/**
 * @module tests/sim/payload_substrate — W8: the OBJECT-PAYLOAD substrate for
 * fuzzing.
 *
 * Before W8 the fuzzer fired every event ARG-FREE (`Simulator.pickOp` emitted
 * `args: []` and the driver filtered anything non-numeric out at two sites), so a
 * machine whose guard/action reads an event ARGUMENT had those branches
 * PERMANENTLY uncovered — `checkMachine` reported the gap honestly as a
 * `no-payload` warning but could not close it.
 *
 * Each `describe` below pins one of the five obligations the design carries:
 *   1. the payload actually REACHES the machine's callbacks (the point);
 *   2. it is DETERMINISTIC per seed (a fuzz finding must replay);
 *   3. the FAULT path carries it IDENTICALLY to the no-fault path (otherwise a
 *      fault run diverges from its twin for a reason unrelated to the fault — a
 *      new class of irreproducibility);
 *   4. the generated CORPUS is byte-identical to pre-W8 (a payload draw must not
 *      consume the op-selection PRNG stream);
 *   5. `checkMachine` closes the coverage gap AND retracts the `no-payload`
 *      warning for the events that now carry a generator.
 */
import { describe, expect, it } from 'vitest'
import type { Adapter, StateMachineConfig } from '../../index'
import { MemoryAdapter } from '../../index'
import { checkMachine } from '../../sim/check-machine'
import type { CheckOptions } from '../../sim/check-machine'
import { makeSimClock } from '../../sim/clock'
import { generateScenario, runScenario } from '../../sim/define'
import { SimDriver } from '../../sim/driver'
import { makeObservableScheduler } from '../../sim/env'
import type { FaultPlan } from '../../sim/faults'
import { NoopLogger } from '../../sim/noop-logger'
import { makePrng } from '../../sim/prng'
import { runSimulation } from '../../sim/public'
import type { SimEventPayload } from '../../sim/public'
import { SimErrorHandler } from '../../sim/sim-error-handler'
import { SimMonitor } from '../../sim/sim-monitor'
import { hashTrace } from '../../sim/trace'

// ── fixtures ────────────────────────────────────────────────────────────────

/** The verdict OBJECT a stateful event carries. A number would not exercise the
 *  interesting case (an object is what `isAdapter` duck-types against). */
type Verdict = { score: number; note: string }

type Box = { state: string; seen: unknown[] }

/**
 * A machine whose ONLY route out of `gate` is guarded on an event ARGUMENT:
 * `(o, v) => v.score > 5`. With arg-free fuzzing the guard sees `undefined` and
 * the `pass` branch is UNREACHABLE — that is the coverage hole W8 closes.
 * `onTransition` records the argument it received so a test can assert identity,
 * not merely reachability.
 */
const GATE: StateMachineConfig<Box> = {
  name: 'Gate',
  stateAttribute: 'state',
  initialState: 'gate',
  states: { gate: {}, pass: {}, fail: {} },
  events: {
    verdict: {
      transitions: [
        {
          from: 'gate',
          to: 'pass',
          guard: (o: Box, v: Verdict) => typeof v === 'object' && v !== null && v.score > 5,
          onTransition: (o: Box, v: Verdict) => {
            o.seen.push(v)
          },
        },
        {
          from: 'gate',
          to: 'fail',
          guard: (o: Box, v: Verdict) => !(typeof v === 'object' && v !== null && v.score > 5),
          onTransition: (o: Box, v: Verdict) => {
            o.seen.push(v)
          },
        },
      ],
    },
    reset: { transitions: [{ from: 'pass', to: 'gate' }, { from: 'fail', to: 'gate' }] },
  } as unknown as StateMachineConfig<Box>['events'],
}

/** A 2-state lane used for the fault-path tests: one event, one transition. */
const LANE: StateMachineConfig<Box> = {
  name: 'Lane',
  stateAttribute: 'state',
  initialState: 'a',
  states: { a: {}, b: {} },
  events: {
    e1: {
      transitions: [
        {
          from: 'a',
          to: 'b',
          onTransition: (o: Box, v: unknown) => {
            o.seen.push(v)
          },
        },
      ],
    },
  } as unknown as StateMachineConfig<Box>['events'],
}

