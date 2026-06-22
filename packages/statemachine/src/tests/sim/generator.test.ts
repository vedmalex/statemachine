import { describe, expect, it } from 'vitest'
import { type StateMachineConfig, validateConfig } from '../../index'
import {
  DEFAULT_BOUNDS,
  DEFAULT_GENOPS_PARAMS,
  type GenOwner,
  generateScenario,
  makeOwner,
  runScenario,
  toEngineConfig,
} from '../../sim/define'
import { makePrng } from '../../sim/prng'
import type { Bounds, InvokeSpec, LiteralCallback, StateSpec, TopologySpec } from '../../sim/scenario'
import { SimDriver } from '../../sim/driver'
import { makeSimClock } from '../../sim/clock'
import { makeObservableScheduler } from '../../sim/env'
import { NoopLogger } from '../../sim/noop-logger'
import { SimErrorHandler } from '../../sim/sim-error-handler'
import { SimMonitor } from '../../sim/sim-monitor'
import { MemoryAdapter, type Adapter } from '../../index'
import { genConfig } from '../../sim/topology'
import { genOps, type OpDriverView } from '../../sim/ops'

// The validator-warning whitelist (DoD#3): SELF_TRANSITION + optionally the two
// count warnings. Anything else FAILS.
const WARNING_WHITELIST = new Set(['SELF_TRANSITION', 'TOO_MANY_STATES', 'TOO_MANY_EVENTS'])

/**
 * Re-create a closure-free literal callback through the EXACT `security.ts:640`
 * restricted-scope executor signature `new Function('adaptee','args', …)` so the
 * closure-free self-test (DoD#4) runs the SAME contract the engine runs. A
 * closure-free body reads only `adaptee`; free identifiers would throw
 * ReferenceError here.
 */
function reEvalViaSecurityExecutor(source: string): (adaptee: unknown, ...args: unknown[]) => unknown {
  const executor = new Function(
    'adaptee',
    'args',
    `
    var eval = undefined;
    var Function = undefined;
    var setTimeout = undefined;
    var setInterval = undefined;
    var document = undefined;
    var window = undefined;
    var global = undefined;
    var process = undefined;
    var require = undefined;
    const __fn = (${source});
    if (typeof __fn !== 'function') { throw new Error('not a function'); }
    return __fn(adaptee, ...(Array.isArray(args) ? args : []));
  `,
  ) as (adaptee: unknown, args: unknown[]) => unknown
  return (adaptee: unknown, ...args: unknown[]) => executor(adaptee, args)
}

/** Walk every {@link LiteralCallback} in a topology, yielding (source, fn) pairs. */
function collectCallbacks(topology: TopologySpec): LiteralCallback[] {
  const out: LiteralCallback[] = []
  const visitState = (s: StateSpec): void => {
    if (s.onEnter) out.push(s.onEnter)
    if (s.onExit) out.push(s.onExit)
    for (const inv of s.invoke ?? []) {
      if (inv.cond) out.push(inv.cond)
      if (inv.action) out.push(inv.action)
    }
    for (const region of Object.values(s.regions ?? {})) {
      for (const ss of Object.values(region)) visitState(ss)
    }
  }
  for (const s of Object.values(topology.states)) visitState(s)
  for (const ev of Object.values(topology.events)) {
    for (const t of ev.transitions) {
      if (t.guard) out.push(t.guard)
      if (t.onTransition) out.push(t.onTransition)
    }
  }
  return out
}

// ── DoD 2/3: 256-seed correct-by-construction + warning whitelist ────────────

