# DA Review — TASK-014 — QA — Iteration 2

- Task: TASK-014
- Phase: QA
- Iteration: 2
- Status: approved
- Verdict: PROCEED
- Source: claude-hook
- Review Mode: subagent
- Gate Authority: authoritative
- Timestamp: 2026-06-22T15:15:08.144Z
- Review Schema: mb3-critic.review/v2
- Lens: Coverage
- Previous Review: da_review_qa_r01
- UR Refs: UR-001, UR-002, UR-003, UR-004, UR-005
- Follow-up Issues: ISS-069, ISS-070, ISS-071

## Follow-up Issues

- ISS-069
- ISS-070
- ISS-071

## Report

## DA Report:

- Task: TASK-014
- Phase: QA
- Lens: Coverage
- Verdict: PROCEED
- Date: 2026-06-22
- Source: claude-hook

### Executive Summary

Re-review of the prior QA REVISE. F-Q-1 (HIGH) is genuinely closed: dst-e2e-repro.test.ts drives a REAL fault-originated Violation through the PUBLIC runSimulation (the onTransition throw is re-thrown by the default processError handler at state_machine.ts:1693 because the generated topology sets no onError, propagates to the harness .catch, and is classified injected-fault via the cause chain at faults.ts:200-202 — landing errorClass:'injected-fault' on a real frame), shrinks via the REAL runScenario+runSafety with a genuine M0 disable-faults move that KEEPS the necessary fault (faults.length===1), emits via real emitRepro, and re-executes the emitted repro through @vedmalex/statemachine/sim re-failing the SAME fingerprint — one whole chain, not decomposed/mocked. AC-2 is real: fault-integration.test.ts applies each of the 7 FaultKinds during a real run with an observable effect + FaultRecord + replay-identical hash, with reorder honestly bounded to the fireMany >=2-op window per ISS-067 (not over-claimed). fault-determinism.test.ts proves bit-identical traceHash with multi-kind faults active across an 8-seed sweep plus public-runSimulation faults-live identity. AC-1 canary, AC-3 Safety, AC-8 capability gate (deep-equal pin + non-vacuous negative proof) did not regress; core byte-frozen, api.md zero leak. Skip honesty holds: the three new fault tests import from SOURCE and run ungated on every leg; only heavy SM_SIM sweeps are gated. F-Q-2 over-claim corrected. No CRITICAL/HIGH/MEDIUM coverage hole at QA exit; the single MEDIUM (ISS-055) is a confirmed CODE_REVIEW carry-forward not a QA gap, and LOW items (ISS-067/068) are advisory. PROCEED to CODE_REVIEW.

### UR-Goal Traceability

| UR-ID | Goal | Status | Evidence |
|---|---|---|---|
| UR-001 | VOPR-style DST simulator running real engine code in a controlled deterministic environment | COVERED | 806/806 tests; fault layer genuinely wired into SimDriver.step (driver.ts:428-485,612-698); real engine driven via public runScenario/runSimulation |
| UR-002 | seed-driven generator + full 7-kind fault injection + Safety/Liveness + shrinker + CI; one seed reproduces the whole run bit-exact | COVERED | prior PARTIAL (ISS-064: fault layer wired into no driver) now CLOSED — all 7 FaultKinds applied during real runs (fault-integration.test.ts:102-267); 8-seed bit-identical replay WITH faults (fault-determinism.test.ts:41-49); full fault-originated chain generator+fault->violation->shrink->emit->re-execute via public ./sim (dst-e2e-repro.test.ts:189-268); throw genuinely engine-produced via processError re-throw (state_machine.ts:1693) classified injected-fault via cause chain (faults.ts:200-202) |
| UR-003 | simulation environment for load/stress + deterministic feature debugging | COVERED | perf plane (metrics.test.ts), public debug surface (public_sim_surface.test.ts), fault-originated MinimalRepro emitted+re-executed (dst-e2e-repro.test.ts:233-269) |
| UR-004 | cover ALL machine functionality + mandatory CI gate failing on uncovered capability | COVERED | sim:coverage exit 0 (32/39, 7 pinned documented gaps); capabilities_gap_pin.test.ts:38-114 deep-equal pin + non-vacuous negative proof (remove covering scenario -> exit 1) |
| UR-005 | exportable ./sim subpackage, core ABI/bundle untouched, full fault model in v1 | COVERED | separate @unstable ./sim entry; core etc/statemachine.api.md zero sim/fault leak; dist_byte_guard.test.ts; all 7 FaultKinds wired (reorder/drop/dup/overflow/clock-skew/timer-jitter/throw) |

