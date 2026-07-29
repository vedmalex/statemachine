# W1 — Корпус MB3-конфигов + матрица селекции (задача #24)

Дата: 2026-07-28. Ветка: `remediation/w1-prep`. HEAD этого репозитория на момент
сбора: `af3d2de39ea5d5293da52a1180d4dd42123902dd`. Источник корпуса (только чтение,
НИЧЕГО в agent-skills не менялось): `~/work/agent-skills/plugins/workflow-plugins/core-workflow/machines/`
(канонический source-каталог; побайтово сверен с зеркалом
`~/work/agent-skills/plugins/dist/server/workflow-plugins/core-workflow/machines/` —
`diff` по `task-sm.config.ts` дал пустой вывод, оба дерева идентичны на момент сбора).
`.claude/worktrees/agent-*/...` копии игнорировались (снапшоты параллельных агентских
сессий, не источник истины).

## 0. Метод

**Правило-под-проверкой** — «last-declared-wins», подтверждено чтением ДВИЖКА
`@vedmalex/statemachine` этого самого пакета (только чтение, `src/state_machine.ts`
не менялся):

```
packages/statemachine/src/state_machine.ts:2201-2241  private async getAllowedTransitions(...)
  for (const transition of transitions) {
    if ((transition.priority ?? -Infinity) < highestPriority) continue   // 2210
    ...
    if (!guardResult) continue                                           // 2232
    highestPriority = transition.priority ?? -Infinity                   // 2236
    selectedTransition = transition                                      // 2237
  }
  return selectedTransition
```

Точная семантика (не приближение — прочитано построчно):
- Обход `transitions` в порядке ОБЪЯВЛЕНИЯ в массиве конфига.
- `priority` по умолчанию отсутствует → трактуется как `-Infinity` (все переходы
  БЕЗ явного `priority` равноприоритетны между собой).
- Переход пропускается (`continue`), ТОЛЬКО если его `priority` СТРОГО МЕНЬШЕ уже
  зафиксированного `highestPriority`. Значит переход с РАВНЫМ приоритетом никогда
  не пропускается по этой причине — гард всё равно вычисляется.
- Если гард (или его отсутствие → `true`) проходит, ЭТОТ переход СТАНОВИТСЯ новым
  `selectedTransition`, `highestPriority` перезаписывается тем же (или бо́льшим)
  значением.
- Итог: среди переходов с ОДИНАКОВЫМ (или отсутствующим) `priority`, чей гард
  проходит, побеждает ПОСЛЕДНИЙ по порядку объявления в массиве — это и есть
  «last-declared-wins». Явный `priority` — единственный способ ВЫЙТИ из-под этого
  правила (см. `pretool-enforcement-chain.config.ts`, §6 ниже): более высокий
  `priority` не может быть вытеснен более поздним по объявлению переходом с более
  низким `priority`.
- Wildcard `from: '*'` матчится безусловно (`state_machine.ts:2250`); ни один
  конфиг корпуса такой wildcard не использует (проверено `grep -rn "from:\s*'\*'"`
  по всему каталогу `machines/` — 0 совпадений, кроме этой строки движка).
- Predecessor/descendant matching: `isTransitionPossible` (2243+) считает
  композитный `from` (например, `'PLAN'`) СОВПАДАЮЩИМ, если текущее состояние —
  ЭТОТ узел ИЛИ вложенный лист под ним (`isParentState`, регион-ключ по
  `lastIndexOf('.')`). Это релевантно `gated-phase-composite` — см. §5.4.

**Конфликт** (в терминах задания) — событие, для которого в (`state`, `event`)
существует ≥2 подходящих (по `from`, без учёта рантайм-истинности гарда) перехода,
ИЛИ где `from` одного перехода — предок/потомок `from` другого перехода ТОГО ЖЕ
события, ИЛИ используется wildcard. Такие клетки — ровно blast radius смены
правила «last-declared-wins» → что-то ещё в W3: сегодня побеждает последний
объявленный кандидат; при другом правиле (например «первый матч» или
«guard-приоритет по алфавиту гарда») победитель СТАТИЧЕСКИ может смениться, даже
если рантайм-поведение сегодня безопасно за счёт взаимоисключающих гардов.

Отдельно помечены переходы с ЯВНЫМ `priority` (`pretool-enforcement-chain`) —
они структурно тоже «≥2 кандидата», но их резолюция УЖЕ не зависит от порядка
объявления (см. выше), поэтому смена дефолтного правила для БЕЗ-приоритетных
переходов их не затронет. Они посчитаны в `conflictsFound`, но помечены
`[priority-immune]`.

## 1. Корпус — что собрано

10 именованных машин из задания + все прочие `*.config.ts` в том же каталоге
(`hook-*` — 9 файлов — и `pretool-enforcement-chain`), итого **20 файлов
`*.config.ts`**. Не-конфигурационные `.ts`-соседи в том же каталоге
(`phase-sm-factory.ts`, `pretool-enforcement-chain-wiring.ts`,
`route-contract.ts`, `route-from-manifest.ts`) прочитаны для контекста фабрик, но
не являются `StateMachineConfig` сами по себе — не включены в матрицу как
отдельные конфиги.

| # | Файл | `name` | Тип | Тиры |
|---|---|---|---|---|
| 1 | `task-sm.config.ts` | `task-sm` | синглтон | — |
| 2 | `phase-sm.config.ts` | `phase-sm` | **фабрика** (`createPhaseSmConfig`) | 6 (T0..T5) |
| 3 | `da-gate-sm.config.ts` | `da-gate-sm` | синглтон | — |
| 4 | `gated-phase-composite.config.ts` | `gated-phase-sm` | **фабрика** (`createGatedPhaseSmConfig`) | 6 (T0..T5) |
| 5 | `roadmap-sm.config.ts` | `roadmap-sm` | синглтон | — |
| 6 | `plan-item-sm.config.ts` | `plan-item-sm` | синглтон | — |
| 7 | `ur-sm.config.ts` | `ur-sm` | синглтон | — |
| 8 | `skill-invocation-sm.config.ts` | `skill-invocation-sm` | синглтон | — |
| 9 | `lock-sm.config.ts` | `lock-sm` | синглтон | — |
| 10 | `artifact-sm.config.ts` | `artifact-sm` | синглтон | — |
| 11 | `hook-permission-request.config.ts` | `hook-permission-request` | синглтон | — |
| 12 | `hook-post-compact.config.ts` | `hook-post-compact` | синглтон | — |
| 13 | `hook-post-tool.config.ts` | `hook-post-tool` | синглтон | — |
| 14 | `hook-pre-compact.config.ts` | `hook-pre-compact` | синглтон | — |
| 15 | `hook-pre-tool.config.ts` | `hook-pre-tool` | синглтон | — |
| 16 | `hook-session-start.config.ts` | `hook-session-start` | синглтон | — |
| 17 | `hook-stop.config.ts` | `hook-stop` | синглтон | — |
| 18 | `hook-subagent-stop.config.ts` | `hook-subagent-stop` | синглтон | — |
| 19 | `hook-user-prompt-submit.config.ts` | `hook-user-prompt-submit` | синглтон | — |
| 20 | `pretool-enforcement-chain.config.ts` | `pretool-enforcement-chain` | синглтон, **priority-based** | — |

18 синглтонов + 2 фабрики × 6 тиров = **30 конкретных SM-конфигов** проматрицировано.

