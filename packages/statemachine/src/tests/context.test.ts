import { describe, expect, it, vi } from 'vitest'
import { StateMachine } from '../state_machine'
import {
  type Events,
  MemoryAdapter,
  type StateMachineConfig,
  type States,
} from '../types'

describe('StateMachine Context', () => {
  it('should use context for actions if context is set', async () => {
    const actionFromContext = vi.fn()
    const actionFromAdaptee = vi.fn()

    const states = {
      state1: {},
      state2: {},
    } satisfies States<any>

    const events = {
      event1: {
        transitions: [{ from: 'state1', to: 'state2' }],
        onAfter: 'actionInContext',
      },
    } satisfies Events<any, typeof states>

    const config = {
      name: 'ContextTestSM',
      initialState: 'state1',
      stateAttribute: 'state',
      states,
      events,
    } satisfies StateMachineConfig<any>

    const adaptee = new MemoryAdapter({
      state: 'state1',
      actionInContext: actionFromAdaptee,
    })
    const context = {
      actionInContext: actionFromContext,
    }

    const sm = new StateMachine(config, adaptee)
    sm.setContext(context)

    await sm.fireEvent('event1')

    expect(actionFromContext).toHaveBeenCalledTimes(1)
    expect(actionFromAdaptee).not.toHaveBeenCalled()
  })

  it('should serialize and deserialize state machine with context actions', async () => {
    const actionFromContext = vi.fn()

    const contextActionsSMConfig = {
      name: 'ContextActionsSM',
      initialState: 'state1',
      stateAttribute: 'state',
      states: { state1: {}, state2: {} },
      events: {
        event1: {
          transitions: [{ from: 'state1', to: 'state2' }],
          onAfter: 'actionInContext',
        },
      } satisfies Events<any, States<any>>,
    } satisfies StateMachineConfig<any>

    const adaptee = new MemoryAdapter({ state: 'state1' })
    const context = { actionInContext: actionFromContext }
    const sm = new StateMachine(contextActionsSMConfig, adaptee)
    sm.setContext(context)

    const serializedSM = sm.toJSON()
    const deserializedSM = StateMachine.fromJSON<
      any,
      typeof contextActionsSMConfig
    >(serializedSM, context)
    await sm.fireEvent('event1')
    await deserializedSM.fireEvent('event1')

    expect(actionFromContext).toHaveBeenCalledTimes(2) // Once for original, once for deserialized
  })
})

describe('StateMachine Context Error Handling', () => {
  it('should use context for error handlers if context is set', async () => {
    const errorHandlerFromContext = vi.fn()

    const states = {
      state1: {},
      state2: {},
    } satisfies States<any>

    const events = {
      eventWithError: {
        transitions: [{ from: 'state1', to: 'state2' }],
        onError: 'errorHandlerInContext',
        onAfter: () => {
          throw new Error('Simulated error in onAfter')
        },
      },
    } satisfies Events<any, typeof states>

    const config = {
      name: 'ContextErrorHandlingSM',
      initialState: 'state1',
      stateAttribute: 'state',
      states,
      events,
    } satisfies StateMachineConfig<any>

    const adaptee = new MemoryAdapter({
      state: 'state1',
    })
    const context = {
      errorHandlerInContext: errorHandlerFromContext,
    }

    const sm = new StateMachine(config, adaptee)
    sm.setContext(context)

    await sm.fireEvent('eventWithError').catch(() => {
      /* Catch expected error */
    })

    expect(errorHandlerFromContext).toHaveBeenCalledTimes(1)
  })
})