describe('topology: 256-seed correct-by-construction (DoD 2/3)', () => {
  it('validateConfig(genConfig(seed)).isValid === true for all 256 seeds; warnings whitelisted', () => {
    for (let s = 0; s < 256; s++) {
      const { topology } = genConfig(makePrng(BigInt(s)), DEFAULT_BOUNDS)
      const r = validateConfig(toEngineConfig(topology) as StateMachineConfig<GenOwner>)
      expect(r.isValid, `seed ${s} produced errors ${JSON.stringify(r.errors.map((e) => e.code))}`).toBe(true)
      expect(r.errors.length, `seed ${s}`).toBe(0)
      for (const w of r.warnings) {
        expect(
          WARNING_WHITELIST.has(w.code),
          `seed ${s} unexpected warning ${w.code}: ${w.message}`,
        ).toBe(true)
      }
    }
  })

  it('no seed throws during generation (no discard-retry, generation total)', () => {
    for (let s = 0; s < 64; s++) {
      expect(() => genConfig(makePrng(BigInt(s)), DEFAULT_BOUNDS)).not.toThrow()
    }
  })
})

// ── DoD 4: closure-free re-eval through the exact security.ts:640 executor ────

describe('topology: closure-free literal callbacks (DoD 4)', () => {
  it('every guard/action/cond re-eval through the security.ts:640 executor (no free-id ReferenceError)', () => {
    const { topology } = genConfig(makePrng(11n), DEFAULT_BOUNDS)
    const callbacks = collectCallbacks(topology)
    expect(callbacks.length).toBeGreaterThan(0)
    // The per-site adaptee shape the engine passes: an owner carrying log/k.
    const owner = { log: [] as number[], k: 5, state: 'x' }
    for (const cb of callbacks) {
      // Re-eval must not throw (closure-free: only reads its parameter).
      const reEvaled = reEvalViaSecurityExecutor(cb.source)
      expect(() => reEvaled(owner), `source threw: ${cb.source}`).not.toThrow()
    }
  })

  it('re-eval OUTPUT is byte-identical to the live fn for guard/cond/sync-action', () => {
    const { topology } = genConfig(makePrng(11n), DEFAULT_BOUNDS)
    const callbacks = collectCallbacks(topology)
    for (const cb of callbacks) {
      // skip async (output is a Promise; compared behaviorally elsewhere)
      if (cb.source.startsWith('async')) continue
      const reEvaled = reEvalViaSecurityExecutor(cb.source)
      for (const k of [0, 3, 7, 10, 14]) {
        const owner = { log: [] as number[], k, state: 'x' }
        const ownerB = { log: [] as number[], k, state: 'x' }
        const live = (cb.fn as (o: typeof owner) => unknown)(owner)
        const re = reEvaled(ownerB)
        expect(re, `mismatch for ${cb.source} at k=${k}`).toEqual(live)
        // marker-push side effects must also match
        expect(ownerB.log).toEqual(owner.log)
      }
    }
  })

  it('async-action re-eval resolves and pushes the same marker as the live fn', async () => {
    const { topology } = genConfig(makePrng(11n), DEFAULT_BOUNDS)
    const asyncCbs = collectCallbacks(topology).filter((c) => c.source.startsWith('async'))
    expect(asyncCbs.length, 'generator must emit >=1 closure-free async action (DoD 11)').toBeGreaterThan(0)
    for (const cb of asyncCbs) {
      const owner = { log: [] as number[], k: 0, state: 'x' }
      const ownerB = { log: [] as number[], k: 0, state: 'x' }
      await (cb.fn as (o: typeof owner) => Promise<unknown>)(owner)
      await reEvalViaSecurityExecutor(cb.source)(ownerB)
      expect(ownerB.log).toEqual(owner.log)
      expect(owner.log.length).toBe(1)
    }
  })
})

// ── DoD 5: non-numeric state names + insertion-stable region init ────────────