### 1.1 Граница генерируемых (фабричных) конфигов — TIER_TO_PHASES явно

Источник: `~/work/agent-skills/plugins/_shared/runtime/mb3-workflow-topology.ts`
(zero-import контракт, `WORKFLOW_TOPOLOGY_CONTRACT_REVISION = "2026-04-19"`).

```
TIER_TO_PHASES = {
  "T0:trace-only": ["VAN", "IMPLEMENT", "ARCHIVE"],
  "T1:patch":      ["VAN", "IMPLEMENT", "QA", "ARCHIVE"],
  "T2:quick":      ["VAN", "IMPLEMENT", "QA", "REFLECT", "ARCHIVE"],
  "T3:moderate":   ["VAN", "PLAN", "IMPLEMENT", "QA", "REFLECT", "ARCHIVE"],
  "T4:standard":   ["VAN","CREATIVE","PLAN","TECH_SPEC","IMPLEMENT","QA","CODE_REVIEW","REFLECT","ARCHIVE"],
  "T5:epic":       ["VAN","CREATIVE","PLAN","TECH_SPEC","IMPLEMENT","QA","CODE_REVIEW","REFLECT","ARCHIVE"],
}
```

T4 и T5 — **структурно идентичная** последовательность фаз (обе == полный
`PHASE_ORDER`); для целей этой матрицы T4 и T5 дают байт-идентичную топологию SM
(различаются только вне-SM метаданными тира — `TIER_METADATA.childTasks` и т.п.,
которые в конфиг переходов не попадают). Ниже они всё равно перечислены раздельно
(как того требует директива «перечисли явно»), но таблицы у них одинаковы.

DA-гейты (`DA_GATES`, `~/work/agent-skills/plugins/_shared/runtime/da-enforcement.ts:149-192`)
и их `minTier`, использованные для `getGatedPhasesForTier` (через
`resolveEffectiveGateRule`, для coding-workflow байт-идентично сравнению
`parseTierLevel(tier) >= DA_GATES[phase].minTier`):

| Фаза | minTier | lens (проза, не lens_id) |
|---|---|---|
| CREATIVE | 3 | Design Integrity + UR-Goal Traceability |
| PLAN | 3 | Completeness + UR-Goal Traceability |
| TECH_SPEC | 4 | Justification |
| IMPLEMENT | 3 | Plan Fidelity |
| QA | 3 | Coverage |
| CODE_REVIEW | 4 | Sustainability |
| REFLECT | 4 | Honesty |

Отсюда для `gated-phase-composite` (`createGatedPhaseSmForTier`) по каждому тиру
(tierNum = `parseTierLevel`: T0=0,T1=1,T2=2,T3=3,T4=4,T5=5):

| Тир | allowedPhases | daGatedPhases (minTier ≤ tierNum) |
|---|---|---|
| T0:trace-only (0) | VAN, IMPLEMENT, ARCHIVE | *(пусто)* |
| T1:patch (1) | VAN, IMPLEMENT, QA, ARCHIVE | *(пусто)* |
| T2:quick (2) | VAN, IMPLEMENT, QA, REFLECT, ARCHIVE | *(пусто)* |
| T3:moderate (3) | VAN, PLAN, IMPLEMENT, QA, REFLECT, ARCHIVE | PLAN, IMPLEMENT, QA |
| T4:standard (4) | все 9 фаз | CREATIVE, PLAN, TECH_SPEC, IMPLEMENT, QA, CODE_REVIEW, REFLECT (всё кроме VAN/ARCHIVE) |
| T5:epic (5) | все 9 фаз | *(то же, что T4 — REFLECT minTier4 ≤ 5)* |

## 2. Итоговые счётчики

| Метрика | Значение |
|---|---|
| Файлов `*.config.ts` собрано | 20 |
| Конкретных SM-конфигов (синглтоны + тир-инстансы фабрик) | 30 |
| Строк матрицы (`state`,`event`)→победитель | **310** |
| События с конфликтом (≥2 кандидата / предок-потомок / wildcard) | **18** |
| — из них зависящие от «last-declared-wins» (реальный blast radius W3) | **9** |
| — из них `[priority-immune]` (уже резолвятся явным `priority`, не порядком) | **9** |
| Wildcard (`from:'*'`) в корпусе | 0 |
| Ancestor/descendant `from` на одном событии | 0 (см. §5.4 — намеренно спроектировано так в `gated-phase-composite`) |

## 3. Синглтон-конфиги — полные матрицы

Обозначения: **conflict** = клетка с ≥2 кандидатами; «winner» — переход, который
реально выигрывает под текущим правилом (не то, что даёт рантайм-гард — гард
решает, ПРОЙДЁТ ли он, само разрешение конфликта — порядок объявления).

### 3.1 `task-sm` (`taskSmConfig`)

States: `PENDING, ACTIVE, CLOSED, HANDED_OFF`

| state | event | кандидаты (in order) | winner | conflict |
|---|---|---|---|---|
| PENDING | CLAIM | PENDING→ACTIVE | ACTIVE | — |
| ACTIVE | CLOSE | ACTIVE→CLOSED | CLOSED | — |
| ACTIVE | HANDOFF | ACTIVE→HANDED_OFF | HANDED_OFF | — |
| ACTIVE | ADVANCE | ACTIVE→ACTIVE (onTransition=onClaimed) | ACTIVE | — |

Строк: 4. Конфликтов: 0.

### 3.2 `da-gate-sm` (`daGateSmConfig`)

States: `DA_PENDING, DA_REVIEWING, DA_APPROVED, DA_REJECTED, CORRECTION_LOOP_OPEN`

| state | event | кандидаты | winner | conflict |
|---|---|---|---|---|
| DA_PENDING | REVIEW_SUBMITTED | DA_PENDING→DA_REVIEWING | DA_REVIEWING | — |
| DA_REVIEWING | REVIEW_SUBMITTED | DA_REVIEWING→DA_REVIEWING (idempotent self) | DA_REVIEWING | — |
| DA_REVIEWING | REVIEW_APPROVED | DA_REVIEWING→DA_APPROVED `guard:hasApprovedVerdict` | DA_APPROVED | — |
| DA_REVIEWING | REVIEW_REJECTED | DA_REVIEWING→DA_REJECTED `guard:hasRejectedVerdict` | DA_REJECTED | — |
| DA_REVIEWING | REVIEW_EXPIRED | DA_REVIEWING→DA_PENDING | DA_PENDING | — |
| DA_REJECTED | CORRECTION_APPLIED | DA_REJECTED→CORRECTION_LOOP_OPEN (onTransition=incrementCorrectionIteration) | CORRECTION_LOOP_OPEN | — |
| CORRECTION_LOOP_OPEN | CORRECTION_RESOLVED | CORRECTION_LOOP_OPEN→DA_PENDING `guard:correctionContextAllows` | DA_PENDING | — |

Строк: 7. Конфликтов: 0. **Дизайн-примечание**: этот конфиг избегает
многокандидатной клетки, которую допускает `artifact-sm` (§3.10), РАЗНОСЯ
approve/reject по РАЗНЫМ именам событий (`REVIEW_APPROVED` / `REVIEW_REJECTED`)
вместо одного `VERDICT` с двумя гардами — тот же исход, но структурно без
конфликта. Это единственная нетривиальная архитектурная развилка, замеченная при
сборе корпуса: одна и та же семантика (approve-vs-reject после ревью) реализована
ДВУМЯ разными способами в двух соседних конфигах одного каталога.

