# User Requests

## UR-001
- Timestamp: 2026-06-22 02:26
- Source: user
- Text (verbatim): "VOPR-style DST simulator for the state machine (deterministic simulation testing)"
- Continued from task: TASK-013
- Continuation reason: TASK-013 landed the deterministic-replay seam (options.clock + createVirtualScheduler). This epic builds the VOPR-style deterministic simulator on top of that seam: a seed-driven scenario generator, a fault-injection layer adapted to a single-process state machine (event reorder/drop/dup, callback errors/throws, clock skew, scheduler jitter, event-queue overflow), safety+liveness modes, invariant checkers, failing-trace shrinker/minimizer, and long-running CI integration. Reuses the clock/scheduler injection contract from TASK-013 and the region-join semantics from TASK-012.

## UR-002
- Timestamp: 2026-06-22 02:26
- Source: user
- Text (verbatim): "Построить VOPR-style Deterministic Simulation Testing (DST) для машины состояний, по образцу симулятора TigerBeetle VOPR. Реальный код машины (не моки) гоняется внутри полностью контролируемой детерминированной среды; источники недетерминизма мокируются и управляются seed'ом. Адаптация модели TigerBeetle (распределённый кластер) на одно-процессную машину состояний: вместо сети/диска/процессов инжектируем недетерминизм на уровне очереди событий, планировщика и колбэков. Объём (амбиция: полноценный VOPR-симулятор как подсистема, T5:epic): (1) seed-driven генератор сценариев — один seed детерминированно воспроизводит весь прогон до бита; (2) fault-injection слой: переупорядочивание / потеря / дублирование событий, ошибки и исключения в guard/action/колбэках, clock skew (ускорение/замедление виртуального времени), jitter планировщика таймеров, переполнение очереди событий; (3) Safety-режим — проверка инвариантов корректности: детерминизм (один seed → идентичный trace), отсутствие потерянных событий, корректность входа/выхода иерархии (ancestor-first/descendant-first, TASK-012), корректность join параллельных регионов, отсутствие недостижимых/застрявших состояний; (4) Liveness-режим — машина продолжает прогрессировать при наличии валидных условий перехода даже под жёсткой инъекцией отказов; (5) shrinker/минимизатор — найденный падающий trace автоматически сжимается до минимального воспроизводящего; (6) интеграция в CI как long-running прогон (большое число seed'ов). Опирается на seam инъекции времени из TASK-013 (options.clock + createVirtualScheduler) и семантику регионов из TASK-012. Референсы: docs.tigerbeetle.com/concepts/safety/, блог TigerBeetle про simulation testing (safety + liveness), sim.tigerbeetle.com. Defense-in-depth: DST изнутри дополняет обычные unit-тесты."

## UR-003
- Timestamp: 2026-06-22 02:32
- Source: user
- Text (verbatim): "Уточнённая суть задачи: подготовить СРЕДУ СИМУЛЯЦИИ, на которой можно (1) тестировать НАГРУЗОЧНО работу машины состояний (высокий объём событий/переходов, стресс-сценарии) и (2) отлаживать новые фичи в детерминированной воспроизводимой среде. Это переопределяет акцент UR-002: симулятор — это не только bug-hunting через fault-injection, но и постоянный инструмент разработки/отладки и нагрузочного тестирования."

## UR-004
- Timestamp: 2026-06-22 02:33
- Source: user
- Text (verbatim): "Покрытие и обязательность: (а) симуляция должна покрывать ВЕСЬ функционал машины состояний (события/переходы, guards/actions, иерархия и composite-состояния, параллельные регионы + join, history, таймеры/after, очередь событий, clock-injection). (б) ОБЯЗАТЕЛЬНЫЙ GATE: при добавлении любой новой фичи она помимо стандартных юнит/интеграционных тестов ОБЯЗАНА проходить через симуляцию (defense-in-depth). Следствие для архитектуры: симулятор должен быть расширяемым и декларативным, чтобы новые фичи легко выражались как сценарии/инварианты. Решение по tier/структуре: одна большая задача без декомпозиции на дочерние (T4:standard, подробный план вместо child-tasks). Roadmap-привязка остаётся RM-001-P03 без реорганизации."

## UR-005
- Timestamp: 2026-06-22 02:38
- Source: user
- Text (verbatim): "Решения интервью (развилки для плана): (1) ЛОКАЦИЯ — симулятор и для внутреннего, и для внешнего использования: экспортируемый sim-подпакет (потребители симулируют свои машины) + внутренний харнесс проекта. Следствие: учёт стабильности API + bundle budget (TASK-010) + ABI-тесты; sim желательно вынести в отдельный entrypoint, чтобы не раздувать основной bundle. (2) LOAD — стресс + перф-метрики: throughput событий/сек, память, распределение длин trace + регрессионные пороги в CI. (3) GATE — программный CI-gate: CI падает, если возможность машины не покрыта сим-сценарием (coverage-чек против реестра capability). (4) FAULT MODEL — полный набор сразу в v1: reorder/drop/dup событий, ошибки/исключения в guard/action/колбэках, clock skew, jitter таймеров, переполнение очереди."

## UR-006
- Timestamp: 2026-06-22 15:32
- Source: user
- Text (verbatim): "Требования к завершению/релизу (после ARCHIVE): (1) BUMP версии пакета (текущая 1.0.0-beta.3; аддитивная ./sim-фича → вероятно beta.4 через changeset). (2) ОБНОВИТЬ ДОКУМЕНТАЦИЮ (README секция Simulation/DST про ./sim API + CHANGELOG; typedoc подхватится docs.yml). (3) КОММИТ всего содержимого репозитория (TASK-014 src/sim + tests + wiring + memory-bank артефакты + .plan). (4) ОПУБЛИКОВАТЬ версию через gh (release.yml — workflow_dispatch, делает bun publish --tag beta и затем npm dist-tag add ... latest). НЕОБРАТИМОЕ внешнее действие — подтвердить версию + факт движения latest-тега перед запуском. Предполагает merge feat/dst-simulation-TASK-014 → main."
