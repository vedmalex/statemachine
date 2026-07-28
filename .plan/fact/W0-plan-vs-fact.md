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

## Вывод

Критерий закрытия П1 достигнут и подтверждён независимо (оркестратор-прогон + adversarial-verify).
Scope не сокращён; расширен на V6b и учёт второго eval-пути (§0.6). Переход в W1 — после ACCEPT
критика приёмки.