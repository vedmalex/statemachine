---
event_store_revision: 6
event_store_hash: f53d4b44a1fbadb0e8195d5c15ec63b4a70b16d1613c6ecc8ddfdeefafd842e2
materialized_at: 2026-07-22T11:24:29.308Z
materialized_by: materialize_verb
---
# Implementation — TASK-016

## Changes Made

## Changes Made

1. `.github/workflows/sim-nightly.yml`: cron schedule removed; triggers now push-to-main (paths-filtered: `packages/statemachine/**` + the workflow file) + `workflow_dispatch`; `concurrency` group with `cancel-in-progress: true`; workflow renamed to "Sim Seed-Sweep" (file name kept for run-history continuity); header documents the event-driven rationale AND the ACCEPTED TRADE-OFF of dropping the periodic perf environment-drift probe; "ONCE per night" comment reworded to "ONCE per triggering event".
2. `packages/statemachine/src/tests/sim/ci-gating.test.ts`: DoD-7 block rewritten — asserts the event-driven trigger shape (push/branches/paths/workflow_dispatch present; `schedule:`/`cron:` ABSENT) plus a new concurrency assertion; perf-placement test title de-nightly-fied.
3. `packages/statemachine/src/sim/cli/sim-sweep.ts`: module docstring no longer claims to be nightly (comment-only, no behavior change — CD-63 not implicated).

## Files Modified

## Files Modified

- `.github/workflows/sim-nightly.yml` (commits 3831818, fcc438b)
- `packages/statemachine/src/tests/sim/ci-gating.test.ts` (fcc438b)
- `packages/statemachine/src/sim/cli/sim-sweep.ts` (fcc438b, docstring only)

## Key Decisions

## Key Decisions

1. **No cron at all** (user directive: the ai-connect pattern) — the sweep's seed window is fixed and deterministic, so scheduled re-runs of unchanged code are pure redundancy.
2. **Documented acceptance instead of a weekly perf cron** (DA F-D1-2): the perf gate runs on every push, so environment drift is detected at the next push; a weekly cron would contradict the user's explicit no-cron directive. Trade-off + compensating control written into the workflow header.
3. **No `pull_request` trigger** — the PR leg is ci.yml; duplication avoided.
4. **File name `sim-nightly.yml` kept** — renaming would orphan the gh run history; only the workflow `name:` changed.
5. **Pre-existing chronic CI red (coverage threshold, since ≥2026-06-15) NOT fixed here** — out of trigger-task scope; captured as REQ-001 to avoid an unverified drive-by fix.
6. **DA capture failures (missing_envelope ×4 today) escalated as REQ-002** — an orthogonal MB3 runtime bug (async-agent subagent-stop path), not a waiver of findings; no replacement emit fabricated, per the DA emission policy.

## Commit Trail

## Commit Trail

- `3831818` ci(TASK-016): sim seed-sweep goes event-driven — push to main + dispatch, cron dropped → its own push AUTO-triggered run 29914058487 (event=push) SUCCESS — live verification of the new trigger.
- `fcc438b` fix(TASK-016): DA remediation — DoD-7 asserts event-driven triggers; perf-drift trade-off documented → auto-triggered Sim Seed-Sweep run 29914837841 SUCCESS; CI run 29914837908: bun/deno/browser legs SUCCESS (incl. the rewritten DoD-7 assertions), tier-a-node fails ONLY on the pre-existing REQ-001 coverage threshold (branches 89.87% < 90%, 59/59 test files passing).

## UR Coverage

UR-001 (superseded by UR-002, same goal): implemented — sim-nightly.yml is event-driven (push to main paths-filtered + workflow_dispatch, concurrency cancel-in-progress, cron removed), commit 3831818; DA F-D1 remediation adds the updated DoD-7 structural test, the documented perf-drift trade-off, and comment cleanups.

## DA REVISE remediation (iteration 1 findings)

## DA REVISE remediation (iteration 1 findings)

- **F-D1-1 (HIGH, stale cron assertion breaks CI):** CONFIRMED — and investigation revealed the failure is layered: the DoD-7 cron assertion newly broke ci-gating.test.ts, BUT main's CI has been red on EVERY push since ≥2026-06-15 for a PRE-EXISTING, unrelated reason (tier-a-node coverage threshold: branches 89.87% < 90%, all tests passing). Fix in this task: DoD-7 rewritten to assert the NEW trigger shape (push+paths-filter+workflow_dispatch+concurrency present; schedule/cron ABSENT) plus a new concurrency assertion; local run 15/15 pass (ci-gating + perf-placement), full suite 798 passed exit 0. The pre-existing coverage-threshold red is OUT OF SCOPE for this trigger task and captured as REQ-001 (bug_report, global inbox) — fixing it silently here would be an unverified drive-by.
- **F-D1-2 (HIGH, perf drift probe dropped undocumented):** documented ACCEPTED TRADE-OFF block added to the sim-nightly.yml header: the gate still runs on EVERY push (drift caught at next push, not next night); the TASK-015-calibrated envelope absorbs known runner variance; compensating control = on a perf failure with no plausible code cause, suspect drift first and re-capture the baseline on the CI runner class (cross-referenced to the baseline calibration note).
- **F-D1-3 (MEDIUM, 'ONCE per night' comment):** reworded to 'ONCE per triggering event'.
- **F-D1-4 (MEDIUM, _task.md UR checklist):** UR-001/UR-002 evidence records appended via evidence_batch (implementation + qa, urRefs).
- **F-D1-5 (LOW, 'nightly' terminology):** the actively-misleading sim-sweep.ts module docstring updated (event-driven since TASK-016, file name kept for run-history continuity); the DoD-7 perf-placement test title reworded. Remaining incidental 'nightly' comment mentions (sim-pr.ts, sweep internals, perf-placement comments) reference the unchanged FILE NAME and are advisory carry-forward per CD-40.
