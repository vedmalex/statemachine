import { describe, expect, it } from 'vitest'
import {
  MemoryAdapter,
  StateMachine,
  type StateMachineConfig,
  type StatePersistenceAdapter,
} from '../../index'
import { type CapturedWrite, wrapAdapterForCapture } from '../../sim/capture'
import { makeSimClock } from '../../sim/clock'
import { SimDriver } from '../../sim/driver'
import { I10_PROBE, I6_PROBE, classifyCorruptState } from '../../sim/faults'
import { issueCorruptStateWrite } from '../../sim/harness'
import { makeObservableScheduler } from '../../sim/env'
import {
  type CheckerContext,
  INVARIANTS,
  type Invariant,
  type LifecycleObservation,
  buildConfigGraph,
  finalStateOf,
  makeViolation,
} from '../../sim/invariants'
import { runSafety, runSafetyWithDeterminism } from '../../sim/invariants.runner'
import { NoopLogger } from '../../sim/noop-logger'
import { makePrng } from '../../sim/prng'
import { SimErrorHandler } from '../../sim/sim-error-handler'
import { SimMonitor } from '../../sim/sim-monitor'
import type { CanonicalHeader, CanonicalTrace, TraceFrame } from '../../sim/trace'
import { hashTrace } from '../../sim/trace'

interface Box {
  state: string
  log: number[]
  k: number
}

/**
 * Two distinct owner sentinels for the W8/V3a lifecycle fixtures. `owner` is a
 * REFERENCE-identity discriminator (one machine can drive many objects), so the
 * fixtures need two objects that are never `===`.
 */
const OWNER_A: object = { owner: 'A' }
const OWNER_B: object = { owner: 'B' }

/** A canonical header for synthetic-trace tests. */
const HEADER: CanonicalHeader = {
  seed: '0',
  configHash: 'deadbeefdeadbeef',
  engine: '@vedmalex/statemachine',
  version: '1',
  runtime: 'node-test',
  prngVersion: 'splitmix64-bigint-v1',
  errorHandlerEnabled: true,
}

/** Build a frame with sensible defaults so tests only override what they assert on. */
function frame(over: Partial<TraceFrame> & { step: number }): TraceFrame {
  return {
    t: 0,
    cause: 'external',
    from: 'a',
    to: 'a',
    queue: { internal: 0, external: 0 },
    quiescent: true,
    ...over,
  }
}

/** Build a checker context for a config + optional maxQueueDepth. */
function ctxFor(config: unknown, maxQueueDepth?: number): CheckerContext {
  return {
    graph: buildConfigGraph(config),
    header: HEADER,
    ...(maxQueueDepth !== undefined ? { maxQueueDepth } : {}),
  }
}

/** Build a driver wired to all five Sim seams. */
function makeDriver<T extends object>(
  config: StateMachineConfig<T>,
  initial: T,
  opts: { policy?: 'safety' | 'liveness'; maxQueueDepth?: number } = {},
): SimDriver<T> {
  const clock = makeSimClock(0)
  const { scheduler, view } = makeObservableScheduler(clock)
  return new SimDriver<T>({
    config,
    owner: new MemoryAdapter<T>(initial),
    clock,
    scheduler,
    schedulerView: view,
    monitor: new SimMonitor(),
    errorHandler: new SimErrorHandler(),
    logger: NoopLogger,
    prng: makePrng(0n),
    runtime: 'node-test',
    policy: opts.policy ?? 'safety',
    ...(opts.maxQueueDepth !== undefined ? { maxQueueDepth: opts.maxQueueDepth } : {}),
  })
}

// ── DoD 1: readonly Invariant[] with all thirteen ids + MECHANICAL blind grep ─

describe('invariants registry + blind iteration (DoD 1)', () => {
  it('INVARIANTS holds all thirteen ids I-1..I-13', () => {
    const ids = INVARIANTS.map((i) => i.id)
    expect(ids).toEqual(['I-1', 'I-2', 'I-3', 'I-4', 'I-5', 'I-6', 'I-7', 'I-8', 'I-9', 'I-10', 'I-11', 'I-12', 'I-13'])
  })

  it('runSafety body contains NO /I-\\d+/ id literal (mechanical blind-iteration grep)', () => {
    // The runner file is isolated from the registry data so this grep is mechanical.
    expect(/I-\d+/.test(runSafety.toString())).toBe(false)
    expect(/I-\d+/.test(runSafetyWithDeterminism.toString())).toBe(false)
  })

  it('the runner source file carries no id literal; the registry file does', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const here = path.dirname(new URL(import.meta.url).pathname)
    const simDir = path.resolve(here, '../../sim')
    const runner = fs.readFileSync(path.join(simDir, 'invariants.runner.ts'), 'utf8')
    // Strip comments — the id literals must be absent from LIVE runner source.
    const runnerCode = runner
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n')
    expect(/I-\d+/.test(runnerCode)).toBe(false)
    // The registry data file legitimately contains them.
    const registry = fs.readFileSync(path.join(simDir, 'invariants.ts'), 'utf8')
    expect(/I-\d+/.test(registry)).toBe(true)
  })
})

// ── DoD 2: AT MOST ONE Violation (lowest-step / first-final / I-1 short-circuit) ─

