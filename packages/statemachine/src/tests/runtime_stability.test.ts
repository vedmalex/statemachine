import { describe, expect, it, afterEach } from 'vitest'
import { StateMachine } from '../state_machine'
import {
  type IMonitor,
  MemoryAdapter,
  type StateMachineConfig,
  StateMachineError,
} from '../types'

/**
 * Волна W1 — RED-тесты устойчивости рантайма для дефектов реестра MASTER §6:
 *   П2 (CRITICAL) — RTC-разрыв: бросок во ВНУТРЕННЕЙ ветке processQueues →
 *                   process unhandledRejection + ошибка НЕ видна в monitor/onError.
 *   П3 (HIGH)     — реентрантный `await fireEvent` из действия → вечный клин.
 *   П8 (HIGH)     — run-away bound недостижим: самоподдерживающийся внутренний
 *                   цикл крутит плоский while, MAX_TRANSITION_DEPTH/maxQueueDepth
 *                   не срабатывают, macrotask голодает.
 *
 * Все три КРАСНЫ на HEAD (remediation/w1-prep, до фикса) и ЗЕЛЕНЕЮТ после фикса.
 * Тайминги подобраны так, чтобы «виснет» ДЕТЕКТИРОВАЛОСЬ маркером, а не вешало
 * прогон: реентрантный клин освобождает поток (await висящего промиса), а
 * run-away сделан САМО-ОГРАНИЧЕННЫМ (кап K) — так что даже на HEAD файл
 * завершается, а RED сигнал — по НАБЛЮДАЕМОМУ признаку, а не по зависанию.
 */

