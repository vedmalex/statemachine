/**
 * @module tests/sim/oracle_self_test — MASTER §4а: self-test of the sim oracle
 * registry. The `checkMachine` verdict (W6) rests on these builtins, so a single
 * per-invariant red test ("fires on ONE witness") is not enough trust. This file
 * adds the two registry-level guards §4а mandates:
 *
 *  §4а.1 META-TEST — every invariant is CLASSIFIED, and every invariant that
 *        CLAIMS teeth genuinely fires on a violator fixture. A new invariant that
 *        is neither classified nor able to fire turns this RED; the documented
 *        no-op (I-5) is asserted to genuinely never fire, which is the red-test for
 *        the "removal findings" class where a direct red is impossible (an oracle
 *        that cannot fire must be HONESTLY a no-op, not a teeth-claiming stub).
 *
 *        The meta-test is DELIBERATELY TWO-SIDED and must stay so: teeth must FIRE
 *        on their violator, no-ops must STAY SILENT on a battery that would tempt a
 *        naive checker. A one-sided version would let a no-op quietly grow teeth, or
 *        a teeth oracle quietly rot into a stub, without turning red.
 *
 *  §4а.2 ZERO-FALSE-POSITIVE CORPUS — the FULL builtin registry runs over a corpus
 *        of KNOWN-CORRECT machines and MUST emit zero violations. This is the
 *        closure criterion for A3/C1: C1 was an already-shipped false-positive, and
 *        an early W5b attempt shipped an I-5 false-positive — exactly the class a
 *        standing zero-false-positive corpus catches before it reaches a consumer.
 *
 * ── W8 status ───────────────────────────────────────────────────────────────
 *  - I-4 MOVED from `DOCUMENTED_NO_OPS` to teeth (V3a). W8/V11 aligned the engine's
 *    callback order to W3C and W8/V1 made that order OBSERVABLE via the public
 *    `IMonitor.recordLifecycle` channel, so the hierarchy-order class is now
 *    checkable. Its violator fixture is a SYNTHETIC lifecycle feed — a hand-built
 *    inverted sequence — deliberately NOT a wait-for-an-engine-bug fixture.
 *  - I-3 was PROMOTED into the DEFAULT builtin set (V8, ISS-030 closed), so §4а.2
 *    now carries string-method-invoke and composite-join machines that specifically
 *    exercise the false-positive I-3 used to produce.
 *
 * ── W9/Г1 status ────────────────────────────────────────────────────────────
 *  - I-5 MOVED from `DOCUMENTED_NO_OPS` to teeth. The last blocker was that a
 *    `done.state.<C>` raise which matched NO candidate transition recorded nothing
 *    anywhere and was indistinguishable from "never raised"; the engine now emits a
 *    `kind:'raise'` lifecycle record at every internal raise site, so the oracle
 *    COUNTS raises against the `doneDelta` `false → true` edges. Its violator
 *    fixture is a synthetic frame sequence plus an EMPTY raise stream — the
 *    "the composite became done and nobody raised the event" witness. That the
 *    ENGINE really emits those records (so the teeth are not synthetic-only) is
 *    pinned separately by the planted-defect e2e in observation_plane.test.ts.
 *  - `DOCUMENTED_NO_OPS` is now EMPTY. The meta-test stays TWO-SIDED by
 *    construction: the classification/partition assertions still run over the whole
 *    registry, and the no-op honesty loop is RETAINED (with an explicit assertion
 *    that the empty set is deliberate) so the next documented no-op is checked the
 *    same way rather than silently skipped.
 *  - §4а.2 gains a composite-join machine whose declared join is GUARD-BLOCKED —
 *    the shape in which the done configuration survives to the settle boundary, so
 *    I-5 is genuinely ARMED (not vacuous) inside the corpus.
 */
import { describe, expect, it } from 'vitest'
import { buildConfigGraph, INVARIANTS } from '../../sim/invariants'
import type { CheckerContext, LifecycleObservation, Violation } from '../../sim/invariants'
import { runSafety, runSafetyWithDeterminism } from '../../sim/invariants.runner'
import { runSimulation } from '../../sim/public'
import type { CanonicalHeader, CanonicalTrace, TraceFrame } from '../../sim/trace'

