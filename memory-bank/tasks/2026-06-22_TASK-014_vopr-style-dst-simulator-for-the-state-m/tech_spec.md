# TASK-014 — TECH_SPEC: `@vedmalex/statemachine/sim` contract freeze

## Preamble

> T4:standard · phase TECH_SPEC. Full frozen spec: `artifacts/tech-spec-sim-api.md` (832 lines, 7 units, all source-verified). Architecture: `artifacts/creative-dst-architecture.md`. Build plan: `artifacts/build-plan.md`.

The TypeScript signatures frozen here become the IMPLEMENT contract. Cross-consistency = FIXED (one ISS-043 cross-unit conflict reconciled; all CRIT/HIGH source-verification gaps folded; line citations corrected against the real engine).

## UR coverage (canonical traceability)

- **UR-001 / UR-002** (VOPR-style DST, real engine, seed→bit-exact replay, faults, Safety+Liveness, shrinker, CI): frozen contracts §3.1 Prng, §3.2 TraceFrame/CanonicalTrace/hashTrace, §3.3 7-member ErrorClass enum, §3.4 Invariant/Liveness, §3.5 7-kind FaultKind + corrupt-state probe + ObservableScheduler, §4 inFlightAsyncCount await-site contract. AC-1 replay canary substrate frozen.
- **UR-003** (load/stress + deterministic debug; consumer-constructible): §1 public `runSimulation`/`wire(env,config,owner)`/`Simulator.step():Promise<StepOutcome>` (ISS-040 seed→step-trace debug surface), §7 PerfSample/PerfReport metrics plane.
- **UR-004** (cover ALL + mandatory gate + declarative): §3.7 closed-union CapabilityId(39 literals) + total Record + errorClass-keyed CapabilityProbe + computeCoverage + DOCUMENTED_GAP_IDS; §3.4 declarative Invariant registry.
- **UR-005** (internal + public `./sim`, API/bundle/ABI stability, perf thresholds, coverage gate, full v1 faults): §1 `@unstable ./sim` surface; §6 tsconfig decision (core `.` byte-frozen; `./sim` separate); §7 perf bands + non-zero p99; §8 wiring diff (exports/tsup/api-extractor.sim.json/knip/dist byte guard); §3.5 full 7-kind fault set.

## Frozen contracts (see §1–§3 of the full spec)

Public: SimEnv(5 seams + logger + random/now), SimSetup/SimTarget/SimOptions, StepOutcome, SimResult/SimSnapshot/MinimalRepro, wire()/runSimulation()/Simulator. Internal: Prng+makePrng(bigint|string)+frozen splitmix64/FNV64 constants; TraceCause/TraceSynthetic/FireOutcome/TraceFrame/CanonicalHeader/CanonicalTrace+hashTrace/normalizeParts/configHash; ErrorClass(7); Invariant/Violation/CheckerContext/runSafety; Quiescence(5-kind)/LivenessVerdict/ProgressFingerprint; FaultKind(7)/FaultSite/FaultPlan/FaultRecord/InjectedFault/CorruptStateProbe/ObservableScheduler; Op/Bounds/ScenarioSpec+defineScenario/runScenario; CapabilityId(39)/CapabilityProbe/Capability/CAPABILITIES/DOCUMENTED_GAP_IDS/computeCoverage; Env.inFlightAsyncCount+bracketAsync; PerfSample/PerfReport/PERF_REGRESSION_CONFIG/PerfBaselineFile/loadPerfBaseline/evaluatePerfBands.

## TECH_SPEC-owned obligations discharged (§9 of full spec)

- **ISS-030**: frozen 4-site awaited-consumer-callback set (callAction:1726 chokepoint; invoke:2170; resume:2504; transitionTimeout Promise.race:1798/:1802); single-chokepoint structural test.
- **ISS-039**: bracketAsync wraps the WRAPPED action's own promise (finally), never callAction's outer race-able return; two-layer falsifiable string-method containment DoD. `invoke[].cond` (sync, types.ts:256) + `onError` (un-awaited :2037, void) verified OUT of scope.
- **ISS-040**: Simulator.step()/StepOutcome.frames/traceHash + SimResult.trace = UR-003 debug surface.
- **ISS-041**: I-6 primary = restoreState validateCompositeState :734 (throw :1614/msg :1615); I-10 primary = getCurrentState :1219 (throw :1220/:1221). :2309/:2353 demoted verify-at-IMPLEMENT (parseCompositeState pre-dedups). False :734 leaf-registration precondition REMOVED.
- **ISS-042**: bands throughput 20%/mem 25%/p99 30%, median-of-N=5, traceLen zero-tolerance, p99Epsilon=1e-9; two-sided loadPerfBaseline throw closes the silent-N/A escape hatch; latencyGated derived from the real-timer measurement leg.
- **ISS-043**: `.d.ts` emission FEASIBLE with zero new config; typecheck isolation NOT achievable by sibling tsconfig alone (base include src/**/* couples — empirically proven). Two-branch IMPLEMENT decision: branch B (documented shared-tsconfig coupling) = recorded default; branch A (isolation via tsconfig.check/sim/sim.build) gated by a falsifiable DoD#11 isolation test + REFLECT sign-off.
- Bonus: vitest coverage.include couples src/sim into the 90% gate — frozen decision to exclude src/sim/** (sim:coverage CLI owns it).

## Open-for-IMPLEMENT (§10 of full spec)

§6 branch A-vs-B decision + tsconfig shapes; concrete `_internal` module paths; per-Invariant checker bodies + splitmix64/fnv64/rotl64 bodies + ConfigGraph walk; measured perf/dist baseline VALUES (node-20 runner, REFLECT-recorded); behavioral-sentinel-probe timer kind in wire(); npm pack --dry-run tarball check; per-callbackKind throw-observable test.

## Carry-forward issue trail

CREATIVE: ISS-029..033. PLAN: ISS-039..043. All resolved-here or carried to IMPLEMENT/REFLECT per §9.

## UR Coverage

- UR-001..UR-005 — covered by the frozen ./sim contracts (§1–§9).
- UR-006 — release scope (version bump, docs, full commit, gh publish); not a signature-freeze item; executed in the ARCHIVE/release phase with user confirmation before the irreversible publish.
