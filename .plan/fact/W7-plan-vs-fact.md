# W7 план-факт: закрытие остатка ремедиации (U1-U8)

> Артефакт §0.7. Волна W7. Процесс: план → критик-плана (fable) → выполнение
> (3 параллельных агента + оркестратор) → валидация → критик-приёмка КАЖДОГО
> юнита → доводка → re-проверка. §0.6: только полнота. Принцип: честность > фейк.

## Критик-план (до старта) поймал и исправлено ДО выполнения

- U5 (I-5 teeth) → **подтверждённый no-op** (sound-тег внутреннего done.state НЕВОЗМОЖЕН без engine-additive правки; вынесено в #35-remainder), а не «medium-субстрат» (ложная надежда).
- U6 (I-4 teeth) → **подтверждённый no-op** (критик СОГЛАСЕН с W5b).
- U1 → SOUND-условно (ISS-030 окно FP) + liveness/reason/DEFAULT-условие.
- U3 → реальные W3C IRP-векторы (не ручные — иначе цель §4в подорвана).
- Верификация: +нулевой-ложняк-корпус со string-method, +двусторонний meta, +dist-политика.

## Юниты (все критик-приняты)

| # | юнит | исход | критик-приёмка |
|---|---|---|---|
| **U1** | #35a I-3 precision | settle.ts 3-way таксономия (+`WAITING_ON_INTERNAL`); I-3 sound-исключает {WAITING_ON_TIMER, WAITING_ON_TRANSITION_TIMEOUT(inFlight>0)}, флагует {WAITING_ON_INTERNAL, microtask-budget, no-reason}. I-3 **остаётся opt-in** (ISS-030: string-method invoke не трекается → FP-окно в DEFAULT) | ДОРАБОТАТЬ → устранено: version '2'→'3' (re-семантизация union), 2 checker-теста I-3 (анти-FP-строка), doc-sync public.ts↔ISS-030 |
| **U2** | #26 RCE B4 | guard в `recreateLiteral` (fail-fast на не-функц. source) + `recreateLiteralIfShaped` (string-method invoke мимо компиляции) + 7 тестов (trusted компилирует / untrusted fromJSON НЕ компилирует — registry-lookup доказан) | **ПРИНЯТЬ** (3 LOW-нита в backlog) |
| **U3** | #36 §4в conformance | `selection_conformance.test.ts` — 10 W3C SCXML §3.13 IRP-векторов (test403a/b/c, 404, 504, 505/506, 405/406); pass-критерии из W3C-нормы (независимая опора); карта применимости (priority=расширение); 0 дивергенций на 8 ассертированных | **ПРИНЯТЬ** + doc → устранено: sibling exit/entry-order вынесен в явную «известная W3C-ось, не ассертирована» (футер не overbroad) |
| **U4** | #35b payload-субстрат | **отложено в #35-remainder** — критик подтвердил риск (fault-путь + replay-детерминизм); не критический для контракта (checkMachine no-payload default + honest advisory уже работает) |
| **U5** | #35c I-5 teeth | **подтверждённый no-op** (engine-additive → #35-remainder); #25 meta классифицирует честно | — |
| **U6** | #35d I-4 teeth | **подтверждённый no-op** (enter-order невыразим из leaf-снимков); #25 meta честен | — |
| **U7** | #15 perf | counting-probe (symbol-gated, test-only) ИЗМЕРИЛ 2 реальных Θ(R²): PERF-03 `computeInternalWrite` (65×), PERF-02 `isCompositeDone` (63×). Оба → **O(R)** (behavior-preserving): PERF-03 ancestor-walk O(depth) + maxRegionDots-гейченный descendant-scan; PERF-02 first-seen region-индекс + completion-gate. +3 perf-теста | **ПРИНЯТЬ** — критик ДОКАЗАЛ эквивалентность (maxRegionDots индуктивно не пропускает; ancestor-walk покрывает dot-префиксы; first-seen==find). F2 закрыт оркестратором (старый предикат УЖЕ dot-boundary `regionKey+'.'` → строгая эквивалентность); F3b probe-валидация + F4a r1/r10-тест добавлены |
| **U8** | #6 docs | финальная синхронизация (checkMachine, I-3 precision, perf-win, deferred-поля checkMachine, §4в scope) |

## Верификация

**1018 passed / 9 skipped; оба tsc + knip чисты**; core dist-baseline обновлён осознанно
(U7 perf + probe-валидация; Node 24; linux-репро через `act` подтверждён); api-report обновлён
(`SettleReason` +WAITING_ON_INTERNAL, version '3'). Каждый юнит red→green + критик-приёмка.

## Осталось (документированный перенос, НЕ сокращение §0.6)

- **#35-remainder**: object-payload субстрат (U4) + engine-additive I-5-зубы (context в success-recordTransition + doneDelta на verdict-пути) + I-4 owner-marker-канал. Все требуют engine-additive правки (смена core-baseline) — вынесено осознанно, спека в #35.
- **§4в follow-up**: пиннинг sibling exit/entry-order параллельных регионов (нормировано W3C, пока не ассертировано).
- **U2 LOW-ниты**: guard-паттерн vs `(function...)`/ведущий-коммент; warn на forged `source`; typeless pass-through — backlog.
- checkMachine зарезервированные поля (guardOutcomes/nonConvergingRegions/minimalTrace-shrink/init-config-invariant) — future, задокументированы в U8.

## Итог

Остаток ремедиации закрыт: 3 реальных дефекта починены (I-3 precision, RCE-guard, 2× Θ(R²)→O(R)),
1 независимая опора добавлена (§4в W3C-векторы), 2 невыразимых-sound класса честно подтверждены no-op
с engine-additive спекой на будущее. Каждый critic-проход (план + 4 приёмки) нашёл реальное — всё
устранено. Программа W0-W7 завершена.
