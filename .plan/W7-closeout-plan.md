# W7 — план закрытия остатка ремедиации (все tracked-хвосты)

> Процесс: план → критик-проверка ПЛАНА → выполнение (workflows/агенты) → валидация →
> доводка → повторная критик-приёмка КАЖДОГО юнита. mb3-critic advisory (не mb3-gate).
> Принцип: НИЧЕГО без проверки/подтверждения фикса. Честность > фейк (только sound-зубы;
> невыполнимое sound — честный no-op с обоснованием, НЕ ложные зубы).

## Юниты, зависимости, выполнимость, модель

> РЕВИЗИЯ после план-критика (fable). Ключевые изменения: U5 → развилка A/B решена как B (no-op сейчас, engine-additive вынесен в отдельный будущий #35-remainder); U1 SOUND-условно (ISS-030 окно FP) + liveness.ts + новый reason + DEFAULT условно на корпус; U3 → реальные IRP-векторы; U6 → подтверждённый no-op; верификация +корпус/+meta/+dist-политика.

| # | юнит | файлы | завис. | выполнимость | модель/effort |
|---|---|---|---|---|---|
| U1 | **#35a I-3 precision** — `WAITING_ON_TRANSITION_TIMEOUT` только при `inFlightAsyncCount()>0`; НОВЫЙ reason (напр. `WAITING_ON_INTERNAL`) для «queue>0/processing ∧ inFlight==0 ∧ таймер» — он ОСТАЁТСЯ I-3-witness. I-3 исключает только WoTT. DEFAULT-промоушен I-3 — УСЛОВЕН на нулевой-ложняк-корпус СО string-method-invoke конфигами (ISS-030: string-method действия не трекаются inFlightAsyncCount → окно FP) | **settle.ts, liveness.ts (своя копия SettleReason+classifier), invariants.ts (I-3), public.ts (DEFAULT), + settle/liveness тесты, api-report** | — | ✅ SOUND-условно (ISS-030 окно проверить корпусом) | opus/high |
| U2 | **#26 RCE B4** — `recreateLiteral`/`new Function` в `./sim` define — trusted-input-only. Решение: НЕ sandbox (accept-risk), ДОБАВИТЬ (a) runtime-guard на пустой/невалидный source, (b) тест-контракт «fromJSON(untrusted) НЕ компилирует source, define(trusted) компилирует», (c) док-подтверждение границы в barrel | define.ts, sim/index.ts (barrel-док), тест | — | ✅ | sonnet/med |
| U3 | **#36 §4в** — минимум 5-10 РЕАЛЬНЫХ W3C SCXML IRP-тестов селекции/document-order/exit-order (семейства test355/403a-c/504 и соседние), транслированных С СОХРАНЕНИЕМ их W3C pass-критериев (независимость = ПРОИСХОЖДЕНИЕ ожидаемого исхода, не форма) + карта применимости (priority-расширение / single-vs-OTS — что не применимо и почему). Если трансляция вектора невозможна — задокументировать per-вектор; если остаются только ручные — записать «§4в частично, независимой опоры нет» в план-факт | новый selection_conformance.test.ts, SPEC-док | — | ✅ (реальные IRP) | opus/high |
| U4 | **#35b payload-субстрат** — `SimOptions.eventPayload?` + driver arg-прокачка (типовая: 2-й позиц.=Adapter ЯВНО передаётся driver'ом, payload с 3-го — до isAdapter не доезжает; hazard НЕ в детекции, а в прокачке через FAULT-путь тоже, иначе fault/no-fault расходятся). checkMachine прокидывает `EventSpec.payload(rng,snapshot)`. DoD: fault-путь несёт payload идентично; payload-draw НЕ потребляет PRNG в no-payload прогонах (byte-identical generated-корпус) | driver.ts (fireOne/fireWithFaults/SubmissionEntry/fireMany), public.ts, check-machine.ts, тесты | U1 | ✅ (риск = replay-детерминизм, ассерт в верификации) | opus/high |
| U5 | **#35c I-5 teeth → ПОДТВЕРЖДЁННЫЙ no-op в W7** — критик доказал: sound-тег внутреннего `done.state.C` НЕВОЗМОЖЕН без engine-правки (frame.event только из op.event; success-recordTransition зовётся БЕЗ context на state_machine.ts:4002; internalQueue приватна). Engine-additive путь (передать context.eventName в success-recordTransition + корреляция с seam + doneDelta на verdict-пути + смена core dist-baseline) — вынесен в **#35-remainder (будущее, НЕ W7)**. В W7: подтвердить честный no-op + meta-классификацию, задокументировать engine-additive спеку | invariants.ts (комментарий), план-факт, #35 | — | ✅ подтвердить no-op (НЕ фабриковать) | sonnet/med |
| U6 | **#35d I-4 teeth → ПОДТВЕРЖДЁННЫЙ no-op** — критик СОГЛАСИЛСЯ с W5b: enter-order невыразим из leaf-снимков (тот же engine-канал, что U5-A). Подтвердить no-op + meta-классификацию | invariants.ts (комментарий), план-факт | — | ✅ подтвердить no-op | sonnet/med |
| U7 | **#15 perf** — §4б counting-probe: test-only счётчик (под символом/флагом, НЕ горячий путь прод-сборки) обходов регионов на `setCurrentState`/`computeInternalWrite` (state_machine.ts:2578 Θ(R²) conflict-scan) при R=320, ассерт O(R) НЕ мс. Если проба вскроет super-linear — PERF-03/02/05 фиксы. Механизм счётчика (engine-edit+baseline vs test-only) — РЕШЁН: test-only symbol-gated (минимальный core-touch; dist-baseline обновляется осознанным коммитом если инструментирование в прод-путь) | state_machine.ts (symbol-gated counter), новый perf-counting тест | секв. с U5-A если оба трогают core (U5=no-op → нет конфликта) | ✅ | opus/high |
| U8 | **#6 docs** — checkMachine в README-каталоге; SPEC §13.3 границы; ЯВНО задокументировать перенос (не сокращение §0.6): guardOutcomes/nonConvergingRegions/minimalTrace-shrink/init-config-invariant checkMachine — зарезервированы/будущее; CODING_RULES/AGENTS под W5-W7 | README, docs, AGENTS, SPEC | все | ✅ | opus/med |

## Группы исполнения (по независимости файлов)

- **Группа A (параллельно, разные файлы)**: U2 (define.ts/тест), U3 (новый тест), U7 (state_machine.ts+новый тест — ОТДЕЛЬНО от sim). → workflow fan-out ИЛИ параллельные mb3-implementer.
- **Группа B (последовательно — общие sim-файлы invariants/driver/public/settle)**: U1 → U5 → U4. U1 первый (settle/I-3 контекст), затем U5 (тот же контекст), затем U4 (driver arg).
- **U6**: оценка (вероятно no-op-подтверждение) — быстрый, до Группы B.
- **U8 docs**: последний (после всех, отражает финал).

## Верификация (КАЖДЫЙ юнит) — дополнена по план-критику

1. red→green: тест-нарушитель до фикса краснеет, после — зеленеет (или honest-no-op обоснован).
2. полный `vitest run` + оба tsc + knip зелёные.
3. **dist-guard политика**: sim-юниты (U1/U2/U4/U5/U6) — core `dist/index.*` байт-идентичен (guard PASS без изменений). Core-трогающие (U7 если инструментирование в прод-путь) — dist-baseline обновляется ОТДЕЛЬНЫМ осознанным коммитом (как W3-волны), не тихо edit-агентом. SM_SIM sim:pr не сломан.
4. **нулевой-ложняк-корпус §4а.2 (ОБЯЗАТЕЛЬНО для U1/U5)**: полный builtin-реестр по корпусу КОРРЕКТНЫХ машин → ноль violation. Корпус ДОПОЛНИТЬ конфигами со **string-method invoke-действиями** (ISS-030 окно FP из U1) + composite-join машинами. C1 — прецедент этого класса.
5. **двусторонний meta-тест §4а.1 (oracle self-test #25)**: ОБНОВИТЬ реестр ожиданий — I-3→DEFAULT (teeth); I-5→подтверждённый no-op; I-4→подтверждённый no-op — и перепрогнать. Не только «зеленеет», но и классификация обновлена.
6. **replay-детерминизм (U1/U4)**: (a) существующий generated-корпус byte-identical traceHash после U4 (payload-draw не потребляет PRNG в no-payload); (b) хэш-эффект нового SettleReason-литерала U1 ограничен только классом с изменённым reason; api-report (`SettleReason` экспортируем) обновлён.
7. mb3-critic (fable, статический) — приёмка КАЖДОГО юнита; дефект → воспроизвести → доводка → re-критик.
8. план-факт §0.7 per-юнит.

## Границы (честность)

- U5/U6: если sound-тег/маркер недостижим из content-трейса — ЧЕСТНЫЙ no-op с обоснованием (как I-4 в W5b), НЕ ложные зубы. Критик плана должен подтвердить, что это допустимый исход.
- U4 payload: object-payload через driver — arg-misparse hazard (isAdapter на 2-й позиции); субстрат обязан НЕ ломать существующий number-путь (byte-identical replay generated-сценариев).
- U7 perf: ассерт O(R) счётчиком, НЕ мс (CI-железо флейкает) — §4б.
