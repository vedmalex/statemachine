# W6 план-факт: фасад `checkMachine` (#17) — венец ремедиации

> Артефакт §0.7. Волна W6. Ветка `remediation/w1-prep`. §0.6: только полнота.

## Факт (verdict CLOSED после critic-приёмки)

`checkMachine(config, ownerSource, options?)` — потребительский фасад динамической проверки
конфига (MASTER §2), надстроен над `runSimulation` + оракулы (наследует все фиксы W5a/W5b, не
может от них разойтись). Файл `src/sim/check-machine.ts`, экспорт из `./sim`, документация
`docs/dynamic-check.md` + README-указатель, api-report обновлён.

Анти-находочный контракт (§2.4) реализован:
- **A2**: `ok===true ⇒ oraclesRun>0 ∧ transitionsFired>0` — оба ЖЁСТКИЕ полы (не через failOn).
- **A4**: `livelocks` в headline + жёсткий пол.
- **A5**: timer-escape → typed warning + `escape` cause (`'fail'` — тоже пол).
- **F7**: throw в `MachineInvariant.check` → violation, не проглатывается.
- Покрытие (reachable/unreachable/deadEvents/uncoveredTransitions/saturation-плато) из
  `compileModel` vs трейсы; deadlocks; violations с kind engine/builtin/user + reproCode.

## Critic-приёмка (fable, статический) — 8 находок, ВСЕ адресованы

Критик нашёл дыры в ПЕРВОЙ версии фасада (каждая реальная и воспроизводимая):

| id | сев | дефект | фикс |
|---|---|---|---|
| **F1** | CRITICAL (ядро A2) | `no-progress`/`livelock`/`violation` гейтились `failSet` → `failOn:[]` даёт `ok:true` над неподвижной/нарушенной машиной (§2.4-контракт фальсифицируем опцией) | ЖЁСТКИЕ полы для no-progress/livelock/violation (bypass failOn); только deadlock/escape/degradation/non-converging — failOn-gated |
| **F2** | HIGH (ложный ok:true + ok:false) | user-инварианты проверяли ПЕРВЫЙ фрейм шага (seam), не boundary → пропуск нарушения в устоявшемся состоянии каскада + рассинхрон config/data | оценка на boundary-фрейме (последний в шаге) + per-step снимок owner-данных, отложенная eval при смене шага + финальная |
| **F6** | HIGH (ложный ok:false) | `transitionsFired` считал только resolve-true → timer/invoke-движимая машина → 0 → ложный no-progress | считаем шаги со сменой конфига (boundary from≠to) — ловит fired И timer-переходы |
| **F3** | HIGH (ложный ok:false) | wildcard(`*`/`p.*`)/композит/self-loop → ложные deadlock + гарантированный uncovered→degradation | консервативный `couldExitFrom` (literal/wildcard/prefix/ancestor); uncoveredTransitions только литеральные leaf-to-leaf (wildcard/композит исключены); self-loop через firedEvents; deadEvents исключает `done.state.*`; uncovered-at-plateau ДЕМОУТ в advisory |
| **F5** | HIGH (сумма) | degradation от no-payload фейлил КАЖДУЮ корректную машину (арность не известна статически); runs:1 молча выключал плато-degradation | no-payload/residual → advisory (не fail); degradation только dead-events-at-plateau; runs:1-ограничение задокументировано |
| **F7-мелочи** | MEDIUM/LOW | escape `'fail'`≡`'warn'`; мёртвый splice-блок ПОСЛЕ расчёта ok; doc-drift (`failedOn empty⇒ok:true`, «warnings fail») | `'fail'`=пол; splice удалён; doc-комментарии исправлены |
| — | — | **NUL-байты** в template literal (`${t.event}\x00${t.from}` — тот же класс, что W3-C.1) — сломали бы matching ключей firedTransitions | вычищены (4 шт), сепаратор = пробел |

Чисто (критик подтвердил механизмом): пол oraclesRun; формат путей leaves↔engine; live-ref
owner-данных (MemoryAdapter мутирует оригинал); детерминизм отчёта (арифметический seed + документный
порядок); engine-violation не теряется и не красит машину потребителя.

+4 регресс-теста (критик-хардненинг): F1 failOn:[] не обходит полы (×2), F3 wildcard-не-deadlock,
F3 self-loop-не-uncovered. Всего 19 тестов checkMachine.

## Осталось (документированные ограничения / follow-up)

- **Object-payload инъекция** end-to-end — субстрат (pickOp + driver arg-handling за пределы чисел)
  → W5c (#35); сейчас no-payload default + honest advisory-warning.
- **guardOutcomes / nonConvergingRegions / minimalTrace-shrinking** — поля зарезервированы;
  reproCode базовый (seed+config, без shrink). Расширяемо.
- **runs:1** не даёт плато-degradation-гейтинга (задокументировано в doc).
- **init-конфиг** не проверяется user-инвариантами (init-кадры не идут в onTrace) — минорно.

## Итог W6

**995 passed / 9 skipped; оба tsc + knip чисты; core dist-guard PASS (ядро не тронуто); api-report
обновлён**. Венец на ПРОВЕРЕННЫХ инвариантах (W5a/W5b) + оракульном self-test (#25). Fable-критик
нашёл CRITICAL-обход ядра A2 в первой версии — воспроизведён и закрыт жёсткими полами с регресс-зубами.
Честность > фейк: фрагильное покрытие (wildcard/композит) демоутнуто в advisory, а не оставлено
ложно-фейлящим корректные машины.
