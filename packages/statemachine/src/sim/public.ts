/**
 * @module sim/public
 * @unstable
 *
 * ADR-7/3/4/1 Step-10 PUBLIC `./sim` surface: the DI-first {@link wire} entry,
 * the inspectable {@link Simulator} driver, and the one-shot {@link runSimulation}
 * convenience. These are the consumer-facing symbols the `./sim` barrel
 * (`src/sim/index.ts`) re-exports; every symbol is `@unstable`.
 *
 * Engine symbols are imported ONLY via `../index` (ADR-7 c6). The harness never
 * touches engine private state: it drives the verified PUBLIC accessors
 * (`fireEvent`, `getQueueDepth`, `isProcessingEvents`, `getCurrentState`,
 * `getAvailableEvents`) plus the Step-2 `Adapter.set` capture seam and the
 * Step-3 {@link SimDriver}/{@link settleMacrostep} primitive. There is NO
 * `flush(N)`/`drainToQuiescence` here — `init()`/`step()`/`run()` delegate to the
 * single {@link settleMacrostep}.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * wire() — THE SANCTIONED DI-FIRST PATH (ADR-7 D2/D3, R17):
 *
 * `wire(env, config, owner)` ITSELF calls
 *   `new StateMachine(config, wrappedOwner, {clock,scheduler,monitor,errorHandler,logger})`
 * with ALL FIVE seams pre-forwarded, so the scheduler-omission footgun
 * (`schedulerProvided = options?.scheduler !== undefined` state_machine.ts:154 →
 * real `createDefaultScheduler()` :155, and real-time timer routing keyed off
 * `schedulerProvided` at :2199) is STRUCTURALLY impossible: there is no way to
 * call `wire()` without supplying `env.scheduler`. `owner` is wrapped by the
 * Step-2 `Adapter.set` capture seam before construction; the wrapped Adapter is
 * always passed as the EXPLICIT 2nd positional arg (ADR-7 c13), never the
 * `:469-471` unshift path.
 * ──────────────────────────────────────────────────────────────────────────
 */

import { MemoryAdapter, StateMachine, isAdapter } from '../index'
import type {
  Adapter,
  Clock,
  IErrorHandler,
  ILogger,
  IMonitor,
  ITimerScheduler,
  PropertiesOf,
  StateMachineConfig,
} from '../index'
import { wrapAdapterForCapture } from './capture'
import { type SimClock, makeSimClock } from './clock'
import { type Env, type SchedulerView, makeObservableScheduler } from './env'
import type { FaultPlan } from './faults'
import { buildPlanJitter, makeObservableSchedulerWithJitter } from './observable-scheduler'
import {
  type CheckerContext,
  type ConfigGraph,
  type Invariant,
  type Violation,
  INVARIANTS,
  buildConfigGraph,
  makeViolation,
} from './invariants'
import { runSafety } from './invariants.runner'
import { type LivenessResult, type LivenessSample, analyzeLiveness } from './liveness'
import { type RunGuardHandle, type RunGuardReport, installRunGuard } from './run-guard'
import { latencyStatsOf } from './metrics'
import type { PerfSample } from './metrics'
import { NoopLogger } from './noop-logger'
import { type Prng, makePrng } from './prng'
import { type DriverOp, SimDriver } from './driver'
import { settleMacrostep } from './settle'
import { SimErrorHandler } from './sim-error-handler'
import { SimMonitor } from './sim-monitor'
import { type CanonicalHeader, type CanonicalTrace, type TraceFrame, hashTrace, normalizeParts } from './trace'

// ============================================================================
// SimEnv — the FIVE deterministic seams + random/now. logger is FIRST-CLASS and
// NON-OPTIONAL (R18 / ADR-7 c8). All five map 1:1 to StateMachineOptions DI
// slots the harness forwards.
// ============================================================================
/** @unstable */
export interface SimEnv {
  /** -> StateMachineOptions.clock (types.ts:128). */
  readonly clock: Clock
  /** -> StateMachineOptions.scheduler (types.ts:120) — REQUIRED (omission unrepresentable). */
  readonly scheduler: ITimerScheduler
  /** -> StateMachineOptions.monitor (types.ts:119) — SimMonitor (reads no wall-clock). */
  readonly monitor: IMonitor
  /** -> StateMachineOptions.errorHandler (types.ts:121) — SimErrorHandler, isEnabled()===true. */
  readonly errorHandler: IErrorHandler
  /** -> StateMachineOptions.logger (types.ts:118) — NoopLogger; NON-OPTIONAL (R18). */
  readonly logger: ILogger
  /** PRNG-backed [0,1); never Math.random. */
  random(): number
  /** === clock(); never Date.now(). */
  now(): number
}

// ============================================================================
// SimTarget / SimSetup — consumer-supplied machine descriptor. {config,owner} is
// the SANCTIONED wire() path; {machine} is best-effort, validated by the
// behavioral sentinel probe in Simulator.init().
// ============================================================================
/** @unstable */
export type SimTarget<T extends object = object> =
  | { readonly config: StateMachineConfig<T>; readonly owner: T | Adapter<T> }
  | { readonly machine: StateMachine<T, StateMachineConfig<T>> }

/** @unstable */
export type SimSetup<T extends object = object> = (env: SimEnv) => SimTarget<T> | Promise<SimTarget<T>>

// ============================================================================
// Event payload (W8) — the object-payload substrate for fuzzing.
// ============================================================================

/**
 * The deterministic RNG a {@link SimEventPayload} generator draws from. Minimal
 * by design; structurally compatible with the {@link Prng} number facade and with
 * `check-machine.ts`'s public `Rng`.
 *
 * @unstable
 */
export interface SimPayloadRng {
  /** A float in [0,1). */
  float(): number
  /** An int in [0,max). */
  int(max: number): number
  /** Pick one element (throws on an empty array). */
  pick<A>(xs: readonly A[]): A
}

/**
 * What a payload generator SEES when it is asked for the next fire's arguments:
 * the SETTLED configuration reached before this step's op is chosen, plus the
 * live owner data. Without this the fuzzer is blind to state and can only emit
 * state-independent payloads (a verdict object is meaningful only relative to the
 * gate it is answering).
 *
 * @unstable
 */
