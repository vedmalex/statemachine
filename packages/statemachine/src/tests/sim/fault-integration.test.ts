/**
 * @module tests/sim/fault-integration
 *
 * Step-5 INTEGRATION (ISS-064 fix): prove each {@link FaultKind} is ACTUALLY
 * APPLIED DURING A REAL SIMULATION RUN — not just exercised at the unit-level
 * harness fns (faults.test.ts already covers those in isolation). For every kind
 * we assert THREE things on a real engine-driven run:
 *   (1) an OBSERVABLE EFFECT (state/outcome/hash differs from the clean run, or a
 *       FROZEN errorClass surfaces),
 *   (2) a {@link FaultRecord} (and/or a `TraceFrame.faultApplied` tag) appears in
 *       the trace, and
 *   (3) the run is REPLAY-IDENTICAL: the same `(seed, plan)` regenerates a
 *       bit-identical traceHash AND an identical FaultRecord[].
 *
 * The driver routes external fires through the fault-aware {@link fireBuffered}
 * (reorder/drop/dup + overflow flood), wraps function-valued callbacks with throw
 * faults (sharing the inFlightAsyncCount bracket), applies clock-skew monotonically
 * and timer-jitter through the scheduler, and records every applied fault. Faults
 * are seed-derived via the label-fork PRNG (fork('faults')), so replay stays
 * bit-identical (ADR-1/2/5; AC-2).
 *
 * Coverage by kind:
 *   reorder / drop / dup / overflow — small purpose-built machines (deterministic
 *     observable effect), driven through the SimDriver / fireMany surface.
 *   clock-skew                       — a generated scenario with a skew on an
 *     advance op (the skew shifts logical time forward, perturbing timer firing).
 *   timer-jitter                     — a generated scenario whose parallel-region
 *     invoke timers are perturbed by a site-keyed jitter fork.
 *   throw                            — a generated scenario whose region invoke
 *     action throws an InjectedFault at the harness boundary.
 */

import { describe, expect, it } from 'vitest'

import { MemoryAdapter } from '../../index'
import type { Adapter, StateMachineConfig } from '../../index'
import { makeSimClock } from '../../sim/clock'
import { SimDriver } from '../../sim/driver'
import { makeObservableScheduler } from '../../sim/env'
import type { FaultPlan } from '../../sim/faults'
import { NoopLogger } from '../../sim/noop-logger'
import { makeObservableSchedulerWithJitter, buildPlanJitter } from '../../sim/observable-scheduler'
import { makePrng } from '../../sim/prng'
import { SimErrorHandler } from '../../sim/sim-error-handler'
import { SimMonitor } from '../../sim/sim-monitor'
import { hashTrace } from '../../sim/trace'
import { generateScenario, runScenario } from '../../sim/define'
import type { FaultKind } from '../../sim/trace'

interface Box {
  state: string
  count: number
}

/**
 * Build a fresh SimDriver over a small purpose-built machine with `plan` wired.
 * When the plan carries timer-jitter the scheduler is jitter-aware; otherwise the
 * plain shim. Mirrors the production define.ts/public.ts wiring.
 */
function buildDriver(config: StateMachineConfig<Box>, owner: Box, plan: FaultPlan, maxQueueDepth?: number): SimDriver<Box> {
  const clock = makeSimClock(0)
  const hasJitter = plan.faults.some((f) => f.kind === 'timer-jitter')
  const { scheduler, view } = hasJitter
    ? makeObservableSchedulerWithJitter(clock, buildPlanJitter(plan, makePrng(1n).fork('faults')).jitterFn)
    : makeObservableScheduler(clock)
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
    ...(maxQueueDepth !== undefined ? { maxQueueDepth } : {}),
    faults: plan,
  })
}

// ── reorder / drop / dup: a 3-state lane a -e1-> b -e2-> c ───────────────────

const LANE: StateMachineConfig<Box> = {
  name: 'Lane',
  stateAttribute: 'state',
  initialState: 'a',
  states: { a: {}, b: {}, c: {} },
  events: {
    e1: { transitions: [{ from: 'a', to: 'b' }] },
    e2: { transitions: [{ from: 'b', to: 'c' }] },
  },
} as StateMachineConfig<Box>

