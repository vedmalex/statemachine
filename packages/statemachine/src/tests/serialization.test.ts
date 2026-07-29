import { describe, expect, it, vi } from 'vitest'
import { StateMachine } from '../state_machine'
import {
  type Events,
  ExtractAdaptee,
  MemoryAdapter,
  ServerAdapter,
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
} satisfies Events<Person, typeof states>

const SMC = {
  name: 'Person',
  initialState: 'inUtro',
  stateAttribute: 'state',
  states,
  events,
} satisfies StateMachineConfig<Person>

describe('StateMachine Serialization/Deserialization', () => {
  it('should serialize and deserialize a simple state machine', () => {
    const sm = new StateMachine(SMC)
    const serializedSM = sm.toJSON()
    // W0: functions restore by NAME from a consumer registry. The `born`
    // event's `onAfter: (root, fn) => fn(root)` serializes under its inferred
    // name 'onAfter'; supply it so restoration resolves the reference.
    const deserializedSM = StateMachine.fromJSON<Person, typeof SMC>(
      serializedSM,
      undefined,
      { actions: { onAfter: (root: any, fn: any) => fn(root) } },
    )
    expect(deserializedSM.getCurrentState()).toBe(sm.getCurrentState())
    expect(deserializedSM.initialState).toBe(sm.initialState)
    expect(deserializedSM.stateAttribute).toBe(sm.stateAttribute)
    expect(deserializedSM.states.size).toBe(sm.states.size)
    expect(deserializedSM.events.size).toBe(sm.events.size)
  })

  it('should serialize and deserialize a state machine with actions', async () => {
    globalThis.$times = 0
    const actionFn = () => {
      console.log('here')
      globalThis.$times += 1
    }

    const actionStates = {
      state1: {},
      state2: {},
    } satisfies States<Person>

    const actionEvents = {
      event1: {
        transitions: [{ from: 'state1', to: 'state2' }],
        onAfter: actionFn,
      },
    } satisfies Events<Person, typeof actionStates>

    const actionSMC = {
      name: 'ActionSM',
      initialState: 'state1',
      stateAttribute: 'state',
      states: actionStates,
      events: actionEvents,
    } satisfies StateMachineConfig<Person>

    const person = new MemoryAdapter<Person>({
      name: 'Someone',
      state: '',
      event: actionFn,
    })
    const sm = new StateMachine(actionSMC, person)

    const serializedSM = sm.toJSON()

    // Create a new adapter for the deserialized state machine
    const newPerson = new MemoryAdapter<Person>({
      name: 'Someone',
      state: '',
      event: actionFn,
    })

    // W0: `onAfter: actionFn` serializes as a name reference ('actionFn').
    // Restoration resolves it from the supplied registry — the body is never
    // recompiled — and firing the event runs the real function.
    const deserializedSM = StateMachine.fromJSON<Person, typeof actionSMC>(
      serializedSM,
      newPerson,
      { actions: { actionFn } },
    )

    expect(deserializedSM.getCurrentState()).toBe(sm.getCurrentState())

    await deserializedSM.fireEvent('event1')
    expect(globalThis.$times).toBe(1) // only onAfter should call action
  })

  it('should serialize and deserialize a hierarchical state machine with regions', async () => {
    const states = {
      parentState: {
        display: 'Родительское состояние',
        initial: 'region1.childState1|region2.childState1', // Начальное состояние для parentState
        regions: {
          // Используем regions вместо states
          region1: {
            // Внутри региона states как раньше
            childState1: {
              display: 'Дочернее состояние 1',
            },
            childState2: {
              display: 'Дочернее состояние 2',
            },
          },
          region2: {
            // Внутри региона states как раньше
            childState1: {
              display: 'Дочернее состояние 2',
            },
            childState2: {
              display: 'Дочернее состояние 2',
            },
          },
        },
      },
      state1: {
        display: 'Состояние 1',
      },
      state2: {
        display: 'Состояние 2',
      },
    } satisfies States<Person>

    type PersonStates = typeof states

    const events = {
      toChild2: {
        display: 'Перейти в Дочернее 2',
        transitions: [
          {
            from: 'parentState.region1.childState1',
            to: 'parentState.region1.childState2',
          },
        ],
      },
      toState1: {
        display: 'Перейти в Состояние 1',
        transitions: [
          { from: 'parentState.region1.childState2', to: 'state1' },
        ],
      },
      toParentChild1: {
        display: 'Перейти в Parent.Child1',
        transitions: [
          // A transition into the bare-root composite 'parentState' expands its
          // regions to their initial leaves (SCXML/UML D1). NOTE: this transition
          // is declared for config shape only — it is not fired in this test body.
          { from: 'state1', to: 'parentState' },
        ],
      },
    } satisfies Events<Person, PersonStates>

    const SMC_HIERARCHICAL_REGIONS = {
      // Переименована конфигурация
      name: 'PersonHierarchicalRegions',
      initialState: 'parentState',
      stateAttribute: 'state',
      states,
      events,
    } satisfies StateMachineConfig<Person>
    const person = new MemoryAdapter<Person>({
      name: 'Someone',
      state: '',
      event: () => null,
    })
    //@ts-ignore
    const sm = new StateMachine(SMC_HIERARCHICAL_REGIONS, person)
    await sm.fireEvent('toChild2')

    const serializedSM = sm.toJSON()
    const deserializedSM = StateMachine.fromJSON<
      Person,
      //@ts-ignore
      typeof SMC_HIERARCHICAL_REGIONS
    >(serializedSM, person)

    expect(deserializedSM.getCurrentState()).toBe(sm.getCurrentState())
    //@ts-ignore
    expect(deserializedSM.initialState).toBe(sm.initialState)
    //@ts-ignore
    expect(deserializedSM.stateAttribute).toBe(sm.stateAttribute)
    //@ts-ignore
    expect(deserializedSM.states.size).toBe(sm.states.size)
    //@ts-ignore
    expect(deserializedSM.events.size).toBe(sm.events.size)

    await deserializedSM.fireEvent('toState1')
    expect(deserializedSM.getCurrentState()).toBe('state1')
  })

  it('should serialize and deserialize a state machine with deep history', async () => {
    const robot = new MemoryAdapter({ state: '', event: () => null })
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
              history: 'deep',
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

    const SMC_DEEP_HISTORY_SERIALIZE = {
      name: 'VacuumRobotDeepHistory',
      initialState: 'robot',
      stateAttribute: 'state',
      states,
      events,
    } satisfies StateMachineConfig<ExtractAdaptee<typeof robot>>
    const sm = new StateMachine(SMC_DEEP_HISTORY_SERIALIZE, robot)

    await sm.fireEvent('startEngine')
    await sm.fireEvent('activateSensors')
    await sm.fireEvent('startAuto')
    await sm.fireEvent('startCleaning')
    await sm.fireEvent('stop')

    const serializedSM = sm.toJSON()
    const deserializedSM = StateMachine.fromJSON<
      any,
      typeof SMC_DEEP_HISTORY_SERIALIZE
    >(serializedSM, robot)

    expect(deserializedSM.getCurrentState()).toBe(sm.getCurrentState())
    await deserializedSM.fireEvent('resumeAuto')
    expect(deserializedSM.getCurrentState()).toBe(
      'robot.engine.on|robot.sensors.on|robot.mode.auto.task.cleaning',
    )
  })

  it('should round-trip a state reached via transition-into-bare-root composite (preserves expanded string, re-arms region timers)', async () => {
    // T13 (D1/D6): a transition into a BARE-ROOT composite now expands its
    // regions to the initial leaves (SCXML/UML), so the stored string is the
    // expanded '|' composite. Serialization is a verbatim pass-through, so the
    // expanded string MUST survive a toJSON/fromJSON round-trip, and restore
    // (resumeTimers) must re-arm one invoke timer per active region leaf — both
    // region leaves' invoke-driven transitions fire on the restored machine.
    const states = {
      idle: { display: 'Idle' },
      box: {
        display: 'Box',
        initial: 'scan.scanning|poll.polling',
        regions: {
          scan: {
            scanning: {
              display: 'Scanning',
              invoke: [{ delay: 50, event: 'scanDone' }],
            },
            done: { display: 'Scan done' },
          },
          poll: {
            polling: {
              display: 'Polling',
              invoke: [{ delay: 50, event: 'pollDone' }],
            },
            done: { display: 'Poll done' },
          },
        },
      },
    } satisfies States<any>

    const events = {
      enterBox: {
        display: 'Enter Box',
        // Bare-root composite target -> regions expand on this transition.
        transitions: [{ from: 'idle', to: 'box' }],
      },
      scanDone: {
        display: 'Scan finished',
        transitions: [{ from: 'box.scan.scanning', to: 'box.scan.done' }],
      },
      pollDone: {
        display: 'Poll finished',
        transitions: [{ from: 'box.poll.polling', to: 'box.poll.done' }],
      },
    } satisfies Events<any, typeof states>

    const SMC_BARE_ROOT_COMPOSITE = {
      name: 'BareRootCompositeRoundTrip',
      initialState: 'idle',
      stateAttribute: 'state',
      states,
      events,
    } satisfies StateMachineConfig<any>

    const owner = new MemoryAdapter({ state: '', event: () => null })
    const sm = new StateMachine(SMC_BARE_ROOT_COMPOSITE, owner)

    // Reach the composite via a transition (NOT as the initial state).
    await sm.fireEvent('enterBox')
    const reached = sm.getCurrentState()
    // The bare-root transition expanded into the parallel '|' composite.
    expect(reached?.split('|').sort()).toEqual(
      ['box.poll.polling', 'box.scan.scanning'].sort(),
    )

    // Serialize from the expanded, timers-armed config and rehydrate into a
    // fresh owner BEFORE the original machine's timers fire.
    const serializedSM = sm.toJSON()
    const restoreOwner = new MemoryAdapter({ state: '', event: () => null })
    const deserializedSM = StateMachine.fromJSON<
      any,
      typeof SMC_BARE_ROOT_COMPOSITE
    >(serializedSM, restoreOwner)

    // The expanded string survives the round-trip verbatim (order-insensitive).
    expect(deserializedSM.getCurrentState()?.split('|').sort()).toEqual(
      reached?.split('|').sort(),
    )

    // resumeTimers re-armed one invoke timer per active region leaf: after the
    // delay both region invoke-events fire and each region advances to done.
    await new Promise((r) => setTimeout(r, 120))
    expect(deserializedSM.getCurrentState()?.split('|').sort()).toEqual(
      ['box.poll.done', 'box.scan.done'].sort(),
    )
  })
})

describe('StateMachine.fromData', () => {
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

  it('should create a StateMachine instance from data and initialize state', async () => {
    const sm = StateMachine.fromData(config)

    expect(sm).toBeInstanceOf(StateMachine)
  })

  it('should correctly fire event after creation from data', async () => {
    const dataState = 'off'
    const person = new MemoryAdapter({ state: dataState, event: () => null })
    const sm = StateMachine.fromData(config, dataState, person)

    expect(sm.getCurrentState()).toBe(dataState)
    await sm.fireEvent('switchOn')
    expect(sm.getCurrentState()).toBe('on')
  })
})
