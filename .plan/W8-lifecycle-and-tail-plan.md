# W8 — канал наблюдаемости жизненного цикла + ПОЛНОЕ закрытие хвоста

> Процесс: план → критик ПЛАНА ✓ (правки внесены) → выполнение → валидация →
> критик-приёмка КАЖДОГО юнита → доводка → re-проверка. mb3-critic в ADVISORY-режиме,
> модель fable. §0.6: только полнота. Директива пользователя: **все находки в работу,
> ничего не оставляем** — поэтому все известные хвосты (W6/W7 «Осталось») включены.

## Рамка

I-4 переосмыслен (директива): логирование входов/выходов ценно САМО ПО СЕБЕ — как
инструмент наблюдения за внутренними процессами машины извне (отладка). Канал —
ключ, открывающий: I-4-зубы, §4в sibling-order, guardOutcomes, ISS-030 (in-flight
трекинг string-method действий) → I-3 в DEFAULT.

## V1 — Lifecycle-канал (ядро волны). Спецификация ПОСЛЕ правок критика

`IMonitor.recordLifecycle?(e: LifecycleEvent)` — ОПЦИОНАЛЬНЫЙ метод (идиома
`recordEvent?`/`getMetrics?`; ABI-тест уже доказывает, что литерал с частью методов валиден).

```ts
interface LifecycleEvent {
  readonly kind: 'enter' | 'exit' | 'invoke' | 'guard'   // расширяемый union (@unstable)
  readonly hook: string        // 'onBeforeEnter'|'onEnter'|'onAfterEnter'|'onBeforeExit'|
                               // 'onExit'|'onAfterExit'|'invoke.action'|'guard'
  readonly state: string       // полный dot-путь (иерархия = dot-парсинг; regionKey/depth НЕ дублируем)
  readonly owner: object       // ★ КРИТИЧНО: машина мультиобъектная (timersFor(obj)…);
                               // без дискриминатора трейсы двух owner'ов СМЕШИВАЮТСЯ
  readonly microstep: number   // ★ КРИТИЧНО: граница микрошага. enter-колбэки идут ДО точки
                               // невозврата → отменённый микрошаг уже отдал 'enter S';
                               // без id трейсер ВРЁТ, а предикат I-4 unsound
  readonly seq: number         // per-machine монотонный (порядок прибытия; per-owner проекция
                               // фильтром остаётся монотонной)
  readonly edge: 'begin' | 'end'  // ★ переименовано из phase (коллизия с ErrorContext.phase)
  readonly event?: string      // событие-причина
  readonly failed?: boolean    // на 'end': колбэк БРОСИЛ (независимо от восстановления onError)
  readonly outcome?: boolean   // для kind:'guard' — результат предиката
}
```
**УДАЛЕНО `durationMs`** (критик): доставка синхронна → подписчик штампует своё время сам;
убирает проблему детерминизма sim (`Date.now` запрещён в sim-плоскости) без потери функции.

**Семантика (обязательства):**
- `'end'` эмитится при settle САМОГО колбэка, **ДО** `processError`/`onError`
  (`callAction().then(end_ok).catch(e=>{end_failed; throw e}).catch(processError)`) — иначе
  зависший onError маскируется под зависший onEnter, и «begin без end» теряет виновника.
  Существующая цепочка `.catch(processError)` НЕ трогается (маршрутизация ошибок байт-в-байт).
- **Sink-guard на КАЖДОМ вызове** (прецедент state_machine.ts:4111 `try/catch` вокруг
  recordTransition): бросающий пользовательский монитор НЕ должен инжектить ошибку в RTC-путь.
  Guard глотает ошибку СИНКА, никогда — ошибку колбэка (анти-F7).
- **errorState-путь НЕ эмитит enter-событий** (fallback коммитит errorConfig минуя
  executeEnterActions) — задокументировать; ни трейсер, ни I-4 не трактуют это как аномалию.
- JSDoc перечисляет, что канал НЕ видит (onTransition/onBefore/onAfter транзишена, onError-хендлер).

## Юниты

