import { describe, expect, it } from 'vitest'
import { StateMachine } from '../state_machine'
import { MemoryAdapter } from '../types'

// ─────────────────────────────────────────────────────────────────────────────
// W3b.1 — доработка W3b по critic-приёмке. РОЛЬ: RED.
//
// П.1д (MEDIUM-HIGH) — abort операции необратим при СОРВАВШЕМСЯ микрошаге.
//   abortOnExitError + onExit источника бросает → applyMicrostep уходит по
//   abort-exit: машина ВОЗВРАЩАЕТСЯ в исходный лист, НО invoke-операция этого
//   листа УЖЕ отменена в фазе exit (executeExitActions abort ДО onExit). На
//   abort-exit re-arm НЕ выполняется → операция мертва навсегда, её onDone
//   подавлен (signal.aborted) → тихий STALL: состояние = источник, onDone не
//   придёт, recordError = 0. Асимметрия с EO-5 (таймеры целы, операции — нет).
//   ФИКС: на этих путях (микрошаг НЕ закоммичен, машина в источнике) операция
//   ещё-активного исходного листа должна БЫТЬ ЖИВА — перезапущена со СВЕЖИМ
//   signal (onDone может прийти) ЛИБО наблюдаемо отменена через recordError.
//
// П.7 (MEDIUM) — персистентность операционной формы сломана ТИХО.
//   serializeStateNodeAsync спредит ...inv → src-функция уходит в JSON.stringify
//   и МОЛЧА выпадает (invoke после сериализации = {onDone:'ok'} без src). После
//   fromJSON: invoke-entry без src → isInvokeOperation=false → resumeTimers идёт
//   в ТАЙМЕРНУЮ ветку → delay undefined → Math.max(0, undefined-elapsed)=NaN →
//   setTimer(cb,NaN)≈немедленно → raiseEvent(undefined) призрачные события.
//   ФИКС: (1) serialize маркирует/вырезает операционную форму (НЕ молча);
//   (2) resumeTimers/arm ГАРДит invoke-entry без числового delay И без src.
//
// Все проверки КРАСНЫ на HEAD. src НЕ чинить (по схеме). По схеме.
// ─────────────────────────────────────────────────────────────────────────────

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

describe('W3b.1 П.1д — abort операции при сорвавшемся микрошаге (abort-exit)', () => {
  it('abort-exit → операция листа-источника НЕ остаётся отменённой навсегда (жива/перезапущена ЛИБО recordError)', async () => {
    let srcCallCount = 0
    let onDoneFired = false
    const recorded: Error[] = []

    const monitor = {
      recordTransition() {},
      recordError(err: Error) {
        recorded.push(err)
      },
    }

    const config = {
      name: 'AbortExitStall',
      initialState: 'a',
      stateAttribute: 'state',
      states: {
        a: {
          // onExit источника бросает → под abortOnExitError микрошаг сорван,
          // машина возвращается в 'a'. НО invoke-операция 'a' уже отменена.
          onExit: () => {
            throw new Error('onExit-boom')
          },
          invoke: [
            {
              src: async (_adaptee: any, signal: AbortSignal) => {
                srcCallCount++
                // Достаточно долгая операция, чтобы быть ЕЩЁ в полёте в момент
                // fireEvent('go') (~t=10) и отмениться вместе с сорванным exit.
                await tick(40)
                // Отменённая операция ничего не поднимает; эта ветка нужна лишь
                // чтобы после перезапуска (fresh signal) onDone мог сработать.
                if (signal.aborted) return 'aborted'
                return 'op-result'
              },
              onDone: 'opDone',
            },
          ],
        },
        b: {},
        opTarget: {},
      },
      events: {
        // Транзиция, срывающая exit источника 'a'.
        go: { transitions: [{ from: 'a', to: 'b' }] },
        // Куда уйдёт машина, если операция ВЫЖИЛА и её onDone поднялся.
        opDone: { transitions: [{ from: 'a', to: 'opTarget' }] },
      },
    }

    const adapter = new MemoryAdapter({ state: 'a' })
    const sm = new StateMachine(config as any, adapter, {
      abortOnExitError: true,
      monitor: monitor as any,
    })

    // Дать операции стартовать (armStateInvoke: setTimer(startOp, 0)).
    await tick(10)
    expect(srcCallCount).toBe(1) // операция реально запущена и в полёте

    // Срываем микрошаг: onExit источника бросает → abort-exit → машина в 'a'.
    const fired = await sm.fireEvent('go')
    expect(fired).toBe(false) // микрошаг не закоммичен

    // Немедленно после срыва машина ВЕРНУЛАСЬ в источник (это корректно и на HEAD:
    // abort-exit возвращает в исходную конфигурацию).
    expect(sm.getCurrentState()).toBe('a')

    // Дать первичной (отменённой) операции доиграть и — при фиксе — перезапуску
    // завершиться и поднять onDone.
    await tick(80)

    if (sm.getCurrentState() === 'opTarget') onDoneFired = true

    const recordedForOp = recorded.some((e) =>
      /operation|cancel|abort/i.test(String(e?.message)),
    )

    // ЯКОРЬ RED (stall на HEAD): операция листа-источника мертва навсегда —
    // перезапуска нет (srcCallCount остался 1), onDone подавлен (не ушли в
    // opTarget), recordError по операции = 0. Ни одного признака «операция жива
    // либо наблюдаемо отменена» → false на HEAD.
    const operationSurvived =
      srcCallCount >= 2 || onDoneFired || recordedForOp
    expect(operationSurvived).toBe(true)
  })
})