/** Маркер зависания: резолвится ПОЗЖЕ, если основной промис завис. */
function hangMarker(ms: number, label = 'ЗАВИС'): Promise<string> {
  return new Promise((res) => setTimeout(() => res(label), ms))
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

/** Шпион-monitor: считает recordError и хранит контексты. */
function makeSpyMonitor(): {
  monitor: IMonitor
  errors: Array<{ error: Error; context?: unknown }>
} {
  const errors: Array<{ error: Error; context?: unknown }> = []
  const monitor: IMonitor = {
    recordTransition() {},
    recordError(error, context) {
      errors.push({ error, context })
    },
  }
  return { monitor, errors }
}

// ---------------------------------------------------------------------------
// П2 — RTC-разрыв во ВНУТРЕННЕЙ ветке processQueues
// ---------------------------------------------------------------------------
describe('П2 (CRITICAL): бросок во внутренней ветке processQueues', () => {
  // Мы временно снимаем чужих слушателей unhandledRejection (в т.ч. vitest),
  // чтобы (1) НАШ слушатель увидел реджект и (2) необработанный реджект на HEAD
  // не убил параллельные тесты файла. Восстанавливаем в afterEach.
  let savedListeners: Array<(...a: any[]) => void> = []
  let captured: unknown[] = []
  const onUnhandled = (reason: unknown) => {
    captured.push(reason)
  }

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled)
    for (const l of savedListeners) {
      process.on('unhandledRejection', l as any)
    }
    savedListeners = []
    captured = []
  })

  it('invoke НЕизвестного события НЕ роняет процесс и ошибка НАБЛЮДАЕМА (monitor/onError)', async () => {
    const { monitor, errors } = makeSpyMonitor()
    let onErrorCalls = 0

    interface Box {
      state: string
    }
    const config: StateMachineConfig<Box> = {
      name: 'P2Invoke',
      stateAttribute: 'state',
      initialState: 'idle',
      // config-level onError — наблюдаемый канал для ошибки внутреннего события
      onError: () => {
        onErrorCalls++
      },
      states: {
        idle: {},
        // Вход в `running` арматирует таймер invoke, который через 5мс поднимает
        // ВНУТРЕННЕЕ событие 'NONEXISTENT' — оно не имеет ни transitions, ни
        // wildcard, поэтому executeQueuedTransition бросит `Invalid event`.
        running: {
          invoke: [{ delay: 5, event: 'NONEXISTENT' }],
        },
      },
      events: {
        go: { transitions: [{ from: 'idle', to: 'running' }] },
      },
    }

    const adaptee = new MemoryAdapter<Box>({ state: 'idle' })
    const sm = new StateMachine<Box, typeof config>(config, adaptee, { monitor })

    // Перехватываем process unhandledRejection только на время теста.
    savedListeners = process.listeners('unhandledRejection') as any
    process.removeAllListeners('unhandledRejection')
    process.on('unhandledRejection', onUnhandled)

    // fireEvent('go') возвращает ok (машина входит в `running`, арматируя invoke).
    const ok = await sm.fireEvent('go')
    expect(ok).toBe(true)

    // Ждём: invoke(5мс) → raiseEvent('NONEXISTENT') → queueMicrotask(processQueues)
    // → бросок во ВНУТРЕННЕЙ ветке (try/finally БЕЗ catch) → вылет из плавающего
    // промиса как РЕАЛЬНЫЙ unhandledRejection.
    await sleep(200)

    // (а) КРИТИЧНО: брошенное внутреннее событие НЕ должно ронять процесс.
    // HEAD: captured содержит `Invalid event: NONEXISTENT` → RED.
    expect(
      captured,
      `unhandledRejection не должен срабатывать; поймано: ${captured
        .map((c) => (c instanceof Error ? c.message : String(c)))
        .join(' | ')}`,
    ).toHaveLength(0)

    // (в) Ошибка внутреннего события ДОЛЖНА быть видна в НАБЛЮДАЕМОМ канале
    // (monitor.recordError и/или onError) — критично для sim A1 (W5), чтобы
    // симулятор увидел violation, а не тишину. HEAD: оба канала молчат → RED.
    expect(
      errors.length + onErrorCalls,
      `ошибка внутреннего события должна попасть в monitor.recordError или onError; ` +
        `recordError=${errors.length}, onError=${onErrorCalls}`,
    ).toBeGreaterThan(0)
  })

  it('внешний fireEvent после падения внутреннего события не виснет (Promise.race маркер ЗАВИС)', async () => {
    interface Box {
      state: string
    }
    const config: StateMachineConfig<Box> = {
      name: 'P2NoHang',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        running: {
          invoke: [{ delay: 5, event: 'NONEXISTENT' }],
        },
        done: {},
      },
      events: {
        go: { transitions: [{ from: 'idle', to: 'running' }] },
        finish: { transitions: [{ from: 'running', to: 'done' }] },
      },
    }

    const adaptee = new MemoryAdapter<Box>({ state: 'idle' })
    const sm = new StateMachine<Box, typeof config>(config, adaptee)

    // Снимаем слушателей: на HEAD invoke уронит unhandledRejection, он не должен
    // уронить этот тест.
    savedListeners = process.listeners('unhandledRejection') as any
    process.removeAllListeners('unhandledRejection')
    process.on('unhandledRejection', onUnhandled)

    await sm.fireEvent('go')
    await sleep(50) // дать invoke-таймеру бросить

    // Внешний промис в очереди на момент/после броска должен settle, не виснуть.
    const outcome = await Promise.race([
      sm
        .fireEvent('finish')
        .then(
          () => 'SETTLED',
          () => 'SETTLED',
        ),
      hangMarker(1500),
    ])
    expect(outcome, 'внешний fireEvent завис (никогда не резолвится/реджектится)').not.toBe(
      'ЗАВИС',
    )
  })
})

