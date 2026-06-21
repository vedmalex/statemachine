import { describe, expect, it } from 'vitest'
import { createVirtualScheduler, TimerScheduler } from '../scheduler'
import { StateMachine } from '../state_machine'
import {
  MemoryAdapter,
  type StateMachineConfig,
  StateMachineError,
} from '../types'

/**
 * Deterministic-Simulation-Testing (DST) suite for TASK-013.
 *
 * Every test drives time through an externally advanced virtual clock
 * (`let t = 0; const clock = () => t`) combined with `createVirtualScheduler`.
 * There are NO real `setTimeout` calls and NO sleeps: time only advances when a
 * test mutates `t` and calls `scheduler.process()`. Because invoke callbacks are
 * async (they raise an event and `queueMicrotask` the queue drain), every
 * `process()` is followed by a microtask flush.
 */

interface Box {
  state: string
  count: number
}

/**
 * Flush the microtask queue enough times to settle chained transitions.
 * Each `await Promise.resolve()` lets one layer of queued microtasks run; a
 * handful of iterations covers invoke -> raiseEvent -> processQueues ->
 * (re-armed) invoke chains used in these tests.
 */
async function flush(times = 16): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

function singleInvokeConfig(delay = 1000): StateMachineConfig<Box> {
  return {
    name: 'SingleInvoke',
    stateAttribute: 'state',
    initialState: 'start',
    states: {
      start: {
        invoke: [{ delay, event: 'go' }],
      },
      next: {
        onEnter: (owner: Box) => {
          owner.count++
        },
      },
    },
    events: {
      go: { transitions: [{ from: 'start', to: 'next' }] },
    },
  }
}

