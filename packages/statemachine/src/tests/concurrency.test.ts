import { describe, expect, test } from 'vitest'
import { StateMachine } from '../state_machine'
import { MemoryAdapter, type StateMachineConfig } from '../types'

interface TrafficLight {
  state: string
  count: number
}

// Synchronous onEnter that simply counts entries. No real setTimeout: the
// run-to-completion queue serialization is what these tests exercise, not wall
// time, so the previous sleep-in-onEnter pattern is removed.
const config: StateMachineConfig<TrafficLight> = {
  name: 'TrafficLight',
  stateAttribute: 'state',
  initialState: 'green',
  states: {
    green: {
      onEnter: (owner: TrafficLight) => {
        owner.count++
      },
    },
    yellow: {
      onEnter: (owner: TrafficLight) => {
        owner.count++
      },
    },
    red: {
      onEnter: (owner: TrafficLight) => {
        owner.count++
      },
    },
  },
  events: {
    next: {
      transitions: [
        { from: 'green', to: 'yellow' },
        { from: 'yellow', to: 'red' },
        { from: 'red', to: 'green' },
      ],
    },
  },
}

describe('Concurrency Tests', () => {
  test('Should handle concurrent fireEvent calls gracefully', async () => {
    const adapter = new MemoryAdapter<TrafficLight>({
      state: 'green',
      count: 0,
    })
    const sm = new StateMachine<TrafficLight, typeof config>(config, adapter)

    // Fire three events concurrently. The run-to-completion queue serializes
    // them, so they apply in order: green -> yellow -> red -> green.
    const results = await Promise.allSettled([
      sm.fireEvent('next'),
      sm.fireEvent('next'),
      sm.fireEvent('next'),
    ])

    // All three are accepted (no rejection / dropped event).
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
    const successes = results.filter(
      (r) => r.status === 'fulfilled' && r.value === true,
    ).length
    expect(successes).toBe(3)

    // Three serialized transitions cycle back to green.
    expect(sm.currentState).toBe('green')
    // onEnter fires once on initial entry to `green` plus once per accepted
    // transition (green->yellow->red->green) = 1 + 3 = 4.
    expect(adapter.adaptee.count).toBe(4)
  })

  test('Race condition on same transition', async () => {
    const adapter = new MemoryAdapter<TrafficLight>({
      state: 'green',
      count: 0,
    })
    const sm = new StateMachine<TrafficLight, typeof config>(config, adapter)

    // Two events fired "simultaneously" against the same start state. Queue
    // serialization means BOTH are honored sequentially (green->yellow->red),
    // not that one is dropped — assert the deterministic serialized outcome.
    const p1 = sm.fireEvent('next')
    const p2 = sm.fireEvent('next')

    const [r1, r2] = await Promise.all([p1, p2])

    expect(r1).toBe(true)
    expect(r2).toBe(true)
    // Exactly two transitions applied: green -> yellow -> red.
    expect(sm.currentState).toBe('red')
    // onEnter fires once on initial entry to `green` plus once per accepted
    // transition (green->yellow->red) = 1 + 2 = 3.
    expect(adapter.adaptee.count).toBe(3)
  })

  test('Async Action Serialization Integrity', async () => {
    const secureConfig: StateMachineConfig<TrafficLight> = {
      ...config,
      states: {
        ...config.states,
        green: {
          onEnter: async (owner: TrafficLight) => {
            owner.count += 10
          },
        },
      },
    }

    const adapter = new MemoryAdapter<TrafficLight>({
      state: 'green',
      count: 0,
    })
    const sm = new StateMachine<TrafficLight, typeof secureConfig>(
      secureConfig,
      adapter,
    )

    const json = await sm.toSecureJSON()
    // W0: functions are serialized as body-free NAME references — no compilable
    // body and no keyless hash survive serialization. `green.onEnter` serializes
    // under its inferred name 'onEnter'.
    expect(json).not.toContain('"hash":')
    expect(json).not.toContain('"body":')
    expect(json).toContain('"type":"function"')
    expect(json).toContain('"name":"onEnter"')

    const sm2 = await StateMachine.fromSecureJSON(
      json,
      new MemoryAdapter({ state: 'green', count: 0 }),
      {
        actions: {
          onEnter: async (owner: TrafficLight) => {
            owner.count += 10
          },
        },
      },
    )
    expect(sm2).toBeDefined()
    expect(sm2.currentState).toBe('green')
  })
})
