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
        { from: 'state1', to: 'parentState' }, // Переход на parentState восстанавливает начальные состояния регионов (SCXML/UML: bare-root composite re-entry expands regions)
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
    // Standards-correct (SCXML/UML): a transition into the bare-root composite
    // re-enters its regions, restoring the initial region substates (D1). The '|'
    // join-string order is map-insertion dependent, so assert order-insensitively.
    expect(sm.isInState('parentState')).toBe(true)
    expect(sm.getCurrentState()?.split('|').sort()).toEqual(
      [
        'parentState.region1.childState1',
        'parentState.region2.childState1',
      ].sort(),
    )
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
    R1: SCXML/UML ancestor-first entry, descendant-first exit on a parallel-exit.
    Leaving a composite parent fires every region-child onExit BEFORE the parent
    composite onExit (descendant-first), and entering it fires the parent onEnter
    BEFORE its region children (ancestor-first). These hooks are newly driven by
    R1 (the engine was previously silent on the parent + sibling regions).
  */
  it('fires descendant-first sibling+parent onExit and ancestor-first onEnter on parallel-exit', async () => {
    const log: string[] = []
    const adaptee = new MemoryAdapter<{ state: string; event: () => any }>({
      state: '',
      event: () => null,
    })

    const states = {
      wrap: {
        display: 'Composite',
        initial: 'r1.a|r2.x',
        onEnter: () => log.push('enter:wrap'),
        onExit: () => log.push('exit:wrap'),
        regions: {
          r1: {
            a: {
              onEnter: () => log.push('enter:r1.a'),
              onExit: () => log.push('exit:r1.a'),
            },
          },
          r2: {
            x: {
              onEnter: () => log.push('enter:r2.x'),
              onExit: () => log.push('exit:r2.x'),
            },
          },
        },
      },
      done: { display: 'Done', onEnter: () => log.push('enter:done') },
    } satisfies States<typeof adaptee>

    const events = {
      finish: {
        display: 'Finish',
        // bare composite-parent `from` is eligible while any region is active
        // (ANY-leaf parallel-exit / LCCA, D3)
        transitions: [{ from: 'wrap', to: 'done' }],
      },
    } satisfies Events<typeof adaptee, typeof states>

    const SMC = {
      name: 'ParallelExitOrder',
      initialState: 'wrap',
      stateAttribute: 'state',
      states,
      events,
    } satisfies StateMachineConfig<ExtractAdaptee<typeof adaptee>>

    const sm = new StateMachine(SMC, adaptee)

    // Initial entry is ancestor-first: parent onEnter precedes its region children.
    expect(sm.isInState('wrap')).toBe(true)
    expect(sm.getCurrentState()?.split('|').sort()).toEqual(
      ['wrap.r1.a', 'wrap.r2.x'].sort(),
    )
    expect(log[0]).toBe('enter:wrap')
    expect(log.slice(1).sort()).toEqual(['enter:r1.a', 'enter:r2.x'].sort())

    log.length = 0
    await sm.fireEvent('finish')
    expect(sm.getCurrentState()).toBe('done')

    // Descendant-first exit: BOTH region children onExit fire before the parent
    // composite onExit, which fires before the target onEnter. Same-depth sibling
    // order is map-insertion dependent, so assert order-insensitively per layer.
    const exitWrapIdx = log.indexOf('exit:wrap')
    const enterDoneIdx = log.indexOf('enter:done')
    expect(log.indexOf('exit:r1.a')).toBeLessThan(exitWrapIdx)
    expect(log.indexOf('exit:r2.x')).toBeLessThan(exitWrapIdx)
    expect(exitWrapIdx).toBeLessThan(enterDoneIdx)
    expect(log.slice(0, 2).sort()).toEqual(['exit:r1.a', 'exit:r2.x'].sort())
    expect(log).toEqual([
      ...log.slice(0, 2),
      'exit:wrap',
      'enter:done',
    ])
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

  // ===== T12: new coverage — R1 ordering + invoke timers + R2 coexistence =====

  it('nested entry is strictly outer-to-inner and nested exit inner-to-outer; region containers are never an onEnter/onExit site', async () => {
    // SCXML/UML (D2): for a leaf nested under TWO composite ancestors, entry fires
    // root-to-leaf (a, then a.r1.c1, then a.r1.c1.r3.x) and exit fires the reverse.
    // Region containers (a.r1, a.r1.c1.r3) are unregistered states, so they are
    // NEVER an onEnter/onExit firing site — only composite parents + atomic leaves.
    const log: string[] = []
    const owner = new MemoryAdapter<{ state: string; event: () => any }>({
      state: '',
      event: () => null,
    })
    const states = {
      idle: { display: 'Idle' },
      a: {
        display: 'A',
        initial: 'r1.c1',
        onEnter: () => log.push('enter:a'),
        onExit: () => log.push('exit:a'),
        regions: {
          r1: {
            c1: {
              display: 'c1',
              initial: 'r3.x',
              onEnter: () => log.push('enter:a.r1.c1'),
              onExit: () => log.push('exit:a.r1.c1'),
              regions: {
                r3: {
                  x: {
                    display: 'x',
                    onEnter: () => log.push('enter:a.r1.c1.r3.x'),
                    onExit: () => log.push('exit:a.r1.c1.r3.x'),
                  },
                },
              },
            },
          },
        },
      },
      out: { display: 'Out' },
    } satisfies States<any>
    const events = {
      go: { display: 'go', transitions: [{ from: 'idle', to: 'a' }] },
      leave: { display: 'leave', transitions: [{ from: 'a', to: 'out' }] },
    }
    const sm = new StateMachine(
      {
        name: 'NestedEntryExitOrder',
        initialState: 'idle',
        stateAttribute: 'state',
        states,
        events,
      } as any,
      owner,
    )

    log.length = 0
    await sm.fireEvent('go')
    // Reaches the deepest leaf, expanded.
    expect(sameComposite(sm.getCurrentState(), 'a.r1.c1.r3.x')).toBe(true)
    // Entry is strictly outer-to-inner; containers never logged.
    expect(log).toEqual(['enter:a', 'enter:a.r1.c1', 'enter:a.r1.c1.r3.x'])
    expect(log).not.toContain('enter:a.r1')
    expect(log).not.toContain('enter:a.r1.c1.r3')

    log.length = 0
    await sm.fireEvent('leave')
    expect(sm.getCurrentState()).toBe('out')
    // Exit is strictly inner-to-outer; containers never logged.
    expect(log).toEqual(['exit:a.r1.c1.r3.x', 'exit:a.r1.c1', 'exit:a'])
    expect(log).not.toContain('exit:a.r1')
    expect(log).not.toContain('exit:a.r1.c1.r3')
  })

  it('invoke arms once per region leaf on a transition; the composite parent is entered exactly once (not once-per-region)', async () => {
    // D2/D7: a transition into a composite arms exactly one invoke timer per
    // entered region LEAF (keyed by that leaf), so each region's delayed invoke
    // event advances exactly once. The composite PARENT is entered exactly once
    // (ancestor-first, before its regions) — its onEnter fires a single time, not
    // once per region, proving the parent is not double-entered/double-armed.
    const owner = new MemoryAdapter<{ state: string; event: () => any }>({
      state: '',
      event: () => null,
    })
    let parentEnterCount = 0
    const states = {
      idle: { display: 'Idle' },
      box: {
        display: 'Box',
        initial: 'scan.scanning|poll.polling',
        onEnter: () => {
          parentEnterCount += 1
        },
        regions: {
          scan: {
            scanning: {
              display: 'Scanning',
              invoke: [{ delay: 40, event: 'scanDone' }],
            },
            done: { display: 'Scan done' },
          },
          poll: {
            polling: {
              display: 'Polling',
              invoke: [{ delay: 40, event: 'pollDone' }],
            },
            done: { display: 'Poll done' },
          },
        },
      },
      parked: { display: 'Parked' },
    } satisfies States<any>
    const events = {
      enterBox: {
        display: 'Enter Box',
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
    }
    const sm = new StateMachine(
      {
        name: 'InvokeArmOnce',
        initialState: 'idle',
        stateAttribute: 'state',
        states,
        events,
      } as any,
      owner,
    )

    await sm.fireEvent('enterBox')
    // Transition into the bare-root composite expands both region leaves.
    expect(
      sameComposite(
        sm.getCurrentState(),
        'box.scan.scanning|box.poll.polling',
      ),
    ).toBe(true)
    // Parent entered exactly once across the two regions (ancestor-first, single).
    expect(parentEnterCount).toBe(1)

    // Let every region invoke timer fire (each @40ms).
    await new Promise((r) => setTimeout(r, 120))

    // Each region's invoke armed once and advanced that region to done exactly once.
    expect(sameComposite(sm.getCurrentState(), 'box.scan.done|box.poll.done')).toBe(
      true,
    )
    // No spurious re-entry of the parent occurred while the regions advanced.
    expect(parentEnterCount).toBe(1)
  })

  it('partial re-entry preserves the surviving sibling region timer (one armed invoke per surviving leaf)', async () => {
    // D2/D7: re-entering ONE region of a composite must not re-arm or clear the
    // OTHER region's already-armed invoke timer. The shared ancestor + surviving
    // sibling leaf are in NEITHER the enter nor the exit diff, so the surviving
    // sibling's invoke timer keeps counting down and still fires exactly once.
    const owner = new MemoryAdapter<{ state: string; event: () => any }>({
      state: '',
      event: () => null,
    })
    let pollFired = 0
    const states = {
      box: {
        display: 'Box',
        initial: 'scan.scanning|poll.polling',
        regions: {
          scan: {
            scanning: { display: 'Scanning' },
            looking: { display: 'Looking' },
          },
          poll: {
            polling: {
              display: 'Polling',
              invoke: [
                {
                  delay: 60,
                  event: 'pollDone',
                  action: () => {
                    pollFired += 1
                  },
                },
              ],
            },
            done: { display: 'Poll done' },
          },
        },
      },
    } satisfies States<any>
    const events = {
      // Re-enter ONLY the scan region (poll untouched) BEFORE poll's timer fires.
      look: {
        display: 'look',
        transitions: [{ from: 'box.scan.scanning', to: 'box.scan.looking' }],
      },
      pollDone: {
        display: 'Poll finished',
        transitions: [{ from: 'box.poll.polling', to: 'box.poll.done' }],
      },
    }
    const sm = new StateMachine(
      {
        name: 'PartialReentryTimer',
        initialState: 'box',
        stateAttribute: 'state',
        states,
        events,
      } as any,
      owner,
    )

    expect(
      sameComposite(sm.getCurrentState(), 'box.scan.scanning|box.poll.polling'),
    ).toBe(true)

    // Re-enter the scan region while poll's invoke timer is still pending.
    await sm.fireEvent('look')
    expect(
      sameComposite(sm.getCurrentState(), 'box.scan.looking|box.poll.polling'),
    ).toBe(true)

    // The surviving poll-region timer was NOT cleared by the scan re-entry: it
    // still fires exactly once and advances poll to done.
    await new Promise((r) => setTimeout(r, 120))
    expect(pollFired).toBe(1)
    expect(
      sameComposite(sm.getCurrentState(), 'box.scan.looking|box.poll.done'),
    ).toBe(true)
  })

  it('isDone guard is ineligible until all-final: false with one region final, true only at all-final', async () => {
    // D10/D11/D12: a guard authored as () => sm.isDone('C') must stay false while
    // any region is non-final and become true only once EVERY region's active
    // atomic leaf is final. Here the join is GUARDED (not a done.state event), so
    // a plain user event with an isDone guard is the trigger.
    const owner = new MemoryAdapter<{ state: string; event: () => any }>({
      state: '',
      event: () => null,
    })
    let sm: StateMachine<any, any>
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
      // Guarded join on a user event: eligible only when isDone('proc') is true.
      tryJoin: {
        display: 'try join',
        transitions: [
          {
            from: 'proc',
            to: 'complete',
            guard: () => (sm as any).isDone('proc'),
          },
        ],
      },
    }
    sm = new StateMachine(
      {
        name: 'IsDoneGuard',
        initialState: 'proc',
        stateAttribute: 'state',
        states,
        events,
      } as any,
      owner,
    )

    // No region final yet -> guard false.
    expect((sm as any).isDone('proc')).toBe(false)
    await sm.fireEvent('tryJoin')
    expect(sm.getCurrentState()).not.toBe('complete')

    // One region final -> still not done -> guard still false, join ineligible.
    await sm.fireEvent('finishA')
    expect((sm as any).isDone('proc')).toBe(false)
    await sm.fireEvent('tryJoin')
    expect(sm.getCurrentState()).not.toBe('complete')
    expect(sameComposite(sm.getCurrentState(), 'proc.a.done|proc.b.run')).toBe(
      true,
    )

    // All regions final -> isDone true -> guarded join now fires.
    await sm.fireEvent('finishB')
    expect((sm as any).isDone('proc')).toBe(true)
    await sm.fireEvent('tryJoin')
    expect(sm.getCurrentState()).toBe('complete')
  })

  it('coexistence: from:<C> user-event parallel-exit AND done.state.<C> join are unambiguous (user event preempts while non-final; done.state fires only at all-final)', async () => {
    // The same composite C declares BOTH a user-event with from:'C' (ANY-leaf
    // parallel-exit, D3) AND a done.state.C join (all-final only, D10/D11).
    // Disambiguation is by TRIGGER: the user event preempts at ANY active leaf
    // (even while non-final); the done.state.C join only ever fires once every
    // region is final. We exercise both branches with two independent machines
    // built from the same config.
    const makeMachine = () => {
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
        aborted: { display: 'Aborted' },
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
        // User event parallel-exit: eligible while ANY region leaf is active.
        abort: {
          display: 'abort',
          transitions: [{ from: 'proc', to: 'aborted' }],
        },
        // All-final join: enqueued only when every region is final.
        'done.state.proc': {
          display: 'all regions final',
          transitions: [{ from: 'proc', to: 'complete' }],
        },
      }
      return new StateMachine(
        {
          name: 'Coexistence',
          initialState: 'proc',
          stateAttribute: 'state',
          states,
          events,
        } as any,
        owner,
      )
    }

    // Branch 1: user event preempts while NON-final (any-leaf parallel-exit).
    const smAbort = makeMachine()
    expect((smAbort as any).isDone('proc')).toBe(false)
    await smAbort.fireEvent('abort')
    expect(smAbort.getCurrentState()).toBe('aborted')

    // Branch 2: drive to all-final; the done.state.proc join fires (not abort).
    const smJoin = makeMachine()
    await smJoin.fireEvent('finishA')
    // Non-final: done.state.proc not raised, machine still inside proc.
    expect((smJoin as any).isDone('proc')).toBe(false)
    expect(smJoin.getCurrentState()).not.toBe('complete')
    await smJoin.fireEvent('finishB')
    // All-final reached: isDone true at this config before the join drains.
    expect((smJoin as any).isDone('proc')).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    // The internally-raised done.state.proc fired the join into complete; the
    // user-event abort did NOT spuriously fire.
    expect(smJoin.getCurrentState()).toBe('complete')
  })
})
