import { createMachine, type Adapter } from '@vedmalex/statemachine'

interface Context { label: string; count: number }

// Custom Adapter<T> binding to a Map-backed object — demonstrates EP-4.
// Verified contract at types.ts:
//   get adaptee(): T
//   get(property: keyof T): T[keyof T]
//   set(property: keyof T, value: T[keyof T]): void
class MapAdapter<T extends object> implements Adapter<T> {
  private store = new Map<keyof T, T[keyof T]>()

  // adaptee returns a live snapshot of all stored properties as a plain object.
  // The internal StateMachine uses this getter for transitive spreads.
  get adaptee(): T {
    const obj = {} as T
    for (const [k, v] of this.store) {
      ;(obj as Record<keyof T, T[keyof T]>)[k] = v
    }
    return obj
  }

  get(property: keyof T): T[keyof T] {
    return this.store.get(property) as T[keyof T]
  }

  set(property: keyof T, value: T[keyof T]): void {
    this.store.set(property, value)
  }
}

const adapter = new MapAdapter<Context>()
// Pre-populate state attribute to the initial state name so the machine
// can resolve the initial state during construction.
adapter.set('label', 'idle')
adapter.set('count', 0)

// createMachine signature: createMachine(config, owner?: T | Adapter<T>, options?)
// Pass adapter as 2nd argument so lite.ts detects 'get' in owner and wires it directly.
const m = createMachine<Context>({
  name: 'counter',
  initialState: 'idle',
  stateAttribute: 'label',
  states: { idle: {}, active: {} },
  events: { start: { transitions: [{ from: 'idle', to: 'active' }] } },
}, adapter)

console.log('Custom adapter example: count =', adapter.get('count'))
console.log('Custom adapter example: currentState =', m.currentState)
