import { describe, expect, it } from 'vitest'
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
describe('StateMachine with hierarchical states using regions', () => {
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
      transitions: [{ from: 'parentState.region1.childState2', to: 'state1' }],
    },
    toParentChild1: {
      display: 'Перейти в Parent.Child1',
      transitions: [
        { from: 'state1', to: 'parentState' }, // Переход на parentState восстановит начальные состояния регионов
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

  it('should correctly transition between hierarchical states using regions', async () => {
    const person = new MemoryAdapter<Person>({
      name: 'Someone',
      state: '',
      event: () => null,
    })
    const sm = new StateMachine(SMC_HIERARCHICAL_REGIONS, person)

    expect(sm.getCurrentState()).toBe(
      'parentState.region1.childState1|parentState.region2.childState1',
    )

    await sm.fireEvent('toChild2')
    expect(sm.getCurrentState()).toBe(
      'parentState.region2.childState1|parentState.region1.childState2',
    )

    await sm.fireEvent('toState1')
    expect(sm.getCurrentState()).toBe('state1')

    await sm.fireEvent('toParentChild1')
    expect(sm.getCurrentState()).toBe('parentState')
  })

  it('should throw error for invalid transition from current state in hierarchical state machine with regions', async () => {
    // Обновлено описание теста
    const person = new MemoryAdapter<Person>({
      name: 'Someone',
      state: '',
      event: () => null,
    })
    const sm = new StateMachine(SMC_HIERARCHICAL_REGIONS, person) // Используем новую конфигурацию
    await expect(sm.fireEvent('toState1')).rejects.toThrow() // 'toState1' invalid from 'parentState.region1.childState1'
  })

  /*
    1. Параллельные состояния: управление умным домом
    Система умного дома управляет освещением и климат-контролем параллельно.
    Описание
    Освещение и Климат-контроль работают независимо, но их состояния могут быть связаны (например, выключение всего дома).

    Это пример параллельных состояний, где два процесса управляются одновременно.
  */
  it('should handle parallel states in smart home', async () => {
    const home = new MemoryAdapter<{ state: string; event: () => any }>({
      state: '',
      event: () => null,
    })

    const states = {
      home: {
        display: 'Дом',
        initial: 'lighting.off|climate.off',
        regions: {
          lighting: {
            off: { display: 'Освещение выключено' },
            on: { display: 'Освещение включено' },
          },
          climate: {
            off: { display: 'Климат выключен' },
            heating: { display: 'Обогрев' },
            cooling: { display: 'Охлаждение' },
          },
        },
      },
      off: { display: 'Всё выключено' },
    } satisfies States<typeof home>

    const events = {
      turnOnLighting: {
        display: 'Включить освещение',
        transitions: [{ from: 'home.lighting.off', to: 'home.lighting.on' }],
      },
      turnOnHeating: {
        display: 'Включить обогрев',
        transitions: [
          { from: 'home.climate.off', to: 'home.climate.heating' },
          { from: 'home.climate.cooling', to: 'home.climate.heating' },
        ],
      },
      turnOffHome: {
        display: 'Выключить дом',
        transitions: [
          { from: 'home.lighting.on', to: 'off' },
          { from: 'home.lighting.off', to: 'off' },
        ],
      },
    } satisfies Events<typeof home, typeof states>

    const SMC = {
      name: 'SmartHome',
      initialState: 'home',
      stateAttribute: 'state',
      states,
      events,
    } satisfies StateMachineConfig<ExtractAdaptee<typeof home>>

    const sm = new StateMachine(SMC, home)

    expect(sm.isInState('home.lighting.off|home.climate.off')).toBe(true)
    await sm.fireEvent('turnOnLighting')
    expect(sm.isInState('home.lighting.on|home.climate.off')).toBe(true)
    await sm.fireEvent('turnOnHeating')
    expect(sm.isInState('home.lighting.on|home.climate.heating')).toBe(true)
    await sm.fireEvent('turnOffHome')
    expect(sm.getCurrentState()).toBe('off')
  })

  /*
    2. Иерархические состояния: процесс покупки онлайн
    Процесс покупки в интернет-магазине с вложенными состояниями.
    Описание
    - Основные состояния: выбор товара, оформление заказа, оплата.
    - "Оформление заказа" имеет подсостояния: ввод адреса, выбор доставки.
  */
  it('should navigate hierarchical states in online shopping', async () => {
    const cart = new MemoryAdapter({ state: '', event: () => null })

    const states = {
      shopping: {
        display: 'Покупка',
        initial: 'selecting',
        regions: {
          order: {
            selecting: { display: 'Выбор товара' },
            checkout: {
              display: 'Оформление заказа',
              initial: 'address',
              regions: {
                details: {
                  address: { display: 'Ввод адреса' },
                  delivery: { display: 'Выбор доставки' },
                },
              },
            },
            payment: { display: 'Оплата' },
          },
        },
      },
      completed: { display: 'Завершено' },
    } satisfies States<any>

    const events = {
      startCheckout: {
        display: 'Начать оформление',
        transitions: [
          { from: 'shopping.order.selecting', to: 'shopping.order.checkout' },
        ],
      },
      setDelivery: {
        display: 'Выбрать доставку',
        transitions: [
          {
            from: 'shopping.order.checkout.details.address',
            to: 'shopping.order.checkout.details.delivery',
          },
        ],
      },
      pay: {
        display: 'Оплатить',
        transitions: [
          {
            from: 'shopping.order.checkout.details.delivery',
            to: 'shopping.order.payment',
          },
        ],
      },
      complete: {
        display: 'Завершить',
        transitions: [{ from: 'shopping.order.payment', to: 'completed' }],
      },
    } satisfies Events<any, typeof states>

    const SMC = {
      name: 'OnlineShopping',
      initialState: 'shopping',
      stateAttribute: 'state',
      states,
      events,
    } satisfies StateMachineConfig<ExtractAdaptee<typeof cart>>

    const sm = new StateMachine(SMC, cart)

    expect(sm.getCurrentState()).toBe('shopping.order.selecting')
    await sm.fireEvent('startCheckout')
    expect(sm.getCurrentState()).toBe('shopping.order.checkout.details.address')
    await sm.fireEvent('setDelivery')
    expect(sm.getCurrentState()).toBe(
      'shopping.order.checkout.details.delivery',
    )
    await sm.fireEvent('pay')
    expect(sm.getCurrentState()).toBe('shopping.order.payment')
    await sm.fireEvent('complete')
    expect(sm.getCurrentState()).toBe('completed')
  })

  /*
    3. Комбинированный пример: управление роботом-пылесосом
    Робот-пылесос с параллельными состояниями для двигателя и датчиков, а также иерархическими состояниями для режима уборки.
    Описание
    - Параллельные состояния: двигатель (вкл/выкл) и датчики (активны/неактивны).
    - Иерархические состояния: режим уборки (авто -> сканирование/очистка, ручной).
  */

  it('should handle combined parallel and hierarchical states in vacuum robot', async () => {
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
              history: 'shallow', // Добавляем поверхностную историю
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
      name: 'VacuumRobot',
      initialState: 'robot',
      stateAttribute: 'state',
      states,
      events,
    } satisfies StateMachineConfig<ExtractAdaptee<typeof robot>>
    const sm = new StateMachine(SMC, robot)

    expect(sm.getCurrentState()).toBe(
      'robot.engine.off|robot.sensors.off|robot.mode.off',
    )
    await sm.fireEvent('startEngine')
    await sm.fireEvent('activateSensors')
    await sm.fireEvent('startAuto')
    expect(sm.getCurrentState()).toBe(
      'robot.engine.on|robot.sensors.on|robot.mode.auto.task.scanning',
    )
    await sm.fireEvent('startCleaning')
    expect(sm.getCurrentState()).toBe(
      'robot.engine.on|robot.sensors.on|robot.mode.auto.task.cleaning',
    )
    await sm.fireEvent('stop')
    expect(sm.getCurrentState()).toBe('stopped')
    await sm.fireEvent('resumeAuto')
    // Благодаря истории, машина восстановит robot.mode.auto.task.cleaning вместо начального scanning
    expect(sm.getCurrentState()).toBe(
      'robot.engine.on|robot.sensors.on|robot.mode.auto.task.cleaning',
    )
  })

  /*
    4. Deep History: Робот-пылесос с глубокой историей
    Расширение примера с роботом-пылесосом для демонстрации deep history.
  */
  it('should handle deep history in vacuum robot', async () => {
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
    await sm.fireEvent('stop')
    await sm.fireEvent('resumeAuto')
    // Deep history восстанавливает robot.mode.auto и все его подсостояния
    expect(sm.getCurrentState()).toBe(
      'robot.engine.on|robot.sensors.on|robot.mode.auto.task.cleaning',
    )
  })
})
