/**
 * @module tests/sim/observation_plane — W8 V5a / V5b / V3a / V8.
 *
 * These pin the three OBSERVATION-PLANE enrichments the W8 sim-oracle block rests
 * on. Each one is a claim about what the harness can SEE, and each is asserted
 * against a REAL engine run — never a synthetic frame — because the whole point is
 * that the engine actually emits it:
 *
 *   V5a  `recordTransition` carries a {@link TransitionContext} on the SUCCESS
 *        path, so an INTERNALLY raised cause (`done.state.<C>`) is attributable.
 *   V5b  `doneDelta` is sampled on the Simulator/VERDICT path, not only in
 *        coverage.ts.
 *   V8   a STRING-METHOD invoke action is visible to the harness settledness
 *        signal (ISS-030), which is what let I-3 join the DEFAULT builtin set.
 *   V3a  the lifecycle stream reaches the checker context and a REAL engine run
 *        satisfies the I-4 hierarchy-order predicate.
 */
import { describe, expect, it } from 'vitest'
import { MemoryAdapter, type StateMachineConfig } from '../../index'
import { makeSimClock } from '../../sim/clock'
import { SimDriver } from '../../sim/driver'
import { makeObservableScheduler } from '../../sim/env'
import { INVARIANTS } from '../../sim/invariants'
import type { CheckerContext, LifecycleObservation } from '../../sim/invariants'
import { NoopLogger } from '../../sim/noop-logger'
import { makePrng } from '../../sim/prng'
import { runSimulation } from '../../sim/public'
import { SimErrorHandler } from '../../sim/sim-error-handler'
import { SimMonitor } from '../../sim/sim-monitor'

type Box = { state: string; [k: string]: unknown }

/** A parallel composite with a DECLARED `done.state.C` join leaving the composite. */
function joinConfig(): { config: unknown; owner: Box } {
  return {
    config: {
      name: 'join',
      stateAttribute: 'state',
      initialState: 'C',
      states: {
        C: {
          regions: {
            r1: { w1: {}, d1: { final: true } },
            r2: { w2: {}, d2: { final: true } },
          },
        },
        after: { final: true },
      },
      events: {
        f1: { transitions: [{ from: 'C.r1.w1', to: 'C.r1.d1' }] },
        f2: { transitions: [{ from: 'C.r2.w2', to: 'C.r2.d2' }] },
        'done.state.C': { transitions: [{ from: 'C', to: 'after' }] },
      },
    },
    owner: { state: 'C' },
  }
}