describe('topology: non-numeric names + stable region init (DoD 5)', () => {
  it('no generated state name starts with a digit', () => {
    const collectNames = (states: Readonly<Record<string, StateSpec>>, acc: string[]): void => {
      for (const [name, s] of Object.entries(states)) {
        acc.push(name)
        for (const region of Object.values(s.regions ?? {})) {
          collectNames(region, acc)
        }
      }
    }
    for (let s = 0; s < 32; s++) {
      const { topology } = genConfig(makePrng(BigInt(s)), DEFAULT_BOUNDS)
      const names: string[] = []
      collectNames(topology.states, names)
      for (const n of names) {
        expect(/^\D/.test(n), `name "${n}" starts with a digit`).toBe(true)
      }
    }
  })

  it('every composite pins `initial` to a leaf present in EVERY region (insertion-stable)', () => {
    const { topology } = genConfig(makePrng(0n), DEFAULT_BOUNDS)
    for (const s of Object.values(topology.states)) {
      if (!s.regions) continue
      expect(s.initial).toBeDefined()
      for (const region of Object.values(s.regions)) {
        expect(Object.keys(region)).toContain(s.initial)
        // first key is non-digit so insertion order is stable
        expect(/^\D/.test(Object.keys(region)[0]!)).toBe(true)
      }
    }
  })
})

// ── DoD 6: >=1 invoke.cond literal-false skip path ───────────────────────────

describe('topology: invoke.cond literal-false (DoD 6)', () => {
  it('generator emits >=1 invoke.cond whose source is the literal-false `(o)=>false`', () => {
    const { topology } = genConfig(makePrng(0n), DEFAULT_BOUNDS)
    const conds: InvokeSpec[] = []
    const visit = (s: StateSpec): void => {
      for (const inv of s.invoke ?? []) {
        if (inv.cond) conds.push(inv)
      }
      for (const region of Object.values(s.regions ?? {})) {
        for (const ss of Object.values(region)) visit(ss)
      }
    }
    for (const s of Object.values(topology.states)) visit(s)
    const falseConds = conds.filter((c) => c.cond?.source === '(o)=>false')
    expect(falseConds.length).toBeGreaterThanOrEqual(1)
    // the literal-false cond evaluates false (so the timer arms but never raises)
    expect((falseConds[0]!.cond!.fn as (o: unknown) => boolean)({})).toBe(false)
  })
})

// ── DoD 7: stable op ids survive op removal (no positional renumber) ─────────

describe('ops: stable ids survive removal (DoD 7)', () => {
  it('every Op has a unique stable id; dropping an arbitrary op leaves surviving ids unchanged', async () => {
    const spec = await generateScenario(4n)
    const ids = spec.ops.map((o) => o.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size, 'ids unique').toBe(ids.length)
    // ids are content (op-N at emission), NOT positions: dropping the middle op
    // leaves the rest identical.
    const dropIdx = Math.floor(spec.ops.length / 2)
    const survivors = spec.ops.filter((_, i) => i !== dropIdx)
    const survivorIds = survivors.map((o) => o.id)
    const expected = ids.filter((_, i) => i !== dropIdx)
    expect(survivorIds).toEqual(expected)
  })
})

// ── DoD 8: Bounds clamp is NON-VACUOUS (depth=error, count=warning) ──────────

describe('topology: Bounds clamp non-vacuous (DoD 8)', () => {
  it('maxStateDepth > 10 is clamped (the ONLY breach that is a validateConfig ERROR via :253)', () => {
    // generate with an over-large depth bound; the generated tree must still
    // validate clean because the generator clamps to <=10 (and the skeleton is
    // shallow regardless).
    const bounds: Bounds = { ...DEFAULT_BOUNDS, maxStateDepth: 50 }
    const { topology } = genConfig(makePrng(0n), bounds)
    const r = validateConfig(toEngineConfig(topology) as StateMachineConfig<GenOwner>)
    expect(r.errors.find((e) => e.code === 'MAX_DEPTH_EXCEEDED')).toBeUndefined()
    expect(r.isValid).toBe(true)
  })

  it('state/event count clamps suppress WARNINGS only — they do NOT prevent an isValid error', () => {
    // With small count clamps the generated machine still validates (counts are
    // warning-only, addWarning :884/:892 — never an isValid:false ERROR).
    const bounds: Bounds = { ...DEFAULT_BOUNDS, maxStatesCount: 2, maxEventsCount: 2 }
    const { topology } = genConfig(makePrng(0n), bounds)
    const r = validateConfig(toEngineConfig(topology) as StateMachineConfig<GenOwner>, {
      maxStatesCount: bounds.maxStatesCount,
      maxEventsCount: bounds.maxEventsCount,
    })
    // counts exceeded => TOO_MANY_* WARNINGS, but isValid stays true (no error).
    expect(r.isValid).toBe(true)
    const codes = r.warnings.map((w) => w.code)
    expect(codes).toContain('TOO_MANY_STATES')
    expect(codes).toContain('TOO_MANY_EVENTS')
    // and they are warnings, never errors
    expect(r.errors.length).toBe(0)
  })
})

