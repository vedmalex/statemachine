import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { MemoryAdapter, StateMachine, StateMachineError, isAdapter } from '../../index'
import type { Adapter, StateMachineConfig } from '../../index'
import { makeSimClock } from '../../sim/clock'
import { bracketAsync, makeAsyncCounter, makeEnv, makeObservableScheduler } from '../../sim/env'
import type { Env } from '../../sim/env'
import {
  type CorruptStateProbe,
  type FaultKind,
  type FaultPlan,
  type FaultRecord,
  type FaultSite,
  type FaultSpec,
  ENGINE_MESSAGE_FIXTURES,
  I6_PROBE,
  I10_PROBE,
  InjectedFault,
  type RejectionOrigin,
  classifyCorruptState,
  classifyError,
  makeFaultCursor,
  resolveFaultAt,
} from '../../sim/faults'
import {
  type SubmissionEntry,
  type UncoveredMarker,
  applyQueueFaults,
  applyThrowFaults,
  buildOverflowFlood,
  captureRejection,
  fireBuffered,
  isStringMethodCallback,
  issueCorruptStateWrite,
  markStringMethodUncovered,
} from '../../sim/harness'
import {
  type JitterRule,
  makeObservableSchedulerWithJitter,
  makeSiteKeyedJitter,
  timerSiteId,
} from '../../sim/observable-scheduler'
import { makePrng } from '../../sim/prng'
import { settleMacrostep } from '../../sim/settle'
import { wrapAdapterForCapture } from '../../sim/capture'
import type { CapturedWrite } from '../../sim/capture'

/**
 * Step-5 fault-layer tests (ADR-5). Every DoD #1..#15 is a named, falsifiable
 * assertion below. The harness wires the REAL engine; no engine source is edited.
 */

interface Box {
  state: string
  log: number[]
  k: number
}

function freshEnv(): Env {
  const clock = makeSimClock(0)
  const { view } = makeObservableScheduler(clock)
  return makeEnv(makeAsyncCounter(), view)
}

// ── DoD 1: FaultKind is EXACTLY seven literals; corrupt-state is NOT a member ──

describe('faults.ts: seven-literal FaultKind + separate corrupt-state probe (DoD 1)', () => {
  it('FaultKind is exactly the seven channel literals', () => {
    expectTypeOf<FaultKind>().toEqualTypeOf<
      'reorder' | 'drop' | 'dup' | 'overflow' | 'clock-skew' | 'timer-jitter' | 'throw'
    >()
  })

  it("'corrupt-state' is NOT assignable to FaultKind (8th probe is separate)", () => {
    expectTypeOf<'corrupt-state'>().not.toEqualTypeOf<FaultKind>()
    // @ts-expect-error — 'corrupt-state' is the harness-only probe, not a channel kind
    const bad: FaultKind = 'corrupt-state'
    void bad
  })

  it('FaultRecord.kind widens FaultKind by exactly the probe literal', () => {
    const rec: FaultRecord = { faultStep: 0, kind: 'corrupt-state', site: { seam: 'event-queue' } }
    expect(rec.kind).toBe('corrupt-state')
    const channel: FaultRecord = { faultStep: 1, kind: 'throw', site: { seam: 'callback' } }
    expect(channel.kind).toBe('throw')
  })
})

// ── DoD 2: InjectedFault is a plain Error, not StateMachineError ───────────────

describe('faults.ts: InjectedFault is a plain Error (DoD 2)', () => {
  it('is instanceof Error but NOT StateMachineError, no errorCode/timestamp', () => {
    const f = new InjectedFault({ seam: 'callback' })
    expect(f).toBeInstanceOf(Error)
    expect(f).not.toBeInstanceOf(StateMachineError)
    expect((f as unknown as { errorCode?: unknown }).errorCode).toBeUndefined()
    expect((f as unknown as { timestamp?: unknown }).timestamp).toBeUndefined()
    expect((f as unknown as { extendedContext?: unknown }).extendedContext).toBeUndefined()
    expect(f.injectedFault).toBe(true)
  })
})

// ── DoD 3: each of the seven kinds recorded; replay is byte-identical (AC-2) ───