| # | юнит | суть | поток |
|---|---|---|---|
| **V1** | канал: state-хуки (enter/exit) по спеке выше | CORE |
| **V1b** | канал: `kind:'invoke'` (armed/started/settled/aborted) — закрывает **ISS-030** (наблюдаемость async-действий, включая string-method) → открывает V8 | CORE |
| **V1c** | канал: `kind:'guard'` + `outcome` — открывает **guardOutcomes** (SPEC §13.1) | CORE |
| **V5a** | `recordTransition(dur,true)` + context `{fromState,toState,eventName}` + microstep-id | CORE |
| **V6b** | warn на подставной `source` в deserializeAction (через logger) + typeless-сигнал | CORE |
| **V2** | `createLifecycleTracer()` — потребительский отладчик: сбор + `format()` (дерево, failed/unfinished), рецепты в доках | INDEP |
| **V6a** | guard-паттерн define.ts: принять `(function(){})` / ведущий комментарий | INDEP |
| **V4** | object-payload субстрат (args number→unknown ×7 точек + FAULT-путь + `EventSpec.payload`); DoD: byte-identical no-payload корпус, PRNG-нейтральность, **канонич. сериализация payload в shrinkCacheKey/hashTrace — зафиксировать ТЕСТОМ** | SIM |
| **V5b** | doneDelta на VERDICT-пути + I-5 sound-зубы (корреляция eventName↔seam-write) | SIM |
| **V3a** | I-4 РЕАЛЬНЫЕ зубы. **Предикат (sound, критик)**: в окне ОДНОГО микрошага — enter: нет пары `enter(s1)` раньше `enter(s2)` где s1 — ПОТОМОК s2; exit: нет `exit(s1)` раньше `exit(s2)` где s1 — ПРЕДОК s2. **Ancestor-relation, НЕ depth-число** (устойчив к BFS-интерливингу и к возможной смене порядка). Red — через synthetic-feed канала (не ждать бага ядра). construction/reset — либо microstep-id, либо явно исключены | SIM |
| **V8** | ISS-030 закрыт через V1b → I-3 в DEFAULT-set + прогон нулевого-ложняк-корпуса (со string-method конфигами) | SIM |
| **V7** | checkMachine хвосты: `guardOutcomes` (из V1c), `nonConvergingRegions` (участвует в предикате ok!), `minimalTrace`-shrink в reproCode, init-config invariant-проверка | SIM |
| **V3b** | §4в sibling-order: измерить фактический порядок каналом vs W3C. **Протокол расхождения (критик: разойдётся почти наверняка — enter BFS vs preorder; exit document vs REVERSE-document)**: вердикт «чинить под стандарт» = **отдельный юнит СЛЕДУЮЩЕЙ волны** (характеризация + corpus-diff §6а + CD-63 DST + migration-note), НЕ расширение V3b. Вердикт «расширение» = фиксация в §4в-карте | INDEP(после V1) |

## Потоки (исправлено по критику — конфликты файлов)

- **CORE (последовательно, `state_machine.ts`+`types.ts`)**: V1 → V1b → V1c → V5a → V6b.
- **SIM (ПОСЛЕДОВАТЕЛЬНО — driver.ts у V3a∩V4, invariants.ts у V3a∩V5b)**: V4 → V5b → V3a → V8 → V7.
- **INDEP (параллельно)**: V2, V6a; V3b — после V1.
- **api-report** регенерится ОДИН раз финально ОРКЕСТРАТОРОМ (общий файл всех потоков).
- **trace-version** — ОДИН координированный bump ('3'→'4'), вбирающий doneDelta (V5b) и любые
  lifecycle-поля трейса (V3a).

## Верификация (каждый юнит)

1. red→green (для V3a — synthetic-feed нарушитель). 2. полный vitest (JUnit) + оба tsc + knip.
3. **Аддитивность**: старый IMonitor-стаб без новых методов работает; поведение машины НЕ изменилось
(1018 существующих тестов зелёные). 4. **Sink-guard**: бросающий монитор НЕ ломает дренаж (тест).
5. **Near-zero**: канал не подписан → нет вызовов. 6. Нулевой-ложняк-корпус §4а.2 (V3a, V8) +
двусторонний meta §4а.1 (I-4 no-op→teeth; I-3 opt-in→DEFAULT). 7. Replay-детерминизм (V4
byte-identical; V5b/V3a один version bump). 8. dist-политика: CORE-юниты → baseline ОДНИМ
осознанным коммитом + `act` linux-репро; SIM — core байт-идентичен. 9. mb3-critic (fable, advisory)
приёмка КАЖДОГО юнита → дефект → воспроизвести → доводка → re-критик. 10. план-факт §0.7.

## Реестр находок-в-работе (ничего не оставляем)

Все хвосты W6/W7 включены: guardOutcomes/nonConvergingRegions/minimalTrace/init-config (V7),
I-3→DEFAULT (V8), ISS-030 (V1b), U2-ниты (V6a/V6b), §4в sibling (V3b), I-4 (V3a), I-5 (V5b),
payload (V4). Новые находки приёмок добавляются сюда же по ходу волны.