export interface SimPayloadSnapshot {
  /** normalized '|'-sorted active configuration. */
  readonly config: string
  /** the active leaf/state string as the engine reports it. */
  readonly state: string
  /** the live owner data (read-only view); `{}` when the owner is not unwrappable. */
  readonly data: Readonly<object>
  readonly queueDepth: number
}

/**
 * Generate the arguments for the NEXT `fire` op. Called ONCE per fire opportunity,
 * AFTER the event has been picked, with a snapshot of the pre-fire settled state.
 *
 * **PRNG neutrality (mandatory contract).** The generator is handed a FORKED
 * child stream, never the driving PRNG: `Prng.fork(label)` derives the child from
 * `state()` WITHOUT advancing the parent (prng.ts), so however many draws a
 * payload generator makes, the op-selection stream is bit-for-bit unchanged. The
 * fork itself is created LAZILY on first use, so a run with NO `eventPayload`
 * performs ZERO extra PRNG work and reproduces the pre-W8 corpus byte-identically.
 *
 * Return `[]` for an event that takes no arguments.
 *
 * @unstable
 */
export type SimEventPayload = (
  event: string,
  rng: SimPayloadRng,
  snapshot: SimPayloadSnapshot,
) => readonly unknown[]

/**
 * Narrow the internal {@link Prng} to the minimal {@link SimPayloadRng} facade a
 * payload generator sees. Renames `nextFloat` → `float`; `int`/`pick` pass
 * through unchanged, so every draw goes through the SAME frozen splitmix64
 * primitives the rest of the sim uses (no second RNG implementation).
 */
function payloadRngOf(prng: Prng): SimPayloadRng {
  return {
    float: () => prng.nextFloat(),
    int: (max: number) => prng.int(max),
    pick: <A,>(xs: readonly A[]): A => prng.pick(xs),
  }
}

// ============================================================================
// SimOptions — seed is bigint|string (ADR-2 #4; bigint not JSON-able => string
// wire form). Optional fields use bare `?` under exactOptionalPropertyTypes:true.
// ============================================================================
/** @unstable */
export interface SimOptions {
  readonly seed: bigint | string
  readonly steps?: number
  readonly faults?: FaultPlan
  readonly invariants?: readonly Invariant[]
  /**
   * Verdict planes to run. `'safety'` (default) runs the invariant registry only;
   * `'liveness'` ALSO wires {@link analyzeLiveness} into the verdict (A4) and lets
   * the settle jump the clock; `'both'` runs safety AND liveness.
   */
  readonly mode?: 'safety' | 'liveness' | 'both'
  /**
   * The queue-depth bound to configure on the machine (StateMachineOptions.
   * maxQueueDepth, types.ts:156). When set, the engine enforces it AND the I-9
   * queue-depth-bound oracle checks the SAME bound e2e; when absent, I-9 is
   * vacuous (the engine default 1000 applies but no oracle bound is asserted).
   */
  readonly maxQueueDepth?: number
  /**
   * W8 object-payload substrate: generate the arguments for each fuzzed `fire`.
   * ABSENT (the default) ⇒ every fire is arg-free AND no PRNG draw is made for
   * payload, so the generated corpus stays byte-identical to pre-W8.
   */
  readonly eventPayload?: SimEventPayload
  readonly onTrace?: (frame: TraceFrame) => void
}

// ============================================================================
// StepOutcome — ISS-040: per-step deterministic inspectable trace surface. The
// `frames` are the content-only, '|'-normalized per-transition frames captured
// DURING this macrostep drain plus the single settle-boundary frame recorded
// AFTER it. NO wall-clock/duration/heap field (ADR-1 exclusion).
// ============================================================================
/** @unstable */
export interface StepOutcome {
  readonly step: number
  readonly t: number
  readonly frames: readonly TraceFrame[]
  readonly traceHash: string
  readonly quiescent: boolean
  readonly done: boolean
  readonly violation?: Violation
}

// ============================================================================
// SimViolation — a {@link Violation} plus the harness-origin `kind` discriminator
// (A1/A4 verdict plumbing). `kind` is ABSENT on an ordinary safety-invariant
// violation (backward-compatible: every SimViolation is a valid Violation) and
// present only on a SYNTHETIC verdict the harness itself raises:
//  - 'engine'   : an engine runtime error surfaced via monitor.recordError or a
//                 residual unhandledRejection (A1) — the run threw internally.
//  - 'liveness' : a livelock/timeout the liveness oracle caught (A4).
// ============================================================================
/** @unstable */
export type SimViolation = Violation & { readonly kind?: 'engine' | 'liveness' }

// ============================================================================
// SimWarning — a NON-fatal observability finding surfaced on the SimResult. It
// does NOT by itself flip `ok`; it tells the consumer the run left the sanctioned
// deterministic envelope (a real-timer escape) or is under-checked (no oracles).
// ============================================================================
/** @unstable */
export interface SimWarning {
  readonly kind: 'timer-escape' | 'unhandled-rejection' | 'no-oracles' | 'lifecycle-truncated'
  readonly message: string
  readonly count?: number
}

// ============================================================================
// SimResult — the one-shot run summary. seed is canonical string form.
// ============================================================================
/** @unstable */
export interface SimResult {
  readonly ok: boolean
  readonly seed: string
  readonly steps: number
  readonly traceHash: string
  readonly trace: readonly TraceFrame[]
  readonly violation?: SimViolation
  readonly metrics: PerfSample
  /**
   * How many ORACLES actually ran (A2 fail-open guard): the effective safety
   * invariants + the always-on engine-error channel + the liveness oracle when
   * enabled. A naive `runSimulation` with no invariants no longer executes ZERO
   * oracles — the default builtin registry is attached — so a structural
   * `ok:true` can never masquerade as "verified". Always `>= 1`.
   */
  readonly oraclesRun: number
  /**
   * The liveness verdict (A4) — present only when the run enabled the liveness
   * plane (`mode:'liveness'` or `'both'`).
   */
  readonly liveness?: LivenessResult
  /**
   * The livelock headline (A4): populated (non-empty) iff the liveness oracle
   * reached a non-`PROGRESSED` verdict (STUCK / TIMEOUT_BUDGET_EXCEEDED). Its
   * presence forces `ok:false`.
   */
  readonly livelocks?: readonly LivenessResult[]
  /** Non-fatal observability findings (A5 real-timer escape, residual rejection). */
  readonly warnings?: readonly SimWarning[]
}

