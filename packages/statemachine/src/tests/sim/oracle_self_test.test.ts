/**
 * @module tests/sim/oracle_self_test — MASTER §4а: self-test of the sim oracle
 * registry. The `checkMachine` verdict (W6) rests on these builtins, so a single
 * per-invariant red test ("fires on ONE witness") is not enough trust. This file
 * adds the two registry-level guards §4а mandates:
 *
 *  §4а.1 META-TEST — every invariant is CLASSIFIED, and every invariant that
 *        CLAIMS teeth genuinely fires on a violator fixture. A new invariant that
 *        is neither classified nor able to fire turns this RED; the documented
 *        no-ops (I-4/I-5) are asserted to genuinely never fire, which is the
 *        red-test for the "removal findings" class where a direct red is
 *        impossible (an oracle that cannot fire must be HONESTLY a no-op, not a
 *        teeth-claiming stub).
 *
 *  §4а.2 ZERO-FALSE-POSITIVE CORPUS — the FULL builtin registry runs over a corpus
 *        of KNOWN-CORRECT machines and MUST emit zero violations. This is the
 *        closure criterion for A3/C1: C1 was an already-shipped false-positive, and
 *        an early W5b attempt shipped an I-5 false-positive — exactly the class a
 *        standing zero-false-positive corpus catches before it reaches a consumer.
 *
 * §4а.3 differential (I-5 done-set vs the model compiler) is DEFERRED with I-5's
 * teeth to W5c (#35): while I-5 is a documented no-op there is nothing to diff.
 */
import { describe, expect, it } from 'vitest'
import { buildConfigGraph, INVARIANTS } from '../../sim/invariants'
import type { CheckerContext, Violation } from '../../sim/invariants'
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
]

// Documented no-ops (MASTER §4а.1 / W5b A3): their class is not soundly observable
// from the content-only trace, so they are HONEST no-ops (I-12 covers the converse
// done-event gating; enter-order is engine-tested). W5c (#35) may give them teeth.
const DOCUMENTED_NO_OPS = ['I-4', 'I-5'] as const

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
      const ctx = ctxFor({ states: { root: { regions: { r1: { a: {} }, r2: { b: {} } } } }, events: { 'done.state.root': {} } }, 8)
      for (const f of battery) {
        expect(inv?.checkStep?.(f, ctx) ?? null, `${id} fired on ${f.to} — a documented no-op must never emit`).toBeNull()
      }
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
