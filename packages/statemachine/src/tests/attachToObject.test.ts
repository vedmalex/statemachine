import { describe, expect, it, vi } from 'vitest'
import { StateMachine } from '../state_machine'
import {
  type Events,
  MemoryAdapter,
  type StateMachineConfig,
  type States,
} from '../types'

describe('StateMachine attachToObject', () => {
  const states = {
    off: { display: 'Off' },
    on: { display: 'On' },
  } satisfies States<any>

  const events = {
    switchOn: { transitions: [{ from: 'off', to: 'on' }] },
    switchOff: { transitions: [{ from: 'on', to: 'off' }] },
  } satisfies Events<any, typeof states>

  const config = {
    name: 'Switcher',
    initialState: 'off',
    stateAttribute: 'state',
    states,
    events,
  } satisfies StateMachineConfig<any>

  it('should attach to a simple object and react to events', async () => {
    const obj = { state: 'off', value: false }
    const sm = new StateMachine(config, new MemoryAdapter(obj))
    const eventMap = {
      on: 'switchOn',
      off: 'switchOff',
    }

    sm.attachToObject(obj, eventMap)

    expect(sm.getCurrentState()).toBe('off')

    // Simulate object event 'on'
    if (typeof obj.on === 'function') {
      obj.on('on') // Assuming 'on' is an event emitter method
    } else if (typeof obj[`onon`] === 'function') {
      obj[`onon`]() // Assuming 'onon' is an event handler property
    } else {
      // Simulate direct call if no event mechanism
      if (typeof obj[`on`] === 'function') obj[`on`]()
    }

    await new Promise((resolve) => setTimeout(resolve, 10)) // Wait for event to be processed
    expect(sm.getCurrentState()).toBe('on')
    // Simulate object event 'off'
    if (typeof obj.on === 'function') {
      obj.on('off') // Assuming 'off' is an event emitter method
    } else if (typeof obj[`onoff`] === 'function') {
      obj[`onoff`]() // Assuming 'onoff' is an event handler property
    } else {
      // Simulate direct call if no event mechanism
      if (typeof obj[`off`] === 'function') obj[`off`]()
    }
    await new Promise((resolve) => setTimeout(resolve, 10)) // Wait for event to be processed
    expect(sm.getCurrentState()).toBe('off')
  })

  it('should attach to an EventEmitter-like object with addEventListener', async () => {
    const emitter = {
      state: 'off',
      _listeners: {},
      addEventListener: function (eventName, handler) {
        this._listeners[eventName] = this._listeners[eventName] || []
        this._listeners[eventName].push(handler)
      },
      dispatchEvent: function (eventName, detail?) {
        if (this._listeners[eventName]) {
          this._listeners[eventName].forEach((handler) =>
            handler({ type: eventName, detail }),
          )
        }
      },
    }
    const sm = new StateMachine(config, new MemoryAdapter(emitter))
    const eventMap = {
      switchon: 'switchOn',
      switchoff: 'switchOff',
    }
    sm.attachToObject(emitter, eventMap)

    expect(sm.getCurrentState()).toBe('off')

    emitter.dispatchEvent('switchon')
    await new Promise((resolve) => setTimeout(resolve, 10)) // Wait for event to be processed

    expect(sm.getCurrentState()).toBe('on')

    emitter.dispatchEvent('switchoff')
    await new Promise((resolve) => setTimeout(resolve, 10)) // Wait for event to be processed

    expect(sm.getCurrentState()).toBe('off')
  })

  it('should pass event arguments from object to fireEvent', async () => {
    const emitter = {
      state: 'off',
      _listeners: {},
      addEventListener: function (eventName, handler) {
        this._listeners[eventName] = this._listeners[eventName] || []
        this._listeners[eventName].push(handler)
      },
      dispatchEvent: function (eventName, ...args) {
        if (this._listeners[eventName]) {
          this._listeners[eventName].forEach((handler) => handler(...args))
        }
      },
    }
    const sm = new StateMachine(config, new MemoryAdapter(emitter))
    const eventMap = {
      switchon: 'switchOn',
    }
    const mockFireEvent = vi.spyOn(sm, 'fireEvent')
    sm.attachToObject(emitter, eventMap)

    emitter.dispatchEvent('switchon', 'arg1', 123)
    await new Promise((resolve) => setTimeout(resolve, 10)) // Wait for event to be processed
    expect(mockFireEvent).toHaveBeenCalledWith('switchOn', emitter, 'arg1', 123)
  })
})