/** Mirrors the production define.ts/public.ts driver wiring. */
function buildDriver(config: StateMachineConfig<Box>, owner: Box, plan: FaultPlan): SimDriver<Box> {
  const clock = makeSimClock(0)
  const { scheduler, view } = makeObservableScheduler(clock)
  return new SimDriver<Box>({
    config,
    owner: new MemoryAdapter<Box>(owner) as unknown as Adapter<Box>,
    clock,
    scheduler: scheduler as {
      process(now?: number): void
      isActive(): boolean
      schedule(d: number, cb: () => void): object
      cancel(t: object): void
    },
    schedulerView: view,
    monitor: new SimMonitor(),
    errorHandler: new SimErrorHandler(),
    logger: NoopLogger,
    prng: makePrng(1n),
    runtime: 'node-sim-v1',
    policy: 'safety',
    ...(plan.faults.length > 0 ? { faults: plan } : {}),
  })
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. The payload REACHES the callbacks (verbatim, object-identity preserved).
// ═════════════════════════════════════════════════════════════════════════════

describe('W8 §1: an object payload reaches the machine callbacks VERBATIM', () => {
  it('SimDriver.step forwards an OBJECT arg to guard + onTransition (pre-W8 the number-filter dropped it)', async () => {
    const owner: Box = { state: 'gate', seen: [] }
    const d = buildDriver(GATE, owner, { faults: [] })
    await d.init()
    const verdict: Verdict = { score: 9, note: 'approve' }
    await d.step({ kind: 'fire', event: 'verdict', args: [verdict], opId: 'op-1' })

    // The guard SAW the object (score>5 ⇒ 'pass'); a dropped arg would have made
    // the guard read `undefined` and route to 'fail'.
    expect(d.machine.getCurrentState()).toBe('pass')
    // …and onTransition received the SAME reference (verbatim, not a copy/coercion).
    expect(owner.seen).toHaveLength(1)
    expect(owner.seen[0]).toBe(verdict)
  })

  it('the arg-free control routes to the OTHER branch — proving the assertion above has teeth', async () => {
    const owner: Box = { state: 'gate', seen: [] }
    const d = buildDriver(GATE, owner, { faults: [] })
    await d.init()
    await d.step({ kind: 'fire', event: 'verdict', args: [], opId: 'op-1' })
    expect(d.machine.getCurrentState()).toBe('fail')
    expect(owner.seen[0]).toBeUndefined()
  })

  it('a MIXED payload (object + string + number) survives intact — no type is filtered out', async () => {
    const owner: Box = { state: 'a', seen: [] }
    const d = buildDriver(LANE, owner, { faults: [] })
    await d.init()
    const obj = { k: 1 }
    await d.step({ kind: 'fire', event: 'e1', args: [obj, 'tag', 7], opId: 'op-1' })
    // onTransition only records its 2nd positional, but reaching 'b' at all plus
    // the object identity proves nothing was dropped ahead of it.
    expect(d.machine.getCurrentState()).toBe('b')
    expect(owner.seen[0]).toBe(obj)
  })

  it('the explicit-Adapter contract holds: an ADAPTER-SHAPED payload ({get,set}) is NOT mistaken for the adapter', async () => {
    // The `isAdapter` duck-check is `'set' in inp && 'get' in inp` (types.ts `isAdapter`, ~:725-726).
    // The driver passes the wrapped Adapter EXPLICITLY at position 2, so a payload
    // that happens to look like an Adapter lands at position 3 and is delivered as
    // a plain argument — it must NOT be unshifted (state_machine.ts:469-471) nor
    // hijack the owner.
    const owner: Box = { state: 'a', seen: [] }
    const d = buildDriver(LANE, owner, { faults: [] })
    await d.init()
    const adapterShaped = { get: () => 'nope', set: () => undefined }
    await d.step({ kind: 'fire', event: 'e1', args: [adapterShaped], opId: 'op-1' })
    expect(d.machine.getCurrentState()).toBe('b')
    // Delivered as a normal argument…
    expect(owner.seen[0]).toBe(adapterShaped)
    // …and the REAL owner was still the one mutated (the decoy did not take over).
    expect(owner.state).toBe('b')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. Determinism per seed.
// ═════════════════════════════════════════════════════════════════════════════

/** A payload generator that DRAWS (so a shifted stream would be visible). */
function makeVerdictPayload(sink: Verdict[]): SimEventPayload {
  return (event, rng) => {
    if (event !== 'verdict') {
      return []
    }
    const v: Verdict = { score: rng.int(11), note: rng.pick(['a', 'b', 'c']) }
    sink.push(v)
    return [v]
  }
}

describe('W8 §2: payload generation is DETERMINISTIC per seed', () => {
  it('the same seed replays the identical payload sequence AND the identical traceHash', async () => {
    const run = async (seed: string) => {
      const sink: Verdict[] = []
      const r = await runSimulation<Box>(
        () => ({ config: GATE, owner: { state: 'gate', seen: [] } }),
        { seed, steps: 24, eventPayload: makeVerdictPayload(sink) },
      )
      // `SimResult` exposes no header, so `hashTrace({ header: r.header, … })`
      // hashed with `header: undefined` — self-consistent between two such runs,
      // but blind to the very header field a version bump moves. `traceHash` IS
      // the canonical hash the run already computed, header included.
      return { sink, hash: r.traceHash }
    }
    const a = await run('7')
    const b = await run('7')
    expect(a.sink.length).toBeGreaterThan(0)
    expect(b.sink).toEqual(a.sink)
    expect(b.hash).toBe(a.hash)
  })

  it('a DIFFERENT seed produces a different payload sequence (the generator is really seed-driven)', async () => {
    const run = async (seed: string) => {
      const sink: Verdict[] = []
      await runSimulation<Box>(
        () => ({ config: GATE, owner: { state: 'gate', seen: [] } }),
        { seed, steps: 24, eventPayload: makeVerdictPayload(sink) },
      )
      return sink
    }
    expect(await run('7')).not.toEqual(await run('99'))
  })

  it('the traceHash is SEED-SENSITIVE (so the equality assertion above is not vacuous)', async () => {
    // Without this, `expect(b.hash).toBe(a.hash)` in the determinism test would
    // still pass if `traceHash` were constant for every run — the assertion would
    // prove nothing. This pins that the hash actually moves when the run does.
    const run = async (seed: string) =>
      (
        await runSimulation<Box>(
          () => ({ config: GATE, owner: { state: 'gate', seen: [] } }),
          { seed, steps: 24, eventPayload: makeVerdictPayload([]) },
        )
      ).traceHash
    expect(await run('7')).not.toBe(await run('99'))
  })

  it('the payload generator SEES the pre-fire snapshot (state/config/data), not a blank one', async () => {
    const observed: Array<{ event: string; state: string; config: string; seenLen: number }> = []
    await runSimulation<Box>(
      () => ({ config: GATE, owner: { state: 'gate', seen: [] } }),
      {
        seed: '5',
        steps: 12,
        eventPayload: (event, _rng, snapshot) => {
          observed.push({
            event,
            state: snapshot.state,
            config: snapshot.config,
            seenLen: ((snapshot.data as Box).seen ?? []).length,
          })
          return event === 'verdict' ? [{ score: 9, note: 'x' } satisfies Verdict] : []
        },
      },
    )
    expect(observed.length).toBeGreaterThan(0)
    // Every snapshot names a REAL declared state, never an empty string.
    for (const o of observed) {
      expect(['gate', 'pass', 'fail']).toContain(o.state)
      expect(o.config).toBe(o.state)
    }
    // The generator saw the machine actually MOVE (more than one distinct state).
    expect(new Set(observed.map((o) => o.state)).size).toBeGreaterThan(1)
    // …and it saw the LIVE owner data growing (the thunk is not a stale copy).
    expect(Math.max(...observed.map((o) => o.seenLen))).toBeGreaterThan(0)
  })

  it('a THROWING payload generator is NOT swallowed (a broken generator must not degrade to silent arg-free fuzzing)', async () => {
    await expect(
      runSimulation<Box>(
        () => ({ config: GATE, owner: { state: 'gate', seen: [] } }),
        {
          seed: '3',
          steps: 8,
          eventPayload: () => {
            throw new Error('generator-boom')
          },
        },
      ),
    ).rejects.toThrow('generator-boom')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. The FAULT path carries the payload IDENTICALLY to the no-fault path.
// ═════════════════════════════════════════════════════════════════════════════

describe('W8 §3: the fault path is payload-IDENTICAL to the no-fault path', () => {
  /** Drive ONE fire of `e1` carrying `verdict` under `plan`; return what arrived. */
  async function fireUnder(plan: FaultPlan, payload: unknown): Promise<{ seen: unknown[]; state: string }> {
    const owner: Box = { state: 'a', seen: [] }
    const d = buildDriver(LANE, owner, plan)
    await d.init()
    await d.step({ kind: 'fire', event: 'e1', args: [payload], opId: 'op-1' })
    return { seen: owner.seen, state: d.machine.getCurrentState() }
  }

  it('DUP: the duplicated fire carries the SAME payload as the original (fireWithFaults → applyQueueFaults → fireOne)', async () => {
    const verdict = { score: 3, note: 'dup' }
    const clean = await fireUnder({ faults: [] }, verdict)
    const dup = await fireUnder(
      { faults: [{ kind: 'dup', site: { seam: 'event-queue', opId: 'op-1' }, opId: 'op-1' }] },
      verdict,
    )
    // The original fire landed identically under both plans…
    expect(clean.seen).toEqual([verdict])
    expect(dup.seen[0]).toBe(verdict)
    expect(dup.state).toBe(clean.state)
    // …and the duplicate did NOT arrive arg-stripped: `e1` has no transition out
    // of 'b', so the dup rejects before onTransition — what matters is that the
    // ONE delivered payload is byte-identical to the no-fault twin.
    expect(dup.seen).toEqual(clean.seen)
  })

  it('REORDER: a reordered submission still carries its payload', async () => {
    const verdict = { score: 4, note: 'reorder' }
    const clean = await fireUnder({ faults: [] }, verdict)
    const reordered = await fireUnder(
      { faults: [{ kind: 'reorder', site: { seam: 'event-queue', opId: 'op-1' }, opId: 'op-1' }] },
      verdict,
    )
    expect(reordered.seen).toEqual(clean.seen)
    expect(reordered.seen[0]).toBe(verdict)
  })

  it('OVERFLOW: every flood copy carries the payload (buildOverflowFlood does not strip args)', async () => {
    const owner: Box = { state: 'a', seen: [] }
    const verdict = { score: 8, note: 'flood' }
    const d = buildDriver(LANE, owner, {
      faults: [{ kind: 'overflow', site: { seam: 'event-queue', opId: 'op-1' }, opId: 'op-1', floodCount: 4 }],
    })
    await d.init()
    await d.step({ kind: 'fire', event: 'e1', args: [verdict], opId: 'op-1' })
    // Only the first flood copy can transition a→b; it must have carried the payload.
    expect(owner.seen.length).toBeGreaterThan(0)
    for (const s of owner.seen) {
      expect(s).toBe(verdict)
    }
  })

  it('MULTI-OP fireMany: every buffered entry keeps its OWN payload through the queue-fault plane', async () => {
    const owner: Box = { state: 'a', seen: [] }
    const d = buildDriver(LANE, owner, { faults: [] })
    await d.init()
    const p1 = { score: 1, note: 'one' }
    const p2 = { score: 2, note: 'two' }
    await d.fireMany([
      { event: 'e1', args: [p1], opId: 'm-1' },
      { event: 'e1', args: [p2], opId: 'm-2' },
    ])
    // Only the a→b fire transitions; the second finds no transition from 'b'. The
    // payload that DID arrive must be the first entry's, not a cross-wired one.
    expect(owner.seen[0]).toBe(p1)
  })

  it('a full RUN under a fault plan sees payloads at every fire, exactly as the no-fault twin does', async () => {
    const under = async (faults: FaultPlan) => {
      const sink: Verdict[] = []
      const owner: Box = { state: 'gate', seen: [] }
      await runSimulation<Box>(() => ({ config: GATE, owner }), {
        seed: '11',
        steps: 20,
        faults,
        eventPayload: makeVerdictPayload(sink),
      })
      return { generated: sink, delivered: owner.seen }
    }
    const clean = await under({ faults: [] })
    const faulty = await under({
      faults: [{ kind: 'dup', site: { seam: 'event-queue', opId: 'sim-op-2' }, opId: 'sim-op-2' }],
    })
    // The GENERATED payload stream is identical: the fault plane does not perturb
    // the payload PRNG (it is a forked stream, independent of fault resolution).
    expect(faulty.generated).toEqual(clean.generated)
    // Every DELIVERED payload under faults is a real generated verdict object —
    // never `undefined`, which is what an args-stripping fault path would deliver.
    expect(faulty.delivered.length).toBeGreaterThan(0)
    for (const d of faulty.delivered) {
      expect(d).toBeTypeOf('object')
      expect(d).not.toBeNull()
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. PRNG-neutrality: the generated corpus is byte-identical to pre-W8.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The traceHashes of `runScenario(generateScenario(seed))`. They are hard-coded
 * (never recomputed) precisely so that a change which consumes a PRNG draw in the
 * payload-free path FAILS here instead of silently invalidating every stored repro
 * artifact in the corpus.
 *
 * The mechanism that keeps them stable: `Simulator.pickOp` returns BEFORE any
 * payload interaction when `opts.eventPayload` is absent, and the payload stream
 * is a `Prng.fork` child (fork reads `state()` without advancing the parent), so
 * even a payload-heavy run cannot shift op selection.
 *
 * ## RE-BASELINED at W8/V5b (`header.version` '3' -> '4')
 * The original values were captured on the pre-W8 tree. They moved ONCE, for the
 * two DECLARED corpus-breaking changes that ship together with the version bump:
 *   1. `header.version` itself is a hashed header field ('3' -> '4');
 *   2. the driver now stamps the sampled `doneDelta` projection onto every settle-
 *      boundary frame of a composite-bearing config, and `doneDelta` has always
 *      been a hashed `TraceFrame` field — it was simply never populated on this
 *      path before.
 *
 * That attribution was VERIFIED, not assumed: pinning `version` back to '3' AND
 * suppressing the `doneDelta` stamp reproduces the pre-W8 hashes in this table
 * EXACTLY. In particular it proves that subscribing the harness monitor to the
 * `IMonitor.recordLifecycle` channel (W8/V3a — which lengthens the engine's
 * internal promise chain around every instrumented callback) does NOT perturb the
 * op stream, the frame sequence, or the settle outcome by a single bit.
 *
 * REBASED AGAIN in W9/Г2 ('4' -> '5'), for ONE declared reason: the `SettleReason`
 * closed union gained `'budget-progressing'`, and `settleReason` is a hashed
 * `TraceFrame` field. Attribution VERIFIED the same way: with `version` pinned back
 * to '4' the previous table passes UNCHANGED (32/32), which proves the progress
 * discriminator added to the settle pump does not alter behaviour on any corpus
 * run — only the schema version moved.
 *
 * ## REBASED AGAIN ('5' -> '6') — settleReason on the init and pre-fire drains
 * The driver now records the settle REASON on two paths that always dropped it:
 * the mandatory post-construction drain (frame 0 and every during-drain init
 * frame) and the step's PRE-fire drain (whose result was discarded outright).
 * `settleReason` is a hashed `TraceFrame` field, so populating it on a new path is
 * corpus-breaking by the same rule as before.
 *
 * Attribution VERIFIED by the SAME experiment: with `version` pinned back to '5'
 * and NOTHING else reverted, this file passes 32/32 with the '5' table above
 * restored EXACTLY. That is a stronger result than the previous two rebases —
 * it proves the new stamps changed no corpus hash AT ALL, because no corpus run
 * is ever non-quiescent on its init or pre-fire drain. The only moving part was
 * the version string itself.
 *
 * The same observation is load-bearing elsewhere: the corpus provably never
 * enters the budget-exhaustion path, so it is NOT evidence that the exhaustion
 * classification is false-positive-free (see docs/dynamic-check.md).
 */
const CORPUS_HASHES: ReadonlyArray<readonly [bigint, string]> = [
  [0n, '70ff65b42191b8e1'],
  [1n, 'fcab6c8579db4979'],
  [3n, '00571deb78c07da5'],
  [4n, '97d84c02f42430ea'],
  [5n, '810bc2777642d6ce'],
  [6n, '900feaca33a2ecb7'],
  [7n, '68a9fcb3e81d46d7'],
  [8n, 'c530684eb816d0e9'],
  [42n, 'bcec1cfc061d41b1'],
  [12345n, '901bb08cdb0547ba'],
]

describe('W8 §4: the generated corpus replays to its PINNED traceHash', () => {
  it.each(CORPUS_HASHES.map(([seed, hash]) => ({ seed: seed.toString(), hash })))(
    'seed $seed replays to the pinned traceHash $hash',
    async ({ seed, hash }) => {
      const spec = await generateScenario(BigInt(seed))
      expect(hashTrace(await runScenario(spec))).toBe(hash)
    },
  )

  it('a payload-heavy run has the SAME traceHash as the payload-free run when the machine IGNORES args', async () => {
    // The direct proof of PRNG-neutrality. `LANE`'s only transition is
    // unguarded, so the payload cannot change WHAT happens — only whether payload
    // draws were taken. If those draws came out of the op-selection stream, the
    // op sequence (and therefore the hash) would diverge.
    const run = async (eventPayload?: SimEventPayload) => {
      const r = await runSimulation<Box>(
        () => ({ config: LANE, owner: { state: 'a', seen: [] } }),
        { seed: '21', steps: 16, ...(eventPayload !== undefined ? { eventPayload } : {}) },
      )
      // The canonical hash (header included) rather than a re-hash that dropped it.
      return r.traceHash
    }
    const withoutPayload = await run()
    let draws = 0
    const withPayload = await run((_e, rng) => {
      // Draw HARD — several draws per fire. A shared stream would desynchronize
      // op selection within the first step.
      draws += 3
      return [{ a: rng.int(1000), b: rng.float(), c: rng.pick([1, 2, 3]) }]
    })
    expect(draws).toBeGreaterThan(0) // the generator really ran
    expect(withPayload).toBe(withoutPayload)
  })

  it('args do NOT enter the content hash: two runs differing ONLY in payload hash identically', async () => {
    // Confirms the TraceFrame schema carries no `args` field (trace.ts) — the
    // canonical trace is content-only, so a payload cannot smuggle bytes into the
    // hash plane. This is what lets §4 above hold at all.
    const run = async (payload: unknown) => {
      const owner: Box = { state: 'a', seen: [] }
      const d = buildDriver(LANE, owner, { faults: [] })
      await d.init()
      await d.step({ kind: 'fire', event: 'e1', args: [payload], opId: 'op-1' })
      return hashTrace(d.trace())
    }
    expect(await run({ score: 1 })).toBe(await run({ totally: 'different', nested: { deep: [1, 2, 3] } }))
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. checkMachine: coverage closed + the `no-payload` warning retracted.
// ═════════════════════════════════════════════════════════════════════════════

const checkFast: Omit<CheckOptions<Box>, 'events'> = { seed: '1', steps: 24, runs: 4, mode: 'safety' }

describe('W8 §5: checkMachine drives the consumer payload end-to-end', () => {
  it('WITHOUT a payload generator the arg-guarded branch is UNREACHABLE (the pre-W8 hole, pinned)', async () => {
    const r = await checkMachine<Box>(GATE, () => ({ state: 'gate', seen: [] }), checkFast)
    // Every fire sees `undefined` ⇒ only the `fail` branch can ever be taken.
    expect(r.reachableStates).toContain('fail')
    expect(r.reachableStates).not.toContain('pass')
  })

  it('WITH a payload generator the arg-guarded branch IS covered (the hole is closed)', async () => {
    const r = await checkMachine<Box>(GATE, () => ({ state: 'gate', seen: [] }), {
      ...checkFast,
      events: [
        {
          name: 'verdict',
          payload: (rng) => [{ score: rng.int(11), note: 'v' } satisfies Verdict],
        },
      ],
    })
    expect(r.reachableStates).toContain('pass')
    expect(r.reachableStates).toContain('fail')
  })

  it('the payload SEES the snapshot: a state-aware generator can steer the machine (blind fuzzing cannot)', async () => {
    // Only ever approve while at `gate` — proving `snapshot.state` is live and the
    // generator is consulted per fire, not once up front.
    const r = await checkMachine<Box>(GATE, () => ({ state: 'gate', seen: [] }), {
      ...checkFast,
      events: [
        { name: 'verdict', payload: (_rng, snapshot) => [{ score: snapshot.state === 'gate' ? 9 : 0, note: 'steer' } satisfies Verdict] },
      ],
    })
    expect(r.reachableStates).toContain('pass')
    // Deterministically steered: `fail` requires score<=5 at `gate`, which this
    // generator never produces.
    expect(r.reachableStates).not.toContain('fail')
  })

  it('an event WITH a payload generator is REMOVED from the `no-payload` warning', async () => {
    const withGen = await checkMachine<Box>(GATE, () => ({ state: 'gate', seen: [] }), {
      ...checkFast,
      events: [{ name: 'verdict', payload: (rng) => [{ score: rng.int(11), note: 'v' } satisfies Verdict] }],
    })
    const w = withGen.warnings.find((x) => x.kind === 'no-payload')
    // `verdict` now has a generator; `reset` still does not, so the warning
    // survives but must no longer NAME `verdict`.
    expect(w?.detail ?? '').not.toContain('verdict')
    expect(w?.detail ?? '').toContain('reset')
  })

  it('covering EVERY event with a generator retracts the `no-payload` warning entirely', async () => {
    const r = await checkMachine<Box>(GATE, () => ({ state: 'gate', seen: [] }), {
      ...checkFast,
      events: [
        { name: 'verdict', payload: (rng) => [{ score: rng.int(11), note: 'v' } satisfies Verdict] },
        { name: 'reset', payload: () => [] },
      ],
    })
    expect(r.warnings.some((x) => x.kind === 'no-payload')).toBe(false)
  })

  it('checkMachine payload runs are seed-reproducible (a fuzz finding replays)', async () => {
    const once = async () =>
      checkMachine<Box>(GATE, () => ({ state: 'gate', seen: [] }), {
        ...checkFast,
        events: [{ name: 'verdict', payload: (rng) => [{ score: rng.int(11), note: 'v' } satisfies Verdict] }],
      })
    const a = await once()
    const b = await once()
    expect(b.reachableStates).toEqual(a.reachableStates)
    expect(b.uncoveredTransitions).toEqual(a.uncoveredTransitions)
    expect(b.transitionsFired).toBe(a.transitionsFired)
  })

  it('declaring NO payloads leaves checkMachine byte-identical to the pre-W8 behavior', async () => {
    // The hook is only installed when at least one spec declares a payload, so a
    // consumer who lists events purely for weighting keeps the old trace exactly.
    const bare = await checkMachine<Box>(GATE, () => ({ state: 'gate', seen: [] }), checkFast)
    const listedNoPayload = await checkMachine<Box>(GATE, () => ({ state: 'gate', seen: [] }), {
      ...checkFast,
      events: [{ name: 'verdict' }, { name: 'reset' }],
    })
    expect(listedNoPayload.reachableStates).toEqual(bare.reachableStates)
    expect(listedNoPayload.uncoveredTransitions).toEqual(bare.uncoveredTransitions)
    expect(listedNoPayload.transitionsFired).toBe(bare.transitionsFired)
  })
})
