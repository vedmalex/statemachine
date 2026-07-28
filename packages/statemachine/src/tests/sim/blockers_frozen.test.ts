/**
 * @module tests/sim/blockers_frozen
 *
 * sim-блокеры Юнита A — РАЗМОРОЖЕННЫЕ в волне W5a (A1/A2/A4/A5/C2) + один ещё
 * замороженный (C1 → W5b).
 *
 * ИСТОРИЯ. Каждый `it` был сначала ПРОГНАН БЕЗ `.skip` на HEAD ветки
 * `remediation/w1-prep` (до фикса движка W0-W4) и ФАКТИЧЕСКИ ВОСПРОИЗВЁЛ дефект
 * sim-сантехники: sim либо тихо проглатывает реальный сбой движка (`ok:true` там,
 * где должен быть `violation`), либо наоборот ложно бракует легитимный прогон.
 * Фактический до-фикс вывод сохранён в комментариях `// HEAD-ФАКТ:` — как witness.
 *
 * W5a-РАЗМОРОЗКА (эта волна). Движок УЖЕ ПОЧИНЕН (W0-W4): ошибки внутренних
 * событий теперь маршрутизируются в `monitor.recordError` (W1 reportRuntimeError),
 * НЕ в `unhandledRejection`; метрики честны (W4). ОДНАКО sim-сантехника вердикта
 * ещё НЕ подключена к этому починенному движку — поэтому эти тесты приведены к
 * ЦЕЛЕВОМУ контракту («ПОСЛЕ ФИКСА») и на ТЕКУЩЕМ HEAD КРАСНЕЮТ:
 *   - A1 (#19)  — RTC-разрыв: recordError видна движком, но sim даёт ok:true.
 *                 ЦЕЛЬ: ok:false + violation.kind==='engine' (синтетический).
 *   - A2 (#20)  — fail-open: 0 оракулов ⇒ ok:true безусловно, нет oraclesRun.
 *                 ЦЕЛЬ: SimResult.oraclesRun>0 (дефолт подключает INVARIANTS).
 *   - A4 (#20)  — liveness отключён от вердикта: livelock ⇒ ok:true.
 *                 ЦЕЛЬ: analyzeLiveness подключён ⇒ ok:false + livelocks[].
 *   - A5 (#20)  — escape реального таймера невидим: quiescent/ok остаются true.
 *                 ЦЕЛЬ: spy на глобальный таймер ⇒ warnings[kind:'timer-escape'].
 *   - C2        — analyzeLiveness ложно STUCK на self-переходе С ПРОГРЕССОМ.
 *                 ЦЕЛЬ: рост queue/timer/data ⇒ verdict !== 'STUCK'. (Юнит-уровень
 *                 liveness.ts — ДО A4, MASTER §3 «C2 до A4».)
 *
 * ЕЩЁ ЗАМОРОЖЕН (снимается в W5b):
 *   - C1 (#21)  — I-3 false-positive на легитимном WAITING_ON_TIMER: settle-reason
 *                 попадает в TraceFrame, WAITING_ON_* исключается из I-3.
 *
 * Директива §0.5: тестовый артефакт ломающих не боится. §0.6: полнота — сценарии/
 * конфиги/HEAD-ФАКТ-witness сохранены дословно (тот же red→green witness).
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
// UNFROZEN (W5a) — A1/A2/A4/A5/C2 приведены к целевому контракту. C1 — FROZEN.
// ─────────────────────────────────────────────────────────────────────────
describe('sim blockers — W5a verdict-plumbing (A1/A2/A4/A5/C2 unfrozen; C1 frozen→W5b)', () => {
  // ── A1 — RTC-разрыв: sim ДОЛЖЕН видеть recordError движка как violation ──
  describe('A1 — RTC-break: an engine-internal invalid-event throw must surface as a SimResult violation', () => {
    it('an internal raiseEvent()-driven invalid-event throw (now routed to monitor.recordError by W1) must make SimResult.ok false with a synthetic engine violation', async () => {
      // ЧТО ФИКСИРУЕТ: `invoke:[{event:'NONEXISTENT', delay:1}]` на состоянии
      // 'idle' без соответствующего события в `events`: invoke-таймер срабатывает
      // через движковый `raiseEvent` (внутренняя очередь), внутренняя ветка
      // `processQueues` бросает `Invalid event: NONEXISTENT for state: idle`.
      //
      // ДО W1 это уходило в process-level `unhandledRejection` и sim НЕ видел
      // (ok:true). ПОСЛЕ W1 (движок починен) симметричный catch маршрутизирует
      // ошибку в `monitor.recordError` (reportRuntimeError) — процесс жив,
      // unhandledRejection НЕ возникает. НО sim-сантехника вердикта ещё НЕ
      // подключила `SimMonitor.recordError` к вердикту, поэтому на ТЕКУЩЕМ HEAD
      // sim ВСЁ РАВНО даёт ok:true — ложный OK при реальном движковом сбое.
      //
      // ЦЕЛЬ W5a #19: (а) SimMonitor.recordError фиксирует ошибку → вердикт видит
      // её (ok:false, синтетический violation kind:'engine'); (б) на остаточные
      // настоящие unhandledRejection — слушатель на окно run → синтетический
      // violation с teardown/скоупингом.
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

      // HEAD-ФАКТ (прогон на remediation/w1-prep, движок W0-W4 починен):
      //   unhandled === undefined  (W1's catch contained the internal throw —
      //     no process-level unhandledRejection remains)
      //   result.ok === true       ← ЛОЖНЫЙ OK: recordError видна движком, но
      //   result.violation === undefined    sim не подключил её к вердикту.

      // ПОСЛЕ ФИКСА (W5a #19): recordError → вердикт; окно run ловит остаточные
      // unhandledRejection → синтетический violation kind:'engine'.
      expect(unhandled).toBeUndefined() // W1's catch already contained it
      expect(result.ok).toBe(false)
      expect((result.violation as any)?.kind).toBe('engine')
    })
  })

  // ── A2 — fail-open: 0 оракулов ⇒ ok:true. ЦЕЛЬ: oraclesRun>0 ──────────────
  describe('A2 — fail-open: a run with no invariants must not report a rubber ok:true', () => {
    it('runSimulation(setup, {seed, steps}) with no `invariants` must carry oraclesRun>0 (default builtins attached), not a structural ok:true', async () => {
      // ЧТО ФИКСИРУЕТ: SimOptions.invariants ОПЦИОНАЛЬНО, и `evaluateSafety` —
      // no-op когда `checkerCtx === undefined` (public.ts:461-469), что происходит
      // именно когда `invariants.length === 0` (public.ts:411). ЛЮБОЙ прогон без
      // явных инвариантов ВСЕГДА возвращает ok:true СТРУКТУРНО — потребитель не
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
      //     — НЕТ oraclesRun ни в каком виде: резиновый ok:true.

      // ПОСЛЕ ФИКСА (A2, W5a #20): SimResult несёт `oraclesRun`; контракт STRICT
      // `ok:true ⇒ oraclesRun>0`; дефолт `builtins:'all-working'` подключает
      // INVARIANTS автоматически когда консьюмер не передал свои.
      expect((result as any).oraclesRun).toBeGreaterThan(0)
    })
  })

  // ── A4 — liveness подключён к вердикту: livelock ⇒ ok:false ──────────────
  describe('A4 — liveness oracle must be wired into SimResult.ok', () => {
    it('an A<->B livelock (configuration cycle, never terminates) must report ok:false with a livelocks[] headline via runSimulation(mode:liveness)', async () => {
      // ЧТО ФИКСИРУЕТ: `analyzeLiveness` (liveness.ts) КОРРЕКТНО классифицирует
      // A↔B бесконечное чередование как STUCK 'configuration cycle', но
      // `runSimulation`/`Simulator` НИКОГДА его не вызывает — `SimResult` не несёт
      // liveness/livelocks поля вовсе. Оракул написан, но не подключён к вердикту.
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
        { seed: '1', steps: 20, mode: 'liveness' },
      )

      // Feed the identical observed trace through analyzeLiveness directly —
      // proving the oracle WOULD catch it if wired (это witness, не вердикт).
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
      //   result.ok === true, result.violation === undefined  ← ЛОЖНЫЙ OK
      //   liveness.verdict === 'STUCK', reason === 'configuration cycle'
      //     (оракул ловит, но вердикт прогона его игнорирует)

      // Оракул независимо подтверждает livelock (witness — держим как якорь):
      expect(liveness.verdict).toBe('STUCK')
      expect(liveness.reason).toBe('configuration cycle')

      // ПОСЛЕ ФИКСА (A4, W5a #20 — analyzeLiveness подключён, mode 'liveness'/'both'):
      expect(result.ok).toBe(false)
      expect((result as any).livelocks?.length).toBeGreaterThan(0) // headline field
    })

    // ── A4-regress: false-NEGATIVE guard (D1) — single-state resolve-true self-loop ──
    // Критик (fable, статический разбор A4-фикса) нашёл, что первая версия фикса
    // (схлопывание по (config,queueDepth) ЧЕРЕЗ границы шагов) стирала одно-
    // состоянийный livelock `s1 --E--> s1` в один sample ⇒ ложный PROGRESSED
    // (false-negative — ХУДШИЙ класс для sim-оракула). buildLivenessSamples теперь
    // схлопывает ПО ШАГУ (boundary-фрейм каждого step), поэтому межшаговое
    // повторение fingerprint выживает и правило (3) выносит STUCK.
    for (const seed of ['1', '2', '42', '99']) {
      it(`a single-state resolve-true self-loop (s1 --E--> s1) must report ok:false STUCK, never a false PROGRESSED (D1, seed=${seed})`, async () => {
        const result = await runSimulation<Box>(
          () => ({
            config: {
              name: 'D1SelfLoop',
              stateAttribute: 'state',
              initialState: 's1',
              states: { s1: {} },
              events: { E: { transitions: [{ from: 's1', to: 's1' }] } },
            },
            owner: { state: 's1' } as any,
          }),
          { seed, steps: 6, mode: 'liveness' },
        )
        expect(result.ok).toBe(false)
        expect((result as any).liveness?.verdict).toBe('STUCK')
        expect((result as any).livelocks?.length).toBeGreaterThan(0)
      })
    }

    // ── A4-regress: false-POSITIVE guard — a legitimately terminating machine ──
    // Исходный A4-дефект (verify RESIDUAL): liveness кричал ok:false STUCK
    // 'configuration cycle' на КАЖДОЙ завершающейся машине при mode 'liveness'|'both'
    // (дубли фреймов давали ложный config-cycle до финальных фреймов). После фикса
    // per-step — терминирующая машина PROGRESSED (noop-шаги в финале не несут
    // resolve-true, правила STUCK их не трогают).
    for (const seed of ['1', '2', '42', '99']) {
      it(`a terminating machine (s1->s2->s3 final) must report ok:true, never a false STUCK (seed=${seed})`, async () => {
        const result = await runSimulation<Box>(
          () => ({
            config: {
              name: 'TerminatingProbe',
              stateAttribute: 'state',
              initialState: 's1',
              states: { s1: {}, s2: {}, s3: { final: true } },
              events: {
                go1: { transitions: [{ from: 's1', to: 's2' }] },
                go2: { transitions: [{ from: 's2', to: 's3' }] },
              },
            },
            owner: { state: 's1' } as any,
          }),
          { seed, steps: 10, mode: 'both' },
        )
        expect(result.ok).toBe(true)
        expect((result as any).liveness?.verdict).toBe('PROGRESSED')
        expect((result as any).livelocks).toBeUndefined()
      })
    }
  })

  // ── A5 — escape реального таймера ДОЛЖЕН быть виден sim ───────────────────
  describe('A5 — a real (non-virtual) timer armed from onEnter must be flagged as a timer-escape warning', () => {
    it('an onEnter action that calls the REAL global setTimeout (bypassing env.scheduler) must surface a warnings[kind:timer-escape] entry', async () => {
      // ЧТО ФИКСИРУЕТ: sim's `env.scheduler` (virtual, ObservableScheduler) —
      // единственный DI-путь таймеров, который settleMacrostep/quiescence
      // отслеживает. НИЧТО в `src/sim/**` не патчит/шпионит глобальный
      // `setTimeout`, поэтому консьюмерский onEnter, вызвавший его напрямую,
      // полностью невидим: settleMacrostep объявляет quiescent:true пока висит
      // реальный macrotask — отчёт врёт «всё тихо».
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
      //   spy call count >= 1 (реальный global setTimeout БЫЛ армирован)
      //   result.ok === true, последний фрейм quiescent === true — НЕТ никакого
      //   warnings-поля на SimResult для этого escape: отчёт врёт «тихо».
      expect(spy).toHaveBeenCalled() // the escape did happen

      for (const h of armedRealTimers) {
        clearTimeout(h)
      }
      spy.mockRestore()

      // ПОСЛЕ ФИКСА (A5, W5a #20): hook на глобальный таймер фиксирует escape как
      // `warnings` entry (kind:'timer-escape'); STRICT failOn может провалить ok.
      expect((result as any).warnings?.some((w: any) => w.kind === 'timer-escape')).toBe(true)
    })
  })

  // ── C2 — analyzeLiveness НЕ должен ложно STUCK на self-переходе с прогрессом
  describe('C2 — analyzeLiveness must not report a false STUCK when observables progress on an unchanged config', () => {
    it('a resolve-true self-loop that keeps GROWING the queue (progress via queue depth, config unchanged) must NOT be classified STUCK', () => {
      // ЧТО ФИКСИРУЕТ: liveness.ts self-loop rule (:224-236) ветвится на
      // `fireOutcome==='resolve-true' && !configChanged && !terminal` и ИГНОРИРУЕТ
      // рост наблюдаемых (queue/timer/data). Легитимный self-переход, который НЕ
      // меняет config, но делает реальную работу (растёт очередь / армируется
      // таймер / меняются данные), ошибочно классифицируется как STUCK.
      //
      // Сэмплы: config неизменен ('x'), но queueDepth монотонно РАСТЁТ — это
      // наблюдаемый прогресс, НЕ no-progress self-loop.
      const samples: LivenessSample[] = [
        {
          config: 'x',
          queueDepth: 0,
          pendingTimers: 0,
          earliestTimerAt: null,
          fireOutcome: 'resolve-true',
          configChanged: true,
          healthy: true,
          inFlight: false,
          terminal: false,
          t: 0,
        },
        {
          config: 'x',
          queueDepth: 1, // ← ПРОГРЕСС: очередь выросла (config тот же)
          pendingTimers: 0,
          earliestTimerAt: null,
          fireOutcome: 'resolve-true',
          configChanged: false,
          healthy: true,
          inFlight: false,
          terminal: false,
          t: 1,
        },
        {
          config: 'x',
          queueDepth: 2, // ← ПРОГРЕСС: очередь снова выросла
          pendingTimers: 0,
          earliestTimerAt: null,
          fireOutcome: 'resolve-true',
          configChanged: false,
          healthy: true,
          inFlight: false,
          terminal: false,
          t: 2,
        },
      ]

      const liveness = analyzeLiveness(samples, { stateCount: 2, budgetVirtualMs: 10_000 })

      // HEAD-ФАКТ (прогон на remediation/w1-prep):
      //   liveness.verdict === 'STUCK'
      //   liveness.reason === 'resolve-true with no configuration change (self-loop)'
      //     — ложный STUCK: rule (:226) увидел !configChanged и вынес STUCK, хотя
      //     queueDepth рос (наблюдаемый прогресс), т.е. это НЕ livelock.

      // ПОСЛЕ ФИКСА (C2): rule учитывает прогресс observables (queue/timer/data);
      // рост queueDepth на неизменном config ⇒ НЕ STUCK.
      expect(liveness.verdict).not.toBe('STUCK')
    })
  })

  // ── C1 — ЕЩЁ ЗАМОРОЖЕН (W5b): I-3 false-positive на легит WAITING_ON_TIMER ─
  describe.skip('C1 — I-3 false-positive: a sibling parallel region\'s own pending future timer is misread as an RTC break (FROZEN→W5b)', () => {
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
