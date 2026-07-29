import { describe, expect, it } from 'vitest'
import { StateMachine } from '../state_machine'
import { MemoryAdapter } from '../types'
import { StateMachineMonitor } from '../monitoring'
import * as PublicSurface from '../index'

// ─────────────────────────────────────────────────────────────────────────────
// Волна W4 — наблюдаемость. РОЛЬ: RED.
//
// Эти тесты фиксируют дефекты П6 / П9+EO-3 / abort-наблюдаемость / П13+EO-8.
// Все они КРАСНЫ на HEAD и должны позеленеть только после соответствующего
// фикса src. Проверки — через публичный контракт (fireEvent/fireEventDetailed,
// инъекция monitor, публичная поверхность index/monitoring). Src не чинить.
//
// ВАЖНО про мультиобъектность: публичный контракт — ОДНА машина на МНОЖЕСТВО
// объектов. Каждый объект оборачивается в свой MemoryAdapter (свой «владелец»);
// состояние живёт в объекте, а activeTimers/activeInvokes/historyMap —
// поля МАШИНЫ с ключом по ИМЕНИ состояния => коллизия между владельцами (П6).
// ─────────────────────────────────────────────────────────────────────────────

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

// ── П6: изоляция таймеров/операций по ВЛАДЕЛЬЦУ ───────────────────────────────
describe('W4 П6 — таймеры/операции изолированы по владельцу, не гасят друг друга', () => {
  it('(1a) таймер: выход владельца a НЕ гасит invoke-таймер владельца b в том же состоянии', async () => {
    const config = {
      name: 'TimerIsolation',
      initialState: 'idle',
      stateAttribute: 'state',
      states: {
        idle: {},
        working: {
          invoke: [{ delay: 40, event: 'tick' }],
        },
        ticked: {},
        gone: {},
      },
      events: {
        go: { transitions: [{ from: 'idle', to: 'working' }] },
        tick: { transitions: [{ from: 'working', to: 'ticked' }] },
        leave: { transitions: [{ from: 'working', to: 'gone' }] },
      },
    }

    const a = { state: 'idle' }
    const b = { state: 'idle' }
    const adA = new MemoryAdapter(a)
    const adB = new MemoryAdapter(b)

    // Первый адаптер — «первичный» (конструктор входит в initial 'idle' для a).
    const sm = new StateMachine(config as any, adA as any)

    // a входит в состояние с таймером.
    await sm.fireEvent('go', adA as any)
    expect(a.state).toBe('working')
    // b входит в ТО ЖЕ состояние — на HEAD запись таймера a затирается общим
    // ключом 'working'.
    await sm.fireEvent('go', adB as any)
    expect(b.state).toBe('working')

    // a покидает 'working'. На HEAD teardownStateTimers('working') снимает
    // таймеры ВСЕХ владельцев в этом состоянии (в т.ч. живой таймер b).
    await sm.fireEvent('leave', adA as any)
    expect(a.state).toBe('gone')

    // Ждём срабатывания таймера b (delay 40).
    await tick(150)

    // ИЗОЛЯЦИЯ: таймер b должен был сработать сам по себе.
    // HEAD: таймер b погашен выходом a => b застрял в 'working' (КРАСНО).
    expect(b.state).toBe('ticked')
  })

  it('(1b) операция: выход владельца a НЕ обрывает invoke-операцию владельца b в том же состоянии', async () => {
    let releaseGate: () => void = () => {}
    const gate = new Promise<void>((res) => {
      releaseGate = res
    })

    const config = {
      name: 'OperationIsolation',
      initialState: 'idle',
      stateAttribute: 'state',
      states: {
        idle: {},
        working: {
          invoke: [
            {
              src: async (_adaptee: any, _signal: AbortSignal) => {
                await gate
                return 'RESULT'
              },
              onDone: 'ok',
            },
          ],
        },
        done: {},
        gone: {},
      },
      events: {
        go: { transitions: [{ from: 'idle', to: 'working' }] },
        ok: { transitions: [{ from: 'working', to: 'done' }] },
        leave: { transitions: [{ from: 'working', to: 'gone' }] },
      },
    }

    const a = { state: 'idle' }
    const b = { state: 'idle' }
    const adA = new MemoryAdapter(a)
    const adB = new MemoryAdapter(b)

    const sm = new StateMachine(config as any, adA as any)

    await sm.fireEvent('go', adA as any) // a: операция запущена
    await sm.fireEvent('go', adB as any) // b: операция запущена (тот же ключ)
    expect(a.state).toBe('working')
    expect(b.state).toBe('working')

    // a покидает лист. На HEAD executeExitActions abort()-ит activeInvokes
    // ключа 'working' — т.е. операцию b (общий ключ по имени состояния).
    await sm.fireEvent('leave', adA as any)
    expect(a.state).toBe('gone')

    // Отпускаем операции: у b (при изоляции) signal НЕ отменён => onDone → 'ok'.
    releaseGate()
    await tick(30)

    // ИЗОЛЯЦИЯ: операция b должна завершиться и поднять onDone.
    // HEAD: операция b отменена выходом a => onDone подавлен => b в 'working' (КРАСНО).
    expect(b.state).toBe('done')
  })
})

