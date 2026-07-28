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

## Осталось (не блокер)

Перф PERF-03 (Θ(R²) setCurrentState), PERF-02 (checkCompletion безусловен), PERF-05 (монитор 36%) —
задача #15 (П14 частично: PERF-01/06 закрыты в W3-B). Отдельная перф-волна после W6.