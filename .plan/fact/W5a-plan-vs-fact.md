# W5a план-факт: вердиктная поверхность src/sim (A1/A2/A4/A5/C2/D2)

> Артефакт §0.7. Волна W5a (аудит src/sim — вердиктные блокеры). Ветка `remediation/w1-prep`.
> Принцип §0.6: только полнота, только улучшения/расширения — ни одного сокращения.

## Факт (verdict CLOSED после residual + critic-приёмки)

| блокер | план | факт | подтверждение (оркестратор-прогон) |
|---|---|---|---|
| A1 [critical] RTC-разрыв невидим | engine-internal throw/reject ⇒ SimResult violation | `assembleResult`: engine-error канал → `violation{kind:'engine'}`, ok:false на errorCount>0 \|\| unhandledRejections | frozen A1: invalid-event throw ⇒ ok:false + violation |
| A2 [high] fail-open | нет инвариантов ⇒ не резиновый ok:true | `oraclesRun = invariants+1(engine)+liveness`; всегда ≥1 | frozen A2: run без инвариантов не маскирует ok |
| A4 [high] liveness не подключён | `analyzeLiveness` подключён к вердикту (mode 'liveness'/'both'); STUCK ⇒ ok:false + livelocks[] | `buildLivenessSamples`→`analyzeLiveness`; non-PROGRESSED ⇒ livelocks headline | frozen A4: A↔B ⇒ ok:false + livelocks[] |
| A5 [critical] escape таймера | реальный таймер из onEnter ⇒ timer-escape warning | run-guard timer-spy; `warnings[]{kind:'timer-escape'}` | frozen A5: onEnter setTimeout ⇒ warning |
| C2 | self-loop С ПРОГРЕССОМ не ложный STUCK | rule (3): observableProgress (queue/timer) на неизменном config ⇒ continue | frozen C2: рост queueDepth ⇒ verdict≠STUCK |
| D2 | engine-path smoke в default-сьюте | подключён | в наборе |

Итог W5a до критик-приёмки: 928 passed / 10 skipped; оба tsc чисты.

## Residual #1 (verify RESIDUAL) — A4 liveness false-POSITIVE — CLOSED

verify (адверсариальный) поймал: A4-подключение репортило `ok:false STUCK 'configuration cycle'`
на КАЖДОЙ легитимно завершающейся машине при mode 'liveness'|'both'. Repro (seeds 1,2,3,42,99):
`s1→s2→s3(final)` и `a→b→c→d(final)` ⇒ ложный STUCK, свидетель — НЕфинальное промежуточное.
Причина: канонический trace эмитит дубли фреймов на шаг (seam+boundary), `buildLivenessSamples`
маппил 1:1 ⇒ два соседних идентичных resolve-true фрейма делили fingerprint и триггерили
config-cycle detector ДО финальных фреймов.

## Residual #2 (critic fable, статический разбор A4-фикса) — false-NEGATIVE D1 — CLOSED

Первая версия residual-фикса схлопывала по `(config,queueDepth)` **через границы шагов**. Критик
(fable, Read/Glob/Grep, без Bash — контрактный разбор) нашёл **D1 CRITICAL false-negative** (худший
класс): одно-состоянийный `s1 --E--> s1` (resolve-true self-loop) — все шаги делят один fingerprint,
cross-step-схлопывание стирало их в 1 sample ⇒ ложный PROGRESSED. То есть первый фикс убрал
false-positive ценой отключения детектора самого частого класса livelock. Ключевой инсайт критика:
в wired-пути `pendingTimers`/`earliestTimerAt` захардкожены в 0/null ⇒ fingerprint ≡ (config,queueDepth),
а мой ключ схлопывания был тождествен полному fingerprint — я схлопывал ИМЕННО повторение,
которое и есть определение no-progress. В `TraceFrame` есть поле `step`, различающее внутришаговый
дубль от межшагового залипания — первый фикс его игнорировал.

**Правильный фикс** (`public.ts buildLivenessSamples`): ОДИН sample на логический STEP =
boundary-фрейм каждого `step` (последний в группе одинакового step; driver эмитит seam-фреймы +
ровно 1 boundary после них). Он несёт settled-наблюдение шага (финальный `to`, settle-queue,
`fireOutcome`). `terminal` выводится ЧЕСТНО из `doneDelta` (все композиты done на квиесцентной
границе), НЕ по позиции (закрывает D3(b) — публичное `quiescence` больше не врёт TERMINAL_FINAL).
Межшаговое повторение fingerprint выживает как отдельные samples ⇒ правило (3)/(2) видят залипание.

| id (critic) | класс | что | подтверждение (оркестратор-прогон, seeds 1/2/42/99) |
|---|---|---|---|
| D1 | CRITICAL false-neg | single-state resolve-true self-loop стирался ⇒ PROGRESSED | per-step boundary; `s1--E-->s1` ⇒ **ok:false STUCK** (правило 3) |
| исходный | false-pos | терминирующая ⇒ ложный STUCK | `s1→s2→s3(final)`, `a→d` ⇒ **ok:true PROGRESSED** |
| A↔B | positive path цел | genuine livelock | pingpong A↔B ⇒ **STUCK** (правило 2 'configuration cycle') |
| D3(b) | MEDIUM ложь | позиционный terminal врал TERMINAL_FINAL всем | terminal ← doneDelta.every(done) на квиесцентной границе |

Регресс-тесты (CD-63 DST-mandate, §0.6 полнота): в `blockers_frozen.test.ts` A4-describe +8 сквозных
через `runSimulation` — single-state self-loop STUCK ×4 seed + терминирующая PROGRESSED ×4 seed.

## Осталось (НЕ регресс фикса — pre-existing, честно задокументировано)

- **D2 (критик, HIGH-note)**: timer self-rearm config-статичный loop ⇒ PROGRESSED при малом числе
  шагов. Причина PRE-EXISTING: таймерные наблюдаемые (`pendingTimers`/`earliestTimerAt`) НЕ переносятся
  в content-only trace (захардкожены 0/null в builder'е ДО A4 — docstring `buildLivenessSamples`).
  Фикс per-step это НЕ ухудшил (keep-last boundary сохраняет поздний `t`; при достаточной глубине
  правило (1) budget-overrun сработает). Углубление покрытия таймерного канала — coverage-gap уровня
  W5b, не headline A4.
- **C1 (#21)**: I-3 false-positive на WAITING_ON_TIMER — FROZEN skip, W5b.
- A3 (мёртвые инварианты I-4/I-5/I-9), B1/D1/D5 (#22 repro-хэш/генератор/фузз) — W5b.

Итог W5a: **936 passed / 10 skipped; оба tsc (build + typecheck) чисты**; W0-W4 регресс цел.
Каждый critic-проход (verify + fable static) нашёл РЕАЛЬНЫЙ воспроизводимый дефект в собственной
проводке фикса — оба воспроизведены оркестратором до правки и закрыты с регресс-тестами.