describe('W3b.1 П.7 — round-trip машины с invoke-операцией не порождает призрачных событий', () => {
  it('toJSON → fromJSON: вход в лист с operation-invoke НЕ поднимает undefined-событие; src обработан явно', async () => {
    const warnMsgs: string[] = []
    const logger = {
      debug() {},
      info() {},
      warn(msg: string) {
        warnMsgs.push(String(msg))
      },
      error() {},
    }

    const config = {
      name: 'InvokeOpPersist',
      initialState: 'op',
      stateAttribute: 'state',
      states: {
        op: {
          invoke: [
            {
              // Операционная форма: src-функция, БЕЗ delay/event.
              src: async () => 'op-result',
              onDone: 'done',
            },
          ],
        },
        done: {},
      },
      events: {
        // Только реальный onDone-таргет; НИКАКОГО undefined-события в карте.
        // W3b.2 — 'done' объявлено (никакого INVOKE_UNKNOWN_EVENT), но перехода
        // ИЗ 'op' нет: операция РЕАЛЬНО стартует и РЕАЛЬНО завершается, её
        // onDone поднимается и штатно отбрасывается, а машина ОСТАЁТСЯ в 'op'.
        // Так снапшот по-прежнему берётся из листа с operation-invoke, но уже
        // НЕ в момент ПОЛЁТА операции: сериализация в полёте теперь отказ (см.
        // serialization_invoke_inflight.test.ts), и это ПРАВИЛЬНО — снапшот
        // «в полёте» восстанавливался в машину, где не работает ничего.
        done: { transitions: [{ from: 'done', to: 'done' }] },
      },
    }

    const adapter = new MemoryAdapter({ state: 'op' })
    const original = new StateMachine(config as any, adapter, {
      logger: logger as any,
    })

    // Дать операции стартовать И завершиться: после этого в полёте ничего нет,
    // а машина всё ещё в 'op' (guard выше не пустил переход).
    await tick(30)
    expect(original.getCurrentState()).toBe('op')

    // Сериализуем машину, находящуюся в листе 'op' с operation-invoke.
    const json = await original.toSecureJSON()
    const parsed = JSON.parse(json)
    expect(JSON.parse(json).currentState).toBe('op')

    // (проверка 1) src обработан ЯВНО — не молча выпал. На HEAD serialize спредит
    // ...inv, src-функция теряется в JSON.stringify, и в снапшоте остаётся голый
    // {onDone:'done'} без маркера/предупреждения.
    const invEntry: any = parsed?.config?.states?.op?.invoke?.[0]
    const handledExplicitly =
      invEntry === undefined || // вырезан из снапшота
      (invEntry &&
        (invEntry.type === 'operation' || // помечен маркером формы
          'name' in invEntry ||
          'id' in invEntry)) ||
      warnMsgs.some((m) => /operation not serializable|invoke operation/i.test(m))
    expect(handledExplicitly).toBe(true)

    // (проверка 2) round-trip НЕ порождает призрачное undefined-событие. На HEAD:
    // src выпал → isInvokeOperation=false → resumeTimers timer-ветка → delay
    // undefined → NaN-таймер ≈ немедленно → raiseEvent(undefined) →
    // executeQueuedTransition бросает "Invalid event: undefined" → recordError.
    const recorded: Error[] = []
    const restoreMonitor = {
      recordTransition() {},
      recordError(err: Error) {
        recorded.push(err)
      },
    }

    const restoreAdapter = new MemoryAdapter({ state: 'op' })
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const restored = await StateMachine.fromSecureJSON(json, restoreAdapter, {
      monitor: restoreMonitor as any,
    })

    // Дать NaN-таймеру resumeTimers сработать и призрачному событию слиться.
    await tick(30)

    const ghostRaised = recorded.some((e) =>
      /Invalid event:\s*undefined/i.test(String(e?.message)),
    )
    expect(ghostRaised).toBe(false)
  })
})

