import { afterEach, describe, expect, it } from 'vitest'
import { StateMachine } from '../state_machine'
import {
  type IMonitor,
  MemoryAdapter,
  type StateMachineConfig,
  StateMachineError,
} from '../types'

/**
 * Волна W1.1 — RED-тесты ТОЧНОСТИ детектора реентрантности и доработок П2/П8.
 *
 * П3 (HIGH, блокер W2): текущий детект (`enqueueEvent`: type==='external' &&
 *   isProcessing → reject 'Reentrant') ШИРЕ дефекта. isProcessing держится через
 *   ВСЕ await'ы дренажа (включая await внутри async onEnter), поэтому посторонний
 *   макротаск — внешний fireEvent из НЕЗАВИСИМОГО setTimeout/IO-колбэка ИЛИ
 *   разбуженный resolve()-ом caller в цепочке `await A; await B` — попадает в окно
 *   и ЛОЖНО реджектится, хотя externalQueue существует ИМЕННО для приёма событий
 *   «пока машина занята». Истинный реентрант — `await sm.fireEvent(X)` ПРЯМО из
 *   стека onEnter/guard — должен по-прежнему реджектиться.
 *
 * П2 №2: двойной recordError. При падении applyTransition ВНУТРЕННЕГО события
 *   ошибка пишется в monitor.recordError в executeQueuedTransition (~:577-582),
 *   rethrow, затем internal-catch processQueues → reportRuntimeError → ВТОРОЙ
 *   recordError. Для количественных оракулов sim W5 задвоенные счётчики фатальны.
 *
 * П8 №1: MAX_TRANSITION_DEPTH=100 захардкожен. Легитимный КОНЕЧНЫЙ внутренний
 *   каскад >100 (длинная auto-advance цепочка через done.state — gated-pipeline)
 *   ложно убивается run-away защитой. Нужен options.maxTransitionDepth (по образцу
 *   maxQueueDepth), дефолт 100.
 *
 * Все тесты КРАСНЫ на HEAD (remediation/w1-prep, до фикса) и ЗЕЛЕНЕЮТ после.
 * Тайминги подобраны так, чтобы «виснет» ДЕТЕКТИРОВАЛОСЬ маркером-исходом, а не
 * вешало прогон.
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

/** Классифицирует исход fireEvent: RESOLVED_TRUE / RESOLVED_FALSE / REENTRANT_REJECT / OTHER. */
function classify(p: Promise<boolean>): Promise<string> {
  return p.then(
    (r) => (r ? 'RESOLVED_TRUE' : 'RESOLVED_FALSE'),
    (e) =>
      e instanceof StateMachineError && /reentrant/i.test(e.message)
        ? 'REENTRANT_REJECT'
        : `OTHER_REJECT:${e instanceof Error ? e.message : String(e)}`,
  )
}

/** composite-лист, который становится "done" сразу при входе → поднимает done.state. */
const doneComposite = () => ({
  initial: 'r.f',
  regions: { r: { f: { final: true } } },
})