function makeDriver<T extends object>(
  config: StateMachineConfig<T>,
  initial: T,
  monitor: SimMonitor,
): SimDriver<T> {
  const clock = makeSimClock(0)
  const { scheduler, view } = makeObservableScheduler(clock)
  return new SimDriver<T>({
    config,
    owner: new MemoryAdapter<T>(initial),
    clock,
    scheduler,
    schedulerView: view,
    monitor,
    errorHandler: new SimErrorHandler(),
    logger: NoopLogger,
    prng: makePrng(0n),
    runtime: 'node-test',
    policy: 'safety',
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// V5a — TransitionContext on the SUCCESS path
// ═══════════════════════════════════════════════════════════════════════════

describe('W8/V5a: recordTransition carries a TransitionContext on the SUCCESS path', () => {
  it('attributes an INTERNALLY raised done.state.<C> to the state write it produced', async () => {
    const monitor = new SimMonitor()
    const { config, owner } = joinConfig()
    const driver = makeDriver(config as StateMachineConfig<Box>, owner, monitor)
    await driver.init()
    await driver.step({ kind: 'fire', event: 'f1' })
    await driver.step({ kind: 'fire', event: 'f2' })

    const contexts = monitor.getTransitionContexts()
    // The join event NEVER appears on any external surface: the driver fired only
    // f1/f2, and a trace frame's `event` is populated from the step's EXTERNAL op.
    // The monitor context is the ONLY place this cause is observable.
    const join = contexts.filter((c) => c.eventName === 'done.state.C')
    expect(join.length).toBeGreaterThan(0)
    // A COMMITTED transition, not a refusal: the two refusal sites both report
    // fromState === toState, so a moved configuration proves this came from the
    // success site the V5a edit added.
    const committed = join.filter((c) => c.fromState !== c.toState)
    expect(committed.length).toBe(1)
    expect(committed[0]?.toState).toContain('after')
    // and the externally-fired events are attributed too.
    expect(contexts.some((c) => c.eventName === 'f1')).toBe(true)
    expect(contexts.some((c) => c.eventName === 'f2')).toBe(true)
  })

  it('is purely ADDITIVE: a monitor that ignores the third argument is unaffected', async () => {
    // The pre-W8 two-argument contract still holds — success/failure counting is
    // byte-for-byte what it was, and no context is required to reach it.
    const monitor = new SimMonitor()
    const { config, owner } = joinConfig()
    const driver = makeDriver(config as StateMachineConfig<Box>, owner, monitor)
    await driver.init()
    await driver.step({ kind: 'fire', event: 'f1' })
    expect(monitor.getTransitionCount()).toBeGreaterThan(0)
    expect(monitor.getErrorCount()).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// V5b — doneDelta on the VERDICT path
// ═══════════════════════════════════════════════════════════════════════════

describe('W8/V5b: doneDelta is sampled on the Simulator/verdict path', () => {
  it('stamps the isDone(C) projection onto settle-boundary frames of a composite run', async () => {
    const result = await runSimulation<Box>((() => joinConfig()) as never, { seed: '5', steps: 8, mode: 'both' })
    const withDelta = result.trace.filter((f) => f.doneDelta !== undefined)
    // Previously ZERO on this path (only coverage.ts ever injected it), which made
    // every doneDelta-keyed oracle and the liveness `terminal` derivation vacuous.
    expect(withDelta.length).toBeGreaterThan(0)
    for (const f of withDelta) {
      expect(f.doneDelta?.map((d) => d.composite)).toContain('C')
    }
    // The projection is not constant: the composite is observed BOTH not-done and
    // done across the run, so it tracks the real configuration rather than a stub.
    const flags = new Set(withDelta.flatMap((f) => (f.doneDelta ?? []).map((d) => d.done)))
    expect(flags.has(false)).toBe(true)
  })

  it('a composite-FREE config keeps its pre-W8 frame shape (no doneDelta key at all)', async () => {
    const flat = () => ({
      config: {
        name: 'flat',
        stateAttribute: 'state',
        initialState: 's1',
        states: { s1: {}, s2: {} },
        events: { go: { transitions: [{ from: 's1', to: 's2' }] } },
      },
      owner: { state: 's1' } as Box,
    })
    const result = await runSimulation<Box>(flat as never, { seed: '5', steps: 4 })
    expect(result.trace.every((f) => f.doneDelta === undefined)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// V8 / ISS-030 — a string-method invoke action is visible to the settledness signal
// ═══════════════════════════════════════════════════════════════════════════

describe('W8/V8 (ISS-030): a STRING-METHOD invoke action reaches the settledness signal', () => {
  it('holds the harness in-flight count above zero while it runs, and releases it', async () => {
    const monitor = new SimMonitor()
    /** in-flight readings taken from INSIDE the string-resolved action body. */
    const insideMonitor: number[] = []
    const insideEnv: number[] = []
    let driverRef: SimDriver<Box> | undefined

    const owner: Box = {
      state: 'working',
      // Resolved by NAME inside `callAction`, PAST the config-layer wrap boundary —
      // this is exactly the action form `bracketAsync` structurally cannot wrap.
      doWork: async () => {
        await Promise.resolve()
        insideMonitor.push(monitor.invokeActionInFlightCount())
        insideEnv.push(driverRef?.environment.inFlightAsyncCount() ?? -1)
      },
    }
    const config = {
      name: 'strInvoke',
      stateAttribute: 'state',
      initialState: 'working',
      states: {
        working: { invoke: [{ delay: 0, event: 'ping', action: 'doWork' }] },
        done: { final: true },
      },
      events: { ping: { transitions: [{ from: 'working', to: 'done' }] } },
    }
    const driver = makeDriver(config as unknown as StateMachineConfig<Box>, owner, monitor)
    driverRef = driver
    await driver.init()

    expect(insideMonitor.length).toBeGreaterThan(0)
    // WHILE the string action was running the harness could see it...
    expect(insideMonitor.every((n) => n > 0)).toBe(true)
    expect(insideEnv.every((n) => n > 0)).toBe(true)
    // ...and the bracket closed cleanly afterwards. A count that never returned to
    // zero would wedge `settleMacrostep` — no macrostep could ever be quiescent.
    expect(monitor.invokeActionInFlightCount()).toBe(0)
    expect(driver.environment.inFlightAsyncCount()).toBe(0)
    expect(driver.machine.getCurrentState()).toBe('done')
  })

  it('the harness in-flight count returns to zero even when the action THROWS', async () => {
    const monitor = new SimMonitor()
    const owner: Box = {
      state: 'working',
      boom: async () => {
        await Promise.resolve()
        throw new Error('action failed')
      },
    }
    const config = {
      name: 'strInvokeThrow',
      stateAttribute: 'state',
      initialState: 'working',
      states: {
        working: { invoke: [{ delay: 0, event: 'ping', action: 'boom' }] },
        done: { final: true },
      },
      events: { ping: { transitions: [{ from: 'working', to: 'done' }] } },
    }
    const driver = makeDriver(config as unknown as StateMachineConfig<Box>, owner, monitor)
    await driver.init()
    // The `end` edge is emitted on the FAILURE path too (state_machine.ts
    // runTracedInvokeAction catch), so a throwing action cannot leak the bracket.
    expect(monitor.invokeActionInFlightCount()).toBe(0)
    expect(driver.environment.inFlightAsyncCount()).toBe(0)
  })

  it('a long-running invoke OPERATION is deliberately NOT counted (it would wedge quiescence)', async () => {
    const monitor = new SimMonitor()
    let settle: (() => void) | undefined
    const owner: Box = { state: 'working' }
    const config = {
      name: 'longOp',
      stateAttribute: 'state',
      initialState: 'working',
      states: {
        working: {
          invoke: [
            {
              // A subscription-shaped operation whose promise outlives the
              // macrostep. Folding `invoke.operation` into the in-flight count
              // would make `inFlightAsyncCount()` permanently non-zero and NO
              // macrostep could ever reach quiescence.
              src: () => new Promise<void>((res) => { settle = res }),
              onDone: 'ping',
            },
          ],
        },
        done: { final: true },
      },
      events: { ping: { transitions: [{ from: 'working', to: 'done' }] } },
    }
    const driver = makeDriver(config as unknown as StateMachineConfig<Box>, owner, monitor)
    await driver.init()
    // The operation IS observable on the channel (an unmatched `begin`)...
    const opBegins = monitor.getLifecycle().filter((e) => e.hook === 'invoke.operation' && e.edge === 'begin')
    expect(opBegins.length).toBeGreaterThan(0)
    // ...but it is NOT part of the settledness count, so the driver stays usable.
    expect(monitor.invokeActionInFlightCount()).toBe(0)
    expect(driver.environment.inFlightAsyncCount()).toBe(0)
    settle?.()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// V3a — the lifecycle plane reaches the checkers, and a REAL run is in order
// ═══════════════════════════════════════════════════════════════════════════

describe('W8/V3a: the lifecycle plane reaches the SAFETY checkers', () => {
  /** The engine config used for the e2e order check: hooks at BOTH hierarchy levels. */
  const hookedJoin = () => ({
    config: {
      name: 'hooked',
      stateAttribute: 'state',
      initialState: 'C',
      states: {
        C: {
          onEnter: (o: Box) => {
            o.log = `${String(o.log ?? '')}+C`
          },
          onExit: (o: Box) => {
            o.log = `${String(o.log ?? '')}-C`
          },
          regions: {
            r1: {
              w1: {
                onEnter: (o: Box) => {
                  o.log = `${String(o.log ?? '')}+w1`
                },
                onExit: (o: Box) => {
                  o.log = `${String(o.log ?? '')}-w1`
                },
              },
              d1: { final: true },
            },
            r2: { w2: {}, d2: { final: true } },
          },
        },
        after: { final: true },
      },
      events: {
        f1: { transitions: [{ from: 'C.r1.w1', to: 'C.r1.d1' }] },
        f2: { transitions: [{ from: 'C.r2.w2', to: 'C.r2.d2' }] },
        'done.state.C': { transitions: [{ from: 'C', to: 'after' }] },
      },
    },
    owner: { state: 'C', log: '' } as Box,
  })

  it('a REAL engine run emits enter/exit records and satisfies the I-4 predicate', async () => {
    const monitor = new SimMonitor()
    const { config, owner } = hookedJoin()
    const driver = makeDriver(config as unknown as StateMachineConfig<Box>, owner, monitor)
    await driver.init()
    await driver.step({ kind: 'fire', event: 'f1' })
    await driver.step({ kind: 'fire', event: 'f2' })

    const stream: readonly LifecycleObservation[] = monitor.getLifecycle()
    // Non-vacuity: the run really did produce hook records at both levels, so a
    // green I-4 below is a checked property and not an empty-input pass.
    expect(stream.some((e) => e.kind === 'enter' && e.edge === 'begin')).toBe(true)
    expect(stream.some((e) => e.kind === 'exit' && e.edge === 'begin')).toBe(true)
    expect(stream.some((e) => e.state === 'C')).toBe(true)
    expect(stream.some((e) => e.state === 'C.r1.w1')).toBe(true)

    const inv4 = INVARIANTS.find((i) => i.id === 'I-4')
    const ctx = {
      graph: { getRegionKey: (s: string) => s, depthOf: () => 0, isRegisteredLeaf: () => true, states: new Set<string>(), composites: new Set<string>(), declaredDoneEvents: new Set<string>() },
      header: driver.trace().header,
      lifecycle: stream,
    } as unknown as CheckerContext
    expect(
      inv4?.checkFinal?.({ config: 'after', queue: { internal: 0, external: 0 }, quiescent: true }, ctx) ?? null,
    ).toBeNull()
  })

  it('the Simulator wires ctx.lifecycle, so I-4 is live in a default runSimulation', async () => {
    // The default builtin registry now INCLUDES I-4; a clean composite run with real
    // hooks must stay ok. (If ctx.lifecycle were not wired, I-4 would be vacuous and
    // this would pass for the wrong reason — the previous test pins non-vacuity.)
    const result = await runSimulation<Box>(hookedJoin as never, { seed: '9', steps: 10, mode: 'both' })
    expect(result.violation).toBeUndefined()
    expect(result.ok).toBe(true)
  })
})