/**
 * The DEFAULT builtin oracle set attached when a `runSimulation`/`Simulator` caller
 * supplies NO `invariants` (A2 fail-open fix). Every member is SOUND on a
 * legitimate machine — it can never false-positive on a correct run. The always-on
 * engine-error channel (A1) supplements this set.
 *
 * Membership decisions:
 *  - I-9 is INCLUDED (W5b): after the A3 fix it only fires on a QUIESCENT boundary
 *    whose combined queue exceeds an explicitly-configured `maxQueueDepth`, and it
 *    is VACUOUS when no bound is set (the default path sets none) — sound and inert.
 *  - I-3 is now INCLUDED (W8/V8) — ISS-030 CLOSED. C1 + U1 had already made
 *    WAITING_ON_TIMER and (precise, inFlight>0) WAITING_ON_TRANSITION_TIMEOUT sound
 *    exclusions; the one reachable false-positive left was ISS-030: a STRING-METHOD
 *    invoke action is resolved INSIDE `callAction`, past the config-layer wrap
 *    boundary, so `bracketAsync` could not see it and a correct machine awaiting one
 *    settled as `pending ∧ inFlight===0` → WAITING_ON_INTERNAL → I-3 fires on a
 *    CORRECT machine. The W8/V1b lifecycle channel wraps the CALL instead of the
 *    action VALUE, so `invoke.action` begin/end pairs cover the string-method form
 *    identically; driver.ts composes that count into `Env.inFlightAsyncCount`, and
 *    such a boundary is now classified WAITING_ON_TRANSITION_TIMEOUT (excluded) or
 *    reaches true quiescence. Guarded by the §4а.2 zero-false-positive corpus, which
 *    carries string-method-invoke and composite-join machines specifically for this.
 *  - I-4 is INCLUDED (W8/V3a): it reads the CAPTURED lifecycle stream and fires only
 *    on a genuine in-microstep ancestor/descendant inversion. It is VACUOUS when no
 *    lifecycle plane is present, so it cannot fabricate a violation.
 *  - I-5 is EXCLUDED: it remains a documented no-op (the `done.state.<C>` RAISE is
 *    still not soundly observable — see invariants.ts), so including it adds nothing.
 */
const DEFAULT_BUILTIN_INVARIANT_IDS: ReadonlySet<string> = new Set([
  'I-2',
  'I-3',
  'I-4',
  'I-6',
  'I-7',
  'I-9',
  'I-10',
  'I-11',
  'I-12',
])

/** The resolved default builtin registry (filtered {@link INVARIANTS}). */
const DEFAULT_INVARIANTS: readonly Invariant[] = INVARIANTS.filter((i) =>
  DEFAULT_BUILTIN_INVARIANT_IDS.has(i.id),
)

/**
 * Virtual-time budget handed to {@link analyzeLiveness}. Generous and finite: the
 * verdict plane leans on the configuration-cycle / self-loop detectors (A4), not a
 * tight timeout, so the budget only needs to dominate any legitimate armed-timer
 * chain a simulated run reaches. Kept well below Number.MAX_SAFE_INTEGER so a
 * genuine runaway virtual-time chain still trips TIMEOUT_BUDGET_EXCEEDED.
 */
const LIVENESS_VIRTUAL_BUDGET_MS = 1_000_000_000

// ============================================================================
// SimSnapshot — serializable mid-run checkpoint. Engine state via StateMachine
// .toJSON() (NOT toSecureJSON), the PRNG state(), and the logical clock. NEVER
// hashed (toJSON bytes are not a determinism contract for inline-fn configs).
// ============================================================================
/** @unstable */
export interface SimSnapshot {
  readonly seed: string
  readonly machine: string
  readonly prngState: string
  readonly t: number
  readonly step: number
}

/**
 * THE SANCTIONED DI-FIRST PATH (ADR-7 D2/D3, R17). Constructs
 * `new StateMachine(config, wrappedOwner, {all five seams})` — every DI slot
 * pre-forwarded from `env`, so the scheduler-omission footgun is structurally
 * impossible. `owner` is wrapped by the Step-2 capture seam before construction.
 *
 * @returns the constructed engine machine (post-construction enter actions are
 *   floating microtasks; the caller settles via {@link settleMacrostep}).
 */
export function wire<T extends object>(
  env: SimEnv,
  config: StateMachineConfig<T>,
  owner: T | Adapter<T>,
): StateMachine<T, StateMachineConfig<T>> {
  // Normalize the owner to an Adapter, then wrap it with the capture seam so
  // every engine state-write is observable. wire() itself is sink-less (it proves
  // the FIVE-seam construction path); the Simulator supplies its own live sink.
  const adapter: Adapter<T> = isAdapter<T>(owner)
    ? (owner as Adapter<T>)
    : (new MemoryAdapter<T>(owner as T) as unknown as Adapter<T>)
  const wrapped = wrapAdapterForCapture(adapter, config.stateAttribute, { onStateWrite() {} })
  // ALL FIVE seams forwarded together (ADR-3 c1). Omission is unrepresentable:
  // every field of SimEnv is non-optional, so a missing scheduler cannot reach
  // this call. The wrapped adapter is structurally a valid Adapter; the cast
  // bridges Adapter<T> -> Adapter<PropertiesOf<T>> (the seam never touches the
  // properties/methods split).
  return new StateMachine<T, StateMachineConfig<T>>(config, wrapped as unknown as Adapter<PropertiesOf<T>>, {
    clock: env.clock,
    scheduler: env.scheduler,
    monitor: env.monitor,
    errorHandler: env.errorHandler,
    logger: env.logger,
  })
}

/**
 * The concrete harness scheduler control surface (always implements `process`,
 * unlike the optional-`process` engine `ITimerScheduler`). {@link makeObservableScheduler}
 * returns exactly this shape; the driver and the sentinel probe drive it.
 */
type HarnessScheduler = {
  process(now?: number): void
  isActive(): boolean
  schedule(d: number, cb: () => void): object
  cancel(t: object): void
}

/**
 * Assemble a default {@link SimEnv} from a seeded {@link Prng} and a fresh
 * {@link SimClock}/virtual scheduler. The five seams are the Step-2/3
 * deterministic components. `random()` draws from the PRNG; `now()` reads the
 * logical clock.
 */