### 3.3 `roadmap-sm` (`roadmapSmConfig`)

States: `IDLE, ACTIVE, PHASE_COMPLETE, ARCHIVED`

| state | event | кандидаты | winner | conflict |
|---|---|---|---|---|
| IDLE | START_PHASE | IDLE→ACTIVE (onTransition=onActivated) | ACTIVE | — |
| PHASE_COMPLETE | START_PHASE | PHASE_COMPLETE→ACTIVE (onTransition=onActivated) | ACTIVE | — |
| ACTIVE | TASK_CLOSED | ACTIVE→ACTIVE (onTransition=onTaskClosed) | ACTIVE | — |
| ACTIVE | PHASE_COMPLETED | ACTIVE→PHASE_COMPLETE | PHASE_COMPLETE | — |
| PHASE_COMPLETE | ARCHIVE | PHASE_COMPLETE→ARCHIVED | ARCHIVED | — |
| ACTIVE | ARCHIVE | ACTIVE→ARCHIVED | ARCHIVED | — |
| ARCHIVED | RESET | ARCHIVED→IDLE | IDLE | — |

Строк: 7. Конфликтов: 0.

### 3.4 `plan-item-sm` (`planItemSmConfig`)

States: `PENDING, BLOCKED, IN_PROGRESS, DONE, CANCELLED`

| state | event | кандидаты | winner | conflict |
|---|---|---|---|---|
| PENDING | START | PENDING→IN_PROGRESS `guard:dependenciesClear` | IN_PROGRESS | — |
| PENDING | BLOCK | PENDING→BLOCKED | BLOCKED | — |
| IN_PROGRESS | BLOCK | IN_PROGRESS→BLOCKED | BLOCKED | — |
| BLOCKED | UNBLOCK | BLOCKED→PENDING | PENDING | — |
| IN_PROGRESS | COMPLETE | IN_PROGRESS→DONE `guard:hasEvidence` | DONE | — |
| DONE | REOPEN | DONE→IN_PROGRESS | IN_PROGRESS | — |
| PENDING | CANCEL | PENDING→CANCELLED `guard:hasReason` | CANCELLED | — |
| BLOCKED | CANCEL | BLOCKED→CANCELLED `guard:hasReason` | CANCELLED | — |
| IN_PROGRESS | CANCEL | IN_PROGRESS→CANCELLED `guard:hasReason` | CANCELLED | — |

Строк: 9. Конфликтов: 0.

### 3.5 `ur-sm` (`urSmConfig`)

States: `CREATED, ACKNOWLEDGED, IN_PROGRESS, COVERED, SUSPENDED, CANCELLED`

| state | event | кандидаты | winner | conflict |
|---|---|---|---|---|
| CREATED | ACKNOWLEDGE | CREATED→ACKNOWLEDGED | ACKNOWLEDGED | — |
| ACKNOWLEDGED | START | ACKNOWLEDGED→IN_PROGRESS | IN_PROGRESS | — |
| SUSPENDED | START | SUSPENDED→IN_PROGRESS | IN_PROGRESS | — |
| IN_PROGRESS | COVER | IN_PROGRESS→COVERED `guard:hasEvidence` | COVERED | — |
| COVERED | REOPEN | COVERED→IN_PROGRESS | IN_PROGRESS | — |
| ACKNOWLEDGED | SUSPEND | ACKNOWLEDGED→SUSPENDED `guard:hasReason` | SUSPENDED | — |
| IN_PROGRESS | SUSPEND | IN_PROGRESS→SUSPENDED `guard:hasReason` | SUSPENDED | — |
| CREATED | CANCEL | CREATED→CANCELLED `guard:hasReason` | CANCELLED | — |
| ACKNOWLEDGED | CANCEL | ACKNOWLEDGED→CANCELLED `guard:hasReason` | CANCELLED | — |
| IN_PROGRESS | CANCEL | IN_PROGRESS→CANCELLED `guard:hasReason` | CANCELLED | — |
| SUSPENDED | CANCEL | SUSPENDED→CANCELLED `guard:hasReason` | CANCELLED | — |

Строк: 11. Конфликтов: 0.

### 3.6 `skill-invocation-sm` (`skillInvocationSmConfig`)

States: `DECLARED, LOADED, RUNNING, RETURNED, UNAVAILABLE, FAILED`

| state | event | кандидаты | winner | conflict |
|---|---|---|---|---|
| DECLARED | LOAD | DECLARED→LOADED | LOADED | — |
| UNAVAILABLE | LOAD | UNAVAILABLE→LOADED | LOADED | — |
| DECLARED | MARK_UNAVAILABLE | DECLARED→UNAVAILABLE `guard:hasReason` | UNAVAILABLE | — |
| LOADED | DISPATCH | LOADED→RUNNING `guard:hasDispatchId` | RUNNING | — |
| RUNNING | RETURN | RUNNING→RETURNED `guard:hasResult` | RETURNED | — |
| RUNNING | FAIL | RUNNING→FAILED | FAILED | — |
| RETURNED | RESET | RETURNED→LOADED | LOADED | — |
| FAILED | RESET | FAILED→LOADED | LOADED | — |

Строк: 8. Конфликтов: 0.

### 3.7 `lock-sm` (`lockSmConfig`)

States: `IDLE, LOCKED, EXPIRED`

| state | event | кандидаты | winner | conflict |
|---|---|---|---|---|
| IDLE | ACQUIRE | IDLE→LOCKED | LOCKED | — |
| LOCKED | RELEASE | LOCKED→IDLE (onTransition=onReleased) | IDLE | — |
| LOCKED | REFRESH | LOCKED→LOCKED (onTransition=onRefreshed, self) | LOCKED | — |
| LOCKED | EXPIRE | LOCKED→EXPIRED | EXPIRED | — |
| EXPIRED | ACQUIRE_FROM_EXPIRED | EXPIRED→LOCKED | LOCKED | — |

Строк: 5. Конфликтов: 0.

### 3.8 `artifact-sm` (`artifactSmConfig`) — **1 конфликт**

States: `ABSENT, STUB, DRAFT, UNDER_REVIEW, ACCEPTED`