// ── П9 + EO-3: метрики честны на отказах ──────────────────────────────────────
describe('W4 П9/EO-3 — метрики честны на отказных путях', () => {
  it('(2a) отказной переход (guard-rejected) вызывает monitor.recordTransition(_, false)', async () => {
    const calls: Array<{ success: boolean }> = []
    const monitor = {
      recordTransition(_dt: number, success: boolean) {
        calls.push({ success })
      },
      recordError() {},
    }

    const config = {
      name: 'MetricsOnReject',
      initialState: 'a',
      stateAttribute: 'state',
      states: { a: {}, b: {} },
      events: {
        go: {
          transitions: [{ from: 'a', to: 'b', guard: () => false }],
        },
      },
    }

    const adapter = new MemoryAdapter({ state: 'a' })
    const sm = new StateMachine(config as any, adapter, { monitor: monitor as any })

    // Гард отвергает переход — это ОТКАЗ, наблюдаемый для sim W5.
    await sm.fireEvent('go')
    await tick(0)

    // HEAD: recordTransition зовётся ТОЛЬКО на успехе => на отказе нет вызова с
    // success=false (КРАСНО).
    const failCall = calls.find((c) => c.success === false)
    expect(failCall).toBeDefined()
  })

  it('(2b) EO-3: successCount не уходит в минус при отказах', () => {
    const monitor = new StateMachineMonitor()

    // Больше ошибок, чем успешных переходов (частый случай на сломанной машине).
    monitor.recordError(new Error('boom-1'))
    monitor.recordError(new Error('boom-2'))
    monitor.recordError(new Error('boom-3'))
    monitor.recordTransition(1, true)

    const metrics = monitor.getMetrics()

    // HEAD: successCount = totalTransitions - totalErrors = 1 - 3 = -2 (КРАСНО).
    expect(metrics.successCount).toBeGreaterThanOrEqual(0)
  })

  it("(2c) EO-3: машина с одними отказами и без успехов НЕ рапортует 'healthy'", () => {
    const monitor = new StateMachineMonitor()

    // Только ошибки, ноль переходов.
    monitor.recordError(new Error('boom-a'))
    monitor.recordError(new Error('boom-b'))

    const report = monitor.getMonitoringReport()

    // HEAD: errorRate = errors/transitions при 0 переходов = 0 => health 'healthy'
    // на реально сломанной машине (КРАСНО).
    expect(report.health.status).not.toBe('healthy')
  })
})

