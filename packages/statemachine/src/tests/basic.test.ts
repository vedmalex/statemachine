import { StateMachine } from '../state_machine'
import {
  type Events,
  ExtractAdaptee,
  MemoryAdapter,
  type StateMachineConfig,
  type States,
} from '../types'

type Person = {
  name: string
  state: string
  event: () => void
}

const states = {
  inUtro: {
    display: 'в утробе',
  },
  born: {
    display: 'родился',
  },
  healthy: {
    display: 'здоров',
  },
  ill: {
    display: 'заболел',
  },
  dead: {
    display: 'умер',
  },
  liberated: {
    display: 'освободился',
  },
} satisfies States<Person>

type PersonStates = typeof states

const events = {
  born: {
    display: 'Родился',
    transitions: [{ from: 'inUtro', to: 'born' }],
    onBefore: 'event',
    onAfter: (root, fn) => fn(root),
  },
  sick: {
    display: 'заболел',
    transitions: [
      {
        from: 'born',
        to: 'ill',
      },
      {
        from: 'healthy',
        to: 'ill',
      },
    ],
  },
  cure: {
    display: 'вылечился',
    transitions: [{ from: 'born', to: 'healthy' }],
  },
  health: {
    display: 'здоров',
    transitions: [
      {
        from: 'born',
        to: 'healthy',
      },
    ],
  },
  dead: {
    display: 'умер',
    transitions: [
      {
        from: 'healthy',
        to: 'dead',
      },
      {
        from: 'ill',
        to: 'dead',
      },
    ],
  },
  liberate: {
    display: 'получил освобождение',
    transitions: [
      {
        from: 'ill',
        to: 'liberated',
      },
      {
        from: 'healthy',
        to: 'liberated',
      },
    ],
  },
  reborn: {
    display: 'повторное рождение',
    transitions: [
      {
        from: 'dead',
        to: 'inUtro',
      },
      {
        from: 'liberated',
        to: 'inUtro',
      },
    ],
  },
} satisfies Events<Person, PersonStates>

const SMC = {
  name: 'Person',
  initialState: 'inUtro',
  stateAttribute: 'state',
  states,
  events,
} satisfies StateMachineConfig<Person>

describe('StateMachine attache to object', () => {
  let person: any
  let sm1: any
  beforeEach(() => {
    person = new MemoryAdapter<Person>({
      name: 'Someone',
      state: '',
      event: () => null,
    })
    sm1 = new StateMachine(SMC as any, person)
  })

  it('works', async () => {
    const action = jest.fn()
    const action1 = jest.fn()
    person.set('event', action)
    await expect(sm1.fireEvent('born', action1)).resolves.toBe(true)
    await sm1.fireEvent('health')
    expect(action).toHaveBeenCalledTimes(1)
  })
  it('throws when event not possible', async () => {
    await expect(sm1.fireEvent('health')).rejects.toBeInstanceOf(Error)
  })

  it('can check and list available events', () => {
    expect(sm1.canFireEvent('born')).toBe(true)
    expect(sm1.canFireEvent('health')).toBe(false)

    const available = sm1.getAvailableEvents()
    expect(available).toContain('born')
    expect(available).not.toContain('health')
  })

  it('reset returns to initial state', async () => {
    await sm1.fireEvent('born', () => undefined)
    expect(sm1.currentState).toBe('born')
    await sm1.reset()
    expect(sm1.currentState).toBe('inUtro')
  })
})

describe('state machine as singleton', () => {
  let person: MemoryAdapter<Person>
  let personEvent = () => undefined

  beforeEach(() => {
    personEvent = jest.fn()
    person = new MemoryAdapter<Person>({
      name: 'Someone',
      state: '',
      event: personEvent,
    })
  })

  const sm2 = new StateMachine<Person, typeof SMC>(SMC)

  it('works', async () => {
    const action = jest.fn()
    expect(person.get('state')).toBe('')
    await expect(sm2.fireEvent('born', person, action)).resolves.toBe(true)
    expect(person.get('state')).toBe('born')
    await sm2.fireEvent('health', person)
    expect(person.get('state')).toBe('healthy')
    expect(action).toHaveBeenCalledTimes(1)
  })
  it('throws when event not pass params', async () => {
    await expect(sm2.fireEvent('born')).rejects.toBeInstanceOf(Error)
  })

  it('throws when event it is not possible', async () => {
    await expect(sm2.fireEvent('health', person)).rejects.toBeInstanceOf(Error)
  })
})

describe('StateMachine boolean fireEvent + history helpers', () => {
  it('returns false when all transitions are blocked by guards', async () => {
    type Owner = { state: string }

    const config = {
      name: 'Guarded',
      initialState: 'idle',
      stateAttribute: 'state',
      states: { idle: {}, done: {} },
      events: {
        go: {
          transitions: [
            {
              from: 'idle',
              to: 'done',
              guard: () => false,
            },
          ],
        },
      },
    } satisfies StateMachineConfig<Owner>

    const adapter = new MemoryAdapter<Owner>({ state: '' })
    const sm = new StateMachine<Owner, typeof config>(config, adapter)

    await expect(sm.fireEvent('go')).resolves.toBe(false)
    expect(sm.currentState).toBe('idle')
  })

  it('returns false when transition action fails', async () => {
    type Owner = { state: string }

    const config = {
      name: 'TransitionError',
      initialState: 'idle',
      stateAttribute: 'state',
      states: { idle: {}, done: {} },
      events: {
        go: {
          transitions: [{ from: 'idle', to: 'done', onTransition: 'missing' as any }],
        },
      },
    } satisfies StateMachineConfig<Owner>

    const adapter = new MemoryAdapter<Owner>({ state: '' })
    const sm = new StateMachine<Owner, typeof config>(config, adapter)

    await expect(sm.fireEvent('go')).rejects.toThrow('No action found')
    expect(sm.currentState).toBe('idle')
  })

  it('exposes history map via getStateHistory()', async () => {
    type Owner = { state: string }

    const config = {
      name: 'History',
      initialState: 'parent',
      stateAttribute: 'state',
      states: {
        parent: {
          history: 'shallow',
          regions: {
            r: {
              a: {},
              b: {},
            },
          },
        },
      },
      events: {
        switch: {
          transitions: [{ from: 'parent.r.a', to: 'parent.r.b' }],
        },
      },
    } satisfies StateMachineConfig<Owner>

    const adapter = new MemoryAdapter<Owner>({ state: '' })
    const sm = new StateMachine<Owner, typeof config>(config, adapter)

    expect(sm.currentState).toBe('parent.r.a')
    await sm.fireEvent('switch')

    const history = sm.getStateHistory()
    expect(history.parent).toBe('parent.r.a')
  })
})
