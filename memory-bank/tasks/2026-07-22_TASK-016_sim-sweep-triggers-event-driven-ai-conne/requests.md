# User Requests

## UR-001
- Timestamp: 2026-07-22 10:59
- Source: user
- Text (verbatim): "Sim sweep triggers: event-driven (ai-connect pattern) instead of nightly cron"
- Superseded by: UR-002
- Continued from task: TASK-015
- Continuation reason: User follow-up after TASK-015 closed: the nightly cron re-runs a FIXED deterministic seed window [0,256) on unchanged code (zero new information); user directed adopting the ~/work/ai-connect trigger model (event-driven, no cron).

## UR-002
- Timestamp: 2026-07-22 10:59
- Source: user
- Text (verbatim): "Rework Sim Seed-Sweep triggers to the ~/work/ai-connect event-driven CI pattern (user directive 2026-07-22, answer to the trigger question: 'посмотри как сделано в ~/work/ai-connect'): drop the daily cron entirely (the sweep enumerates a FIXED deterministic seed window [0,256) — re-running on unchanged code yields identical results by construction); trigger on push to main (paths-filtered to packages/statemachine/** and the workflow file itself) + keep workflow_dispatch; add concurrency group with cancel-in-progress like ai-connect ci.yml. Timing evidence: every job (8 sweep shards + perf-gate) completes in 25-35s including npm install+build (run 29913039238), so the original 'too slow for the PR leg' premise does not hold; the PR leg itself stays covered by ci.yml (no pull_request trigger added here to avoid duplication). Verification: the push of this change itself must auto-trigger the workflow and come back green."
