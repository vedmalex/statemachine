# DA Review — TASK-014 — CREATIVE — Iteration 1

- Task: TASK-014
- Phase: CREATIVE
- Iteration: 1
- Status: approved
- Verdict: PROCEED
- Source: claude-hook
- Review Mode: subagent
- Gate Authority: authoritative
- Timestamp: 2026-06-22T03:54:21.264Z
- Review Schema: mb3-critic.review/v2
- Lens: CREATIVE / Design Integrity
- UR Refs: UR-004, UR-002, UR-001, UR-003, UR-005
- Follow-up Issues: ISS-024, ISS-025, ISS-026, ISS-027, ISS-028

## Follow-up Issues

- ISS-024
- ISS-025
- ISS-026
- ISS-027
- ISS-028

## Report

## DA Report:

- Task: TASK-014
- Phase: CREATIVE
- Lens: CREATIVE / Design Integrity
- Verdict: PROCEED
- Date: 2026-06-22
- Source: claude-hook

### Executive Summary

All 8 ADRs are internally coherent; the three cross-ADR contradictions (capture-inside-recordTransition reading both from/to; 'single determinism surface' vs Liveness clock-jump; structural-predicate quiescence) are resolved into one capture seam, one quiescence primitive, one PRNG, one trace, one shrinker target. Every load-bearing file:line source claim I independently verified against the real engine is accurate: Adapter.set single method + three write sites (:1116/:1126/:1204 with history-restore return-before-:1204); recordTransition(:2060) hardcoded (time,true) no-context; recordError gated (:424); recordEvent never called; duration telemetry + 'Do not virtualize' comment (:2044-2060); errorState fallback bypass (:2020); async-invoke CRIT-1 (await callAction :2170 before raiseEvent/scheduleProcessing :2172-2173); invoke.cond caught-continue (:2151-2162); checkCompletion same-depth sibling raise-order gap (:1493-1495 depth-only sort); overflow reject (:228-240); invalid-event throw (:381-386); monitoring :77/:97 Date.now; security createdAt + FNV fold (:430/:462/:468); canFireEvent no-guard (:518); setTimeout fallback (:2207); fireEvent unshift overload (:469-471). The determinism hash is sound by construction (closed-allowlist TraceFrame structurally incapable of referencing excluded fields). Zero core-source edit preserves the etc/statemachine.api.md zero-diff and dist byte-stability claims. UR scoping is honest (registry-scoped coverage, not falsely exhaustive) and the T4:standard tier correctly honors UR-004's explicit override of UR-002's T5:epic ambition. No CRITICAL/HIGH defect found. Carry-forward MEDIUM/LOW items recorded below are TECH_SPEC/IMPLEMENT obligations, not CREATIVE-blocking.

### UR-Goal Traceability

