# DA Review — TASK-014 — IMPLEMENT — Iteration 3

- Task: TASK-014
- Phase: IMPLEMENT
- Iteration: 3
- Status: approved
- Verdict: PROCEED
- Source: claude-hook
- Review Mode: subagent
- Gate Authority: authoritative
- Timestamp: 2026-06-22T15:06:17.287Z
- Review Schema: mb3-critic.review/v2
- Lens: Plan Fidelity
- Previous Review: da_review_implement_r02
- UR Refs: UR-002, UR-005
- Follow-up Issues: ISS-065, ISS-066

## Follow-up Issues

- ISS-065
- ISS-066

## Report

## DA Report:

- Task: TASK-014
- Phase: IMPLEMENT
- Lens: Plan Fidelity
- Verdict: PROCEED
- Date: 2026-06-22
- Source: claude-hook

### Executive Summary

Re-review of the IMPLEMENT-exit fix for ISS-064 (fault layer wired into no driver). VERIFIED against source, not on trust: (1) all 7 FaultKinds have a real apply call-path during a run — reorder/drop/dup/overflow through fireBuffered+applyQueueFaults+buildOverflowFlood (driver.ts:612-698), clock-skew forward-only delta on advance ops (driver.ts:436-444, clock.ts monotonic), timer-jitter via buildPlanJitter over fork('faults') installed on the scheduler (define.ts:272-300, public.ts:210-241, observable-scheduler.ts:156-193), throw via applyThrowFaults config-mutation at construction (driver.ts:197-202, harness.ts:331-474); each stamps TraceFrame.faultApplied + pushes a FaultRecord. (2) AC-2 is now genuinely end-to-end: dst-e2e-repro.test.ts originates a FAULT-driven Violation through public runSimulation, shrinks through real runScenario+runSafety with a genuine M0 disable-faults move (shrinker.ts:497,547-563) that keeps the necessary fault (faults.length===1), emits via real codegen, and re-executes the emitted repro through @vedmalex/statemachine/sim re-failing the same fingerprint. (3) Determinism preserved: fork('faults') never advances the parent op/topology PRNG, fault-determinism.test.ts asserts bit-identical traceHash across an 8-seed multi-kind sweep WITH faults active + JSON round-trip stability; no Date.now/Math.random/real-timer in any fault path (clock is logical monotonic; faults.ts/harness.ts/observable-scheduler.ts module-doc invariants grep-enforced). (4) FaultRecord + faultApplied recorded at every apply point and exposed via faultRecordsList(); replay regenerates identical records (integration:125,186). (5) No regression / no ABI break: etc/statemachine.api.md contains ZERO sim/fault symbols (only the pre-existing SimpleStateName engine generic), SimOptions.faults was already-frozen and is now merely made live (public.ts:354,401 — no signature change), the no-fault fast path is gated by faultsActive and routes the original raw fire (driver.ts:466-475) so clean-run hash/perf are unchanged, the 7-literal FaultKind union is frozen (trace.ts:81), and the coverage-gate overflow path is intact (coverage.ts). Evidence corroborated by npm run check exit 0, SM_SIM=1 vitest 806 passed/0 failed, sim:coverage exit 0, and the independent adversarial verifier (sound / faults_genuinely_applied / ac2_real). Two residual LOW gaps surfaced as carry-forward (F-I-1 reorder single-op no-op; F-I-2 identity-keyed throw latch); neither blocks. Zero CRITICAL/HIGH/MEDIUM findings -> PROCEED to QA.

### UR-Goal Traceability

| UR-ID | Goal | Status | Evidence |
|---|---|---|---|
| UR-002 | Fault injection at event-queue / scheduler / callback seams genuinely applied during a real run | COVERED | driver.ts step()/fireWithFaults routes external fires through fireBuffered+applyQueueFaults (reorder/drop/dup at :666-697, overflow flood at :628-658), clock-skew forward delta on advance ops (:436-444 via clockSkewAt), timer-jitter via define.ts:279 buildPlanJitter(fork('faults')) scheduler + recordPlanJitter (:392), throw via applyThrowFaults at construction (:197). dst-e2e-repro.test.ts drives generator+fault -> public runSimulation -> real Violation -> shrink(M0 disable-faults shrinker.ts:547) -> emit -> re-execute, end-to-end. |
| UR-005 | Full v1 fault set (seven FaultKinds) wired and individually reproducible during a real simulation | COVERED | fault-integration.test.ts proves each of 7 kinds applied with observable effect + FaultRecord + TraceFrame.faultApplied + replay-identical hash; FaultKind union frozen to exactly seven literals (trace.ts:81); faults.test.ts (46 fault assertions) covers unit layer; fault-determinism.test.ts multiKindPlan exercises queue+scheduler+callback seams together through public runScenario/runSimulation. |

### Phase-Specific Challenges