| state | event | кандидаты (in order) | winner | conflict |
|---|---|---|---|---|
| ABSENT | MATERIALIZE | ABSENT→STUB | STUB | — |
| STUB | WRITE | STUB→DRAFT `guard:hasContent` | DRAFT | — |
| ABSENT | WRITE | ABSENT→DRAFT `guard:hasContent` | DRAFT | — |
| DRAFT | WRITE | DRAFT→DRAFT (self, no guard) | DRAFT | — |
| DRAFT | SUBMIT_FOR_REVIEW | DRAFT→UNDER_REVIEW | UNDER_REVIEW | — |
| **UNDER_REVIEW** | **VERDICT** | 1) UNDER_REVIEW→ACCEPTED `guard:verdictApproves`; 2) UNDER_REVIEW→DRAFT `guard:verdictRejects`, `onTransition:countRevise` | **DRAFT** (кандидат #2, объявлен последним) | **CONFLICT (2 candidates, same from)** |
| ACCEPTED | REOPEN | ACCEPTED→DRAFT (onTransition=countRevise) | DRAFT | — |

Строк: 7. Конфликтов: **1**.

Разбор конфликта: сегодня безопасно, потому что `verdictApproves` и
`verdictRejects` — взаимоисключающие по значению `lastVerdict.verdict`
(`PROCEED` vs `REVISE`/`BLOCK`); ровно один гард истинен в момент диспетчеризации,
и «победитель по порядку объявления» совпадает с «победитель по гарду» ТОЛЬКО
потому что оба гарда никогда не проходят одновременно. Если правило сменится так,
что при РАВНЫХ приоритетах побеждает ПЕРВЫЙ прошедший гард (а не последний), а
кто-то по ошибке уберёт/расширит взаимоисключение гардов (например, вернёт
`undefined` вердикт, который сегодня не матчит НИ ОДИН из двух гардов и оставляет
машину в `UNDER_REVIEW`) — статический победитель для клетки
(`UNDER_REVIEW`,`VERDICT`) поменяется с ACCEPTED-ветки-если-обе-true на
DRAFT-ветку-если-обе-true, то есть смена правила БЕЗМОЛВНО инвертирует, какая
ветка «выигрывает при накладке», не меняя код `artifact-sm.config.ts` вообще —
это и есть искомый blast radius.

### 3.9 `hook-permission-request` (`hookPermissionRequestConfig`) — **1 конфликт (3-way)**

States: `IDLE, EVALUATING, ALLOWED, DENIED, DEFERRED`

| state | event | кандидаты | winner | conflict |
|---|---|---|---|---|
| IDLE | EVALUATE | IDLE→EVALUATING | EVALUATING | — |
| **EVALUATING** | **RESOLVE** | 1) →ALLOWED `guard:isAllowed`; 2) →DENIED `guard:isDenied`; 3) →DEFERRED `guard:isDeferred` | **DEFERRED** (#3, последний объявленный) | **CONFLICT (3 candidates, same from)** |
| ALLOWED | RESET | ALLOWED→IDLE | IDLE | — |
| DENIED | RESET | DENIED→IDLE | IDLE | — |
| DEFERRED | RESET | DEFERRED→IDLE | IDLE | — |
| EVALUATING | RESET | EVALUATING→IDLE | IDLE | — |

Строк: 6. Конфликтов: **1** (наибольшая кратность в корпусе — 3 кандидата на
клетку). Сегодняшний default-decision (`onEvaluating`, no `evaluatePermission`
опция) всегда ставит `decision:'allowed'` — то есть по факту РАБОЧАЯ клетка
почти всегда `isAllowed` (кандидат #1), но СТАТИЧЕСКИЙ «победитель по порядку»
— DEFERRED (#3). Расхождение между «что реально сработает по default-гарду
сегодня» и «что победило бы, если бы больше одного гарда стало истинным
одновременно» — именно то, что нужно пере-тестировать в W3.

### 3.10 `hook-post-compact` (`hookPostCompactConfig`)

States: `idle, enriching, done`

| state | event | кандидаты | winner | conflict |
|---|---|---|---|---|
| idle | PRE_COMPACT_DONE | idle→enriching | enriching | — |
| enriching | ENRICHED | enriching→done | done | — |
| done | RESET | done→idle | idle | — |
| enriching | RESET | enriching→idle | idle | — |

Строк: 4. Конфликтов: 0.

### 3.11 `hook-post-tool` (`hookPostToolConfig`)

States: `IDLE, CAPTURING, CAPTURED, PERSISTENCE_FAILED`

| state | event | кандидаты | winner | conflict |
|---|---|---|---|---|
| IDLE | CAPTURE | IDLE→CAPTURING | CAPTURING | — |
| CAPTURING | CAPTURE_SUCCESS | CAPTURING→CAPTURED | CAPTURED | — |
| CAPTURING | CAPTURE_FAILED | CAPTURING→PERSISTENCE_FAILED | PERSISTENCE_FAILED | — |
| IDLE | PASS_THROUGH | IDLE→CAPTURED | CAPTURED | — |
| CAPTURED | RESET | CAPTURED→IDLE | IDLE | — |

Строк: 5. Конфликтов: 0. Примечание: `PERSISTENCE_FAILED` не имеет исходящего
`RESET` (терминально по комментарию файла — «halt blocks subsequent transitions»);
это НЕ конфликт (нет ни одного перехода из него), но стоит держать в уме при
DST-сценариях #25 (застревание, не гонка кандидатов).

### 3.12 `hook-pre-compact` (`hookPreCompactConfig`)

States: `idle, capturing, done`

| state | event | кандидаты | winner | conflict |
|---|---|---|---|---|
| idle | START | idle→capturing | capturing | — |
| capturing | CAPTURED | capturing→done | done | — |
| done | RESET | done→idle | idle | — |
| capturing | RESET | capturing→idle | idle | — |

Строк: 4. Конфликтов: 0.

### 3.13 `hook-pre-tool` (`hookPreToolConfig`) — **1 конфликт**

States: `IDLE, CHECKING, ALLOWED, BLOCKED`

| state | event | кандидаты | winner | conflict |
|---|---|---|---|---|
| IDLE | CHECK | IDLE→CHECKING | CHECKING | — |
| **CHECKING** | **RESOLVE** | 1) →ALLOWED `guard:isAllowed`; 2) →BLOCKED `guard:isBlocked` | **BLOCKED** (#2) | **CONFLICT (2 candidates, same from)** |
| ALLOWED | RESET | ALLOWED→IDLE | IDLE | — |
| BLOCKED | RESET | BLOCKED→IDLE | IDLE | — |
| CHECKING | RESET | CHECKING→IDLE | IDLE | — |

Строк: 5. Конфликтов: **1**. Замечание безопасности: `onChecking` — единственное
место в корпусе с явным **fail-closed без checkImpl** (WP-B): отсутствие
`checkImpl` даёт `checkResult.blocked=true` (не `false`) — то есть дефолтный
рантайм-гард сегодня склоняется К BLOCKED-ветке даже без реального правила, что
СОВПАДАЕТ с сегодняшним last-declared-wins победителем (BLOCKED, #2) — приятное
совпадение, но именно совпадение, не гарантия.

### 3.14 `hook-session-start` (`hookSessionStartConfig`) — **1 конфликт**

States: `IDLE, HYDRATING, READY, NO_SESSION`

| state | event | кандидаты | winner | conflict |
|---|---|---|---|---|
| **IDLE** | **START** | 1) →HYDRATING `guard:isResume`; 2) →NO_SESSION `guard:isStartup` | **NO_SESSION** (#2) | **CONFLICT (2 candidates, same from)** |
| HYDRATING | HYDRATION_COMPLETE | HYDRATING→READY `guard:isHydrationComplete` | READY | — |
| READY | RESET | READY→IDLE | IDLE | — |
| NO_SESSION | RESET | NO_SESSION→IDLE | IDLE | — |
| HYDRATING | RESET | HYDRATING→IDLE | IDLE | — |

Строк: 5. Конфликтов: **1**. `isResume`/`isStartup` взаимоисключающие
(`source==='resume'` vs `!== 'resume'`) — тотальное покрытие (нет "ни то ни
другое" в отличие от §3.8/§3.9), поэтому реальный рантайм-риск от смены правила
здесь НИЖЕ, чем у §3.8/§3.9/§3.15-3.19 (где отсутствие/непокрытое значение гарда
оставляет машину без перехода вовсе — другой класс риска).

### 3.15 `hook-stop` (`hookStopConfig`) — **1 конфликт**

States: `IDLE, DEDUP_ACTIVE, CHECKPOINT_WRITING, CHECKPOINTED, DEDUP_SKIPPED`

| state | event | кандидаты | winner | conflict |
|---|---|---|---|---|
| IDLE | STOP | IDLE→DEDUP_ACTIVE | DEDUP_ACTIVE | — |
| CHECKPOINTED | STOP | CHECKPOINTED→DEDUP_ACTIVE | DEDUP_ACTIVE | — |
| DEDUP_SKIPPED | STOP | DEDUP_SKIPPED→DEDUP_ACTIVE | DEDUP_ACTIVE | — |
| **DEDUP_ACTIVE** | **EVALUATE** | 1) →CHECKPOINT_WRITING `guard:isOutsideDedupWindow`; 2) →DEDUP_SKIPPED `guard:isWithinDedupWindow` | **DEDUP_SKIPPED** (#2) | **CONFLICT (2 candidates, same from)** |
| CHECKPOINT_WRITING | WRITE_COMPLETE | CHECKPOINT_WRITING→CHECKPOINTED | CHECKPOINTED | — |
| CHECKPOINTED | RESET | CHECKPOINTED→IDLE | IDLE | — |
| DEDUP_SKIPPED | RESET | DEDUP_SKIPPED→IDLE | IDLE | — |
| DEDUP_ACTIVE | RESET | DEDUP_ACTIVE→IDLE | IDLE | — |

Строк: 8. Конфликтов: **1**. `isOutsideDedupWindow`/`isWithinDedupWindow` —
дополняющие по `age < 120_000`, тотальное покрытие (`isNaN(age)` считается
outside в обоих направлениях согласованно — не расходится).

### 3.16 `hook-subagent-stop` (`hookSubagentStopConfig`) — **3 конфликта**

States: `IDLE, FILTERING, EXTRACTING, CAPTURING, CAPTURED, SKIPPED, CAPTURE_FAILED`

| state | event | кандидаты | winner | conflict |
|---|---|---|---|---|
| IDLE | PROCESS | IDLE→FILTERING | FILTERING | — |
| **FILTERING** | **FILTER_RESULT** | 1) →EXTRACTING `guard:isCriticAgent`; 2) →SKIPPED `guard:isNonCriticAgent` | **SKIPPED** (#2) | **CONFLICT** |
| **EXTRACTING** | **EXTRACT_RESULT** | 1) →CAPTURING `guard:hasValidEnvelope`; 2) →SKIPPED `guard:hasNoEnvelope` | **SKIPPED** (#2) | **CONFLICT** |
| **CAPTURING** | **CAPTURE_RESULT** | 1) →CAPTURED `guard:isCaptureSuccess`; 2) →CAPTURE_FAILED `guard:isCaptureFailure` | **CAPTURE_FAILED** (#2) | **CONFLICT** |
| CAPTURED | RESET | CAPTURED→IDLE | IDLE | — |
| SKIPPED | RESET | SKIPPED→IDLE | IDLE | — |
| CAPTURE_FAILED | RESET | CAPTURE_FAILED→IDLE | IDLE | — |
| FILTERING | RESET | FILTERING→IDLE | IDLE | — |
| EXTRACTING | RESET | EXTRACTING→IDLE | IDLE | — |
| CAPTURING | RESET | CAPTURING→IDLE | IDLE | — |

Строк: 10. Конфликтов: **3** — наибольшее число конфликтов в одном синглтон-файле.
Все три пары взаимоисключающие И тотальные (`isX`/`isNonX`, `has.../hasNo...`,
`isSuccess/isFailure` — каждая пара строится как `X`/`!X` от одного и того же
булева поля), т.е. рантайм сегодня НИКОГДА не бьётся о «last-declared-wins» —
но структурно это именно та цепочка (FILTER→EXTRACT→CAPTURE), которую критик
DA-гейта проходит на каждый стоп сабагента (TASK-388 FT-005) — самая «горячая»
последовательность в корпусе по частоте вызова в проде через shadow-путь.

### 3.17 `hook-user-prompt-submit` (`hookUserPromptSubmitConfig`) — **1 конфликт**

States: `IDLE, PROCESSING, PASSED, ANNOTATED`

| state | event | кандидаты | winner | conflict |
|---|---|---|---|---|
| IDLE | PROCESS | IDLE→PROCESSING | PROCESSING | — |
| **PROCESSING** | **RESOLVE** | 1) →PASSED `guard:isPassThrough`; 2) →ANNOTATED `guard:needsAnnotation` | **ANNOTATED** (#2) | **CONFLICT** |
| PASSED | RESET | PASSED→IDLE | IDLE | — |
| ANNOTATED | RESET | ANNOTATED→IDLE | IDLE | — |
| PROCESSING | RESET | PROCESSING→IDLE | IDLE | — |

Строк: 5. Конфликтов: **1**. Текущий default (`onProcessing` без
`evaluateAnnotation`) всегда даёт `shouldAnnotate=false` → реальный
рантайм-гард сегодня `isPassThrough`(#1), но статический победитель — ANNOTATED
(#2) — тот же класс расхождения default-vs-static-winner, что в §3.9.

### 3.18 `pretool-enforcement-chain` (`pretoolEnforcementChainConfig`) — **9 конфликтов, все `[priority-immune]`**

States: `IDLE, P_DAFAB, P_NOACTIVETASK, P_TASKNOTFOUND, P_PHASE, P_DAGATE, P_PLANREVIEW, P_GITSAFETY, P_SHELLMANAGED, P_ARTIFACTDIRECT, ALLOWED, BLOCKED`

Единственный конфиг корпуса, использующий явное числовое поле `priority`
(BLOCK-рёбра `priority:10`, PASS-рёбра `priority:1` — комментарий в файле
указывает `vendor state_machine.ts:1812`, в этом дереве соответствующая логика
находится на строках 2201-2241, см. §0). Резолюция независима от порядка
объявления (см. цитату движка §0): BLOCK строго вытесняет PASS ВСЕГДА, когда
BLOCK-гард истинен, вне зависимости от того, что объявлено раньше/позже в
массиве. Все 9 клеток ниже помечены `[priority-immune]` — они НЕ входят в
реальный blast radius смены «last-declared-wins», потому что уже не полагаются
на неё.

| state | event | кандидаты | winner | conflict |
|---|---|---|---|---|
| IDLE | CHECK | IDLE→P_DAFAB | P_DAFAB | — |
| **P_DAFAB** | **ADVANCE** | →BLOCKED `guard:isBlocked_P_DAFAB, priority:10`; →P_NOACTIVETASK `guard:isPassed_P_DAFAB, priority:1` | BLOCKED, если гард10 истинен; иначе P_NOACTIVETASK | **CONFLICT `[priority-immune]`** |
| **P_NOACTIVETASK** | **ADVANCE** | →BLOCKED `priority:10`; →P_TASKNOTFOUND `priority:1` | приоритет-разрешено | **CONFLICT `[priority-immune]`** |
| **P_TASKNOTFOUND** | **ADVANCE** | →BLOCKED `priority:10`; →P_PHASE `priority:1` | приоритет-разрешено | **CONFLICT `[priority-immune]`** |
| **P_PHASE** | **ADVANCE** | →BLOCKED `priority:10`; →P_DAGATE `priority:1` | приоритет-разрешено | **CONFLICT `[priority-immune]`** |
| **P_DAGATE** | **ADVANCE** | →BLOCKED `priority:10`; →P_PLANREVIEW `priority:1` | приоритет-разрешено | **CONFLICT `[priority-immune]`** |
| **P_PLANREVIEW** | **ADVANCE** | →BLOCKED `priority:10`; →P_GITSAFETY `priority:1` | приоритет-разрешено | **CONFLICT `[priority-immune]`** |
| **P_GITSAFETY** | **ADVANCE** | →BLOCKED `priority:10`; →P_SHELLMANAGED `priority:1` | приоритет-разрешено | **CONFLICT `[priority-immune]`** |
| **P_SHELLMANAGED** | **ADVANCE** | →BLOCKED `priority:10`; →P_ARTIFACTDIRECT `priority:1` | приоритет-разрешено | **CONFLICT `[priority-immune]`** |
| **P_ARTIFACTDIRECT** | **ADVANCE** | →BLOCKED `priority:10`; →ALLOWED `priority:1` | приоритет-разрешено | **CONFLICT `[priority-immune]`** |
| ALLOWED | RESET | ALLOWED→IDLE | IDLE | — |
| BLOCKED | RESET | BLOCKED→IDLE | IDLE | — |
| P_DAFAB | RESET | P_DAFAB→IDLE | IDLE | — |
| P_NOACTIVETASK | RESET | P_NOACTIVETASK→IDLE | IDLE | — |
| P_TASKNOTFOUND | RESET | P_TASKNOTFOUND→IDLE | IDLE | — |
| P_PHASE | RESET | P_PHASE→IDLE | IDLE | — |
| P_DAGATE | RESET | P_DAGATE→IDLE | IDLE | — |
| P_PLANREVIEW | RESET | P_PLANREVIEW→IDLE | IDLE | — |
| P_GITSAFETY | RESET | P_GITSAFETY→IDLE | IDLE | — |
| P_SHELLMANAGED | RESET | P_SHELLMANAGED→IDLE | IDLE | — |
| P_ARTIFACTDIRECT | RESET | P_ARTIFACTDIRECT→IDLE | IDLE | — |

Строк: 21 (1 CHECK + 9 ADVANCE + 11 RESET). Конфликтов: **9**, все
`[priority-immune]`. Важный контр-пример для W3: этот файл — SHADOW-ONLY
(`TASK-483 WP-C`, «NOT wired into dispatch.ts»), но его дизайн уже сегодня
опережает потенциальную смену правила W3 — если решится сделать
`priority` дефолтным механизмом дизамбигуации по всему корпусу, ЭТОТ файл
можно взять референсом миграции для остальных 9 конфликтов из §3.8-3.9,
3.13-3.17.

## 4. Фабричные конфиги — по тирам

### 4.1 `phase-sm` (`createPhaseSmConfig`, потребитель — `createPhaseSmForTier` в `phase-sm-factory.ts`)

Единственное событие — `ADVANCE`, линейная цепочка по `allowedPhases`: для
`i` от `0` до `n-2` — ровно один переход `allowedPhases[i] → allowedPhases[i+1]`
(с `onTransition:'onTransitionTo<Phase>'`, если `allowedPhases[i+1]` в
`daGatedPhases` — параметр, передаваемый ВЫЗЫВАЮЩИМ, у самой `phase-sm` нет
встроенного знания о DA-гейтах). Каждое состояние — `from` РОВНО ОДНОГО перехода
→ **конфликтов структурно быть не может** ни в одном тире.

**T0:trace-only** — allowedPhases = `[VAN, IMPLEMENT, ARCHIVE]`

| state | event | winner | conflict |
|---|---|---|---|
| VAN | ADVANCE | IMPLEMENT | — |
| IMPLEMENT | ADVANCE | ARCHIVE | — |

Строк: 2. Конфликтов: 0.

**T1:patch** — allowedPhases = `[VAN, IMPLEMENT, QA, ARCHIVE]`

| state | event | winner | conflict |
|---|---|---|---|
| VAN | ADVANCE | IMPLEMENT | — |
| IMPLEMENT | ADVANCE | QA | — |
| QA | ADVANCE | ARCHIVE | — |

Строк: 3. Конфликтов: 0.

**T2:quick** — allowedPhases = `[VAN, IMPLEMENT, QA, REFLECT, ARCHIVE]`

| state | event | winner | conflict |
|---|---|---|---|
| VAN | ADVANCE | IMPLEMENT | — |
| IMPLEMENT | ADVANCE | QA | — |
| QA | ADVANCE | REFLECT | — |
| REFLECT | ADVANCE | ARCHIVE | — |

Строк: 4. Конфликтов: 0.

**T3:moderate** — allowedPhases = `[VAN, PLAN, IMPLEMENT, QA, REFLECT, ARCHIVE]`

| state | event | winner | conflict |
|---|---|---|---|
| VAN | ADVANCE | PLAN | — |
| PLAN | ADVANCE | IMPLEMENT | — |
| IMPLEMENT | ADVANCE | QA | — |
| QA | ADVANCE | REFLECT | — |
| REFLECT | ADVANCE | ARCHIVE | — |

Строк: 5. Конфликтов: 0.

**T4:standard** — allowedPhases = все 9 фаз (`PHASE_ORDER`)

| state | event | winner | conflict |
|---|---|---|---|
| VAN | ADVANCE | CREATIVE | — |
| CREATIVE | ADVANCE | PLAN | — |
| PLAN | ADVANCE | TECH_SPEC | — |
| TECH_SPEC | ADVANCE | IMPLEMENT | — |
| IMPLEMENT | ADVANCE | QA | — |
| QA | ADVANCE | CODE_REVIEW | — |
| CODE_REVIEW | ADVANCE | REFLECT | — |
| REFLECT | ADVANCE | ARCHIVE | — |

Строк: 8. Конфликтов: 0.

**T5:epic** — allowedPhases идентична T4 (обе == `PHASE_ORDER`) → **таблица
байт-идентична T4** (см. §1.1).

Строк: 8. Конфликтов: 0.

**Итого по `phase-sm`**: 2+3+4+5+8+8 = **30 строк**, **0 конфликтов** во всех
6 тирах.

### 4.2 `gated-phase-composite` (`createGatedPhaseSmConfig`, потребитель —
`createGatedPhaseSmForTier`)

Каждая НЕ-гейтованная фаза даёт 1 строку (`PHASE_ADVANCE`, атомарный лист).
Каждая ГЕЙТОВАННАЯ фаза (композит с регионами `work`/`gate`) даёт **8 строк**:
1 `PHASE_ADVANCE` (guard: `() => sm.isDone(fromPhase)`) + 1 `WORK_COMPLETE`
(`<phase>.work.WORK_OPEN → <phase>.work.WORK_READY`) + 2 `REVIEW_SUBMITTED`
(`DA_PENDING→DA_REVIEWING`, self-loop `DA_REVIEWING→DA_REVIEWING`) + 1
`REVIEW_APPROVED` (`guard:hasApprovedVerdict`) + 1 `REVIEW_REJECTED`
(`guard:hasRejectedVerdict`) + 1 `CORRECTION_APPLIED` + 1 `CORRECTION_RESOLVED`.

**Ни одна клетка ни в одном тире не конфликтна** — подтверждено построчно: каждый
из `PHASE_ADVANCE`/`WORK_COMPLETE`/`REVIEW_SUBMITTED`/`REVIEW_APPROVED`/
`REVIEW_REJECTED`/`CORRECTION_APPLIED`/`CORRECTION_RESOLVED` для ДАННОЙ фазы
формируется через `.flatMap` РОВНО ОДИН раз на фазу и на `from`; между РАЗНЫМИ
фазами `from`-строки различны (`'<phaseA>...'` vs `'<phaseB>...'` — не префиксы
друг друга) → ancestor/descendant конфликт исключён структурно. Это
НАМЕРЕННЫЙ дизайн-выбор автора (см. заголовок файла: избежать
`DONE_VS_PARALLEL_EXIT_AMBIGUITY`, используя guard-based level-triggering вместо
`done.state.<phase>`-join).

**T0:trace-only** — allowedPhases=`[VAN,IMPLEMENT,ARCHIVE]`, gated=`[]`

| state | event | winner | conflict |
|---|---|---|---|
| VAN | PHASE_ADVANCE | IMPLEMENT | — |
| IMPLEMENT | PHASE_ADVANCE | ARCHIVE | — |

Строк: 2. Конфликтов: 0.

**T1:patch** — allowedPhases=`[VAN,IMPLEMENT,QA,ARCHIVE]`, gated=`[]`

| state | event | winner | conflict |
|---|---|---|---|
| VAN | PHASE_ADVANCE | IMPLEMENT | — |
| IMPLEMENT | PHASE_ADVANCE | QA | — |
| QA | PHASE_ADVANCE | ARCHIVE | — |

Строк: 3. Конфликтов: 0.

**T2:quick** — allowedPhases=`[VAN,IMPLEMENT,QA,REFLECT,ARCHIVE]`, gated=`[]`

| state | event | winner | conflict |
|---|---|---|---|
| VAN | PHASE_ADVANCE | IMPLEMENT | — |
| IMPLEMENT | PHASE_ADVANCE | QA | — |
| QA | PHASE_ADVANCE | REFLECT | — |
| REFLECT | PHASE_ADVANCE | ARCHIVE | — |

Строк: 4. Конфликтов: 0.

**T3:moderate** — allowedPhases=`[VAN,PLAN,IMPLEMENT,QA,REFLECT,ARCHIVE]`,
gated=`[PLAN,IMPLEMENT,QA]`

`PHASE_ADVANCE` (5 строк, все не-конфликтны, независимо гейтована фаза или нет
— guard решает только ИСТИННОСТЬ, не конкуренцию):

| state | event | winner | conflict |
|---|---|---|---|
| VAN | PHASE_ADVANCE | PLAN | — |
| PLAN | PHASE_ADVANCE (`guard: isDone('PLAN')`) | IMPLEMENT | — |
| IMPLEMENT | PHASE_ADVANCE (`guard: isDone('IMPLEMENT')`) | QA | — |
| QA | PHASE_ADVANCE (`guard: isDone('QA')`) | REFLECT | — |
| REFLECT | PHASE_ADVANCE | ARCHIVE | — |

Композитные регионы для PLAN, IMPLEMENT, QA (7 внутренних строк на фазу —
WORK_COMPLETE 1 + REVIEW_SUBMITTED 2 + REVIEW_APPROVED 1 + REVIEW_REJECTED 1 +
CORRECTION_APPLIED 1 + CORRECTION_RESOLVED 1 — `PHASE_ADVANCE` уже учтён отдельно
выше — × 3 фазы = 21 строка):

| phase | state (внутри региона) | event | winner | conflict |
|---|---|---|---|---|
| PLAN | PLAN.work.WORK_OPEN | WORK_COMPLETE | PLAN.work.WORK_READY | — |
| PLAN | PLAN.gate.DA_PENDING | REVIEW_SUBMITTED | PLAN.gate.DA_REVIEWING | — |
| PLAN | PLAN.gate.DA_REVIEWING | REVIEW_SUBMITTED (self) | PLAN.gate.DA_REVIEWING | — |
| PLAN | PLAN.gate.DA_REVIEWING | REVIEW_APPROVED `guard:hasApprovedVerdict` | PLAN.gate.DA_CLEARED | — |
| PLAN | PLAN.gate.DA_REVIEWING | REVIEW_REJECTED `guard:hasRejectedVerdict` | PLAN.gate.DA_REJECTED | — |
| PLAN | PLAN.gate.DA_REJECTED | CORRECTION_APPLIED | PLAN.gate.CORRECTION_LOOP_OPEN | — |
| PLAN | PLAN.gate.CORRECTION_LOOP_OPEN | CORRECTION_RESOLVED | PLAN.gate.DA_PENDING | — |
| IMPLEMENT | IMPLEMENT.work.WORK_OPEN | WORK_COMPLETE | IMPLEMENT.work.WORK_READY | — |
| IMPLEMENT | IMPLEMENT.gate.DA_PENDING | REVIEW_SUBMITTED | IMPLEMENT.gate.DA_REVIEWING | — |
| IMPLEMENT | IMPLEMENT.gate.DA_REVIEWING | REVIEW_SUBMITTED (self) | IMPLEMENT.gate.DA_REVIEWING | — |
| IMPLEMENT | IMPLEMENT.gate.DA_REVIEWING | REVIEW_APPROVED | IMPLEMENT.gate.DA_CLEARED | — |
| IMPLEMENT | IMPLEMENT.gate.DA_REVIEWING | REVIEW_REJECTED | IMPLEMENT.gate.DA_REJECTED | — |
| IMPLEMENT | IMPLEMENT.gate.DA_REJECTED | CORRECTION_APPLIED | IMPLEMENT.gate.CORRECTION_LOOP_OPEN | — |
| IMPLEMENT | IMPLEMENT.gate.CORRECTION_LOOP_OPEN | CORRECTION_RESOLVED | IMPLEMENT.gate.DA_PENDING | — |
| QA | QA.work.WORK_OPEN | WORK_COMPLETE | QA.work.WORK_READY | — |
| QA | QA.gate.DA_PENDING | REVIEW_SUBMITTED | QA.gate.DA_REVIEWING | — |
| QA | QA.gate.DA_REVIEWING | REVIEW_SUBMITTED (self) | QA.gate.DA_REVIEWING | — |
| QA | QA.gate.DA_REVIEWING | REVIEW_APPROVED | QA.gate.DA_CLEARED | — |
| QA | QA.gate.DA_REVIEWING | REVIEW_REJECTED | QA.gate.DA_REJECTED | — |
| QA | QA.gate.DA_REJECTED | CORRECTION_APPLIED | QA.gate.CORRECTION_LOOP_OPEN | — |
| QA | QA.gate.CORRECTION_LOOP_OPEN | CORRECTION_RESOLVED | QA.gate.DA_PENDING | — |

(Таблица выше содержит ровно 21 строку — 3 гейтованные фазы × 7 внутренних строк
на регион, `PHASE_ADVANCE` в неё НЕ входит, он уже перечислен отдельной таблицей
выше.)

Итого T3: `PHASE_ADVANCE` 5 строк + композит на фазу 7 строк (WORK_COMPLETE 1 +
REVIEW_SUBMITTED 2 + REVIEW_APPROVED 1 + REVIEW_REJECTED 1 + CORRECTION_APPLIED 1
+ CORRECTION_RESOLVED 1) × 3 гейтованных фазы (PLAN, IMPLEMENT, QA) = 5 + 21 =
**26 строк**. Конфликтов: 0.

**T4:standard** — allowedPhases = все 9 фаз, gated=`[CREATIVE, PLAN, TECH_SPEC,
IMPLEMENT, QA, CODE_REVIEW, REFLECT]` (всё, кроме VAN/ARCHIVE)

`PHASE_ADVANCE` — 8 строк (VAN→CREATIVE, CREATIVE→PLAN(`isDone`),
PLAN→TECH_SPEC(`isDone`), TECH_SPEC→IMPLEMENT(`isDone`), IMPLEMENT→QA(`isDone`),
QA→CODE_REVIEW(`isDone`), CODE_REVIEW→REFLECT(`isDone`),
REFLECT→ARCHIVE(`isDone`)) — все без конфликта.

Композитные регионы: 7 гейтованных фаз × 7 строк/фазу = 49 строк (WORK_COMPLETE,
REVIEW_SUBMITTED×2, REVIEW_APPROVED, REVIEW_REJECTED, CORRECTION_APPLIED,
CORRECTION_RESOLVED — структура идентична таблице T3 выше, подставить
`CREATIVE`/`TECH_SPEC`/`CODE_REVIEW`/`REFLECT` вместо `PLAN`/`IMPLEMENT`/`QA`).
Ни одна не конфликтна (тот же структурный аргумент — разные `from`-префиксы на
фазу).

Итого T4: 8 + 49 = **57 строк**. Конфликтов: 0.

**T5:epic** — топология байт-идентична T4 (см. §1.1: `T4:standard` и `T5:epic`
делят одну и ту же `allowedPhases` и одинаковый `tierNum`-порог для каждого
`DA_GATES[phase].minTier`, следовательно то же множество `daGatedPhases`).

Строк: 57. Конфликтов: 0.

**Итого по `gated-phase-composite`**: 2+3+4+26+57+57 = **149 строк**, **0
конфликтов** во всех 6 тирах.

## 5. Наблюдения / выводы для W3

1. **Единственная РЕАЛЬНАЯ (не priority-immune) blast-radius группа — 9
   клеток**: `artifact-sm.VERDICT@UNDER_REVIEW` (§3.8),
   `hook-permission-request.RESOLVE@EVALUATING` (§3.9, 3-way — самая широкая),
   `hook-pre-tool.RESOLVE@CHECKING` (§3.13),
   `hook-session-start.START@IDLE` (§3.14),
   `hook-stop.EVALUATE@DEDUP_ACTIVE` (§3.15),
   `hook-subagent-stop.{FILTER_RESULT@FILTERING, EXTRACT_RESULT@EXTRACTING,
   CAPTURE_RESULT@CAPTURING}` (§3.16, 3 клетки в одном файле),
   `hook-user-prompt-submit.RESOLVE@PROCESSING` (§3.17).
   Ровно эти 9 нужно продиффать под новым правилом после W3 (нулевой-ложняк-корпус
   для #25) — их СЕГОДНЯШНЕЕ рантайм-поведение безопасно (гарды
   взаимоисключающие/тотальные), но их СТАТИЧЕСКИЙ победитель зависит от порядка
   объявления, а не от гарда.
2. **`pretool-enforcement-chain` (9 клеток) уже иммунен** — явный `priority`
   выводит его из-под смены дефолтного правила; полезный образец, если решение
   W3 — мигрировать остальные 9 на `priority` вместо смены глобального дефолта.
3. **Фабричные конфиги (`phase-sm`, `gated-phase-composite`) дают НОЛЬ
   конфликтов на всех 6 тирах** — оба спроектированы так, что на каждую
   (`state`,`event`) всегда ровно один структурный кандидат; `gated-phase-composite`
   явно документирует, ЧТО он избегает (см. заголовок файла:
   `DONE_VS_PARALLEL_EXIT_AMBIGUITY`) — это подтверждённый нулевой blast radius
   для 179 из 310 строк корпуса (30 phase-sm + 149 gated-phase-composite).
4. **Одна и та же семантика («approve-vs-reject после ревью») реализована ДВУМЯ
   разными способами** в соседних файлах одного каталога: `da-gate-sm` и
   `gated-phase-composite` разносят approve/reject по РАЗНЫМ событиям (0
   конфликтов), `artifact-sm` держит их под ОДНИМ событием `VERDICT` с двумя
   гардами (1 конфликт). Три родственных конфига (`hook-permission-request`,
   `hook-pre-tool`, `hook-session-start`, `hook-stop`, `hook-subagent-stop`×3,
   `hook-user-prompt-submit`) все используют схему «один REST-события +
   N гардов» (артефакт общего шаблона «evaluate → route по гарду», TASK-310/
   TASK-470 WP-4) — то есть смена правила W3 системно затрагивает именно ЭТОТ
   архитектурный паттерн, а не что-то случайное.
5. Нет ни одного wildcard (`from:'*'`) и ни одного истинного ancestor/descendant
   конфликта НА ОДНОМ событии во всём собранном корпусе (0 из 20 файлов, 0 из
   30 тир-инстансов) — оба класса конфликтов из задания присутствуют В
   ОПРЕДЕЛЕНИИ (движок их поддерживает — `isTransitionPossible`, wildcard-ветка
   на `state_machine.ts:2250`, `isParentState` на композитных путях), но
   НИКЕМ в этом корпусе не используются на практике. Единственный близкий случай
   — `gated-phase-composite`'s `PHASE_ADVANCE.from:'<phase>'` МАТЧИТ и
   композит-родителя, и (за счёт `isParentState`) любой вложенный лист под ним,
   но это ОДИН переход, не конкуренция двух — не в счёт конфликтов, но стоит
   упомянуть для W3: если позже кто-то добавит ВТОРОЙ `PHASE_ADVANCE`-переход с
   `from:'<phase>.gate.DA_CLEARED'` (более специфичный потомок) — ЭТО будет
   первый настоящий ancestor/descendant-конфликт корпуса, и он немедленно
   зависим от «last-declared-wins» (порядок объявления в массиве определит,
   родитель или потомок выигрывает).

## 6. Что НЕ сделано (честно, по границам задания)

- Конфиги НЕ менялись (только читались) — `agent-skills` дерево осталось byte-
  identical на всех трёх путях (`source`, `dist`-зеркало, `.claude/worktrees/*`
  игнорированы намеренно).
- `route-contract.ts` / `route-from-manifest.ts` / `pretool-enforcement-chain-
  wiring.ts` / `phase-sm-factory.ts` — прочитаны для понимания вызывающего кода
  фабрик, но НЕ являются `StateMachineConfig` и не вошли в матрицу как отдельные
  строки.
- Полный текст `da-enforcement.ts` (1209 строк) прочитан только до строки ~950
  (хватило для `DA_GATES`/`minTier`/`lens` — весь материал, нужный для границы
  §1.1); остаток файла — рантайм-политика (`checkNoActiveTaskEnforcement`,
  `checkPhaseEnforcement` и т.д.), НЕ относящаяся к SM-конфигам этого корпуса —
  не читан, т.к. не нужен для задачи #24.
- W3-диффинг (после смены правила) — НЕ выполнялся здесь по прямому указанию
  задания («После W3 этот же корпус продиффать» — будущая работа, этот документ
  — база для неё).
