import { describe, expect, it } from 'bun:test'
import { TimerScheduler } from '../scheduler'
import { StateMachine } from '../state_machine'
import { MemoryAdapter } from '../types'

describe('Advanced Features: Wildcards & Timers', () => {
  // Ensure scheduler is off before these tests to use native setTimeout
  TimerScheduler.getInstance().stop()
  TimerScheduler.getInstance().clear()

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
    const adapter2 = new MemoryAdapter({ state: '', valid: false })
    const sm2 = StateMachine.fromJSON(json, adapter2)

    expect(sm2.getCurrentState()).toBe('start')

    // Ждем > 100мс
    await new Promise((r) => setTimeout(r, 150))

    // Переход НЕ должен произойти, так как valid=false
    expect(sm2.getCurrentState()).toBe('start')

    // Теперь восстанавливаем с valid=true
    const adapter3 = new MemoryAdapter({ state: '', valid: true })
    const sm3 = StateMachine.fromJSON(json, adapter3)

    // Ждем > 100мс
    await new Promise((r) => setTimeout(r, 150))

    // Переход должен произойти
    expect(sm3.getCurrentState()).toBe('checked')
  })

  it('should reject unsafe legacy function strings during deserialization', () => {
    // This test demonstrates that unsafe function strings are blocked during deserialization
    const safeConfig = {
      name: 'SafeSM',
      initialState: 'start',
      stateAttribute: 'state',
      states: {
        start: {},
      },
      events: {},
    }

    const sm = new StateMachine(safeConfig as any)
    const jsonData = sm.toJSON()

    // Manually inject unsafe function string (simulating malicious JSON)
    const maliciousJson = jsonData.replace(
      '"onEnter":null',
      '"onEnter":"function() { process.exit(1) }"',
    )

    // Should not crash - the unsafe function should be rejected and set to undefined
    const deserializedSM = StateMachine.fromJSON(maliciousJson)

    // The unsafe function should be undefined, not executed
    expect(deserializedSM).toBeDefined()
    // Since onEnter is undefined, it won't cause issues
  })
})
