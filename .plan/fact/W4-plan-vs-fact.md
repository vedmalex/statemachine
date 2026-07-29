# W4 план-факт: наблюдаемость (П6/П9/П13/EO-3/EO-8)

> Артефакт §0.7. Волна W4. Ветка `remediation/w1-prep`.

## Факт (verdict CLOSED после residual-фикса)

| дефект | факт | подтверждение (оркестратор-прогон) |
|---|---|---|
| П6 [MEDIUM] мультиобъектные таймеры | activeTimers/activeInvokes/stateEntryTimes/historyMap → `WeakMap<owner>` (было машино-level по имени состояния) | 2 adaptee: таймеры/операции/история изолированы, не гасят друг друга (критик W3b: с операциями радиус вырос) |
| П9/EO-3 метрики лгут | recordTransition(_,false) на guard-rejected + abort; successCount=max(0,...); errorRate=100 при 0-переходов+ошибках | health 'critical' на errorState-глотающей машине (был ложный 'healthy') |
| abort-наблюдаемость (W3-C.1 residual) | reason:'aborted' (additive §7) ≠ 'no-transition'; recordTransition(_,false) на abort | sim W5 отличит «нет кандидата» от «микрошаг отменён» |
| П13/EO-8 экспорт | StateMachineMonitor/createDefaultMonitor/logger/setDefaultLogLevel из index; публичные getMonitor/getMetrics | доступны; EO-8 ПОСЛЕ EO-3 (не экспортируем враньё) |
| residual (adversarial-verify) errorState невидим | health лгал 'healthy' на errorState recovery | recordTransition(false) на errorState-пути (errorCount 0→1, нет double) |
| residual guard-error задвоен | errorCount=2 (recordError + recordTransition) | исключён guard-error из recordTransition (recordError уже наблюдаем); errorCount=1 |

Итог W4: **915 passed / 14 skipped; оба tsc чисты**; W0-W3 регресс цел. auto-start монитора НЕ включён
(риск утечки setInterval по сьюту) — health on-demand через getMonitor().getMonitoringReport().

## W4.1 — доработка по critic-приёмке W4 (обратная ложь health) — CLOSED

Критик (без Bash) нашёл: EO-3-фикс закрыл false-healthy в одну сторону, открыл в другую. Проверено запуском:

| id | что | подтверждение |
|---|---|---|
| #1 [HIGH для W5] health обратная ложь | guard-rejected (штатный отказ) через recordTransition(false)→recordError красил здоровую машину critical (10 успехов+2 отказа) | разведены REFUSAL (failedTransitions) и ERROR (recordError); здоровая+guard-отказы → **healthy**, сломанная(guard-error) → **critical** |
| #2 [MEDIUM] invokeRestartCount глобальный | мультиowner обходил livelock-bound W3b.1 (коммит B обнулял A) | WeakMap<owner,Map<leaf>>; чистка только exit-set владельца — bounded независимо |
| #3 [MEDIUM] errorState detailed vs метрика | fired:true противоречил failed | applyMicrostep {kind:'ok'\|'error-state'}; detailed reason 'error-state' (fired:false) — 3 канала согласованы |
| #4 [MEDIUM] stale sim-комментарии | утверждали до-W4 «recordTransition только success» — W5-оракулы прочли бы ложь | обновлены под реальный контракт |
| #5 setDefaultLogLevel холостой | console-шим движка мимо logger.ts | подключён/JSDoc честен |

Итог W4.1: **920 passed / 14 skipped; оба tsc чисты**; W0-W4 регресс цел. verify независимо
воспроизвёл. successCount больше не смешивает refusal/error домены.

## Осталось (не блокер)

Перф PERF-03 (Θ(R²) setCurrentState), PERF-02 (checkCompletion безусловен), PERF-05 (монитор 36%) —
задача #15 (П14 частично: PERF-01/06 закрыты в W3-B). Отдельная перф-волна после W6.