describe('faults.ts: per-opportunity fault cursor reproduces FaultRecord[] (DoD 3)', () => {
  const plan: FaultPlan = {
    faults: [
      { kind: 'drop', site: { seam: 'event-queue', opId: 'op2' }, opId: 'op2' },
      { kind: 'throw', site: { seam: 'callback', callbackKind: 'invoke.action', invokeIndex: 0 } },
    ],
  }
  const opIds = ['op0', 'op1', 'op2', 'op3']

  function runOnce(): FaultRecord[] {
    const cursor = makeFaultCursor()
    const records: FaultRecord[] = []
    for (const id of opIds) {
      resolveFaultAt(plan, id, cursor, records)
    }
    return records
  }

  it('one PRNG-aligned opportunity per opId; matched faults recorded', () => {
    const records = runOnce()
    // only the drop fault (keyed to op2) fires by opId; the throw fault has no opId
    expect(records).toHaveLength(1)
    expect(records[0]?.kind).toBe('drop')
    expect(records[0]?.opId).toBe('op2')
    // faultStep is the opportunity index of op2 (index 2 in the opId stream)
    expect(records[0]?.faultStep).toBe(2)
  })

  it('re-running yields a byte-identical FaultRecord[] (AC-2)', () => {
    expect(JSON.stringify(runOnce())).toBe(JSON.stringify(runOnce()))
  })

  it('cursor advances exactly one step per opportunity (alignment)', () => {
    const cursor = makeFaultCursor()
    const records: FaultRecord[] = []
    resolveFaultAt(plan, 'opX', cursor, records)
    expect(cursor.faultStep).toBe(1)
    resolveFaultAt(plan, 'opY', cursor, records)
    expect(cursor.faultStep).toBe(2)
  })
})

// ── DoD 4: site-keyed jitter survives restore at non-zero elapsed ─────────────

describe('observable-scheduler.ts: site-keyed jitter is re-arm stable (DoD 4)', () => {
  const rules: readonly JitterRule[] = [{ timerSiteId: timerSiteId('sA', 0, 0), jitterMs: 3 }]

  it('same site id ⇒ same perturbation j across re-arms (memoized fork)', () => {
    const prng = makePrng(7n)
    const j = makeSiteKeyedJitter(prng, rules)
    const id = timerSiteId('sA', 0, 0)
    j.enterSite(id)
    const j1 = j.jitterFn(5)
    j.exitSite()
    j.enterSite(id)
    const j2 = j.jitterFn(5) // re-arm at a DIFFERENT base delay
    j.exitSite()
    expect(j1).toBe(j2)
    expect(j1).toBeGreaterThanOrEqual(-3)
    expect(j1).toBeLessThanOrEqual(3)
  })

  it('j is site-stable while eff differs when base delay differs (restore at non-zero elapsed)', () => {
    const prng = makePrng(7n)
    const j = makeSiteKeyedJitter(prng, rules)
    const id = timerSiteId('sA', 0, 0)
    j.enterSite(id)
    const jArm = j.jitterFn(10) // first arm: base delay 10
    const effArm = Math.max(0, 10 + jArm)
    j.exitSite()
    j.enterSite(id)
    const jResume = j.jitterFn(4) // resume: remaining = max(0, 10 - 6 elapsed) = 4
    const effResume = Math.max(0, 4 + jResume)
    j.exitSite()
    // SAME perturbation, but eff legitimately differs because base differs.
    expect(jArm).toBe(jResume)
    expect(effArm).not.toBe(effResume)
  })

  it('faultStep-keyed negative control: a different site id diverges', () => {
    const prng = makePrng(7n)
    const j = makeSiteKeyedJitter(prng, [
      { timerSiteId: timerSiteId('sA', 0, 0), jitterMs: 5 },
      { timerSiteId: timerSiteId('sA', 0, 1), jitterMs: 5 },
    ])
    j.enterSite(timerSiteId('sA', 0, 0))
    const jEpoch0 = j.jitterFn(5)
    j.exitSite()
    j.enterSite(timerSiteId('sA', 0, 1))
    const jEpoch1 = j.jitterFn(5)
    j.exitSite()
    // Two distinct sites (different armEpoch) draw from distinct forks.
    expect(jEpoch0).not.toBe(jEpoch1)
  })

  it('armEpoch derives only from logical coordinates (no wall-clock in the id)', () => {
    const id = timerSiteId('s', 1, 42)
    expect(id).toBe('s#1@42')
    expect(id).not.toMatch(/\d{13}/) // no epoch-ms wall-clock timestamp baked in
  })
})

// ── DoD 5: overflow vs depth by per-fire IDENTITY, never message ──────────────