// ---------------------------------------------------------------------------
// П3 — реентрантный await fireEvent из действия → вечный клин
// ---------------------------------------------------------------------------
describe('П3 (HIGH): реентрантный await fireEvent из действия', () => {
  it('await sm.fireEvent(...) внутри onEnter → внешний fireEvent реджектится, не виснет', async () => {
    interface Box {
      state: string
    }

    // onEnter состояния 'A' делает ВЛОЖЕННЫЙ await sm.fireEvent('inner').
    // На HEAD: isProcessing===true, drain заблокирован в onEnter, 'inner' не
    // обработается никогда → внешний fireEvent('go') не резолвится (клин).
    // Фикс: реентрантный fireEvent из стека действия → немедленный reject с
    // внятным StateMachineError; raiseEvent (внутренняя постановка) остаётся ok.
    let sm!: StateMachine<Box, any>
    const config: StateMachineConfig<Box> = {
      name: 'P3Reentrant',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        A: {
          onEnter: async () => {
            await sm.fireEvent('inner')
          },
        },
        B: {},
      },
      events: {
        go: { transitions: [{ from: 'idle', to: 'A' }] },
        inner: { transitions: [{ from: 'A', to: 'B' }] },
      },
    }

    const adaptee = new MemoryAdapter<Box>({ state: 'idle' })
    sm = new StateMachine<Box, typeof config>(config, adaptee)

    const outcome = await Promise.race([
      sm.fireEvent('go').then(
        () => 'RESOLVED',
        (e) =>
          e instanceof StateMachineError && /reentrant/i.test(e.message)
            ? 'REENTRANT_REJECT'
            : `OTHER_REJECT:${e instanceof Error ? e.message : String(e)}`,
      ),
      hangMarker(1500),
    ])

    // HEAD: клин → 'ЗАВИС' (внешний промис никогда не settle) → RED.
    // GREEN: реентрантность задетектирована → 'REENTRANT_REJECT'.
    expect(
      outcome,
      `реентрантный fireEvent должен реджектиться внятной ошибкой, а не виснуть (получено: ${outcome})`,
    ).toBe('REENTRANT_REJECT')
  })
})

