# W3 план-факт: семантика — гарды, правило селекции, OTS, порядок фаз

> Артефакт §0.7. Волна W3 (сердце работы). Ветка `remediation/w1-prep`.
> Под-волны: W3-A F7/F8 (предусловие), W3-B правило+перф+detailed, W3-C OTS+фазы, W3b invoke.

## W3-A — F7/F8 (предусловие правила) — verdict CLOSED

| дефект | факт | подтверждение (оркестратор-прогон) |
|---|---|---|
| F7 [HIGH] ошибка гарда слепа для monitor | guard.catch → `monitor.recordError(err, {phase:'guard'})` (W1-dedup маркер); переход disabled (fireEvent=false, обратная совместимость) | recordError=1 (был 0); не задваивается с onError; ===0 при disabled errorHandler |
| F8 [HIGH] guard победителя дважды | снесён Phase 1 guard re-check в applyTransition (гард проверен 1 раз в getAllowedTransitions) | guard вызван РОВНО 1 раз (плоский/priority/composite); недетерм. guard не отменяет выбранный переход; abort/errorState в Phase 3/6 — не задет |

Итог W3-A: **862 passed / 14 skipped; оба tsc чисты**; гейт характеризации 10/10 (W3-A про гарды/
наблюдаемость, не про ВЫБОР — селекция не сдвинута); W0/W1/W2 62/62. Полная отличимость
guard-error vs guard-rejected (fireEventDetailed) отложена в W3-B корректно.

## W3-B — правило селекции SCXML + ленивые гарды + fireEventDetailed + перф — verdict CLOSED (после перф-residual)

**Правило селекции реализовано и корректно по ВСЕМ 9 осям** (verify + оркестратор-прогон):

| ось | факт | подтверждение |
|---|---|---|
| потомок бьёт предка | НЕЗАВИСИМО от порядка объявления (было last-declared) | оба порядка → DONE (потомок); F9 закрыт |
| priority default 0 | отрицательный НИЖЕ неуказанного (было -Infinity → любое число выше) | `-5` проигрывает неуказанному |
| специфичность | явный `from` бьёт wildcard всегда (не по порядку) | оба порядка → explWon |
| document order | первый объявленный при равенстве | ✓ |
| ленивые гарды | до первого прошедшего, остальные не исполнены | счётчик: проигравшие 0 |
| fireEventDetailed | guard-error / guard-rejected / no-transition различимы (F4 закрыт) | discriminated union; fireEvent всё ещё boolean |
| conformance | W3C SCXML IRP-векторы (child-over-parent, doc-order tie) | проходят |
| реализация | стабильная сортировка (priority↓,специфичность↑,docIndex↑) + ФИЛЬТР доминирования (не ветка компаратора — частичный порядок) | предвычисление в конструкторе (`orderedTransitions`) |
| **корпус 9 клеток** | **РАНТАЙМ-победитель НЕ изменился ни в одной** — все «evaluate→route» с взаимоисключающими гардами (ровно один истинен), lazy выбирает первый прошедший | blast radius = 0 фактически (как и предсказывал W1-prep) |

Характеризация ПЕРЕПИСАНА в целевые SCXML (не удалена — дельта = скелет migration-note §9).

**Перф-residual (verify perfNotWorse:False, закрыт оркестратором):** фильтр доминирования O(T²·L)
исполнялся EAGER по всем кандидатам. Фикс: coverMap ЛЕНИВО, только для пар с равными
(priority, специфичность); ранний выход, если таких пар нет.
- реальный профиль (различные ключи) T=100: **43 µs** (было 265 eager);
- корпус T≤3: 5 µs (чистый выигрыш от lazy-гардов + parse-once, +27% vs старое eager);
- **честная граница**: T кандидатов ОДНОЙ группы (равные priority+специфичность, напр. 100
  дубликатов `from` от одного источника) остаётся O(T²·L) — попарное доминирование фундаментально
  квадратично. Это вырожденный конфиг; реальный корпус T≤3. Задокументировано.