const HEADER: CanonicalHeader = {
  seed: '0',
  configHash: 'deadbeefdeadbeef',
  engine: '@vedmalex/statemachine',
  version: '2',
  runtime: 'node-test',
  prngVersion: 'splitmix64-bigint-v1',
  errorHandlerEnabled: true,
}

function frame(over: Partial<TraceFrame> & { step: number }): TraceFrame {
  return { t: 0, cause: 'external', from: 'a', to: 'a', queue: { internal: 0, external: 0 }, quiescent: true, ...over }
}
function ctxFor(config: unknown, maxQueueDepth?: number): CheckerContext {
  return { graph: buildConfigGraph(config), header: HEADER, ...(maxQueueDepth !== undefined ? { maxQueueDepth } : {}) }
}
/** Owner sentinel for the synthetic lifecycle feed (`owner` is reference identity). */
const FEED_OWNER: object = { owner: 'oracle-self-test' }
/**
 * A SYNTHETIC lifecycle feed: an `enter` sequence inside ONE microstep that enters
 * a DESCENDANT (`root.rA.leaf`) before its ANCESTOR (`root`) — the exact W3C
 * document-order violation I-4 exists to catch. Constructed by hand rather than
 * waiting for the engine to regress, which is the only way a red test for an
 * ordering oracle can exist at all.
 */
const I4_INVERTED_FEED: readonly LifecycleObservation[] = [
  { kind: 'enter', hook: 'onEnter', state: 'root.rA.leaf', owner: FEED_OWNER, microstep: 7, seq: 0, edge: 'begin' },
  { kind: 'enter', hook: 'onEnter', state: 'root', owner: FEED_OWNER, microstep: 7, seq: 1, edge: 'begin' },
]
function trace(...frames: TraceFrame[]): CanonicalTrace {
  return { header: HEADER, frames }
}

// ── §4а.1 canonical oracle registry ─────────────────────────────────────────
// Each teeth invariant maps to a violator fixture that MUST make runSafety return
// THAT invariant's id (the lowest-step / first-final wins, and each fixture is
// built so its own invariant is the sole/earliest witness).
interface TeethCase {
  readonly id: string
  readonly fire: () => Violation | null
}
const baseCtx = (): CheckerContext => ctxFor({ states: { a: {}, b: {} }, events: { go: {} } }, 4)

