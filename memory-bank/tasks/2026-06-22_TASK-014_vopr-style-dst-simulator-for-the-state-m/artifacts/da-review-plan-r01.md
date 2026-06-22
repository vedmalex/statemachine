# DA Review — TASK-014 — PLAN — Iteration 1

- Task: TASK-014
- Phase: PLAN
- Iteration: 1
- Status: approved
- Verdict: PROCEED
- Source: claude-hook
- Review Mode: subagent
- Gate Authority: authoritative
- Timestamp: 2026-06-22T07:53:48.752Z
- Review Schema: mb3-critic.review/v2
- Lens: Plan Fidelity
- UR Refs: UR-002, UR-003, UR-004, UR-005
- Follow-up Issues: ISS-034, ISS-035, ISS-036, ISS-037, ISS-038

## Follow-up Issues

- ISS-034
- ISS-035
- ISS-036
- ISS-037
- ISS-038

## Report

## DA Report:

- Task: TASK-014
- Phase: PLAN
- Lens: Plan Fidelity
- Verdict: PROCEED
- Date: 2026-06-22
- Source: claude-hook

### Executive Summary

The build plan is faithful to the ratified ADR-1..ADR-8. Every load-bearing file:line claim I spot-checked against packages/statemachine/src/state_machine.ts is source-accurate: R1 three write sites (:1116/:1126 each `return` before :1204; :1203 validateCompositeState runs before the :1204 write; :2048 write precedes :2060 recordTransition); R2 CRIT-1 await ordering (:2170 callAction awaited before :2172 raiseEvent + :2173 scheduleProcessing); errorState bypass (:2020 setCurrentState then return inside executeEnterActions catch, never reaching :2060); R11 corrupt-state de-dup (setCurrentStateInternal collapses duplicate region keys into a Map before :1203, so I-6 payload must arrive via :734 restore / :2309/:2353 transition-target — exactly as the conform-6 HIGH fold states); :1493 done.state depth-only sort with no same-depth tiebreak; overflow :228-240 synchronous vs :299-312 pending-during-drain; setTimer footgun :2199/:2207; ci.yml:43-52 node-20-guarded api:check/git-diff structure. All five carry-forward obligations (ISS-029..033) are assigned to >=1 step with TECH_SPEC pre-work flagged where required. The dependency graph is acyclic (all edges low->high) and 1..11 is buildable. The architecture-thesis invariants are grep-enforced per step. The three highest-risk traps (corrupt-state de-dup, perf p99 divide-by-zero, knip src/sim reachability) are each explicitly resolved. Sampled DoD checks are falsifiable and non-vacuous (Step 3 DoD#4 explicitly forbids reusing the vacuous dst.test.ts:116 idempotency fixture; Step 6 DoD#11 requires >1 legitimately-orderable sibling). Zero CRITICAL/HIGH findings; MEDIUM/LOW items carry forward to TECH_SPEC/IMPLEMENT.

### UR-Goal Traceability

| UR-ID | Goal | Status | Evidence |
|---|---|---|---|
| UR-002 | Real engine seed->bit-exact replay + fault injection at event-queue/scheduler/callback + Safety+Liveness + shrinker + long-running CI | COVERED | Steps 1-3 (PRNG/trace/clock + DI + settle/driver), Step 5 (seven-kind faults across the three seams), Step 6 (Safety I-1..I-12 + Liveness), Step 7 (shrinker), Step 11 (nightly seed-sweep). AC-1 four-run replay canary is the executable bit-exact proof. |
| UR-003 | Dual bug-hunter AND permanent load/debug tool; constructible for arbitrary consumer machines | COVERED | Step 8 (perf/load plane: throughput, heap, traceLen) serves the load-test facet; Step 10 wire(env,config,owner) makes arbitrary consumer machines constructible with all five DI seams; deterministic replay + public ./sim serve the debug-tool facet. The permanent-debug-tool facet is the lightest-emphasized but is structurally present via the stable public entry. |
| UR-004 | Cover ALL functionality + MANDATORY programmatic coverage gate (defense-in-depth) + declarative/extensible + single T4 task | COVERED | Step 9 closed-union CapabilityId + total Record (remove-one-entry tsc-fails teeth) + errorClass-keyed pure probes + computeCoverage gate (uncovered>0\|\|drift>0 -> non-zero); Step 6 declarative blind-iterated Invariant registry. 'ALL functionality' is honestly scoped as registry-scoped (ADR-8 OQ#5 process-gap residual + committed etc/sim-capabilities.txt key-set snapshot) rather than falsely claimed exhaustive. Single T4 task with detailed plan per UR-004's tier decision. |
| UR-005 | BOTH internal harness AND public ./sim (API stability + bundle budget + ABI zero-diff) + stress+perf with CI regression thresholds + programmatic coverage gate + full v1 fault set | COVERED | Step 10 second tsup entry + ./sim exports key + second api-extractor + dist-byte zero-diff guard (splitting:false, '.' byte-frozen); Step 8 perf bands (throughput 20% / mem 25% / p99 30% + traceLen zero) with CI regression; Step 9 coverage gate; full v1 fault set = ADR-5 seven-kind taxonomy (reorder/drop/dup/throw/clock-skew/timer-jitter/overflow) matching UR-005.4 exactly. |

### Phase-Specific Challenges

- [LOW] UR-003 'permanent debug tool' facet under-instrumented relative to load + bug-hunter
  - Challenge: UR-003 explicitly re-weights the task: the simulator is a permanent DEVELOPMENT/DEBUG tool AND a load tool, not only a bug-hunter. The plan robustly covers load (Step 8) and bug-hunting (Steps 5-7), and the public wire()/replay surface (Step 10) structurally enables debugging, but no step carries an explicit DoD proving the debug-workflow ergonomics UR-003 calls out (e.g. a developer reproducing/stepping a new-feature scenario deterministically from a seed). The MinimalRepro emitter (Step 7) and public wire() (Step 10) are the closest, but the 'debug a new feature in a deterministic reproducible env' use case is implicit.
  - Alternative: At TECH_SPEC, add one explicit acceptance bullet (e.g. on Step 10 or a REFLECT honesty note) that a consumer can take a seed + scenario through the public ./sim wire()/runSimulation path and obtain a deterministic, inspectable step trace for feature debugging — making the UR-003 debug-tool facet falsifiable rather than inferred from replay + repro-codegen.
  - Risk: Low. The capability is present; only the explicit demonstration that the debug-tool facet of UR-003 is satisfied is absent, risking a REFLECT-phase honesty gap where load + bug-hunting are demonstrated but the debug-workflow is asserted without a test.
- [LOW] I-6 corrupt-state via transition-target sites (:2309/:2353) cited but not source-pinned in the plan the way :734/:1203 are
  - Challenge: The plan repeatedly cites :2309/:2353 as alternative I-6 throwing sites (transition-target validation) alongside the source-verified restore path :734. I independently verified :734 (validateCompositeState on the raw restored string before setCurrentState) and the :1203 de-dup mechanism, confirming the payload-delivery contract is correct. But the plan offers :2309/:2353 as an OR-branch without the same line-level mechanism proof it gives :734, so an implementer could pick the transition-target branch and discover at IMPLEMENT that those sites also pre-dedup or are otherwise unsuitable.
  - Alternative: TECH_SPEC item 4 (corrupt-state payload-delivery contract) should pin ONE primary delivery site with verified mechanism — the :734 restore path is already proven to see the raw duplicate — and demote :2309/:2353 to a verified-at-IMPLEMENT alternative, or verify them at TECH_SPEC before freezing.
  - Risk: Low. :734 is proven sufficient, so the obligation is dischargeable regardless; the risk is only wasted IMPLEMENT effort if the unproven branch is chosen first.
- [MEDIUM] inFlightAsyncCount string-method-invoke gap (:1745/:1764) is honestly documented but its coverage-residual interaction with the mandatory gate is split across Steps 3/5/9 without a single owner of the v1 settledness-blind-spot statement
  - Challenge: ADR-4/ISS-030 scope inFlightAsyncCount to wrappable function-valued invoke actions (callAction path-2 :1758-1761), documenting string-method invoke actions resolved via context (:1745) or adaptee.get (:1764) as a v1 gap. This is a genuine settledness blind spot: a string-method async invoke action could be in-flight while settleMacrostep reports quiescent (the very CRIT-1 hazard, but for the unwrappable shape). Step 3 documents it in env.ts, Step 5 owns the enumeration, Step 9 owns the coverage residual — but no single artifact states the determinism CONSEQUENCE (a string-method async invoke can produce a non-replayable trace, so such scenarios must be excluded by I-1 or the generator must avoid emitting them).
  - Alternative: At TECH_SPEC, alongside the ISS-030 await-site freeze, add an explicit statement of the determinism consequence of the string-method-invoke settledness gap and WHERE it is contained: either (a) the Step-4 generator never emits string-method async invoke actions (so the corpus is gap-free by construction), or (b) any such scenario is caught by the I-1 replay gate and excluded from coverage. Make the chosen containment a falsifiable DoD on Step 4 or Step 6.
  - Risk: Medium. If neither containment is pinned, a generated (or consumer wire()) scenario with a string-method async invoke could intermittently produce a premature-quiescence trace that fails I-1 non-deterministically, or worse, slips past as a flaky coverage contributor. The gap is honestly named but its containment is currently distributed and not provably closed in any single step's DoD.
- [LOW] Perf latency advisory-skip under faked Date depends on a real-timer baseline leg whose CI wiring is split between Step 8 (measure) and Step 11 (run); a stale/absent real-timer p99 baseline silently yields a permanent N/A band
  - Challenge: Step 8 conform-8-HIGH correctly identifies that engine Date.now() latency is structurally 0 under vitest faked Date, requires the committed baseline p99 to come from a real-timer leg, and defines the p99 band as N/A when baseline p99 < epsilon (avoiding divide-by-zero). But the band N/A path means a perpetually-zero baseline (e.g. if the real-timer leg is never actually run during the ISS-032 measurement pass, or regresses to 0) silently disables the p99 gate forever without failing anything.
  - Alternative: Add a Step-8 DoD (or a Step-11 CI assertion) that the committed baseline p99 MUST be strictly > epsilon when the latency band is intended to gate — i.e. an all-zero latency baseline is itself a committed-baseline validation failure, not a silent N/A. This makes 'the p99 gate is actually armed' falsifiable rather than degrading silently to N/A.
  - Risk: Low. The divide-by-zero is correctly avoided and throughput/traceLen remain the primary gates; only the p99 latency band could silently no-op. Carry to IMPLEMENT (ISS-032 measurement pass).
- [LOW] Step 10 RR-2 tsconfig-isolation fallback branch can re-couple a sim type error to the core tier-a gate, partially eroding the 'additive, zero-core-impact' thesis
  - Challenge: Step 10(6)/contract RR-2 acknowledges that if isolating tsconfig.sim.json while still emitting types/sim/index.d.ts is infeasible, the fallback is documented acceptance — meaning a src/sim/** type error WOULD block core npm run check / build / prepublishOnly / tier-a. That is a real erosion of the UR-005 'core unaffected' posture (a sim-island bug breaks the core gate), accepted as a risk but only discoverable at TECH_SPEC feasibility assessment.
  - Alternative: TECH_SPEC item 3 already owns the feasibility assessment; ensure its falsifiable acceptance test (Step 10 DoD#11) is treated as gate-relevant at TECH_SPEC exit: if the fallback branch is taken, REFLECT must record the accepted coupling explicitly so it is not silently absorbed. No plan change needed now; flag that the fallback branch is a material UR-005 posture change requiring explicit sign-off, not a routine documentation note.
  - Risk: Low. Accepted risk with a clear owner phase (TECH_SPEC->IMPLEMENT->REFLECT) and a falsifiable acceptance test; surfaced here so the fallback is not quietly chosen.

### Verdict

**PROCEED**

The build plan is faithful to the ratified ADR-1..ADR-8. Every load-bearing file:line claim I spot-checked against packages/statemachine/src/state_machine.ts is source-accurate: R1 three write sites (:1116/:1126 each `return` before :1204; :1203 validateCompositeState runs before the :1204 write; :2048 write precedes :2060 recordTransition); R2 CRIT-1 await ordering (:2170 callAction awaited before :2172 raiseEvent + :2173 scheduleProcessing); errorState bypass (:2020 setCurrentState then return inside executeEnterActions catch, never reaching :2060); R11 corrupt-state de-dup (setCurrentStateInternal collapses duplicate region keys into a Map before :1203, so I-6 payload must arrive via :734 restore / :2309/:2353 transition-target — exactly as the conform-6 HIGH fold states); :1493 done.state depth-only sort with no same-depth tiebreak; overflow :228-240 synchronous vs :299-312 pending-during-drain; setTimer footgun :2199/:2207; ci.yml:43-52 node-20-guarded api:check/git-diff structure. All five carry-forward obligations (ISS-029..033) are assigned to >=1 step with TECH_SPEC pre-work flagged where required. The dependency graph is acyclic (all edges low->high) and 1..11 is buildable. The architecture-thesis invariants are grep-enforced per step. The three highest-risk traps (corrupt-state de-dup, perf p99 divide-by-zero, knip src/sim reachability) are each explicitly resolved. Sampled DoD checks are falsifiable and non-vacuous (Step 3 DoD#4 explicitly forbids reusing the vacuous dst.test.ts:116 idempotency fixture; Step 6 DoD#11 requires >1 legitimately-orderable sibling). Zero CRITICAL/HIGH findings; MEDIUM/LOW items carry forward to TECH_SPEC/IMPLEMENT.
