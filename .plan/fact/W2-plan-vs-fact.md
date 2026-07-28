# W2 план-факт: компилятор конфига + валидатор + типы

> Артефакт §0.7. Волна W2. Ветка `remediation/w1-prep`. Фундамент семантики.
> Под-волны: W2a компилятор (#8), W2b валидатор (#5), W2c типы+README (#16).

## План (MASTER §3 W2)

Нормализованная модель конфига (потребляют рантайм и валидатор) → валидатор на модель (достижимость,
вложенность, 3 уровня доставки, политика бросков) → типы путей + README. Гейт: характеризация зелёная.

## W2a — компилятор конфига (#8) — verdict CLOSED

| пункт | факт | подтверждение (оркестратор-прогон) |
|---|---|---|
| нормализованная модель | `src/model.ts`: `ModelNode {id,kind,parent,depth,documentIndex,isFinal,children}` + `compileModel` (pre-order Object.keys DFS, регионы — first-class узлы, skip 'initial') | компилируется 1 раз в конструкторе |
| детерминированный documentIndex | активная конфигурация сериализуется в documentIndex-порядке (было map-insertion) | documentIndex байт-идентичен в 2 bun-процессах |
| checkCompletion на модели | сортировка по `model.depthOf` вместо `split('.').length` | order-эквивалентно для зарегистрированных композитов |
| **ГЕЙТ: характеризация зелёная** | селекция НЕ сдвинута | 10/10 характеризация зелёные на W2a-рантайме; decisive-проба verify: сьют на ОРИГИНАЛЕ упал ровно на 2 ожидаемых тестах (829 passing) — дельта хирургична |
| поведение сохранено | 5-10 машин те же последовательности состояний | model_determinism part B (был RED: map-insertion зависимость) зелёный |

Реалигнован 1 stale-тест `hierarchical.test.ts` — НЕ ослабление: старое ожидание фиксировало
map-insertion артефакт `region2|region1`, новое — канонический `region1|region2` (детерминизм).

Итог W2a: **831 passed / 14 skipped; tsc чисто; W0+W1+DST регресс зелёный** (оркестратор-прогон).

Advisory (не блокер, verify): `getCompiledModel` объявлен `public` (internal-by-convention,
`index.ts` не реэкспортит — `public_surface.test.ts` зелёный). Учесть в W2b/чистоте.

## W2b — валидатор на модель (#5) — verdict CLOSED

| группа | факт | подтверждение (оркестратор-прогон) |
|---|---|---|
| чинит ложные (F10/V1/V2/V4/V11/V12/UNREACHABLE) | валидатор потребляет `model.ts`, не парсит пути заново; UNREACHABLE — обход достижимости ПО МОДЕЛИ | README-пример регионов: 0 errors, 0 warnings, isValid:true (было INVALID_INITIAL_STATE + ложные UNREACHABLE) |
| новые проверки | REGION_STARTS_FINAL, REGION_NO_PATH_TO_FINAL, UNSATISFIABLE_FROM, DUPLICATE_REGION_NAME, DEAD_END_STATE, ANCESTOR_DESCENDANT_OVERLAP, PRIORITY_INVERTS_DOMINANCE, WILDCARD_SHADOWED (в infos[]) | нулевой-ложняк на корректной машине: 0/0 |
| INVOKE_NO_HANDLER | заготовка инертна (коммент «активируется в W3b») | не мёртвый код 2 волны |
| политика бросков | **INVALID_STATE_PATH бросает** при конструкции; остальные model-ошибки — репорт + strict (см. дельту) | битый from → throw; валидный → построен; validateConfigStrict бросает (V10) |
| корпус MB3 | **9 warning вместо 28**, все настоящие (6× REGION_MISSING_INITIAL — реальный совет, 3× SELF_TRANSITION); 0 ложных UNREACHABLE | `validator_corpus_mb3.test.ts` 4/4 |

Итог W2b: **846 passed / 14 skipped; tsc чисто**; гейт характеризации 10/10 (селекция не сдвинута);
W0/W1/W2a целы (оркестратор-прогон).

**Дельта план→факт (§0.6):** политика бросков СУЖЕНА против буквального SPEC — бросает только
`INVALID_STATE_PATH`, а REGION_STARTS_FINAL/REGION_NO_PATH_TO_FINAL/UNSATISFIABLE_FROM/
DUPLICATE_REGION_NAME остаются репорт-ошибками (isValid:false + strict), НЕ бросают при конструкции.
Причина (verify независимо подтвердил REQUIRED): рантайм сознательно исполняет вырожденные final-only
регионы, которые строят замороженные тесты; бросок реоткрыл бы гейты. SPEC §1а обновлён под это.

## W2c — типы путей + README (#16) — ОЖИДАЕТ