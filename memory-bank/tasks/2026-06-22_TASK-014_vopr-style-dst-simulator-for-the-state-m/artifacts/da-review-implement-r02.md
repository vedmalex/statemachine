# DA Review — TASK-014 — IMPLEMENT — Iteration 2

- Task: TASK-014
- Phase: IMPLEMENT
- Iteration: 2
- Status: approved
- Verdict: PROCEED
- Source: claude-hook
- Review Mode: subagent
- Gate Authority: authoritative
- Timestamp: 2026-06-22T13:54:48.196Z
- Review Schema: mb3-critic.review/v2
- Lens: IMPLEMENT / Plan Fidelity
- Previous Review: da_review_implement_r01
- UR Refs: UR-002, UR-003, UR-004, UR-005
- Follow-up Issues: ISS-056

## Follow-up Issues

- ISS-056

## Report

## DA Report:

- Task: TASK-014
- Phase: IMPLEMENT
- Lens: IMPLEMENT / Plan Fidelity
- Verdict: PROCEED
- Date: 2026-06-22
- Source: claude-hook

### Executive Summary

RE-REVIEW after prior REVISE. Both HIGH findings are verified FIXED against source, not merely claimed. F-PF-1: DOCUMENTED_GAP_IDS (capabilities.ts:525-533) is exactly the 7 ratified ids — the 4 frozen-minimal + 3 amended structural gaps (queue.internal-before-external, event.onSuccess, event.onError), each with genuine inline structural-unreachability rationale (capabilities.ts:156-170/260-278/499-516), matching the TECH_SPEC §3.7 amendment recorded as canonical Section 11 (tech-spec-sim-api.md:836-863) and deep-equal pinned by capabilities_gap_pin.test.ts:28-45. The 5 recovered ids (queue.backpressure.overflow, timer.transitionTimeout, timer.resume, persistence.serialize, persistence.deserialize) have REAL covering wire-time drive paths (coverage.ts driveOverflowFrame/driveTransitionTimeoutFrame/drivePostRestoreFrame :311-430, field-selected errorClass never e.message) keyed off CoverageScenario envelope intents, with concrete scenarios (backpressure-timeout.ts maxQueueDepth:2 flood-8 + hanging-onTransition timeoutMs:2; persistence.ts saveState/restoreState round-trip with a pending delay:5 invoke for genuine resumeTimers re-arm) registered in COVERAGE_SCENARIOS (scenarios/index.ts:26-35). The pin test is NON-vacuous: it removes each covering scenario and asserts the id goes uncovered with exitCode!==0 (capabilities_gap_pin.test.ts:74-115). F-PF-2: opts.invariants is genuinely threaded (public.ts:343) into a CheckerContext built once (public.ts:390-393); evaluateSafety runs the blind runSafety registry against the accumulating canonical trace at each step boundary (public.ts:417-448); StepOutcome.violation = lowest-step firstViolation (public.ts:430); SimResult.ok = (firstViolation===undefined) and SimResult.violation = first/lowest (public.ts:469-474) — NOT a no-op, ok flips false on a real violation. The frozen public signatures are unchanged (only EXISTING Violation/runSafety/CheckerContext types used). repro-codegen.ts now emits a test replaying via the PUBLIC runSimulation with the frozen INVARIANTS registry (repro-codegen.ts:158-166), closing AC-4/DoD-9b; public_invariants.test.ts (8 tests) proves planted-violation→ok:false+fingerprint through BOTH runSimulation and Simulator.run, incremental step()-surfacing, lowest-step-wins, clean→ok:true, and AC-4 public-entry re-fail. Architecture-thesis invariants re-confirmed intact: state_machine.ts has ZERO sim symbols (grep 0 matches for runSafety/invariants/wire/Simulator/SimDriver/settleMacrostep/capture/CapabilityId), core etc/statemachine.api.md has zero sim leak (only Clock/createVirtualScheduler + pre-existing engine StateMachineOptions), TraceSynthetic legitimately extends to 'post-restore' (trace.ts:25), no flush()/drainToQuiescence()/untilIdle primitive exists (only module-doc absence assertions + the QUIET_FLUSH heuristic comments), single settleMacrostep preserved, errorClass-keyed probes and closed-union CapabilityId determinism intact. CI change introduces no regression: ci.yml is a single Node-24 tier-a-node leg with no node-18/20 matrix and no per-version guards, and ci-gating.test.ts:42-77 + perf-placement.test.ts:19-44 assert the new single-leg Node-24 contract (DST steps on the one leg, perf regression nightly-only). No NEW HIGH/CRITICAL divergence introduced. F-PF-3 (settle.ts QUIET_FLUSH=16 heuristic; observable 4-conjunct isQuiescent preserved) carries to CODE_REVIEW as MEDIUM ISS-055 per directive — not re-blocked here. ISS-048 (node-20 baseline) resolved by the Node-24 CI directive (baselines measured on v24.9.0 == CI node).

