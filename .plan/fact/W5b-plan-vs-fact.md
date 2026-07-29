# W5b план-факт: sim-семантика — мёртвые инварианты (A3) + I-3 false-positive (C1)

> Артефакт §0.7. Волна W5b. Ветка `remediation/w1-prep`.
> Принцип §0.6: только полнота/улучшения. ВАЖНО: «полнота» здесь = ЧЕСТНОЕ покрытие
> (оракул либо имеет sound-зубы, либо честно задокументирован как невыразимый) — НЕ
> фабрикация зубов, которые дают false-positive. Fable-критик доказал, что 2 из 3
> «мёртвых» оракулов невыразимы sound из текущего трейса; честный no-op с
> документацией и follow-tracked обогащением плана — это и есть полнота, а не сокрытие.

## C1 — I-3 false-positive на легитимном WAITING_ON_TIMER — CLOSED

I-3 (RTC-serialization break) срабатывал на ЛЮБОМ `resolve-true && !quiescent && !errorClass`
boundary. Но non-quiescence бывает легитимной. Фикс:
- `settle.ts` — `SettleReason` уже существовал; проброшен в трейс.
- `trace.ts` — `TraceFrame.settleReason?` (import type, additive хэшируемое поле). Version bump '1'→'2'.
- `driver.ts` — `result.reason` в boundary И seam-фреймы (frameFromWrite).
- `invariants.ts` I-3 — исключает **ТОЛЬКО** `WAITING_ON_TIMER`.

**Критик (fable) поймал FN в первой версии**: я исключал и `WAITING_ON_TRANSITION_TIMEOUT`.
settle.ts:281 присваивает его при ЛЮБОЙ pending-работе + таймере, НЕ связывая работу с таймером —
так реальный RTC-разрыв (зависший processing-флаг/недренированная internal-очередь) рядом с
посторонним таймером был бы ЗАМАСКИРОВАН. Исправлено: исключаем только WAITING_ON_TIMER (sound —
settle assign его лишь при `hasPendingWork()===false`: регион наблюдаемо завершился, остался лишь
чужой будущий дедлайн). WAITING_ON_TRANSITION_TIMEOUT НЕ исключаем (FN закрыт). I-3 остаётся
opt-in (вне DEFAULT-set), пока settle.ts не сделает reason точным (`inFlightAsyncCount()>0`) — W5c.

## A3 — «мёртвые инварианты» I-4/I-5/I-9

Три оракула были мертвы. РАЗНАЯ природа, РАЗНЫЙ честный исход:

| оракул | природа «смерти» | исход W5b |
|---|---|---|
| **I-9** queue-depth-bound | HAS teeth, но `ctx.maxQueueDepth` не populated e2e → вакуумен | **ОЖИВЛЁН sound**: `SimOptions.maxQueueDepth` → машина (энфорс) + checkerCtx (I-9 читает тот же bound); в DEFAULT-set (вакуумен без bound) |
| **I-5** parallel-join | структурно no-op (все ветки null); класс кросс-фреймовый | **честный no-op** (не наблюдаем sound — см. ниже); W5c |
| **I-4** hierarchy enter-order | структурно no-op | **честный no-op** (не наблюдаем sound); JSDoc почищен; W5c |

### I-9 — оживлён + критик-хардненинг

Первая версия проверяла `internal+external > bound` на ЛЮБОМ фрейме. **Критик поймал FP**:
движок гейтит maxQueueDepth только при ВНЕШНЕМ enqueue (state_machine.ts:611/684); internal
`raiseEvent` НЕ гейтится → internal-очередь легитимно превышает bound transient. non-quiescent
boundary с internal>bound красил бы корректную машину. Исправлено: I-9 проверяет ТОЛЬКО quiescent-
фреймы (комбинированный bound — rest-инвариант). Transient-превышение не наблюдаемо здесь — его
оракул — классификация `errorClass:'queue-overflow'`, не I-9 (честно задокументировано).

### I-5 — почему честный no-op, а не фабрикованные зубы (критик: CRITICAL FP)

Я СНАЧАЛА дал I-5 кросс-фреймовые зубы через additive hook `checkTrace` (done-композит без
`done.state.<C>`-raise). **Критик доказал CRITICAL false-positive**: `frame.event` заполняется
ТОЛЬКО из ВНЕШНЕГО op-события (driver.ts:491/507); внутренний `raiseEvent('done.state.C')` движка
НИКОГДА не станет `frame.event`. Значит корректная машина (join → raise → guard-false → stays
all-final) не несёт эвентового фрейма → I-5 кричал бы «raise не было» на РАБОЧЕМ движке. Плюс
(HIGH): `doneDelta` инжектится только в coverage-пути, где `runSafety` не зовётся вовсе — в
Simulator-пути (единственном с инвариантами) doneDelta нет → I-5.checkTrace всё равно no-op e2e.