describe('fault-integration: every FaultKind is APPLIED during a real run', () => {
  it('DROP removes a fire (observable: the target transition never happens) + FaultRecord + replay-identical', async () => {
    const plan: FaultPlan = { faults: [{ kind: 'drop', site: { seam: 'event-queue', opId: 'op-1' }, opId: 'op-1' }] }
    const d = buildDriver(LANE, { state: 'a', count: 0 }, plan)
    await d.init()
    await d.step({ kind: 'fire', event: 'e1', opId: 'op-1' }) // DROPPED → stays at 'a'
    expect(d.machine.getCurrentState()).toBe('a') // observable effect: no transition

    // clean control: without the drop, e1 reaches 'b'.
    const clean = buildDriver(LANE, { state: 'a', count: 0 }, { faults: [] })
    await clean.init()
    await clean.step({ kind: 'fire', event: 'e1', opId: 'op-1' })
    expect(clean.machine.getCurrentState()).toBe('b')

    // FaultRecord present + frame tagged.
    const records = d.faultRecordsList()
    expect(records.map((r) => r.kind)).toContain('drop')
    expect(d.trace().frames.some((f) => f.faultApplied === ('drop' satisfies FaultKind))).toBe(true)

    // replay-identical: same plan, fresh driver → identical hash + records.
    const d2 = buildDriver(LANE, { state: 'a', count: 0 }, plan)
    await d2.init()
    await d2.step({ kind: 'fire', event: 'e1', opId: 'op-1' })
    expect(hashTrace(d2.trace())).toBe(hashTrace(d.trace()))
    expect(JSON.stringify(d2.faultRecordsList())).toBe(JSON.stringify(records))
  })

  it('DUP fires an op twice (observable: a second fire is a no-op resolve-false) + FaultRecord + replay-identical', async () => {
    const plan: FaultPlan = { faults: [{ kind: 'dup', site: { seam: 'event-queue', opId: 'op-1' }, opId: 'op-1' }] }
    const d = buildDriver(LANE, { state: 'a', count: 0 }, plan)
    await d.init()
    await d.step({ kind: 'fire', event: 'e1', opId: 'op-1' })
    // e1 fires TWICE: the first a→b transitions; the duplicate fires e1 AGAIN from
    // 'b', where e1 has no transition → an invalid-event reject. That reject is the
    // observable proof the duplicate actually ran (a single fire would never reject).
    expect(d.machine.getCurrentState()).toBe('b')
    const dupFrames = d.trace().frames
    expect(dupFrames.some((f) => f.errorClass === 'invalid-event')).toBe(true)

    expect(d.faultRecordsList().map((x) => x.kind)).toContain('dup')
    expect(dupFrames.some((f) => f.faultApplied === 'dup')).toBe(true)

    // clean control: a single e1 reaches 'b' with NO reject.
    const clean = buildDriver(LANE, { state: 'a', count: 0 }, { faults: [] })
    await clean.init()
    await clean.step({ kind: 'fire', event: 'e1', opId: 'op-1' })
    expect(clean.trace().frames.some((f) => f.errorClass === 'invalid-event')).toBe(false)

    const d2 = buildDriver(LANE, { state: 'a', count: 0 }, plan)
    await d2.init()
    await d2.step({ kind: 'fire', event: 'e1', opId: 'op-1' })
    expect(hashTrace(d2.trace())).toBe(hashTrace(d.trace()))
  })

  it('REORDER swaps adjacent submissions (observable: final state differs) + FaultRecord + replay-identical', async () => {
    const plan: FaultPlan = { faults: [{ kind: 'reorder', site: { seam: 'event-queue', opId: 'op-A' }, opId: 'op-A' }] }
    const d = buildDriver(LANE, { state: 'a', count: 0 }, plan)
    await d.init()
    // fireMany applies the reorder over the ≥2-entry submission window.
    const results = await d.fireMany([
      { event: 'e1', opId: 'op-A' },
      { event: 'e2', opId: 'op-B' },
    ])
    // reordered to [e2, e1]: e2 rejects from 'a' (no transition), then e1 reaches 'b'.
    expect(d.machine.getCurrentState()).toBe('b')
    expect(results.map((r) => `${r.opId}:${r.outcome}`)).toEqual(['op-B:reject', 'op-A:resolve-true'])

    // clean control: ordered [e1, e2] reaches 'c'.
    const clean = buildDriver(LANE, { state: 'a', count: 0 }, { faults: [] })
    await clean.init()
    await clean.fireMany([
      { event: 'e1', opId: 'op-A' },
      { event: 'e2', opId: 'op-B' },
    ])
    expect(clean.machine.getCurrentState()).toBe('c')

    expect(d.faultRecordsList().map((x) => x.kind)).toContain('reorder')

    // replay-identical (records).
    const d2 = buildDriver(LANE, { state: 'a', count: 0 }, plan)
    await d2.init()
    await d2.fireMany([
      { event: 'e1', opId: 'op-A' },
      { event: 'e2', opId: 'op-B' },
    ])
    expect(JSON.stringify(d2.faultRecordsList())).toBe(JSON.stringify(d.faultRecordsList()))
  })

  it('OVERFLOW floods past maxQueueDepth (observable: queue-overflow errorClass) + FaultRecord + replay-identical', async () => {
    // A guard-blocked self-loop never drains, so flooded fires PILE in the external
    // queue and the (maxQueueDepth+1)-th enqueue rejects synchronously (:234).
    const blocked: StateMachineConfig<Box> = {
      name: 'OF',
      stateAttribute: 'state',
      initialState: 'a',
      states: { a: {} },
      events: { noop: { transitions: [{ from: 'a', to: 'a', guard: () => false }] } },
    } as StateMachineConfig<Box>
    const plan: FaultPlan = {
      faults: [{ kind: 'overflow', site: { seam: 'event-queue', opId: 'op-of' }, opId: 'op-of', floodCount: 6 }],
    }
    const d = buildDriver(blocked, { state: 'a', count: 0 }, plan, 3)
    await d.init()
    await d.step({ kind: 'fire', event: 'noop', opId: 'op-of' })
    const frames = d.trace().frames
    // observable effect: the FROZEN queue-overflow errorClass surfaced.
    expect(frames.some((f) => f.errorClass === 'queue-overflow')).toBe(true)
    expect(frames.some((f) => f.faultApplied === 'overflow')).toBe(true)
    expect(d.faultRecordsList().map((x) => x.kind)).toContain('overflow')

    const d2 = buildDriver(blocked, { state: 'a', count: 0 }, plan, 3)
    await d2.init()
    await d2.step({ kind: 'fire', event: 'noop', opId: 'op-of' })
    expect(hashTrace(d2.trace())).toBe(hashTrace(d.trace()))
  })

  // ── clock-skew / timer-jitter / throw: generated scenarios (real engine) ─────

  it('CLOCK-SKEW shifts logical time forward (observable: hash differs from clean) + FaultRecord + replay-identical', async () => {
    const spec = await generateScenario(7n)
    // The generated op stream contains advance ops; skew op-1 (an advance) forward.
    const plan: FaultPlan = { faults: [{ kind: 'clock-skew', site: { seam: 'scheduler', opId: 'op-1' }, deltaMs: 50 }] }
    const faulted = { ...spec, faults: plan }
    const t1 = await runScenario(faulted)
    const clean = await runScenario(spec)
    expect(hashTrace(t1)).not.toBe(hashTrace(clean)) // observable: skew perturbed the run
    expect(t1.frames.some((f) => f.faultApplied === 'clock-skew')).toBe(true)
    // replay-identical
    const t2 = await runScenario(faulted)
    expect(hashTrace(t2)).toBe(hashTrace(t1))
  }, 30000)

  it('TIMER-JITTER perturbs an armed invoke timer (observable: hash differs from clean) + tag + replay-identical', async () => {
    const spec = await generateScenario(7n)
    const plan: FaultPlan = {
      faults: [
        {
          kind: 'timer-jitter',
          site: { seam: 'scheduler', stateName: 'cP.rA.start', invokeIndex: 0, armEpoch: 0 },
          jitterMs: 3,
        },
      ],
    }
    const faulted = { ...spec, faults: plan }
    const t1 = await runScenario(faulted)
    const clean = await runScenario(spec)
    expect(hashTrace(t1)).not.toBe(hashTrace(clean))
    expect(t1.frames.some((f) => f.faultApplied === 'timer-jitter')).toBe(true)
    const t2 = await runScenario(faulted)
    expect(hashTrace(t2)).toBe(hashTrace(t1))
  }, 30000)

  it('THROW injects an InjectedFault at the harness boundary (observable: throw tag + hash differs) + replay-identical', async () => {
    const spec = await generateScenario(7n)
    // The region rA arms a function-valued invoke action (invokeIndex 0); a throw
    // fault on it raises an InjectedFault the harness observes at the wire boundary.
    const plan: FaultPlan = {
      faults: [{ kind: 'throw', site: { seam: 'callback', callbackKind: 'invoke.action', invokeIndex: 0, stateName: 'cP.rA.start' } }],
    }
    const faulted = { ...spec, faults: plan }
    const t1 = await runScenario(faulted)
    const clean = await runScenario(spec)
    expect(hashTrace(t1)).not.toBe(hashTrace(clean)) // observable: the throw changed the run
    expect(t1.frames.some((f) => f.faultApplied === 'throw')).toBe(true)
    const t2 = await runScenario(faulted)
    expect(hashTrace(t2)).toBe(hashTrace(t1))
  }, 30000)
})
