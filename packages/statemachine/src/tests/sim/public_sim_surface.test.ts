import { describe, expect, it } from 'vitest'

import { MemoryAdapter } from '../../index'
import type { StateMachineConfig } from '../../index'
import * as sim from '../../sim'
import type { SimEnv } from '../../sim'

/**
 * Step-10 PUBLIC `./sim` surface ratchet (ADR-7 D4 / c7). Mirrors the core
 * `public_surface.test.ts`: a PRESENCE list + a banned-internals list, asserting
 * PRESENCE (not md5). Field-shape drift of re-exported cross-unit types is caught
 * by `etc/statemachine-sim.api.md` (api:check:sim), NOT this test.
 *
 * UNGATED determinism-floor test (build-plan §11A): asserts presence via SOURCE
 * import (`../../sim`), so it needs no built `dist/sim` and runs on every leg.
 */

// Every @unstable value symbol the public ./sim entry MUST export.
const PUBLIC_VALUE_SYMBOLS = [
  // Step-10 public surface
  'wire',
  'runSimulation',
  'Simulator',
  // engine VALUE re-exports (split-by-kind)
  'StateMachine',
  'createVirtualScheduler',
  'isAdapter',
  // Step-1 determinism substrate
  'makePrng',
  'makeSimClock',
  'hashTrace',
  'normalizeParts',
  'PRNG_VERSION',
  // Step-9 capability registry
  'CAPABILITIES',
  'DOCUMENTED_GAP_IDS',
  // Step-7 repro
  'buildMinimalRepro',
  // Step-8 perf
  'PerfBaselineValidationError',
  'evaluatePerfBands',
  'loadPerfBaseline',
  // Step-5 faults
  'InjectedFault',
  // Step-6 oracles
  'runSafety',
  'analyzeLiveness',
] as const

// Internal engine helpers / singletons that must NEVER leak onto ./sim.
const BANNED_SYMBOLS = [
  'globalStateMachineMonitor',
  'globalErrorHandler',
  'MetricsCollector',
  'StateMachineMonitor',
  'PerformanceMonitor',
  'HealthChecker',
  'createDefaultScheduler',
  'createDefaultMonitor',
  'createDefaultErrorHandler',
  'Logger',
  'LoggerFactory',
  'ConsoleAppender',
  'serializationLogger',
] as const

describe('Step 10 — public ./sim surface ratchet', () => {
  it('exports every declared @unstable public value symbol', () => {
    for (const name of PUBLIC_VALUE_SYMBOLS) {
      expect(sim, `expected ${name} on public ./sim surface`).toHaveProperty(name)
    }
  })

  it('does NOT leak any banned/internal engine symbol', () => {
    for (const name of BANNED_SYMBOLS) {
      expect(sim, `${name} must not be on public ./sim surface`).not.toHaveProperty(name)
    }
  })

  it('exports wire as a function and Simulator as a constructable class', () => {
    expect(typeof sim.wire).toBe('function')
    expect(typeof sim.Simulator).toBe('function')
    expect(sim.Simulator.prototype).toBeDefined()
    expect(typeof sim.runSimulation).toBe('function')
  })
})

// A 2-state ping/pong config used by the wire() + sentinel behavioral checks.
type Owner = { state: string }
function pingPongConfig(): StateMachineConfig<Owner> {
  return {
    name: 'pingpong',
    stateAttribute: 'state',
    initialState: 'a',
    states: { a: {}, b: {} },
    events: {
      go: { transitions: [{ from: 'a', to: 'b' }] },
      back: { transitions: [{ from: 'b', to: 'a' }] },
    },
  } as unknown as StateMachineConfig<Owner>
}

describe('Step 10 — wire() five-seam DI-first construction (DoD 6)', () => {
  it('wire() constructs a real StateMachine with all five seams forwarded', () => {
    // Build a full SimEnv via a throwaway Simulator so we reuse the harness seams.
    const probe = new sim.Simulator<Owner>(() => ({ config: pingPongConfig(), owner: { state: 'a' } }), { seed: 7n })
    const env: SimEnv = probe.env
    // Every seam is present and non-optional on SimEnv.
    expect(typeof env.clock).toBe('function')
    expect(env.scheduler).toBeDefined()
    expect(env.monitor).toBeDefined()
    expect(env.errorHandler).toBeDefined()
    expect(env.logger).toBeDefined()
    expect(typeof env.random).toBe('function')
    expect(typeof env.now).toBe('function')

    const machine = sim.wire(env, pingPongConfig(), { state: 'a' })
    expect(machine).toBeDefined()
    // The constructed machine is a real engine StateMachine (public accessors).
    expect(typeof machine.fireEvent).toBe('function')
    expect(typeof machine.getCurrentState).toBe('function')
    expect(machine.getCurrentState()).toBe('a')
  })

  it('errorHandler seam is the SimErrorHandler (isEnabled() pinned true)', () => {
    const probe = new sim.Simulator<Owner>(() => ({ config: pingPongConfig(), owner: { state: 'a' } }), { seed: 1n })
    expect(probe.env.errorHandler.isEnabled()).toBe(true)
  })

  it('wire() accepts an Adapter owner as well as a raw object (no arg-misparse)', () => {
    const probe = new sim.Simulator<Owner>(() => ({ config: pingPongConfig(), owner: { state: 'a' } }), { seed: 2n })
    const adapter = new MemoryAdapter<Owner>({ state: 'a' })
    const machine = sim.wire(probe.env, pingPongConfig(), adapter as never)
    expect(machine.getCurrentState()).toBe('a')
  })
})

