/**
 * @module sim/scenario
 * @unstable
 *
 * ADR-1/2/5 Step-4 scenario schema: the deterministic, JSON-serializable
 * {@link ScenarioSpec} one seed derives into (a) a `validateConfig`-clean machine
 * config built CORRECT-BY-CONSTRUCTION (no discard-retry) and (b) a closed-loop,
 * available-event-aware {@link Op} stream. Replaying the Step-3 driver on the
 * same spec/seed/runtime yields a bit-identical `traceHash`.
 *
 * FROZEN shapes (tech-spec §3.6):
 *  - {@link Op}: a CLOSED union; every variant carries a STABLE `id: string`,
 *    NEVER a positional index (R22). Dropping an op leaves surviving ids
 *    unchanged.
 *  - {@link Bounds}: `maxStateDepth` is the ONLY count/size that is a
 *    `validateConfig` ERROR (config_validator.ts:253 `addError`); the state/event
 *    counts are WARNING-suppression only.
 *  - {@link ScenarioSpec}: `seed` is the SERIALIZED bigint (string; JSON-safe,
 *    R3); callbacks in `topology` are closure-free literal-inlined SOURCE that
 *    survives `security.ts:640` restricted-scope re-eval (R13).
 *
 * `Op.fire.args` is `number[]`: a number fails `isAdapter`
 * (`'set' in inp && 'get' in inp`, types.ts:301-303), so the `fireEvent`
 * `args[0]`-misparse hazard (state_machine.ts:469-471) cannot arise for
 * generated scenarios.
 *
 * ## W8 — why `Op.fire.args` STAYS `number[]` while the LIVE driver widened
 *
 * W8 widened the LIVE fuzzing path (`DriverOp.fire.args`, `SubmissionEntry.args`,
 * `SimDriver.fireOne`/`fireMany`/`boundFireEvent`, `fireBuffered`) from `number[]`
 * to `unknown[]` so `checkMachine` can fuzz OBJECT payloads. The PERSISTED
 * {@link ScenarioSpec} deliberately did NOT follow, for three independent reasons:
 *
 *  1. **Key determinism.** `shrinker.ts:shrinkCacheKey` folds a fire op as
 *     `f:<id>:<event>:${op.args.join(',')}`. `join` on objects yields
 *     `[object Object]` for EVERY distinct object, so two structurally different
 *     candidates would COLLIDE on one memo key and the shrinker would return a
 *     wrong (unverified) minimal repro. A widened `args` therefore requires a
 *     canonical serializer inside the shrink key — a change outside this schema.
 *  2. **Shrink move M5** (`shrinker.ts:706-750`) narrows args ARITHMETICALLY
 *     (`Math.abs(value)`, `value < 0`, binary search toward 0). That move is only
 *     meaningful for numbers; `unknown` would make it type-unsound.
 *  3. **JSON round-trip.** A `ScenarioSpec` is the SERIALIZED corpus artifact
 *     (`repro-codegen.ts` embeds it in a `MinimalRepro`). `unknown` is not
 *     JSON-round-trippable in general (functions/symbols/cycles), which would
 *     break the module's "deterministic, JSON-serializable" contract.
 *
 * Consequence: `MINIMAL_REPRO_SCHEMA_VERSION` (repro-codegen.ts) is UNCHANGED at
 * 1 — no persisted shape changed. Object payloads live only on the LIVE
 * `Simulator`/`checkMachine` path (`SimOptions.eventPayload`), which is
 * seed-reproducible but not corpus-serialized. Widening this field is the
 * prerequisite work for object-payload shrinking, not part of W8.
 */

// The fault taxonomy is owned by Step 5 (`faults.ts`, tech-spec §3.5); the single
// definition of each fault type lives there (no divergence). `ScenarioSpec.faults`
// only needs `FaultPlan`; the richer `FaultKind`/`FaultSite`/`FaultSpec` are
// re-exported by the `./index` barrel directly from `./faults`. faults.ts imports
// only from trace.ts, so there is no import cycle. Step 4 always emits an EMPTY
// FaultPlan (`{ faults: [] }`).
import type { FaultPlan } from './faults'
// Re-export FaultPlan so consumers that read the scenario shape (e.g. define.ts,
// the `./index` barrel) resolve it from the scenario module too; the single
// definition still lives in faults.ts.
export type { FaultPlan } from './faults'

/**
 * A single deterministic operation against the running machine. CLOSED union;
 * each variant carries a STABLE `id` (R22) so faults/shrinking reference ops by
 * identity, never by position. `fire.args` is `number[]` (never an Adapter — see
 * module doc); it stays number-only even after the W8 live-path widening, because
 * the shrink cache key and the M5 narrow move both require numeric args (module
 * doc §W8).
 *
 * Step 4 emits ONLY `fire`/`advance`/`noop` (the Step-3 driver's drivable op
 * set); `snapshot`/`restore` are part of the frozen union (tech-spec §3.6) and
 * are driven once the Simulator lands snapshot/restore (Step 10).
 */
export type Op =
  | { readonly kind: 'fire'; readonly id: string; readonly event: string; readonly args: readonly number[] }
  | { readonly kind: 'advance'; readonly id: string; readonly dtMs: number }
  | { readonly kind: 'noop'; readonly id: string }
  | { readonly kind: 'snapshot'; readonly id: string }
  | { readonly kind: 'restore'; readonly id: string; readonly fromSnapshotId: string }