| UR-ID | Goal | Status | Evidence |
|---|---|---|---|
| UR-001 | VOPR-style DST simulator on top of the TASK-013 clock/scheduler seam (seed-driven generator, fault injection, safety+liveness, shrinker, long-running CI) | COVERED | Architecture thesis + ADR-1..ADR-8 + §3 driver loop + §8 phase plan; all built on the TASK-013 clock/scheduler DI seam verified at state_machine.ts:154-156, scheduler.ts process(). |
| UR-002 | Real engine, seed->bit-exact replay, fault injection at event-queue/scheduler/callback, Safety + Liveness, shrinker, long-running CI | COVERED | ADR-1 (content-only hash) + ADR-2 (frozen PRNG) + ADR-3 (DI neutralization, Adapter-write capture) + ADR-4 (settleMacrostep) + ADR-5 (3-seam fault taxonomy) + ADR-6 (Safety/Liveness oracle, shrinker first-violation target). AC-1 four-run canary is the executable bit-exactness proof. Real-engine-unchanged confirmed (zero source edit). |
| UR-003 | Dual role: bug-hunter AND permanent load/debug tool; constructible for arbitrary consumer machines | COVERED | ADR-7 (public ./sim entry + wire()-from-config DI) for arbitrary-consumer constructibility; §4.7 PerfHarness (load/stress) + MinimalRepro JSON+*.repro.test.ts (debug fixture). Bug-hunter role via ADR-5/ADR-6. |
| UR-004 | Cover ALL functionality; MANDATORY programmatic coverage gate (defense-in-depth); declarative/extensible; single T4 task (no child decomposition) | COVERED | ADR-8 (closed-union CapabilityRegistry + total Record forcing tsc completeness + errorClass-keyed trace-probes + key-set snapshot) is the mandatory gate; §6 registry table is declarative/extensible. 'ALL functionality' is honestly scoped as registry-scoped (ADR-8 OQ#5, REFLECT honesty note) rather than over-claimed. T4:standard tier honors UR-004's explicit override of UR-002's T5:epic ambition. |
| UR-005 | BOTH internal harness AND public ./sim entry; API stability + bundle budget + ABI zero-diff; stress+perf with CI regression thresholds; programmatic coverage gate; full v1 fault set | COVERED | ADR-7 (separate ./sim @unstable island, etc/statemachine.api.md zero-diff, dist byte guard, splitting:false duplication empirically proven core bytes unchanged); §4.7 perf median-of-N regression + zero-tolerance traceLen; ADR-8 gate; ADR-5 full v1 fault set = exactly reorder/drop/dup + guard/action/callback throw + clock-skew + timer-jitter + overflow as UR-005.4 demands. |

### Phase-Specific Challenges

- [MEDIUM] v1 fault gaps narrow UR-005.4 'full fault set' and UR-004 'cover ALL' for two callback shapes
  - Challenge: ADR-5 (RR-4) excludes invoke[].cond throw-injection and string-method (ActionOrString name-resolved) callback throws from v1. UR-005.4 demands the 'full v1 fault set' and UR-004 demands 'cover ALL functionality'. The exclusions are technically justified (cond throw is caught-continued at :2155-2161 verified; string-method callbacks cannot be wrapped by config mutation), so they are honest gaps rather than over-claims — but a consumer machine that uses string-method callbacks gets NO throw-fault coverage, and the coverage gate must actively refuse to mark error.guard-throw/error.action-throw covered for such machines.
  - Alternative: Carry forward to TECH_SPEC/IMPLEMENT + REFLECT: (1) the coverage gate MUST detect a string-method-only machine and emit an explicit uncovered/not-applicable signal rather than silent pass; (2) REFLECT records both gaps as named PARTIAL-coverage residuals against UR-005.4 with a v2 path (e.g. a config-AST rewrite or an additive wrap seam for string-method callbacks). The ADR already commits contract 12 (literal-inlined false cond exercises the cond-skip path) — ensure this is the ONLY cond capability claimed.
  - Risk: If unenforced, a future consumer/scenario silently certifies 'throws covered' on a machine whose throw paths were never exercised, defeating the UR-004 defense-in-depth gate for the most common production callback shape (named string actions).
  - Ref: .plan/TASK-014-creative-dst-architecture.md ADR-5 v1 EXCLUSIONS (lines 312, 329); RR-4 (line 641)
- [MEDIUM] inFlightAsyncCount settledness depends on wrapping opaque consumer callbacks — feasibility unproven for the ./sim arbitrary-consumer path
  - Challenge: ADR-4's CRIT-1 fix (the entire quiescence correctness for in-flight async invoke actions, verified real at :2169-2173) rests on env.inFlightAsyncCount() being incremented/decremented by the harness wrapper around consumer-supplied callbacks at wire time. For the internal harness (closure-free generated guards/actions) this is sound. For the public ./sim wire() path with an arbitrary consumer machine, the harness must wrap EVERY function-valued callback the engine may await (invoke[].action, and any onEnter/onAfter that returns a Promise the engine awaits). If a consumer callback path is reachable but not wrapped (e.g. a callback the wrapper enumeration misses, or a string-method action resolved by name), inFlightAsyncCount can read 0 while an action is genuinely in flight -> premature quiescence -> the exact CRIT-1 false-settle the ADR claims to have closed, now on the public path.
  - Alternative: Carry forward to TECH_SPEC: enumerate EXHAUSTIVELY every engine site that awaits a consumer callback (cross-check against callAction :1726 chokepoint and the invoke action path :2170) and prove the wrapper covers all of them; document that the inFlightAsyncCount guarantee is scoped to wrappable function-valued callbacks (the same shape-scope as the ADR-5 throw gap) and that string-method/unwrappable callbacks degrade settledness to the maxTurns last-resort budget. IMPLEMENT must validate against a consumer machine with a genuinely opaque async action.
  - Risk: A determinism/false-quiescence regression that escapes the internal test suite (which uses closure-free callbacks) but surfaces for real ./sim consumers, undermining UR-002 bit-exact replay precisely on UR-003's arbitrary-consumer use case.
  - Ref: .plan/TASK-014-creative-dst-architecture.md ADR-4 decision item inFlightAsyncCount (line 240), contract 9 (line 274); ADR-7 wire() (line 450)
- [MEDIUM] corrupt-state probe issues a bogus write through Adapter.set, which the capture seam wraps — risk of self-corrupting the captured trace / engine state
  - Challenge: ADR-6 introduces an 8th harness-only corrupt-state fault that does a direct adaptee.set of a contradictory composite to make the engine's validateCompositeState (:1203/:1608) and getCurrentState (:1219-1224, verified throws on unregistered leaf) guards fire for I-6/I-10. But ADR-6 also states this bogus write goes through 'the SAME consumer Adapter.set the capture seam wraps' and is captured as a synthetic:'corrupt-state' frame. There is an ordering hazard: after the probe writes a bogus composite, the very next engine read of getCurrentState (e.g. inside the next macrostep's settle diff, or the harness's own getCurrentState try/catch) will throw — the ADR relies on this throw being the I-10 witness, but it must be proven the bogus write does not also derail the unrelated settle-boundary getCurrentState diff used for resolve-false/reject framing, nor leave the real engine in a state from which the run cannot continue deterministically for OTHER invariants in the same run.
  - Alternative: Carry forward to TECH_SPEC/IMPLEMENT: specify that corrupt-state is the LAST op of a dedicated single-purpose I-6/I-10 scenario (no other invariant shares the run after a corrupt write), or that the harness restores the pre-corrupt config immediately after capturing the guard-throw witness. Pin a regression test that a corrupt-state scenario produces exactly one synthetic:'corrupt-state' frame followed by the expected guard-throw witness and no spurious downstream frames.
  - Risk: Without scoping, the probe could contaminate the captured trace of co-resident invariants in the same run, producing a false I-1 determinism mismatch or a mis-attributed violation that the shrinker then minimizes toward the harness artifact rather than an engine bug.
  - Ref: .plan/TASK-014-creative-dst-architecture.md ADR-6 I-6/I-10 triggering input (line 382), RR-6 (line 643)
- [LOW] OQ#2 perf baselines unmeasured — AC-7 CI regression thresholds are not yet falsifiable
  - Challenge: UR-005.2 demands perf metrics with CI regression thresholds. ADR-7/§4.7 commit to median-of-N=5 with wide bands (throughput 20% / mem 25% / p99 30%) and zero-tolerance traceLen, but OQ#2 leaves the concrete events/sec floor and peak-heap ceiling for etc/sim-perf.baseline.json to a one-time IMPLEMENT measurement pass. This is correctly deferred (a baseline cannot be set in CREATIVE without a runner-class measurement) and explicitly owned as an accepted risk, so it is advisory, not blocking.
  - Alternative: Carry forward: IMPLEMENT performs the measurement pass on the CI runner class and commits the baseline; REFLECT records the chosen floor/ceiling and confirms the band widths actually catch an order-of-magnitude regression without flapping across the bun + node18/20 legs.
  - Risk: If the band widths prove too wide after measurement, a real perf regression could pass CI silently — but the zero-tolerance traceLen determinism detector remains an independent backstop, limiting the blast radius.
  - Ref: .plan/TASK-014-creative-dst-architecture.md OQ#2 (line 634); §4.7 baseline (plan line 371)
- [LOW] Equal-executeAt timer-tie order and same-depth done.state raise-order are 'capture-actual-order as ground truth' — replay-stable but semantically unpinned
  - Challenge: Two verified engine non-orderings — the min-heap has no insertion tiebreak (scheduler.ts process orders by executeAt only, confirmed) and checkCompletion :1493-1495 sorts candidates by depth only (same-depth siblings fall to seen-Set insertion order, confirmed) — are handled by capturing the ACTUAL fired/raised order as ground truth plus a regression pin. This is sound for bit-exact replay (the order is deterministic for a fixed insertion sequence within one isolate) and the ADR correctly refuses to add an engine tiebreak (which would be an ABI change). The residual is that the 'ground truth' is insertion-order-coupled, so a future engine Map-iteration or heap-array refactor would change the hash — the ADR's regression pin is the only guard, and its existence/strength is an IMPLEMENT obligation.
  - Alternative: Carry forward to IMPLEMENT: ensure BOTH regression pins exist and are non-vacuous — (a) the ≥2-parallel-region '|'-normalization pin (ADR-1 contract 9) and (b) the same-depth sibling done.state raise-order pin (leak ledger gap #4). Each must construct a topology where >1 sibling could be ordered differently, else the pin is vacuous (the same vacuous-test trap the ADR already fixed for the region-order test).
  - Risk: A silent hash drift on a future engine refactor that the regression pin fails to catch if the pin topology is degenerate (single-element), invalidating the long-running regression corpus.
  - Ref: .plan/TASK-014-creative-dst-architecture.md leak ledger gap #4 (lines 600, 609); ADR-1 contract 9 (line 92); verified state_machine.ts:1493-1495, scheduler.ts:108-132

### Verdict

**PROCEED**

All 8 ADRs are internally coherent; the three cross-ADR contradictions (capture-inside-recordTransition reading both from/to; 'single determinism surface' vs Liveness clock-jump; structural-predicate quiescence) are resolved into one capture seam, one quiescence primitive, one PRNG, one trace, one shrinker target. Every load-bearing file:line source claim I independently verified against the real engine is accurate: Adapter.set single method + three write sites (:1116/:1126/:1204 with history-restore return-before-:1204); recordTransition(:2060) hardcoded (time,true) no-context; recordError gated (:424); recordEvent never called; duration telemetry + 'Do not virtualize' comment (:2044-2060); errorState fallback bypass (:2020); async-invoke CRIT-1 (await callAction :2170 before raiseEvent/scheduleProcessing :2172-2173); invoke.cond caught-continue (:2151-2162); checkCompletion same-depth sibling raise-order gap (:1493-1495 depth-only sort); overflow reject (:228-240); invalid-event throw (:381-386); monitoring :77/:97 Date.now; security createdAt + FNV fold (:430/:462/:468); canFireEvent no-guard (:518); setTimeout fallback (:2207); fireEvent unshift overload (:469-471). The determinism hash is sound by construction (closed-allowlist TraceFrame structurally incapable of referencing excluded fields). Zero core-source edit preserves the etc/statemachine.api.md zero-diff and dist byte-stability claims. UR scoping is honest (registry-scoped coverage, not falsely exhaustive) and the T4:standard tier correctly honors UR-004's explicit override of UR-002's T5:epic ambition. No CRITICAL/HIGH defect found. Carry-forward MEDIUM/LOW items recorded below are TECH_SPEC/IMPLEMENT obligations, not CREATIVE-blocking.