function makeSimEnv(
  prng: Prng,
  clock: SimClock,
  faults?: FaultPlan,
): { env: SimEnv; view: SchedulerView; scheduler: HarnessScheduler } {
  // When a non-empty fault plan is wired, build the scheduler with the plan's
  // seed-derived timer-jitter (via fork('faults')) so timer-jitter faults ACTUALLY
  // perturb armed timers while staying deterministic. Otherwise the plain Step-3
  // shim (identity jitter). Both expose the SAME SchedulerView shape.
  const hasFaults = faults !== undefined && faults.faults.length > 0
  const { scheduler, view } = hasFaults
    ? makeObservableSchedulerWithJitter(clock, buildPlanJitter(faults, prng.fork('faults')).jitterFn)
    : makeObservableScheduler(clock)
  // The shim's scheduler always implements process/isActive/schedule/cancel; the
  // SimEnv.scheduler type (ITimerScheduler) widens process to optional, so keep a
  // concrete reference for the driver + the sentinel probe's settleMacrostep.
  const concrete = scheduler as unknown as HarnessScheduler
  const env: SimEnv = {
    clock: clock.now,
    scheduler,
    monitor: new SimMonitor(),
    errorHandler: new SimErrorHandler(),
    logger: NoopLogger,
    random(): number {
      return prng.nextFloat()
    },
    now(): number {
      return clock.now()
    },
  }
  return { env, view, scheduler: concrete }
}

/** Coerce the seed (bigint|string) to a canonical bigint for {@link makePrng}. */
function seedToBigInt(seed: bigint | string): bigint {
  return typeof seed === 'bigint' ? seed : BigInt(seed)
}

/** A zeroed {@link PerfSample} for the public SimResult (the perf plane is Step 8). */
function zeroMetrics(traceLen: number): PerfSample {
  return {
    wallNs: 0n,
    eventsProcessed: 0,
    transitionsObserved: 0,
    eventsPerSec: 0,
    transitionsPerSec: 0,
    latency: latencyStatsOf([]),
    heapPeakBytes: 0,
    heapAvgBytes: 0,
    heapEndBytes: 0,
    gcProxy: 0,
    traceLen,
    queueDepthPeak: 0,
  }
}

/** An empty canonical header for the degenerate zero-step run. */
function emptyHeader(seed: string): CanonicalHeader {
  return {
    seed,
    configHash: '',
    engine: '@vedmalex/statemachine',
    // '4': kept in lockstep with the driver's canonical header (C1 settleReason +
    // U1 WAITING_ON_INTERNAL re-semantization + W8/V5b doneDelta now populated on
    // the verdict path). See driver.ts for the full version rationale.
    version: '4',
    runtime: 'node-sim-v1',
    prngVersion: 'splitmix64-bigint-v1',
    errorHandlerEnabled: true,
  }
}

/** A throwaway {@link Env} for the sentinel probe (no in-flight async to track). */
function makeProbeEnv(view: SchedulerView): Env {
  return {
    inFlightAsyncCount(): number {
      return 0
    },
    enterAsync(): void {},
    exitAsync(): void {},
    schedulerEmptyAt: view.schedulerEmptyAt,
    earliestExecuteAt: view.earliestExecuteAt,
  }
}

/**
 * The inspectable driver. `init()` runs the MANDATORY post-construction
 * {@link settleMacrostep} (ADR-4 c7) + the behavioral sentinel scheduler probe
 * (ADR-7 D3): it arms a harness-owned sentinel timer through `env.scheduler`,
 * advances the clock, processes the scheduler, drives EXACTLY ONE bounded
 * `settleMacrostep`, and asserts the sentinel fired through `env.scheduler`
 * (NOT real `setTimeout`); if pending it FAILS LOUDLY. `step()` advances exactly
 * ONE macrostep and returns its {@link StepOutcome} (ISS-040). `step()`/`run()`/
 * `init()` delegate to the SINGLE {@link settleMacrostep}; no `flush(N)`.
 *
 * @unstable
 */
export class Simulator<T extends object = object> {
  private readonly clock: SimClock
  private readonly prng: Prng
  private readonly seedString: string
  private readonly schedulerView: SchedulerView
  private readonly scheduler: HarnessScheduler
  private readonly _env: SimEnv
  private readonly stepBudget: number
  private readonly policy: 'safety' | 'liveness'
  /** True iff the liveness plane is wired into the verdict (mode 'liveness'|'both'). */
  private readonly livenessEnabled: boolean
  /** Number of declared config states — the {@link analyzeLiveness} cycle window K = stateCount + 1. */
  private stateCount = 1
  private readonly onTrace?: (frame: TraceFrame) => void
  /**
   * The consumer-supplied SAFETY invariants (opts.invariants). Threaded into the
   * BLIND {@link runSafety} registry evaluated against the accumulating canonical
   * trace at each {@link step} boundary. Empty when the caller passes none.
   */
  private readonly invariants: readonly Invariant[]
  /**
   * The consumer-supplied {@link FaultPlan} (opts.faults). Threaded into the
   * {@link SimDriver} so faults ACTUALLY fire during the run (Step 5 integration).
   * Empty when the caller passes none — the run then behaves exactly as a
   * fault-free simulation. The frozen public `SimOptions.faults` field becomes
   * live here.
   */
  private readonly faults: FaultPlan
  /**
   * The consumer-supplied queue-depth bound (opts.maxQueueDepth). Threaded to the
   * machine (the engine enforces it) AND the {@link CheckerContext} (I-9 asserts
   * the SAME bound). Absent ⇒ I-9 vacuous (A3).
   */
  private readonly maxQueueDepth: number | undefined
  /**
   * W8: the consumer-supplied payload generator (opts.eventPayload). Absent ⇒ the
   * arg-free pre-W8 behavior AND zero payload PRNG work.
   */
  private readonly eventPayload: SimEventPayload | undefined
  /**
   * The FORKED payload RNG facade. Created LAZILY on the first payload draw so a
   * run without `eventPayload` never touches it. `fork` reads `state()` WITHOUT
   * advancing the parent (prng.ts), so even creating it cannot perturb the
   * op-selection stream.
   */
  private payloadRng?: SimPayloadRng
  /** The resolved owner adapter, kept so a payload snapshot can read live data. */
  private ownerAdapter?: Adapter<T>