// ── abort-наблюдаемость: reason 'aborted' и recordTransition(_, false) ────────
describe('W4 abort — отменённый микрошаг наблюдаем и отличим от no-transition', () => {
  it("(3a) fireEventDetailed при abort даёт reason 'aborted', а не 'no-transition'", async () => {
    const config = {
      name: 'AbortReason',
      initialState: 'a',
      stateAttribute: 'state',
      states: {
        a: {
          onExit: function () {
            throw new Error('exit-boom')
          },
        },
        b: {},
      },
      events: {
        go: { transitions: [{ from: 'a', to: 'b' }] },
      },
    }

    const adapter = new MemoryAdapter({ state: 'a' })
    const sm = new StateMachine(config as any, adapter, {
      abortOnExitError: true,
    } as any)

    const result: any = await sm.fireEventDetailed('go')

    // Микрошаг НАЧАТ, но отменён на onExit-throw => не 'no-transition'.
    expect(result.fired).toBe(false)
    // HEAD: reason === 'no-transition' — неотличимо от «нет кандидата» (КРАСНО).
    expect(result.reason).toBe('aborted')
  })

  it('(3b) abort вызывает monitor.recordTransition(_, false)', async () => {
    const calls: Array<{ success: boolean }> = []
    const monitor = {
      recordTransition(_dt: number, success: boolean) {
        calls.push({ success })
      },
      recordError() {},
    }

    const config = {
      name: 'AbortMetric',
      initialState: 'a',
      stateAttribute: 'state',
      states: {
        a: {
          onExit: function () {
            throw new Error('exit-boom')
          },
        },
        b: {},
      },
      events: {
        go: { transitions: [{ from: 'a', to: 'b' }] },
      },
    }

    const adapter = new MemoryAdapter({ state: 'a' })
    const sm = new StateMachine(config as any, adapter, {
      abortOnExitError: true,
      monitor: monitor as any,
    } as any)

    await sm.fireEventDetailed('go')
    await tick(0)

    // HEAD: на abort-пути recordTransition не зовётся вовсе (КРАСНО).
    const failCall = calls.find((c) => c.success === false)
    expect(failCall).toBeDefined()
  })
})

// ── П13 + EO-8: наблюдаемость экспортирована, health/логгер управляемы ─────────
describe('W4 П13/EO-8 — наблюдаемость экспортирована из index', () => {
  it('(4a) monitoring surface экспортирован из index', () => {
    const surface = PublicSurface as Record<string, unknown>
    // HEAD: index не реэкспортирует monitoring runtime (только тип) (КРАСНО).
    expect(surface.StateMachineMonitor).toBeDefined()
    expect(typeof surface.createDefaultMonitor).toBe('function')
  })

  it('(4b) logger surface экспортирован и управляем из index', () => {
    const surface = PublicSurface as Record<string, unknown>
    // HEAD: logger.ts не реэкспортирован из index (КРАСНО).
    expect(surface.stateMachineLogger).toBeDefined()
    expect(typeof surface.setDefaultLogLevel).toBe('function')
  })

  it('(4c) StateMachine даёт публичный доступ к метрикам/монитору', () => {
    const config = {
      name: 'MonitorAccess',
      initialState: 'a',
      stateAttribute: 'state',
      states: { a: {}, b: {} },
      events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
    }
    const sm = new StateMachine(config as any, new MemoryAdapter({ state: 'a' }))
    const anySm = sm as any

    // HEAD: монитор доступен только как (sm as any).monitor — нет публичного
    // getMonitor/getMetrics (КРАСНО).
    const hasAccessor =
      typeof anySm.getMonitor === 'function' ||
      typeof anySm.getMetrics === 'function'
    expect(hasAccessor).toBe(true)
  })
})

// W4 residual (adversarial-verify): errorState recovery must be observable
// (was false-healthy), and a guard-error must not double-count in the monitor.
describe('W4 residual — errorState observability + guard-error single-count', () => {
  it('errorState recovery records a failed transition (not false-healthy)', async () => {
    let failCount = 0
    const monitor = {
      recordTransition(_d: number, ok: boolean) { if (!ok) failCount++ },
      recordError() {},
    }
    const cfg = {
      name: 'es',
      stateAttribute: 'state',
      initialState: 'a',
      states: { a: {}, b: { onEnter: () => { throw new Error('enter-fail') } }, err: {} },
      events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
    } as any
    const sm = new StateMachine(cfg, new MemoryAdapter({ state: 'a' }) as any, {
      monitor: monitor as any,
      errorState: 'err',
    })
    await sm.fireEvent('go').catch(() => {})
    expect(sm.getCurrentState()).toBe('err')
    expect(failCount).toBe(1)
  })

  it('a guard-error is counted ONCE in the default monitor (not doubled)', async () => {
    const cfg = {
      name: 'ge',
      stateAttribute: 'state',
      initialState: 'a',
      states: { a: {}, b: {} },
      events: { go: { transitions: [{ from: 'a', to: 'b', guard: () => { throw new Error('g') } }] } },
    } as any
    const sm = new StateMachine(cfg, new MemoryAdapter({ state: 'a' }) as any)
    await sm.fireEvent('go').catch(() => {})
    expect(sm.getMetrics()?.errorCount).toBe(1)
  })
})