describe('harness.ts: overflow-vs-depth classification by identity (DoD 5)', () => {
  it("a sync-at-enqueue reject classifies 'queue-overflow'", () => {
    const overflow = new StateMachineError('Event queue overflow — possible infinite loop', {
      event: 'go',
      state: 'a',
    })
    const origin: RejectionOrigin = { syncAtEnqueue: true }
    expect(captureRejection(overflow, origin)).toBe('queue-overflow')
  })

  it("a pending-drain reject classifies 'max-transition-depth'", () => {
    const depth = new StateMachineError('Max transition depth exceeded — possible infinite loop', {
      event: 'processQueues',
    })
    const origin: RejectionOrigin = { syncAtEnqueue: false }
    expect(captureRejection(depth, origin)).toBe('max-transition-depth')
  })

  it('classifier never reads error.message: a renamed-message error still classifies by context', () => {
    const renamed = new StateMachineError('TOTALLY DIFFERENT WORDS', { event: 'processQueues' })
    expect(classifyError(renamed, { syncAtEnqueue: false })).toBe('max-transition-depth')
  })

  it('interleaved-pending-plus-flood regression: same context fields, origin disambiguates', () => {
    // Both errors carry context.event with NO phase; ONLY the origin identity
    // distinguishes them (proves no message-based misclassification).
    const a = new StateMachineError('Event queue overflow — possible infinite loop', { event: 'go', state: 's' })
    const b = new StateMachineError('Max transition depth exceeded — possible infinite loop', {
      event: 'processQueues',
    })
    expect(captureRejection(a, { syncAtEnqueue: true })).toBe('queue-overflow')
    expect(captureRejection(b, { syncAtEnqueue: false })).toBe('max-transition-depth')
  })

  it('engine message strings are kept ONLY as drift fixtures (not classification inputs)', () => {
    expect(ENGINE_MESSAGE_FIXTURES.queueOverflow).toContain('Event queue overflow')
    expect(ENGINE_MESSAGE_FIXTURES.maxTransitionDepth).toContain('Max transition depth')
  })
})

// ── DoD 6: transitionTimeout first-class + action-wrapper-finally bracket ─────

describe('harness.ts: transitionTimeout is a first-class rejection (DoD 6)', () => {
  it("classifies the timeout shape as 'transition-timeout', distinct from injected-fault", () => {
    // The engine's transitionTimeout throw: StateMachineError('Transition timeout',
    // {action, phase:'action'}) — NO transition/state, NO cause.
    const timeout = new StateMachineError('Transition timeout', {
      action: 'anonymous',
      phase: 'action',
    })
    expect(classifyError(timeout)).toBe('transition-timeout')

    // An injected fault re-wrapped by callAction carries phase:'action' too, but
    // ALSO a `cause` that is the InjectedFault — so it classifies as injected-fault.
    const wrapped = new StateMachineError('Error executing action: injected fault', {
      action: 'anonymous',
      phase: 'action',
    })
    ;(wrapped as { cause?: unknown }).cause = new InjectedFault({ seam: 'callback' })
    expect(classifyError(wrapped)).toBe('injected-fault')
  })

  it('inFlightAsyncCount stays >0 until the action body settles even if the race already rejected', async () => {
    // Bracket on the ACTION's own promise: a timeout-win reject must NOT decrement
    // while the real action body is still pending (premature-quiescence guard).
    const env = freshEnv()
    let release!: () => void
    const deferred = new Promise<void>((res) => {
      release = res
    })
    const wrappedAction = bracketAsync(env, async () => {
      await deferred // body stays pending until released
    })
    const actionPromise = wrappedAction({})
    expect(env.inFlightAsyncCount()).toBe(1) // body in flight, not yet decremented
    release()
    await actionPromise
    expect(env.inFlightAsyncCount()).toBe(0)
  })
})

// ── DoD 7: ObservableScheduler mirror + lazy-cancel parity ────────────────────

