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

/*
  T0 — Baseline failing repros (RED on current code).

  These tests encode the desired SCXML/UML-correct behavior for the
  regions-entry-bugfix work (decisions D1, D2, D3, D10, D11). On the current
  (buggy) engine they FAIL; they turn GREEN as T1..T8 land. All assertions are
  order-insensitive: composite '|' part order is map-insertion dependent, so we
  never compare against a hard-coded ordered composite string. Entry/exit
  ordering is asserted via relative index (ancestor-first / descendant-first),
  never absolute sibling order.
*/
describe('SCXML/UML regions: ancestor-first entry + final join (T0 repros, red)', () => {
  // Order-insensitive composite membership: every sorted '|'-part of `expected`
  // equals the corresponding sorted '|'-part of `actual`.
  const sortedParts = (s: string | undefined): string[] =>
    (s ?? '').split('|').filter(Boolean).sort()
  const sameComposite = (actual: string | undefined, expected: string): boolean => {
    const a = sortedParts(actual)
    const e = sortedParts(expected)
    return a.length === e.length && a.every((p, i) => p === e[i])
  }

  it('ancestor-first entry: transition into bare-root composite expands regions and fires parent onEnter before each region-child onEnter', async () => {
    const log: string[] = []
    const owner = new MemoryAdapter<{ state: string; event: () => any }>({
      state: '',
      event: () => null,
    })
    const states = {
      idle: { display: 'Idle' },
      parent: {
        display: 'Parent',
        initial: 'r1.c1|r2.c1',
        onEnter: () => {
          log.push('parent')
        },
        regions: {
          r1: {
            c1: {
              display: 'c1',
              onEnter: () => {
                log.push('parent.r1.c1')
              },
            },
          },
          r2: {
            c1: {
              display: 'c1',
              onEnter: () => {
                log.push('parent.r2.c1')
              },
            },
          },
        },
      },
    } satisfies States<any>
    const events = {
      go: { display: 'go', transitions: [{ from: 'idle', to: 'parent' }] },
    }
    const sm = new StateMachine(
      {
        name: 'AncestorFirstEntry',
        initialState: 'idle',
        stateAttribute: 'state',
        states,
        events,
      } as any,
      owner,
    )
    log.length = 0
    await sm.fireEvent('go')

    // D1: a bare-root composite transition expands its regions (order-insensitive).
    expect(
      sameComposite(sm.getCurrentState(), 'parent.r1.c1|parent.r2.c1'),
    ).toBe(true)
    // D2: parent onEnter fires AND precedes each region-child onEnter.
    expect(log).toContain('parent')
    expect(log).toContain('parent.r1.c1')
    expect(log).toContain('parent.r2.c1')
    expect(log.indexOf('parent')).toBeLessThan(log.indexOf('parent.r1.c1'))
    expect(log.indexOf('parent')).toBeLessThan(log.indexOf('parent.r2.c1'))
  })

  it('descendant-first exit: leaving an expanded composite fires region-child onExit before parent onExit', async () => {
    const log: string[] = []
    const owner = new MemoryAdapter<{ state: string; event: () => any }>({
      state: '',
      event: () => null,
    })
    const states = {
      parent: {
        display: 'Parent',
        initial: 'r1.c1|r2.c1',
        onExit: () => {
          log.push('parent')
        },
        regions: {
          r1: {
            c1: {
              display: 'c1',
              onExit: () => {
                log.push('parent.r1.c1')
              },
            },
          },
          r2: {
            c1: {
              display: 'c1',
              onExit: () => {
                log.push('parent.r2.c1')
              },
            },
          },
        },
      },
      out: { display: 'Out' },
    } satisfies States<any>
    const events = {
      leave: {
        display: 'leave',
        transitions: [{ from: 'parent', to: 'out' }],
      },
    }
    const sm = new StateMachine(
      {
        name: 'DescendantFirstExit',
        initialState: 'parent',
        stateAttribute: 'state',
        states,
        events,
      } as any,
      owner,
    )
    log.length = 0
    // D3: from:'parent' (composite-parent) is eligible while any region leaf is active.
    await sm.fireEvent('leave')

    expect(sm.getCurrentState()).toBe('out')
    // D2: each region-child onExit precedes the parent onExit.
    expect(log).toContain('parent')
    expect(log).toContain('parent.r1.c1')
    expect(log).toContain('parent.r2.c1')
    expect(log.indexOf('parent.r1.c1')).toBeLessThan(log.indexOf('parent'))
    expect(log.indexOf('parent.r2.c1')).toBeLessThan(log.indexOf('parent'))
  })

  it('parallel-exit / join: a transition from a composite-parent matches the expanded config and fires', async () => {
    const owner = new MemoryAdapter<{ state: string; event: () => any }>({
      state: '',
      event: () => null,
    })
    const states = {
      council: {
        display: 'Council',
        initial: 'a.x|b.y',
        regions: {
          a: { x: { display: 'x' } },
          b: { y: { display: 'y' } },
        },
      },
      finished: { display: 'Finished' },
    } satisfies States<any>
    const events = {
      finish: {
        display: 'finish',
        transitions: [{ from: 'council', to: 'finished' }],
      },
    }
    const sm = new StateMachine(
      {
        name: 'CompositeParentJoin',
        initialState: 'council',
        stateAttribute: 'state',
        states,
        events,
      } as any,
      owner,
    )
    // Expanded initial config; from:'council' must match (D3) — currently throws Invalid event.
    expect(
      sameComposite(sm.getCurrentState(), 'council.a.x|council.b.y'),
    ).toBe(true)
    await sm.fireEvent('finish')
    expect(sm.getCurrentState()).toBe('finished')
  })

  it('all-final join (positive): both regions final raises done.state.<C> once and the join fires', async () => {
    const owner = new MemoryAdapter<{ state: string; event: () => any }>({
      state: '',
      event: () => null,
    })
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
      finishB: {
        display: 'finishB',
        transitions: [{ from: 'proc.b.run', to: 'proc.b.done' }],
      },
      // Join authored on the engine-raised completion event.
      'done.state.proc': {
        display: 'all regions final',
        transitions: [{ from: 'proc', to: 'complete' }],
      },
    }
    const sm = new StateMachine(
      {
        name: 'AllFinalJoin',
        initialState: 'proc',
        stateAttribute: 'state',
        states,
        events,
      } as any,
      owner,
    )
    await sm.fireEvent('finishA')
    // One region final: NOT done yet, join must NOT have fired.
    expect((sm as any).isDone?.('proc')).toBe(false)
    expect(sameComposite(sm.getCurrentState(), 'proc.a.done|proc.b.run')).toBe(
      true,
    )
    await sm.fireEvent('finishB')
    // Both regions are now final: the all-final configuration is reached, so
    // isDone('proc') is true at THIS point (before the internally-raised
    // done.state.proc join drains and moves the machine out of proc).
    expect((sm as any).isDone?.('proc')).toBe(true)
    expect(sameComposite(sm.getCurrentState(), 'proc.a.done|proc.b.done')).toBe(
      true,
    )
    // Allow the internally-raised done.state.proc to be processed; the join
    // fires exactly once and exits proc into complete (SCXML done.state).
    await new Promise((r) => setTimeout(r, 0))
    expect(sm.getCurrentState()).toBe('complete')
    // Having left proc entirely, the machine is no longer "in" proc's done set.
    expect((sm as any).isDone?.('proc')).toBe(false)
  })

  it('all-final join (negative): one region final does not raise done.state.<C> and the join does not fire', async () => {
    const owner = new MemoryAdapter<{ state: string; event: () => any }>({
      state: '',
      event: () => null,
    })
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
      'done.state.proc': {
        display: 'all regions final',
        transitions: [{ from: 'proc', to: 'complete' }],
      },
    }
    const sm = new StateMachine(
      {
        name: 'AllFinalJoinNegative',
        initialState: 'proc',
        stateAttribute: 'state',
        states,
        events,
      } as any,
      owner,
    )
    await sm.fireEvent('finishA')
    await new Promise((r) => setTimeout(r, 0))
    // Only region a is final -> not done, join must not fire.
    expect((sm as any).isDone?.('proc')).toBe(false)
    expect(sm.getCurrentState()).not.toBe('complete')
    expect(sameComposite(sm.getCurrentState(), 'proc.a.done|proc.b.run')).toBe(
      true,
    )
  })
})