const ORACLE_TEETH: readonly TeethCase[] = [
  {
    id: 'I-1',
    // Two runs of the same seed hashing differently → the determinism meta short-circuits.
    fire: () => runSafetyWithDeterminism(INVARIANTS, trace(frame({ step: 0, cause: 'init' })), baseCtx(), { a: 'aaaa', b: 'bbbb' }),
  },
  { id: 'I-2', fire: () => runSafety(INVARIANTS, trace(frame({ step: 1, cause: 'external', event: 'go' })), baseCtx()) },
  { id: 'I-3', fire: () => runSafety(INVARIANTS, trace(frame({ step: 1, fireOutcome: 'resolve-true', quiescent: false })), baseCtx()) },
  {
    id: 'I-4',
    // Lifecycle-keyed teeth (W8/V3a): a clean trace plus a SYNTHETIC lifecycle feed
    // whose enter sequence inverts the ancestor/descendant order inside ONE
    // microstep. I-4 is final-scoped, so the trace must be otherwise clean for the
    // sweep to reach it — frame 0 is a bare init snapshot.
    fire: () =>
      runSafety(INVARIANTS, trace(frame({ step: 0, cause: 'init', from: 'root', to: 'root' })), {
        ...ctxFor({ states: { root: { regions: { rA: { leaf: {} } } } }, events: {} }, 8),
        lifecycle: I4_INVERTED_FEED,
      }),
  },
  {
    id: 'I-5',
    // W9/Г1 counting teeth: the doneDelta projection shows the composite ENTERING
    // its all-final configuration (a `false → true` edge across two adjacent
    // boundary frames) while the raise plane is PRESENT-BUT-EMPTY — i.e. the engine
    // never raised the declared `done.state.C`. An ABSENT raise plane would make
    // I-5 vacuous instead, so `raises: []` is the load-bearing part of the fixture.
    // The frames are otherwise clean so the sweep reaches the final scope. The
    // FRAMES are supplied by the runner, not by this context.
    fire: () =>
      runSafety(
        INVARIANTS,
        trace(
          frame({ step: 0, cause: 'init', from: 'C', to: 'C', doneDelta: [{ composite: 'C', done: false }] }),
          frame({ step: 1, from: 'C', to: 'C', doneDelta: [{ composite: 'C', done: true }] }),
        ),
        {
          ...ctxFor(
            {
              states: { C: { regions: { r1: { w1: {}, d1: {} }, r2: { w2: {}, d2: {} } } } },
              events: { 'done.state.C': {} },
            },
            8,
          ),
          raises: [],
        },
      ),
  },
  {
    id: 'I-6',
    fire: () =>
      runSafety(
        INVARIANTS,
        trace(frame({ step: 1, to: 'root.regionA.leaf1|root.regionA.leaf2' })),
        ctxFor({ states: { root: { regions: { regionA: { leaf1: {}, leaf2: {} } } } }, events: {} }, 8),
      ),
  },
  {
    id: 'I-7',
    fire: () =>
      runSafety(INVARIANTS, trace(frame({ step: 1, cause: 'external', event: 'go', fireOutcome: 'resolve-true', queue: { internal: 2, external: 0 }, quiescent: true })), baseCtx()),
  },
  { id: 'I-8', fire: () => runSafety(INVARIANTS, trace(frame({ step: 1, errorClass: 'max-transition-depth', quiescent: false, queue: { internal: 3, external: 0 } })), baseCtx()) },
  { id: 'I-9', fire: () => runSafety(INVARIANTS, trace(frame({ step: 1, to: 'a', queue: { internal: 3, external: 2 } })), ctxFor({ states: { a: {} }, events: {} }, 4)) },
  {
    id: 'I-10',
    // Final-scope unregistered part.
    fire: () => runSafety(INVARIANTS, trace(frame({ step: 5, to: 'bogusLeaf' })), ctxFor({ states: { idle: {}, running: {} }, events: {} }, 8)),
  },
  { id: 'I-11', fire: () => runSafety(INVARIANTS, trace(frame({ step: 1, errorClass: 'injected-fault', quiescent: false, queue: { internal: 2, external: 0 } })), baseCtx()) },
  {
    id: 'I-12',
    fire: () =>
      runSafety(INVARIANTS, trace(frame({ step: 1, cause: 'internal', from: 'root', to: 'root', event: 'done.state.other' })), ctxFor({ states: { root: {} }, events: { 'done.state.root': {} } }, 8)),
  },
  {
    id: 'I-13',
    // A CAPTURED sample-plane observation in which the stall predicate held across
    // TWO microtask-adjacent pump checkpoints. One positive is a reading a correct
    // machine produces (see the I-13 note in invariants.ts); two consecutive ones
    // mean nothing was scheduled to drain the queue. The real teeth — the same
    // predicate driven by an ENGINE with its `scheduleProcessing()` deleted — live
    // in `rtc_stall_oracle.test.ts`; this fixture is the registry-level claim.
    fire: () =>
      runSafety(
        INVARIANTS,
        trace(frame({ step: 1, to: 'a' })),
        { ...baseCtx(), rtcStall: { samples: 64, maxRun: 44, witnessQueueTotal: 1 } },
      ),
  },
]

// Documented no-ops (MASTER §4а.1). I-4 LEFT this set in W8/V3a once the lifecycle
// channel made callback order observable; I-5 LEFT it in W9/Г1 once the engine's
// `kind:'raise'` records made the internal raise observable. The set is now EMPTY —
// every registry member claims teeth and must prove them. The honesty loop below is
// KEPT (not deleted) so the next documented no-op is held to the same two-sided bar.
const DOCUMENTED_NO_OPS: readonly string[] = []