Итог W3-B: **878 passed / 14 skipped; оба tsc чисты**; W0/W1/W2 целы; PERF-01 (parse-once) +
PERF-06 (ленивый ErrorContext) применены.

## W3-B.1 — доработка по critic-приёмке W3-B (2 HIGH) — CLOSED

Критик (статический, без Bash) нашёл 2 HIGH в правиле доминирования. Проверено оркестратором ЗАПУСКОМ:

| находка | что | подтверждение |
|---|---|---|
| №1 [HIGH] | `dominates` требовал равного покрытия → в мульти-лэйновом композите лист (1 лист) и родитель (2 листа) несравнимы → document order → родитель объявленный первым БЬЁТ лист (last-declared регресс) | **subset-доминирование**: потомок бьёт предка в ОБА порядка (было: `[предок,лист]`→родитель) |
| №2 [HIGH] | доминирование как ФИЛЬТР удаляло предка ДО гардов → гард потомка отказал → предок потерян (SCXML/UML/§6.1 подняли бы к предку) | доминирование как **ПОРЯДОК** (стабильная топосортировка, потомок раньше, не удалять); гард листа=false → предок ABORTED фолбэк |
| покрытие | класс специфичности `'a|*'` не был покрыт (критик §5) | добавлен тест: явный бьёт `'a|*'` |

Оба фикса — строгий частичный порядок сохранён (subset транзитивен; топосортировка детерминирована).
Red проверен откатом (возврат size-check краснит мульти-лэйн). SPEC §4 обновлён (порядок не фильтр).

Итог W3-B.1: **882 passed / 14 skipped; оба tsc чисты**; W0/W1/W2 регресс 28/28. Согласовано с §6.1
(подъём от листа с гард-фолбэком) — OTS в W3-C наследует корректную семантику.

## W3-C — optimal transition set + порядок фаз applyTransition (П5) — verdict CLOSED

Архитектурная переработка `applyTransition`/`updateState`. Проверено оркестратором ЗАПУСКОМ:

| часть | факт | подтверждение |
|---|---|---|
| OTS §6.1 | per-leaf выбор подъёмом (selectTransition W3-B/B.1 как per-node); каждый регион ≤1 переход | событие в 3 региона → **3 перехода** (был 1); fireEventDetailed.transitions = все |
| OTS §6.2 | removeConflicting по пересечению exit-set; преемпция потомком; несравнимые — precedence order | disjoint-регионы все срабатывают; конфликтующие — потомок |
| OTS §6.3 | объединённые exit (descendant-first) / enter (ancestor-first); commit одной операцией; done.state innermost-first | оба региона к final за микрошаг → COMPLETE (done.state после микрошага, не в середине) |
| П5 единый корень | teardown таймеров + invoke-arm СТРОГО после точки невозврата; enter-set из записанной конфигурации | — |
| Q4 watchdog | timeout per-action; exit-teardown post-commit → source watchdog жив | active→safe (был потерян) |
| T3 deep-restore | previewCommitState резолвит restore ДО enter/exit → onEnter восстановленного листа + invoke взведён | timer-driven машина ОЖИВАЕТ (был мёртв) |
| EO-4 onAfter | arming post-commit → onAfter throw до arming → нет осиротевшего таймера | ✓ |
| T1 to:'*' | резолвится в текущую конфигурацию → onEnter не потерян | ✓ |
| EO-5 abort | abort не коммитит → source timers целы (no zombie); наблюдаемо через logger.warn | таймеры целы |
| единичный выбор | 1 регион = частный случай OTS = byte-identical | selection_scxml/характеризация зелёные |

Итог W3-C: **888 passed / 14 skipped; оба tsc чисты**; W0/W1/W2/W3-A/W3-B регресс 31/31. Мёртвый
кластер updateState/removeConflictingStates/addRegionStates удалён (заменён computeInternalWrite).

**Residual (non-blocking, §0.6):** EO-5 abort наблюдаем только через logger.warn — recordError отнесён
в W4 (verify обосновал: re-arm таймеров дублировал бы, ломая П2). Cross-composite-root leaf→leaf —
pre-existing на baseline, не регресс W3-C.

