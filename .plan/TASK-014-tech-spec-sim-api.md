# TASK-014 TECH_SPEC — `@vedmalex/statemachine/sim` API + Internal Contract Freeze

**Status:** TECH_SPEC (pending TECH_SPEC-exit DA gate via `mb3-critic`).
**Package:** `@vedmalex/statemachine` 1.0.0-beta.3 — additive `./sim` island under `src/sim/**`. Core engine (`.` export) is **NOT modified**; every signature below is wired through the existing public surface (`../index`) only (ADR-7 c6).
**Scope contract:** Every TypeScript signature and every payload/site/config contract **frozen here is the IMPLEMENT contract**. Steps 1–11 of the build plan implement to these exact shapes; a deviation requires re-opening TECH_SPEC. Values that are *measurements* (perf medians, dist hashes, baseline numbers) are explicitly carried to IMPLEMENT and are NOT frozen here.

Inputs of record: ADR-1..ADR-8 (`.plan/TASK-014-creative-dst-architecture.md`), build plan (`.plan/TASK-014-build-plan.md`), design plan (`.plan/TASK-014-dst-simulation-plan.md`). All `file:line` citations below were re-verified against `packages/statemachine/src/**` at this commit; corrections to the source units are flagged inline as **[CORRECTED]**.

---

## 1. Frozen public `./sim` surface (compile-ready, `@unstable`)

`src/sim/index.ts` is the **only** public `./sim` entry. It is never re-exported by `src/index.ts` (verified: `src/index.ts` has no `./sim` import). Engine symbols are re-exported **split by kind** (`export type` vs `export`) so `verbatimModuleSyntax` stays satisfied; cross-unit sim types are owned by the internal-contract units in §3 and only *listed* here.

```ts
// ============================================================================
// src/sim/index.ts — public ./sim barrel. Every exported symbol is @unstable.
// Engine imports come ONLY via ../index (ADR-7 c6).
// ============================================================================

// --- engine TYPE re-exports (verified present in src/index.ts) ---
export type {
  Clock,                 // src/index.ts:150  (from './scheduler')
  ITimerScheduler,       // src/index.ts:144  (from './types')
  IMonitor,              // src/index.ts:138  (from './types')
  IErrorHandler,         // src/index.ts:175  (from './types')
  ILogger,               // src/index.ts:181  (from './types')
  StateMachineConfig,    // src/index.ts:32   (from './types', @stable)
  Adapter,               // src/index.ts (the :51-76 type-export block)
  StateMachineOptions,   // src/index.ts (the :51-76 type-export block)
} from '../index'

// --- engine VALUE re-exports (verified present in src/index.ts) ---
export {
  StateMachine,            // src/index.ts:24
  createVirtualScheduler,  // src/index.ts:169
  isAdapter,               // src/index.ts:98
} from '../index'

// --- cross-unit sim symbols (FROZEN in §3; re-exported, not re-frozen here) ---
export type {
  TraceFrame, CanonicalTrace, CanonicalHeader, TraceCause, TraceSynthetic, FireOutcome,
  ErrorClass,
  Violation, Invariant, InvariantScope, CheckerContext, FinalState, ConfigGraph,
  Quiescence, LivenessVerdict, LivenessResult, ProgressFingerprint,
  FaultKind, FaultPlan, FaultSpec, FaultSite, FaultRecord, CorruptStateProbe,
  ScenarioSpec, Op, Bounds,
  CapabilityId, Capability, CapabilityProbe,
  Prng, SimClock, PerfSample, PerfReport,
} from './_internal'   // resolves at IMPLEMENT to the concrete Step-1/4/5/6/8/9 modules
export {
  makePrng, makeSimClock, hashTrace, normalizeParts,
  PRNG_VERSION, CAPABILITIES, DOCUMENTED_GAP_IDS,
} from './_internal'

// ============================================================================
// SimEnv — the FIVE deterministic seams + random/now. logger is FIRST-CLASS and
// NON-OPTIONAL (R18 / ADR-7 c8 — design §4.8 omitted it; CORRECTED here). All
// five map 1:1 to StateMachineOptions DI slots the harness forwards.
// ============================================================================
/** @unstable */
export interface SimEnv {
  readonly clock: Clock                 // -> StateMachineOptions.clock        (types.ts:128)
  readonly scheduler: ITimerScheduler   // -> StateMachineOptions.scheduler    (types.ts:120) — REQUIRED
  readonly monitor: IMonitor            // -> StateMachineOptions.monitor      (types.ts:119) — SimMonitor
  readonly errorHandler: IErrorHandler  // -> StateMachineOptions.errorHandler (types.ts:121) — SimErrorHandler, isEnabled()===true
  readonly logger: ILogger              // -> StateMachineOptions.logger       (types.ts:118) — NoopLogger; NON-OPTIONAL
  random(): number                      // PRNG-backed [0,1); never Math.random
  now(): number                         // === clock(); never Date.now()
}

// ============================================================================
// SimTarget / SimSetup — consumer-supplied machine descriptor.
// {config,owner} is the SANCTIONED wire() path; {machine} is best-effort,
// validated by the behavioral sentinel probe in Simulator.init().
// ============================================================================
/** @unstable */
export type SimTarget<T extends object = object> =
  | { readonly config: StateMachineConfig<T>; readonly owner: T | Adapter<T> }   // -> wire(env, config, owner)
  | { readonly machine: StateMachine<T, StateMachineConfig<T>> }                 // best-effort

/** @unstable */
export type SimSetup<T extends object = object> =
  (env: SimEnv) => SimTarget<T> | Promise<SimTarget<T>>

// ============================================================================
// SimOptions — seed is bigint|string (ADR-2 #4; bigint not JSON-able => string
// wire form). Optional fields use bare `?` (NO `| undefined`) under
// exactOptionalPropertyTypes:true (tsconfig.json:11). [CORRECTED: the option flag
// is on tsconfig.json line 11, not :13.]
// ============================================================================
/** @unstable */
export interface SimOptions {
  readonly seed: bigint | string
  readonly steps?: number
  readonly faults?: FaultPlan
  readonly invariants?: readonly Invariant[]
  readonly mode?: 'safety' | 'liveness'
  readonly onTrace?: (frame: TraceFrame) => void
}

// ============================================================================
// StepOutcome — ISS-040 discharge: the per-step deterministic inspectable trace
// surface for the UR-003 seed->debug workflow. `frames` are the content-only,
// '|'-normalized per-transition frames captured DURING this macrostep drain plus
// the single settle-boundary frame recorded AFTER it (ADR-4 capture ordering).
// NO wall-clock/duration/heap field (ADR-1 exclusion).
// ============================================================================
/** @unstable */
export interface StepOutcome {
  readonly step: number                        // monotonic macrostep index (matches TraceFrame.step)
  readonly t: number                           // logical virtual time = env.clock(); never Date.now()
  readonly frames: readonly TraceFrame[]        // content-only, '|'-normalized
  readonly traceHash: string                   // running ADR-1 hashTrace up to and incl. this step
  readonly quiescent: boolean                  // settleMacrostep reached the quiescence predicate
  readonly done: boolean                       // all declared composites done (captured doneDelta projection)
  readonly violation?: Violation                // lowest-step violation so far (safety mode); absent if none
}

// ============================================================================
// SimResult — design §4.8 + non-optional metrics. seed is canonical string form.
// ============================================================================
/** @unstable */
export interface SimResult {
  readonly ok: boolean
  readonly seed: string
  readonly steps: number
  readonly traceHash: string
  readonly trace: readonly TraceFrame[]
  readonly violation?: Violation
  readonly metrics: PerfSample
}

// ============================================================================
// SimSnapshot — serializable mid-run checkpoint. Engine state via StateMachine
// .toJSON() (NOT toSecureJSON), the PRNG state(), and the logical clock.
// CAVEAT (see §3.2 note): toJSON bytes are NOT a determinism contract for
// inline-function configs (createdAt:Date.now() at security.ts:462); only the
// engine-state CONTENT round-trips. SimSnapshot is a checkpoint, never hashed.
// ============================================================================
/** @unstable */
export interface SimSnapshot {
  readonly seed: string
  readonly machine: string      // StateMachine.toJSON() output (state_machine.ts:~2527)
  readonly prngState: string    // PRNG post-increment 64-bit counter, serialized (ADR-2 #5)
  readonly t: number            // logical virtual time (SimClock.now())
  readonly step: number
}

// ============================================================================
// MinimalRepro — UR-003 deliverable (design §4.8 line 345 + build-plan Step 7).
// seed/wallNs-free; witness '|'-normalized; errorClass from the FROZEN enum only.
// ============================================================================
/** @unstable */
export interface MinimalRepro {
  readonly schemaVersion: number
  readonly packageVersion: string
  readonly seed: string
  readonly scenario: ScenarioSpec
  readonly violation: {
    readonly invariantId: string
    readonly witness: string        // '|'-normalized
    readonly errorClass?: ErrorClass
    readonly step: number
  }
  readonly replay: {
    readonly traceHash: string
    readonly finalState: string     // '|'-normalized
    readonly finalQueueDepth: number
  }
  readonly provenance: {
    readonly shrinkMoves: number
    readonly runs: number
    readonly minimal: boolean       // false => budget-bounded non-convergence
  }
}

// ============================================================================
// wire() — THE SANCTIONED DI-FIRST PATH (ADR-7 D2/D3, R17). wire() constructs
// `new StateMachine(config, owner, {clock,scheduler,monitor,errorHandler,logger})`
// with all FIVE seams pre-forwarded, so the scheduler-omission footgun
// (schedulerProvided = scheduler!==undefined, state_machine.ts:154 -> real
// createDefaultScheduler() :155) is STRUCTURALLY impossible. `owner` is wrapped
// by the Step-2 Adapter.set capture seam before construction; the wrapped Adapter
// is ALWAYS passed as the EXPLICIT 2nd positional arg to fireEvent (ADR-7 c13),
// never via the unshift path (state_machine.ts:469-471).
// ============================================================================
/** @unstable */
export function wire<T extends object>(
  env: SimEnv,
  config: StateMachineConfig<T>,
  owner: T | Adapter<T>,
): StateMachine<T, StateMachineConfig<T>>

/** @unstable — one-shot convenience over Simulator (design §4.8). */
export function runSimulation<T extends object>(
  setup: SimSetup<T>,
  opts: SimOptions,
): Promise<SimResult>

// ============================================================================
// Simulator — the inspectable driver. init() runs the MANDATORY post-construction
// settleMacrostep + behavioral sentinel scheduler probe (ADR-4 c7, ADR-7 D3).
// step() advances exactly ONE macrostep and returns its StepOutcome (ISS-040).
// step()/run()/init() delegate to the SINGLE settleMacrostep; no flush(N).
// ============================================================================
/** @unstable */
export declare class Simulator<T extends object = object> {
  constructor(setup: SimSetup<T>, opts: SimOptions)
  init(): Promise<void>
  step(): Promise<StepOutcome>
  run(): Promise<SimResult>
  snapshot(): SimSnapshot
  readonly env: SimEnv
}
```

