/**
 * Edge Cases Tests for StateMachine
 * TDD-based tests for timeout, state visibility, and zombie prevention
 */

import { describe, expect, it, beforeEach } from 'vitest'
import { StateMachine } from '../state_machine'
import { type Adapter, MemoryAdapter, type StateMachineConfig, StateMachineError } from '../types'

// Helper function
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

interface TestEntity {
  state: string
  data?: string
}

describe('Edge Cases: Transition Timeout', () => {
  it('should timeout if onEnter hangs beyond limit', async () => {
    const config: StateMachineConfig<TestEntity> = {
      name: 'TimeoutTest',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        loading: {
          onEnter: () => new Promise(() => { }) // Never resolves
        }
      },
      events: {
        start: { transitions: [{ from: 'idle', to: 'loading' }] }
      }
    }

    const adapter = new MemoryAdapter<TestEntity>({ state: 'idle' })
    const sm = new StateMachine<TestEntity, typeof config>(config, adapter, { transitionTimeout: 100 })

    await expect(sm.fireEvent('start')).rejects.toThrow(/[Tt]imeout/)
  })

  it('should complete normally if action finishes in time', async () => {
    const config: StateMachineConfig<TestEntity> = {
      name: 'TimeoutSuccessTest',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        ready: {
          onEnter: async () => { await delay(10) }
        }
      },
      events: {
        go: { transitions: [{ from: 'idle', to: 'ready' }] }
      }
    }

    const adapter = new MemoryAdapter<TestEntity>({ state: 'idle' })
    const sm = new StateMachine<TestEntity, typeof config>(config, adapter, { transitionTimeout: 1000 })

    await expect(sm.fireEvent('go')).resolves.toBe(true)
    expect(sm.currentState).toBe('ready')
  })

  it('should timeout if onExit hangs beyond limit', async () => {
    const config: StateMachineConfig<TestEntity> = {
      name: 'ExitTimeoutTest',
      stateAttribute: 'state',
      initialState: 'active',
      states: {
        active: {
          onExit: () => new Promise(() => { }) // Never resolves
        },
        done: {}
      },
      events: {
        finish: { transitions: [{ from: 'active', to: 'done' }] }
      }
    }

    const adapter = new MemoryAdapter<TestEntity>({ state: 'active' })
    const sm = new StateMachine<TestEntity, typeof config>(config, adapter, { transitionTimeout: 100 })

    await expect(sm.fireEvent('finish')).rejects.toThrow(/[Tt]imeout/)
  })
})

describe('Edge Cases: Transition State Visibility', () => {
  it('should expose isTransitioning flag during transition', async () => {
    let capturedDuringEnter = false
    let capturedDuringExit = false
    let smRef: StateMachine<TestEntity, any>

    const config: StateMachineConfig<TestEntity> = {
      name: 'TransitioningFlagTest',
      stateAttribute: 'state',
      initialState: 'a',
      states: {
        a: {
          onExit: async function () {
            capturedDuringExit = (smRef as any).isTransitioning ?? false
          }
        },
        b: {
          onEnter: async function () {
            capturedDuringEnter = (smRef as any).isTransitioning ?? false
          }
        }
      },
      events: {
        go: { transitions: [{ from: 'a', to: 'b' }] }
      }
    }

    const adapter = new MemoryAdapter<TestEntity>({ state: 'a' })
    const sm = new StateMachine<TestEntity, typeof config>(config, adapter)
    smRef = sm

    // Before transition
    expect((sm as any).isTransitioning).toBe(false)

    await sm.fireEvent('go')

    // After transition
    expect((sm as any).isTransitioning).toBe(false)

    // Verify captured values
    expect(capturedDuringExit).toBe(true)
    expect(capturedDuringEnter).toBe(true)
  })

  it('should expose targetState during transition', async () => {
    let capturedTarget: string | undefined
    let smRef: StateMachine<TestEntity, any>

    const config: StateMachineConfig<TestEntity> = {
      name: 'TargetStateTest',
      stateAttribute: 'state',
      initialState: 'a',
      states: {
        a: {
          onExit: function () {
            capturedTarget = (smRef as any).targetState
          }
        },
        b: {}
      },
      events: {
        go: { transitions: [{ from: 'a', to: 'b' }] }
      }
    }

    const adapter = new MemoryAdapter<TestEntity>({ state: 'a' })
    const sm = new StateMachine<TestEntity, typeof config>(config, adapter)
    smRef = sm

    await sm.fireEvent('go')

    expect(capturedTarget).toBe('b')
    expect((sm as any).targetState).toBeUndefined() // Should be cleared after transition
  })
})