Вывод: класс не наблюдаем sound из текущего трейса. **Откачено**: I-5 → честный no-op backstop;
`checkTrace` hook (interface + runner) удалён (не использовался); мои I-5 checkTrace-тесты →
no-op-тест. Реальные зубы требуют тегирования внутренних событий + сэмплинга isDone в
verdict-пути → **W5c (#35)**. Обратная импликация (undeclared/wildcard done-event) — уже звонко
ловит I-12.

### I-4 — честный no-op (критик СОГЛАСЕН)

enter-order невосстановим sound: движок рендерит один активный лист на регион; смена глубины
листа — легитимный переход (up ИЛИ down), per-onEnter-callback порядок физически отсутствует в
leaf-снимках; depth-monotonicity дала бы FP на выходе-к-мельче, registered-path украла бы
lowest-step witness у I-10. Критик подтвердил. Оставлен честным no-op; stale-JSDoc (описывал
несуществующий чекер) почищен. Реальные зубы — ordered onEnter owner-marker-пробы → W5c.

## Прочие критик-находки (адресованы)

- **trace version bump** '1'→'2' (driver.ts + public.ts) — settleReason хэшируемое поле, контракт trace.ts:120.
- **DEFAULT-set staleness** — комментарий актуализирован; I-9 добавлен (sound+вакуумен); I-3/I-5 честно вне с причиной.
- Все хэш-тесты — self-сравнения (нет литералов) → bump безопасен; knip-чисто (3 unused типа — pre-existing model.ts/types.ts).

## #22 — repro-хэш / генератор-скелет / undrivable-op (B1/D1/D5) — CLOSED

| id | сев | что было | фикс |
|---|---|---|---|
| **B1** | M | persistent traceHash = `hashOfTrace(configHash, frameCount)` = `${configHash}:${frameCount}` — 2 РАЗНЫХ прогона с тем же конфигом и числом фреймов → ОДИН hash; течёт в MinimalRepro через `run.traceHash` | `defaultShrinkRunner` использует полный `hashTrace(trace)` (content-only, Date-independent, O(frames) ничтожно рядом с runScenario+runSafety); слабый `hashOfTrace` удалён. Тест: persisted hash === полный hashTrace, не содержит ':' |
| **D5** | L | scenario Op-union `snapshot`/`restore` → `toDriverOp` возвращал `null` → молча пропускался (нет фрейма/ошибки; автор введён в заблуждение) | `toDriverOp` БРОСАЕТ явную ошибку на недрайвимый op. Безопасно: Op-union snapshot/restore нигде не драйвятся (shrinker-тесты — только `shrinkCacheKey`; coverage-персистентность — через ОТДЕЛЬНЫЙ флаг `snapshotRestore`→saveState/restoreState, не Op-union). Тест: runScenario rejects на restore/snapshot op |
| **D1** | M | генератор фиксированной формы (composite→region→leaf, depth 2); N сидов варьируют только детали | Honest scope в JSDoc `genConfig`: это ENGINE-PATH фаззер (селекция/RTC/join/history/invoke/faults на богатой фикс-топологии), НЕ topology-SHAPE фаззер; depth-3+/иная вложенность — вне досягаемости, покрывается hand-authored W1-корпусом. Фикс-форма = корректность-by-construction + replay-детерминизм; варьирование их бы forfeit-нуло. (D2 закрыт в W5a) |

+2 регресс-теста в replay.test.ts (B1 полный hash, D5 throw). 939 passed / 9 skipped.

## Итог W5b

**937 passed / 9 skipped; оба tsc (build+typecheck) чисты; knip чист (re-changes)**. W0-W5a регресс цел.
C1 разморожен (14 в blockers_frozen). Fable-критик нашёл 10 находок (2 CRITICAL/HIGH FP+FN в моих
первых фиксах) — ВСЕ адресованы: sound-фиксы (I-3 WAITING_ON_TIMER, I-9 quiescent) + честные no-op
(I-4/I-5) вместо фабрикованных зубов. Честность > фейк-полнота. Остаток → W5c (#35).