Governance: `etc/statemachine-sim.api.md` (api-extractor) is the field-shape guard; `src/tests/public_sim_surface.test.ts` asserts symbol **presence** (mirrors `src/tests/public_surface.test.ts`, NOT md5). Field-shape drift of re-exported cross-unit types (e.g. `PerfSample`) is caught only by `etc/statemachine-sim.api.md`, so `api:check:sim` MUST run in CI.

---

## 2. Verified engine-surface facts the public surface depends on

| Claim | Verified site |
|---|---|
| `StateMachine` constructor `(config, adaptee?, options?)` | `state_machine.ts:143-147` |
| Five DI seams are real `StateMachineOptions` slots with wall-clock/real-time fallbacks | `types.ts:117-133` (`logger?/monitor?/scheduler?/errorHandler?/clock?/transitionTimeout?`); fallbacks `state_machine.ts:152-157` |
| Scheduler-omission footgun: `schedulerProvided = options?.scheduler !== undefined` | `state_machine.ts:154`; fallback `createDefaultScheduler()` `:155`; real-time timer routing keys off `schedulerProvided` at `:2194/:2199` |
| `scheduler`/`schedulerProvided` are PRIVATE; no getter — object-identity assertion infeasible, behavioral probe required | `state_machine.ts` private fields (no `getScheduler`/`getOptions`) |
| `Adapter` has exactly one `set(property,value)`; `isAdapter` = `'set' in inp && 'get' in inp` | `types.ts:293-297`, `:301-303` |
| `fireEvent` overload; non-Adapter 2nd arg is unshifted into `args` (fallback to `this.adaptee`) | `state_machine.ts:453-481` (unshift `:469-471`, explicit-Adapter `:476-478`) |
| `toJSON` (state) vs `toSecureJSON` (createdAt-bearing) | `toJSON` `state_machine.ts:~2527`; `toSecureJSON` `~2562`; createdAt fold `security.ts:430/462` |
| `exactOptionalPropertyTypes:true` | **`tsconfig.json:11`** [CORRECTED from :13] |
| `isInState` normalizes via `split('|').sort()` | `state_machine.ts:639` |

---

## 3. Frozen internal contracts (`src/sim/**`)

### 3.1 PRNG — `src/sim/prng.ts` (ADR-2)

Engine has NO PRNG and NO bigint; `security.ts:382-385` is a **32-bit** FNV-1a (offset `0x811c9dc5`, prime `0x01000193`) — DISTINCT from the sim's 64-bit FNV; no constant collision.

```ts
export interface Prng {
  readonly seed: bigint
  nextU32(): number
  nextFloat(): number                                       // [0,1)
  int(maxExclusive: number): number                          // rejection-free 64-bit Lemire; 1 draw/call; throws n<=0
  pick<T>(xs: readonly T[]): T                               // throws on empty
  weighted<T>(xs: readonly (readonly [T, number])[]): T      // throws empty/zero-total
  bool(p?: number): boolean
  fork(label: string): Prng                                  // FROZEN combine; MUST NOT advance parent/sibling
  state(): bigint                                            // post-increment 64-bit counter; round-trips via makePrng(state())
}
export function makePrng(seed: bigint | string): Prng
export function makePrng(seed: number): Prng                 // VALIDATED [0,2^53) convenience; SimError on NaN/Inf/non-int/|seed|>=2^53/neg

export const SPLITMIX64_INCREMENT = 0x9E3779B97F4A7C15n
export const SPLITMIX64_MUL_1     = 0xBF58476D1CE4E5B9n
export const SPLITMIX64_MUL_2     = 0x94D049BB133111EBn
export const MASK64               = (1n << 64n) - 1n
export const FNV64_OFFSET = 0xcbf29ce484222325n             // 64-bit (DISTINCT from security.ts:382 32-bit)
export const FNV64_PRIME  = 0x100000001b3n
// FROZEN fork combine: childSeed = splitmix64_mix((parent.state() ^ rotl64(fnv64(label),17n)) & MASK64)
// Golden(seed=0): [0xe220a8397b1dcdaf,0x6e789e6aa1b965f4,0x06c45d188009454f,0xf88bb8a8724c81ec,0x1b39896a51a8749b]
// Golden: fnv64('topology') = 0x516188458c0dece4
```
`splitmix64_mix`/`fnv64`/`rotl64` byte-level bodies: IMPLEMENT (pinned by constants + golden vectors). Bigint serialized as **string** everywhere (seed, wallNs, prngState) — bigint is not JSON-able (target ES2022 + tsup node18).

### 3.2 Trace — `src/sim/trace.ts` (ADR-1)