// ---------------------------------------------------------------------------
// П8 — run-away bound недостижим; macrotask голодает
// ---------------------------------------------------------------------------
describe('П8 (HIGH): run-away bound недостижим (плоский while)', () => {
  it('самоподдерживающийся внутренний цикл ловится run-away защитой; setTimeout успевает сработать', async () => {
    // Пинг-понг ЗАВЕРШЁННОСТИ (done.state) между двумя ВЛОЖЕННЫМИ composite-
    // состояниями P и Q — сиблингами ОДНОГО региона `main` родителя `root`
    // (общий регион делает их взаимоисключающими, так что переход P->Q реально
    // ВЫХОДИТ из P). Каждый из P/Q — свой composite с единственным final-листом,
    // поэтому становится "done" сразу при входе → движок поднимает ВНУТРЕННЕЕ
    // done.state.root.main.<C>.
    //   done.state.root.main.P: P -> Q  (Q становится done → done.state...Q)
    //   done.state.root.main.Q: Q -> P  (P становится done → done.state...P)
    // Это самоподдерживающийся ВНУТРЕННИЙ цикл (raiseEvent, НЕ внешний fireEvent —
    // значит П3-детект реентрантности его НЕ трогает): очередь держится на 0-1
    // (maxQueueDepth=1000 не срабатывает), transitionDepth ∈ {0,1}
    // (MAX_TRANSITION_DEPTH=100 не срабатывает) → плоский while крутится, пока
    // n не упрётся в само-ограничитель K. На HEAD цикл проходит ВСЕ K итераций
    // (защита не сработала); на GREEN run-away защита обрывает его задолго до K.
    // Приоритеты: рабочий переход priority:1 (выигрывает пока guard истинен),
    // фолбэк в 'stopped' priority:0 (побеждает лишь когда n>=K) — иначе
    // getAllowedTransitions выбрал бы ПОСЛЕДНИЙ равноприоритетный (фолбэк).
    const K = 5000

    interface Box {
      state: string
      n: number
    }
    const { monitor, errors } = makeSpyMonitor()
    let onErrorCalls = 0

    const doneComposite = () => ({
      initial: 'r.f',
      regions: { r: { f: { final: true } } },
    })
    const config: StateMachineConfig<Box> = {
      name: 'P8RunAway',
      stateAttribute: 'state',
      initialState: 'idle',
      onError: () => {
        onErrorCalls++
      },
      states: {
        idle: {},
        root: {
          initial: 'main.P',
          regions: {
            main: {
              P: doneComposite(),
              Q: doneComposite(),
            },
          },
        } as any,
        stopped: {},
      },
      events: {
        start: { transitions: [{ from: 'idle', to: 'root' }] },
        'done.state.root.main.P': {
          transitions: [
            {
              from: 'root.main.P',
              to: 'root.main.Q',
              priority: 1,
              guard: (o: Box) => o.n < K,
              onTransition: (o: Box) => {
                o.n++
              },
            },
            { from: 'root.main.P', to: 'stopped', priority: 0 },
          ],
        },
        'done.state.root.main.Q': {
          transitions: [
            {
              from: 'root.main.Q',
              to: 'root.main.P',
              priority: 1,
              guard: (o: Box) => o.n < K,
              onTransition: (o: Box) => {
                o.n++
              },
            },
            { from: 'root.main.Q', to: 'stopped', priority: 0 },
          ],
        },
      },
    }

    const adaptee = new MemoryAdapter<Box>({ state: 'idle', n: 0 })
    const sm = new StateMachine<Box, typeof config>(config, adaptee, { monitor })

    // Маркер macrotask: планируем ПЕРЕД запуском цикла. На HEAD плоский while
    // (микротаск-приоритет) голодает macrotask, но т.к. цикл само-ограничен K,
    // маркер в итоге срабатывает — измеряем это ПОСЛЕ.
    let markerFired = false
    setTimeout(() => {
      markerFired = true
    }, 0)

    // Снимаем слушателей unhandledRejection: на HEAD после П2-фикса/без него
    // возможны реджекты, не должны ронять тест.
    const saved = process.listeners('unhandledRejection') as any[]
    process.removeAllListeners('unhandledRejection')

    try {
      // Запускаем цикл. fireEvent('start') резолвится после СВОЕГО перехода,
      // ping-pong продолжается в фоновом дренаже.
      await sm.fireEvent('start')

      // Ждём завершения фонового дренажа. На HEAD дренаж голодает macrotask,
      // поэтому этот setTimeout сработает лишь ПОСЛЕ того как цикл упрётся в K.
      // На GREEN защита обрывает цикл рано → macrotask свободен раньше.
      await sleep(800)
    } finally {
      for (const l of saved) process.on('unhandledRejection', l)
    }

    // (1) Run-away ДОЛЖЕН быть пойман защитой ДО того как цикл пройдёт все K
    // итераций. HEAD: n дошло до K (защита не сработала) → RED.
    //
    // П8.2 (запинить границу): прежний ассерт `n < K(5000)` рыхлый — прошёл бы
    // даже при bound=4999. Ужесточаем до `n ≲ MAX_TRANSITION_DEPTH + ε`: дефолтный
    // порог = 100 (каждый внутренний done.state-переход инкрементит и n, и
    // transitionDepth ≈1:1, поэтому run-away срабатывает при n≈100). Верхняя
    // граница BOUND ловит регресс, при котором порог тихо уполз бы вверх.
    //
    // П8.3 (что именно ловит bound): per-drain счётчик ловит STARVATION —
    // самоподдерживающийся ВНУТРЕННИЙ цикл (raiseEvent), который в одном
    // непрерывном дренаже голодал бы macrotask-очередь. Он НЕ обещает поймать
    // любую бесконечность: таймерный ping-pong (`invoke` с delay:0) уступает
    // macrotask-очереди на каждом шаге, поэтому лежит ВНЕ этого bound по
    // построению (и не голодает). Коллатеральный reject подвисших внешних
    // промисов при срабатывании run-away (см. drain: externalQueue → reject) —
    // осознанный выбор: подвисшего внешнего caller'а settle'ят ошибкой run-away,
    // а не оставляют висеть.
    const BOUND = 150 // MAX_TRANSITION_DEPTH(100) + ε
    expect(
      adaptee.adaptee.n,
      `run-away не пойман/порог уполз: цикл прошёл ${adaptee.adaptee.n} итераций; ` +
        `ожидалось срабатывание около MAX_TRANSITION_DEPTH≈100 (кап K=${K}, ` +
        `пиновая граница=${BOUND})`,
    ).toBeLessThan(BOUND)

    // (2) Ошибка run-away ДОЛЖНА быть наблюдаема (monitor/onError) — не тихо.
    // HEAD: цикл тихо само-ограничился, ошибки нет → RED.
    expect(
      errors.length + onErrorCalls,
      `run-away должен реджектить/бросать НАБЛЮДАЕМО (monitor/onError); ` +
        `recordError=${errors.length}, onError=${onErrorCalls}`,
    ).toBeGreaterThan(0)

    // (3) macrotask-очередь не мертва — setTimeout успевает сработать.
    expect(markerFired, 'setTimeout-маркер так и не сработал (macrotask мёртв)').toBe(true)
  })

  it('легитимная конечная цепочка (10-20 внутренних переходов) НЕ ломается', async () => {
    // Guard против over-fix: длинная-но-КОНЕЧНАЯ внутренняя цепочка через
    // done.state должна отработать до конца без ложного run-away.
    const CHAIN = 15

    interface Box {
      state: string
      steps: number
    }
    const doneComposite = () => ({
      initial: 'r.f',
      regions: { r: { f: { final: true } } },
    })
    const config: StateMachineConfig<Box> = {
      name: 'P8FiniteChain',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        root: {
          initial: 'main.P',
          regions: {
            main: {
              P: doneComposite(),
              Q: doneComposite(),
            },
          },
        } as any,
        stopped: {},
      },
      events: {
        start: { transitions: [{ from: 'idle', to: 'root' }] },
        'done.state.root.main.P': {
          transitions: [
            {
              from: 'root.main.P',
              to: 'root.main.Q',
              priority: 1,
              guard: (o: Box) => o.steps < CHAIN,
              onTransition: (o: Box) => {
                o.steps++
              },
            },
            { from: 'root.main.P', to: 'stopped', priority: 0 },
          ],
        },
        'done.state.root.main.Q': {
          transitions: [
            {
              from: 'root.main.Q',
              to: 'root.main.P',
              priority: 1,
              guard: (o: Box) => o.steps < CHAIN,
              onTransition: (o: Box) => {
                o.steps++
              },
            },
            { from: 'root.main.Q', to: 'stopped', priority: 0 },
          ],
        },
      },
    }

    const adaptee = new MemoryAdapter<Box>({ state: 'idle', steps: 0 })
    const sm = new StateMachine<Box, typeof config>(config, adaptee)

    await sm.fireEvent('start')
    await sleep(100)

    // Конечная цепочка из CHAIN переходов должна завершиться в 'stopped'.
    expect(adaptee.adaptee.steps).toBe(CHAIN)
    expect(sm.getCurrentState()).toBe('stopped')
  })

  it('легитимный синхронный батч >100 ВНЕШНИХ fireEvent НЕ триггерит run-away (регресс over-fix)', async () => {
    // Первая версия П8-фикса инкрементировала счётчик ДО ветвления internal/
    // external, поэтому синхронный батч внешних событий (нормальный RTC-паттерн:
    // replay лога / поток событий) ложно ловился на 101-м как run-away. Run-away
    // считает ТОЛЬКО внутренние (raised) переходы; внешнее событие — свежий шаг.
    const config = {
      name: 'ext-batch',
      stateAttribute: 'state',
      initialState: 'a',
      states: { a: {}, b: {} },
      events: {
        toB: { transitions: [{ from: 'a', to: 'b' }] },
        toA: { transitions: [{ from: 'b', to: 'a' }] },
      },
    } as any
    const sm = new StateMachine<Box, typeof config>(config, { state: 'a' } as any)
    let rejected = 0
    const N = 500
    const ps: Promise<unknown>[] = []
    for (let i = 0; i < N; i++) {
      ps.push(sm.fireEvent(i % 2 === 0 ? 'toB' : 'toA').catch(() => { rejected++ }))
    }
    await Promise.all(ps)
    expect(rejected).toBe(0)
  })
})
