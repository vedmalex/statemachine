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
import { type CheckerContext, type ConfigGraph, type Invariant, type Violation, buildConfigGraph } from './invariants'
import { runSafety } from './invariants.runner'
import { latencyStatsOf } from './metrics'
import type { PerfSample } from './metrics'
import { NoopLogger } from './noop-logger'
import { type Prng, makePrng } from './prng'
import { type DriverOp, SimDriver } from './driver'
import { settleMacrostep } from './settle'
import { SimErrorHandler } from './sim-error-handler'
import { SimMonitor } from './sim-monitor'
import { type CanonicalHeader, type CanonicalTrace, type TraceFrame, hashTrace } from './trace'

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
// SimOptions — seed is bigint|string (ADR-2 #4; bigint not JSON-able => string
// wire form). Optional fields use bare `?` under exactOptionalPropertyTypes:true.
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
// SimResult — the one-shot run summary. seed is canonical string form.
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
    version: '1',
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
    this.policy = opts.mode ?? 'safety'
    this.invariants = opts.invariants ?? []
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
    })
    this.driver = driver
    this.machine = driver.machine

    // Build the pure CheckerContext ONCE (only when the caller wants the SAFETY
    // path). The graph is the config-derived structural view; the header is the
    // driver's canonical trace header (same seed/runtime the hash uses). Empty
    // invariants ⇒ no context (runSafety is never called), so a clean run keeps
    // ok:true / violation:undefined.
    if (this.invariants.length > 0) {
      const graph: ConfigGraph = buildConfigGraph(resolved.config)
      this.checkerCtx = { graph, header: driver.trace().header }
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
    if (!this.initialized) {
      await this.init()
    }
    for (let i = 0; i < this.stepBudget; i++) {
      await this.step()
    }
    const trace: CanonicalTrace = this.driver?.trace() ?? { header: emptyHeader(this.seedString), frames: [] }
    // Final SAFETY sweep so a checkFinal-scoped violation is caught even at a zero
    // step budget (where the per-step loop never ran).
    this.evaluateSafety(trace)
    // SAFETY semantics: ok iff no violation was ever observed; violation is the
    // first/lowest-step Violation seen across the run (using the EXISTING
    // Violation/runSafety types — no new shapes, frozen public signature intact).
    return {
      ok: this.firstViolation === undefined,
      seed: this.seedString,
      steps: this.stepCount,
      traceHash: hashTrace(trace),
      trace: trace.frames,
      ...(this.firstViolation !== undefined ? { violation: this.firstViolation } : {}),
      metrics: zeroMetrics(trace.frames.length),
    }
  }

  /**
   * Serializable mid-run checkpoint. Engine state via `toJSON()` (NOT
   * toSecureJSON), the PRNG state, the logical clock. NEVER hashed.
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
   * set; PRNG-picks one to fire, else a noop. Args are an empty list (a number
   * fails isAdapter, so the :469-471 arg-misparse hazard cannot arise; here the
   * list is empty so no positional Adapter ambiguity is possible at all).
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
    if (available.length === 0) {
      return { kind: 'noop', opId: `sim-op-${this.stepCount}` }
    }
    const event = this.prng.pick(available)
    // Stable per-step op-id so the driver can resolve a per-op channel fault keyed
    // by `opId` (a plan may target `sim-op-<n>`). R22 stable op-id addressing.
    return { kind: 'fire', event, args: [], opId: `sim-op-${this.stepCount}` }
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
 * One-shot convenience over {@link Simulator}: construct, init, run, return the
 * {@link SimResult}.
 */
export async function runSimulation<T extends object>(setup: SimSetup<T>, opts: SimOptions): Promise<SimResult> {
  const sim = new Simulator<T>(setup, opts)
  await sim.init()
  return sim.run()
}