```ts
export type TraceCause     = 'init' | 'external' | 'timer' | 'internal'      // CLOSED engine-causal
export type TraceSynthetic = 'errorState-fallback' | 'corrupt-state' | 'post-restore'  // CLOSED, ORTHOGONAL to cause
export type FireOutcome    = 'resolve-true' | 'resolve-false' | 'reject'

export interface TraceFrame {
  readonly step: number
  readonly t: number                       // LOGICAL virtual time = SimClock.now(); NEVER Date.now()
  readonly cause: TraceCause
  readonly synthetic?: TraceSynthetic
  readonly event?: string                  // 'done.state.<C>' / '*' distinguishable (isEngineDoneEvent state_machine.ts:367)
  readonly from: string                    // normalized split('|').sort().join('|')
  readonly to: string                      // normalized
  readonly queue: { readonly internal: number; readonly external: number }  // NO synthesized `total`
  readonly quiescent: boolean
  readonly errorClass?: ErrorClass         // FROZEN enum ONLY; never error.message / toJSON()
  readonly faultApplied?: FaultKind        // channel-fault tag (NOT 'corrupt-state')
  readonly fireOutcome?: FireOutcome
  readonly doneDelta?: ReadonlyArray<{ readonly composite: string; readonly done: boolean }>
  // doneDelta = captured isDone(C)-per-composite at the settle boundary, stored as DERIVED frame data.
  // Probes read THIS, never a live sm.isDone() (which requires a compositeId — state_machine.ts:1433).
}

export interface CanonicalHeader {
  readonly seed: string                    // serialized bigint
  readonly configHash: string              // structural walk folding Function.prototype.toString(); NEVER JSON.stringify/toJSON/toSecureJSON
  readonly engine: string
  readonly version: string                 // trace-schema version (bump on closed-union/hashed-field change)
  readonly runtime: string                 // pins microtask-FIFO + Date-fake scope
  readonly prngVersion: 'splitmix64-bigint-v1'
  readonly errorHandlerEnabled: true       // ADR-3(D): isEnabled()===true pinned (gate state_machine.ts:424)
}

export interface CanonicalTrace { readonly header: CanonicalHeader; readonly frames: readonly TraceFrame[] }
export type SimTrace = CanonicalTrace
export const PRNG_VERSION = 'splitmix64-bigint-v1' as const

export function hashTrace(trace: CanonicalTrace): string    // key-sorted; structurally cannot reference an excluded field
export function normalizeParts(s: string): string           // s.split('|').sort().join('|') (matches state_machine.ts:639 sort)
export function configHash(config: unknown): string         // structural walk folding toString(); no JSON.stringify/toJSON
```

**Note (SimSnapshot determinism, folds Unit-1 MED + Unit-5 IMPRECISE):** `toJSON`'s inline-function serializer stamps `createdAt: Date.now()` (`security.ts:462` via `state_machine.ts:~2758`), so `SimSnapshot.machine` bytes are non-deterministic for inline-function configs. This is acceptable because toJSON/toSecureJSON bytes are NEVER hashed (ADR-1) — `SimSnapshot` is a checkpoint, not a hashed frame. Snapshot byte-equality is NOT a determinism contract; only engine-state CONTENT (currentState/history/stateEntryTimes) round-trips. If byte-equality is ever needed, the harness must strip `createdAt`.

### 3.3 FROZEN `errorClass` enum — `src/sim/trace.ts`

Derived by enumerating EVERY engine throw/reject site; computed ONCE at the harness try/catch boundary by **field-selection**, NEVER from `error.message`.

```ts
export type ErrorClass =
  | 'queue-overflow'        // 'Event queue overflow…' state_machine.ts:234 (sync reject at enqueue ~:233)
  | 'max-transition-depth'  // 'Max transition depth exceeded…' :303 (rejects pending externals :307-310, clears internal :311)
  | 'transition-timeout'    // base StateMachineError 'Transition timeout' :1790 (NO Date.now; Promise.race :1798/:1802)
  | 'invalid-event'         // 'Invalid event: …' :383 (isEngineDoneEvent gate :367 prevents wildcard fall-through)
  | 'injected-fault'        // class InjectedFault extends Error (harness; callAction catch ~:1774)
  | 'contradictory-state'   // validateCompositeState throw :1614 / msg :1615 — I-6 witness
  | 'invalid-state-path'    // unregistered-leaf throw — I-10 witness (read-path getCurrentState throw :1220 / msg :1221;
                            //   write-path setCurrentStateInternal throw :1161 / msg :1162 — see §5)
```
[CORRECTED across units: contradictory throw is `:1614` (msg `:1615`); invalid-state-path read-path throw is `:1220` (msg `:1221`, guard `:1219`).] The `'corrupt-state' family` = `{ 'contradictory-state', 'invalid-state-path' }`. The write-path `:1161` Invalid-state-path throw (DISTINCT message from the `:1221` read-path) folds into `'invalid-state-path'` by field-selection; it is unreachable via the harness `Adapter.set` seam (private method) — explicitly listed-and-excluded in §5. Engine message strings are kept ONLY as drift fixtures.

### 3.4 Safety / Liveness — `invariants.ts` + `liveness.ts` (ADR-6)

```ts
export type InvariantScope = 'step' | 'final' | 'both'

export interface FinalState {
  readonly config: string                  // normalized
  readonly queue: { readonly internal: number; readonly external: number }
  readonly quiescent: boolean
}

export interface ConfigGraph {             // computed ONCE; getRegionKey REPLICATED (engine's is PRIVATE)
  getRegionKey(statePart: string): string
  depthOf(statePart: string): number
  isRegisteredLeaf(statePart: string): boolean
  readonly states: ReadonlySet<string>
  readonly composites: ReadonlySet<string>
  readonly declaredDoneEvents: ReadonlySet<string>   // 'done.state.<C>' the config declares
}

export interface CheckerContext { readonly graph: ConfigGraph; readonly header: CanonicalHeader }

export interface Violation {
  readonly invariantId: string
  readonly step: number
  readonly witness: string                 // normalized
  readonly errorClass?: ErrorClass
  readonly message: string                 // human-readable; NOT hashed; NOT the fingerprint
  readonly observed: string
  readonly expected: string
  readonly fingerprint: {                   // shrinker target — the ONLY equality key the predicate uses
    readonly invariantId: string
    readonly witness: string
    readonly errorClass?: ErrorClass
  }
}

export interface Invariant {               // runner iterates a readonly Invariant[] BLIND (never references an id literally)
  readonly id: string
  readonly scope: InvariantScope
  readonly capabilityTags?: readonly string[]
  checkStep?(frame: TraceFrame, ctx: CheckerContext): Violation | null
  checkFinal?(state: FinalState, ctx: CheckerContext): Violation | null
}

export function runSafety(invariants: readonly Invariant[], trace: CanonicalTrace, ctx: CheckerContext): Violation | null
// AT MOST ONE violation: lowest-step checkStep, else first checkFinal; I-1 short-circuits (first-violation-wins).

export type Quiescence =
  | 'TERMINAL_FINAL' | 'QUIESCENT_NO_WORK' | 'WAITING_ON_TIMER'
  | 'WAITING_ON_TRANSITION_TIMEOUT' | 'ACTIVE'                 // 5-kind (R12 adds WAITING_ON_TRANSITION_TIMEOUT)
export type LivenessVerdict = 'PROGRESSED' | 'STUCK' | 'TIMEOUT_BUDGET_EXCEEDED'
export interface ProgressFingerprint {
  readonly config: string                   // normalized
  readonly queueDepth: number
  readonly pendingTimers: number
  readonly earliestTimerAt: number | null
}
export interface LivenessResult {
  readonly verdict: LivenessVerdict
  readonly quiescence: Quiescence
  readonly witness?: string
  readonly reason?: string
}
```
Verified: `recordTransition(transitionTime,true)` hardcoded, no context (`state_machine.ts:2059-2060`) — IMonitor cannot be a determinism signal; `getRegionKey` is PRIVATE; `isDone(compositeId,adaptee?)` PUBLIC and REQUIRES a compositeId (`:1433`); enter/exit total-order sort with index tiebreak (`:1596-1603`).

### 3.5 Faults — `faults.ts` + `harness.ts` + `observable-scheduler.ts` (ADR-5)

