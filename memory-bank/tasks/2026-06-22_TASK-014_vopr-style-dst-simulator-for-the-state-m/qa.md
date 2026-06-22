---
event_store_revision: 3
event_store_hash: 8cc31b934de535defdf36453dac9dd31cd00c66548abf8103ad38d6ae93712e5
materialized_at: 2026-06-22T15:22:17.490Z
materialized_by: phaseTransition
---
# Qa — TASK-014

## Test Results

## Verification Evidence

Freshly re-executed in the main session from packages/statemachine (fault-wired tree):
- `npm run check` (biome + tsc --noEmit + knip): exit 0, 66 files, no fixes.
- `SM_SIM=1 npx vitest run`: 806 passed / 0 failed / 64 files (default leg skips only SM_SIM-gated heavy sweeps by design).
- `npm run sim:coverage`: exit 0 — capability gate 32 covered / 39 total / 7 documented gaps, zero drift (deep-equal pin + committed negative proof).
- Core engine src byte-frozen: no modified file under src/ except src/sim + src/tests/sim; core etc/statemachine.api.md zero sim/fault-symbol leak.

UR coverage (all met, fault layer now genuinely wired):
- UR-001 (VOPR-style DST on the real engine in a controlled deterministic env): COVERED — src/sim/** + 806 tests; real engine driven via public runScenario/runSimulation; AC-1..AC-5.
- UR-002 (seed→bit-exact replay + 7-kind fault injection + Safety/Liveness + shrinker + CI): COVERED — all 7 FaultKinds applied during real runs (fault-integration.test.ts), 8-seed bit-identical replay WITH faults (fault-determinism.test.ts), fault-originated end-to-end repro through public ./sim (dst-e2e-repro.test.ts); ISS-064 closed.
- UR-003 (load/stress + deterministic feature debugging; consumer-constructible): COVERED — perf plane (metrics.test.ts), public wire()/runSimulation/Simulator.step debug surface, fault-originated MinimalRepro; AC-6/AC-7.
- UR-004 (cover ALL functionality + mandatory programmatic coverage gate + declarative): COVERED — sim:coverage gate 32/39 with 7 pinned documented gaps + non-vacuous negative proof; AC-8.
- UR-005 (internal + public @unstable ./sim, ABI/bundle stability, perf thresholds, coverage gate, full v1 fault set): COVERED — separate ./sim entry, core byte-frozen, perf bands, all 7 FaultKinds wired; AC-9/AC-10.

All 10 acceptance criteria (AC-1..AC-10) PASS; AC-2 and AC-4 are now genuinely end-to-end (fault layer wired). IMPLEMENT-exit + QA-exit DA gates both PROCEED.

## Residual Risks

## Sign-off

QA (MAX) SIGNED OFF. All 10 acceptance criteria met against UR-001..UR-005 with fresh re-executed evidence (npm run check exit 0; SM_SIM=1 vitest 806/806; sim:coverage exit 0). The central VOPR-DST fault-injection capability is genuinely wired (7/7 FaultKinds applied during real runs) and determinism-preserving (8-seed multi-kind bit-identical). Mandatory capability gate is non-vacuous; public Safety bug-hunter + fault-originated repro chain are end-to-end. Core engine byte-frozen, zero ABI leak. QA-exit DA gate (mb3-critic, Coverage lens) = PROCEED, zero CRITICAL/HIGH/MEDIUM. Open carry-forward (non-blocking): ISS-055 (settle QUIET_FLUSH margin test → CODE_REVIEW), ISS-067 (reorder single-op doc), ISS-068 (throw-latch identity-key hardening → CODE_REVIEW), ISS-047 (tech-spec citation fixes). Cleared to enter CODE_REVIEW.

## UR Coverage

- [x] UR-001 — AC-1..AC-5 green; real engine driven via public runScenario/runSimulation; 806/806 tests.
- [x] UR-002 — fault injection genuinely applied (7/7), 8-seed bit-identical replay, fault-originated e2e repro through public ./sim.
- [x] UR-003 — AC-6/AC-7: perf bands + public debug surface + MinimalRepro.
- [x] UR-004 — AC-8: sim:coverage exit 0 (32/39), pin + negative proof.
- [x] UR-005 — AC-9/AC-10: separate ./sim entry, core byte-frozen, perf thresholds, full 7-kind fault set.
