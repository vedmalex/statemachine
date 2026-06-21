# User Requests

## UR-001
- Timestamp: 2026-06-21 08:24
- Source: user
- Text (verbatim): "SCXML/UML-correct composite regions: ancestor-first entry/exit + all-final join"

## UR-002
- Timestamp: 2026-06-21 09:06
- Source: user
- Text (verbatim): "SCXML/UML-correct composite regions. Реализовано и подтверждено независимой проверкой (workflow wdjxtj6xy, verdict=implemented, confidence=high): UR-A region-entry fix (bare-root composite раскрывается, region onEnter файрит на переходах; updateState guard state_machine.ts:2320); UR-B SCXML ancestor-first entry / descendant-first exit единообразно (computeEnterExitSets:1596, shared ancestors диффятся); UR-C UML all-regions-final join через State.final/done.state.<C>/isDone (isCompositeDone:1366, checkCompletion:1459 deepest-first, edge-gated, event-gated; публичный isDone:1433); UR-D docs (README + docs/regions-and-parallel.md, нет stale unsupported); UR-E llm-wiki ≥3 страницы (regions-and-parallel, entry-exit-ordering, all-final-join); public API ratchet final?/isDone (etc/statemachine.api.md:458,509); changeset MINOR. Тесты regions/composite/final/join: 51 тест, 0 fail, 165 expect (hierarchical.test.ts + config_validator.test.ts). Единственный named-fail в полном наборе — pre-existing ServerAdapter (вне scope), performance-flake environmental. Branch fix/regions-ancestor-entry-and-final-join."
