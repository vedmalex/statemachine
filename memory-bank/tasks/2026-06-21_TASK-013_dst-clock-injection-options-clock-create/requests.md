# User Requests

## UR-001
- Timestamp: 2026-06-21 08:29
- Source: user
- Text (verbatim): "DST clock-injection: options.clock + createVirtualScheduler for deterministic replay"

## UR-002
- Timestamp: 2026-06-21 08:29
- Source: user
- Text (verbatim): "Сделать так, чтобы библиотека @vedmalex/statemachine не была причиной сложностей для DST-окружения (детерминированный replay) использующих её приложений/библиотек. Аудит (4 параллельных агента + design workflow с adversarial-критикой) установил: PRNG отсутствует, guards чистые; единственный класс реальных блокеров replay — wallclock в таймерном пути. Решение: инъекция часов options.clock?: () => number (default Date.now) + экспорт createVirtualScheduler(clock) + README DST-раздел. Закрыть блокеры: #1 stateEntryTimes/resumeTimers (state_machine.ts:2137,2446) -> this.clock(); #2 setTimer: при явно поданном scheduler всегда роутить через него (state_machine.ts:2193); #3 TimerScheduler clock-инъекция (scheduler.ts) + process?(now?) в ITimerScheduler (types.ts); #4 transitionTimeout через scheduler (state_machine.ts:1788). HARD CONSTRAINT: default-поведение (без options.clock/scheduler) остаётся byte-identical. Adversarial-критик (вердикт needs-revision) добавил 3 обязательные ревизии: (A) CRITICAL — виртуализировать писателей timestamp очереди 247/260/277 согласованно с читателем :492; (B) HIGH — НЕ делать sort() initial региона #1318 (ломает ~60 конфигов, insertion-order уже детерминирован); (C) MEDIUM — гейтить .finally(clearTimer) transitionTimeout за schedulerProvided для byte-identical default. security.ts createdAt-in-hash вне scope (@deprecated, не в dist)."
