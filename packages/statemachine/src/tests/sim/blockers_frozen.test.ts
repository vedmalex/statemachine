/**
 * @module tests/sim/blockers_frozen
 *
 * ЗАМОРОЖЕННЫЕ red-тесты sim-блокеров (Юнит A, W1 ПОРЯДКОВЫЙ ИНВАРИАНТ).
 *
 * Каждый `it` в этом файле был ПРОГНАН БЕЗ `.skip` на текущем HEAD (ветка
 * `remediation/w1-prep`, до фикса П2/W1 — catch во внутренней ветке
 * `processQueues`) и ФАКТИЧЕСКИ ВОСПРОИЗВЁЛ дефект: sim либо тихо проглатывает
 * реальный сбой движка (`ok:true` там, где должен быть `violation`), либо
 * наоборот ложно бракует легитимный прогон (`ok:false` там, где должен быть
 * `ok:true`). Фактический вывод каждого прогона записан в комментарии
 * `// HEAD-ФАКТ:` перед соответствующим `expect`.
 *
 * ПРИЧИНА ЗАМОРОЗКИ (см. .plan/MASTER-remediation-plan.md §3/§4б, строка ~333):
 * фикс П2 (симметричный catch во внутренней ветке `processQueues`, W1) уничтожит
 * ВОСПРОИЗВЕДЕНИЕ A1 — после фикса внутренний брос больше не порождает
 * `unhandledRejection` (он корректно перехватывается и уходит в
 * onError/monitor), поэтому «на текущем HEAD» A1 физически перестанет
 * краснеть. Это ПОРЯДКОВЫЙ ИНВАРИАНТ волны W1: red-тесты sim СНИМАЮТСЯ
 * (зафиксированы здесь) ДО того, как П2 попадёт в HEAD — иначе воспроизведение
 * теряется безвозвратно.
 *
 * Все пять сценариев — `describe.skip` (не исполняются обычным прогоном
 * `vitest run`). Разморозка (снятие `.skip`) запланирована по реестру §6
 * MASTER-remediation-plan.md волнами:
 *   - A1 (#19)              → W5a — «слушатель unhandledRejection на окно run»
 *   - A2 (fail-open)        → W5a — «oraclesRun» в отчёте + STRICT failOn
 *   - A4 (liveness/livelock)→ W5a — analyzeLiveness подключается к вердикту
 *     (после починки C2 — «C2 до A4», см. MASTER §3/строка 282)
 *   - A5 (real-timer escape)→ W5a — spy на глобальные таймеры → warning/fail
 *   - C1 (I-3 false-positive)→ W5b — settle-reason попадает в TraceFrame,
 *     WAITING_ON_* исключается из I-3
 *
 * При разморозке каждый `it` меняет полярность своего `expect` на
 * ПОСТ-ФИКС-ожидание (см. комментарий `// ПОСЛЕ ФИКСА:` в каждом блоке) —
 * НЕ удаляется и не переписывается с нуля: тот же сценарий/конфиг остаётся
 * red→green witness.
 *
 * Директива §0.5: файл ломающих изменений не боится (это тестовый артефакт,
 * не src движка). Директива §0.6: полнота — ничего не сокращено относительно
 * реально прогнанных сценариев.
 */

import { describe, expect, it } from 'vitest'
import { runSimulation } from '../../sim/index'
import { INVARIANTS } from '../../sim/invariants'
import { analyzeLiveness, type LivenessSample } from '../../sim/liveness'
import type { TraceFrame } from '../../sim/trace'

interface Box {
  state: string
  entered?: number
}