describe('Step 10 — behavioral sentinel scheduler probe (DoD 6/7/8)', () => {
  it('init() succeeds for a timer-less machine (harness-armed sentinel fires through env.scheduler)', async () => {
    // A purely event-driven machine with NO consumer timers: the sentinel is
    // harness-owned, so the probe still fires it through env.scheduler.
    const s = new sim.Simulator<Owner>(() => ({ config: pingPongConfig(), owner: { state: 'a' } }), {
      seed: 3n,
      steps: 0,
    })
    await expect(s.init()).resolves.toBeUndefined()
  })

  it('init() is idempotent (second init() is a no-op)', async () => {
    const s = new sim.Simulator<Owner>(() => ({ config: pingPongConfig(), owner: { state: 'a' } }), { seed: 4n })
    await s.init()
    await expect(s.init()).resolves.toBeUndefined()
  })

  it('runSimulation drives a deterministic ping/pong run to a SimResult', async () => {
    const result = await sim.runSimulation<Owner>(() => ({ config: pingPongConfig(), owner: { state: 'a' } }), {
      seed: 5n,
      steps: 4,
    })
    expect(result.ok).toBe(true)
    expect(result.seed).toBe('5')
    expect(result.steps).toBe(4)
    expect(typeof result.traceHash).toBe('string')
    expect(result.traceHash.length).toBeGreaterThan(0)
    expect(result.metrics.traceLen).toBe(result.trace.length)
    // metrics is a PerfSample with a non-hashed shape (latency advisory all-zero).
    expect(result.metrics.latency.resolution).toBe('ms-coarse')
  })

  it('two runs at the same seed produce the SAME traceHash (determinism floor)', async () => {
    const run = () =>
      sim.runSimulation<Owner>(() => ({ config: pingPongConfig(), owner: { state: 'a' } }), { seed: 99n, steps: 6 })
    const [a, b] = await Promise.all([run(), run()])
    expect(a.traceHash).toBe(b.traceHash)
  })

  it('the {machine} best-effort target is not driveable in v1 (fails loudly, not silently)', async () => {
    const machine = sim.wire(
      new sim.Simulator<Owner>(() => ({ config: pingPongConfig(), owner: { state: 'a' } }), { seed: 6n }).env,
      pingPongConfig(),
      { state: 'a' },
    )
    const s = new sim.Simulator<Owner>(() => ({ machine }), { seed: 6n })
    await expect(s.init()).rejects.toThrow(/best-effort/)
  })
})

describe('Step 10 — Simulator.step() inspectable StepOutcome (ISS-040)', () => {
  it('step() returns a StepOutcome with frames + running traceHash', async () => {
    const s = new sim.Simulator<Owner>(() => ({ config: pingPongConfig(), owner: { state: 'a' } }), { seed: 8n })
    await s.init()
    const outcome = await s.step()
    expect(outcome.step).toBeGreaterThanOrEqual(1)
    expect(typeof outcome.t).toBe('number')
    expect(Array.isArray(outcome.frames)).toBe(true)
    expect(typeof outcome.traceHash).toBe('string')
    expect(typeof outcome.quiescent).toBe('boolean')
    expect(typeof outcome.done).toBe('boolean')
    // NO wall-clock/duration/heap leaked onto a frame.
    for (const f of outcome.frames) {
      expect(f).not.toHaveProperty('duration')
      expect(f).not.toHaveProperty('timestamp')
      expect(f).not.toHaveProperty('heap')
    }
  })

  it('snapshot() returns a serializable checkpoint (seed/prngState/t/step/machine)', async () => {
    const s = new sim.Simulator<Owner>(() => ({ config: pingPongConfig(), owner: { state: 'a' } }), { seed: 10n })
    await s.init()
    const snap = s.snapshot()
    expect(snap.seed).toBe('10')
    expect(typeof snap.prngState).toBe('string')
    expect(typeof snap.t).toBe('number')
    expect(typeof snap.step).toBe('number')
    expect(typeof snap.machine).toBe('string')
    // round-trips through JSON (no bigint/function leak).
    expect(() => JSON.parse(JSON.stringify(snap))).not.toThrow()
  })

  it('step() before init() throws', async () => {
    const s = new sim.Simulator<Owner>(() => ({ config: pingPongConfig(), owner: { state: 'a' } }), { seed: 11n })
    await expect(s.step()).rejects.toThrow(/before init/)
  })
})
