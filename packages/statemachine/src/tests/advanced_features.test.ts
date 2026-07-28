import { describe, expect, it } from 'vitest'
import { StateMachine } from '../state_machine'
import { MemoryAdapter } from '../types'

describe('Advanced Features: Wildcards & Timers', () => {
  // TASK-004: TimerScheduler.getInstance() removed; each StateMachine gets its own scheduler.
  // These tests use native setTimeout (default scheduler is not started), so no explicit cleanup needed.

  // --- Тест таймеров ---
  it('should automatically transition using "invoke" (Time-based)', async () => {
    const config = {
      name: 'TimerSM',
      initialState: 'red',
      stateAttribute: 'state',
      states: {
        red: {
          invoke: [{ delay: 100, event: 'next' }], // Через 100мс вызвать 'next'
        },
        green: {},
      },
      events: {
        next: {
          transitions: [{ from: 'red', to: 'green' }],
        },
      },
    } as const

    const adapter = new MemoryAdapter({ state: 'red' })
    const sm = new StateMachine(config as any, adapter)

    expect(sm.getCurrentState()).toBe('red')

    // Ждем > 100мс
    await new Promise((r) => setTimeout(r, 200))

    expect(sm.getCurrentState()).toBe('green')
  })

  // --- Тест отмены таймеров ---
  it('should cancel timer if state exited manually', async () => {
    const config = {
      name: 'CancelTimerSM',
      initialState: 'red',
      stateAttribute: 'state',
      states: {
        red: {
          invoke: [{ delay: 500, event: 'timeout' }], // Долгое ожидание
        },
        green: {},
        error: {},
      },
      events: {
        manual: { transitions: [{ from: 'red', to: 'green' }] },
        timeout: { transitions: [{ from: 'red', to: 'error' }] },
      },
    } as const

    const adapter = new MemoryAdapter({ state: 'red' })
    const sm = new StateMachine(config as any, adapter)

    // Ручной переход сразу же
    await sm.fireEvent('manual')
    expect(sm.getCurrentState()).toBe('green')

    // Ждем, пока таймер мог бы сработать
    await new Promise((r) => setTimeout(r, 600))

    // Должны остаться в green, таймер не должен был перекинуть в error
    expect(sm.getCurrentState()).toBe('green')
  })

  // --- Тест Wildcard ---
  it('should use wildcard event handler if specific event not found', async () => {
    const config = {
      name: 'WildcardSM',
      initialState: 'idle',
      stateAttribute: 'state',
      states: { idle: {}, active: {}, stopped: {} },
      events: {
        start: { transitions: [{ from: 'idle', to: 'active' }] },
        '*': {
          // Catch-all
          transitions: [{ from: 'active', to: 'stopped' }],
        },
      },
    } as const

    const adapter = new MemoryAdapter({ state: 'idle' })
    const sm = new StateMachine(config as any, adapter)

    await sm.fireEvent('start')
    expect(sm.getCurrentState()).toBe('active')

    // Вызываем несуществующее событие 'stop_now'
    // Так как его нет в конфиге, SM должен искать '*'
    await sm.fireEvent('stop_now' as any)

    expect(sm.getCurrentState()).toBe('stopped')
  })

  // --- Тест сериализации таймеров ---
  it('should restore timers after serialization', async () => {
    const config = {
      name: 'PersistenceSM',
      initialState: 'waiting',
      stateAttribute: 'state',
      states: {
        waiting: {
          invoke: [{ delay: 500, event: 'timeout' }],
        },
        timeout: {},
      },
      events: {
        timeout: { transitions: [{ from: 'waiting', to: 'timeout' }] },
      },
    } as const

    const adapter = new MemoryAdapter({ state: 'waiting' })
    const sm1 = new StateMachine(config as any, adapter)

    expect(sm1.getCurrentState()).toBe('waiting')

    // Ждем половину времени
    await new Promise((r) => setTimeout(r, 250))

    // Сохраняем состояние
    const json = sm1.toJSON()

    // Создаем новую машину из JSON
    const adapter2 = new MemoryAdapter({ state: '' })
    const sm2 = StateMachine.fromJSON(json, adapter2)

    expect(sm2.getCurrentState()).toBe('waiting')

    // Ждем оставшееся время + немного сверху
    // Если таймер сбросился, то 300мс не хватит (нужно еще 500)
    // Если восстановился корректно, то нужно 250, так что 300 хватит
    await new Promise((r) => setTimeout(r, 450))

    expect(sm2.getCurrentState()).toBe('timeout')
  })

  // --- Тест расширенного invoke (cond & action) ---
  it('should handle invoke with cond and action', async () => {
    let actionCalled = false
    const config = {
      name: 'AdvancedInvokeSM',
      initialState: 'start',
      stateAttribute: 'state',
      states: {
        start: {
          invoke: [
            {
              delay: 100,
              event: 'to_success',
              cond: (ctx: any) => ctx.shouldWork,
              action: () => {
                actionCalled = true
              },
            },
            {
              delay: 100,
              event: 'to_fail',
              cond: (ctx: any) => !ctx.shouldWork,
            },
          ],
        },
        success: {},
        fail: {},
      },
      events: {
        to_success: { transitions: [{ from: 'start', to: 'success' }] },
        to_fail: { transitions: [{ from: 'start', to: 'fail' }] },
      },
    }

    // Case 1: cond = true
    const adapter1 = new MemoryAdapter({ state: 'start', shouldWork: true })
    const sm1 = new StateMachine(config as any, adapter1)
    await new Promise((r) => setTimeout(r, 200))
    expect(sm1.getCurrentState()).toBe('success')
    expect(actionCalled).toBe(true)

    // Case 2: cond = false
    const adapter2 = new MemoryAdapter({ state: 'start', shouldWork: false })
    const sm2 = new StateMachine(config as any, adapter2)
    await new Promise((r) => setTimeout(r, 200))
    expect(sm2.getCurrentState()).toBe('fail')
  })

  // --- Дополнительные тесты ---

  it('should handle mixed invocations (some with cond, some without)', async () => {
    const config = {
      name: 'MixedInvokeSM',
      initialState: 'start',
      stateAttribute: 'state',
      states: {
        start: {
          invoke: [
            // Этот должен быть проигнорирован
            {
              delay: 50,
              event: 'to_ignored',
              cond: () => false,
            },
            // Этот должен сработать
            {
              delay: 100,
              event: 'to_success',
            },
          ],
        },
        ignored: {},
        success: {},
      },
      events: {
        to_ignored: { transitions: [{ from: 'start', to: 'ignored' }] },
        to_success: { transitions: [{ from: 'start', to: 'success' }] },
      },
    }

    const adapter = new MemoryAdapter({ state: 'start' })
    const sm = new StateMachine(config as any, adapter)

    // Ждем, пока первый таймер мог бы сработать (50мс), но меньше второго (100мс)
    await new Promise((r) => setTimeout(r, 75))
    expect(sm.getCurrentState()).toBe('start')

    // Ждем срабатывания второго
    await new Promise((r) => setTimeout(r, 100))
    expect(sm.getCurrentState()).toBe('success')
  })

  it('should gracefully handle errors in invoke conditions', async () => {
    const config = {
      name: 'ErrorCondSM',
      initialState: 'start',
      stateAttribute: 'state',
      states: {
        start: {
          invoke: [
            {
              delay: 50,
              event: 'to_fail',
              cond: () => {
                throw new Error('Condition Error')
              },
            },
            {
              delay: 100,
              event: 'to_success',
            },
          ],
        },
        fail: {},
        success: {},
      },
      events: {
        to_fail: { transitions: [{ from: 'start', to: 'fail' }] },
        to_success: { transitions: [{ from: 'start', to: 'success' }] },
      },
    }

    const adapter = new MemoryAdapter({ state: 'start' })
    const sm = new StateMachine(config as any, adapter)

    // Ждем, пока первый мог бы сработать. Из-за ошибки в cond он не должен быть запланирован.
    await new Promise((r) => setTimeout(r, 75))
    expect(sm.getCurrentState()).toBe('start')

    // Ждем второй
    await new Promise((r) => setTimeout(r, 100))
    expect(sm.getCurrentState()).toBe('success')
  })

  it('should prevent event fire if invoke action throws', async () => {
    const config = {
      name: 'ErrorActionSM',
      initialState: 'start',
      stateAttribute: 'state',
      states: {
        start: {
          invoke: [
            {
              delay: 50,
              event: 'to_fail',
              action: () => {
                throw new Error('Action Error')
              },
            },
            {
              delay: 100,
              event: 'to_success',
            },
          ],
        },
        fail: {},
        success: {},
      },
      events: {
        to_fail: { transitions: [{ from: 'start', to: 'fail' }] },
        to_success: { transitions: [{ from: 'start', to: 'success' }] },
      },
    }

    const adapter = new MemoryAdapter({ state: 'start' })
    const sm = new StateMachine(config as any, adapter)

    // Первый таймер срабатывает через 50мс, но action падает -> event не отправляется
    await new Promise((r) => setTimeout(r, 75))
    expect(sm.getCurrentState()).toBe('start')

    // Второй таймер срабатывает через 100мс
    await new Promise((r) => setTimeout(r, 100))
    expect(sm.getCurrentState()).toBe('success')
  })

  it('should restore invoke with conditions after serialization', async () => {
    const config = {
      name: 'PersistenceCondSM',
      initialState: 'start',
      stateAttribute: 'state',
      states: {
        start: {
          invoke: [
            {
              delay: 100,
              event: 'to_check',
              cond: (ctx: any) => ctx.valid === true,
            },
          ],
        },
        checked: {},
      },
      events: {
        to_check: { transitions: [{ from: 'start', to: 'checked' }] },
      },
    }

    const adapter1 = new MemoryAdapter({ state: 'start', valid: true })
    const sm1 = new StateMachine(config as any, adapter1)

    // Сохраняем сразу
    const json = sm1.toJSON()

    // Восстанавливаем с ДРУГИМ контекстом (valid=false)
    // Условие должно провериться заново при восстановлении
    // W0: the invoke `cond` serializes under its inferred name 'cond'; supply
    // it via the registry so restoration resolves the reference (never a
    // recompiled body). The restored cond re-reads the new context's `valid`.
    const condRegistry = { actions: { cond: (ctx: any) => ctx.valid === true } }
    const adapter2 = new MemoryAdapter({ state: '', valid: false })
    const sm2 = StateMachine.fromJSON(json, adapter2, condRegistry)

    expect(sm2.getCurrentState()).toBe('start')

    // Ждем > 100мс
    await new Promise((r) => setTimeout(r, 150))

    // Переход НЕ должен произойти, так как valid=false
    expect(sm2.getCurrentState()).toBe('start')

    // Теперь восстанавливаем с valid=true
    const adapter3 = new MemoryAdapter({ state: '', valid: true })
    const sm3 = StateMachine.fromJSON(json, adapter3, condRegistry)

    // Ждем > 100мс
    await new Promise((r) => setTimeout(r, 150))

    // Переход должен произойти
    expect(sm3.getCurrentState()).toBe('checked')
  })

  it('does not compile or execute a function-body string injected into onEnter', async () => {
    // W0 B2 — honest replacement for the former "reject unsafe legacy function
    // strings" test, which injected via `.replace('"onEnter":null', …)`. That
    // token never existed in the serialized JSON (serializeAction drops falsy
    // handlers, so JSON.stringify omits the key entirely), making the replace a
    // no-op: the test asserted only `toBeDefined()` and could not go red under
    // ANY implementation — pure test theater.
    //
    // This version injects into a handler that is REALLY present in the JSON and
    // asserts real behavior: an attacker-controlled function-body string placed
    // in onEnter must be neither compiled into a callable nor executed. On the
    // vulnerable (body-compiling) code path both assertions go red.
    const MARKER = '__w0_b2_onenter_marker__'
    delete (globalThis as any)[MARKER]

    // Target-state onEnter is a real, present-in-JSON string reference.
    // serializeAction passes strings through untouched, so the token appears
    // verbatim in the serialized JSON and can be swapped for a forged body.
    const config = {
      name: 'OnEnterInjectSM',
      initialState: 'a',
      stateAttribute: 'state',
      states: {
        a: {},
        b: { onEnter: '__legit_onEnter__' },
      },
      events: {
        go: { transitions: [{ from: 'a', to: 'b' }] },
      },
    }
    const sm = new StateMachine(config as any, new MemoryAdapter({ state: 'a' }))
    const json = sm.toJSON()

    // Guard against silent-no-op injection (the exact defect this test replaces):
    // the onEnter reference MUST really be present in the serialized JSON.
    expect(json).toContain('"onEnter":"__legit_onEnter__"')

    // Forge a raw arrow-function-body string that stamps a global marker.
    const body = "() => { globalThis['" + MARKER + "'] = 'pwned'; return true }"
    const maliciousJson = json.replace(
      '"__legit_onEnter__"',
      JSON.stringify(body),
    )
    expect(maliciousJson).toContain(MARKER) // injection actually landed

    const restored = StateMachine.fromJSON(
      maliciousJson,
      new MemoryAdapter({ state: 'a' }),
    )

    // (b) The injected body must NOT have been compiled into a function.
    const restoredOnEnter = (restored as any).states.get('b')?.onEnter
    expect(typeof restoredOnEnter).not.toBe('function')

    // Trigger entry into 'b' so any (wrongly) compiled onEnter would run.
    await restored.fireEvent('go').catch(() => {})

    // (a) The attacker-controlled string must never have executed.
    expect((globalThis as any)[MARKER]).toBeUndefined()

    delete (globalThis as any)[MARKER]
  })
})
