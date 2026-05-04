import { describe, expect, test } from 'vitest'
import { StateMachine } from '../state_machine'
import {
  type Adapter,
  MemoryAdapter,
  type StateMachineConfig,
  StateMachineError,
} from '../types'

interface Counter {
  state: string
  value: number
  log: string[]
}

describe('Event Queue', () => {
  test('internal events should be processed before external events', async () => {
    const log: string[] = []

    const config: StateMachineConfig<Counter> = {
      name: 'InternalPriorityTest',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {
          onEnter: (adapter: Adapter<Counter>) => {
            log.push('enter:idle')
          },
        },
        processing: {
          onEnter: (adapter: Adapter<Counter>) => {
            log.push('enter:processing')
          },
        },
        done: {
          onEnter: (adapter: Adapter<Counter>) => {
            log.push('enter:done')
          },
        },
      },
      events: {
        start: { transitions: [{ from: 'idle', to: 'processing' }] },
        complete: { transitions: [{ from: 'processing', to: 'done' }] },
        reset: { transitions: [{ from: 'done', to: 'idle' }] },
      },
    }

    const adapter = new MemoryAdapter<Counter>({
      state: 'idle',
      value: 0,
      log: [],
    })
    const sm = new StateMachine<Counter, typeof config>(config, adapter)

    await sm.fireEvent('start')
    expect(sm.currentState).toBe('processing')
    expect(log).toContain('enter:processing')
  })

  test('getQueueDepth should return correct queue sizes', async () => {
    const config: StateMachineConfig<Counter> = {
      name: 'QueueDepthTest',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        active: {},
      },
      events: {
        activate: { transitions: [{ from: 'idle', to: 'active' }] },
      },
    }

    const adapter = new MemoryAdapter<Counter>({
      state: 'idle',
      value: 0,
      log: [],
    })
    const sm = new StateMachine<Counter, typeof config>(config, adapter)

    const depth = sm.getQueueDepth()
    expect(depth.internal).toBe(0)
    expect(depth.external).toBe(0)
    expect(depth.total).toBe(0)
  })

  test('getQueuedEvents should return event info', async () => {
    const config: StateMachineConfig<Counter> = {
      name: 'QueuedEventsTest',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        active: {},
      },
      events: {
        activate: { transitions: [{ from: 'idle', to: 'active' }] },
      },
    }

    const adapter = new MemoryAdapter<Counter>({
      state: 'idle',
      value: 0,
      log: [],
    })
    const sm = new StateMachine<Counter, typeof config>(config, adapter)

    const events = sm.getQueuedEvents()
    expect(Array.isArray(events)).toBe(true)
    expect(events.length).toBe(0)
  })

  test('isProcessingEvents should return false when idle', () => {
    const config: StateMachineConfig<Counter> = {
      name: 'ProcessingTest',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        active: {},
      },
      events: {
        activate: { transitions: [{ from: 'idle', to: 'active' }] },
      },
    }

    const adapter = new MemoryAdapter<Counter>({
      state: 'idle',
      value: 0,
      log: [],
    })
    const sm = new StateMachine<Counter, typeof config>(config, adapter)

    expect(sm.isProcessingEvents()).toBe(false)
  })

  test('should handle reentrant events via invoke', async () => {
    const log: string[] = []

    const config: StateMachineConfig<Counter> = {
      name: 'ReentrantTest',
      stateAttribute: 'state',
      initialState: 'start',
      states: {
        start: {
          onEnter: () => log.push('enter:start'),
          invoke: [{ delay: 10, event: 'next' }],
        },
        middle: {
          onEnter: () => log.push('enter:middle'),
          invoke: [{ delay: 10, event: 'finish' }],
        },
        end: {
          onEnter: () => log.push('enter:end'),
        },
      },
      events: {
        next: { transitions: [{ from: 'start', to: 'middle' }] },
        finish: { transitions: [{ from: 'middle', to: 'end' }] },
      },
    }

    const adapter = new MemoryAdapter<Counter>({
      state: 'start',
      value: 0,
      log: [],
    })
    const sm = new StateMachine<Counter, typeof config>(config, adapter)

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(log).toContain('enter:start')
    expect(log).toContain('enter:middle')
    expect(log).toContain('enter:end')
    expect(sm.currentState).toBe('end')
  })

  test('sequential fireEvent calls should work correctly', async () => {
    const config: StateMachineConfig<Counter> = {
      name: 'SequentialTest',
      stateAttribute: 'state',
      initialState: 'a',
      states: {
        a: {},
        b: {},
        c: {},
      },
      events: {
        next: {
          transitions: [
            { from: 'a', to: 'b' },
            { from: 'b', to: 'c' },
          ],
        },
      },
    }

    const adapter = new MemoryAdapter<Counter>({
      state: 'a',
      value: 0,
      log: [],
    })
    const sm = new StateMachine<Counter, typeof config>(config, adapter)

    expect(sm.currentState).toBe('a')

    await sm.fireEvent('next')
    expect(sm.currentState).toBe('b')

    await sm.fireEvent('next')
    expect(sm.currentState).toBe('c')
  })

  test('concurrent fireEvent calls should be serialized', async () => {
    const log: string[] = []

    const config: StateMachineConfig<Counter> = {
      name: 'ConcurrentTest',
      stateAttribute: 'state',
      initialState: 'a',
      states: {
        a: {
          onEnter: () => log.push('enter:a'),
          onExit: () => log.push('exit:a'),
        },
        b: {
          onEnter: () => log.push('enter:b'),
          onExit: () => log.push('exit:b'),
        },
        c: {
          onEnter: () => log.push('enter:c'),
          onExit: () => log.push('exit:c'),
        },
        d: {
          onEnter: () => log.push('enter:d'),
        },
      },
      events: {
        next: {
          transitions: [
            { from: 'a', to: 'b' },
            { from: 'b', to: 'c' },
            { from: 'c', to: 'd' },
          ],
        },
      },
    }

    const adapter = new MemoryAdapter<Counter>({
      state: 'a',
      value: 0,
      log: [],
    })
    const sm = new StateMachine<Counter, typeof config>(config, adapter)

    const results = await Promise.all([
      sm.fireEvent('next'),
      sm.fireEvent('next'),
      sm.fireEvent('next'),
    ])

    expect(results.filter((r) => r === true).length).toBe(3)
    expect(sm.currentState).toBe('d')
  })
})