describe('§4а.1 oracle meta-test: registry classification + teeth', () => {
  it('every INVARIANTS id is CLASSIFIED as either teeth or a documented no-op (no silent unaccounted oracle)', () => {
    const classified = new Set<string>([...ORACLE_TEETH.map((t) => t.id), ...DOCUMENTED_NO_OPS])
    const registryIds = INVARIANTS.map((i) => i.id)
    for (const id of registryIds) {
      expect(classified.has(id), `${id} is unclassified — add a teeth fixture or declare it a documented no-op`).toBe(true)
    }
    // and no phantom classification for an id that left the registry.
    for (const id of classified) {
      expect(registryIds.includes(id), `${id} is classified but no longer in INVARIANTS`).toBe(true)
    }
    // the two partitions are disjoint and exhaustive.
    expect(ORACLE_TEETH.length + DOCUMENTED_NO_OPS.length).toBe(INVARIANTS.length)
  })

  for (const t of ORACLE_TEETH) {
    it(`${t.id} HAS TEETH: its violator fixture makes runSafety emit a ${t.id} violation`, () => {
      const v = t.fire()
      expect(v, `${t.id} did not fire on its violator fixture — a teeth-claiming oracle that cannot fire is fake coverage`).not.toBeNull()
      expect(v?.invariantId).toBe(t.id)
    })
  }

  it('the DOCUMENTED_NO_OPS set is EMPTY by DECISION, not by omission (every oracle claims teeth)', () => {
    // Guards the state W9/Г1 reached: with I-5 promoted, no registry member is
    // allowed to be a silent stub. If a future oracle is added as a documented
    // no-op this assertion goes red and forces an explicit, reviewed re-classification
    // instead of a set that quietly grows again.
    expect(DOCUMENTED_NO_OPS).toEqual([])
    expect(ORACLE_TEETH.length).toBe(INVARIANTS.length)
  })

  for (const id of DOCUMENTED_NO_OPS) {
    it(`${id} is an HONEST no-op: it exposes no checkTrace and never fires on a battery of frames`, () => {
      const inv = INVARIANTS.find((i) => i.id === id)
      expect(inv).toBeDefined()
      // A documented no-op must not carry a whole-trace hook (that would be undeclared teeth).
      expect(inv?.checkTrace).toBeUndefined()
      // Its per-frame check must return null on a battery of frames that would
      // plausibly tempt a naive checker (composite, done, queue, non-quiescent).
      const battery: TraceFrame[] = [
        frame({ step: 1, to: 'root.r1.a|root.r2.b', doneDelta: [{ composite: 'root', done: true }] }),
        frame({ step: 2, to: 'root', quiescent: false, fireOutcome: 'resolve-true' }),
        frame({ step: 3, to: 'x.y.z', queue: { internal: 5, external: 5 } }),
      ]
      const ctx: CheckerContext = {
        ...ctxFor({ states: { root: { regions: { r1: { a: {} }, r2: { b: {} } } } }, events: { 'done.state.root': {} } }, 8),
        // Feed the lifecycle plane too — including a sequence that DOES violate
        // hierarchy order. A documented no-op must stay silent even when the richest
        // available observation plane is present; otherwise it is not a no-op.
        lifecycle: I4_INVERTED_FEED,
      }
      for (const f of battery) {
        expect(inv?.checkStep?.(f, ctx) ?? null, `${id} fired on ${f.to} — a documented no-op must never emit`).toBeNull()
      }
      expect(
        inv?.checkFinal?.({ config: 'root.r1.a|root.r2.b', queue: { internal: 0, external: 0 }, quiescent: true }, ctx) ?? null,
        `${id} fired at final scope — a documented no-op must never emit`,
      ).toBeNull()
    })
  }
})

