/**
 * @module sim
 * @unstable
 *
 * Public `./sim` barrel. Every exported symbol is `@unstable`.
 *
 * This is the ONLY public `./sim` entry; it is never re-exported by
 * `src/index.ts`. Engine imports come ONLY via `../index` (ADR-7 c6). The full
 * frozen surface (SimEnv/wire/runSimulation/Simulator + cross-unit type
 * re-exports) is assembled here and frozen LAST in Step 10.
 *
 * Engine re-exports are SPLIT BY KIND (`export type` vs `export`) so
 * `verbatimModuleSyntax`/`isolatedModules` stay satisfied: type-only symbols use
 * `export type`, runtime values use `export`.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ISS-043 / TECH_SPEC §6 — sim tsconfig isolation DECISION: BRANCH B
 * (DOCUMENTED COUPLING — the recorded default; RR-2 accepted risk).
 *
 * The `@unstable ./sim` island shares the core `tsconfig.json` (`include:
 * ["src/**\/*"]`, no `src/sim` exclude). Consequences, accepted by design:
 *   1. EMISSION (feasible, no new config): `tsc -p tsconfig.build.json
 *      --emitDeclarationOnly` already emits `types/sim/index.d.ts` per-file, which
 *      `api-extractor.sim.json` reads for `api:check:sim` and the `./sim` exports
 *      `types` key. PROVEN: a clean `npm run build` produces `types/sim/index.d.ts`.
 *   2. TYPECHECK COUPLING (accepted risk): a `src/sim/**` type error blocks the
 *      core `npm run check`/`build`/`prepublishOnly`/tier-a, because `check` runs
 *      bare `tsc --noEmit` over the shared config. Branch A (separate
 *      `tsconfig.check.json`/`tsconfig.sim.json` excluding `src/sim/**\/*`) was NOT
 *      taken — the coupling is acceptable for a byte-frozen-core island whose own
 *      tests gate every sim change, and isolation adds four derived tsconfigs whose
 *      extends-chain `exclude`-replacement + sim-leg core-`.d.ts` re-emit footguns
 *      outweigh the benefit at v1. REFLECT records the sign-off.
 *
 * The falsifiable record of this choice is `src/tests/sim/tsconfig_isolation.test.ts`
 * (DoD#11): it asserts the emission half works AND that a sim type error reaches
 * the shared `tsc --noEmit` graph (i.e. isolation was deliberately NOT installed).
 * ──────────────────────────────────────────────────────────────────────────
 */

// --- engine VALUE re-exports (verified present in src/index.ts) ---
export { StateMachine, createVirtualScheduler, isAdapter } from '../index'

// --- engine TYPE re-exports (split by kind for verbatimModuleSyntax) ---
export type {
  Adapter,
  Clock,
  IErrorHandler,
  ILogger,
  IMonitor,
  ITimerScheduler,
  StateMachineConfig,
  StateMachineOptions,
} from '../index'

// --- Step-10 PUBLIC surface: wire / Simulator / runSimulation (VALUE symbols) ---
export { Simulator, runSimulation, wire } from './public'
export type {
  SimEnv,
  SimEventPayload,
  SimOptions,
  SimPayloadRng,
  SimPayloadSnapshot,
  SimResult,
  SimSetup,
  SimSnapshot,
  SimTarget,
  SimViolation,
  SimWarning,
  StepOutcome,
} from './public'

// --- Step-2 deterministic DI seams + Adapter-write capture seam (VALUE symbols) ---
export { NoopLogger } from './noop-logger'
export { SimErrorHandler } from './sim-error-handler'
export { SimMonitor } from './sim-monitor'
export { wrapAdapterForCapture } from './capture'
export type { CapturedWrite, CaptureSink } from './capture'

// --- Step-3 driver + settle primitive + harness env (VALUE symbols) ---
export { SimDriver } from './driver'
export type { DriverConfig, DriverOp, DriverStepResult } from './driver'
export { DEFAULT_MAX_TURNS, settleMacrostep } from './settle'
export type {
  SettleArgs,
  SettlePolicy,
  SettleReason,
  SettleResult,
  SettleScheduler,
  SettleTarget,
} from './settle'
export {
  bracketAsync,
  makeAsyncCounter,
  makeEnv,
  makeObservableScheduler,
} from './env'
export type {
  AsyncCounter,
  Env,
  ObservableSchedulerShim,
  SchedulerView,
  WrappableAction,
} from './env'