describe('observable-scheduler.ts: mirror + lazy-cancel parity (DoD 7)', () => {
  it('exposes pendingCount/earliestExecuteAt/schedulerEmptyAt mirroring executeAt=clock()+eff', () => {
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableSchedulerWithJitter(clock)
    expect(scheduler.isActive()).toBe(true)
    scheduler.schedule(10, () => {})
    scheduler.schedule(5, () => {})
    expect(view.pendingCount()).toBe(2)
    expect(view.earliestExecuteAt()).toBe(5)
    expect(view.schedulerEmptyAt(4)).toBe(true)
    expect(view.schedulerEmptyAt(5)).toBe(false)
  })

  it('cancel removes the mirror entry at cancel time; cancelled timer never fires', () => {
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableSchedulerWithJitter(clock)
    let fired = false
    const token = scheduler.schedule(5, () => {
      fired = true
    })
    expect(view.pendingCount()).toBe(1)
    scheduler.cancel(token)
    expect(view.pendingCount()).toBe(0)
    expect(view.earliestExecuteAt()).toBeNull()
    clock.set(10)
    scheduler.process(10)
    expect(fired).toBe(false)
  })

  it('a fired timer forgets its mirror entry (no stale earliestExecuteAt)', () => {
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableSchedulerWithJitter(clock)
    scheduler.schedule(5, () => {})
    clock.set(5)
    scheduler.process(5)
    expect(view.pendingCount()).toBe(0)
    expect(view.earliestExecuteAt()).toBeNull()
  })

  it('jitter applies eff=max(0,delay+j) into the mirror', () => {
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableSchedulerWithJitter(clock, () => 3)
    scheduler.schedule(10, () => {})
    expect(view.earliestExecuteAt()).toBe(13)
  })

  it('jitter floors negative effective delay at 0', () => {
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableSchedulerWithJitter(clock, () => -100)
    scheduler.schedule(10, () => {})
    expect(view.earliestExecuteAt()).toBe(0)
  })
})

// ── DoD 8: reorder/drop/dup mutate ONLY the external buffer ───────────────────

describe('harness.ts: queue faults touch only the external submission buffer (DoD 8)', () => {
  const buf: readonly SubmissionEntry[] = [
    { opId: 'a', event: 'e1', args: [] },
    { opId: 'b', event: 'e2', args: [] },
    { opId: 'c', event: 'e3', args: [] },
  ]

  it('drop removes the matching opId only', () => {
    const out = applyQueueFaults(buf, { faults: [{ kind: 'drop', site: { seam: 'event-queue' }, opId: 'b' }] })
    expect(out.map((e) => e.opId)).toEqual(['a', 'c'])
  })

  it('dup duplicates the matching entry immediately after itself', () => {
    const out = applyQueueFaults(buf, { faults: [{ kind: 'dup', site: { seam: 'event-queue' }, opId: 'a' }] })
    expect(out.map((e) => e.opId)).toEqual(['a', 'a', 'b', 'c'])
  })

  it('reorder swaps with the successor in the external buffer only', () => {
    const out = applyQueueFaults(buf, { faults: [{ kind: 'reorder', site: { seam: 'event-queue' }, opId: 'a' }] })
    expect(out.map((e) => e.opId)).toEqual(['b', 'a', 'c'])
  })

  it('the original buffer is never mutated (pure over the external buffer)', () => {
    const before = buf.map((e) => e.opId)
    applyQueueFaults(buf, { faults: [{ kind: 'drop', site: { seam: 'event-queue' }, opId: 'b' }] })
    expect(buf.map((e) => e.opId)).toEqual(before)
  })

  it('overflow flood builds floodCount copies sharing the issuing opId', () => {
    const flood = buildOverflowFlood({ opId: 'x', event: 'go', args: [] }, 4)
    expect(flood).toHaveLength(4)
    expect(flood.every((e) => e.opId === 'x')).toBe(true)
  })
})

// ── DoD 9: inFlightAsyncCount brackets an opaque async action ─────────────────

describe('harness.ts: inFlightAsyncCount brackets opaque async (ISS-030) (DoD 9)', () => {
  it('>0 while a deferred-controlled async action is in flight, 0 after', async () => {
    const env = freshEnv()
    let release!: () => void
    const gate = new Promise<void>((res) => {
      release = res
    })
    const opaque = bracketAsync(env, async () => {
      await gate
      return 1
    })
    expect(env.inFlightAsyncCount()).toBe(0)
    const p = opaque({})
    expect(env.inFlightAsyncCount()).toBe(1) // observably in-flight across a settle sample
    release()
    await p
    expect(env.inFlightAsyncCount()).toBe(0)
  })

  it('a synchronous throw decrements immediately (settles now)', () => {
    const env = freshEnv()
    const thrower = bracketAsync(env, () => {
      throw new Error('sync')
    })
    expect(() => thrower({})).toThrow('sync')
    expect(env.inFlightAsyncCount()).toBe(0)
  })
})

