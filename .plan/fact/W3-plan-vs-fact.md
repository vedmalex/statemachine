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

## W3-B — правило селекции SCXML + ленивые гарды + fireEventDetailed + перф — ОЖИДАЕТ

## W3-C — optimal transition set + порядок фаз applyTransition (П5) — ОЖИДАЕТ

## W3b — invoke-операции + ExitContext (новая фича) — ОЖИДАЕТ