describe('Edge Cases: Zombie State Prevention', () => {
  it('should transition to error state if onEnter fails after onExit', async () => {
    let exitCalled = false

    const config: StateMachineConfig<TestEntity> = {
      name: 'ZombiePreventionTest',
      stateAttribute: 'state',
      initialState: 'a',
      states: {
        a: {
          onExit: () => { exitCalled = true }
        },
        b: {
          onEnter: () => { throw new Error('onEnter boom') }
        },
        error: {}
      },
      events: {
        go: { transitions: [{ from: 'a', to: 'b' }] }
      }
    }

    const adapter = new MemoryAdapter<TestEntity>({ state: 'a' })
    const sm = new StateMachine<TestEntity, typeof config>(config, adapter, { errorState: 'error' })

    // Should NOT throw, should transition to error state
    const result = await sm.fireEvent('go')

    expect(exitCalled).toBe(true)
    expect(sm.currentState).toBe('error') // NOT 'a' - zombie prevention
  })

  it('should stay in source state if onExit fails (no side effects yet)', async () => {
    let enterCalled = false

    const config: StateMachineConfig<TestEntity> = {
      name: 'ExitFailureTest',
      stateAttribute: 'state',
      initialState: 'a',
      states: {
        a: {
          onExit: () => { throw new Error('onExit failed') }
        },
        b: {
          onEnter: () => { enterCalled = true }
        }
      },
      events: {
        go: { transitions: [{ from: 'a', to: 'b' }] }
      }
    }

    const adapter = new MemoryAdapter<TestEntity>({ state: 'a' })
    const sm = new StateMachine<TestEntity, typeof config>(config, adapter, { abortOnExitError: true })

    const result = await sm.fireEvent('go')

    expect(result).toBe(false)
    expect(sm.currentState).toBe('a')
    expect(enterCalled).toBe(false) // onEnter should NOT have been called
  })

  it('should reject if onEnter fails and no errorState configured (new behavior)', async () => {
    const config: StateMachineConfig<TestEntity> = {
      name: 'NoErrorStateTest',
      stateAttribute: 'state',
      initialState: 'a',
      states: {
        a: {},
        b: { onEnter: () => { throw new Error('boom') } }
      },
      events: {
        go: { transitions: [{ from: 'a', to: 'b' }] }
      }
    }

    const adapter = new MemoryAdapter<TestEntity>({ state: 'a' })
    const sm = new StateMachine<TestEntity, typeof config>(config, adapter) // No errorState option

    // New behavior: propagates error instead of swallowing
    await expect(sm.fireEvent('go')).rejects.toThrow('boom')

    // State remains in 'a'
    expect(sm.currentState).toBe('a')
  })
})

describe('Edge Cases: Queue Saturation Under Load', () => {
  it('should reject events when queue is full during slow transition', async () => {
    const config: StateMachineConfig<TestEntity> = {
      name: 'QueueSaturationTest',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        processing: {
          onEnter: async () => { await delay(500) } // Slow
        }
      },
      events: {
        process: { transitions: [{ from: 'idle', to: 'processing' }] },
        ping: { transitions: [{ from: 'processing', to: 'processing' }] }
      }
    }

    const adapter = new MemoryAdapter<TestEntity>({ state: 'idle' })
    const sm = new StateMachine<TestEntity, typeof config>(config, adapter, { maxQueueDepth: 5 })

    // Start slow transition
    const slowTransition = sm.fireEvent('process')

    // Flood with events
    const floodPromises = Array(10).fill(null).map(() =>
      sm.fireEvent('ping').catch(e => e)
    )

    const results = await Promise.all(floodPromises)
    const overflowErrors = results.filter(r => r instanceof Error && r.message.includes('overflow'))

    // Some should have been rejected
    expect(overflowErrors.length).toBeGreaterThan(0)

    await slowTransition
  })
})
