import { describe, expect, it } from 'vitest'
import { StateMachine } from '../state_machine'
import { MemoryAdapter } from '../types'
import { StateMachineMonitor } from '../monitoring'

// ─────────────────────────────────────────────────────────────────────────────
// Волна W4.1 — доработка W4 по critic-приёмке. РОЛЬ: RED.
//
// Все три сценария КРАСНЫ на HEAD и должны позеленеть только после фикса src
// (state_machine.ts / monitoring.ts). Проверки — через ПУБЛИЧНЫЙ контракт
// (fireEvent / fireEventDetailed, инъекция monitor, getMonitoringReport /
// getMetrics). Src не чинить.
//
//   #1  health лжёт в ОБРАТНУЮ сторону: guard-REJECTED (штатный отказ) растит
//       errorCount → здоровая машина рапортует 'critical'.
//   #2  invokeRestartCount — глобальный Map на машине + глобальный clm.clear()
//       обходит livelock-bound W3b.1 в мультиowner (коммит одного владельца
//       обнуляет счётчик другого → неограниченный relaunch).
//   #3  errorState-путь: detailed возвращает fired:true, хотя монитор записал
//       failed и машина ушла в err — два публичных канала противоречат.
// ─────────────────────────────────────────────────────────────────────────────

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

// Документированный livelock-bound W3b.1 (state_machine.ts: MAX_INVOKE_RESTARTS).
// Ссылаемся на него как на наблюдаемую границу перезапусков, не на приватное поле.
const MAX_INVOKE_RESTARTS = 3

// ── #1 — health лжёт в ОБРАТНУЮ сторону ───────────────────────────────────────
describe('W4.1 #1 — health не лжёт: guard-отказ ≠ error', () => {
  it('обратная ложь: 10 успехов + 2 guard-rejected → health НЕ critical', async () => {
    const monitor = new StateMachineMonitor()

    const config = {
      name: 'ReverseHealthLie',
      initialState: 'a',
      stateAttribute: 'state',
      states: { a: {}, b: {} },
      events: {
        // Успешный переход, тумблер a<->b (10 успехов).
        toggle: {
          transitions: [
            { from: 'a', to: 'b' },
            { from: 'b', to: 'a' },
          ],
        },
        // ШТАТНЫЙ отказ перехода — guard отвергает. Это НЕ ошибка машины.
        blocked: {
          transitions: [{ from: 'a', to: 'b', guard: () => false }],
        },
      },
    }

    const adapter = new MemoryAdapter({ state: 'a' })
    const sm = new StateMachine(config as any, adapter, {
      monitor: monitor as any,
    })

    // 10 успешных переходов (чётное число => машина снова в 'a').
    for (let i = 0; i < 10; i++) {
      await sm.fireEvent('toggle')
    }
    expect(sm.getCurrentState()).toBe('a')

    // 2 guard-отказа — ШТАТНЫЙ отказ, не ошибка.
    await sm.fireEvent('blocked')
    await sm.fireEvent('blocked')
    await tick(0)

    const report = monitor.getMonitoringReport()

    // HEAD: recordTransition(_, false) на guard-отказе зовёт recordError =>
    // errorCount=2, errorRate = 2/12 = 16.7% ≥ 15% => health 'critical' на
    // ЗДОРОВОЙ машине (10 успехов, всего 2 штатных отказа) — КРАСНО.
    // После фикса: guard-отказ НЕ error => health 'healthy'/'warning', не critical.
    expect(report.health.status).not.toBe('critical')
  })

  it('прямая ложь остаётся закрытой: guard-error (сломанная машина) → critical', async () => {
    const monitor = new StateMachineMonitor()

    const config = {
      name: 'GenuineErrorStaysCritical',
      initialState: 'a',
      stateAttribute: 'state',
      states: { a: {}, b: {} },
      events: {
        boom: {
          transitions: [
            {
              from: 'a',
              to: 'b',
              guard: () => {
                throw new Error('guard-throw')
              },
            },
          ],
        },
      },
    }

    const sm = new StateMachine(config as any, new MemoryAdapter({ state: 'a' }), {
      monitor: monitor as any,
    })

    // НАСТОЯЩАЯ ошибка (guard бросил) => recordError.
    await sm.fireEvent('boom').catch(() => {})
    await tick(0)

    const report = monitor.getMonitoringReport()

    // Прямая ложь EO-3 остаётся закрытой: реально сломанная машина => 'critical'.
    // Зелено и на HEAD, и после фикса (страховка от гиперкоррекции: фикс не должен
    // глушить ГЕНУИННЫЕ ошибки).
    expect(report.health.status).toBe('critical')
  })

  it('прямая ложь остаётся закрытой: action-throw без errorState → critical', async () => {
    const monitor = new StateMachineMonitor()

    const config = {
      name: 'ActionThrowStaysCritical',
      initialState: 'a',
      stateAttribute: 'state',
      states: {
        a: {},
        b: {
          onEnter: () => {
            throw new Error('enter-throw')
          },
        },
      },
      events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
    }

    const sm = new StateMachine(config as any, new MemoryAdapter({ state: 'a' }), {
      monitor: monitor as any,
    })

    await sm.fireEvent('go').catch(() => {})
    await tick(0)

    const report = monitor.getMonitoringReport()
    expect(report.health.status).toBe('critical')
  })
})