## W3-C.1 — доработка по critic-приёмке W3-C — CLOSED

Критик (статический, без Bash) нашёл 2 подтверждённых запуском + дыры покрытия:

| id | что | подтверждение |
|---|---|---|
| NUL-байт [MEDIUM] | сырой `\x00` в `state_machine.ts` (моя опечатка W3-B: `${priority}\x00${spec}` вместо пробела) — rg считал файл бинарным, ломал grep-тулинг | заменён на пробел; NUL:0 |
| дубликаты rejected [MEDIUM] | `computeEnabledSet` пушил rejected по разу на лист → кандидат governing N листьев давал N записей; кэш guard-error терял `error` | дедуп по transition-label; кэш хранит `error`; guard-rejected в 3 региона → 1 запись, guard-error несёт error |
| тесты взаимодействий | частичный OTS, guard-error в одном регионе, дедуп — не покрыты | добавлены (10 тестов ots_microstep): partial→1, guard-error не глушит другие регионы, дедуп, error через кэш |
| transitionTimeout [сверка] | SPEC §11 рекомендовал per-microstep, реализовано per-action | SPEC §11 обновлён: **per-action принят** (соответствует «максимум на действие», прежнее поведение) |
| abort-наблюдаемость | abort маскируется под no-transition; recordTransition(_,false) мёртв | → задача #14 (W4): `reason:'aborted'` + monitor-канал |

Итог W3-C.1: **892 passed / 14 skipped; оба tsc чисты**; W0-W3 регресс 58/58.

## W3b — invoke-операции с AbortSignal + ExitContext (новая фича, SPEC §6а) — verdict CLOSED

Прямой ответ на вопрос владельца из начала сессии (как лэйны узнают про abort и сворачивают работу):

| часть | факт | подтверждение (оркестратор-прогон) |
|---|---|---|
| invoke union | `StateInvocation = InvokeTimer \| InvokeOperation`; таймерная форма сохранена дословно | таймерная форма зелёная (advanced_features) |
| операция + AbortSignal | `src:(adaptee,signal)=>Promise` в `activeInvokes` рядом с per-leaf таймерами; запуск через инжектированный scheduler | операция стартует при входе |
| abort при выходе | `abort()` в `executeExitActions` ДО onExit, синхронно | `signal.aborted` виден в onExit (лэйн узнал) |
| onDone/onError | через raiseEvent (результат/ошибка в payload) | ✓ |
| отменённая игнорируется | `signal.aborted` к моменту settle → событие НЕ в очередь | состояние `aborted`, onDone НЕ увёл в okState (нет призрака) |
| отказ без onError | → reportRuntimeError → monitor.recordError (политика F7) | наблюдаемо |
| ExitContext | `{event,preempted,wasFinal,target}` доп. аргументом в onExit (payload не заменён) | preempted:true при parallel-exit, false при final; argc+1 |
| DST | запуск/отмена через scheduler | детерминизм |
| валидатор | INVOKE_NO_HANDLER активирован для src без onDone/onError (заготовка W2b) | ✓ |

Итог W3b: **899 passed / 14 skipped; оба tsc чисты**; W0-W3 не тронуты. Residual (contract note, не
дефект): `preempted = NOT(reached-final)` — промежуточный лист сообщает preempted:true; соответствует
буквальному SPEC.

## Вывод W3 (A + B + B.1 + C + C.1 + b)

Семантика ядра переписана: правило выбора перехода SCXML/UML, optimal transition set (несколько
переходов за микрошаг), корректный порядок фаз с живыми таймерами. Гарды наблюдаемы и ленивы.
Комбинационные сценарии (история+таймеры+abort, мультиобъект+история) проверены. Осталось W3b
(invoke-операции + ExitContext — новая фича, ответ на вопрос про abort лэйнов).

## W3b — invoke-операции + ExitContext (новая фича) — ОЖИДАЕТ