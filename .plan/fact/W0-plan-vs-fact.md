# W0 план-факт: закрытие RCE (дефект П1)

> Артефакт §0.7. Волна W0. Ветка `remediation/w0-rce`, baseline `0fa9680`.
> Статус: реализовано, critic-приёмка запущена. Дата 2026-07-28.

## План (реестр §6, дефект П1)

RCE через `fromJSON`: строковый guard/action исполняется через `new Function`, блоклист обходится
char-code сборкой. `fromSecureJSON` — keyless-хэш, подделываемый. Критерий закрытия: legacy-строковая
десериализация функций удалена; реестр `name→fn`; проба не исполняет код.

## Факт

| пункт плана | сделано | подтверждение |
|---|---|---|
| red-test краснеет на HEAD | ✅ | `security_rce.test.ts`: 2 теста, `expected 'darwin:35772' to be undefined` — реальные `process.platform:pid` прочитаны, падение на ОЖИДАЕМОМ ассерте |
| удалить legacy eval-путь | ✅ | `createSafeFunction`, `deserializeLegacyString`, keyless `createSecurityHash`/`validateSecurityHash` удалены (security.ts −352 стр); `new Function` в non-test src: 0 (кроме sim/define — см. дельту) |
| реестр `name→fn` | ✅ | `FunctionRegistry` (types.ts); `deserializeAction(action, registry)` резолвит по имени; тело/хэш не сериализуются |
| неизвестное имя → throw | ✅ | `StateMachineError('Cannot restore function… not present in registry')` |
| red → green | ✅ | оба RCE-теста зелёные (проверено оркестратором) |
| полный сьют | ✅ | **801 passed / 0 failed / 9 skipped**; `tsc --noEmit` exit 0 (проверено оркестратором своими руками, не только агентом) |
| adversarial-verify | ✅ CLOSED | 10 векторов (action/onError/forged secure/prototype/partial-registry/double-deser/nested invoke) — ни один не исполнил код |

## Дельта план→факт (только дополнения, §0.6)

1. **V6b — prototype-обход реестра (закрыт в W0).** `registry?.[name]` ходил по prototype chain:
   `name='constructor'` резолвился в `Object` (тоже `typeof 'function'`), контракт «неизвестное имя →
   throw» обходился. НЕ RCE (Object-конструктор не компилирует код), но нарушение контракта.
   Фикс: `Object.hasOwn(registry, name)`. Добавлен red-тест, **проверен откатом**: краснеет на
   `registry?.[name]`, зеленеет на `Object.hasOwn` → +1 тест (801 vs 800).