// W3b.1 residual (adversarial-verify): the throw branch (onEnter throw without
// errorState) also aborts source operations without commit → must relaunch too;
// and a deterministically-throwing onExit must NOT livelock the restart.
describe('W3b.1 residual — throw-branch relaunch + livelock bound', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('throw from onEnter without errorState relaunches the source operation (no stall)', async () => {
    let src = 0
    const cfg = {
      name: 't',
      stateAttribute: 'state',
      initialState: 'a',
      states: {
        a: { invoke: [{ src: async () => { src++; await sleep(25); return 'r' }, onDone: 'done' }] },
        b: { onEnter: () => { throw new Error('enter-boom') } },
        c: {},
      },
      events: {
        go: { transitions: [{ from: 'a', to: 'b' }] },
        done: { transitions: [{ from: 'a', to: 'c' }] },
      },
    } as any
    const sm = new StateMachine(cfg, new MemoryAdapter({ state: 'a' }) as any)
    await sleep(10)
    await sm.fireEvent('go').catch(() => {})
    await sleep(60)
    // Source operation was aborted by the failed microstep; the throw branch
    // relaunches it — src runs at least twice (original + restart).
    expect(src).toBeGreaterThanOrEqual(2)
  })

  it('a deterministically-throwing onExit does NOT livelock the restart (bounded)', async () => {
    let src = 0
    const cfg = {
      name: 'l',
      stateAttribute: 'state',
      initialState: 'a',
      states: {
        a: {
          invoke: [{ src: async () => { src++; return 'r' }, onDone: 'done' }],
          onExit: () => { throw new Error('always') },
        },
        b: {},
        c: {},
      },
      events: {
        go: { transitions: [{ from: 'a', to: 'b' }] },
        done: { transitions: [{ from: 'a', to: 'c' }] },
      },
    } as any
    const sm = new StateMachine(cfg, new MemoryAdapter({ state: 'a' }) as any, {
      abortOnExitError: true,
    })
    await sleep(10)
    await sm.fireEvent('go').catch(() => {})
    await sleep(120)
    // Bounded by MAX_INVOKE_RESTARTS (3) + initial — a handful, not hundreds.
    expect(src).toBeLessThanOrEqual(6)
  })
})