// ---------------------------------------------------------------------------
// П3 — ложная реентрантность на ЛЕГИТИМНЫХ внешних событиях
// ---------------------------------------------------------------------------
describe('П3-точность: детектор реентрантности НЕ должен ловить легитимные внешние события', () => {
  // На HEAD ложный reject — это ОБРАБОТАННЫЙ нами промис (.then/.catch), поэтому
  // unhandledRejection не ожидается; тем не менее подстрахуемся восстановлением
  // слушателей, если какой-то фоновой промис останется висеть.
  let saved: Array<(...a: any[]) => void> = []
  afterEach(() => {
    for (const l of saved) process.on('unhandledRejection', l as any)
    saved = []
  })

  it('(а) внешний fireEvent из НЕЗАВИСИМОГО setTimeout в окно async-onEnter → ВСТАЁТ В ОЧЕРЕДЬ и резолвится (HEAD: ложный Reentrant reject)', async () => {
    interface Box {
      state: string
    }

    // onEnter состояния 'A' ВИСИТ 100мс (симуляция async-дренажа: isProcessing
    // держится всё это время, включая await). Внешний fireEvent('finish') из
    // НЕЗАВИСИМОГО setTimeout-колбэка (симуляция IO) стреляет на 30мс — ВНУТРИ окна.
    // Это НЕ реентрант: колбэк — посторонний макротаск вне логического стека
    // дренажа. Должен встать в externalQueue и резолвиться после onEnter (A->B).
    // HEAD: isProcessing===true → детект реджектит как 'Reentrant' → RED.
    let sm!: StateMachine<Box, any>
    const config: StateMachineConfig<Box> = {
      name: 'P3FalseExternal',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        A: {
          onEnter: async () => {
            await sleep(100)
          },
        },
        B: {},
      },
      events: {
        go: { transitions: [{ from: 'idle', to: 'A' }] },
        finish: { transitions: [{ from: 'A', to: 'B' }] },
      },
    }

    const adaptee = new MemoryAdapter<Box>({ state: 'idle' })
    sm = new StateMachine<Box, typeof config>(config, adaptee)

    // Запускаем go, НЕ дожидаясь (onEnter повиснет на 100мс, drain занят).
    const goP = sm.fireEvent('go').catch(() => {})

    // Внешнее событие из независимого таймера — попадает в окно async-onEnter.
    const extOutcome = await new Promise<string>((resolve) => {
      setTimeout(() => {
        classify(sm.fireEvent('finish')).then(resolve)
      }, 30)
    })

    await goP

    // GREEN: событие встало в очередь, дренаж после onEnter выполнил A->B → true.
    // HEAD: ложный reject 'Reentrant fireEvent from within an action' → RED.
    expect(
      extOutcome,
      `внешний fireEvent из независимого таймера в окно async-onEnter должен ` +
        `встать в очередь и резолвиться (A->B), а НЕ реджектиться как реентрант ` +
        `(получено: ${extOutcome})`,
    ).toBe('RESOLVED_TRUE')

    // Машина не должна застрять — итоговое состояние 'B'.
    expect(sm.getCurrentState(), 'машина застряла (не дошла до B)').toBe('B')
  })

  it('(в) chained `await fireEvent(A); await fireEvent(B)` при НЕПУСТОЙ очереди → B резолвится (HEAD: ложный Reentrant, resolve будит caller раньше конца дренажа)', async () => {
    interface Box {
      state: string
    }

    // fireEvent('A') входит в composite 'root', который сразу становится done →
    // поднимает ВНУТРЕННЕЕ done.state.root.main.P (очередь НЕпуста). resolve(A)
    // будит caller ДО завершения дренажа (drain ещё крутит внутреннее событие,
    // isProcessing===true). Следующий `await sm.fireEvent('B')` — легитимное
    // внешнее событие, но попадает в окно занятого дренажа.
    // HEAD: ложный reject 'Reentrant'. GREEN: B встаёт в очередь → s1->s2 → true.
    const config: StateMachineConfig<Box> = {
      name: 'P3FalseChained',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        root: {
          initial: 'main.P',
          regions: { main: { P: doneComposite() } },
        } as any,
        s1: {},
        s2: {},
      },
      events: {
        A: { transitions: [{ from: 'idle', to: 'root' }] },
        'done.state.root.main.P': {
          transitions: [{ from: 'root.main.P', to: 's1' }],
        },
        B: { transitions: [{ from: 's1', to: 's2' }] },
      },
    }

    const adaptee = new MemoryAdapter<Box>({ state: 'idle' })
    const sm = new StateMachine<Box, typeof config>(config, adaptee)

    await sm.fireEvent('A')
    // Цепочечный вызов сразу после resolve(A): дренаж ещё обрабатывает внутренний
    // done.state, isProcessing===true. Легитимное внешнее B не должно реджектиться.
    const bOutcome = await Promise.race([classify(sm.fireEvent('B')), hangMarker(1500)])

    // GREEN: B встало в очередь, после дренажа done.state (root.main.P -> s1)
    // выполнено s1 -> s2 → true. HEAD: 'REENTRANT_REJECT' → RED.
    expect(
      bOutcome,
      `цепочечный await A; await B при непустой очереди: B — легитимное внешнее ` +
        `событие, должно резолвиться, а НЕ реджектиться как реентрант (получено: ${bOutcome})`,
    ).toBe('RESOLVED_TRUE')
  })

  it('КОНТРОЛЬ: истинный реентрант — `await sm.fireEvent` ПРЯМО из onEnter — по-прежнему реджектится (не регресс детекта)', async () => {
    interface Box {
      state: string
    }

    // Истинный реентрант: onEnter 'A' делает ВЛОЖЕННЫЙ await sm.fireEvent('inner')
    // ПРЯМО в стеке дренажа. Это НЕ должно виснуть — детект обязан реджектить.
    // GREEN держит этот кейс красным-детектом (reject), а НЕ ложно-зелёным.
    let sm!: StateMachine<Box, any>
    const config: StateMachineConfig<Box> = {
      name: 'P3TrueReentrant',
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

    const outcome = await Promise.race([classify(sm.fireEvent('go')), hangMarker(1500)])

    // Истинный реентрант обязан быть отклонён внятной ошибкой (а не зависнуть).
    expect(
      outcome,
      `истинный реентрантный await fireEvent из onEnter должен реджектиться ` +
        `внятной ошибкой, а не виснуть/резолвиться (получено: ${outcome})`,
    ).toBe('REENTRANT_REJECT')
  })

  it('(б) fireEvent из config-level onError (восстановление) → встаёт в очередь, не reject', async () => {
    // onError — легитимная точка error-recovery: внутреннее событие бросает,
    // onError выпускает восстановительный fireEvent. processError гоняет
    // обработчик ВНЕ drain-контекста (drainContext.exit), поэтому этот fire
    // ставится в очередь и резолвится, а не ложно ловится как реентрант.
    interface Box {
      state: string
    }
    let recover = 'pending'
    let smRef: StateMachine<Box, any>
    const config: StateMachineConfig<Box> = {
      name: 'RecoverViaOnError',
      stateAttribute: 'state',
      initialState: 'running',
      onError: () => {
        smRef.fireEvent('recover').then(
          () => {
            recover = 'RESOLVED'
          },
          (e: Error) => {
            recover = `REJECTED:${e.message.slice(0, 30)}`
          },
        )
      },
      states: {
        running: { invoke: [{ delay: 5, event: 'tick' }] },
        boom: {
          onEnter: () => {
            throw new Error('BOOM in onEnter')
          },
        },
        safe: {},
      },
      events: {
        tick: { transitions: [{ from: 'running', to: 'boom' }] },
        recover: { transitions: [{ from: 'boom', to: 'safe' }] },
      },
    }
    smRef = new StateMachine<Box, typeof config>(config, new MemoryAdapter<Box>({ state: 'running' }))
    await sleep(150)
    expect(recover, 'fireEvent из onError ложно отклонён как реентрантный').toBe('RESOLVED')
    expect(smRef.getCurrentState()).toBe('safe')
  })

  it('(г) fireEvent для ВТОРОГО adaptee во время дренажа первого → встаёт в очередь', async () => {
    // Один StateMachine, два независимых adaptee. Событие для B, пришедшее пока
    // async-onEnter объекта A держит дренаж, — не реентрантность (другой
    // логический контекст), должно встать в очередь и обработаться.
    interface Box {
      state: string
    }
    const config: StateMachineConfig<Box> = {
      name: 'TwoAdaptee',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        working: {
          onEnter: async () => {
            await sleep(60)
          },
        },
        done: {},
      },
      events: {
        start: { transitions: [{ from: 'idle', to: 'working' }] },
      },
    }
    const sm = new StateMachine<Box, typeof config>(config, new MemoryAdapter<Box>({ state: 'idle' }))
    const a = new MemoryAdapter<Box>({ state: 'idle' })
    const b = new MemoryAdapter<Box>({ state: 'idle' })
    const pA = sm.fireEvent('start', a)
    let rb = 'pending'
    setTimeout(() => {
      sm.fireEvent('start', b).then(
        () => {
          rb = 'RESOLVED'
        },
        (e: Error) => {
          rb = `REJECTED:${e.message.slice(0, 30)}`
        },
      )
    }, 20)
    await pA
    await sleep(120)
    expect(rb, 'событие для второго adaptee ложно отклонено как реентрантное').toBe('RESOLVED')
    expect(b.get('state')).toBe('working')
  })
})

