# DA Review — TASK-014 — TECH_SPEC — Iteration 1

- Task: TASK-014
- Phase: TECH_SPEC
- Iteration: 1
- Status: approved
- Verdict: PROCEED
- Source: claude-hook
- Review Mode: subagent
- Gate Authority: authoritative
- Timestamp: 2026-06-22T08:33:03.322Z
- Review Schema: mb3-critic.review/v2
- Lens: TECH_SPEC / Justification (signature/contract fidelity + spec completeness)
- UR Refs: UR-002, UR-003, UR-004, UR-005
- Follow-up Issues: ISS-044, ISS-045, ISS-046

## Follow-up Issues

- ISS-044
- ISS-045
- ISS-046

## Report

## DA Report:

- Task: TASK-014
- Phase: TECH_SPEC
- Lens: TECH_SPEC / Justification (signature/contract fidelity + spec completeness)
- Verdict: PROCEED
- Date: 2026-06-22
- Source: claude-hook

### Executive Summary

Exhaustive line-by-line verification of every load-bearing file:line claim in the TECH_SPEC against the engine source at this commit. All CRITICAL/HIGH-stakes contracts are faithful and compile-plausible: (1) the public ./sim re-exports (Clock :150, ITimerScheduler :144, IMonitor :138, IErrorHandler :175, ILogger :181, StateMachineConfig :32, StateMachine :24, createVirtualScheduler :169, isAdapter :98, Adapter/StateMachineOptions :51-76) all verified present in src/index.ts; (2) the 7-member errorClass enum is complete and accurate for every engine throw site — queue-overflow (:234 sync reject ~:233), max-transition-depth (:303 msg, externals rejected :307-310, internal cleared :311), transition-timeout (:1790 base StateMachineError, no Date.now), invalid-event (:383, isEngineDoneEvent gate :367), injected-fault, contradictory-state (:1614/:1615), invalid-state-path (read :1220/:1221 guard :1219; write :1161/:1162 correctly listed-and-excluded); (3) the four await-sites are exhaustive — callAction chokepoint :1726, invoke :2170 (await BEFORE raiseEvent+scheduleProcessing :2172/:2173), resume :2504 (then await fireEvent :2506, internal->external asymmetry confirmed), Promise.race :1798/:1802; onError genuinely un-awaited at :2037 (ErrorHandler<T>=EventAction<T,void> types.ts:4) and invoke[].cond genuinely synchronous (types.ts:256, called directly :2153/:2497) — both correctly out of scope; the bracket-the-wrapped-action's-own-promise rule is verified sound against the Promise.race timeout-win semantics; (4) the corrupt-state contract is true — history-restore writes :1116/:1126 each return BEFORE :1204 (confirming the wrap-Adapter.set-not-intercept-:1204 correction), silent-dedup trap :1203 real, validateCompositeState (:1608-1621) operates purely on region-key collision and never calls getCurrentState/this.states.has() so the 'false leaf-registration precondition removed' correction is ITSELF correct and verified, restoreState :734 runs validateCompositeState on the raw string BEFORE setCurrentState :739; (5) ISS-043 honesty verified — tsconfig.json include=['src/**/*'] with no src/sim exclude (:20), check runs bare tsc --noEmit (:50), declarationDir at tsconfig.build.json:6, so the 'isolation NOT achievable by sibling tsconfig alone; branch B documented-coupling is default' verdict is HONEST; (6) perf premises verified — vitest toFake includes 'Date' (:13) but NOT hrtime/memoryUsage/queueMicrotask, security.ts:430/462 bake createdAt:Date.now(); (7) all TECH_SPEC-owned obligations (ISS-030/039/040/041/042/043) discharged with the rest correctly carried to IMPLEMENT. Only two off-by-one citation defects found (both LOW carry-forward): exactOptionalPropertyTypes is at tsconfig.json:12 not :11, and vitest coverage.include is at :17 not :16 — both underlying facts are correct, neither affects compile-plausibility or any contract. Per S3 matrix (zero CRITICAL/HIGH/MEDIUM): gate clears.

### UR-Goal Traceability