// ── #2 — invokeRestartCount мультиowner обходит livelock-bound ─────────────────
describe('W4.1 #2 — invoke-restart bound не обходится в мультиowner', () => {
  it('коммит владельца B не обнуляет restart-счётчик владельца A (каждый bounded)', async () => {
    // Считаем запуски invoke-операции ПО ВЛАДЕЛЬЦУ (adaptee-идентичность).
    const launches = new Map<object, number>()

    const config = {
      name: 'MultiOwnerRestartBound',
      initialState: 'idle',
      stateAttribute: 'state',
      states: {
        idle: {},
        working: {
          // Детерминированно-бросающий onExit: любой выход из 'working' срывается
          // в abort (abortOnExitError) => микрошаг не коммитит, владелец остаётся
          // в 'working', операция релончится (bounded W3b.1).
          onExit: () => {
            throw new Error('exit-boom')
          },
          invoke: [
            {
              src: (adaptee: any, _signal: AbortSignal) => {
                launches.set(adaptee, (launches.get(adaptee) ?? 0) + 1)
                // Никогда не резолвится — живёт до abort().
                return new Promise<never>(() => {})
              },
            },
          ],
        },
        gone: {},
        // Благонадёжный цикл владельца B — источник УСПЕШНЫХ коммитов.
        p: {},
        q: {},
      },
      events: {
        go: { transitions: [{ from: 'idle', to: 'working' }] },
        leave: { transitions: [{ from: 'working', to: 'gone' }] },
        bToggle: {
          transitions: [
            { from: 'p', to: 'q' },
            { from: 'q', to: 'p' },
          ],
        },
      },
    }

    const adA = new MemoryAdapter({ state: 'idle' })
    const adB = new MemoryAdapter({ state: 'p' })
    const sm = new StateMachine(config as any, adA as any, {
      abortOnExitError: true,
    } as any)

    // A входит в 'working' — операция запускается впервые.
    await sm.fireEvent('go', adA as any)
    expect(adA.adaptee.state).toBe('working')
    await tick(15)
    // Стартовый запуск (не через restart-счётчик).
    expect(launches.get(adA.adaptee) ?? 0).toBe(1)

    // A многократно пытается выйти (каждый leave => abort => relaunch),
    // между попытками владелец B КОММИТИТ успешный переход.
    const LEAVE_ATTEMPTS = 8
    for (let i = 0; i < LEAVE_ATTEMPTS; i++) {
      await sm.fireEvent('leave', adA as any) // abort-exit, счётчик 'working'++
      await sm.fireEvent('bToggle', adB as any) // УСПЕШНЫЙ коммит B
      await tick(15) // релончённая операция A успевает вызвать src
    }

    // A так и не покинул 'working' (все выходы срывались в abort).
    expect(adA.adaptee.state).toBe('working')

    const aLaunches = launches.get(adA.adaptee) ?? 0

    // Границей relaunch-ей владельца A является MAX_INVOKE_RESTARTS: стартовый
    // запуск + не более MAX перезапусков => src вызывается ≤ 1 + MAX раз.
    //
    // HEAD: invokeRestartCount — ГЛОБАЛЬНЫЙ Map на машине, commitConfiguration
    // делает .clear() ГЛОБАЛЬНО => каждый коммит B обнуляет счётчик A =>
    // A релончится на КАЖДЫЙ leave (1 + LEAVE_ATTEMPTS = 9) — bound обойдён (КРАСНО).
    // После фикса (WeakMap<owner, Map<leaf,count>>, clear только exit-set
    // коммитящего владельца): A bounded независимо => aLaunches ≤ 1 + MAX = 4.
    expect(aLaunches).toBeLessThanOrEqual(1 + MAX_INVOKE_RESTARTS)
  })
})

// ── #3 — errorState detailed противоречит монитору/состоянию ───────────────────
describe('W4.1 #3 — errorState detailed: fired отражает уход в error-state', () => {
  it('fireEventDetailed + errorState + onEnter-throw → fired:false (не true)', async () => {
    const config = {
      name: 'ErrorStateDetailed',
      initialState: 'a',
      stateAttribute: 'state',
      states: {
        a: {},
        b: {
          onEnter: () => {
            throw new Error('enter-fail')
          },
        },
        err: {},
      },
      events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
    }

    const sm = new StateMachine(config as any, new MemoryAdapter({ state: 'a' }), {
      errorState: 'err',
    })

    const result: any = await sm.fireEventDetailed('go')

    // Санити: машина реально ушла в error-state (уход, не успех).
    expect(sm.getCurrentState()).toBe('err')

    // HEAD: error-state коммитит errorConfig (truthy) => processTransition падает
    // в ветку {fired:true, transitions:[a→b]}, хотя монитор записал failed и
    // машина в 'err' — два публичных канала противоречат (КРАСНО).
    // После фикса: detailed.fired должен согласовываться с монитором/состоянием =>
    // fired:false (переход в целевое 'b' НЕ состоялся, произошёл уход в err).
    expect(result.fired).toBe(false)
  })
})