// --- Step-4 scenario generator (VALUE symbols) ---
// ⚠️ SECURITY — TRUSTED INPUT ONLY (W0 B4 / task #26, W7 U2 учёт/закалка):
// `toEngineConfig` and `runScenario` COMPILE each callback `source` string via
// `new Function` (define.ts `recreateLiteral`). `recreateLiteral` now runs a
// fail-fast RUNTIME GUARD (FUNCTION_LITERAL_PATTERN) that throws on an
// empty/non-string/non-function-shaped `source` before it ever reaches
// `new Function` — this is hygiene/fail-fast, NOT a sandbox: a crafted,
// syntactically-valid-looking malicious literal still compiles. Pass ONLY
// author-side trusted specs; NEVER a ScenarioSpec/TopologySpec reconstructed
// from untrusted JSON. Untrusted input belongs on the non-compiling
// `StateMachine.fromJSON`/`fromSecureJSON` path, which resolves callbacks BY
// NAME from a caller-supplied `FunctionRegistry` (`state_machine.ts`
// `deserializeAction`) and never reaches `recreateLiteral`/`new Function` — a
// contract fixed by `src/tests/sim/define_trusted_boundary.test.ts`
// (trusted `define` compiles; untrusted `fromJSON` does not).
export { genConfig } from './topology'
export type { GeneratedTopology } from './topology'
export { genOps } from './ops'
export type { GenOpsParams, OpDriverView } from './ops'
export {
  defineScenario,
  generateScenario,
  runScenario,
  toEngineConfig,
  makeOwner,
  pinTopology,
  pinOps,
  DEFAULT_BOUNDS,
  DEFAULT_GENOPS_PARAMS,
  SCENARIO_RUNTIME,
} from './define'
export type { GenOwner } from './define'
export type {
  ScenarioSpec,
  Op,
  Bounds,
  TopologySpec,
  StateSpec,
  EventSpec,
  TransitionSpec,
  InvokeSpec,
  LiteralCallback,
} from './scenario'

// --- Step-5 fault layer (VALUE symbols) ---
export {
  InjectedFault,
  classifyError,
  classifyCorruptState,
  makeFaultCursor,
  resolveFaultAt,
  ENGINE_MESSAGE_FIXTURES,
  I6_PROBE,
  I10_PROBE,
} from './faults'
export type {
  FaultPlan,
  FaultSpec,
  FaultSite,
  FaultRecord,
  FaultCursor,
  RejectionOrigin,
  CorruptStateProbe,
} from './faults'
export {
  applyQueueFaults,
  buildOverflowFlood,
  wrapThrowingCallback,
  captureRejection,
  fireBuffered,
  issueCorruptStateWrite,
  markStringMethodUncovered,
  isStringMethodCallback,
  applyThrowFaults,
} from './harness'
export type { SubmissionEntry, FireResult, UncoveredMarker } from './harness'
export {
  makeObservableSchedulerWithJitter,
  makeSiteKeyedJitter,
  timerSiteId,
} from './observable-scheduler'
export type {
  ObservableScheduler,
  ObservableSchedulerBundle,
  JitterRule,
  JitterFn,
} from './observable-scheduler'

// --- Step-6 invariant / liveness / fairness oracles (VALUE symbols) ---
export {
  INVARIANTS,
  buildConfigGraph,
  finalStateOf,
  makeViolation,
} from './invariants'
export type {
  CheckerContext,
  ConfigGraph,
  FinalState,
  Invariant,
  InvariantScope,
  // W8/V3a: the lifecycle observation a custom invariant reads from
  // `CheckerContext.lifecycle` (I-4 keys its ordering predicate on it).
  LifecycleObservation,
  Violation,
} from './invariants'
export { runSafety, runSafetyWithDeterminism } from './invariants.runner'
export {
  analyzeLiveness,
  classifyQuiescence,
  fingerprintOf,
  fingerprintsEqual,
} from './liveness'
export type {
  LivenessParams,
  LivenessResult,
  LivenessSample,
  LivenessVerdict,
  ProgressFingerprint,
  Quiescence,
} from './liveness'
export {
  PERTURB_ONLY_FAULTS,
  PROGRESS_BLOCKING_FAULTS,
  isProgressBlocking,
  makeFaultSchedule,
  suppressesStuck,
} from './fairness'
export type { FaultSchedule } from './fairness'