  private driver?: SimDriver<T>
  private machine?: StateMachine<T, StateMachineConfig<T>>
  private initialized = false
  private stepCount = 0
  /**
   * The pure {@link CheckerContext} (config graph + trace header) the invariant
   * checkers receive. Built ONCE in {@link init} from the resolved config + the
   * driver's canonical header; absent until init (and when no invariants run).
   */
  private checkerCtx?: CheckerContext
  /**
   * The lowest-step {@link Violation} seen so far across all evaluated steps
   * (SAFETY semantics: first/lowest-step violation wins). `undefined` until a
   * violation is observed.
   */
  private firstViolation?: Violation

  constructor(
    private readonly setup: SimSetup<T>,
    opts: SimOptions,
  ) {
    const seed = seedToBigInt(opts.seed)
    this.prng = makePrng(seed)
    this.seedString = seed.toString()
    this.clock = makeSimClock(0)
    this.faults = opts.faults ?? { faults: [] }
    const { env, view, scheduler } = makeSimEnv(this.prng, this.clock, this.faults)
    this._env = env
    this.schedulerView = view
    this.scheduler = scheduler
    this.stepBudget = opts.steps ?? 16
    // mode 'both' and 'liveness' both wire the liveness plane; only 'liveness'/'both'
    // let the settle jump the clock (SettlePolicy has no 'both' — map it to 'liveness').
    this.livenessEnabled = opts.mode === 'liveness' || opts.mode === 'both'
    this.policy = this.livenessEnabled ? 'liveness' : 'safety'
    // A2 fail-open fix: a caller that supplies NO invariants gets the DEFAULT builtin
    // registry, so a run always executes real oracles (never a rubber structural ok).
    this.invariants = opts.invariants ?? DEFAULT_INVARIANTS
    // A3 (I-9): the configured queue-depth bound, exposed on SimOptions so the
    // queue-overflow oracle has a live bound e2e. Threaded to BOTH the machine
    // (StateMachineOptions.maxQueueDepth — the engine actually enforces it) AND the
    // CheckerContext (I-9 reads the SAME bound) so a flood past the bound is caught,
    // not silently accepted. Absent ⇒ I-9 stays vacuous (documented, not fake).
    this.maxQueueDepth = opts.maxQueueDepth
    // W8: absent ⇒ arg-free fuzzing, and `pickOp` makes ZERO extra PRNG draws.
    this.eventPayload = opts.eventPayload
    if (opts.onTrace) {
      this.onTrace = opts.onTrace
    }
  }

  /** The harness environment (the five seams + random/now). */
  get env(): SimEnv {
    return this._env
  }

  /**
   * MANDATORY post-construction drain (ADR-4 c7) + behavioral sentinel scheduler
   * probe (ADR-7 D3). Idempotent.
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return
    }
    const target = await this.setup(this._env)
    const resolved = this.resolveTarget(target)
    // Kept for the W8 payload snapshot (live owner data). Read-only use.
    this.ownerAdapter = resolved.owner

    // Build the Step-3 driver over the resolved {config, owner}. The driver
    // forwards all five seams (it never omits scheduler) — the DI-first
    // construction path wire() exercises is mirrored structurally here.
    const driver = new SimDriver<T>({
      config: resolved.config,
      owner: resolved.owner,
      clock: this.clock,
      scheduler: this.scheduler,
      schedulerView: this.schedulerView,
      monitor: this._env.monitor as SimMonitor,
      errorHandler: this._env.errorHandler as SimErrorHandler,
      logger: this._env.logger,
      prng: this.prng,
      runtime: 'node-sim-v1',
      policy: this.policy,
      ...(this.onTrace ? { onFrame: this.onTrace } : {}),
      // The frozen public SimOptions.faults field becomes LIVE here: a non-empty
      // plan is threaded into the driver so faults ACTUALLY fire during the run.
      ...(this.faults.faults.length > 0 ? { faults: this.faults } : {}),
      // A3 (I-9): forward the queue-depth bound so the engine enforces it.
      ...(this.maxQueueDepth !== undefined ? { maxQueueDepth: this.maxQueueDepth } : {}),
    })
    this.driver = driver
    this.machine = driver.machine

    // Build the pure CheckerContext ONCE (only when the caller wants the SAFETY
    // path). The graph is the config-derived structural view; the header is the
    // driver's canonical trace header (same seed/runtime the hash uses). Empty
    // invariants ⇒ no context (runSafety is never called), so a clean run keeps
    // ok:true / violation:undefined.
    // The config graph is built once: it supplies both the safety CheckerContext
    // (when invariants run) and the liveness cycle-window K = stateCount + 1 (A4).
    const graph: ConfigGraph = buildConfigGraph(resolved.config)
    this.stateCount = Math.max(1, graph.states.size)
    if (this.invariants.length > 0) {
      this.checkerCtx = {
        graph,
        header: driver.trace().header,
        // A3 (I-9): give the queue-depth oracle the SAME bound the engine enforces.
        ...(this.maxQueueDepth !== undefined ? { maxQueueDepth: this.maxQueueDepth } : {}),
        // W8/V3a: the CAPTURED lifecycle observation stream, handed to the checkers
        // BY REFERENCE so this once-built context observes the run as it grows. It
        // is not a live engine read — the monitor seam recorded these during the
        // drain, exactly like the doneDelta projection.
        lifecycle: (this._env.monitor as SimMonitor).getLifecycle(),
      }
    }

    // (1) MANDATORY post-construction drain (delegates to settleMacrostep).
    await driver.init()

    // (2) Behavioral sentinel scheduler probe.
    await this.runSentinelProbe()

    this.initialized = true
  }

  /**
   * Drive exactly ONE macrostep and return its {@link StepOutcome}. Picks the
   * next op from the available-event set (PRNG-driven); falls back to noop when
   * the machine is quiescent with no available events.
   */
  async step(): Promise<StepOutcome> {
    if (!this.initialized || !this.driver) {
      throw new Error('Simulator.step() called before init()')
    }
    const op = this.pickOp()
    const result = await this.driver.step(op)
    this.stepCount += 1
    const trace = this.driver.trace()
    // SAFETY: evaluate the BLIND invariant registry against the accumulating
    // canonical trace at this step boundary and track the lowest-step violation
    // seen SO FAR (first-violation-wins). runSafety returns at-most-one violation
    // (lowest-step checkStep else first checkFinal); we keep the lowest across all
    // steps so StepOutcome.violation is monotone in severity, not last-write.
    this.evaluateSafety(trace)
    return {
      step: result.step,
      t: result.t,
      frames: result.frames,
      traceHash: hashTrace(trace),
      quiescent: result.quiescent,
      done: this.computeDone(result.quiescent),
      ...(this.firstViolation !== undefined ? { violation: this.firstViolation } : {}),
    }
  }