// ── §4а.2 zero-false-positive corpus ────────────────────────────────────────
// KNOWN-CORRECT machines. The FULL builtin registry (mode:'both' → safety +
// liveness) MUST return ok:true with no violation and no livelock on every one.
type Box = { state: string; [k: string]: unknown }
interface CorpusEntry {
  readonly name: string
  readonly setup: () => { config: unknown; owner: Box }
}
const CORPUS: readonly CorpusEntry[] = [
  {
    name: 'flat two-state, single event',
    setup: () => ({ config: { name: 'flat', stateAttribute: 'state', initialState: 's1', states: { s1: {}, s2: {} }, events: { go: { transitions: [{ from: 's1', to: 's2' }] } } }, owner: { state: 's1' } }),
  },
  {
    name: 'terminating chain to a final leaf',
    setup: () => ({ config: { name: 'term', stateAttribute: 'state', initialState: 's1', states: { s1: {}, s2: {}, s3: { final: true } }, events: { e1: { transitions: [{ from: 's1', to: 's2' }] }, e2: { transitions: [{ from: 's2', to: 's3' }] } } }, owner: { state: 's1' } }),
  },
  {
    name: 'guard-blocked transition (legitimate quiescence, not STUCK)',
    setup: () => ({ config: { name: 'guarded', stateAttribute: 'state', initialState: 's1', states: { s1: {}, s2: {} }, events: { go: { transitions: [{ from: 's1', to: 's2', guard: () => false }] } } }, owner: { state: 's1' } }),
  },
  {
    name: 'composite with two parallel regions reaching a join',
    setup: () => ({
      config: {
        name: 'parallel',
        stateAttribute: 'state',
        initialState: 'root',
        states: { root: { regions: { r1: { a1: {}, f1: { final: true } }, r2: { a2: {}, f2: { final: true } } } } },
        events: { e1: { transitions: [{ from: 'root.r1.a1', to: 'root.r1.f1' }] }, e2: { transitions: [{ from: 'root.r2.a2', to: 'root.r2.f2' }] } },
      },
      owner: { state: 'root' },
    }),
  },
  {
    name: 'hierarchical composite with a nested initial leaf',
    setup: () => ({
      config: {
        name: 'nested',
        stateAttribute: 'state',
        initialState: 'P',
        states: {
          P: { initial: 'a.work', regions: { a: { idle: {}, work: {}, done: { final: true } } } },
          outside: { final: true },
        },
        events: {
          step: { transitions: [{ from: 'P.a.work', to: 'P.a.done' }] },
          leave: { transitions: [{ from: 'P', to: 'outside' }] },
        },
      },
      owner: { state: 'P' },
    }),
  },
  // ── W8/V8 (ISS-030) shapes ────────────────────────────────────────────────
  // These are the machines whose CORRECT behavior used to make I-3 fire. A
  // string-method invoke action is resolved by NAME inside `callAction`, past the
  // config-layer wrap boundary, so `bracketAsync` could not bracket it; the machine
  // settled as `pending ∧ inFlight===0`, which settle.ts classifies
  // WAITING_ON_INTERNAL — the I-3 witness. If the lifecycle-derived in-flight count
  // ever regresses, THESE entries go red rather than a consumer's run.
  {
    name: 'ISS-030: async STRING-METHOD invoke action (unbracketable by bracketAsync)',
    setup: () => ({
      config: {
        name: 'strInvoke',
        stateAttribute: 'state',
        initialState: 'working',
        states: {
          // Resolved by NAME at call time — the exact form no other observability
          // surface could see before the lifecycle channel.
          working: { invoke: [{ delay: 0, event: 'ping', action: 'doWork' }] },
          done: { final: true },
        },
        events: { ping: { transitions: [{ from: 'working', to: 'done' }] } },
      },
      owner: {
        state: 'working',
        // Genuinely async: the await suspends across several microtasks, which is
        // precisely the window in which the machine looked "wedged" to I-3.
        doWork: async () => {
          await Promise.resolve()
          await Promise.resolve()
        },
      },
    }),
  },
  {
    name: 'ISS-030: string-method invoke action that CHAINS into another delayed invoke',
    setup: () => ({
      config: {
        name: 'strInvokeChain',
        stateAttribute: 'state',
        initialState: 's1',
        states: {
          s1: { invoke: [{ delay: 0, event: 'go', action: 'stepA' }] },
          s2: { invoke: [{ delay: 5, event: 'go2', action: 'stepB' }] },
          s3: { final: true },
        },
        events: {
          go: { transitions: [{ from: 's1', to: 's2' }] },
          go2: { transitions: [{ from: 's2', to: 's3' }] },
        },
      },
      owner: {
        state: 's1',
        stepA: async () => {
          await Promise.resolve()
        },
        stepB: async () => {
          await Promise.resolve()
        },
      },
    }),
  },
  {
    name: 'ISS-030 + join: parallel composite whose regions run string-method invokes to a done.state join',
    setup: () => ({
      config: {
        name: 'joinStrInvoke',
        stateAttribute: 'state',
        initialState: 'C',
        states: {
          C: {
            regions: {
              r1: { w1: { invoke: [{ delay: 0, event: 'f1', action: 'work1' }] }, d1: { final: true } },
              r2: { w2: { invoke: [{ delay: 0, event: 'f2', action: 'work2' }] }, d2: { final: true } },
            },
          },
          after: { final: true },
        },
        events: {
          f1: { transitions: [{ from: 'C.r1.w1', to: 'C.r1.d1' }] },
          f2: { transitions: [{ from: 'C.r2.w2', to: 'C.r2.d2' }] },
          // The DECLARED join: the composite reaching all-final raises this
          // internally, and it must leave the composite without any oracle firing.
          'done.state.C': { transitions: [{ from: 'C', to: 'after' }] },
        },
      },
      owner: {
        state: 'C',
        work1: async () => {
          await Promise.resolve()
        },
        work2: async () => {
          await Promise.resolve()
        },
      },
    }),
  },
  // ── W9/Г1 shape ───────────────────────────────────────────────────────────
  // A GUARD-BLOCKED join: the composite reaches all-final, the engine raises the
  // declared `done.state.C`, the guard refuses the transition and the composite
  // therefore STAYS all-final at the settle boundary. That is the only shape in
  // which the doneDelta `false → true` EDGE survives to the boundary sample, so it
  // is the shape in which I-5 is genuinely ARMED rather than vacuous. A regression
  // that stops emitting `kind:'raise'` — or an I-5 rewrite that drifts back toward
  // replicating selection — turns THIS entry red instead of a consumer's run.
  {
    name: 'W9: composite join whose declared done.state.C is GUARD-BLOCKED (I-5 armed, must stay clean)',
    setup: () => ({
      config: {
        name: 'guardedJoin',
        stateAttribute: 'state',
        initialState: 'C',
        states: {
          C: { regions: { r1: { w1: {}, d1: { final: true } }, r2: { w2: {}, d2: { final: true } } } },
          after: { final: true },
        },
        events: {
          f1: { transitions: [{ from: 'C.r1.w1', to: 'C.r1.d1' }] },
          f2: { transitions: [{ from: 'C.r2.w2', to: 'C.r2.d2' }] },
          'done.state.C': { transitions: [{ from: 'C', to: 'after', guard: () => false }] },
        },
      },
      owner: { state: 'C' },
    }),
  },
  {
    name: 'composite join with nested enter/exit hooks (I-4 hierarchy order on a REAL engine run)',
    setup: () => ({
      config: {
        name: 'joinHooks',
        stateAttribute: 'state',
        initialState: 'C',
        states: {
          C: {
            // Hooks at BOTH levels so the lifecycle stream carries real
            // ancestor/descendant enter and exit pairs for I-4 to check.
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
      owner: { state: 'C', log: '' },
    }),
  },
]

describe('§4а.2 zero-false-positive corpus: the full builtin registry emits zero violations on correct machines', () => {
  for (const seed of ['1', '2', '42']) {
    for (const entry of CORPUS) {
      it(`[seed ${seed}] '${entry.name}' → ok:true, no violation, no livelock`, async () => {
        const result = await runSimulation<Box>(entry.setup as never, { seed, steps: 12, mode: 'both' })
        expect(result.ok, `false-positive on a correct machine: ${(result as { violation?: { invariantId?: string; kind?: string } }).violation?.invariantId ?? (result as { violation?: { kind?: string } }).violation?.kind ?? (result as { livelocks?: { reason?: string }[] }).livelocks?.[0]?.reason ?? 'unknown'}`).toBe(true)
        expect((result as { violation?: unknown }).violation).toBeUndefined()
        expect((result as { livelocks?: unknown }).livelocks).toBeUndefined()
        // oraclesRun must be >= 1 (A2 fail-open guard) so ok:true is never a rubber stamp.
        expect(result.oraclesRun).toBeGreaterThan(0)
      })
    }
  }
})
