---
event_store_revision: 2
event_store_hash: f5d566ffcf6937cb6fea0d51382a417c5ddbccdb48ce7c205733ac92cfbdc49c
materialized_at: 2026-07-22T10:46:02.065Z
materialized_by: materialize_verb
---
# Implementation — TASK-015

## Changes Made

## Files Modified

## Key Decisions

## Commit Trail

## Changes

## Changes

**Root cause (VAN):** `Sim Nightly Seed-Sweep` failed EVERY night since its first run 2026-06-23 (14+ failure emails; the Release/publish workflow is healthy — last success 2026-06-22). The `sim:perf` memory band tripped: committed baseline `heapPeakBytes=21282048` was captured locally (node v24.9.0), while GitHub ubuntu runners show a bimodal heap peak (~22.45MB low cluster / ~27.0MB high cluster); 27.0MB > 21.28MB*1.25=26.6MB ceiling. With the gate duplicated in all 8 matrix shards, ≥1 shard landed in the high cluster nearly every night. Throughput margin was also thin (floor 10648.7 ev/s vs observed CI low 10917).

**Edit 1 — `packages/statemachine/etc/sim-perf.baseline.json`:** recalibrated the two GATED fields to the CI runner envelope observed across 2026-06-23..2026-07-22 nightly logs: `eventsPerSec` 13310.93→12000 (floor 9600; CI observed range 10917..19300), `heapPeakBytes` 21282048→27030000 (ceiling 33.79MB; covers both CI clusters). Bumped `packageVersion` to 1.0.0-beta.4, set `node` provenance to the runner class, added a `calibration` note field (loader `validatePerfBaseline` checks semantic invariants only — extra field is safe, verified by running the gate). Ungated informational fields left untouched.

**Edit 2 — `.github/workflows/sim-nightly.yml`:** removed the `sim:perf` step from the 8-way `seed-sweep` matrix job and added a dedicated single `perf-gate` job (checkout → node 24 → npm install --no-workspaces → build → `npm run sim:perf`). The gate was identical in every shard, so the matrix multiplied the false-positive odds ×8.

**Verification:** local `npm run sim:perf` → 1 passed; `SM_SIM=1 vitest run src/tests/sim/metrics.test.ts` → 32 passed (unit tests use synthetic samples, no dependency on committed baseline values); YAML parse ok. CI verification: dispatch `Sim Nightly Seed-Sweep` after push and confirm green (pending).

## DA REVISE remediation + CI verification

## DA REVISE remediation + CI verification

DA iteration 1 (IMPLEMENT) returned REVISE with F-D1-1..F-D1-5. Remediation:
- **F-D1-1 (HIGH, CI verification deferred):** committed cf0a66d, pushed to main, dispatched `Sim Nightly Seed-Sweep` run 29913039238 — conclusion SUCCESS, all 9 jobs green (8 seed-sweep shards + the new single perf-gate job). Perf gate bands on the REAL runner: throughput pass (baseline=12000 observed=12219), memory pass (baseline=27030000 observed=27035376 — the run landed in the HIGH heap cluster and passed, directly exercising the failure mode), latencyP99 na, traceLen pass. UR-002's dispatch-verification requirement is now satisfied.
- **F-D1-2 (MEDIUM, gate sensitivity):** accepted trade-off now documented verbatim in the baseline `calibration` field (ceiling ~33.8MB ≈ +25% over worst cluster / +50% over low cluster; tightening path = re-capture full baseline via sim:perf:baseline on the CI runner class).
- **F-D1-3 (MEDIUM, stub implementation.md):** canonical artifact materialized via mb3_artifact materialize (2223 bytes, changed:true).
- **F-D1-4 (LOW, stale informational fields):** staleness now stated explicitly in the calibration note.
- **F-D1-5 (LOW, 'median' mislabel):** calibration note relabels eventsPerSec=12000 as a conservative LOW-END floor anchor (CI observed 10917..19300), not a median.

## UR Coverage

- [x] UR-002
