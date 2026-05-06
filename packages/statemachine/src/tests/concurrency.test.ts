import { describe, expect, test } from 'vitest'
import { StateMachine } from '../state_machine'
import { MemoryAdapter, type StateMachineConfig } from '../types'

interface TrafficLight {
  state: string
  count: number
}

const config: StateMachineConfig<TrafficLight> = {
  name: 'TrafficLight',
  stateAttribute: 'state',
  initialState: 'green',
  states: {
    green: {
      onEnter: async (owner: TrafficLight) => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        owner.count++
      },
    },
    yellow: {
      onEnter: async (owner: TrafficLight) => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        owner.count++
      },
    },
    red: {
      onEnter: async (owner: TrafficLight) => {
        await new Promise((resolve) => setTimeout(resolve, 10))
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

    const results = await Promise.allSettled([
      sm.fireEvent('next'),
      sm.fireEvent('next'),
      sm.fireEvent('next'),
    ])

    const successes = results.filter(
      (r) => r.status === 'fulfilled' && r.value === true,
    ).length

    console.log(`Concurrent transitions success count: ${successes}`)
    console.log(`Final state: ${sm.currentState}`)
    console.log(`Transition count: ${adapter.adaptee.count}`)

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
  })

  test('Race condition on same transition', async () => {
    const adapter = new MemoryAdapter<TrafficLight>({
      state: 'green',
      count: 0,
    })
    const sm = new StateMachine<TrafficLight, typeof config>(config, adapter)

    const p1 = sm.fireEvent('next')
    const p2 = sm.fireEvent('next')

    const [r1, r2] = await Promise.all([p1, p2])

    console.log(`Race results: ${r1}, ${r2}`)
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
    expect(json).toContain('"hash":')

    const sm2 = await StateMachine.fromSecureJSON(
      json,
      new MemoryAdapter({ state: 'green', count: 0 }),
    )
    expect(sm2).toBeDefined()
    expect(sm2.currentState).toBe('green')
  })
})