### Phase-Specific Challenges

- [MEDIUM] ISS-055 settle QUIET_FLUSH=16 margin (carry-forward)
  - Challenge: settle.ts QUIET_FLUSH=16 deferred-timer margin lacks an explicit boundary test; routed to CODE_REVIEW per prior F-Q-4 confirmation, not a QA coverage hole
  - Alternative: Add a QUIET_FLUSH boundary/margin test and document the deferred-timer rationale during CODE_REVIEW/REFLECT
  - Risk: If the margin is wrong an edge settle could over/under-drain; low likelihood, contained to a known issue
  - Ref: src/sim/settle.ts (ISS-055)
- [LOW] ISS-067 reorder observable only on >=2-op fireMany window
  - Challenge: reorder produces no observable swap on the single-op step() path; it is structurally a no-op there (driver.ts:660-678) and only observable via fireMany (driver.ts:716-735)
  - Alternative: Keep the disclosure; consider a generator path that emits >=2-op windows so generated scenarios can surface reorder end-to-end in a future iteration
  - Risk: None for QA — the qa evidence explicitly does NOT over-claim reorder on single-op; fault-integration uses fireMany for the observable reorder
  - Ref: src/tests/sim/fault-integration.test.ts:155-187; src/sim/driver.ts:660-678
- [LOW] ISS-068 throw-fault single-shot latch keyed by FaultSite object identity
  - Challenge: the throw latch is keyed by FaultSite object identity (harness.ts:345-352); currently safe/deterministic but identity-keyed latches are brittle if a site object is reconstructed
  - Alternative: Consider a value-keyed (serialized site) latch during CODE_REVIEW to remove the identity dependency
  - Risk: None observed — replay-identical across runs is proven (fault-integration replay assertions); flagged for durability only
  - Ref: src/sim/harness.ts:345-352

### Verdict

**PROCEED**

Re-review of the prior QA REVISE. F-Q-1 (HIGH) is genuinely closed: dst-e2e-repro.test.ts drives a REAL fault-originated Violation through the PUBLIC runSimulation (the onTransition throw is re-thrown by the default processError handler at state_machine.ts:1693 because the generated topology sets no onError, propagates to the harness .catch, and is classified injected-fault via the cause chain at faults.ts:200-202 — landing errorClass:'injected-fault' on a real frame), shrinks via the REAL runScenario+runSafety with a genuine M0 disable-faults move that KEEPS the necessary fault (faults.length===1), emits via real emitRepro, and re-executes the emitted repro through @vedmalex/statemachine/sim re-failing the SAME fingerprint — one whole chain, not decomposed/mocked. AC-2 is real: fault-integration.test.ts applies each of the 7 FaultKinds during a real run with an observable effect + FaultRecord + replay-identical hash, with reorder honestly bounded to the fireMany >=2-op window per ISS-067 (not over-claimed). fault-determinism.test.ts proves bit-identical traceHash with multi-kind faults active across an 8-seed sweep plus public-runSimulation faults-live identity. AC-1 canary, AC-3 Safety, AC-8 capability gate (deep-equal pin + non-vacuous negative proof) did not regress; core byte-frozen, api.md zero leak. Skip honesty holds: the three new fault tests import from SOURCE and run ungated on every leg; only heavy SM_SIM sweeps are gated. F-Q-2 over-claim corrected. No CRITICAL/HIGH/MEDIUM coverage hole at QA exit; the single MEDIUM (ISS-055) is a confirmed CODE_REVIEW carry-forward not a QA gap, and LOW items (ISS-067/068) are advisory. PROCEED to CODE_REVIEW.