| UR-ID | Goal | Status | Evidence |
|---|---|---|---|
| UR-002 | Real engine seed->bit-exact replay; fault injection at event-queue/scheduler/callback; Safety + Liveness; shrinker; long-running CI | COVERED | TECH_SPEC freezes the content-only CanonicalTrace/TraceFrame + hashTrace (§3.2), the 7-kind FaultKind + FaultSite/FaultPlan/FaultSpec/FaultRecord (§3.5, all attached to the three verified injectable seams), Invariant/Violation/Quiescence/LivenessVerdict (§3.4), and the frozen errorClass enum (§3.3). Determinism rests on the verified settledness contract (§4) and DI fidelity (StateMachineOptions types.ts:117-133 verified). Measurement values (perf medians, dist hashes) correctly carried to IMPLEMENT, not frozen. |
| UR-003 | Dual bug-hunter AND permanent load/debug tool; constructible for arbitrary consumer machines | COVERED | ISS-040 discharged: Simulator.step():Promise<StepOutcome> + StepOutcome.frames/traceHash (§1) is the per-step inspectable debug surface; SimResult.trace + PerfSample metrics (§1, §7) serve the load/perf workflow. Arbitrary-machine constructibility via wire(env,config,owner) (§1) where the private-scheduler footgun (verified :79/:82 private, no getter; :154 schedulerProvided) is structurally impossible, plus the {machine} best-effort + behavioral sentinel probe path. |
| UR-004 | Cover ALL functionality; MANDATORY programmatic coverage gate (defense-in-depth); declarative/extensible | COVERED | TECH_SPEC freezes the genuine closed-union CapabilityId (39 literals, no string&{} widening, §3.7), total Record<CapabilityId,Capability> with tsc-totality teeth, errorClass-keyed CapabilityProbe over the canonical trace, computeCoverage with non-zero exit on uncovered/drift, DOCUMENTED_GAP_IDS, and the committed etc/sim-capabilities.txt key-set snapshot. 'ALL functionality' honestly scoped as registry-scoped (carried to REFLECT per OQ#5), not falsely claimed exhaustive. |
| UR-005 | BOTH internal harness AND public ./sim; API stability + bundle budget + ABI zero-diff; stress+perf with CI regression thresholds; full v1 fault set | COVERED | §1 freezes the public ./sim surface (@unstable island); §8 wiring diff verified against package.json (one additive ./sim exports key, '.' byte-identical, sideEffects:false at :23 unchanged, files unchanged), tsup splitting:false, api-extractor.sim.json, verify-dist-bytes.cjs. §7 freezes the perf band config + two-sided loadPerfBaseline throw closing the silent-N/A hole + traceLen zero-tolerance. Full v1 fault set = the verified 7-kind FaultKind (§3.5). ABI zero-diff preserved (no engine source line modified; intentional :2047 Date.now and security createdAt untouched). |

### Phase-Specific Challenges

- [LOW] exactOptionalPropertyTypes line citation off-by-one (over-corrected)
  - Challenge: TECH_SPEC §1 (line ~89-90) and §2 table and §10 assert exactOptionalPropertyTypes:true is at tsconfig.json line 11, flagged as [CORRECTED from :13]. Actual: line 11 is "strict": true; exactOptionalPropertyTypes:true is at line 12. The original :13 was wrong (that is noImplicitOverride) and the [CORRECTED] :11 is also wrong; the true line is :12.
  - Alternative: At IMPLEMENT, correct the citation to tsconfig.json:12 wherever the spec says :11. No contract change — the underlying fact (exactOptionalPropertyTypes IS enabled, so the SimOptions bare-`?`-no-`|undefined` rule holds) is correct and verified.
  - Risk: Cosmetic only. An implementer following the citation literally lands one line off in a 22-line file; the option is unambiguously present. Does not affect compile-plausibility or any frozen signature.
  - Ref: .plan/TASK-014-tech-spec-sim-api.md §1 (SimOptions comment) / §2 table / §10 — vs tsconfig.json:11-12
- [LOW] vitest coverage.include line citation off-by-one
  - Challenge: TECH_SPEC §6 (vitest coverage coupling) cites coverage.include is `['src/**/*.ts']` at vitest.config.ts:16. Actual: line 16 is `provider: 'v8'`; coverage.include is at line 17 (exclude :18-22, thresholds :23-28 — those two are correct).
  - Alternative: At IMPLEMENT, correct the include citation to vitest.config.ts:17. The substantive finding is correct and verified: include is `['src/**/*.ts']`, exclude (:18-22) does NOT list src/sim, so the 90% gate applies to src/sim the moment it lands — the frozen Step-10/11 decision to add 'src/sim/**' to coverage.exclude (or guarantee reachability) stands.
  - Risk: Cosmetic only. The vitest-coverage-coupling decision and its falsifiable test are unaffected.
  - Ref: .plan/TASK-014-tech-spec-sim-api.md §6 (vitest coverage coupling) — vs vitest.config.ts:16-17
- [LOW] callAction await-arm citations point at branch guards, not the await statements
  - Challenge: §4.1 cites callAction's three `await result` arms at :1745 (context), :1758 (inline-fn), :1764 (adaptee.get). Those lines are the if/else-if branch GUARDS; the actual `await result` statements are at :1753, :1760, :1770 (inside `return result instanceof Promise ? await result : result`).
  - Alternative: At IMPLEMENT (Step 5 inFlightAsyncCount wrap + the §4.1 structural single-chokepoint test), reference the await lines :1753/:1760/:1770 if the test asserts on await positions. The chokepoint claim itself (every function-valued callback funnels through callAction:1726's executeAction) is structurally verified and correct.
  - Risk: Sub-cosmetic. The single-chokepoint property — the load-bearing claim — is verified; only the per-arm sub-citation is imprecise. No contract impact.
  - Ref: .plan/TASK-014-tech-spec-sim-api.md §4.1 — vs state_machine.ts:1742-1772

### Verdict

**PROCEED**

Exhaustive line-by-line verification of every load-bearing file:line claim in the TECH_SPEC against the engine source at this commit. All CRITICAL/HIGH-stakes contracts are faithful and compile-plausible: (1) the public ./sim re-exports (Clock :150, ITimerScheduler :144, IMonitor :138, IErrorHandler :175, ILogger :181, StateMachineConfig :32, StateMachine :24, createVirtualScheduler :169, isAdapter :98, Adapter/StateMachineOptions :51-76) all verified present in src/index.ts; (2) the 7-member errorClass enum is complete and accurate for every engine throw site — queue-overflow (:234 sync reject ~:233), max-transition-depth (:303 msg, externals rejected :307-310, internal cleared :311), transition-timeout (:1790 base StateMachineError, no Date.now), invalid-event (:383, isEngineDoneEvent gate :367), injected-fault, contradictory-state (:1614/:1615), invalid-state-path (read :1220/:1221 guard :1219; write :1161/:1162 correctly listed-and-excluded); (3) the four await-sites are exhaustive — callAction chokepoint :1726, invoke :2170 (await BEFORE raiseEvent+scheduleProcessing :2172/:2173), resume :2504 (then await fireEvent :2506, internal->external asymmetry confirmed), Promise.race :1798/:1802; onError genuinely un-awaited at :2037 (ErrorHandler<T>=EventAction<T,void> types.ts:4) and invoke[].cond genuinely synchronous (types.ts:256, called directly :2153/:2497) — both correctly out of scope; the bracket-the-wrapped-action's-own-promise rule is verified sound against the Promise.race timeout-win semantics; (4) the corrupt-state contract is true — history-restore writes :1116/:1126 each return BEFORE :1204 (confirming the wrap-Adapter.set-not-intercept-:1204 correction), silent-dedup trap :1203 real, validateCompositeState (:1608-1621) operates purely on region-key collision and never calls getCurrentState/this.states.has() so the 'false leaf-registration precondition removed' correction is ITSELF correct and verified, restoreState :734 runs validateCompositeState on the raw string BEFORE setCurrentState :739; (5) ISS-043 honesty verified — tsconfig.json include=['src/**/*'] with no src/sim exclude (:20), check runs bare tsc --noEmit (:50), declarationDir at tsconfig.build.json:6, so the 'isolation NOT achievable by sibling tsconfig alone; branch B documented-coupling is default' verdict is HONEST; (6) perf premises verified — vitest toFake includes 'Date' (:13) but NOT hrtime/memoryUsage/queueMicrotask, security.ts:430/462 bake createdAt:Date.now(); (7) all TECH_SPEC-owned obligations (ISS-030/039/040/041/042/043) discharged with the rest correctly carried to IMPLEMENT. Only two off-by-one citation defects found (both LOW carry-forward): exactOptionalPropertyTypes is at tsconfig.json:12 not :11, and vitest coverage.include is at :17 not :16 — both underlying facts are correct, neither affects compile-plausibility or any contract. Per S3 matrix (zero CRITICAL/HIGH/MEDIUM): gate clears.