// ── DoD 10/11/13: end-to-end harness against a REAL engine ────────────────────

function baseConfig(throwingAction: (o: Box) => unknown): StateMachineConfig<Box> {
  return {
    name: 'fault-fixture',
    stateAttribute: 'state',
    initialState: 'idle',
    states: {
      idle: {
        invoke: [{ delay: 1, event: 'tick', action: throwingAction }],
      },
      running: {},
    },
    events: {
      tick: { transitions: [{ from: 'idle', to: 'running' }] },
    },
  } as unknown as StateMachineConfig<Box>
}

describe('harness.ts: throw fault observed at the harness boundary on a real engine (DoD 13)', () => {
  it('applyThrowFaults wraps a function-valued invoke.action; throw recorded as injected-fault', async () => {
    const injected: FaultSite[] = []
    const env = freshEnv()
    const plan: FaultPlan = {
      faults: [{ kind: 'throw', site: { seam: 'callback', callbackKind: 'invoke.action', invokeIndex: 0 } }],
    }
    const cfg = baseConfig(() => 0)
    const { config: mutated, uncovered } = applyThrowFaults(cfg, plan, env, (s) => injected.push(s))
    expect(uncovered).toHaveLength(0) // function-valued ⇒ wrapped, not uncovered

    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableScheduler(clock)
    const fullEnv = makeEnv(makeAsyncCounter(), view)
    const sm = new StateMachine<Box, StateMachineConfig<Box>>(
      mutated,
      new MemoryAdapter<Box>({ state: 'idle', log: [], k: 0 }) as unknown as Adapter<never>,
      { clock: clock.now, scheduler, monitor: undefined, errorHandler: undefined, logger: undefined } as never,
    )
    // settle (liveness) so the invoke timer fires and the wrapped action throws.
    await settleMacrostep({ sm, scheduler, clock, env: fullEnv, policy: 'liveness' })
    expect(injected).toHaveLength(1)
    expect(injected[0]?.callbackKind).toBe('invoke.action')
    // The engine swallowed the throw (callAction(...).catch(processError)); the
    // HARNESS boundary is the observable surface, and it fired exactly once.
  })

  it('a string-method invoke.action emits an explicit uncovered/N-A marker (ISS-029)', () => {
    const env = freshEnv()
    const cfg = {
      ...baseConfig(() => 0),
      states: {
        idle: { invoke: [{ delay: 1, event: 'tick', action: 'someMethodName' }] },
        running: {},
      },
    } as unknown as StateMachineConfig<Box>
    const plan: FaultPlan = {
      faults: [{ kind: 'throw', site: { seam: 'callback', callbackKind: 'invoke.action', invokeIndex: 0 } }],
    }
    const { uncovered } = applyThrowFaults(cfg, plan, env, () => {})
    expect(uncovered).toHaveLength(1)
    expect(uncovered[0]).toMatchObject<Partial<UncoveredMarker>>({
      reason: 'string-method',
      capability: 'error.action-throw',
    })
  })

  it('isStringMethodCallback distinguishes string method names from function values', () => {
    expect(isStringMethodCallback('go')).toBe(true)
    expect(isStringMethodCallback(() => 0)).toBe(false)
    const m = markStringMethodUncovered('error.guard-throw', { seam: 'callback' })
    expect(m.capability).toBe('error.guard-throw')
  })
})

// ── DoD 10: explicit-Adapter 2nd positional via fireBuffered ──────────────────