- [LOW] reorder is a structural no-op on the normal single-op step() path
  - Challenge: In driver.ts fireWithFaults (:660-678) a reorder fault on a normal step() op operates on a single-entry submission buffer, so applyQueueFaults swaps nothing — the fault is RECORDED and TraceFrame.faultApplied:'reorder' is stamped, but no observable reordering occurs. Only fireMany (:723-743) drives a genuine >=2-entry reorder window, and only the integration test (fault-integration.test.ts:160-166) exercises it. A consumer attaching a lone reorder fault via SimOptions.faults on a per-step op would see a recorded-but-inert fault.
  - Alternative: Carry-forward note for QA: document that reorder requires a multi-op submission window (fireMany) to have observable effect, and confirm QA coverage does not over-claim reorder reproducibility from the single-op step() path. The driver already documents this (:661-665); QA should pin it.
  - Risk: A reorder fault could be reported as 'applied' (FaultRecord + tag present) while producing no behavioral perturbation on the public per-step op path, weakening the reproducibility claim for that one kind on that one path. Non-blocking: the kind IS genuinely exercised via fireMany and recorded honestly.
  - Ref: src/sim/driver.ts:660-678
- [LOW] throw-fault single-shot latch keyed by FaultSite object identity
  - Challenge: applyThrowFaults uses `const fired = new Set<FaultSite>()` with `fired.has(site)` / `fired.add(site)` (harness.ts:345-352) to make the throw single-shot. This relies on the SAME site object reference being passed on every invocation. It is currently safe because the site is captured once at config-mutation time and the wrapped closure holds that reference, so replay is deterministic. But it is an implementation fragility: identity-keyed latching (rather than a value/opId key) would silently mis-fire if a site object were ever reconstructed or structurally cloned mid-run.
  - Alternative: Carry-forward: prefer a value-stable latch key (e.g. opId or a structural site signature) over object identity in a future hardening pass, or add an assertion that the latch is identity-stable. No change required for this gate.
  - Risk: Latent fragility only; no current determinism break (fault-determinism.test.ts + dst-e2e-repro replay both pass bit-identically). Becomes a real bug only if site reconstruction is introduced later.
  - Ref: src/sim/harness.ts:345-352

### Verdict

**PROCEED**

Re-review of the IMPLEMENT-exit fix for ISS-064 (fault layer wired into no driver). VERIFIED against source, not on trust: (1) all 7 FaultKinds have a real apply call-path during a run — reorder/drop/dup/overflow through fireBuffered+applyQueueFaults+buildOverflowFlood (driver.ts:612-698), clock-skew forward-only delta on advance ops (driver.ts:436-444, clock.ts monotonic), timer-jitter via buildPlanJitter over fork('faults') installed on the scheduler (define.ts:272-300, public.ts:210-241, observable-scheduler.ts:156-193), throw via applyThrowFaults config-mutation at construction (driver.ts:197-202, harness.ts:331-474); each stamps TraceFrame.faultApplied + pushes a FaultRecord. (2) AC-2 is now genuinely end-to-end: dst-e2e-repro.test.ts originates a FAULT-driven Violation through public runSimulation, shrinks through real runScenario+runSafety with a genuine M0 disable-faults move (shrinker.ts:497,547-563) that keeps the necessary fault (faults.length===1), emits via real codegen, and re-executes the emitted repro through @vedmalex/statemachine/sim re-failing the same fingerprint. (3) Determinism preserved: fork('faults') never advances the parent op/topology PRNG, fault-determinism.test.ts asserts bit-identical traceHash across an 8-seed multi-kind sweep WITH faults active + JSON round-trip stability; no Date.now/Math.random/real-timer in any fault path (clock is logical monotonic; faults.ts/harness.ts/observable-scheduler.ts module-doc invariants grep-enforced). (4) FaultRecord + faultApplied recorded at every apply point and exposed via faultRecordsList(); replay regenerates identical records (integration:125,186). (5) No regression / no ABI break: etc/statemachine.api.md contains ZERO sim/fault symbols (only the pre-existing SimpleStateName engine generic), SimOptions.faults was already-frozen and is now merely made live (public.ts:354,401 — no signature change), the no-fault fast path is gated by faultsActive and routes the original raw fire (driver.ts:466-475) so clean-run hash/perf are unchanged, the 7-literal FaultKind union is frozen (trace.ts:81), and the coverage-gate overflow path is intact (coverage.ts). Evidence corroborated by npm run check exit 0, SM_SIM=1 vitest 806 passed/0 failed, sim:coverage exit 0, and the independent adversarial verifier (sound / faults_genuinely_applied / ac2_real). Two residual LOW gaps surfaced as carry-forward (F-I-1 reorder single-op no-op; F-I-2 identity-keyed throw latch); neither blocks. Zero CRITICAL/HIGH/MEDIUM findings -> PROCEED to QA.