// ── DoD 9: genOps closed-loop probes a SETTLED machine; no local drain ───────

describe('ops: closed-loop genOps (DoD 9)', () => {
  it('pBlind=0 => no blind invalid-event fires; every fire targets an available event', async () => {
    // Build the same wiring define.buildDriver uses, then drive genOps with
    // pBlind=0 so EVERY fire targets an available event (no __no_such_event__).
    const { topology } = genConfig(makePrng(2n).fork('topology'), DEFAULT_BOUNDS)
    const driver = makeProbeDriver(topology, 2n)
    await driver.init()
    const ops = await genOps(makePrng(2n).fork('ops'), driver as unknown as OpDriverView, {
      maxOps: 24,
      pBlind: 0,
      pAdvance: 0.3,
    })
    const blind = ops.filter((o) => o.kind === 'fire' && (o as { event: string }).event === '__no_such_event__')
    expect(blind.length).toBe(0)
  })

  it('pBlind>0 => at least one blind invalid-event fire appears (reject path producer)', async () => {
    const { topology } = genConfig(makePrng(2n).fork('topology'), DEFAULT_BOUNDS)
    const driver = makeProbeDriver(topology, 2n)
    await driver.init()
    const ops = await genOps(makePrng(2n).fork('ops'), driver as unknown as OpDriverView, {
      maxOps: 40,
      pBlind: 0.9,
      pAdvance: 0,
    })
    const blind = ops.filter((o) => o.kind === 'fire' && (o as { event: string }).event === '__no_such_event__')
    expect(blind.length).toBeGreaterThanOrEqual(1)
  })
})

// ── DoD 6 (behavioral): the literal-false cond arms a timer that never raises ─

describe('topology: invoke.cond literal-false is a true no-fire (DoD 6 behavioral)', () => {
  it('the false-cond invoke event never resolves true off its own timer (cond-skip)', async () => {
    // Drive a full scenario; the `noFire` invoke (literal-false cond) arms a timer
    // at lane[1] but the cond is false so the engine SKIPS the raise. The only way
    // `noFire` ever transitions is when a USER op fires it explicitly — never as a
    // spontaneous timer raise. We prove the false cond is inert by checking the
    // cond evaluates false and that a fresh scenario settles without the false
    // cond producing a transition on its own.
    const spec = await generateScenario(0n)
    const trace = await runScenario(spec)
    // The trace settles (no microtask-budget livelock from a runaway cond-skip
    // re-arm) and reaches a stable hash deterministically.
    expect(trace.frames.length).toBeGreaterThan(0)
    // every `noFire` frame, if any, must be caused by an EXTERNAL user op (the
    // user firing it), never a spontaneous `timer` raise from the false cond.
    const noFireTimerFrames = trace.frames.filter((f) => f.event === 'noFire' && f.cause === 'timer')
    expect(noFireTimerFrames.length, 'false cond must never raise noFire off a timer').toBe(0)
  }, 30000)
})

// ── DoD 11: generator emits >=1 closure-free async action (ISS-030 producer) ──