describe('runSafety: at-most-one violation, first-violation-wins (DoD 2)', () => {
  it('a planted two-violation trace (low-step I-9 + high-step I-3) yields ONLY I-9', () => {
    // I-9 fires at step 1 (depth over bound); I-3 fires at step 3 (resolve-true
    // non-quiescent). The lowest-step violation wins.
    const trace: CanonicalTrace = {
      header: HEADER,
      frames: [
        frame({ step: 0, cause: 'init' }),
        frame({ step: 1, queue: { internal: 3, external: 2 } }), // depth 5 > bound 2 → I-9
        frame({ step: 3, fireOutcome: 'resolve-true', quiescent: false }), // I-3
      ],
    }
    const v = runSafety(INVARIANTS, trace, ctxFor({ states: { a: {} }, events: {} }, 2))
    expect(v).not.toBeNull()
    expect(v?.invariantId).toBe('I-9')
    expect(v?.step).toBe(1)
  })

  it('I-1 determinism failure short-circuits to the meta violation before any other', () => {
    // Even a trace that would violate I-9 returns the determinism violation first
    // when the two run hashes differ.
    const trace: CanonicalTrace = {
      header: HEADER,
      frames: [frame({ step: 1, queue: { internal: 9, external: 9 } })],
    }
    const v = runSafetyWithDeterminism(INVARIANTS, trace, ctxFor({ states: { a: {} }, events: {} }, 2), {
      a: 'hashA',
      b: 'hashB',
    })
    expect(v).not.toBeNull()
    expect(v?.invariantId).toBe('I-1')
    expect(v?.witness).toContain('hashA')
  })

  it('equal hashes fall through to the normal blind sweep', () => {
    const trace: CanonicalTrace = { header: HEADER, frames: [frame({ step: 0, cause: 'init', from: 'a', to: 'a' })] }
    const v = runSafetyWithDeterminism(INVARIANTS, trace, ctxFor({ states: { a: {} }, events: {} }), {
      a: 'same',
      b: 'same',
    })
    expect(v).toBeNull()
  })

  it('determinism mismatch with a registry that has NO meta-determinism tag falls back to id "determinism"', () => {
    // A minimal registry with only a step invariant (no meta.determinism tag) →
    // the runner cannot discover the meta id and uses the "determinism" fallback.
    const minimal: Invariant[] = [
      { id: 'X-step', scope: 'step', checkStep: () => null },
    ]
    const trace: CanonicalTrace = { header: HEADER, frames: [frame({ step: 0, to: 'a' })] }
    const v = runSafetyWithDeterminism(minimal, trace, ctxFor({ states: { a: {} }, events: {} }), {
      a: 'h1',
      b: 'h2',
    })
    expect(v?.invariantId).toBe('determinism')
  })

  it('runSafety skips invariants lacking checkStep / checkFinal (blind iteration is total)', () => {
    // A step-only invariant (no checkFinal) and a final-only invariant (no checkStep)
    // are both iterated without error; a clean trace yields null.
    const mixed: Invariant[] = [
      { id: 'step-only', scope: 'step', checkStep: () => null },
      { id: 'final-only', scope: 'final', checkFinal: () => null },
    ]
    const trace: CanonicalTrace = { header: HEADER, frames: [frame({ step: 0, to: 'a' })] }
    expect(runSafety(mixed, trace, ctxFor({ states: { a: {} }, events: {} }))).toBeNull()
  })
})

// ── DoD 3: each I-2..I-12 catches its planted violation AND passes clean ──────

describe('each I-2..I-12 catch/pass with normalized witness (DoD 3)', () => {
  const baseCtx = (): CheckerContext =>
    ctxFor({ states: { a: {}, b: {} }, events: { go: {} } }, 4)

  it('I-2 catches a never-settled fire; passes a settled one', () => {
    const dirty: CanonicalTrace = {
      header: HEADER,
      frames: [frame({ step: 1, cause: 'external', event: 'go' })], // no fireOutcome → lost
    }
    expect(runSafety(INVARIANTS, dirty, baseCtx())?.invariantId).toBe('I-2')
    const clean: CanonicalTrace = {
      header: HEADER,
      frames: [frame({ step: 1, cause: 'external', event: 'go', fireOutcome: 'resolve-true' })],
    }
    expect(runSafety(INVARIANTS, clean, baseCtx())).toBeNull()
  })

  it('I-3 catches a non-quiescent resolve-true boundary; passes a quiescent one', () => {
    const dirty: CanonicalTrace = {
      header: HEADER,
      frames: [frame({ step: 1, fireOutcome: 'resolve-true', quiescent: false })],
    }
    expect(runSafety(INVARIANTS, dirty, baseCtx())?.invariantId).toBe('I-3')
    const clean: CanonicalTrace = {
      header: HEADER,
      frames: [frame({ step: 1, fireOutcome: 'resolve-true', quiescent: true })],
    }
    expect(runSafety(INVARIANTS, clean, baseCtx())).toBeNull()
  })

  it('I-3 EXCLUDES every documented settle reason, including WAITING_ON_INTERNAL; only a no-reason boundary is left, and that is hand-built only', () => {
    const nonQuiescentBoundary = (settleReason?: string): CanonicalTrace => ({
      header: HEADER,
      frames: [frame({ step: 1, fireOutcome: 'resolve-true', quiescent: false, ...(settleReason ? { settleReason: settleReason as never } : {}) })],
    })
    // EVERY documented reason is a legitimate wait — I-3 stays clean (anti-FP).
    // WAITING_ON_TIMER is C1; WAITING_ON_TRANSITION_TIMEOUT is U1 (settle assigns it
    // only when inFlightAsyncCount()>0); the two budget reasons are wave-A
    // truncations; and WAITING_ON_INTERNAL is the SAME truncation over the 16-turn
    // QUIET_FLUSH window rather than the 1024-turn budget — the pump's early break
    // (exit (b)) observes only "the fingerprint has not moved for 16 turns and some
    // timer is armed", and that fingerprint is frozen across an entire ordinary
    // microstep whose length grows with the machine's own width. Measured through
    // `runSimulation`: a parallel composite with an unrelated sibling region holding
    // `invoke:[{event:'never', delay:100000}]` used to be convicted here for a
    // SYNCHRONOUS `onEnter`.
    for (const reason of [
      'WAITING_ON_TIMER',
      'WAITING_ON_TRANSITION_TIMEOUT',
      'WAITING_ON_INTERNAL',
      'budget-progressing',
      'microtask-budget',
    ]) {
      expect(runSafety(INVARIANTS, nonQuiescentBoundary(reason), baseCtx()), reason).toBeNull()
    }
    // The ONLY surviving branch: a non-quiescent boundary carrying no reason at all.
    // It is unreachable from a real run — every `quiescent:false` return in
    // `settleMacrostep` sets a reason and the driver stamps it — which is why I-3 is
    // no longer in DEFAULT_BUILTIN_INVARIANT_IDS. This hand-built frame is the only
    // way to reach it, and the assertion documents that fact rather than a capability.
    expect(runSafety(INVARIANTS, nonQuiescentBoundary(undefined), baseCtx())?.invariantId).toBe('I-3')
  })

  it('I-6 catches a duplicate-region composite without the guard firing; passes when the guard fired', () => {
    const cfg = {
      states: {
        root: { regions: { regionA: { leaf1: {}, leaf2: {} } } },
      },
      events: {},
    }
    // Two parts collapse to region key 'root.regionA' → containment broken.
    const dirty: CanonicalTrace = {
      header: HEADER,
      frames: [frame({ step: 1, to: 'root.regionA.leaf1|root.regionA.leaf2' })],
    }
    const v = runSafety(INVARIANTS, dirty, ctxFor(cfg, 8))
    expect(v?.invariantId).toBe('I-6')
    expect(v?.errorClass).toBe('contradictory-state')
    // Witness is '|'-normalized (sorted).
    expect(v?.witness).toBe('root.regionA.leaf1|root.regionA.leaf2')
    // Same shape WITH the guard fired (errorClass present + synthetic) → clean.
    const clean: CanonicalTrace = {
      header: HEADER,
      frames: [
        frame({
          step: 1,
          to: 'root.regionA.leaf1|root.regionA.leaf2',
          errorClass: 'contradictory-state',
          synthetic: 'corrupt-state',
        }),
      ],
    }
    expect(runSafety(INVARIANTS, clean, ctxFor(cfg, 8))).toBeNull()
  })

  it('I-7 catches an external settle with internal still queued; whitelists reorder/post-restore', () => {
    const dirty: CanonicalTrace = {
      header: HEADER,
      frames: [frame({ step: 1, cause: 'external', event: 'go', fireOutcome: 'resolve-true', queue: { internal: 2, external: 0 }, quiescent: true })],
    }
    expect(runSafety(INVARIANTS, dirty, baseCtx())?.invariantId).toBe('I-7')
    const whitelisted: CanonicalTrace = {
      header: HEADER,
      frames: [frame({ step: 1, cause: 'external', event: 'go', fireOutcome: 'resolve-true', queue: { internal: 2, external: 0 }, quiescent: true, faultApplied: 'reorder' })],
    }
    expect(runSafety(INVARIANTS, whitelisted, baseCtx())).toBeNull()
  })

  it('I-8 catches a depth reject that did not clear the internal queue; passes a cleared one', () => {
    const dirty: CanonicalTrace = {
      header: HEADER,
      frames: [frame({ step: 1, errorClass: 'max-transition-depth', quiescent: false, queue: { internal: 3, external: 0 } })],
    }
    expect(runSafety(INVARIANTS, dirty, baseCtx())?.invariantId).toBe('I-8')
    const clean: CanonicalTrace = {
      header: HEADER,
      frames: [frame({ step: 1, errorClass: 'max-transition-depth', quiescent: true, queue: { internal: 0, external: 0 } })],
    }
    expect(runSafety(INVARIANTS, clean, baseCtx())).toBeNull()
  })

  it('I-9 catches a queue depth over the bound; passes within the bound; vacuous without a bound', () => {
    const cfg = { states: { a: {} }, events: {} }
    const dirty: CanonicalTrace = {
      header: HEADER,
      frames: [frame({ step: 1, to: 'a', queue: { internal: 3, external: 2 } })],
    }
    expect(runSafety(INVARIANTS, dirty, ctxFor(cfg, 4))?.invariantId).toBe('I-9')
    const clean: CanonicalTrace = {
      header: HEADER,
      frames: [frame({ step: 1, to: 'a', queue: { internal: 2, external: 1 } })],
    }
    expect(runSafety(INVARIANTS, clean, ctxFor(cfg, 4))).toBeNull()
    // No bound → vacuous.
    expect(runSafety(INVARIANTS, dirty, ctxFor(cfg))).toBeNull()
  })

  it('I-11 catches an injected fault that left internal work pending; passes a contained one', () => {
    const dirty: CanonicalTrace = {
      header: HEADER,
      frames: [frame({ step: 1, errorClass: 'injected-fault', quiescent: false, queue: { internal: 2, external: 0 } })],
    }
    expect(runSafety(INVARIANTS, dirty, baseCtx())?.invariantId).toBe('I-11')
    const clean: CanonicalTrace = {
      header: HEADER,
      frames: [frame({ step: 1, errorClass: 'injected-fault', quiescent: true, queue: { internal: 0, external: 0 } })],
    }
    expect(runSafety(INVARIANTS, clean, baseCtx())).toBeNull()
  })

  it('I-12 catches an undeclared done event and a wildcard-routed one; passes a declared one', () => {
    const cfg = { states: { root: {} }, events: { 'done.state.root': {} } }
    const undeclared: CanonicalTrace = {
      header: HEADER,
      frames: [frame({ step: 1, cause: 'internal', from: 'root', to: 'root', event: 'done.state.other' })],
    }
    expect(runSafety(INVARIANTS, undeclared, ctxFor(cfg, 8))?.invariantId).toBe('I-12')
    const wildcard: CanonicalTrace = {
      header: HEADER,
      frames: [frame({ step: 1, cause: 'internal', event: 'done.state.root', from: '*', to: 'root' })],
    }
    expect(runSafety(INVARIANTS, wildcard, ctxFor(cfg, 8))?.invariantId).toBe('I-12')
    const declared: CanonicalTrace = {
      header: HEADER,
      frames: [frame({ step: 1, cause: 'internal', event: 'done.state.root', from: 'root', to: 'root' })],
    }
    expect(runSafety(INVARIANTS, declared, ctxFor(cfg, 8))).toBeNull()
  })
})