// ─────────────────────────────────────────────────────────────────────────
// FROZEN — не исполняется. Снимается волнами W5a/W5b (см. заголовок модуля).
// ─────────────────────────────────────────────────────────────────────────
describe.skip('sim blockers — FROZEN pre-fix red-tests (W1 ordinal invariant)', () => {
  // ── A1 — RTC-разрыв: sim НЕ видит unhandledRejection (П2 / #19) ──────────
  describe('A1 — RTC-break: internal-queue throw escapes as an unhandled rejection, invisible to SimResult', () => {
    it('an internal raiseEvent()-driven invalid-event throw crashes past processQueues as a real unhandledRejection, yet SimResult.ok stays true', async () => {
      // ЧТО ФИКСИРУЕТ: `invoke:[{event:'NONEXISTENT', delay:1}]` на состоянии
      // 'idle' без соответствующего события в `events` воспроизводит П2:
      // invoke-таймер срабатывает через движковый `raiseEvent` (внутренняя
      // очередь), `processQueues`'s internal-branch (state_machine.ts:354-361)
      // НЕ имеет catch (в отличие от external-branch :362-373), поэтому
      // `Invalid event: NONEXISTENT for state: idle` (:420-425) пробрасывается
      // из async processQueues(), вызванного через
      // `queueMicrotask(() => this.processQueues())` (:328) БЕЗ .catch — это
      // РЕАЛЬНЫЙ process-level `unhandledRejection`, а не просто отклонённый
      // fireEvent.
      //
      // ПОСЛЕ ФИКСА (П2, W1): симметричный catch в internal-branch убирает
      // unhandledRejection — ошибка уходит в onError/monitor, процесс жив;
      // ЭТОТ КОНКРЕТНЫЙ unhandledRejection перестаёт возникать вовсе, так что
      // это `it` необходимо ПЕРЕСТРОИТЬ на "слушатель окна run" (W5a #19),
      // не просто инвертировать expect — отсюда W1-порядковый-инвариант.
      let unhandled: unknown
      const handler = (err: unknown): void => {
        unhandled = err
      }
      process.once('unhandledRejection', handler)

      const result = await runSimulation<Box>(
        () => ({
          config: {
            name: 'A1FrozenProbe',
            stateAttribute: 'state',
            initialState: 'idle',
            states: {
              idle: { invoke: [{ event: 'NONEXISTENT', delay: 1 }] },
            },
            events: {},
          },
          owner: { state: 'idle' } as any,
        }),
        { seed: '1', steps: 5 },
      )

      // Flush the microtask/macrotask queue so Node's unhandled-rejection
      // detection (which fires on a later tick) has run before we assert.
      await new Promise((r) => setTimeout(r, 0))
      await Promise.resolve()
      process.removeListener('unhandledRejection', handler)

      // HEAD-ФАКТ (прогон на remediation/w1-prep, до П2):
      //   result.ok === true, result.violation === undefined
      //   unhandled instanceof StateMachineError,
      //     message === "Invalid event: NONEXISTENT for state: idle"
      // sim's own SAFETY oracle set (I-1..I-12) never sees this — it is a
      // process-level crash-class defect the harness has NO seam for.
      expect(result.ok).toBe(true)
      expect(result.violation).toBeUndefined()
      expect(unhandled).toBeInstanceOf(Error)
      expect((unhandled as Error).message).toMatch(/Invalid event: NONEXISTENT for state: idle/)

      // ПОСЛЕ ФИКСА (когда W5a #19 lands a run-window unhandledRejection
      // listener that synthesizes a violation of kind:'engine'):
      //   expect(unhandled).toBeUndefined() // П2's catch already contained it
      //   expect(result.ok).toBe(false)
      //   expect(result.violation?.kind).toBe('engine') // synthetic engine violation
    })
  })

  // ── A2 — fail-open: 0 оракулов → ok:true безусловно ──────────────────────
  describe('A2 — fail-open: zero invariants passed still reports ok:true unconditionally', () => {
    it('runSimulation(setup, {seed, steps}) with no `invariants` field returns ok:true and carries no oracle-count field at all', async () => {
      // ЧТО ФИКСИРУЕТ: SimOptions.invariants является ОПЦИОНАЛЬНЫМ, и
      // `Simulator.evaluateSafety` — no-op когда `this.checkerCtx === undefined`
      // (public.ts:461-469), что происходит именно когда `invariants.length===0`
      // (public.ts:411). Значит ЛЮБОЙ прогон без явно переданных инвариантов
      // ВСЕГДА возвращает ok:true, СТРУКТУРНО, вне зависимости от того, что на
      // самом деле произошло в трассе. SimResult не несёт даже поля,
      // фиксирующего "сколько оракулов реально отработало" — потребитель не
      // может ОТЛИЧИТЬ «прогон чист» от «прогон никем не проверялся».
      const result = await runSimulation<Box>(
        () => ({
          config: {
            name: 'A2FrozenProbe',
            stateAttribute: 'state',
            initialState: 'idle',
            states: { idle: {}, active: {} },
            events: { go: { transitions: [{ from: 'idle', to: 'active' }] } },
          },
          owner: { state: 'idle' } as any,
        }),
        { seed: '1', steps: 3 }, // <- НЕТ `invariants` вовсе
      )

      // HEAD-ФАКТ (прогон на remediation/w1-prep):
      //   result.ok === true, result.violation === undefined
      //   Object.keys(result) === ['ok','seed','steps','traceHash','trace','metrics']
      //     — НЕТ oraclesRun/oraclesEvaluated ни в каком виде.
      expect(result.ok).toBe(true)
      expect(result.violation).toBeUndefined()
      expect(Object.keys(result).sort()).toEqual(['metrics', 'ok', 'seed', 'steps', 'trace', 'traceHash'].sort())
      expect((result as Record<string, unknown>)['oraclesRun']).toBeUndefined()

      // ПОСЛЕ ФИКСА (A2, W5a #20): SimResult несёт `oraclesRun` (или
      // эквивалент); контракт STRICT `ok:true ⇒ oraclesRun>0`, дефолт
      // `builtins:'all-working'` подключает INVARIANTS автоматически когда
      // консьюмер не передал свои:
      //   expect((result as any).oraclesRun).toBeGreaterThan(0)
    })
  })

  // ── A4 — liveness отключён от вердикта: livelock/run-away → ok:true ──────
  describe('A4 — liveness oracle exists but is disconnected from SimResult.ok', () => {
    it('an A<->B livelock (configuration cycle, never terminates) reports ok:true via runSimulation, though analyzeLiveness independently classifies the SAME trace as STUCK', async () => {
      // ЧТО ФИКСИРУЕТ: `sim/liveness.ts`'s `analyzeLiveness` (Step-6 oracle,
      // DoD 6 — «configuration cycle» K=states.length+1) СУЩЕСТВУЕТ и КОРРЕКТНО
      // классифицирует A↔B бесконечное чередование как STUCK (см.
      // liveness.test.ts:58-70 — тот же паттерн). Но `Simulator`/`runSimulation`
      // (public.ts) НИКОГДА не вызывает `analyzeLiveness` — `SimResult` не
      // содержит liveness/livelocks поля вовсе (см. SimResult interface,
      // public.ts:132-141: только ok/seed/steps/traceHash/trace/violation/
      // metrics). Оракул написан, но не подключён к вердикту прогона.
      const result = await runSimulation<Box>(
        () => ({
          config: {
            name: 'A4FrozenProbe',
            stateAttribute: 'state',
            initialState: 'a',
            states: { a: {}, b: {} },
            events: {
              toB: { transitions: [{ from: 'a', to: 'b' }] },
              toA: { transitions: [{ from: 'b', to: 'a' }] },
            },
          },
          owner: { state: 'a' } as any,
        }),
        { seed: '1', steps: 20 },
      )

      // Feed the identical observed trace through analyzeLiveness directly —
      // proving the oracle WOULD catch it if wired.
      const samples: LivenessSample[] = result.trace.map((f: TraceFrame, i) => ({
        config: f.to,
        queueDepth: f.queue.internal + f.queue.external,
        pendingTimers: 0,
        earliestTimerAt: null,
        configChanged: i === 0 ? true : f.to !== result.trace[i - 1]!.to,
        healthy: true,
        inFlight: false,
        terminal: false,
        t: f.t,
        ...(f.fireOutcome ? { fireOutcome: f.fireOutcome } : {}),
      }))
      const liveness = analyzeLiveness(samples, { stateCount: 2, budgetVirtualMs: 10_000 })

      // HEAD-ФАКТ (прогон на remediation/w1-prep):
      //   result.ok === true, result.violation === undefined
      //   trace bounces a -> b -> b -> b -> a -> a -> a -> b -> ... (never done)
      //   liveness.verdict === 'STUCK', liveness.reason === 'configuration cycle'
      expect(result.ok).toBe(true)
      expect(result.violation).toBeUndefined()
      expect(liveness.verdict).toBe('STUCK')
      expect(liveness.reason).toBe('configuration cycle')

      // ПОСЛЕ ФИКСА (A4, W5a #20 — ПОСЛЕ C2 «ложный STUCK на прогрессе»
      // починен, MASTER §3 «C2 до A4»): runSimulation подключает
      // analyzeLiveness, mode по умолчанию 'both' (MASTER §2.3):
      //   expect(result.ok).toBe(false)
      //   expect(result.livelocks?.length).toBeGreaterThan(0) // headline field
    })
  })

  // ── A5 — escape реального таймера невидим для sim ────────────────────────
  describe('A5 — a real (non-virtual) timer armed from onEnter is invisible: quiescent/ok stay true', () => {
    it('an onEnter action that calls the REAL global setTimeout (bypassing env.scheduler) leaves quiescent:true / ok:true with no warning', async () => {
      // ЧТО ФИКСИРУЕТ: sim's `env.scheduler` (virtual, ObservableScheduler) —
      // единственный DI-путь таймеров, который settleMacrostep/quiescence
      // отслеживает (`env.earliestExecuteAt()`). НИЧТО в `src/sim/**` не
      // патчит/шпионит глобальный `setTimeout` (grep 'setTimeout|setInterval'
      // src/sim/*.ts подтверждает — сантехника settle.ts явно документирует
      // "no real timer ever runs in the hashed path", но ничего не МЕШАЕТ
      // консьюмерскому onEnter-действию вызвать его напрямую). Такой "escape"
      // полностью невидим: settleMacrostep's quiescence-предикат не видит
      // армированный реальный таймер вообще (он не в env.scheduler), поэтому
      // отчёт врёт "всё тихо".
      const { vi } = await import('vitest')
      const spy = vi.spyOn(globalThis, 'setTimeout')
      const armedRealTimers: ReturnType<typeof setTimeout>[] = []

      const result = await runSimulation<Box>(
        () => ({
          config: {
            name: 'A5FrozenProbe',
            stateAttribute: 'state',
            initialState: 'idle',
            states: {
              idle: {
                onEnter: (obj: any) => {
                  // ESCAPE: real global timer, never routed through env.scheduler.
                  const h = globalThis.setTimeout(() => {
                    obj.entered = (obj.entered ?? 0) + 1
                  }, 50)
                  armedRealTimers.push(h)
                },
              },
            },
            events: {},
          },
          owner: { state: 'idle', entered: 0 } as any,
        }),
        { seed: '1', steps: 2 },
      )

      // HEAD-ФАКТ (прогон на remediation/w1-prep):
      //   spy call count === 1 (the real global setTimeout WAS armed)
      //   result.ok === true, last frame quiescent === true — no warning field
      //   exists anywhere on SimResult for this.
      expect(spy).toHaveBeenCalled()
      expect(result.ok).toBe(true)
      expect(result.trace[result.trace.length - 1]?.quiescent).toBe(true)

      for (const h of armedRealTimers) {
        clearTimeout(h)
      }
      spy.mockRestore()

      // ПОСЛЕ ФИКСА (A5, W5a #20): spy/hook on the global timer surface
      // records an escape as a `warnings` entry (kind:'timer-escape'); STRICT
      // failOn config can fail `ok` on it (MASTER §2.3):
      //   expect(result.warnings?.some((w) => w.kind === 'timer-escape')).toBe(true)
    })
  })

  // ── C1 — I-3 false-positive на легитимном WAITING_ON_TIMER ──────────────
  describe('C1 — I-3 false-positive: a sibling parallel region\'s own pending future timer is misread as an RTC break', () => {
    it('a resolve-true settle boundary in region r1 is flagged I-3 even though the non-quiescence is r2\'s OWN unrelated future invoke timer (WAITING_ON_TIMER, not an RTC violation)', async () => {
      // ЧТО ФИКСИРУЕТ: composite `root` с параллельными регионами r1/r2. r1
      // имеет только событие 'go' (r1a->r1b), r2's initial state r2a arms an
      // invoke (delay:50) whose completion event ('R2_TICK') is intentionally
      // NOT declared in `events` — under Simulator's automatic driving the
      // logical clock only ever advances by the ONE-TIME behavioral-sentinel
      // probe (+1, public.ts runSentinelProbe) and never again (no 'advance'
      // op is ever issued by Simulator.pickOp()), so this invoke timer stays
      // ARMED-BUT-NEVER-DUE for the entire run — a perfectly ordinary
      // WAITING_ON_TIMER (settle.ts SettleReason) situation, structurally
      // identical to a real system waiting on an unrelated concurrent region.
      //
      // I-3's checker (invariants.ts:305-332) fires on ANY
      // `fireOutcome==='resolve-true' && quiescent===false && errorClass===
      // undefined` boundary frame — it has NO visibility into `SettleReason`
      // (TraceFrame carries no settle-reason field at all, see trace.ts), so
      // it cannot distinguish "r1 legitimately resolved true while r2's OWN
      // future timer is still pending" from an actual RTC-serialization break.
      const result = await runSimulation<Box>(
        () => ({
          config: {
            name: 'C1FrozenProbe',
            stateAttribute: 'state',
            initialState: 'root',
            states: {
              root: {
                regions: {
                  r1: { r1a: {}, r1b: {} },
                  r2: { r2a: { invoke: [{ event: 'R2_TICK', delay: 50 }] }, r2b: {} },
                },
              },
            },
            events: {
              go: { transitions: [{ from: 'root.r1.r1a', to: 'root.r1.r1b' }] },
              // NOTE: 'R2_TICK' intentionally undeclared — see comment above.
            },
          } as any,
          owner: { state: 'root' } as any,
        }),
        { seed: '1', steps: 2, invariants: INVARIANTS },
      )

      // HEAD-ФАКТ (прогон на remediation/w1-prep):
      //   result.ok === false
      //   result.violation.invariantId === 'I-3'
      //   result.violation.step === 1
      //   result.violation.observed === 'quiescent:false'
      //   the step-1 boundary frame: fireOutcome:'resolve-true', event:'go',
      //     to:'root.r1.r1b|root.r2.r2a', quiescent:false — a CORRECT,
      //     non-buggy run flagged as a safety violation.
      expect(result.ok).toBe(false)
      expect(result.violation?.invariantId).toBe('I-3')
      expect(result.violation?.step).toBe(1)
      expect(result.violation?.observed).toBe('quiescent:false')
      const boundaryFrame = result.trace.find((f) => f.step === 1 && f.event === 'go')
      expect(boundaryFrame?.fireOutcome).toBe('resolve-true')
      expect(boundaryFrame?.quiescent).toBe(false)
      expect(boundaryFrame?.errorClass).toBeUndefined()

      // ПОСЛЕ ФИКСА (C1, W5b #21 — settle-reason threaded into TraceFrame,
      // I-3 excludes any WAITING_ON_* boundary): the SAME scenario cleanly
      // passes:
      //   expect(result.ok).toBe(true)
      //   expect(result.violation).toBeUndefined()
    })
  })
})