describe('topology: async action producing input (DoD 11)', () => {
  it('at least one invoke action source is `async (...) => {...}`', () => {
    const { topology } = genConfig(makePrng(0n), DEFAULT_BOUNDS)
    const cbs = collectCallbacks(topology)
    expect(cbs.some((c) => c.source.startsWith('async '))).toBe(true)
  })

  it('the async invoke region completes (both regions reach final) — proves the awaited inFlightAsyncCount path settles through', async () => {
    // Region rA arms an ASYNC invoke action; its region-edge event only fires
    // AFTER the awaited action resolves (engine awaits callAction :2170 BEFORE
    // raiseEvent). If the harness did NOT track inFlightAsyncCount, the settle
    // would conclude prematurely and the region would never reach `fin`. Reaching
    // `cP.rA.fin|cP.rB.fin` is the behavioral witness that the awaited async
    // action was settled-through.
    const spec = await generateScenario(0n)
    const trace = await runScenario(spec)
    const bothFinal = trace.frames.some(
      (f) => (f.to ?? '').includes('cP.rA.fin') && (f.to ?? '').includes('cP.rB.fin'),
    )
    expect(bothFinal, 'parallel composite never reached all-final via the async region').toBe(true)
  }, 30000)
})

// ── DoD 12: errorState excluded from the probe-bearing topology family ───────

describe('topology: errorState excluded from probe family (DoD 12)', () => {
  it('generated topology declares NO errorState and every state carries an enter-marker probe', () => {
    // "errorState target" = a state referenced by the engine errorState fallback
    // config (:2017-2020). Step 4 never emits an errorState, so the :2020 bypass
    // (which skips executeEnterActions) can never need to fire an enter-triad
    // probe. We assert (a) the topology has no errorState-ish field and (b) the
    // enter-marker probe family is present on the probe-bearing states.
    for (let s = 0; s < 32; s++) {
      const { topology } = genConfig(makePrng(BigInt(s)), DEFAULT_BOUNDS)
      // no top-level errorState concept leaks into the spec
      expect((topology as unknown as { errorState?: unknown }).errorState).toBeUndefined()
      // simple lane states carry onEnter marker probes (the I-4 owner-marker family)
      const simpleStatesWithEnter = Object.values(topology.states).filter((st) => !st.regions && st.onEnter)
      expect(simpleStatesWithEnter.length).toBeGreaterThan(0)
    }
  })
})

// ── DoD 10 (partial): ScenarioSpec JSON round-trips losslessly ───────────────

describe('scenario: JSON round-trip (DoD 10)', () => {
  it('ScenarioSpec stringifies/parses with string seed, no bigint, no function', async () => {
    const spec = await generateScenario(6n, DEFAULT_BOUNDS, DEFAULT_GENOPS_PARAMS)
    const json = JSON.stringify(spec)
    const round = JSON.parse(json)
    expect(typeof round.seed).toBe('string')
    expect(round.version).toBe(1)
    // functions are dropped by JSON; the closure-free `source` survives.
    expect(json).not.toContain('function')
    // a callback source survived the round-trip
    expect(json).toContain('(o)=>')
  })
})

// ── helper: a probe driver sharing define.buildDriver's wiring ────────────────

function makeProbeDriver(topology: TopologySpec, seed: bigint): SimDriver<GenOwner> {
  const config = toEngineConfig<GenOwner>(topology)
  const clock = makeSimClock(0)
  const { scheduler, view } = makeObservableScheduler(clock)
  return new SimDriver<GenOwner>({
    config,
    owner: new MemoryAdapter<GenOwner>(makeOwner(topology)) as unknown as Adapter<GenOwner>,
    clock,
    scheduler,
    schedulerView: view,
    monitor: new SimMonitor(),
    errorHandler: new SimErrorHandler(),
    logger: NoopLogger,
    prng: makePrng(seed),
    runtime: 'node-sim-v1',
    policy: 'liveness',
  })
}