/**
 * Generation bounds. Only `maxStateDepth` gates an `isValid:false` ERROR
 * (config_validator.ts:253). `maxStatesCount`/`maxEventsCount` suppress WARNINGS
 * only (addWarning ~:884/:892) and never flip `isValid`.
 */
export interface Bounds {
  /** clamp <=10 — the ONLY count/size that is a validateConfig ERROR (config_validator.ts:253 addError). */
  readonly maxStateDepth: number
  /** WARNING-suppression only (addWarning ~:884). */
  readonly maxStatesCount: number
  /** WARNING-suppression only (addWarning ~:892). */
  readonly maxEventsCount: number
  /** Cap on the generated op stream length. */
  readonly maxOps: number
  /** Longest legal armed-timer delay; feeds the Liveness budget/healWindow. */
  readonly maxArmedDelay: number
}

/**
 * A single closure-free literal callback: its `source` is a function-expression
 * string with NO free identifiers (reads ONLY its parameter), so it survives the
 * `security.ts:640` restricted-scope re-eval (R13). The harness uses the LIVE
 * `fn` when wiring; `source` is what is serialized into a {@link TopologySpec}
 * and re-created on replay / `configHash`.
 */
export interface LiteralCallback {
  /** Closure-free function-expression source, e.g. `(o)=>(o.k%7)===3`. */
  readonly source: string
  /** The live function (created by the generator; equal in behavior to `source`). */
  readonly fn: (...args: never[]) => unknown
}

/** A generated `invoke` timer descriptor (closure-free `action`/`cond` if present). */
export interface InvokeSpec {
  readonly delay: number
  readonly event: string
  /** Closure-free literal cond; when present the engine skips the raise if it returns false. */
  readonly cond?: LiteralCallback
  /** Closure-free literal action (sync or async) run before the raise. */
  readonly action?: LiteralCallback
}

/** A generated state node. Either an atomic leaf or a composite carrying regions. */
export interface StateSpec {
  /** `display`/`final`/`history` carried explicitly to stay validator-clean. */
  readonly final?: boolean
  readonly history?: 'shallow' | 'deep'
  /** Pinned region-start leaf (avoids the REGION_MISSING_INITIAL advisory warning). */
  readonly initial?: string
  /** Parallel/composite regions: region-name -> region-state map. */
  readonly regions?: Readonly<Record<string, Readonly<Record<string, StateSpec>>>>
  /**
   * Hierarchical (single-region) sub-states: name -> StateSpec. ADDITIVE Step-9
   * authoring surface (the Step-4 generator uses only {@link regions}); the engine
   * accepts a `states` field on a composite node, mapped 1:1 by
   * define.ts:toEngineState. Enables nested/deep-history composites in coverage
   * scenarios.
   */
  readonly states?: Readonly<Record<string, StateSpec>>
  /** Closure-free enter/exit owner-marker probes + invoke timers. */
  readonly onEnter?: LiteralCallback
  readonly onExit?: LiteralCallback
  /**
   * Optional full entry/exit hook triad (closure-free literal markers). The Step-4
   * generator never emits these (it uses only {@link onEnter}/{@link onExit}); they
   * are an ADDITIVE Step-9 authoring surface so the coverage scenarios can exercise
   * the full hook set the engine supports (types.ts:228-233). Mapped 1:1 onto the
   * engine state node by define.ts:toEngineState.
   */
  readonly onBeforeEnter?: LiteralCallback
  readonly onAfterEnter?: LiteralCallback
  readonly onBeforeExit?: LiteralCallback
  readonly onAfterExit?: LiteralCallback
  readonly invoke?: readonly InvokeSpec[]
}

/** A generated transition (closure-free literal `guard`/`onTransition` if present). */
export interface TransitionSpec {
  readonly from: string
  readonly to: string
  readonly priority?: number
  readonly guard?: LiteralCallback
  readonly onTransition?: LiteralCallback
}

/** A generated event with its transitions. */
export interface EventSpec {
  readonly transitions: readonly TransitionSpec[]
  /**
   * Optional event-level hooks (closure-free literal markers). The Step-4
   * generator never emits these; they are an ADDITIVE Step-9 authoring surface so
   * the coverage scenarios can exercise the event-level hook set (types.ts:280-283).
   * Mapped 1:1 onto the engine event node by define.ts:toEngineEvent.
   */
  readonly onBefore?: LiteralCallback
  readonly onAfter?: LiteralCallback
  readonly onSuccess?: LiteralCallback
}

/**
 * Concrete generated topology. JSON-serializable EXCEPT the live `fn` field of
 * each {@link LiteralCallback} (serialization drops `fn` and keeps `source`); the
 * `source` round-trips losslessly and re-creates an equivalent callback.
 */
export interface TopologySpec {
  readonly name: string
  readonly stateAttribute: string
  readonly initialState: string
  readonly states: Readonly<Record<string, StateSpec>>
  readonly events: Readonly<Record<string, EventSpec>>
  /** Owner fields the closure-free probes touch (`log`, `k`, …) — seeds the adaptee. */
  readonly ownerSeed: Readonly<Record<string, unknown>>
}

/**
 * The deterministic scenario root. Pure in `(seed, spec, header.runtime)`: two
 * runs of the Step-3 driver on the same spec yield an identical `traceHash`.
 */
export interface ScenarioSpec {
  /** serialized bigint (R3); JSON-safe. */
  readonly seed: string
  readonly version: 1
  /** JSON-serializable; callbacks = closure-free literal-inlined source (R13). */
  readonly topology: TopologySpec
  readonly ops: readonly Op[]
  readonly faults: FaultPlan
  readonly bounds: Bounds
}
