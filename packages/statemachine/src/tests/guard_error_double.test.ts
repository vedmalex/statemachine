import { describe, expect, it } from 'vitest'
import { StateMachine } from '../state_machine'
import {
  type IMonitor,
  MemoryAdapter,
  type StateMachineConfig,
} from '../types'

/**
 * Волна W3-A — RED-тесты дефектов реестра SPEC §5 (гарды/наблюдаемость):
 *
 *   F7 (HIGH) — ошибка гарда наблюдаема НЕ полностью: при исключении в guard
 *     переход становится disabled (fireEvent=false) и W1 зовёт onError, НО
 *     monitor.recordError НЕ вызывается. Для sim (A1/W5, количественные
 *     оракулы) и для потребителя с monitor ошибка гарда НЕВИДИМА в метриках.
 *     ЦЕЛЬ: исключение в guard (getAllowedTransitions guard.catch) → вызвать
 *     monitor.recordError с контекстом phase:'guard'. Переход остаётся disabled
 *     (fireEvent=false — обратная совместимость, НЕ меняется на throw).
 *
 *   F8 (HIGH) — guard ПОБЕДИВШЕГО перехода вызывается ДВАЖДЫ за один fireEvent:
 *     getAllowedTransitions исполняет guard кандидата, затем applyTransition
 *     Phase 1 (guard re-check) исполняет guard победителя ВТОРОЙ раз — чистое
 *     дублирование. ЦЕЛЬ: снести Phase 1 re-check → guard победителя вызван
 *     РОВНО 1 раз. Побочный дефект: недетерминированный guard (true при 1-м
 *     вызове, false при 2-м) СЕЙЧАС отменяет уже выбранный переход вторым
 *     вызовом — после фикса переход должен СОСТОЯТЬСЯ.
 *
 * Все три КРАСНЫ на HEAD (remediation/w1-prep, до фикса) и ЗЕЛЕНЕЮТ после фикса.
 * ГЕЙТ: характеризация селекции (10/10) НЕ трогается — W3-A про гарды и
 * наблюдаемость, НЕ про ВЫБОР победителя перехода.
 */

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

interface Box {
  state: string
}

// ---------------------------------------------------------------------------
// F7 — ошибка гарда должна быть видна в monitor.recordError с phase:'guard'
// ---------------------------------------------------------------------------
describe('F7 (HIGH): исключение в guard наблюдаемо через monitor.recordError', () => {
  it('guard бросает → monitor.recordError вызван (>=1) с phase:"guard"; переход остаётся disabled', async () => {
    const { monitor, errors } = makeSpyMonitor()

    const config: StateMachineConfig<Box> = {
      name: 'F7Guard',
      stateAttribute: 'state',
      initialState: 's0',
      states: { s0: {}, s1: {} },
      events: {
        ev: {
          transitions: [
            {
              from: 's0',
              to: 's1',
              guard: () => {
                throw new Error('guard boom')
              },
            },
          ],
        },
      },
    }

    const adaptee = new MemoryAdapter<Box>({ state: 's0' })
    const sm = new StateMachine<Box, typeof config>(config, adaptee, { monitor })

    // Обратная совместимость: бросок гарда оставляет переход disabled
    // (fireEvent=false), НЕ роняет процесс и НЕ переводит машину.
    const result = await sm.fireEvent('ev')
    expect(result).toBe(false)
    expect(sm.getCurrentState()).toBe('s0')

    // F7-ядро: ошибка гарда ДОЛЖНА попасть в наблюдаемый канал monitor.recordError.
    // HEAD: getAllowedTransitions guard.catch не трогает monitor → errors.length===0 → RED.
    expect(
      errors.length,
      `ошибка гарда должна попасть в monitor.recordError; recordError=${errors.length}`,
    ).toBeGreaterThan(0)

    // И контекст должен помечать фазу как guard (отличимость канала от action/transition).
    const guardErr = errors.find(
      (e) => (e.context as { phase?: string } | undefined)?.phase === 'guard',
    )
    expect(
      guardErr,
      `среди записанных ошибок должна быть с phase:"guard"; contexts=${JSON.stringify(
        errors.map((e) => e.context),
      )}`,
    ).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// F8 — guard победителя вызывается РОВНО один раз (снос Phase 1 re-check)
// ---------------------------------------------------------------------------
describe('F8 (HIGH): guard победившего перехода вызывается РОВНО 1 раз', () => {
  it('счётчик вызовов guard победителя === 1 (HEAD === 2)', async () => {
    let calls = 0
    const config: StateMachineConfig<Box> = {
      name: 'F8Count',
      stateAttribute: 'state',
      initialState: 'a',
      states: { a: {}, b: {} },
      events: {
        go: {
          transitions: [
            {
              from: 'a',
              to: 'b',
              guard: () => {
                calls++
                return true
              },
            },
          ],
        },
      },
    }

    const adaptee = new MemoryAdapter<Box>({ state: 'a' })
    const sm = new StateMachine<Box, typeof config>(config, adaptee)

    const ok = await sm.fireEvent('go')
    // Переход должен состояться (guard постоянно true).
    expect(ok).toBe(true)
    expect(sm.getCurrentState()).toBe('b')

    // F8-ядро: guard победителя проверяется ОДИН раз в getAllowedTransitions.
    // HEAD: applyTransition Phase 1 дублирует проверку → calls===2 → RED.
    expect(
      calls,
      `guard победителя должен вызываться РОВНО 1 раз, но вызван ${calls}`,
    ).toBe(1)
  })

  it('недетерминированный guard (true, затем false) НЕ отменяет уже выбранный переход', async () => {
    let n = 0
    const config: StateMachineConfig<Box> = {
      name: 'F8NonDet',
      stateAttribute: 'state',
      initialState: 'a',
      states: { a: {}, b: {} },
      events: {
        go: {
          transitions: [
            {
              from: 'a',
              to: 'b',
              // true при 1-м вызове (выбор в getAllowedTransitions),
              // false при 2-м (повторная оценка Phase 1 на HEAD).
              guard: () => {
                n++
                return n === 1
              },
            },
          ],
        },
      },
    }

    const adaptee = new MemoryAdapter<Box>({ state: 'a' })
    const sm = new StateMachine<Box, typeof config>(config, adaptee)

    const ok = await sm.fireEvent('go')

    // F8-побочный: уже выбранный переход НЕ должен отменяться вторым вызовом guard.
    // HEAD: Phase 1 повторно зовёт guard (n=2 → false) → переход отменён,
    // машина остаётся в 'a', ok===false → RED.
    expect(
      sm.getCurrentState(),
      `переход должен состояться; вторая оценка guard не должна его отменять (n=${n})`,
    ).toBe('b')
    expect(ok).toBe(true)
  })
})
