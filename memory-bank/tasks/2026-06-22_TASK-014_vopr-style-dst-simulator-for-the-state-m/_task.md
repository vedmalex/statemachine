# TASK-014: VOPR-style DST simulator for the state machine (deterministic simulation testing)

- **Profile**: creative-first
- **Tier**: T4:standard
- **QA Level**: MAX
- **Execution Mode**: subagent_driven
- **Status**: in_progress
- **Phase**: ARCHIVE
- **Created**: 2026-06-22T02:26:02Z
- **Updated**: 2026-06-22T15:43:43Z
- **Branch**: feat/dst-simulation-TASK-014
- **Continues**: TASK-013
- **Continuation reason**: TASK-013 landed the deterministic-replay seam (options.clock + createVirtualScheduler). This epic builds the VOPR-style deterministic simulator on top of that seam: a seed-driven scenario generator, a fault-injection layer adapted to a single-process state machine (event reorder/drop/dup, callback errors/throws, clock skew, scheduler jitter, event-queue overflow), safety+liveness modes, invariant checkers, failing-trace shrinker/minimizer, and long-running CI integration. Reuses the clock/scheduler injection contract from TASK-013 and the region-join semantics from TASK-012.

## Scope

- packages/statemachine/src/**
- packages/statemachine/src/tests/**

## UR Coverage

- [x] UR-001 — covered
- [x] UR-002 — covered
- [x] UR-003 — covered
- [x] UR-004 — covered
- [x] UR-005 — covered
- [x] UR-006 — covered

## Notes

- De-escalate T5:epic -> T4:standard per user directive: one big task with a detailed plan, no child decomposition. Phase set unchanged (9 phases).