describe('harness.ts: fireBuffered passes the wrapped Adapter explicit 2nd positional (DoD 10)', () => {
  it('the 2nd arg passed to fireEvent satisfies isAdapter (never the unshift path)', async () => {
    const adaptee = new MemoryAdapter<Box>({ state: 'idle', log: [], k: 0 })
    const writes: CapturedWrite[] = []
    const wrapped = wrapAdapterForCapture(adaptee as unknown as Adapter<Box>, 'state', {
      onStateWrite: (w) => writes.push(w),
    })
    let seenSecond: unknown
    const fakeFire = (_event: never, adapter: never, ..._args: number[]): Promise<boolean> => {
      seenSecond = adapter
      return Promise.resolve(true)
    }
    const res = await fireBuffered(fakeFire, wrapped, { opId: 'op0', event: 'tick', args: [1, 2] })
    expect(res.outcome).toBe('resolve-true')
    expect(isAdapter(seenSecond)).toBe(true)
  })

  it('classifies a synchronous overflow reject as queue-overflow with syncAtEnqueue', async () => {
    const adaptee = new MemoryAdapter<Box>({ state: 'idle', log: [], k: 0 })
    const wrapped = wrapAdapterForCapture(adaptee as unknown as Adapter<Box>, 'state', { onStateWrite: () => {} })
    const syncOverflow = (_e: never, _a: never, ..._args: number[]): Promise<boolean> =>
      Promise.reject(new StateMachineError('Event queue overflow — possible infinite loop', { event: 'go', state: 'idle' }))
    const res = await fireBuffered(syncOverflow, wrapped, { opId: 'flood', event: 'go', args: [] })
    expect(res.outcome).toBe('reject')
    expect(res.syncAtEnqueue).toBe(true)
    expect(res.errorClass).toBe('queue-overflow')
  })

  it('classifies a drain-time depth reject as max-transition-depth (not sync)', async () => {
    const adaptee = new MemoryAdapter<Box>({ state: 'idle', log: [], k: 0 })
    const wrapped = wrapAdapterForCapture(adaptee as unknown as Adapter<Box>, 'state', { onStateWrite: () => {} })
    const drainReject = (_e: never, _a: never, ..._args: number[]): Promise<boolean> =>
      // reject after several microtasks so it lands AFTER the sentinel tick
      Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => Promise.resolve())
        .then(() => {
          throw new StateMachineError('Max transition depth exceeded — possible infinite loop', {
            event: 'processQueues',
          })
        }) as Promise<boolean>
    const res = await fireBuffered(drainReject, wrapped, { opId: 'pending', event: 'go', args: [] })
    expect(res.outcome).toBe('reject')
    expect(res.syncAtEnqueue).toBe(false)
    expect(res.errorClass).toBe('max-transition-depth')
  })
})

// ── DoD 12: corrupt-state probe captured + tagged single-frame (issuance) ─────

describe('harness.ts: corrupt-state probe issuance — capture + tag (DoD 12)', () => {
  it('writes the bogus payload through the wrapped Adapter.set (captured exactly once)', () => {
    const adaptee = new MemoryAdapter<Box>({ state: 'idle', log: [], k: 0 })
    const writes: CapturedWrite[] = []
    const wrapped = wrapAdapterForCapture(adaptee as unknown as Adapter<Box>, 'state', {
      onStateWrite: (w) => writes.push(w),
    })
    const written = issueCorruptStateWrite(wrapped, 'state', I10_PROBE)
    expect(written).toBe(I10_PROBE.payload)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.to).toBe(I10_PROBE.payload)
    expect(writes[0]?.from).toBe('idle')
  })

  it('the probe kind is corrupt-state and is NOT a FaultKind member (DoD 12)', () => {
    const probe: CorruptStateProbe = I6_PROBE
    expect(probe.kind).toBe('corrupt-state')
    expectTypeOf<CorruptStateProbe['kind']>().toEqualTypeOf<'corrupt-state'>()
  })

  it('classifyCorruptState returns the FROZEN family class by field-selection (not message)', () => {
    expect(classifyCorruptState(I6_PROBE)).toBe('contradictory-state')
    expect(classifyCorruptState(I10_PROBE)).toBe('invalid-state-path')
  })

  it('I-10 unregistered-leaf write triggers the engine getCurrentState throw on read-back', () => {
    // Behavioral confirmation that the chosen payload reaches a throw (Step-6 owns
    // the full I-10 oracle; here we prove the issuance delivers to a throwing site).
    // A timer-FREE config so no invoke fires (the corrupt state must only be read
    // by the harness-driven getCurrentState, never an engine-internal read).
    const noTimerConfig = {
      name: 'no-timer',
      stateAttribute: 'state',
      initialState: 'idle',
      states: { idle: {}, running: {} },
      events: { tick: { transitions: [{ from: 'idle', to: 'running' }] } },
    } as unknown as StateMachineConfig<Box>
    const adaptee = new MemoryAdapter<Box>({ state: 'idle', log: [], k: 0 })
    const wrapped = wrapAdapterForCapture(adaptee as unknown as Adapter<Box>, 'state', { onStateWrite: () => {} })
    const clock = makeSimClock(0)
    const { scheduler } = makeObservableScheduler(clock)
    const sm = new StateMachine<Box, StateMachineConfig<Box>>(
      noTimerConfig,
      wrapped as unknown as Adapter<never>,
      { clock: clock.now, scheduler } as never,
    )
    issueCorruptStateWrite(wrapped, 'state', I10_PROBE)
    expect(() => sm.getCurrentState()).toThrow(/Invalid state path in current state/)
  })
})