// ---------------------------------------------------------------------------
// П2 №2 — двойной recordError на падении ВНУТРЕННЕГО события
// ---------------------------------------------------------------------------
describe('П2 №2: recordError не должен задваиваться на падении внутреннего события', () => {
  it('внутреннее (invoke) событие, чей applyTransition бросает → monitor.recordError вызван РОВНО 1 раз (HEAD: 2)', async () => {
    const { monitor, errors } = makeSpyMonitor()

    interface Box {
      state: string
    }

    // Вход в 'running' арматирует invoke-таймер, который через 5мс поднимает
    // ВНУТРЕННЕЕ событие 'tick'. tick: running -> boom. onEnter 'boom' БРОСАЕТ.
    // Путь: executeQueuedTransition.applyTransition(...).catch → recordError #1 +
    // rethrow → processQueues internal-catch → reportRuntimeError → recordError #2.
    // errorState НЕ задан (иначе Phase 6 ушёл бы в error-state без rethrow).
    const config: StateMachineConfig<Box> = {
      name: 'P2DoubleRecord',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        running: {
          invoke: [{ delay: 5, event: 'tick' }],
        },
        boom: {
          onEnter: () => {
            throw new Error('boom onEnter failed')
          },
        },
      },
      events: {
        go: { transitions: [{ from: 'idle', to: 'running' }] },
        tick: { transitions: [{ from: 'running', to: 'boom' }] },
      },
    }

    const adaptee = new MemoryAdapter<Box>({ state: 'idle' })
    const sm = new StateMachine<Box, typeof config>(config, adaptee, { monitor })

    const ok = await sm.fireEvent('go')
    expect(ok).toBe(true)

    // Ждём invoke(5мс) → raiseEvent('tick') → дренаж → applyTransition бросает.
    await sleep(150)

    // Падение ОДНОГО внутреннего события = ОДНА ошибка → РОВНО один recordError.
    // HEAD: 2 (executeQueuedTransition + reportRuntimeError) → RED.
    expect(
      errors.length,
      `падение одного внутреннего события должно дать РОВНО один monitor.recordError ` +
        `(задвоенные счётчики фатальны для количественных оракулов sim W5); ` +
        `получено recordError=${errors.length}`,
    ).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// П8 №1 — maxTransitionDepth: легитимный конечный каскад >100 не должен убиваться
// ---------------------------------------------------------------------------
describe('П8 №1: options.maxTransitionDepth поднимает захардкоженный порог 100', () => {
  it('легитимный КОНЕЧНЫЙ внутренний каскад из 150 переходов + options.maxTransitionDepth:200 → доходит до конца (HEAD: option игнорится, run-away на 100)', async () => {
    // Gated-pipeline: ping-pong ЗАВЕРШЁННОСТИ (done.state) между сиблингами P/Q
    // одного региона — самоподдерживающийся ВНУТРЕННИЙ каскад, но КОНЕЧНЫЙ (guard
    // steps<150). Каждый внутренний done.state инкрементит transitionDepth; без
    // сброса он достигает ~150. Захардкоженный MAX_TRANSITION_DEPTH=100 убил бы
    // каскад на 100-м. options.maxTransitionDepth:200 (по образцу maxQueueDepth)
    // должен поднять порог, чтобы легитимные 150 дошли до 'stopped'.
    const CHAIN = 150

    interface Box {
      state: string
      steps: number
    }
    const { monitor, errors } = makeSpyMonitor()
    let onErrorCalls = 0

    const config: StateMachineConfig<Box> = {
      name: 'P8MaxDepthOption',
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
    // maxTransitionDepth ещё НЕ в StateMachineOptions на HEAD → cast as any.
    // На HEAD опция игнорится (порог остаётся 100); на GREEN поднимает до 200.
    const sm = new StateMachine<Box, typeof config>(config, adaptee, {
      monitor,
      maxTransitionDepth: 200,
    } as any)

    await sm.fireEvent('start')
    await sleep(300)

    // GREEN: легитимные 150 внутренних переходов выполнены, каскад завершился в
    // 'stopped'. HEAD: run-away на захардкоженном 100 оборвал каскад → steps<150.
    expect(
      adaptee.adaptee.steps,
      `легитимный конечный каскад из ${CHAIN} переходов при maxTransitionDepth:200 ` +
        `должен дойти до конца; на HEAD опция игнорится и захардкоженный ` +
        `MAX_TRANSITION_DEPTH=100 обрывает каскад. steps=${adaptee.adaptee.steps}, ` +
        `state=${sm.getCurrentState()}, recordError=${errors.length}, onError=${onErrorCalls}`,
    ).toBe(CHAIN)

    expect(
      sm.getCurrentState(),
      `каскад должен завершиться в 'stopped' (state=${sm.getCurrentState()})`,
    ).toBe('stopped')
  })
})