// --- Step-7 shrinker + repro codegen (VALUE symbols) ---
export {
  shrink,
  defaultShrinkRunner,
  fingerprintEquals,
  shrinkCacheKey,
  rekeyFaultPlan,
  configHasNoErrors,
  DEFAULT_SHRINK_BUDGET,
} from './shrinker'
export type {
  ShrinkRunner,
  ShrinkRunResult,
  ShrinkBudget,
  ShrinkResult,
  ViolationFingerprint,
} from './shrinker'
// --- W9/Г3 op-stream delta-debugging (the live-config minimizer) ---
export { shrinkOps, DEFAULT_OP_SHRINK_BUDGET } from './op-shrink'
export type { ShrinkableOp, OpShrinkPredicate, OpShrinkBudget, OpShrinkResult } from './op-shrink'
export {
  buildMinimalRepro,
  emitReproTest,
  emitRepro,
  MINIMAL_REPRO_SCHEMA_VERSION,
  PUBLIC_PACKAGE,
  PUBLIC_SIM_ENTRY,
} from './repro-codegen'
export type { MinimalRepro } from './repro-codegen'

// --- Step-8 perf/load metrics plane (VALUE symbols) ---
export {
  PerfBaselineValidationError,
  PerfHarness,
  PERF_REGRESSION_CONFIG,
  evaluatePerfBands,
  isGcExposed,
  latencyStatsOf,
  loadPerfBaseline,
  maybeWriteBaseline,
  medianSample,
  runPerf,
  toBaselineFile,
  validatePerfBaseline,
} from './metrics'
export type {
  BandResult,
  LatencyResolution,
  LatencyStats,
  PerfBaselineFile,
  PerfReport,
  PerfSample,
  RunPerfOptions,
} from './metrics'
export { PERF_BASELINE_PATH, PERF_SEEDS, perfMain } from './perf-run'

// --- Step-9 coverage gate + capability registry (VALUE symbols) ---
export { CAPABILITIES, DOCUMENTED_GAP_IDS, capabilityKeys } from './capabilities'
export type { Capability, CapabilityId, CapabilityProbe } from './capabilities'
export {
  COVERAGE_RUNTIME,
  CoverageDeterminismError,
  computeCoverage,
  coverageMain,
  formatCoverageReport,
} from './coverage'
export type { CoverageResult, CoverageScenario } from './coverage'
export {
  COVERAGE_SCENARIOS,
  coreEventsScenario,
  errorsFaultsScenario,
  hierarchyRegionsScenario,
  condSkipScenario,
  historyTimersScenario,
  persistenceScenario,
  overflowScenario,
  transitionTimeoutScenario,
} from './scenarios/index'

// --- Step-1 determinism substrate (VALUE symbols) ---
export {
  makePrng,
  SimError,
  SPLITMIX64_INCREMENT,
  SPLITMIX64_MUL_1,
  SPLITMIX64_MUL_2,
  MASK64,
  FNV64_OFFSET,
  FNV64_PRIME,
} from './prng'
export type { Prng } from './prng'

export { makeSimClock } from './clock'
export type { SimClock } from './clock'

export { hashTrace, normalizeParts, configHash, PRNG_VERSION } from './trace'
export type {
  TraceFrame,
  CanonicalHeader,
  CanonicalTrace,
  SimTrace,
  TraceCause,
  TraceSynthetic,
  FireOutcome,
  ErrorClass,
  FaultKind,
} from './trace'

// --- checkMachine: the consumer-facing dynamic config check (W6 / #17) ---
export { checkMachine } from './check-machine'
export type {
  CheckReport,
  CheckOptions,
  CheckViolation,
  CheckWarning,
  CheckScriptOp,
  CheckMinimalOp,
  CheckMinimalRepro,
  CheckEventSpec,
  MachineInvariant,
  MachineSnapshot,
  OwnerSource,
  FailCause,
  WarningKind,
  Rng as CheckRng,
} from './check-machine'