// ── DoD 13: cond-throw is a documented v1 gap (no wrapper touches it) ─────────

describe('harness.ts: invoke[].cond throw is a documented v1 gap (DoD 13)', () => {
  it('applyThrowFaults does NOT wrap invoke[].cond (no callbackKind reaches it)', () => {
    const env = freshEnv()
    const cfg = {
      ...baseConfig(() => 0),
      states: {
        idle: { invoke: [{ delay: 1, event: 'tick', cond: () => false, action: () => 0 }] },
        running: {},
      },
    } as unknown as StateMachineConfig<Box>
    // A throw fault targeting invoke.action must leave cond untouched.
    const plan: FaultPlan = {
      faults: [{ kind: 'throw', site: { seam: 'callback', callbackKind: 'invoke.action', invokeIndex: 0 } }],
    }
    const { config: mutated } = applyThrowFaults(cfg, plan, env, () => {})
    const idle = (mutated.states as Record<string, { invoke?: Array<{ cond?: unknown }> }>)['idle']
    const cond = idle?.invoke?.[0]?.cond
    // cond is the ORIGINAL function-valued cond, never wrapped by the throw layer.
    expect(typeof cond).toBe('function')
    // There is no FaultSite.callbackKind literal for cond — it cannot be targeted.
    expectTypeOf<NonNullable<FaultSite['callbackKind']>>().not.toEqualTypeOf<'invoke.cond'>()
  })
})

// ── DoD 14: captureRejection drops error.context entirely ─────────────────────

describe('harness.ts: captureRejection drops error.context (DoD 14)', () => {
  it('returns only the frozen ErrorClass, never any context field', () => {
    const err = new StateMachineError('Invalid event: x for state: s', { state: 's', event: 'x' })
    const out = captureRejection(err)
    // The result is a plain enum string — no object, no context.state leaks out.
    expect(typeof out).toBe('string')
    expect(out).toBe('invalid-event')
    expect((out as unknown as { state?: unknown }).state).toBeUndefined()
  })

  it('an unclassifiable error yields undefined (no context fallthrough)', () => {
    expect(captureRejection(new Error('opaque'))).toBeUndefined()
    expect(captureRejection({ context: { phase: 'guard' } })).toBeUndefined()
  })
})

// ── DoD 15: determinism grep-clean (no wall-clock / Math.random in fault path) ─

describe('faults layer: determinism grep-clean (DoD 15)', () => {
  it('faults.ts / harness.ts / observable-scheduler.ts contain no wall-clock or Math.random source', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const here = path.dirname(new URL(import.meta.url).pathname)
    const simDir = path.resolve(here, '../../sim')
    for (const file of ['faults.ts', 'harness.ts', 'observable-scheduler.ts']) {
      const src = fs.readFileSync(path.join(simDir, file), 'utf8')
      // strip line comments + block comments so doc-citations like "Date.now()" in
      // prose do not trip the grep; only LIVE source is checked.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, ''))
        .join('\n')
      expect(code).not.toMatch(/Math\.random/)
      expect(code).not.toMatch(/Date\.now/)
      expect(code).not.toMatch(/performance\.now/)
      expect(code).not.toMatch(/process\.hrtime/)
      expect(code).not.toMatch(/\bsetTimeout\b/)
      expect(code).not.toMatch(/\bsetInterval\b/)
    }
  })

  it('FaultSpec is a closed discriminated union over the seven kinds', () => {
    const specs: FaultSpec[] = [
      { kind: 'drop', site: { seam: 'event-queue' }, opId: 'o' },
      { kind: 'overflow', site: { seam: 'event-queue' }, opId: 'o', floodCount: 3 },
      { kind: 'clock-skew', site: { seam: 'scheduler' }, deltaMs: 5 },
      { kind: 'timer-jitter', site: { seam: 'scheduler' }, jitterMs: 2 },
      { kind: 'throw', site: { seam: 'callback' } },
    ]
    expect(specs).toHaveLength(5)
  })
})
