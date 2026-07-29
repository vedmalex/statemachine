import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createVirtualScheduler } from '../scheduler'
import { StateMachine } from '../state_machine'
import type { ILogger, StateMachineConfig } from '../types'

/**
 * `transitionTimeout` observability suite.
 *
 * Two properties are pinned here:
 *  1. the deadline timer armed for a racing action is ALWAYS disposed, on the
 *     default scheduler as well as an injected one, for BOTH race outcomes;
 *  2. an `invoke` action that FAILS — by throwing or by blowing its
 *     `transitionTimeout` — reaches the same observable error channels
 *     (`monitor.recordError` / config `onError`) as every other invoke failure,
 *     instead of vanishing.
 */

interface Box {
  state: string
  n: number
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

function quietLogger(): ILogger & { errors: string[] } {
  const errors: string[] = []
  return {
    errors,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message: string) => {
      errors.push(message)
    },
  } as unknown as ILogger & { errors: string[] }
}

// ---------------------------------------------------------------------------
// 1. The deadline timer is disposed on every path
// ---------------------------------------------------------------------------

describe('transitionTimeout: the deadline timer is always disposed', () => {
  // A delay value no other timer in the process will use, so the tracker can
  // isolate the machine's deadline handle from vitest's own timers.
  const DEADLINE_MS = 987_654

  let realSetTimeout: typeof globalThis.setTimeout
  let realClearTimeout: typeof globalThis.clearTimeout
  /** Handles armed with exactly DEADLINE_MS and not yet cleared. */
  let liveDeadlines: Set<unknown>
  /** How many DEADLINE_MS timers the machine armed (guards a vacuous pass). */
  let armedDeadlines: number
  /**
   * When set, a DEADLINE_MS request is armed at 1 ms instead. That lets the
   * TIMEOUT win the race while the tracker still keys on the unique sentinel —
   * so the assertion is about the machine's own handle and nothing else's.
   */
  let accelerate: boolean

  beforeEach(() => {
    liveDeadlines = new Set()
    armedDeadlines = 0
    accelerate = false
    realSetTimeout = globalThis.setTimeout
    realClearTimeout = globalThis.clearTimeout
    globalThis.setTimeout = ((cb: any, ms?: any, ...rest: any[]) => {
      const isDeadline = ms === DEADLINE_MS
      const handle = (realSetTimeout as any)(
        cb,
        isDeadline && accelerate ? 1 : ms,
        ...rest,
      )
      if (isDeadline) {
        armedDeadlines++
        liveDeadlines.add(handle)
      }
      return handle
    }) as unknown as typeof globalThis.setTimeout
    globalThis.clearTimeout = ((handle: any) => {
      liveDeadlines.delete(handle)
      return (realClearTimeout as any)(handle)
    }) as unknown as typeof globalThis.clearTimeout
  })

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
    // Nothing must survive the test either way.
    for (const handle of liveDeadlines) (realClearTimeout as any)(handle)
  })

  function machine(onEnter: (owner: Box) => Promise<void>): StateMachine<Box> {
    const config: StateMachineConfig<Box> = {
      name: 'Deadline',
      stateAttribute: 'state',
      initialState: 'a',
      states: { a: {}, b: { onEnter } },
      events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
    }
    return new StateMachine<Box>(
      config,
      { state: 'a', n: 0 },
      { transitionTimeout: DEADLINE_MS, logger: quietLogger() },
    )
  }

  it('clears the deadline when the ACTION wins the race (default scheduler)', async () => {
    const sm = machine(async (owner) => {
      owner.n++
    })

    await sm.fireEvent('go')

    expect(armedDeadlines).toBe(1)
    expect(liveDeadlines.size).toBe(0)
  })

  it('clears the deadline when the TIMEOUT wins the race (default scheduler)', async () => {
    accelerate = true
    // A deferred the test controls, so the action itself arms no timer and the
    // only tracked handle is the machine's own deadline.
    let release: () => void = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const config: StateMachineConfig<Box> = {
      name: 'DeadlineLoses',
      stateAttribute: 'state',
      initialState: 'a',
      states: { a: {}, b: { onEnter: () => blocked } },
      events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
    }
    const sm = new StateMachine<Box>(
      config,
      { state: 'a', n: 0 },
      { transitionTimeout: DEADLINE_MS, logger: quietLogger() },
    )

    await expect(sm.fireEvent('go')).rejects.toThrow('Transition timeout')
    release()

    expect(armedDeadlines).toBe(1)
    expect(liveDeadlines.size).toBe(0)
  })

  it('cancels the deadline via an INJECTED scheduler (regression guard)', async () => {
    const scheduler = createVirtualScheduler(() => 0)
    let scheduled = 0
    let cancelled = 0
    const spy = {
      isActive: () => scheduler.isActive(),
      schedule: (delay: number, cb: () => void) => {
        scheduled++
        return scheduler.schedule(delay, cb)
      },
      cancel: (token: object) => {
        cancelled++
        scheduler.cancel(token)
      },
      process: () => scheduler.process(),
    }
    const config: StateMachineConfig<Box> = {
      name: 'DeadlineInjected',
      stateAttribute: 'state',
      initialState: 'a',
      states: {
        a: {},
        b: {
          onEnter: async (owner: Box) => {
            owner.n++
          },
        },
      },
      events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
    }
    const sm = new StateMachine<Box>(
      config,
      { state: 'a', n: 0 },
      {
        transitionTimeout: DEADLINE_MS,
        scheduler: spy as any,
        logger: quietLogger(),
      },
    )

    await sm.fireEvent('go')

    expect(scheduled).toBe(1)
    expect(cancelled).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 2. A failing `invoke` action is observable
// ---------------------------------------------------------------------------

interface InvokeProbe {
  sm: StateMachine<Box>
  owner: Box
  recorded: Array<{ message: string; phase?: string; state?: string }>
  onErrorMessages: string[]
  logger: ILogger & { errors: string[] }
}

function invokeProbe(
  action: () => Promise<void>,
  options: { transitionTimeout?: number } = {},
): InvokeProbe {
  const recorded: InvokeProbe['recorded'] = []
  const onErrorMessages: string[] = []
  const owner: Box = { state: 'start', n: 0 }
  const logger = quietLogger()
  const config: StateMachineConfig<Box> = {
    name: 'InvokeFailure',
    stateAttribute: 'state',
    initialState: 'start',
    onError: (_owner: Box, error: Error) => {
      onErrorMessages.push(error.message)
    },
    states: {
      start: { invoke: [{ delay: 10, event: 'go', action }] },
      done: {
        onEnter: (o: Box) => {
          o.n++
        },
      },
    },
    events: { go: { transitions: [{ from: 'start', to: 'done' }] } },
  }
  const monitor: any = {
    recordTransition: () => {},
    recordStateEntry: () => {},
    recordStateExit: () => {},
    getMetrics: () => ({}),
    reset: () => {},
    recordError: (error: Error, context: any) => {
      recorded.push({
        message: error.message,
        phase: context?.phase,
        state: context?.state,
      })
    },
  }
  const sm = new StateMachine<Box>(config, owner, {
    ...options,
    monitor,
    logger,
  })
  return { sm, owner, recorded, onErrorMessages, logger }
}

describe('invoke action failure is observable', () => {
  const unhandled: unknown[] = []
  const capture = (reason: unknown): void => {
    unhandled.push(reason)
  }

  beforeEach(() => {
    unhandled.length = 0
    process.on('unhandledRejection', capture)
  })

  afterEach(() => {
    process.off('unhandledRejection', capture)
  })

  it('surfaces an EXPIRED invoke action on recordError and config onError', async () => {
    const probe = invokeProbe(() => sleep(200), { transitionTimeout: 40 })

    await sleep(150)

    expect(probe.recorded).toHaveLength(1)
    expect(probe.recorded[0]?.message).toBe('Transition timeout')
    expect(probe.recorded[0]?.phase).toBe('action')
    expect(probe.recorded[0]?.state).toBe('start')
    expect(probe.onErrorMessages).toEqual(['Transition timeout'])
    // Non-cancellation and the "event not raised on failure" contract are both
    // preserved: the action keeps running and the machine does not advance.
    expect(probe.owner.state).toBe('start')
    expect(probe.owner.n).toBe(0)
  })

  it('reports an expiry through the SAME channels as a throwing action', async () => {
    const thrower = invokeProbe(async () => {
      throw new Error('boom')
    })

    await sleep(120)

    expect(thrower.recorded).toHaveLength(1)
    expect(thrower.recorded[0]?.phase).toBe('action')
    expect(thrower.recorded[0]?.state).toBe('start')
    expect(thrower.onErrorMessages).toHaveLength(1)
    expect(thrower.owner.state).toBe('start')
  })

  it('produces no unhandled rejection when an invoke action expires', async () => {
    invokeProbe(() => sleep(200), { transitionTimeout: 40 })

    await sleep(300)

    expect(unhandled).toEqual([])
  })

  it('produces no unhandled rejection when the LOSING action later rejects', async () => {
    // The deadline wins the race and the action rejects afterwards, so the
    // rejection arrives at a `Promise.race` branch nobody is awaiting any more.
    const probe = invokeProbe(async () => {
      await sleep(120)
      throw new Error('late failure')
    }, { transitionTimeout: 30 })

    await sleep(300)

    expect(unhandled).toEqual([])
    // The expiry — not the late rejection — is what was reported.
    expect(probe.recorded.map((r) => r.message)).toEqual(['Transition timeout'])
  })

  it('leaves a SUCCEEDING invoke action untouched (no new noise)', async () => {
    const probe = invokeProbe(async () => {}, { transitionTimeout: 500 })

    await sleep(120)

    expect(probe.recorded).toEqual([])
    expect(probe.onErrorMessages).toEqual([])
    expect(probe.owner.state).toBe('done')
    expect(probe.owner.n).toBe(1)
  })
})
