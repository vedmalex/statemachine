import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StateMachine } from '../state_machine'
import {
  type Events,
  type ExtractAdaptee,
  LocalStorageAdapter,
  MemoryAdapter,
  ServerAdapter,
  SessionStorageAdapter,
  type StateMachineConfig,
  type States,
} from '../types'

import './mocks'

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
} satisfies Events<Person, typeof states>

describe('StateMachine persistence', () => {
  const personConfig = {
    name: 'Person',
    initialState: 'inUtro',
    stateAttribute: 'state',
    states,
    events,
  } satisfies StateMachineConfig<Person>

  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('should persist and restore state with MemoryAdapter', async () => {
    const person = new MemoryAdapter<Person>({
      name: 'Test',
      state: '',
      event: () => null,
    })
    const sm = new StateMachine(personConfig, person)

    const action = vi.fn()
    const action1 = vi.fn()
    person.set('event', action)

    await sm.fireEvent('born', action1)
    expect(sm.getCurrentState()).toBe('born')

    await sm.saveState()
    const sm2 = new StateMachine(personConfig, person)
    await sm2.restoreState()
    expect(sm2.getCurrentState()).toBe('born')
  })

  it('should persist and restore state with LocalStorageAdapter', async () => {
    const person = new LocalStorageAdapter<Person>(
      {
        name: 'Test',
        state: '',
        event: () => null,
      },
      'test_person',
    )
    const sm = new StateMachine(personConfig, person)

    const action = vi.fn()
    const action1 = vi.fn()
    person.set('event', action)

    await sm.fireEvent('born', action1)
    await sm.saveState()

    const sm2 = new StateMachine(
      personConfig,
      new LocalStorageAdapter<Person>(
        {
          name: 'Test',
          state: '',
          event: () => null,
        },
        'test_person',
      ),
    )
    await sm2.restoreState()
    expect(sm2.getCurrentState()).toBe('born')
  })

  it('should persist and restore state with SessionStorageAdapter', async () => {
    const person = new SessionStorageAdapter<Person>(
      {
        name: 'Test',
        state: '',
        event: () => null,
      },
      'test_person',
    )
    const sm = new StateMachine(personConfig, person)
    const action = vi.fn()
    const action1 = vi.fn()
    person.set('event', action)

    await sm.fireEvent('born', action1)
    await sm.saveState()

    const sm2 = new StateMachine(
      personConfig,
      new SessionStorageAdapter<Person>(
        {
          name: 'Test',
          state: '',
          event: () => null,
        },
        'test_person',
      ),
    )
    await sm2.restoreState()
    expect(sm2.getCurrentState()).toBe('born')
  })

  it('should persist and restore state with ServerAdapter (async)', async () => {
    const person = new ServerAdapter<Person>({
      name: 'Test',
      state: '',
      event: () => null,
    })
    const sm = new StateMachine(personConfig, person)

    const action = vi.fn()
    const action1 = vi.fn()
    person.set('event', action)

    await sm.fireEvent('born', action1)
    await sm.saveState()

    const sm2 = new StateMachine(
      personConfig,
      new ServerAdapter<Person>({
        name: 'Test',
        state: '',
        event: () => null,
      }),
    )
    await sm2.restoreState()
    expect(sm2.getCurrentState()).toBe('born')
  })

  it('should persist and restore history', async () => {
    const robot = new ServerAdapter({ state: '', event: () => null })
    const states = {
      robot: {
        display: 'Робот',
        initial: 'engine.off|sensors.off|mode.off',
        regions: {
          engine: {
            off: { display: 'Двигатель выключен' },
            on: { display: 'Двигатель включен' },
          },
          sensors: {
            off: { display: 'Датчики выключены' },
            on: { display: 'Датчики включены' },
          },
          mode: {
            off: { display: 'Режим выключен' },
            auto: {
              display: 'Автоматический режим',
              initial: 'task.scanning',
              history: 'deep', // Используем deep history
              regions: {
                task: {
                  scanning: { display: 'Сканирование' },
                  cleaning: { display: 'Уборка' },
                },
              },
            },
            manual: { display: 'Ручной режим' },
          },
        },
      },
      stopped: { display: 'Остановлен' },
    } satisfies States<any>

    const events = {
      startEngine: {
        display: 'Запустить двигатель',
        transitions: [{ from: 'robot.engine.off', to: 'robot.engine.on' }],
      },
      activateSensors: {
        display: 'Включить датчики',
        transitions: [{ from: 'robot.sensors.off', to: 'robot.sensors.on' }],
      },
      startAuto: {
        display: 'Запустить авторежим',
        transitions: [{ from: 'robot.mode.off', to: 'robot.mode.auto' }],
      },
      startCleaning: {
        display: 'Начать уборку',
        transitions: [
          {
            from: 'robot.mode.auto.task.scanning',
            to: 'robot.mode.auto.task.cleaning',
          },
        ],
      },
      stop: {
        display: 'Остановить',
        transitions: [
          { from: 'robot.mode.auto.task.cleaning', to: 'stopped' },
          { from: 'robot.mode.manual', to: 'stopped' },
        ],
      },
      resumeAuto: {
        display: 'Возобновить авторежим',
        transitions: [{ from: 'stopped', to: 'robot.mode.auto' }],
      },
    } satisfies Events<any, typeof states>

    const SMC = {
      name: 'VacuumRobotDeepHistory',
      initialState: 'robot',
      stateAttribute: 'state',
      states,
      events,
    } satisfies StateMachineConfig<ExtractAdaptee<typeof robot>>
    const sm = new StateMachine(SMC, robot)

    await sm.fireEvent('startEngine')
    await sm.fireEvent('activateSensors')
    await sm.fireEvent('startAuto')
    await sm.fireEvent('startCleaning')
    expect(sm.getCurrentState()).toBe(
      'robot.engine.on|robot.sensors.on|robot.mode.auto.task.cleaning',
    )
    await sm.saveState()
    const sm2 = new StateMachine(
      SMC,
      new ServerAdapter({ state: '', event: () => null }),
    )
    await sm2.restoreState()

    expect(sm2.getCurrentState()).toBe(
      'robot.engine.on|robot.sensors.on|robot.mode.auto.task.cleaning',
    )
    // Check if history is preserved
    await sm2.fireEvent('stop')
    await sm2.fireEvent('resumeAuto')
    expect(sm2.getCurrentState()).toBe(
      'robot.engine.on|robot.sensors.on|robot.mode.auto.task.cleaning',
    )
  })

  it('should NOT emit done.state on restore of a non-final composite config', async () => {
    // T13 (D6/D11/D12): checkCompletion runs after setInitialState/reset and
    // after each transition, but restoreState writes the persisted string
    // verbatim through setCurrentState (no enter-action / completion pass), so
    // restoring a NON-final configuration must not raise done.state.<C> and
    // must not fire the join. isDone stays false; the join target is unentered.
    const states = {
      proc: {
        display: 'Proc',
        initial: 'a.run|b.run',
        regions: {
          a: {
            run: { display: 'run' },
            done: { display: 'done', final: true },
          },
          b: {
            run: { display: 'run' },
            done: { display: 'done', final: true },
          },
        },
      },
      complete: { display: 'Complete' },
    } satisfies States<any>

    const events = {
      finishA: {
        display: 'finishA',
        transitions: [{ from: 'proc.a.run', to: 'proc.a.done' }],
      },
      // Join authored on the engine-raised completion event.
      'done.state.proc': {
        display: 'all regions final',
        transitions: [{ from: 'proc', to: 'complete' }],
      },
    }

    const SMC = {
      name: 'NonFinalRestore',
      initialState: 'proc',
      stateAttribute: 'state',
      states,
      events,
    } as any

    const owner = new ServerAdapter({ state: '', event: () => null })
    const sm = new StateMachine(SMC, owner)

    // Drive only ONE region to final -> non-final composite config.
    await sm.fireEvent('finishA')
    await new Promise((r) => setTimeout(r, 0))
    expect((sm as any).isDone('proc')).toBe(false)
    expect(sm.getCurrentState()).not.toBe('complete')
    await sm.saveState()

    // Restore onto a fresh machine + adapter.
    const sm2 = new StateMachine(
      SMC,
      new ServerAdapter({ state: '', event: () => null }),
    )
    await sm2.restoreState()
    // Allow any (erroneously) raised done.state to drain.
    await new Promise((r) => setTimeout(r, 0))

    // Non-final config restored verbatim: join did NOT fire, isDone false.
    expect(sm2.getCurrentState()?.split('|').sort()).toEqual(
      ['proc.a.done', 'proc.b.run'].sort(),
    )
    expect(sm2.getCurrentState()).not.toBe('complete')
    expect((sm2 as any).isDone('proc')).toBe(false)
  })
})