### UR-Goal Traceability

| UR-ID | Goal | Status | Evidence |
|---|---|---|---|
| UR-002 | Real engine, seed->bit-exact replay, fault injection, Safety + Liveness modes, shrinker, long-running CI | COVERED | Public Safety path now wired: Simulator/runSimulation evaluate opts.invariants via blind runSafety per step boundary (public.ts:343,390-393,417-448) and populate ok/violation; prior PARTIAL (dead public Safety path) is closed. Liveness/replay/shrinker/CI unchanged and faithful. |
| UR-003 | Dual bug-hunter AND permanent load/debug tool; constructible for arbitrary consumer machines via ./sim | COVERED | A consumer supplying invariants to runSimulation now gets ok:false + a populated Violation on a real violation (public_invariants.test.ts planted-violation cases); AC-4 generated repro re-fails through the REAL public runSimulation with frozen INVARIANTS (repro-codegen.ts:158-166, public_invariants.test.ts DoD-9b). Prior PARTIAL closed. |
| UR-004 | Cover ALL functionality via a MANDATORY programmatic capability-coverage gate (defense-in-depth) | COVERED | DOCUMENTED_GAP_IDS restored to the ratified 7-id minimal set (capabilities.ts:525-533), gap-set CONTENTS now deep-equal pinned with negative-proof teeth (capabilities_gap_pin.test.ts), 5 previously-gapped ids genuinely covered by wire-time drive paths; gate enforces 32/39 with exit 0 (was 27/12). The mandatory-gate thesis is no longer silently weakened. Prior PARTIAL closed. |
| UR-005 | Both internal harness AND public ./sim; ABI zero-diff + bundle budget; perf regression gate; full v1 fault set | COVERED | Core src byte-frozen (zero sim refs in state_machine.ts), core etc/statemachine.api.md zero sim leak, separate ./sim entry + dist-bytes guard, full fault set; CI Node-24 single-leg + perf regression nightly-only re-verified (ci.yml, ci-gating.test.ts, perf-placement.test.ts). |

### Phase-Specific Challenges

- [LOW] settle.ts QUIET_FLUSH=16 stability-window heuristic (carry-forward)
  - Challenge: settle.ts retains the QUIET_FLUSH=16 quiet-window heuristic and deferred-timer-processing mechanism that refines (does not break) the literal frozen ADR-4 'process each turn' mechanism; the observable 4-conjunct isQuiescent predicate is preserved exactly. Adequacy of the 16-turn window is asserted empirically, so a scenario deeper than the empirical microtask chain could in principle burn budget or declare quiescence one layer early.
  - Alternative: At CODE_REVIEW, justify QUIET_FLUSH=16 against the deepest registered scenario's observed microtask-chain depth with a falsifiable margin test, and document the deferred-timer-processing rationale in REFLECT as a ratified deviation.
  - Risk: Bounded to the settle mechanism; the AC-1 fixed-seed canary plus the determinism-gated coverage runner (run-twice equal hashTrace before counting) currently catch any non-reproducible traceHash. Tracked as ISS-055 (MEDIUM CODE_REVIEW carry-forward per directive); recorded here as LOW advisory carry-forward — does NOT block PROCEED.
  - Ref: packages/statemachine/src/sim/settle.ts:154-289 (QUIET_FLUSH window); ISS-055