  /**
   * Run the BLIND {@link runSafety} sweep over the accumulating canonical trace
   * and fold its at-most-one {@link Violation} into {@link firstViolation},
   * keeping the LOWEST-step one (SAFETY first-violation-wins). No-op when the
   * caller supplied no invariants (no {@link checkerCtx}).
   */
  private evaluateSafety(trace: CanonicalTrace): void {
    if (this.checkerCtx === undefined) {
      return
    }
    const v = runSafety(this.invariants, trace, this.checkerCtx)
    if (v !== null && (this.firstViolation === undefined || v.step < this.firstViolation.step)) {
      this.firstViolation = v
    }
  }

  /**
   * Drive `opts.steps` macrosteps and return the aggregate {@link SimResult}.
   * Always `await init()` first if not already initialized.
   */
  async run(): Promise<SimResult> {
    // Install the run-window guard BEFORE init(): a consumer onEnter can arm a real
    // timer (A5 escape) or throw an internal event (A1) DURING the post-construction
    // drain, which init() runs. runSimulation delegates here so init() is inside the
    // window. The guard is torn down in `finally` regardless of outcome.
    const guard: RunGuardHandle = installRunGuard()
    let guardReport: RunGuardReport
    try {
      if (!this.initialized) {
        await this.init()
      }
      for (let i = 0; i < this.stepBudget; i++) {
        await this.step()
      }
    } finally {
      guardReport = guard.stop()
    }

    const trace: CanonicalTrace = this.driver?.trace() ?? { header: emptyHeader(this.seedString), frames: [] }
    // Final SAFETY sweep so a checkFinal-scoped violation is caught even at a zero
    // step budget (where the per-step loop never ran).
    this.evaluateSafety(trace)
    return this.assembleResult(trace, guardReport)
  }

