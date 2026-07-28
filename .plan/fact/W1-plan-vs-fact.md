# W1 план-факт: устойчивость рантайма + подготовка

> Артефакт §0.7. Волна W1. Ветка `remediation/w1-prep`. Дефекты П2/П3/П8 + подготовительный слой.

## План (MASTER §3 W1)

Устойчивость рантайма (#12: П2 RTC-разрыв, П3 реентрантность, П8 run-away) + корпус MB3 (#24) +
характеризация селекции + заморозка red-тестов sim (порядковый инвариант: до фикса П2).

## Факт

### Подготовительный слой (коммит `a2cf228`)

| юнит | результат |
|---|---|
| Заморозка sim-red | `blockers_frozen.test.ts`: A1/A2/A4/A5/C1 `describe.skip`, все воспроизведены на HEAD ДО заморозки (порядковый инвариант соблюдён — A1 заморожен до фикса П2) |
| Корпус MB3 | `W1-mb3-corpus-matrix.md`: 30 конфигов, 310 клеток. **Blast radius смены правила = 9 клеток** (hook-конфиги), 0 wildcard, 0 предок/потомок. Снят риск «оценить нечем» |
| Характеризация | `selection_characterization.test.ts`: 5 осей × 2 порядка (10 тестов) фиксируют last-declared-wins — датчик для W2 |

### Устойчивость рантайма (#12)

| дефект | фикс | подтверждение |
|---|---|---|
| П2 [C] RTC-разрыв | симметричный catch во внутренней ветке processQueues; ошибка → `reportRuntimeError` (monitor.recordError + onError — НАБЛЮДАЕМЫЙ канал, нужен для sim A1 в W5); дренаж продолжается, внешние промисы не виснут, процесс жив | red воспроизвёл unhandledRejection; verify: разные броски внутр.события → процесс жив, ошибка наблюдаема |
| П3 [H] реентрантный дедлок | reentrancy-guard в enqueueEvent: внешний fireEvent при isProcessing → reject с внятным StateMachineError; raiseEvent остаётся легальным; resumed-invoke-timer переведён на raiseEvent | verify: реентрант из onEnter/onTransition/guard → reject; raiseEvent работает; внешняя очередь не сломана |
| П8 [H] run-away недостижим | счётчик за дренаж вместо глубины рекурсии; MAX_TRANSITION_DEPTH достижим; превышение → наблюдаемо (reportRuntimeError), не тихо; `/* c8 ignore */` снят | red: ping-pong ловится, setTimeout дышит |

## Дельта план→факт (§0.6 — только полнота)

**П8 over-fix РЕГРЕССИЯ (нашёл adversarial-verify, verdict RESIDUAL, закрыто оркестратором).**
Первый фикс П8 инкрементировал счётчик ДО ветвления internal/external → синхронный батч >100 ВНЕШНИХ
fireEvent (нормальный RTC-паттерн: replay лога, поток событий) ложно ловился на 101-м как run-away.
Воспроизведено оркестратором: N=500 → 400 rejected. Причина: `transitionDepth++` на строке 394 до
ветки. **Фикс:** инкремент только в internal-ветке (raised переходы = самоподдерживающийся цикл);
сброс `transitionDepth=0` при внешнем событии (свежий RTC-шаг). После: N=500 → 0 rejected, run-away
всё ещё ловится. Добавлен регресс-тест «батч 500 внешних → 0 rejected».

## Итог

**821 passed / 14 skipped; tsc чисто** (оркестратор-прогон). W0 security-регресс (security_rce +
source_scan + serialization_registry) зелёный — не реоткрыт. Легит цепочки (15 внутренних, внешний
батч) работают.

## W1.1 — доработка по critic-приёмке (ACCEPT С ЗАМЕЧАНИЯМИ) + finalize

Critic-приёмка (статическая, критик без Bash) нашла блокер W2 — П3-детектор реентрантности ШИРЕ
дефекта. Проверено оркестратором ЗАПУСКОМ, закрыто:

| id | что | подтверждение |
|---|---|---|
| П3-точность [HIGH, блокер] | детектор ловил ложно легит внешние события | `AsyncLocalStorage` drainContext + epoch: reject только из логического стека дренажа. **Все 4 случая проверены запуском**: (а) внешний-в-async-окно RESOLVED, (в) chained RESOLVED, (б) fireEvent из onError RESOLVED, (г) 2й adaptee RESOLVED; истинный реентрант всё ещё reject |
| П3(б) residual | verdict RESIDUAL: onError бежал под drain-контекстом | `processError` возвращаемый handler обёрнут в `drainContext.exit` — любой user error-handler вне контекста; default-rethrow пропагируется сквозь. Red проверен откатом |
| П3-сообщение | советовал private raiseEvent | переформулировано без несуществующего API |
| П2 закалка | getCurrentState мог воскресить unhandledRejection; двойной recordError; тихая дыра | `safeGetCurrentState`; `RUNTIME_ERROR_REPORTED` symbol-дедуп (recordError=1, критично для sim W5); logger.error floor при disabled+no-onError |
| П8 конфиг | MAX=100 захардкожен | `maxTransitionDepth` в StateMachineOptions (дефолт 100); тест ужесточён n<K→n≲MAX |
| тесты (б)(г) | verify: отсутствовали | добавлены, (б) проверен откатом |

Итог W1.1: **828 passed / 14 skipped; tsc чисто; W0+W1 регресс 34/34** (оркестратор-прогон).

## Вывод W1 (prep + #12 + W1.1)

Устойчивость рантайма закрыта целиком. Три слоя проверки поймали три класса дефектов: adversarial-
verify — over-fix счётчика (внешний батч), critic-приёмка — over-scope детектора (легит события),
второй verify — residual (onError под контекстом). Связь П2↔A1 подтверждена критиком: ошибка
внутреннего события в monitor (recordError=1, без задвоения) — sim прочитает как violation в W5.
Blast radius смены правила измерен: 9 клеток. Фундамент под W2 (компилятор конфига) устойчив.