```ts
export type FaultKind =                     // EXACTLY seven channel literals. 'corrupt-state' is NOT a member.
  | 'reorder' | 'drop' | 'dup'              // event-queue (EXTERNAL submission buffer only)
  | 'overflow'                              // event-queue backpressure (flood to maxQueueDepth+1; sync reject :234)
  | 'clock-skew' | 'timer-jitter'           // scheduler
  | 'throw'                                 // callback (function-valued, via callAction :1726)

export interface FaultSite {
  readonly seam: 'event-queue' | 'scheduler' | 'callback'
  readonly stateName?: string
  readonly invokeIndex?: number
  readonly armEpoch?: number                // derives ONLY from logical clock/stateEntryTimes (never wall-clock)
  readonly callbackKind?:                   // function-valued callbacks dispatched through callAction
    | 'guard' | 'onTransition'
    | 'state.onBeforeEnter' | 'state.onEnter' | 'state.onAfterEnter'
    | 'state.onBeforeExit'  | 'state.onExit'  | 'state.onAfterExit'
    | 'event.onBefore' | 'event.onAfter' | 'event.onSuccess'
    | 'invoke.action'
  readonly opId?: string
}

export interface FaultPlan {
  readonly faults: readonly FaultSpec[]
  readonly transitionTimeoutMs?: number     // wire-time options.transitionTimeout (types.ts:133), NOT per-state
  readonly reorderWindow?: number
}

export type FaultSpec =
  | { readonly kind: 'reorder' | 'drop' | 'dup'; readonly site: FaultSite; readonly opId: string }
  | { readonly kind: 'overflow'; readonly site: FaultSite; readonly opId: string; readonly floodCount: number }
  | { readonly kind: 'clock-skew'; readonly site: FaultSite; readonly deltaMs: number }     // forward-only
  | { readonly kind: 'timer-jitter'; readonly site: FaultSite; readonly jitterMs: number }   // site-keyed fork('jitter:'+id)
  | { readonly kind: 'throw'; readonly site: FaultSite }

export interface FaultRecord {              // regenerates identically on replay (AC-2)
  readonly faultStep: number
  readonly kind: FaultKind | 'corrupt-state'   // kind union INCLUDES the probe; the channel union does NOT
  readonly site: FaultSite
  readonly opId?: string
}

export class InjectedFault extends Error {} // PLAIN Error — never StateMachineError/EnhancedStateMachineError (bake Date.now())

export interface CorruptStateProbe {        // SEPARATE 8th harness-only probe (NOT in FaultKind) — see §5
  readonly kind: 'corrupt-state'
  readonly invariant: 'I-6' | 'I-10'
  readonly delivery: 'restore' | 'transition-target' | 'unregistered-leaf'
  readonly payload: string                  // bogus composite string written via adaptee.set / returned by restore()
  readonly expectedErrorClass: 'contradictory-state' | 'invalid-state-path'
  readonly expectedMessagePrefix: string    // drift fixture; NOT a classification input
}

export interface ObservableScheduler /* decorator over createVirtualScheduler (scheduler.ts:259) */ {
  schedulerEmptyAt(t: number): boolean
  earliestExecuteAt(): number | null
  pendingCount(): number
}
```
DoD pin: `expectTypeOf<'corrupt-state'>().not.toEqualTypeOf<FaultKind>()` (Step-5 #1). Each `callbackKind` `'throw'` fault MUST be proven observably (a behavioral InjectedFault-frame test, not just `expectTypeOf`); any kind that does NOT dispatch through `callAction` is demoted to a documented v1 GAP (folds Unit-2 LOW gap — the hook-triad dispatch sites were not all individually opened; the chokepoint property is asserted by the §4 structural test).

### 3.6 Scenario — `scenario.ts` + `ops.ts` + `topology.ts` (ADR-1/2/5)

```ts
export type Op =                            // closed union; every variant a STABLE id:string (never positional index, R22)
  | { readonly kind: 'fire';     readonly id: string; readonly event: string; readonly args: readonly number[] }
  | { readonly kind: 'advance';  readonly id: string; readonly dtMs: number }
  | { readonly kind: 'noop';     readonly id: string }
  | { readonly kind: 'snapshot'; readonly id: string }
  | { readonly kind: 'restore';  readonly id: string; readonly fromSnapshotId: string }

export interface Bounds {
  readonly maxStateDepth: number            // clamp <=10 — the ONLY count/size that is a validateConfig ERROR (config_validator.ts:253 addError)
  readonly maxStatesCount: number           // WARNING-suppression only (addWarning ~:884)
  readonly maxEventsCount: number           // WARNING-suppression only (addWarning ~:892)
  readonly maxOps: number
  readonly maxArmedDelay: number            // longest legal chain; feeds Liveness budget/healWindow
}

export interface ScenarioSpec {
  readonly seed: string                     // serialized bigint (R3); JSON-safe
  readonly version: 1
  readonly topology: TopologySpec           // JSON-serializable; callbacks = closure-free literal-inlined source (R13)
  readonly ops: readonly Op[]
  readonly faults: FaultPlan
  readonly bounds: Bounds
}
// TopologySpec concrete shape is Step-4 IMPLEMENT; only JSON-serializability + closure-freeness are frozen here.

export function defineScenario(spec: ScenarioSpec): ScenarioSpec
export function runScenario(spec: ScenarioSpec): Promise<CanonicalTrace>  // pure in (seed, spec, header.runtime)
```
`Op.fire.args` is `number[]`: a number fails `isAdapter` (`'set' in inp && 'get' in inp`, types.ts:301-303), so the `fireEvent` `args[0]`-misparse hazard (`:469-471`) cannot arise for generated scenarios.

### 3.7 Capability registry — `capabilities.ts` + `coverage.ts` (ADR-8)

```ts
export type CapabilityId =                  // GENUINE closed string-literal union — NO `string` / NO `string & {}`
  | 'event.fire.external' | 'event.raise.internal' | 'queue.internal-before-external'
  | 'transition.guard.pass' | 'transition.guard.block' | 'transition.priority' | 'transition.onTransition'
  | 'event.wildcard'
  | 'hook.entry.onBeforeEnter' | 'hook.entry.onEnter' | 'hook.entry.onAfterEnter'
  | 'hook.exit.onBeforeExit' | 'hook.exit.onExit' | 'hook.exit.onAfterExit'
  | 'event.onBefore' | 'event.onAfter' | 'event.onSuccess' | 'event.onError'
  | 'hierarchy.nested-enter' | 'composite.parallel-regions' | 'composite.join.done-state'
  | 'history.shallow' | 'history.deep'
  | 'timer.invoke.fire' | 'timer.invoke.cond-skip' | 'timer.invoke.cancel-on-exit'
  | 'timer.transitionTimeout' | 'timer.resume'
  | 'error.action-throw' | 'error.guard-throw'
  | 'error.recovery.errorState' | 'error.recovery.abortOnExitError'
  | 'queue.backpressure.overflow' | 'queue.depth-bound.max-transition'
  | 'persistence.serialize' | 'persistence.deserialize'
  | 'inspection.getQueueDepth' | 'inspection.getCurrentStateInfo' | 'inspection.isDone'
  // 39 literals — one per design §6 row (grouped rows expanded per ADR-8 'every §6 row literal').
  // Overrides design §4.9:432 `string & {}` (which would collapse the Record to Record<string,…> and defeat totality).

export type CapabilityProbe = (trace: SimTrace) => boolean   // pure; switches on ErrorClass enum, never e.message;
                                                             // reads doneDelta, never live sm.* / IMonitor / wall-clock

export interface Capability {
  readonly id: CapabilityId
  readonly title: string
  readonly engineRefs: readonly string[]    // file:line citations
  readonly probe: CapabilityProbe
  readonly tier?: 'core' | 'advanced'
  readonly coverageStatus?: 'covered' | 'dormant' | 'n/a-string-method'   // COMPUTED at run-time, never a static pass flag
}

export declare const CAPABILITIES: Record<CapabilityId, Capability>      // TOTAL — tsc --noEmit fails if any id lacks an entry
export declare const DOCUMENTED_GAP_IDS: ReadonlySet<CapabilityId>
// = { 'error.guard-throw','error.action-throw','error.recovery.abortOnExitError' (string-method machines),
//     'queue.depth-bound.max-transition' (dormant) }

export function computeCoverage(scenarios: readonly ScenarioSpec[]): {
  readonly covered: ReadonlySet<CapabilityId>
  readonly uncovered: ReadonlySet<CapabilityId>
  readonly drift: ReadonlySet<CapabilityId>
  readonly exitCode: number                  // non-zero on uncovered>0 || drift>0 (excluding DOCUMENTED_GAP_IDS)
}
```
The committed `etc/sim-capabilities.txt` key-set snapshot MUST be generated from `keys(CAPABILITIES)`, not hand-typed. A remove-one-entry test pins that the total `Record` fails tsc.

---

## 4. `inFlightAsyncCount` await-site contract + string-method containment (ISS-030 / ISS-039)

### 4.1 Verified awaited-consumer-callback set (FROZEN, complete)

`callAction` (`state_machine.ts:1726`) is the **single chokepoint**: every function-valued guard/hook/action/invoke await funnels through its three `await result` arms (context `:1745`, inline-fn `:1758`, adaptee.get `:1764`). The four structurally distinct awaited sites:

| Site | Line | Notes |
|---|---|---|
| `callAction` chokepoint | `1726` | call sites that funnel through it: guards `1830`/`1950`; `event.onBefore` `1967`; `onTransition` `1997`; `event.onAfter` `2029`; exit hooks `~2105`; enter hooks `~2135`; invoke `2170`; resume `2504` |
| invoke action | `2170` | `await this.callAction(obj, invocation.action)` BEFORE `raiseEvent`+`scheduleProcessing` |
| resume action | `2504` | `await this.callAction(this.adaptee, invocation.action)` then `await this.fireEvent(...)` `:2506` (internal→external restore asymmetry) |
| transitionTimeout `Promise.race` | `1798` (scheduler leg) / `1802` (non-scheduler leg) | races `executeAction()` (defined `~:1742`) |

**OUT OF SCOPE (verified):**
- `invoke[].cond` — synchronous `(adaptee:T)=>boolean` (`types.ts:256`), invoked DIRECTLY (not awaited) at `2153` (`obj.adaptee`) and `2497` (`this.adaptee.adaptee`).
- `onError` handler — **[FOLDS Unit-3 MED gap]** resolved in `processError` (`~:1718-1722`, returns a closure invoking `handler(...)` directly) and dispatched **un-awaited** at `:2037` (`errorHandler(this.resolveCallbackOwner(obj), error)`). NOT routed through `callAction`. Out of scope on the same basis as cond: `ErrorHandler<T> = EventAction<T,void>` (`types.ts:4`) is typed to return `void`, so a conforming config cannot supply tracked async work. A CODE-REVIEW line-item MUST assert the `ErrorHandler` void return type and the `cond` synchronous signature (`types.ts:256`) are unchanged.
- `targetAdapter.save` (`:724`) / `restore` (`:733`) — persistence I/O, not a consumer guard/action/hook.

The single-chokepoint property is asserted by a **structural test** over the enumerated call-site list above (not prose).

### 4.2 Frozen `Env.inFlightAsyncCount` contract + bracket point

```ts
export interface Env {                       // full Env (incl. SchedulerView) is Step-3-owned; this freezes ONLY the count
  inFlightAsyncCount(): number               // settledness signal; ===0 is a NECESSARY conjunct of the macrostep fixed point (ADR-4)
  enterAsync(): void                         // increment — only callers are the action-wrapper bracket
  exitAsync(): void                          // decrement (in finally)
}

type WrappableAction<O> = (owner: O, ...args: any[]) => unknown | Promise<unknown>

function bracketAsync<O>(env: Env, fn: WrappableAction<O>): WrappableAction<O> {
  return (owner, ...args) => {
    env.enterAsync()                          // increment BEFORE the body runs
    let r: unknown
    try { r = fn(owner, ...args) }
    catch (e) { env.exitAsync(); throw e }    // sync throw — settle immediately
    if (r instanceof Promise) return r.finally(() => env.exitAsync())  // ACTION'S OWN promise
    env.exitAsync(); return r                  // sync (non-promise) result
  }
}
```
**FROZEN bracket rule:** `enter()` immediately before the wrapped body; `exit()` in a `finally` on the **wrapped action's own promise** — NEVER on `callAction`'s outer return. With `transitionTimeout` set, `callAction` returns `Promise.race([executeAction(), timeoutPromise])` (`:1798/:1802`); the timeout leg can reject while `executeAction()`'s wrapped action is still pending. Bracketing the outer return would decrement on timeout-win → premature quiescence. Step-5 DoD: an opaque deferred-controlled async action observably in-flight across a settle sample; a timeout-win MUST NOT prematurely decrement.

**Wrappable scope:** function-valued callbacks resolved on `callAction` path-1/2/3 when `typeof === 'function'`. A raw string method-name is resolved INSIDE `callAction` (after the wrap boundary) and is structurally unwrappable.

### 4.3 Frozen string-method-invoke containment DoD (two layers, both falsifiable)

- **Layer (a) PRIMARY — Step 4:** the scenario generator emits ONLY function-valued (closure-free literal) invoke actions and NEVER a string method-name async invoke action. Acceptance: a CODE-REVIEW + test assertion over Step-4 emitted `ScenarioSpec`s that no `invoke[].action` is a string resolving to a callAction path-1/path-3 async body — corpus gap-free by construction.
- **Layer (b) BACKSTOP — Step 6/8:** any string-method async invoke that nonetheless appears is caught by the I-1 replay determinism gate (non-reproducible `inFlightAsyncCount` divergence) and EXCLUDED from registry-scoped coverage with an explicit `uncovered`/`n/a-string-method` marker — NEVER a silent pass (ISS-029 honesty alignment; the marker assertion is a hard gate).

---

## 5. Corrupt-state payload-delivery contract (ISS-041 / F-PF-2)

The 8th `corrupt-state` probe drives the engine's OWN guards to throw, but ONLY via verified throwing sites — not the silent-dedup normal path. `setCurrentState`/`setCurrentStateInternal` are PRIVATE, so the probe's only write seam is the harness-owned `Adapter.set` wrap (ADR-3): it writes the raw composite string directly, bypassing internal validation; the witness is then delivered/read through a public throwing site.

### Verified silent-dedup trap
`setCurrentStateInternal` de-dups duplicate/overlapping region keys (loop `~:1170-1192`, last-write-wins) and then renders `Array.from(map.values()).join('|')` BEFORE `validateCompositeState(newCompositeState)` at `:1203` and `adaptee.set` at `:1204`. A duplicate-region payload through this path is SILENTLY collapsed and never throws. `validateCompositeState` has exactly four callers: `:734` (restore, raw string), `:1203` (the dedup trap), `:2309` (`updatePartialState`), `:2353` (`updateState`).

### Frozen primaries

```ts
// I-6 REGION-CONTAINMENT — delivered via public restoreState (state_machine.ts:727):
//   restore() returns the RAW duplicate string; validateCompositeState(result.currentState) at :734
//   runs on the RAW string BEFORE setCurrentState(:739) -> throws :1614 (msg :1615).
const I6_PROBE: CorruptStateProbe = {
  kind: 'corrupt-state', invariant: 'I-6', delivery: 'restore',
  payload: 'root.regionA.leaf1|root.regionA.leaf2',          // same regionKey 'root.regionA'
  expectedErrorClass: 'contradictory-state',
  expectedMessagePrefix: 'Contradictory state detected: multiple states for region',  // :1615
}

// I-10 CONFIG-GRAPH-VALID — write the unregistered leaf via the wrapped Adapter.set (ADR-3 seam),
//   then read back via public getCurrentState (:1210); per-part this.states.has(statePart) fails
//   at :1219 -> throws :1220 (msg :1221).
const I10_PROBE: CorruptStateProbe = {
  kind: 'corrupt-state', invariant: 'I-10', delivery: 'unregistered-leaf',
  payload: 'root.regionA.leaf1|root.regionA.bogusLeaf',       // 'root.regionA.bogusLeaf' NOT in this.states
  expectedErrorClass: 'invalid-state-path',
  expectedMessagePrefix: 'Invalid state path in current state',  // :1221
}
```

### Corrections folded
- **[CORRECTED — Unit-5 FALSE rationale]:** leaf registration is **NOT** a precondition for the `:734` contradiction throw. `validateCompositeState` (`:1608-1621`) never calls `getCurrentState` nor `this.states.has()`; it operates purely on region-key collision. The Unit-5 risk that ":1219 pre-empts and misclassifies as I-10" is a **phantom** for the frozen restore-path primary and is REMOVED. (Registration would only matter if a delivery routed the dup string through `getCurrentState` first, which the frozen contract does not.)
- **[CORRECTED line citations]:** contradictory throw `:1614` / msg `:1615`; read-path invalid-path throw `:1220` / msg `:1221` / guard `:1219`; write-path region set `:1191`; write-path Invalid-path throw `:1161` / msg `:1162`.

### Verified-and-demoted secondary
`:2309` (`updatePartialState`) and `:2353` (`updateState`) DO call `validateCompositeState`, but `updateState` runs `parseCompositeState` first (Map-dedups within one target leaf-set), so they throw reliably only on a CROSS-WRITE region collision (generator-dependent). DEMOTED to verify-at-IMPLEMENT; `restoreState:734` is the unconditional I-6 primary.

### Explicitly excluded (completeness)
`:1161` (`setCurrentStateInternal` write-path Invalid-state-path throw, message DISTINCT from the `:1221` read-path) — EXCLUDED: private method; the `Adapter.set` seam writes the raw attribute directly, bypassing it.

### Frame + ordering contract
Each probe is the LAST op of a DEDICATED single-purpose scenario, emits exactly ONE `synthetic:'corrupt-state'` frame, and the guard-throw IS the witness. Removing the probe makes the invariant vacuously pass with ZERO witnesses. **[FOLDS Unit-5 LOW gap]:** because many engine methods call `getCurrentState` internally (e.g. `:716/:589/:2452/:2166/...`), the I-10 IMPLEMENT obligation is explicit: after the corrupt `Adapter.set`, NO engine method that calls `getCurrentState` may run before the witnessing read (machine quiescent, no pending timers/fireEvent). DoD: assert exactly ONE synthetic frame and that the throw originates from the harness-invoked read.

---

## 6. Sim tsconfig isolation decision (ISS-043 / F-PF-5 / RR-2)

### Reconciled verdict — CROSS-UNIT CONFLICT RESOLVED

Two source units disagreed: the dedicated isolation unit and one internal-types unit asserted isolation is "FEASIBLE / the ratified target"; the public-API verifier, the build-wiring unit, and an empirical control all proved a deliberate `src/sim/**` type error **fails the core `npm run check` and `build:types` today**. **Verified at this commit:** `tsconfig.json` include is `["src/**/*"]` (no `src/sim` exclude), `tsconfig.build.json` extends it, and `check` runs bare `tsc --noEmit` (defaults to `tsconfig.json`). So once `src/sim/**` exists it is in BOTH the check graph and the emit graph by default.

**RESOLUTION (frozen):**
1. **Emission half — FEASIBLE, no new config.** `tsc -p tsconfig.build.json --emitDeclarationOnly` already emits `types/sim/index.d.ts` per-file (non-rollup; `declarationDir:"types"` at **`tsconfig.build.json:6`** [CORRECTED from :7; :7 is `outDir`], api-extractor `dtsRollup:false`). `api-extractor.sim.json` reads the emitted `.d.ts`, NOT `src/sim`, so `api:check:sim` is independent of the include question.
2. **Typecheck-isolation half — NOT achievable by adding a sibling `tsconfig.sim.json` alone.** True isolation requires excluding `src/sim/**/*` from the config the core `check`/`build:types` use. This is a two-branch IMPLEMENT decision; **the documented-coupling fallback (branch B) is the recorded default** unless Step 10 demonstrates branch A passing its acceptance test.

**Branch A — ISOLATION (target if it lands):** add `tsconfig.check.json` (extends base, restates full exclude + `src/sim/**/*`) for `check`; add `exclude:["…","src/sim/**/*"]` to `tsconfig.build.json` for core dts; add `tsconfig.sim.json` (`noEmit`, `include:["src/sim/**/*"]`) wired as a node-20-only `sim:check` step; add `tsconfig.sim.build.json` (`emitDeclarationOnly`, `include:["src/sim/**/*"]`) for `types/sim/**`. **Falsifiable acceptance test (Step-10 DoD#11):** `src/tests/sim/tsconfig_isolation.test.ts` writes a temp `src/sim/__isolation_probe__.ts` with a type error and asserts `tsc -p tsconfig.check.json --noEmit` exits 0 AND `tsc -p tsconfig.sim.json` exits non-zero naming the probe (cleanup in `finally`).

Branch-A footguns (frozen as load-bearing invariants if A is taken):
- **Glob form** must be `src/sim/**/*` everywhere — a bare `src/sim/**` in `include` is rejected by tsc (TS5010).
- A child `exclude` in an `extends` chain **REPLACES** (does not merge) the parent's — every derived config must restate the full exclude list.
- **[FOLDS Unit-4 MED gap — false "sole emit root" claim]:** the sim emit leg re-emits the entire transitively-imported core `.d.ts` tree into `types/` (because `src/sim/index.ts` imports `../index`). This is benign ONLY if (i) `build` runs the **core-types leg first, then the sim leg**, and (ii) `tsconfig.sim.build.json` shares the base compiler options verbatim so the sim leg's re-emit of core `.d.ts` is byte-identical. `rootDir:"src/sim"` does NOT cleanly scope it (raises TS6059). Step-10 DoD must assert core `.d.ts` are byte-identical whether the build stops after the core leg or the full build.

**Branch B — DOCUMENTED COUPLING (recorded default, RR-2 accepted risk):** keep the shared `tsconfig.json`; a `src/sim/**` type error blocks core `check`/`build`/`prepublishOnly`/tier-a by design. The `@unstable ./sim` island is then NOT type-isolated from the byte-frozen core gate. **Acceptance:** the coupling note is committed AND `types/sim/index.d.ts` still emits; REFLECT records the sign-off. This branch needs no config beyond §8's exports/tsup/api-extractor additions.

### vitest coverage coupling — **[FOLDS Unit-6 MED gap]**
`vitest.config.ts` `coverage.include` is `['src/**/*.ts']` (`:16`) and `coverage.exclude` (`:18-22`) lists only `src/tests`, `src/presets.ts`, `src/security.ts` — NOT `src/sim`. The moment `src/sim/**` lands, the existing 90% `test:coverage` gate (`thresholds` `:23-28`) applies to it, independent of the separate `sim:coverage` CLI. **Frozen decision:** Step 10/11 MUST add `'src/sim/**'` to `coverage.exclude` (the separate `sim:coverage` CLI owns sim coverage), OR explicitly accept that the core vitest threshold gates sim and guarantee every sim line is reachable from `src/tests/**`. Default: **exclude `src/sim/**` from vitest coverage** and let `sim:coverage` own it. Falsifiable test: an uncovered no-op branch in a `src/sim` file must NOT fail `npm run test:coverage` under the exclude path.

---

## 7. Perf band config + non-zero-p99 rule + baseline shape (ISS-042 / F-PF-4)

Structurally-walled-off SECOND sink (`src/sim/metrics.ts`); MUST NEVER feed `hashTrace` (ADR-1). Perf VALUES are measured in IMPLEMENT (Step 8) on the node-20 CI runner class; only config/shape/rules are frozen here.

```ts
export type LatencyResolution = 'ms-coarse'
export interface LatencyStats { p50:number; p90:number; p99:number; max:number; mean:number; resolution:LatencyResolution }

export interface PerfSample {
  wallNs: bigint               // process.hrtime.bigint() ns; serialized as DECIMAL STRING in baseline JSON
  eventsProcessed: number
  transitionsObserved: number
  eventsPerSec: number          // PRIMARY throughput: eventsProcessed / (Number(wallNs)/1e9)
  transitionsPerSec: number
  latency: LatencyStats         // advisory; all-zero under any vi.useFakeTimers()-active leg
  heapPeakBytes: number; heapAvgBytes: number; heapEndBytes: number
  gcProxy: number
  traceLen: number              // READ from the Step-1 trace object; never recomputed; never hashed
  queueDepthPeak: number        // sampled by the harness AFTER each settleMacrostep barrier; never reads private engine queues (see note)
}

export interface PerfReport {
  schemaVersion: 1; packageVersion: string
  runtime: 'node' | 'bun'; node: string
  sample: PerfSample            // field-wise median-of-N=5
  raw: PerfSample[]             // length === medianN (RUNTIME invariant — see note; a DoD test asserts raw.length===5)
}

export const PERF_REGRESSION_CONFIG = {
  medianN: 5,
  bands: {
    throughputPct: 0.20,        // PRIMARY; hrtime-sourced; gates ALWAYS
    memoryPct: 0.25,            // gates ONLY when global.gc present (--expose-gc); else advisory-downgrade
    latencyP99Pct: 0.30,        // advisory; gates only when latencyGated && baseline.p99 > epsilon
    traceLenTolerance: 0,       // ZERO tolerance — any delta for the fixed seed is a determinism regression
  },
  p99Epsilon: 1e-9,             // ms
} as const

export interface PerfBaselineFile {           // etc/sim-perf.baseline.json
  schemaVersion: 1; packageVersion: string; runtime: 'node'|'bun'; node: string
  baseline: {
    wallNs: string              // decimal-string bigint
    eventsPerSec: number        // MUST be > 0 (DoD 6)
    transitionsPerSec: number
    latency: { p50:number; p90:number; p99:number; max:number; mean:number; resolution:'ms-coarse' }
    heapPeakBytes:number; heapAvgBytes:number; heapEndBytes:number; gcProxy:number
    traceLen:number; queueDepthPeak:number
  }
  gates: { latencyGated: boolean; memoryGated: boolean }
}

export class PerfBaselineValidationError extends Error {}
export declare function loadPerfBaseline(path: string): PerfBaselineFile
export interface BandResult { metric:'throughput'|'memory'|'latencyP99'|'traceLen'; status:'pass'|'fail'|'advisory'|'na'; baseline:number; observed:number; band:number }
export declare function evaluatePerfBands(report: PerfReport, baseline: PerfBaselineFile): BandResult[]
```

### Non-zero-p99 rule (FROZEN; closes F-PF-4 — **two-sided** per Unit-7 HIGH gap)
`loadPerfBaseline()` THROWS `PerfBaselineValidationError` (a committed-baseline VALIDATION FAILURE — never a silent N/A) when:
- (a) `gates.latencyGated === true` AND `baseline.latency.p99 <= p99Epsilon` — an all-zero gating p99 is invalid; **and**
- (b) **[FOLDS Unit-7 HIGH — closes the self-asserted escape hatch]** `gates.latencyGated === false` AND `baseline.latency.p99 > p99Epsilon` — a non-zero p99 with the band disabled is ALSO a validation failure (a real measurement being silently ignored); **and**
- (c) `baseline.eventsPerSec <= 0` — placeholder-zeros throughput is invalid.

`latencyGated` MUST be **derived from the measurement leg, not author-free**: the real-timer leg (`vi.useRealTimers()` or a vitest project omitting `'Date'` from `toFake`) sets `latencyGated:true`; a faked-timer leg cannot set it true. Acceptance tests: a baseline with (latencyGated:true, p99<=epsilon) fails to load; a baseline with (latencyGated:false, p99>epsilon) fails to load. N/A is permitted ONLY for an honestly faked-leg, all-zero, non-gating baseline.

### Verified premises
- `vitest.config.ts:13` `toFake = ['setTimeout','clearTimeout','setInterval','clearInterval','Date']` — does NOT fake `process.hrtime`/`performance.now`/`process.memoryUsage`. So hrtime throughput + heap survive faked Date.
- The engine duration `Date.now()` delta (`state_machine.ts:2047`→`2059`, intentional wall-clock telemetry per the `:2044-2046` comment) is structurally 0 **specifically when `vi.useFakeTimers()` is ACTIVE** — corrected from the build-plan's config-global phrasing. There is no global `setupFiles`/`vi.useFakeTimers()` install; tests install per-test. Hence the gating latency baseline MUST come from a real-timer leg.
- No `--expose-gc` plumbing exists today (`global.gc` only inside `performance.test.ts`); memory band advisory-downgrades absent `global.gc`. The node-20 nightly perf-regression leg passes `--expose-gc` to make it enforceable.

### Notes folded
- **traceLen** read-from-trace; a negative tsc fixture (Step-8 DoD 2) asserts adding `wallNs` to a `TraceFrame` is a compile error.
- `raw.length === medianN` is a **runtime invariant** (a DoD test asserts it), NOT type-enforced — **[FOLDS Unit-7 LOW]**.
- `queueDepthPeak` source **[FOLDS Unit-7 LOW]:** sampled by the harness drive-loop AFTER each `settleMacrostep` barrier via the Step-3 scheduler-observation/SimMonitor seam, NEVER reading the private engine queues (zero core-ABI; ADR-7/4).
- `SM_PERF_UPDATE_BASELINE=1` refreshes the committed file (read-only otherwise), mirroring the `etc/statemachine.api.md` drift-gate UX. Scripts: `sim:perf`, `sim:perf:baseline`.
- **[FOLDS Unit-7 MED — perf depends on ISS-043]:** the perf plane lands under `src/sim/metrics.ts`; under §6 branch B (default), a `metrics.ts` type error can block core `check`. Surfaced as the §6 accepted-coupling risk, recorded in REFLECT.

---

## 8. Build / packaging wiring diff

```jsonc
// (1) package.json — add EXACTLY one ./sim exports key; "." UNCHANGED; sideEffects:false (line 23) STAYS.
"exports": {
  ".":     { "types": "./types/index.d.ts",     "import": "./dist/index.js",     "require": "./dist/index.cjs" },
  "./sim": { "types": "./types/sim/index.d.ts", "import": "./dist/sim/index.js", "require": "./dist/sim/index.cjs" }
}
// files:["dist","types","README.md","LICENSE"] UNCHANGED — dist/sim/** + types/sim/** auto-ship; etc/** stays excluded.
// new scripts: "api:check:sim", "sim:coverage" (folded into check at Step 10/11 only), "sim:perf", "sim:perf:baseline";
//   "prepublishOnly": "... && node test/verify-dist.cjs && node test/verify-dist-bytes.cjs"
//   Under §6 branch A also: "sim:check","build:types"(+sim leg),"check"(via tsconfig.check.json).
```

```ts
// (2) tsup.config.ts — ONLY the entry array changes. splitting STAYS false (engine duplicates into dist/sim, ADR-7
//     accepted). dts:false STAYS (types from tsc, not tsup). EMPIRICALLY PROVEN: dist/index.{js,cjs} bytes are
//     IDENTICAL before/after adding the 2nd entry under splitting:false.
entry: ['src/index.ts', 'src/sim/index.ts']   // was ['src/index.ts']
```

```jsonc
// (3) api-extractor.sim.json — NEW; clone of api-extractor.json with the sim entry + sim report.
//     Core api-extractor.json reads ONLY types/index.d.ts (:3) -> 2nd tsup entry adds ZERO bytes to the core report.
{ "mainEntryPointFilePath": "<projectFolder>/types/sim/index.d.ts",
  "compiler": { "tsconfigFilePath": "<projectFolder>/tsconfig.build.json" },   // resolution only; does NOT re-typecheck src/sim
  "apiReport": { "enabled": true, "reportFolder": "<projectFolder>/etc/", "reportFileName": "statemachine-sim.api.md" },
  "dtsRollup": { "enabled": false }, "docModel": { "enabled": false }, "tsdocMetadata": { "enabled": false } }
// Generate + git-add etc/statemachine-sim.api.md BEFORE wiring its own `git diff --exit-code` assertion.
```

```js
// (5) test/verify-dist-bytes.cjs — NEW; DISTINCT from the presence-only test/verify-dist.cjs (kept).
//     sha256 of dist/index.{js,cjs} with the trailing //# sourceMappingURL= line STRIPPED, vs committed
//     etc/dist-bytes.baseline.json. MUST be a committed baseline, NOT git diff: dist/ + types/ are gitignored
//     (.gitignore:2-3); only etc/ is tracked. SM_DIST_UPDATE_BASELINE=1 refreshes. .map files out of scope.
//     EMPIRICALLY PROVEN: strip regex /\n?\/\/[#@] sourceMappingURL=.*$/m matches tsup output.
```

- **(4) knip:** no config change needed in the common case — knip 6's tsup plugin registers `src/sim/index.ts` as a production entry from SOURCE (build-order-independent, the load-bearing path), and the exports-leaf reader registers the `./sim` paths (build-output-dependent — present only post-build; **[FOLDS Unit-6 LOW]** run the knip green-check both pre-build local and post-build CI). Add a knip `entry`/`ignore` ONLY if a real run flags `src/sim/**` (e.g. a `coverage.ts` CLI not reached by a test import).
- **(6) `npm run check` `sim:coverage` fold** happens ONLY at Step 10/11 (after knip is green), per ADR-8 F.
- **CI wiring (`ci.yml`):** append node-20-only steps after the existing `git diff --exit-code etc/statemachine.api.md` (`:52`): `node test/verify-dist-bytes.cjs`, `npm run api:check:sim`, `git diff --exit-code etc/statemachine-sim.api.md`, and (branch A) `npm run sim:check`. Core `etc/statemachine.api.md` zero-diff is REUSED (the 2nd entry adds zero bytes). `release.yml` publish chain does NOT invoke `prepublishOnly` (`bun publish`), so `node test/verify-dist-bytes.cjs` MUST be an explicit release step.
- **[FOLDS Unit-6 LOW]:** the byte guard is node-20-only; document that it intentionally pins the node-20 toolchain and cross-toolchain (bun) dist byte equivalence is out of scope (or also run it on tier-a-bun).

---

## 9. Obligation-discharge table

| Obligation | Resolution / where carried |
|---|---|
| **ISS-029** (coverage honesty) | §3.7 `coverageStatus` COMPUTED at run-time + `DOCUMENTED_GAP_IDS`; §4.3 layer-(b) emits `n/a-string-method`/`uncovered` markers (never silent pass) → IMPLEMENT Step 9 |
| **ISS-030** (await-site enumeration) | §4.1 FROZEN four-site set + chokepoint `callAction:1726`; structural test owns single-chokepoint property |
| **ISS-031** (corrupt-state synthetic frame / vacuous-on-removal) | §5 last-op single-purpose scenario, exactly-one `synthetic:'corrupt-state'` frame, vacuous-on-removal |
| **ISS-032** (perf bands) | §7 band config + baseline shape + real-timer-leg p99 frozen; numeric measurement → IMPLEMENT Step 8; REFLECT records numbers + runner class |
| **ISS-033** (trace schema / hash plane) | §3.2 CLOSED `TraceFrame` two-orthogonal-unions + `hashTrace` excludes wall-clock/duration/heap/errorCode/byte; `version` bump on closed-union/hashed-field change |
| **ISS-039** (wrappable scope / string-method consequence) | §4.2 bracket-the-wrapped-action's-own-promise; §4.3 two-layer falsifiable DoD |
| **ISS-040** (UR-003 seed→step-trace debug) | §1 `Simulator.step():Promise<StepOutcome>` + `StepOutcome.frames/traceHash`; `SimResult.trace`; substrate §3.2 |
| **ISS-041** (corrupt-state delivery) | §5 I-6=`restoreState:734`, I-10=`getCurrentState:1219`; `:2309/:2353` demoted to verify-at-IMPLEMENT; `:1161` listed-and-excluded; false registration-precondition removed |
| **ISS-042** (perf bands + non-zero p99) | §7 frozen; two-sided `loadPerfBaseline` throw closes the self-asserted-flag escape hatch |
| **ISS-043** (sim tsconfig isolation) | §6 emission FEASIBLE (no new config); typecheck isolation = two-branch decision, **branch B (documented coupling) recorded default**, branch A target with falsifiable acceptance test → IMPLEMENT Step 10 + REFLECT sign-off |

---

## 10. Cross-consistency report + open-for-IMPLEMENT

### Cross-consistency: **FIXED** (one conflict reconciled, plus shared-type and citation fixes)

- **ISS-043 verdict conflict (the one substantive cross-unit disagreement):** the isolation unit's "FEASIBLE/ratified isolation" framing contradicted the public-API verifier, the build-wiring unit, and an empirical control. Reconciled in §6: emission is feasible with zero new config; **typecheck isolation is a two-branch IMPLEMENT decision with the documented-coupling fallback (branch B) as the recorded default** and branch A gated by a falsifiable acceptance test. No unit's verified facts were dropped — only the overstated verdict was corrected.
- **`TraceFrame`/`Violation` identity:** `SimResult.violation`, `StepOutcome.violation`, and `MinimalRepro.violation.errorClass` reference the SAME `Violation`/`ErrorClass`/`TraceFrame` frozen in §3.2/§3.3/§3.4 (re-exported, not redefined). Consistent.
- **`errorClass` identity:** the `CapabilityProbe` (§3.7), the corrupt-state probe (§5), and the public `MinimalRepro` (§1) all consume the SAME §3.3 `ErrorClass` enum. Consistent.
- **await-site set identity:** the site set referenced by `Env.inFlightAsyncCount` (§4), the corrupt-state delivery (§5), and the perf `queueDepthPeak`/settle-barrier sampling (§7) all reference the same verified `state_machine.ts` sites. Consistent.
- **`PerfSample` identity:** `SimResult.metrics` (§1) === the §3/§7 `PerfSample`; field-shape drift guarded by `etc/statemachine-sim.api.md` (not the presence test).
- **Line-citation corrections folded throughout:** `exactOptionalPropertyTypes` `tsconfig.json:11` (was :13); `declarationDir` `tsconfig.build.json:6` (was :7); contradictory throw `:1614`/msg `:1615`; invalid-path read throw `:1220`/msg `:1221`/guard `:1219`; write-path throw `:1161`.
- **onError out-of-scope** added (§4.1) so the "EVERY awaited consumer-callback site" claim is honest; **Unit-5 false registration-precondition** removed (§5); **Unit-4 false sole-emit-root** corrected to the order+option-identity invariant (§6); **Unit-7 self-asserted latencyGated** closed with the two-sided throw (§7); **Unit-6 vitest-coverage** coupling fixed (§6).

### Open-for-IMPLEMENT
- §6 branch decision (A isolation vs B documented coupling) + the exact `tsconfig.sim.json`/`tsconfig.check.json`/`tsconfig.sim.build.json` shapes (only if A) + the DoD#11 isolation test.
- Concrete `./_internal` module paths behind the §1 barrel (`trace.ts`/`prng.ts`/`clock.ts`/`faults.ts`/`invariants.ts`/`liveness.ts`/`capabilities.ts`/`coverage.ts`/`metrics.ts`/`scenario.ts`) — names frozen, source paths not.
- `TopologySpec` concrete field layout (Step 4); per-Invariant `checkStep`/`checkFinal` bodies for I-1..I-12 (Step 6); `splitmix64_mix`/`fnv64`/`rotl64` byte-level bodies (Step 1); `ConfigGraph` build-from-config walk (Step 6); `CaptureSink`/`CapturedWrite` sink struct (Step 2).
- Measured VALUES: `etc/sim-perf.baseline.json` medians + `etc/dist-bytes.baseline.json` hashes (node-20 runner class, Step 8/11) — committed at IMPLEMENT, REFLECT-recorded.
- Behavioral-sentinel-probe timer kind inside `wire()`/`init()` (Step 10 mechanism choice, bounded one-settleMacrostep).
- `npm pack --dry-run` confirmation that the tarball contains `dist/sim/**`+`types/sim/**` and excludes `etc/**` (Step 10 CODE_REVIEW artifact).
- `SimTarget` extension (pre-wired handle) — deferred; v1 freezes `{config,owner}` (sanctioned) + `{machine}` (best-effort).
- Per-`callbackKind` `'throw'`-observable behavioral test; demote any non-`callAction` kind to a documented gap (Step 5).