// ── DoD 4/5: corrupt-state TWO scenarios via the real engine (I-6 / I-10) ─────

describe('corrupt-state I-6 / I-10 via the real engine (DoD 4/5)', () => {
  it('I-10 unregistered-leaf: getCurrentState(:1219) throws invalid-state-path; ONE synthetic frame', async () => {
    const config = {
      name: 'i10',
      stateAttribute: 'state',
      initialState: 'idle',
      states: { idle: {}, running: {} },
      events: { tick: { transitions: [{ from: 'idle', to: 'running' }] } },
    } as unknown as StateMachineConfig<Box>

    const adaptee = new MemoryAdapter<Box>({ state: 'idle', log: [], k: 0 })
    const writes: CapturedWrite[] = []
    const wrapped = wrapAdapterForCapture(adaptee as unknown as never, 'state', {
      onStateWrite: (w) => writes.push(w),
    })
    const clock = makeSimClock(0)
    const { scheduler } = makeObservableScheduler(clock)
    const sm = new StateMachine<Box, StateMachineConfig<Box>>(config, wrapped as never, {
      clock: clock.now,
      scheduler,
    } as never)

    // Deliver the unregistered-leaf payload, then the harness-driven read throws.
    writes.length = 0
    issueCorruptStateWrite(wrapped, 'state', I10_PROBE)
    expect(writes).toHaveLength(1) // exactly ONE synthetic corrupt-state write
    let thrown: unknown
    try {
      sm.getCurrentState()
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(/Invalid state path in current state/)
    // The errorClass comes from field-selection on the probe, never the message.
    expect(classifyCorruptState(I10_PROBE)).toBe('invalid-state-path')

    // Build the I-10 witness frame as the harness would and assert the oracle fires
    // CLEAN on the synthetic frame (the guard firing is the positive witness).
    const synthetic: CanonicalTrace = {
      header: HEADER,
      frames: [
        // a clean run up to the probe (the registered terminal config) …
        frame({ step: 0, cause: 'init', from: 'idle', to: 'idle' }),
        // … then the corrupt-state probe as the LAST op (a witness, not terminal).
        frame({
          step: 1,
          from: 'idle',
          to: I10_PROBE.payload,
          synthetic: 'corrupt-state',
          errorClass: 'invalid-state-path',
        }),
      ],
    }
    const cfgGraph = { states: { idle: {}, running: {} }, events: {} }
    // The guard fired (synthetic frame) → I-10 stays clean (it tests the THROW);
    // the trailing synthetic corrupt-state payload is NOT validated as the final
    // config (it is a witness), so the registered 'idle' is the terminal config.
    expect(runSafety(INVARIANTS, synthetic, ctxFor(cfgGraph, 8))).toBeNull()
  })

  it('I-10: removing the corrupt-state fault makes the invariant vacuously pass (no witness)', () => {
    // A clean run with only registered parts → no I-10 witness anywhere.
    const cfg = { states: { idle: {}, running: {} }, events: {} }
    const clean: CanonicalTrace = {
      header: HEADER,
      frames: [frame({ step: 0, cause: 'init', to: 'idle' }), frame({ step: 1, to: 'running' })],
    }
    expect(runSafety(INVARIANTS, clean, ctxFor(cfg, 8))).toBeNull()
  })

  it('I-10 final-scope: a final config with an unregistered part is caught', () => {
    const cfg = { states: { idle: {}, running: {} }, events: {} }
    const dirty: CanonicalTrace = {
      header: HEADER,
      frames: [frame({ step: 5, to: 'bogusLeaf' })],
    }
    const v = runSafety(INVARIANTS, dirty, ctxFor(cfg, 8))
    expect(v?.invariantId).toBe('I-10')
    expect(v?.errorClass).toBe('invalid-state-path')
  })

  it('I-6 duplicate-region via the restore path (:734) throws contradictory-state', async () => {
    const config = {
      name: 'i6',
      stateAttribute: 'state',
      initialState: 'root',
      states: {
        root: { regions: { regionA: { leaf1: {}, leaf2: {} } } },
      },
      events: {},
    } as unknown as StateMachineConfig<Box>
    const adaptee = new MemoryAdapter<Box>({ state: 'root', log: [], k: 0 })
    const clock = makeSimClock(0)
    const { scheduler } = makeObservableScheduler(clock)
    const sm = new StateMachine<Box, StateMachineConfig<Box>>(config, adaptee as never, {
      clock: clock.now,
      scheduler,
    } as never)

    // A restore adapter returning the I-6 duplicate-region payload: the engine's
    // validateCompositeState(:734) sees BOTH parts collapse to 'root.regionA' and
    // throws 'Contradictory state detected' BEFORE the silent :1203 de-dup.
    const restoreAdapter: StatePersistenceAdapter = {
      // biome-ignore lint/suspicious/noExplicitAny: matching the engine's loose persistence shape
      async save(): Promise<void> {},
      async restore() {
        return {
          currentState: I6_PROBE.payload, // 'root.regionA.leaf1|root.regionA.leaf2'
          // biome-ignore lint/suspicious/noExplicitAny: engine restore() returns loose any
          history: {} as any,
          // biome-ignore lint/suspicious/noExplicitAny: engine restore() returns loose any
          stateEntryTimes: {} as any,
        }
      },
    }
    let thrown: unknown
    try {
      await sm.restoreState(restoreAdapter)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(/Contradictory state detected/)
    // The errorClass is by field-selection, never the message.
    expect(classifyCorruptState(I6_PROBE)).toBe('contradictory-state')
  })

  it('I-6: the engine de-dups a duplicate written via :1203 silently — the throw MUST come from :734', () => {
    // PIN the HIGH fold: a duplicate written directly via adaptee.set does NOT throw
    // at :1203 (last-write-wins de-dup); only the restore/transition-target path
    // (:734/:2309/:2353) validates BEFORE de-dup. We confirm the probe delivery is
    // 'restore' (the throwing site), never the direct-write silent-dedup path.
    expect(I6_PROBE.delivery).toBe('restore')
    expect(I10_PROBE.delivery).toBe('unregistered-leaf')
  })
})

// ── DoD 10: each scenario passes I-1 FIRST; a non-deterministic fixture rejected ─

describe('I-1 determinism gate runs first (DoD 10)', () => {
  it('a deliberately non-deterministic fixture is rejected before any other invariant', () => {
    // Even with a clean trace, mismatched hashes short-circuit to I-1.
    const trace: CanonicalTrace = { header: HEADER, frames: [frame({ step: 0, cause: 'init' })] }
    const v = runSafetyWithDeterminism(INVARIANTS, trace, ctxFor({ states: { a: {} }, events: {} }), {
      a: 'h1',
      b: 'h2',
    })
    expect(v?.invariantId).toBe('I-1')
  })

  it('a real driver run is deterministic: two runs of the same seed hash equal (I-1 clean)', async () => {
    const config = {
      name: 'det',
      stateAttribute: 'state',
      initialState: 'idle',
      states: { idle: {}, active: {} },
      events: { go: { transitions: [{ from: 'idle', to: 'active' }] } },
    } as unknown as StateMachineConfig<Box>
    const run = async (): Promise<string> => {
      const d = makeDriver(config, { state: 'idle', log: [], k: 0 })
      await d.init()
      await d.step({ kind: 'fire', event: 'go' })
      return hashTrace(d.trace())
    }
    const h1 = await run()
    const h2 = await run()
    expect(h1).toBe(h2)
  })
})

// ── DoD 11: ISS-033 non-vacuous pins (≥2 regions, ≥2 same-depth done siblings) ─

describe('ISS-033 non-vacuous pins (DoD 11)', () => {
  it('(a) a ≥2-parallel-region machine: |-normalization stable across region-declaration-order permutations', async () => {
    // Two regions, each with >1 sibling that could legitimately order differently.
    const mk = (regionOrder: 'ab' | 'ba'): StateMachineConfig<Box> => {
      const regionA = { a1: { final: true }, a2: {} }
      const regionB = { b1: { final: true }, b2: {} }
      const regions = regionOrder === 'ab' ? { regionA, regionB } : { regionB, regionA }
      return {
        name: 'parallel',
        stateAttribute: 'state',
        initialState: 'root',
        states: { root: { regions } },
        events: {},
      } as unknown as StateMachineConfig<Box>
    }
    const run = async (order: 'ab' | 'ba'): Promise<string[]> => {
      const d = makeDriver(mk(order), { state: 'root', log: [], k: 0 }, { policy: 'liveness' })
      await d.init()
      return d.trace().frames.map((f) => f.to)
    }
    const ab = await run('ab')
    const ba = await run('ba')
    // The '|'-normalized `to` parts are identical regardless of region-declaration
    // order — the normalizer compensates the :1202 insertion-order render. We assert
    // every rendered `to` is '|'-sorted (the comparator lock).
    for (const to of [...ab, ...ba]) {
      const parts = to.split('|')
      const sorted = [...parts].sort()
      expect(parts).toEqual(sorted)
    }
  })

  it('(b) a ≥2-same-depth-sibling done.state topology: the oracle reads ground-truth raise order', () => {
    // The :1493 sort is depth-only with NO same-depth tiebreak. The oracle must read
    // the OBSERVED done order from the trace, not assume one. We pin that two
    // same-depth done.state events both appear and I-12 accepts BOTH orderings.
    const cfg = { states: { root: {} }, events: { 'done.state.root.r1': {}, 'done.state.root.r2': {} } }
    // done.state.<C> events are engine-RAISED (cause:'internal'), not external fires.
    const orderA: CanonicalTrace = {
      header: HEADER,
      frames: [
        frame({ step: 1, cause: 'internal', event: 'done.state.root.r1', from: 'root', to: 'root' }),
        frame({ step: 2, cause: 'internal', event: 'done.state.root.r2', from: 'root', to: 'root' }),
      ],
    }
    const orderB: CanonicalTrace = {
      header: HEADER,
      frames: [
        frame({ step: 1, cause: 'internal', event: 'done.state.root.r2', from: 'root', to: 'root' }),
        frame({ step: 2, cause: 'internal', event: 'done.state.root.r1', from: 'root', to: 'root' }),
      ],
    }
    // Both orderings are accepted (the oracle reads ground truth, not an assumed order).
    expect(runSafety(INVARIANTS, orderA, ctxFor(cfg, 8))).toBeNull()
    expect(runSafety(INVARIANTS, orderB, ctxFor(cfg, 8))).toBeNull()
  })
})

// ── DoD 9: purity — checkers make no live engine call; ProgressFingerprint normalized ─

describe('checker purity grep + config-graph (DoD 9)', () => {
  it('invariants.ts / invariants.runner.ts contain no settle/drain/flush/Math.random/Date.now', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const here = path.dirname(new URL(import.meta.url).pathname)
    const simDir = path.resolve(here, '../../sim')
    for (const file of ['invariants.ts', 'invariants.runner.ts', 'liveness.ts', 'fairness.ts']) {
      const src = fs.readFileSync(path.join(simDir, file), 'utf8')
      // Strip block comments and line comments so JSDoc {@link settleMacrostep}
      // cross-references and prose citations ("never a live sm.isDone()") do not
      // trip the grep; only LIVE source (calls + imports) is checked.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, ''))
        .join('\n')
      expect(code).not.toMatch(/Math\.random/)
      expect(code).not.toMatch(/Date\.now/)
      expect(code).not.toMatch(/performance\.now/)
      expect(code).not.toMatch(/process\.hrtime/)
      // No LOCAL settle/drain/flush CALL or import (the cross-reference in a JSDoc
      // {@link} is fine; an actual call/import is the violation).
      expect(code).not.toMatch(/\bflush\(/)
      expect(code).not.toMatch(/drainToQuiescence/)
      expect(code).not.toMatch(/settleMacrostep\(/)
      expect(code).not.toMatch(/from '\.\/settle'/)
      expect(code).not.toMatch(/from '\.\/driver'/)
      // No LIVE engine read in a checker body (a call, not a prose mention).
      expect(code).not.toMatch(/\bsm\.isDone\(/)
      expect(code).not.toMatch(/\bsm\.getCurrentState\(/)
      expect(code).not.toMatch(/\.isDone\(/)
      expect(code).not.toMatch(/\.getCurrentState\(/)
    }
  })

  it('buildConfigGraph replicates getRegionKey (lastIndexOf split) and depthOf', () => {
    const g = buildConfigGraph({ states: { root: { regions: { rA: { leaf: {} } } } }, events: {} })
    expect(g.getRegionKey('root.rA.leaf')).toBe('root.rA')
    expect(g.getRegionKey('atomic')).toBe('atomic')
    expect(g.depthOf('root.rA.leaf')).toBe(2)
    expect(g.depthOf('root')).toBe(0)
    expect(g.isRegisteredLeaf('root.rA.leaf')).toBe(true)
    expect(g.isRegisteredLeaf('not.a.state')).toBe(false)
    expect(g.composites.has('root')).toBe(true)
  })

  it('makeViolation normalizes the witness and mirrors it into the fingerprint', () => {
    const v = makeViolation({
      invariantId: 'I-X',
      step: 2,
      witness: 'b|a|c',
      errorClass: 'invalid-state-path',
      message: 'm',
      observed: 'o',
      expected: 'e',
    })
    expect(v.witness).toBe('a|b|c')
    expect(v.fingerprint.witness).toBe('a|b|c')
    expect(v.fingerprint.errorClass).toBe('invalid-state-path')
  })

  it('finalStateOf projects the last frame; empty trace → empty terminal', () => {
    const trace: CanonicalTrace = {
      header: HEADER,
      frames: [frame({ step: 0, to: 'a' }), frame({ step: 1, to: 'b', queue: { internal: 1, external: 0 }, quiescent: false })],
    }
    const fs = finalStateOf(trace)
    expect(fs.config).toBe('b')
    expect(fs.queue.internal).toBe(1)
    expect(fs.quiescent).toBe(false)
    const empty = finalStateOf({ header: HEADER, frames: [] })
    expect(empty.config).toBe('')
  })
})

// ── I-4 / I-5 clean-path coverage (the order + join invariants do not false-fire) ─

describe('I-4 / I-5 do not false-fire on well-formed composites', () => {
  // ── W8/V3a — I-4 moved from a documented no-op to LIFECYCLE-KEYED teeth. It no
  // longer inspects the content-only frame at all (the callback ORDER is simply
  // not in it); it reads the captured `IMonitor.recordLifecycle` stream on the
  // CheckerContext. These cases pin the FALSE-POSITIVE frontier — the shapes a
  // naive ancestor/depth check would wrongly flag.
  const inv4 = (): Invariant => INVARIANTS.find((i) => i.id === 'I-4') as Invariant
  const FINAL = { config: 'a', queue: { internal: 0, external: 0 }, quiescent: true }
  const life = (
    over: Partial<LifecycleObservation> & { state: string; microstep: number },
  ): LifecycleObservation => ({ kind: 'enter', hook: 'onEnter', owner: OWNER_A, seq: 0, edge: 'begin', ...over })
  const withLifecycle = (cfg: unknown, lifecycle: readonly LifecycleObservation[]): CheckerContext => ({
    ...ctxFor(cfg, 8),
    lifecycle,
  })
  const CFG_NESTED = { states: { root: { regions: { rA: { l1: {} }, rB: { l2: {} } } } }, events: {} }

  it('I-4 exposes no checkStep: the content-only frame carries no callback order to check', () => {
    // Guards the SOUNDNESS boundary: a frame-shaped I-4 check would have to infer
    // hook order from leaf snapshots, which is exactly the false-positive the old
    // documented-no-op comment refused to ship.
    expect(inv4().checkStep).toBeUndefined()
    expect(inv4().scope).toBe('final')
  })

  it('I-4 is VACUOUS without a lifecycle plane (a missing observation never fabricates a violation)', () => {
    expect(inv4().checkFinal?.(FINAL, ctxFor(CFG_NESTED, 8))).toBeNull()
    expect(inv4().checkFinal?.(FINAL, withLifecycle(CFG_NESTED, []))).toBeNull()
  })

  it('I-4 stays clean on a correct W3C order: enter ancestor→descendant, exit descendant→ancestor', () => {
    const stream: LifecycleObservation[] = [
      life({ state: 'root', microstep: 1, seq: 0 }),
      life({ state: 'root.rA.l1', microstep: 1, seq: 1 }),
      life({ state: 'root.rB.l2', microstep: 1, seq: 2 }),
      life({ kind: 'exit', hook: 'onExit', state: 'root.rA.l1', microstep: 2, seq: 3 }),
      life({ kind: 'exit', hook: 'onExit', state: 'root', microstep: 2, seq: 4 }),
    ]
    expect(inv4().checkFinal?.(FINAL, withLifecycle(CFG_NESTED, stream))).toBeNull()
  })

  it('I-4 stays clean on SIBLING branches in any order (the depth-number trap)', () => {
    // `root.rA.l1` (depth 2) entered BEFORE `root.rB` (depth 1). A depth-comparison
    // predicate would flag this; the ancestor relation correctly does not, because
    // neither state contains the other. Parallel-region entry order is document
    // order and is free to interleave.
    const stream: LifecycleObservation[] = [
      life({ state: 'root', microstep: 3, seq: 0 }),
      life({ state: 'root.rA.l1', microstep: 3, seq: 1 }),
      life({ state: 'root.rB', microstep: 3, seq: 2 }),
    ]
    expect(inv4().checkFinal?.(FINAL, withLifecycle(CFG_NESTED, stream))).toBeNull()
  })

  it('I-4 stays clean when an inversion spans DIFFERENT microsteps or DIFFERENT owners', () => {
    // Two independent microsteps: entering a descendant in one and its ancestor in
    // a later one is an ordinary drill-down, not an in-microstep order break.
    const crossStep: LifecycleObservation[] = [
      life({ state: 'root.rA.l1', microstep: 4, seq: 0 }),
      life({ state: 'root', microstep: 5, seq: 1 }),
    ]
    expect(inv4().checkFinal?.(FINAL, withLifecycle(CFG_NESTED, crossStep))).toBeNull()
    // Same microstep, two DIFFERENT owners: two independent hierarchies whose
    // timelines interleave — never comparable against each other.
    const crossOwner: LifecycleObservation[] = [
      life({ state: 'root.rA.l1', microstep: 6, seq: 0, owner: OWNER_A }),
      life({ state: 'root', microstep: 6, seq: 1, owner: OWNER_B }),
    ]
    expect(inv4().checkFinal?.(FINAL, withLifecycle(CFG_NESTED, crossOwner))).toBeNull()
  })

  it('I-4 ignores guard records (their `state` is a SELECTOR, not a path) and invoke records', () => {
    // 'root.rA.*' would dot-parse as a descendant of 'root' — treating a selector
    // as a path is precisely how a naive checker invents ancestry.
    const stream: LifecycleObservation[] = [
      life({ kind: 'guard', hook: 'guard', state: 'root.rA.*', microstep: 7, seq: 0, transition: 'root.rA.* -> x' }),
      life({ kind: 'guard', hook: 'guard', state: 'root', microstep: 7, seq: 1, transition: 'root -> y' }),
      life({ kind: 'invoke', hook: 'invoke.action', state: 'root.rA.l1', microstep: 8, seq: 2 }),
      life({ kind: 'invoke', hook: 'invoke.action', state: 'root', microstep: 8, seq: 3 }),
    ]
    expect(inv4().checkFinal?.(FINAL, withLifecycle(CFG_NESTED, stream))).toBeNull()
  })

  it('I-4 ignores microstep 0 (construction / reset / resumeTimers share that reserved id)', () => {
    const stream: LifecycleObservation[] = [
      life({ state: 'root.rA.l1', microstep: 0, seq: 0 }),
      life({ state: 'root', microstep: 0, seq: 1 }),
    ]
    expect(inv4().checkFinal?.(FINAL, withLifecycle(CFG_NESTED, stream))).toBeNull()
  })

  it('I-4 ignores `end` edges: only `begin` defines invocation order', () => {
    // `end` order is SETTLE order. Ordering on it would flag a correct machine
    // whose ancestor onEnter simply resolves after its descendant's.
    const stream: LifecycleObservation[] = [
      life({ state: 'root', microstep: 9, seq: 0, edge: 'begin' }),
      life({ state: 'root.rA.l1', microstep: 9, seq: 1, edge: 'begin' }),
      life({ state: 'root.rA.l1', microstep: 9, seq: 2, edge: 'end' }),
      life({ state: 'root', microstep: 9, seq: 3, edge: 'end' }),
    ]
    expect(inv4().checkFinal?.(FINAL, withLifecycle(CFG_NESTED, stream))).toBeNull()
  })

  it('I-4 FIRES on a descendant entered before its ancestor in ONE microstep', () => {
    const stream: LifecycleObservation[] = [
      life({ state: 'root.rA.l1', microstep: 11, seq: 0 }),
      life({ state: 'root', microstep: 11, seq: 1 }),
    ]
    const v = inv4().checkFinal?.(FINAL, withLifecycle(CFG_NESTED, stream))
    expect(v?.invariantId).toBe('I-4')
    expect(v?.witness).toBe('enter@11:root.rA.l1>root')
  })

  it('I-4 FIRES on an ancestor exited before its descendant in ONE microstep', () => {
    const stream: LifecycleObservation[] = [
      life({ kind: 'exit', hook: 'onExit', state: 'root', microstep: 12, seq: 0 }),
      life({ kind: 'exit', hook: 'onExit', state: 'root.rA.l1', microstep: 12, seq: 1 }),
    ]
    const v = inv4().checkFinal?.(FINAL, withLifecycle(CFG_NESTED, stream))
    expect(v?.invariantId).toBe('I-4')
    expect(v?.witness).toBe('exit@12:root>root.rA.l1')
  })

  it('I-4 does not confuse a NAME PREFIX with an ancestor (root vs rootish)', () => {
    const stream: LifecycleObservation[] = [
      life({ state: 'rootish', microstep: 13, seq: 0 }),
      life({ state: 'root', microstep: 13, seq: 1 }),
    ]
    expect(inv4().checkFinal?.(FINAL, withLifecycle(CFG_NESTED, stream))).toBeNull()
  })

  it('I-5 stays clean when a declared-done composite is observed done via doneDelta', () => {
    const cfg = { states: { root: {} }, events: { 'done.state.root': {} } }
    const trace: CanonicalTrace = {
      header: HEADER,
      frames: [frame({ step: 1, from: 'root', to: 'root', doneDelta: [{ composite: 'root', done: true }] })],
    }
    expect(runSafety(INVARIANTS, trace, ctxFor(cfg, 8))).toBeNull()
  })

  // ── W9/Г1 — I-5 PURE-CHECKER teeth + the FALSE-POSITIVE frontier ────────────
  // The checkers are pure, so the predicate is exercised DIRECTLY on a synthetic
  // CheckerContext (fabricated frames + a fabricated raise stream). The e2e half —
  // that a REAL engine run emits these records, and that removing them makes I-5
  // fire — lives in observation_plane.test.ts (planted defect, no engine mutation).
  const inv5 = (): Invariant => INVARIANTS.find((i) => i.id === 'I-5') as Invariant
  /** A parallel composite C with a DECLARED join, plus an UNDECLARED composite D. */
  const CFG_JOIN = {
    states: {
      C: { regions: { r1: { w1: {}, d1: { final: true } }, r2: { w2: {}, d2: { final: true } } } },
      D: { regions: { r1: { x1: {}, y1: { final: true } } } },
    },
    events: { 'done.state.C': {} },
  }
  const I5_FINAL = { config: 'C', queue: { internal: 0, external: 0 }, quiescent: true }
  /** A settle-BOUNDARY frame: the doneDelta projection is what marks one. */
  const bframe = (
    step: number,
    done: Record<string, boolean>,
    over?: Partial<TraceFrame>,
  ): TraceFrame =>
    frame({
      step,
      from: 'C',
      to: 'C',
      doneDelta: Object.entries(done).map(([composite, d]) => ({ composite, done: d })),
      ...over,
    })
  /** One engine raise record (the `begin` half of the adjacent begin+end pair). */
  const raiseRec = (
    event: string,
    seq: number,
    over?: Partial<LifecycleObservation>,
  ): LifecycleObservation => ({
    kind: 'raise',
    hook: 'raise.done',
    state: 'C',
    owner: OWNER_A,
    microstep: 1,
    seq,
    edge: 'begin',
    event,
    ...over,
  })
  const i5ctx = (
    frames: readonly TraceFrame[],
    raises: readonly LifecycleObservation[] | undefined,
    over?: Partial<CheckerContext>,
  ): CheckerContext => ({
    ...ctxFor(CFG_JOIN, 8),
    frames,
    ...(raises !== undefined ? { raises } : {}),
    ...over,
  })

  it('I-5 is final-scoped and counting: it exposes NO checkStep (a single frame carries no edge)', () => {
    expect(inv5().checkStep).toBeUndefined()
    expect(inv5().scope).toBe('final')
  })

  it('I-5 FIRES: the composite ENTERED its all-final configuration but no done.state.C was raised', () => {
    const frames = [bframe(1, { C: false }), bframe(2, { C: true })]
    const v = inv5().checkFinal?.(I5_FINAL, i5ctx(frames, []))
    expect(v?.invariantId).toBe('I-5')
    expect(v?.witness).toBe('C')
    expect(v?.observed).toContain("0 raise(s) of 'done.state.C'")
  })

  it('I-5 stays clean when the engine DID raise the declared join', () => {
    const frames = [bframe(1, { C: false }), bframe(2, { C: true })]
    expect(inv5().checkFinal?.(I5_FINAL, i5ctx(frames, [raiseRec('done.state.C', 0)]))).toBeNull()
  })

  it('I-5 tolerates MORE raises than edges (microstep vs macrostep granularity)', () => {
    // The engine checks the done edge per MICROSTEP; the harness samples doneDelta
    // per settle BOUNDARY. A done→undone→done blink inside one macrostep raises
    // TWICE but shows ONE boundary edge. `>` is the only sound direction.
    const frames = [bframe(1, { C: false }), bframe(2, { C: true })]
    const raises = [raiseRec('done.state.C', 0), raiseRec('done.state.C', 2)]
    expect(inv5().checkFinal?.(I5_FINAL, i5ctx(frames, raises))).toBeNull()
  })

  it('I-5 counts RE-ENTRY: leaving and re-entering the done configuration expects TWO raises', () => {
    const frames = [
      bframe(1, { C: false }),
      bframe(2, { C: true }),
      bframe(3, { C: false }),
      bframe(4, { C: true }),
    ]
    // one raise for two edges → fires
    const v = inv5().checkFinal?.(I5_FINAL, i5ctx(frames, [raiseRec('done.state.C', 0)]))
    expect(v?.invariantId).toBe('I-5')
    expect(v?.expected).toContain('at least 2')
    // two raises → clean
    const raises = [raiseRec('done.state.C', 0), raiseRec('done.state.C', 4)]
    expect(inv5().checkFinal?.(I5_FINAL, i5ctx(frames, raises))).toBeNull()
  })

  it('FP-surface: EDGE-TRIGGERED — a done PLATEAU is not a new expectation', () => {
    // done.state.C is generated once, when the done configuration is ENTERED. A
    // composite that stays all-final across later macrosteps is NOT re-signalled.
    const frames = [
      bframe(1, { C: false }),
      bframe(2, { C: true }),
      bframe(3, { C: true }),
      bframe(4, { C: true }),
    ]
    expect(inv5().checkFinal?.(I5_FINAL, i5ctx(frames, [raiseRec('done.state.C', 0)]))).toBeNull()
  })

  it('FP-surface: a composite ALREADY all-final at frame 0 is not an edge (no predecessor)', () => {
    const frames = [bframe(0, { C: true }, { cause: 'init' }), bframe(1, { C: true })]
    expect(inv5().checkFinal?.(I5_FINAL, i5ctx(frames, []))).toBeNull()
  })

  it("FP-surface: a step carrying a synthetic:'post-restore' frame is excluded (restoreState does NOT re-fire the join)", () => {
    const frames = [
      bframe(1, { C: false }),
      bframe(2, { C: true }, { synthetic: 'post-restore' }),
    ]
    expect(inv5().checkFinal?.(I5_FINAL, i5ctx(frames, []))).toBeNull()
  })

  it("FP-surface: a step carrying a synthetic:'corrupt-state' frame is excluded (the probe writes past checkCompletion)", () => {
    // The exclusion is per STEP, not per frame: the boundary frame that carries the
    // doneDelta may be a different frame of the same corrupt-state step.
    const frames = [
      bframe(1, { C: false }),
      frame({ step: 2, from: 'C', to: 'C', synthetic: 'corrupt-state' }),
      bframe(2, { C: true }),
    ]
    expect(inv5().checkFinal?.(I5_FINAL, i5ctx(frames, []))).toBeNull()
  })

  it("FP-surface: a step carrying a synthetic:'errorState-fallback' frame is excluded (the recovery commits past checkCompletion)", () => {
    // No harness produces this tag today (see the KNOWN RESIDUAL note on I-5), but
    // the exclusion is in place BEFORE a producer exists so the oracle cannot start
    // false-positiving the day one appears.
    const frames = [
      bframe(1, { C: false }),
      bframe(2, { C: true }, { synthetic: 'errorState-fallback' }),
    ]
    expect(inv5().checkFinal?.(I5_FINAL, i5ctx(frames, []))).toBeNull()
  })

  it('FP-surface: an UNDECLARED done.state.<C> is never raised by the engine, so it is never expected', () => {
    // D is a real composite but the config declares no `done.state.D` event; the
    // engine gates the raise on events.has(...) and stays silent. Keying on
    // declaredDoneEvents is what keeps this clean.
    const frames = [bframe(1, { C: false, D: false }), bframe(2, { C: true, D: true })]
    expect(
      inv5().checkFinal?.(I5_FINAL, i5ctx(frames, [raiseRec('done.state.C', 0)])),
    ).toBeNull()
  })

  it('FP-surface: a composite ABSENT from the predecessor sample is not an edge', () => {
    // `undefined` is not `false`: without an observed not-done predecessor there is
    // no evidence the configuration was ENTERED during the run.
    const frames = [bframe(1, { D: false }), bframe(2, { C: true, D: false })]
    expect(inv5().checkFinal?.(I5_FINAL, i5ctx(frames, []))).toBeNull()
  })

  it('FP-surface: VACUOUS without a raise plane (ctx.raises undefined) — I-4 convention', () => {
    const frames = [bframe(1, { C: false }), bframe(2, { C: true })]
    expect(inv5().checkFinal?.(I5_FINAL, i5ctx(frames, undefined))).toBeNull()
  })

  it('FP-surface: VACUOUS when the raise buffer TRUNCATED (an under-count would be a false positive)', () => {
    const frames = [bframe(1, { C: false }), bframe(2, { C: true })]
    expect(
      inv5().checkFinal?.(I5_FINAL, i5ctx(frames, [], { raisesTruncated: true })),
    ).toBeNull()
  })

  it('FP-surface: VACUOUS with fewer than two boundary frames (no adjacent pair exists)', () => {
    expect(inv5().checkFinal?.(I5_FINAL, i5ctx([bframe(1, { C: true })], []))).toBeNull()
    expect(inv5().checkFinal?.(I5_FINAL, i5ctx([], []))).toBeNull()
  })

  it("I-5 counts only the `begin` edge of the raise pair (counting `end` too would double every raise)", () => {
    const frames = [bframe(1, { C: false }), bframe(2, { C: true })]
    // ONLY the `end` half present → the raise is NOT counted → fires.
    const endsOnly = [raiseRec('done.state.C', 1, { edge: 'end' })]
    expect(inv5().checkFinal?.(I5_FINAL, i5ctx(frames, endsOnly))?.invariantId).toBe('I-5')
    // The real adjacent pair counts exactly ONCE → clean.
    const pair = [raiseRec('done.state.C', 0), raiseRec('done.state.C', 1, { edge: 'end' })]
    expect(inv5().checkFinal?.(I5_FINAL, i5ctx(frames, pair))).toBeNull()
  })

  it('I-5 ignores non-raise lifecycle records that happen to carry the same event name', () => {
    const frames = [bframe(1, { C: false }), bframe(2, { C: true })]
    const decoy: LifecycleObservation[] = [
      { kind: 'enter', hook: 'onEnter', state: 'C', owner: OWNER_A, microstep: 1, seq: 0, edge: 'begin', event: 'done.state.C' },
    ]
    expect(inv5().checkFinal?.(I5_FINAL, i5ctx(frames, decoy))?.invariantId).toBe('I-5')
  })

  it('the RUNNER supplies the frames to checkFinal: runSafety fires I-5 without the caller passing any', () => {
    // The caller's context carries the raise plane only. Sequence-shaped final-scope
    // predicates get their frames from the runner, so an oracle can never be armed
    // on one call path and silently vacuous on another.
    const frames = [bframe(1, { C: false }), bframe(2, { C: true })]
    const callerCtx: CheckerContext = { ...ctxFor(CFG_JOIN, 8), raises: [] }
    expect(callerCtx.frames).toBeUndefined()
    const v = runSafety(INVARIANTS, { header: HEADER, frames }, callerCtx)
    expect(v?.invariantId).toBe('I-5')
  })

  it('I-6 NON-synthetic frame carrying contradictory-state errorClass (transition-target throw) is clean', () => {
    // The transition-target throwing site (:2309/:2353) is NOT synthetic but DOES
    // carry errorClass:'contradictory-state' — the guard fired, so I-6 stays clean.
    const cfg = { states: { root: { regions: { rA: { l1: {}, l2: {} } } } }, events: {} }
    const inv6 = INVARIANTS.find((i) => i.id === 'I-6') as Invariant
    const f = frame({ step: 1, to: 'root.rA.l1|root.rA.l2', errorClass: 'contradictory-state' })
    expect(inv6.checkStep?.(f, ctxFor(cfg, 8))).toBeNull()
    // a distinct-region multi-part composite reaches the end-of-loop clean return.
    const cfg2 = { states: { root: { regions: { rA: { l1: {} }, rB: { l2: {} } } } }, events: {} }
    const distinct = frame({ step: 2, to: 'root.rA.l1|root.rB.l2' })
    expect(inv6.checkStep?.(distinct, ctxFor(cfg2, 8))).toBeNull()
  })

  it('I-7 whitelists a post-restore resumed-invoke external routing', () => {
    const cfg = { states: { a: {} }, events: { go: {} } }
    const inv7 = INVARIANTS.find((i) => i.id === 'I-7') as Invariant
    const f = frame({
      step: 1,
      cause: 'external',
      event: 'go',
      to: 'a',
      fireOutcome: 'resolve-true',
      queue: { internal: 2, external: 0 },
      quiescent: true,
      synthetic: 'post-restore',
    })
    expect(inv7.checkStep?.(f, ctxFor(cfg, 8))).toBeNull()
  })

  it('buildConfigGraph walks nested `states` composites (not only regions)', () => {
    const g = buildConfigGraph({ states: { parent: { states: { child: {} } } }, events: {} })
    expect(g.isRegisteredLeaf('parent.child')).toBe(true)
    expect(g.composites.has('parent')).toBe(true)
    expect(g.depthOf('parent.child')).toBe(1)
  })
})