2. **Второй eval-путь `sim/define.ts:69` `recreateLiteral` (в реестр, задача #26).** `new Function`
   на `ScenarioSpec.source`. Verify: НЕ attacker-reachable из `fromJSON` (source генерируется
   внутри). НО `src/sim` станет публичным (checkMachine #17) — закрыть при W5/W6. Не блокер W0.
3. **6 тестов обновлены под реестр** — ломающий переход (§0.5). Ассерты сохранены/усилены, НЕ
   ослаблены: `concurrency.test` `toContain('hash')` → `not.toContain('hash')` + `not.toContain('body')`
   + проверка body-free формы (усиление). Проверить в critic-приёмке (пункт 2 брифа критику).

## Изменённые файлы (src, vs 0fa9680)

security.ts (−352 нетто-упрощение), state_machine.ts (+243 реестр-резолвер), types.ts (+22
FunctionRegistry), security_rce.test.ts (новый, 3 теста) + 6 тестов под реестр.

## Открытые к моменту закрытия W0

- critic-приёмка (fable) — в процессе; при REJECT → правочная под-волна до перехода в W1.
- Задача #26 (sim/define eval) — отложена в W5/W6 обоснованно (вне attacker-surface).

## W0.1 — доработка по critic-приёмке (ACCEPT С ЗАМЕЧАНИЯМИ)

Critic-приёмка (fable) нашла: V6b закрыт в 1 точке из 3. Проверено оркестратором ЗАПУСКОМ до правки:
`guard='constructor'` голой строкой из forged JSON → машина переходит (обход авторизации). Закрыто:

| id | что | подтверждение |
|---|---|---|
| B1 [HIGH] | prototype-обход на call-time резолве строк | `RESERVED_ACTION_NAMES` + `Object.hasOwn` на context (1922/1877), reserved-gate на adaptee (1946); `types.ts:374` не тронут (легит-чтения целы). Verify: 16+ векторов BLOCKED, легит owner-method/context-DI резолв PASS. Red проверен откатом |
| B2 | тест-театр (`.replace` по несуществующей подстроке) | переписан в честный: строка-тело в onEnter, маркер НЕ установлен + onEnter не function; `b2CanRedden:true` |
| B3 | нет стража на возврат eval | `security_source_scan.test.ts` (4 теста): 0 `new Function`/`eval` в non-test src кроме whitelist `sim/define.ts`; `b3Present:true` |
| B4 [учёт] | sim/define — RCE-класс в публичном `./sim` | doc-warning на `toEngineConfig`/`runScenario` + `sim/index.ts`; полное закрытие → #26/W5 |
| A | лживый JSDoc `fromSecureJSON` «Verifies cryptographic hashes» | исправлен на честный |
| A-residual | симметричная ложь в `toSecureJSON:2742` (verify поймал, grep implementer пропустил) | исправлен оркестратором |

Итог W0.1: **807 passed / 0 failed; tsc чисто** (оркестратор-прогон). Легит-резолв не сломан.

## Остаётся в W0.2 (до W1, §0.6 — разбито на под-волны, не сокращено)

- **C1 [HIGH]** реестр по `fn.name`: коллизия слотов (проверено запуском — 3 разных onEnter → одно имя) + рекурсия по regions (тихая потеря вложенных callbacks) — задача #28.
- Полуживой `security.ts` (~250 строк мёртвого blocklist) + nameless-асимметрия — задача #29.

## W0.2 — корректность сериализации (verdict CLOSED)

| id | что | подтверждение (оркестратор-прогон) |
|---|---|---|
| C1 [HIGH] | коллизия реестра по `fn.name` | составной ключ слота (`serialize-actions.ts`, `slot:'green.onEnter'`); резолв slot-first через `Object.hasOwn`, name-fallback → warn/strict-throw. Red проверен: 3 разных onEnter → `['G','R']` вместо `['G','G']` |
| C1-regions | вложенные callbacks терялись | serialize/deserialize РЕКУРСЯТ по `regions` (были спред); вложенный onEnter восстанавливается |
| dead-code | полуживой `security.ts` | **удалён целиком**; живой `serializeAction` вынесен в `serialize-actions.ts`; `security.test.ts` (тестировал только мёртвый `FunctionValidator` — 4 вхождения, 0 живого) удалён; живое покрыто `serialization*.test.ts` |
| nameless | warn о body не на том случае | warn о body/hash поднят ВЫШЕ проверки имени; `strictActions` → nameless throw (симметрия) |
| **регресс-контроль** | W0/W0.1 bypass не реоткрыт | оркестратор-проба 5 векторов + НОВЫЙ `slot:'constructor'` → все закрыто (throw/no-exec); `security_rce`+`security_source_scan` зелёные |

Итог W0.2: **805 passed / 0 failed; tsc чисто** (805 vs 807: −`security.test.ts` мёртвого кода,
+`serialization_registry.test.ts`). `new Function` в non-test src: только whitelisted `sim/define.ts`.

## Вывод W0 (ядро + W0.1 + W0.2)

RCE-путь `fromJSON`/`fromSecureJSON` закрыт полностью и подтверждён независимо (оркестратор-прогон +
adversarial-verify + critic-приёмка). Обход авторизации строкой закрыт. Scope только расширялся
(V6b, B1-B4, A-residual, второй eval-путь) — §0.6 соблюдён. Переход в W1 — ПОСЛЕ W0.2 (корректность
сериализации), чтобы RCE-волна закрылась целиком.