describe('DST: deterministic virtual-clock replay (TASK-013)', () => {
  // #1 — invoke fires at the exact virtual tick.
  it('#1 invoke fires at exact virtual tick', async () => {
    let t = 0
    const clock = () => t
    const scheduler = createVirtualScheduler(clock)
    const adapter = new MemoryAdapter<Box>({ state: 'start', count: 0 })
    const sm = new StateMachine<Box, ReturnType<typeof singleInvokeConfig>>(
      singleInvokeConfig(1000),
      adapter,
      { clock, scheduler },
    )
    await flush() // settle the construction-time invoke arming
    expect(sm.currentState).toBe('start')

    t = 1000
    scheduler.process()
    await flush()

    expect(sm.currentState).toBe('next')
  })

  // #2 — invoke does NOT fire before the deadline.
  it('#2 invoke does NOT fire before deadline', async () => {
    let t = 0
    const clock = () => t
    const scheduler = createVirtualScheduler(clock)
    const adapter = new MemoryAdapter<Box>({ state: 'start', count: 0 })
    const sm = new StateMachine<Box, ReturnType<typeof singleInvokeConfig>>(
      singleInvokeConfig(1000),
      adapter,
      { clock, scheduler },
    )
    await flush()

    t = 999
    scheduler.process()
    await flush()

    expect(sm.currentState).toBe('start')
  })

  // #3 — fires exactly at the boundary, and double-drain is idempotent.
  it('#3 invoke fires exactly at boundary, idempotent process()', async () => {
    let t = 0
    const clock = () => t
    const scheduler = createVirtualScheduler(clock)
    const adapter = new MemoryAdapter<Box>({ state: 'start', count: 0 })
    const sm = new StateMachine<Box, ReturnType<typeof singleInvokeConfig>>(
      singleInvokeConfig(1000),
      adapter,
      { clock, scheduler },
    )
    await flush()

    t = 1000
    scheduler.process()
    scheduler.process() // second drain must not re-fire
    await flush()

    // onEnter of `next` increments count exactly once -> proves single transition.
    expect(sm.currentState).toBe('next')
    expect(adapter.adaptee.count).toBe(1)
  })

  // #4 — resumeTimers restores the remaining delay across serialize/deserialize.
  it('#4 resumeTimers restores remaining delay across serialize/deserialize', async () => {
    let t = 0
    const clock = () => t
    const scheduler = createVirtualScheduler(clock)
    const config = singleInvokeConfig(1000)
    const adapter = new MemoryAdapter<Box>({ state: 'start', count: 0 })
    const sm = new StateMachine<Box, typeof config>(config, adapter, {
      clock,
      scheduler,
    })
    await flush()

    // Advance partway, then snapshot.
    t = 400
    const json = sm.toJSON()

    // Fresh machine + fresh scheduler whose clock already reads 400.
    const scheduler2 = createVirtualScheduler(clock)
    const adapter2 = new MemoryAdapter<Box>({ state: '', count: 0 })
    const sm2 = StateMachine.fromJSON<Box, typeof config>(json, adapter2, {
      clock,
      scheduler: scheduler2,
    })
    await flush()
    expect(sm2.currentState).toBe('start')

    // 600 ms of the original 1000 ms remain.
    t = 999
    scheduler2.process()
    await flush()
    expect(sm2.currentState).toBe('start')

    t = 1000
    scheduler2.process()
    await flush()
    expect(sm2.currentState).toBe('next')
  })

  // #5 — transitionTimeout aborts via the virtual clock.
  it('#5 transitionTimeout aborts via virtual clock', async () => {
    let t = 0
    const clock = () => t
    const scheduler = createVirtualScheduler(clock)
    const config: StateMachineConfig<Box> = {
      name: 'TimeoutSM',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        // Entry action never resolves -> the transition must time out.
        busy: {
          onEnter: () => new Promise<void>(() => {}),
        },
      },
      events: {
        go: { transitions: [{ from: 'idle', to: 'busy' }] },
      },
    }
    const adapter = new MemoryAdapter<Box>({ state: 'idle', count: 0 })
    const sm = new StateMachine<Box, typeof config>(config, adapter, {
      clock,
      scheduler,
      transitionTimeout: 500,
    })
    await flush()

    const firePromise = sm.fireEvent('go')
    const settled: { rejected: boolean; err?: unknown } = { rejected: false }
    firePromise.catch((err) => {
      settled.rejected = true
      settled.err = err
    })
    await flush()

    t = 500
    scheduler.process()
    await flush()

    expect(settled.rejected).toBe(true)
    expect(settled.err).toBeInstanceOf(StateMachineError)
    expect((settled.err as StateMachineError).message).toContain(
      'Transition timeout',
    )

    // A further drain must not throw / produce a ghost rejection.
    t = 1000
    scheduler.process()
    await flush()
  })

  // #6 — transitionTimeout does NOT abort a fast action.
  it('#6 transitionTimeout does NOT abort a fast action', async () => {
    let t = 0
    const clock = () => t
    const scheduler = createVirtualScheduler(clock)
    const config: StateMachineConfig<Box> = {
      name: 'FastSM',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        done: {
          onEnter: (owner: Box) => {
            owner.count++
          },
        },
      },
      events: {
        go: { transitions: [{ from: 'idle', to: 'done' }] },
      },
    }
    const adapter = new MemoryAdapter<Box>({ state: 'idle', count: 0 })
    const sm = new StateMachine<Box, typeof config>(config, adapter, {
      clock,
      scheduler,
      transitionTimeout: 500,
    })
    await flush()

    await sm.fireEvent('go')
    await flush()
    expect(sm.currentState).toBe('done')
    expect(adapter.adaptee.count).toBe(1)

    // Advancing past the timeout must not produce a late rejection.
    t = 1000
    scheduler.process()
    await flush()
    expect(sm.currentState).toBe('done')
  })

  // #7 — stateEntryTimes recorded with the virtual clock (observed via resume math).
  it('#7 stateEntryTimes recorded with virtual clock', async () => {
    let t = 123
    const clock = () => t
    const scheduler = createVirtualScheduler(clock)
    const config = singleInvokeConfig(1000)
    const adapter = new MemoryAdapter<Box>({ state: 'start', count: 0 })
    const sm = new StateMachine<Box, typeof config>(config, adapter, {
      clock,
      scheduler,
    })
    await flush()

    // Entry recorded at t=123. Remaining delay is measured from 123, so the
    // invoke must fire at t=123+1000=1123, NOT before. If the entry time had
    // been recorded against Date.now() the elapsed math (serialize/restore)
    // would be wrong; we observe it through the deadline.
    const json = sm.toJSON()
    const scheduler2 = createVirtualScheduler(clock)
    const sm2 = StateMachine.fromJSON<Box, typeof config>(
      json,
      new MemoryAdapter<Box>({ state: '', count: 0 }),
      { clock, scheduler: scheduler2 },
    )
    await flush()

    t = 1122
    scheduler2.process()
    await flush()
    expect(sm2.currentState).toBe('start')

    t = 1123
    scheduler2.process()
    await flush()
    expect(sm2.currentState).toBe('next')
  })

  // #8 — parallel regions: independent virtual timers fire at their own ticks.
  it('#8 parallel regions: independent virtual timers', async () => {
    let t = 0
    const clock = () => t
    const scheduler = createVirtualScheduler(clock)
    const config: StateMachineConfig<Box> = {
      name: 'ParallelSM',
      stateAttribute: 'state',
      initialState: 'p',
      states: {
        p: {
          regions: {
            a: {
              a1: { invoke: [{ delay: 300, event: 'aDone' }] },
              a2: {},
            },
            b: {
              b1: { invoke: [{ delay: 700, event: 'bDone' }] },
              b2: {},
            },
          },
        },
      },
      events: {
        aDone: { transitions: [{ from: 'p.a.a1', to: 'p.a.a2' }] },
        bDone: { transitions: [{ from: 'p.b.b1', to: 'p.b.b2' }] },
      },
    }
    const adapter = new MemoryAdapter<Box>({ state: 'p', count: 0 })
    const sm = new StateMachine<Box, typeof config>(config, adapter, {
      clock,
      scheduler,
    })
    await flush()

    // Region A fires at 300, region B is still pending.
    t = 300
    scheduler.process()
    await flush()
    expect(sm.currentState).toContain('p.a.a2')
    expect(sm.currentState).toContain('p.b.b1')

    // Region B fires at 700.
    t = 700
    scheduler.process()
    await flush()
    expect(sm.currentState).toContain('p.a.a2')
    expect(sm.currentState).toContain('p.b.b2')
  })

  // #9 — deterministic region initial selection (insertion order, no `initial`).
  it('#9 deterministic region initial selection', async () => {
    let t = 0
    const clock = () => t
    const scheduler = createVirtualScheduler(clock)
    // Region states deliberately inserted out of lexicographic order. With no
    // explicit `initial`, the first DECLARED state is chosen (insertion order,
    // deterministic per ECMAScript). 'zeta' is declared first -> it is initial.
    const config: StateMachineConfig<Box> = {
      name: 'RegionInitialSM',
      stateAttribute: 'state',
      initialState: 'p',
      states: {
        p: {
          regions: {
            r: {
              zeta: {},
              alpha: {},
            },
          },
        },
      },
      events: {},
    }
    const adapter = new MemoryAdapter<Box>({ state: 'p', count: 0 })
    const sm = new StateMachine<Box, typeof config>(config, adapter, {
      clock,
      scheduler,
    })
    await flush()

    expect(sm.currentState).toBe('p.r.zeta')
  })

  // #10 — getQueuedEvents age uses the virtual clock (writer/reader coherence).
  it('#10 getQueuedEvents age uses virtual clock', async () => {
    let t = 0
    const clock = () => t
    const scheduler = createVirtualScheduler(clock)
    const config: StateMachineConfig<Box> = {
      name: 'QueueAgeSM',
      stateAttribute: 'state',
      initialState: 'idle',
      states: { idle: {}, active: {} },
      events: {
        activate: { transitions: [{ from: 'idle', to: 'active' }] },
      },
    }
    const adapter = new MemoryAdapter<Box>({ state: 'idle', count: 0 })
    const sm = new StateMachine<Box, typeof config>(config, adapter, {
      clock,
      scheduler,
    })
    await flush()

    // Enqueue at t=0. processQueues runs on a microtask, so synchronously (no
    // await yet) the event is still in the queue with the t=0 timestamp.
    const p = sm.fireEvent('activate')

    // Right after enqueue, writer and reader share the virtual clock -> age 0.
    expect(sm.getQueuedEvents()[0]?.age).toBe(0)

    // Advance virtual time WITHOUT flushing: the queued event's age tracks the
    // virtual delta, proving age = clock() - clock(), not a wall-clock mix.
    t = 250
    expect(sm.getQueuedEvents()[0]?.age).toBe(250)

    // Drain and confirm the transition completes.
    await p
    await flush()
    expect(sm.currentState).toBe('active')
  })

  // #11 — BACK-COMPAT GUARD: default options remain real-time.
  it('#11 default options remain real-time (back-compat)', async () => {
    // No clock, no scheduler: schedulerProvided === false, so invoke timers go
    // through native setTimeout. A virtual scheduler we never injected cannot
    // drive the machine; the only way the invoke fires is real wall-clock time.
    let t = 0
    const clock = () => t
    const detachedScheduler = createVirtualScheduler(clock)

    const adapter = new MemoryAdapter<Box>({ state: 'start', count: 0 })
    const sm = new StateMachine<Box, ReturnType<typeof singleInvokeConfig>>(
      singleInvokeConfig(1000),
      adapter,
    ) // <- NO options
    await flush()
    expect(sm.currentState).toBe('start')

    // Advancing a scheduler the machine never received does nothing: the
    // default path uses real setTimeout, not this virtual scheduler.
    t = 5000
    detachedScheduler.process()
    await flush()
    expect(sm.currentState).toBe('start')
  })

  // #12 — an EXPLICITLY provided but UNSTARTED real scheduler is still routed
  // through (schedulerProvided contract), never via setTimeout. Pins Blocker #2
  // routing: without it, an unstarted scheduler's isActive() is false and the
  // timer would fall back to real setTimeout (and would never be drainable via
  // process()). With a virtual clock + manual process() the invoke fires.
  it('#12 explicit unstarted real scheduler is routed through (not setTimeout)', async () => {
    let t = 0
    const clock = () => t
    const realScheduler = new TimerScheduler(clock)
    // NOT started: setPollingInterval is never called, so isActive() === false.
    expect(realScheduler.isActive()).toBe(false)

    const adapter = new MemoryAdapter<Box>({ state: 'start', count: 0 })
    const sm = new StateMachine<Box, ReturnType<typeof singleInvokeConfig>>(
      singleInvokeConfig(1000),
      adapter,
      { clock, scheduler: realScheduler },
    )
    await flush()
    expect(sm.currentState).toBe('start')

    // Before the deadline: nothing fires.
    t = 999
    realScheduler.process()
    await flush()
    expect(sm.currentState).toBe('start')

    // At the deadline: the timer queued on the (unstarted) scheduler drains.
    t = 1000
    realScheduler.process()
    await flush()
    expect(sm.currentState).toBe('next')
  })
})