### Verdict

**PROCEED**

RE-REVIEW after prior REVISE. Both HIGH findings are verified FIXED against source, not merely claimed. F-PF-1: DOCUMENTED_GAP_IDS (capabilities.ts:525-533) is exactly the 7 ratified ids — the 4 frozen-minimal + 3 amended structural gaps (queue.internal-before-external, event.onSuccess, event.onError), each with genuine inline structural-unreachability rationale (capabilities.ts:156-170/260-278/499-516), matching the TECH_SPEC §3.7 amendment recorded as canonical Section 11 (tech-spec-sim-api.md:836-863) and deep-equal pinned by capabilities_gap_pin.test.ts:28-45. The 5 recovered ids (queue.backpressure.overflow, timer.transitionTimeout, timer.resume, persistence.serialize, persistence.deserialize) have REAL covering wire-time drive paths (coverage.ts driveOverflowFrame/driveTransitionTimeoutFrame/drivePostRestoreFrame :311-430, field-selected errorClass never e.message) keyed off CoverageScenario envelope intents, with concrete scenarios (backpressure-timeout.ts maxQueueDepth:2 flood-8 + hanging-onTransition timeoutMs:2; persistence.ts saveState/restoreState round-trip with a pending delay:5 invoke for genuine resumeTimers re-arm) registered in COVERAGE_SCENARIOS (scenarios/index.ts:26-35). The pin test is NON-vacuous: it removes each covering scenario and asserts the id goes uncovered with exitCode!==0 (capabilities_gap_pin.test.ts:74-115). F-PF-2: opts.invariants is genuinely threaded (public.ts:343) into a CheckerContext built once (public.ts:390-393); evaluateSafety runs the blind runSafety registry against the accumulating canonical trace at each step boundary (public.ts:417-448); StepOutcome.violation = lowest-step firstViolation (public.ts:430); SimResult.ok = (firstViolation===undefined) and SimResult.violation = first/lowest (public.ts:469-474) — NOT a no-op, ok flips false on a real violation. The frozen public signatures are unchanged (only EXISTING Violation/runSafety/CheckerContext types used). repro-codegen.ts now emits a test replaying via the PUBLIC runSimulation with the frozen INVARIANTS registry (repro-codegen.ts:158-166), closing AC-4/DoD-9b; public_invariants.test.ts (8 tests) proves planted-violation→ok:false+fingerprint through BOTH runSimulation and Simulator.run, incremental step()-surfacing, lowest-step-wins, clean→ok:true, and AC-4 public-entry re-fail. Architecture-thesis invariants re-confirmed intact: state_machine.ts has ZERO sim symbols (grep 0 matches for runSafety/invariants/wire/Simulator/SimDriver/settleMacrostep/capture/CapabilityId), core etc/statemachine.api.md has zero sim leak (only Clock/createVirtualScheduler + pre-existing engine StateMachineOptions), TraceSynthetic legitimately extends to 'post-restore' (trace.ts:25), no flush()/drainToQuiescence()/untilIdle primitive exists (only module-doc absence assertions + the QUIET_FLUSH heuristic comments), single settleMacrostep preserved, errorClass-keyed probes and closed-union CapabilityId determinism intact. CI change introduces no regression: ci.yml is a single Node-24 tier-a-node leg with no node-18/20 matrix and no per-version guards, and ci-gating.test.ts:42-77 + perf-placement.test.ts:19-44 assert the new single-leg Node-24 contract (DST steps on the one leg, perf regression nightly-only). No NEW HIGH/CRITICAL divergence introduced. F-PF-3 (settle.ts QUIET_FLUSH=16 heuristic; observable 4-conjunct isQuiescent preserved) carries to CODE_REVIEW as MEDIUM ISS-055 per directive — not re-blocked here. ISS-048 (node-20 baseline) resolved by the Node-24 CI directive (baselines measured on v24.9.0 == CI node).
