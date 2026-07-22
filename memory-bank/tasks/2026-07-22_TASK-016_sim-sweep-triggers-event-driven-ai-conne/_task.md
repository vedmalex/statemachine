# TASK-016: Sim sweep triggers: event-driven (ai-connect pattern) instead of nightly cron

- **Profile**: creative-first
- **Tier**: 2
- **QA Level**: STANDARD
- **Execution Mode**: sequential
- **Status**: completed
- **Phase**: QA
- **Created**: 2026-07-22T10:59:32Z
- **Updated**: 2026-07-22T11:30:37Z
- **Continues**: TASK-015
- **Continuation reason**: User follow-up after TASK-015 closed: the nightly cron re-runs a FIXED deterministic seed window [0,256) on unchanged code (zero new information); user directed adopting the ~/work/ai-connect trigger model (event-driven, no cron).

## UR Coverage

- [x] UR-001 — superseded by UR-002
- [x] UR-002 — covered