  /**
   * Fold the SAFETY sweep result together with the A1 engine-error channel, the A4
   * liveness verdict, and the A5 escape warnings into the {@link SimResult}. This is
   * where the run stops giving a FALSE ok: a recorded engine error, a residual
   * unhandled rejection, or a livelock all force `ok:false`, and `oraclesRun`
   * records that real oracles ran (never a rubber structural ok).
   */
  private assembleResult(trace: CanonicalTrace, guardReport: RunGuardReport): SimResult {
    const noFaults = this.faults.faults.length === 0

    // ── A1: engine-error channel. After W1 the engine routes an internal invalid/
    // throwing event to monitor.recordError (no process rejection remains); a
    // RESIDUAL genuine unhandledRejection is captured by the run guard. Either — on
    // a NON-fault run (a fault run carries its OWN oracles for EXPECTED errors) — is
    // a synthetic 'engine' violation the verdict must see.
    const errorCount = (this._env.monitor as SimMonitor).getErrorCount()
    const unhandled = guardReport.unhandledRejections
    let engineViolation: SimViolation | undefined
    if (noFaults && (errorCount > 0 || unhandled.length > 0)) {
      const reason =
        errorCount > 0
          ? `engine recorded ${errorCount} runtime error(s) via monitor.recordError`
          : `${unhandled.length} unhandled rejection(s) escaped the run`
      const base = makeViolation({
        invariantId: 'engine-error',
        step: 0,
        witness: this.safeCurrentConfig(),
        errorClass: 'invalid-event',
        message: `engine runtime error during simulation: ${reason}`,
        observed: reason,
        expected: 'no engine runtime error / unhandled rejection',
      })
      engineViolation = { ...base, kind: 'engine' }
    }

    // ── A4/C2: liveness plane wired into the verdict when enabled (mode
    // 'liveness'|'both'). A non-PROGRESSED verdict (STUCK / TIMEOUT_BUDGET_EXCEEDED)
    // becomes a livelocks[] headline and forces ok:false. C2 (progress-aware
    // self-loop) must precede this so a legitimate progressing self-loop is not a
    // false STUCK once analyzeLiveness is authoritative for the verdict.
    let liveness: LivenessResult | undefined
    let livelocks: readonly LivenessResult[] | undefined
    if (this.livenessEnabled) {
      const samples = buildLivenessSamples(trace.frames)
      liveness = analyzeLiveness(samples, {
        stateCount: this.stateCount,
        budgetVirtualMs: LIVENESS_VIRTUAL_BUDGET_MS,
      })
      if (liveness.verdict !== 'PROGRESSED') {
        livelocks = [liveness]
      }
    }

    // ── A5: real-timer escape warning + residual-rejection observability.
    const warnings: SimWarning[] = []
    // W8 (critic A-2): the lifecycle buffer is bounded, and I-4 keys its ordering
    // predicate on that stream — a truncated prefix is a FALSE-NEGATIVE window for
    // the oracle. Silence would make the run look more verified than it is, so the
    // truncation is surfaced rather than left to an unread accessor.
    if ((this._env.monitor as SimMonitor).isLifecycleTruncated?.()) {
      warnings.push({
        kind: 'lifecycle-truncated',
        message:
          'the lifecycle observation buffer was truncated: the ordering oracle (I-4) saw only a PREFIX of the callback stream, so a late ordering violation could have been missed',
      })
    }
    if (guardReport.timerEscapes > 0) {
      warnings.push({
        kind: 'timer-escape',
        message: `${guardReport.timerEscapes} real timer(s) armed outside the virtual scheduler (escaped env.scheduler); quiescence cannot see them`,
        count: guardReport.timerEscapes,
      })
    }
    if (unhandled.length > 0) {
      warnings.push({
        kind: 'unhandled-rejection',
        message: `${unhandled.length} unhandled rejection(s) observed during the run window`,
        count: unhandled.length,
      })
    }

    // ── A2: oracle count. Always >= 1 — the engine-error channel is always on —
    // so a structural ok:true can never masquerade as "verified".
    const oraclesRun = this.invariants.length + 1 + (this.livenessEnabled ? 1 : 0)

    // The engine error dominates a safety-invariant violation for the REPORTED
    // `violation` (it is the more fundamental fault); either it, a safety violation,
    // or a livelock forces ok:false.
    const primary: SimViolation | undefined = engineViolation ?? this.firstViolation
    const ok = primary === undefined && livelocks === undefined

    return {
      ok,
      seed: this.seedString,
      steps: this.stepCount,
      traceHash: hashTrace(trace),
      trace: trace.frames,
      oraclesRun,
      ...(primary !== undefined ? { violation: primary } : {}),
      ...(liveness !== undefined ? { liveness } : {}),
      ...(livelocks !== undefined ? { livelocks } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      metrics: zeroMetrics(trace.frames.length),
    }
  }

  /** Current normalized config for a synthetic-violation witness (never throws). */
  private safeCurrentConfig(): string {
    try {
      return this.machine?.getCurrentState() ?? ''
    } catch {
      return ''
    }
  }

  /**
   * Serializable mid-run checkpoint. Engine state via `toJSON()` (NOT
   * toSecureJSON), the PRNG state, the logical clock. NEVER hashed.
   *
   * KNOWN GAP (W8, latent until restore lands): the checkpoint captures the
   * DRIVING prng state but NOT the lazily-forked `event-payload` child stream. No
   * public `restore` exists yet, so nothing breaks today — but a restore
   * implementation must also carry the payload child's state, otherwise a
   * payload-heavy run resumed from a snapshot re-forks from the restored parent
   * and diverges from the uninterrupted run.
   */
  snapshot(): SimSnapshot {
    if (!this.machine) {
      throw new Error('Simulator.snapshot() called before init()')
    }
    return {
      seed: this.seedString,
      machine: this.machine.toJSON(),
      prngState: this.prng.state().toString(),
      t: this.clock.now(),
      step: this.stepCount,
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Resolve a {@link SimTarget} to the {config, owner} the driver needs. */
  private resolveTarget(target: SimTarget<T>): { config: StateMachineConfig<T>; owner: Adapter<T> } {
    if ('machine' in target) {
      // Best-effort {machine}: the engine exposes no public config getter, so we
      // cannot re-derive a {config, owner}. v1 freezes {machine} as best-effort:
      // the behavioral sentinel probe still validates timer routing, but stepping
      // requires the sanctioned {config, owner} path. Fail loudly so callers do
      // not silently get an undriveable machine.
      throw new Error(
        'Simulator: the {machine} SimTarget is best-effort and not driveable in v1 — supply {config, owner} (the sanctioned wire() path) for a stepping simulation.',
      )
    }
    const owner: Adapter<T> = isAdapter<T>(target.owner)
      ? (target.owner as Adapter<T>)
      : (new MemoryAdapter<T>(target.owner as T) as unknown as Adapter<T>)
    return { config: target.config, owner }
  }

  /**
   * Behavioral sentinel scheduler probe (ADR-7 D3). Arm a sentinel timer through
   * `env.scheduler`, advance the clock to its deadline, process the scheduler,
   * drive EXACTLY ONE bounded `settleMacrostep`, and assert the sentinel fired.
   * If still pending → FAIL LOUDLY (timers did not route through env.scheduler).
   * Bounded (`maxTurns`): it never awaits a real timer, so it cannot hang.
   */
  private async runSentinelProbe(): Promise<void> {
    const SENTINEL_DELAY = 1
    let fired = false
    const at = this.clock.now() + SENTINEL_DELAY
    // Arm THROUGH env.scheduler — the verified DI scheduler seam. If a machine
    // were constructed without a scheduler it would route to real setTimeout and
    // this token would never fire within the bounded settle below.
    const token = this.scheduler.schedule(SENTINEL_DELAY, () => {
      fired = true
    })
    this.clock.set(at)
    this.scheduler.process(this.clock.now())
    if (!this.machine) {
      this.scheduler.cancel(token)
      throw new Error('Simulator.runSentinelProbe(): machine not constructed')
    }
    await settleMacrostep({
      sm: this.machine,
      scheduler: this.scheduler,
      clock: this.clock,
      env: makeProbeEnv(this.schedulerView),
      policy: 'safety',
      maxTurns: 64,
    })
    if (!fired) {
      this.scheduler.cancel(token)
      throw new Error(
        'Simulator.init(): behavioral sentinel scheduler probe FAILED — the harness sentinel timer did not fire through env.scheduler within one bounded settleMacrostep. Timers are not routed through the injected virtual scheduler (scheduler-omission footgun).',
      )
    }
  }

  /**
   * Pick the next op (ISS-040 deterministic driving). Probes the available-event
   * set; PRNG-picks one to fire, else a noop.
   *
   * W8 payload: when (and ONLY when) `opts.eventPayload` is supplied, the picked
   * event's arguments are drawn from it. The generator sees the pre-fire settled
   * snapshot and draws from a FORKED child PRNG, so the op-selection stream is
   * untouched no matter how many draws it makes. With no `eventPayload` the args
   * stay `[]` and NOT ONE extra PRNG draw happens — the pre-W8 generated corpus
   * replays byte-identically.
   *
   * The arg list is never positionally ambiguous with an Adapter: the driver
   * always passes the wrapped Adapter EXPLICITLY as the 2nd positional arg, so
   * payload values start at position 3 and the `:469-471` unshift branch is
   * unreachable (driver.ts module doc).
   */
  private pickOp(): DriverOp {
    const sm = this.machine
    if (!sm) {
      return { kind: 'noop' }
    }
    let available: string[]
    try {
      available = sm.getAvailableEvents()
    } catch {
      available = []
    }
    // `done.state.<C>` is ENGINE-RAISED (edge-triggered on an all-final join). The
    // engine does not special-case it in `canFireEvent`, so it shows up in the
    // available set and used to be drawn like any other event — letting the fuzzer
    // force a join the real system could never reach at that moment, and thereby
    // FALSELY breaking a consumer invariant that legitimately assumes "join only
    // after every region completed". Excluding it costs no coverage: the internal
    // raise path exercises the join for real, and I-12 still audits declaration.
    available = available.filter((e) => !e.startsWith('done.state.'))
    if (available.length === 0) {
      return { kind: 'noop', opId: `sim-op-${this.stepCount}` }
    }
    const event = this.prng.pick(available)
    const args = this.drawPayload(event)
    // Stable per-step op-id so the driver can resolve a per-op channel fault keyed
    // by `opId` (a plan may target `sim-op-<n>`). R22 stable op-id addressing.
    return { kind: 'fire', event, args, opId: `sim-op-${this.stepCount}` }
  }

  /**
   * Draw the payload for `event`, or `[]` when no generator is wired.
   *
   * PRNG neutrality is structural, not incidental: the early return happens
   * BEFORE any PRNG interaction, and the child stream is obtained via
   * {@link Prng.fork}, which derives from `state()` without advancing the parent.
   * A generator that throws is NOT swallowed — a broken payload generator is a
   * consumer bug that must surface loudly, never as silently arg-free fuzzing
   * (which would look like passing coverage).
   */
  private drawPayload(event: string): readonly unknown[] {
    const gen = this.eventPayload
    if (gen === undefined) {
      return []
    }
    if (this.payloadRng === undefined) {
      // `fork` derives the child from `state()` WITHOUT advancing the parent
      // (prng.ts), so creating this stream cannot shift op selection.
      this.payloadRng = payloadRngOf(this.prng.fork('event-payload'))
    }
    return gen(event, this.payloadRng, this.payloadSnapshot())
  }

  /** The pre-fire settled snapshot handed to a {@link SimEventPayload}. */
  private payloadSnapshot(): SimPayloadSnapshot {
    const sm = this.machine
    let state = ''
    try {
      state = sm?.getCurrentState() ?? ''
    } catch {
      state = ''
    }
    let queueDepth = 0
    try {
      const q = sm?.getQueueDepth()
      queueDepth = q ? q.internal + q.external : 0
    } catch {
      queueDepth = 0
    }
    // The owner data behind the adapter (MemoryAdapter exposes `adaptee`,
    // types.ts:561); a consumer adapter without one yields `{}` rather than a
    // throw — the generator can still see config/state/queueDepth.
    const maybe = this.ownerAdapter as unknown as { adaptee?: object } | undefined
    const data: Readonly<object> = maybe?.adaptee ?? {}
    return { config: normalizeParts(state), state, data, queueDepth }
  }

  /**
   * Compute `done` WITHOUT a live `sm.isDone(compositeId)` call (which requires a
   * compositeId — state_machine.ts:1433). A machine with no available events at a
   * quiescent boundary has reached a terminal configuration; that is the public
   * "done" signal (the invariant/doneDelta plumbing is the Step-6 oracle path,
   * not the public Simulator surface).
   */
  private computeDone(quiescent: boolean): boolean {
    const sm = this.machine
    if (!sm || !quiescent) {
      return false
    }
    try {
      return sm.getAvailableEvents().length === 0
    } catch {
      return false
    }
  }
}

/**
 * Build the per-step {@link LivenessSample} stream the {@link analyzeLiveness}
 * oracle consumes from the accumulated canonical trace (A4). ONE sample per
 * logical STEP: the driver emits, per step, N per-transition seam frames PLUS
 * exactly one settle-boundary frame (driver.ts:487-512), all sharing the same
 * `step`. Only the boundary frame carries the step's SETTLED observation — the
 * final config `to`, the settle-time queue depth, and the step's `fireOutcome`.
 * Timer observables are not carried per-frame in the content-only trace, so
 * `pendingTimers`/`earliestTimerAt` read the no-pending-timer default — the
 * cycle/self-loop detectors key on config + queue progress, which the trace DOES
 * carry.
 */
function buildLivenessSamples(frames: readonly TraceFrame[]): LivenessSample[] {
  // Collapse to ONE boundary frame PER STEP — the LAST frame of each contiguous
  // same-`step` run (`step` is monotonic non-decreasing and contiguous; the
  // boundary frame is pushed AFTER the step's seam frames). Feeding every frame
  // 1:1 made a step's intra-step seam+boundary pair share a progress fingerprint
  // and FALSELY trip the config-cycle / self-loop detectors on a machine that in
  // fact terminates (a resolve-true step looked like "the same config twice").
  //
  // NOTE: an earlier fix collapsed by (config, queueDepth) across step BOUNDARIES
  // — that ALSO erased a genuine single-state `s1 --E--> s1` self-loop (its every
  // step shares one fingerprint), turning a real livelock into a false PROGRESSED
  // (a false-NEGATIVE, the worst class for a sim oracle). Collapsing PER STEP is
  // the correct grain: a real self-loop / A<->B livelock repeats its fingerprint
  // across DISTINCT steps, which survive here as distinct samples for the
  // cross-step detectors. (W5a A4 fix.)
  const boundaries: TraceFrame[] = []
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    if (f === undefined) {
      continue
    }
    const next = frames[i + 1]
    if (next === undefined || next.step !== f.step) {
      boundaries.push(f)
    }
  }
  return boundaries.map((f, i) => {
    const prev = i > 0 ? boundaries[i - 1] : undefined
    // TERMINAL derived HONESTLY from the settle boundary — NEVER from position: a
    // quiescent boundary whose captured `doneDelta` marks EVERY declared composite
    // done is a genuine terminal configuration. Absent doneDelta (a single-leaf
    // final with no declared composite) leaves terminal=false, which is SAFE — a
    // truly terminated machine issues no resolve-true fire (getAvailableEvents()
    // is empty -> a noop step with no fireOutcome), so the STUCK rules (which gate
    // on fireOutcome==='resolve-true') never fire on it.
    const terminal =
      f.quiescent === true &&
      f.doneDelta !== undefined &&
      f.doneDelta.length > 0 &&
      f.doneDelta.every((d) => d.done)
    return {
      config: f.to,
      queueDepth: f.queue.internal + f.queue.external,
      pendingTimers: 0,
      earliestTimerAt: null,
      configChanged: prev === undefined ? true : f.to !== prev.to,
      healthy: true,
      inFlight: false,
      terminal,
      t: f.t,
      ...(f.fireOutcome ? { fireOutcome: f.fireOutcome } : {}),
    }
  })
}

/**
 * One-shot convenience over {@link Simulator}: construct and {@link Simulator.run}
 * (which drives `init()` INSIDE the run-window guard so an A5 real-timer escape /
 * A1 engine error armed during the post-construction drain is observed), returning
 * the {@link SimResult}.
 */
export async function runSimulation<T extends object>(setup: SimSetup<T>, opts: SimOptions): Promise<SimResult> {
  return new Simulator<T>(setup, opts).run()
}
