/**
 * @module sim/driver
 * @unstable
 *
 * ADR-4/3/1/7 Step-3 driver: the single deterministic execution surface that
 * runs the REAL engine through a seeded macrostep loop, recording the canonical
 * content-only trace. No faults (Step 5), no invariants (Step 6), no public
 * `wire()`/`Simulator` (Step 10) — just the converged-macrostep loop over the
 * sole {@link settleMacrostep} primitive.
 *
 * Per macrostep (ADR-4 line 259 fixed ordering):
 *   pick op → clock.set(nextT) → settleMacrostep → fireEvent(await .catch)
 *           → settleMacrostep → record (Adapter-seam frames DURING the drain +
 *             exactly ONE settle-boundary frame AFTER) → onFrame hook
 *
 * `init()`'s FIRST action after construction is `await settleMacrostep` (ADR-4
 * c7): the ctor fires `executeEnterActions(...).catch(...)` fire-and-forget and
 * defers `checkCompletion` via `queueMicrotask`, so frame 0 (`cause:'init'`,
 * normalized `from===to===initialState`) is recorded ONLY after that drain.
 *
 * All five DI seams are forwarded together (ADR-3 c1 / ADR-7 c8). Omitting
 * `scheduler` is the worst footgun (`schedulerProvided = scheduler !== undefined`
 * state_machine.ts:154 → real `createDefaultScheduler()` :155); the driver
 * always forwards the harness virtual scheduler so the real-time path is never
 * taken. The wrapped Adapter is ALWAYS passed as the EXPLICIT 2nd positional arg
 * to `fireEvent` (ADR-7 c13), never via the `:469-471` unshift path.
 *
 * **Event payload (W8).** `DriverOp.fire.args` is `readonly unknown[]` and the
 * driver forwards it VERBATIM — it does NOT filter to numbers. An OBJECT payload
 * (the typical case: a verdict object meaningful relative to the current state)
 * therefore reaches the machine's guard/action callbacks, which is the only way
 * arg-dependent transition branches get covered. This is SAFE with respect to the
 * `isAdapter` duck-check (`'set' in inp && 'get' in inp`, types.ts `isAdapter`, ~:725-726)
 * BECAUSE the driver always passes the wrapped Adapter EXPLICITLY as the 2nd
 * positional arg: payload values start at position 3 and `state_machine.ts`
 * :469-471 only inspects position 2. Never call `sm.fireEvent(event, ...args)`
 * without the explicit adapter from this module.
 *
 * Determinism premise (M5): V8 microtask order is FIFO within one isolate and
 * the virtual scheduler creates no real timers/IO; vitest does NOT fake
 * `queueMicrotask`. `header.runtime` pins that premise into the hash.
 */

import { StateMachine } from '../index'
import type { Adapter, ILogger, PropertiesOf, StateMachineConfig } from '../index'
import { type CaptureSink, type CapturedWrite, wrapAdapterForCapture } from './capture'
import type { SimClock } from './clock'
import { type Env, type SchedulerView, bracketAsync, makeAsyncCounter, makeEnv } from './env'
import {
  type FaultCursor,
  type FaultPlan,
  type FaultRecord,
  type FaultSite,
  classifyError,
  makeFaultCursor,
} from './faults'
import { type FireResult, type SubmissionEntry, applyQueueFaults, applyThrowFaults, buildOverflowFlood, fireBuffered } from './harness'
import type { Prng } from './prng'
import { type SettlePolicy, type SettleReason, settleMacrostep } from './settle'
import type { SimErrorHandler } from './sim-error-handler'
import type { SimMonitor } from './sim-monitor'
import {
  type CanonicalHeader,
  type CanonicalTrace,
  type ErrorClass,
  type FaultKind,
  type FireOutcome,
  type TraceCause,
  type TraceFrame,
  configHash,
  normalizeParts,
} from './trace'

/**
 * Fixed Step-3 op list. Step 4 replaces this with a generated, available-event-
 * aware op stream; Step 3 drives a literal op union to exercise the loop.
 */
export type DriverOp =
  | { readonly kind: 'fire'; readonly event: string; readonly args?: readonly unknown[]; readonly opId?: string }
  | { readonly kind: 'advance'; readonly dtMs: number; readonly opId?: string }
  | { readonly kind: 'noop'; readonly opId?: string }

/** Everything the driver needs to construct and drive ONE machine. */
export interface DriverConfig<T extends object> {
  readonly config: StateMachineConfig<T>
  /** The consumer owner adapter (wrapped by the capture seam before construction). */
  readonly owner: Adapter<T>
  readonly clock: SimClock
  /** The harness virtual scheduler (the DI `scheduler` seam). */
  readonly scheduler: { process(now?: number): void; isActive(): boolean; schedule(d: number, cb: () => void): object; cancel(t: object): void }
  /** The {@link SchedulerView} over `scheduler` (same armed tasks). */
  readonly schedulerView: SchedulerView
  readonly monitor: SimMonitor
  readonly errorHandler: SimErrorHandler
  readonly logger: ILogger
  /** Seeded PRNG (header.seed serialized from `prng.seed`). Drives op selection in later steps. */
  readonly prng: Prng
  /** Pins the microtask-FIFO + Date-fake premise into the hash header. */
  readonly runtime: string
  /** Optional per-frame hook (Step-6 SafetyRunner plugs in here; Step 3 runs nothing). */
  readonly onFrame?: (frame: TraceFrame) => void
  /** Settle policy for `step()` drains. `init()` always uses `'safety'`. Defaults to `'safety'`. */
  readonly policy?: SettlePolicy
  /** Forwarded to `StateMachineOptions.transitionTimeout` (types.ts:133). */
  readonly transitionTimeout?: number
  /** Forwarded to `StateMachineOptions.errorState` (types.ts:137) — zombie-state fallback. */
  readonly errorState?: string
  /** Forwarded to `StateMachineOptions.abortOnExitError` (types.ts:141). */
  readonly abortOnExitError?: boolean
  /** Forwarded to `StateMachineOptions.maxQueueDepth` (types.ts:146). */
  readonly maxQueueDepth?: number
  /**
   * Per-macrostep microtask-pump budget, forwarded to EVERY {@link settleMacrostep}
   * this driver makes (init, pre-fire, post-fire, batch). Defaults to
   * {@link DEFAULT_MAX_TURNS} = 1024.
   *
   * This is the knob the budget warnings' advice presupposes: raising it is what
   * separates a hook doing a lot of finite internal work from a genuine wedge,
   * because the two are indistinguishable over any FIXED window.
   */
  readonly maxTurns?: number
  /**
   * INTERNAL (not a public-ABI field): the resolved {@link FaultPlan} to apply
   * DURING this run. When present the driver routes external fires through the
   * fault-aware {@link fireBuffered} (reorder/drop/dup + overflow flood), wraps
   * function-valued callbacks with throw faults (via {@link applyThrowFaults},
   * sharing the inFlightAsyncCount bracket), applies clock-skew monotonically and
   * timer-jitter through the scheduler, and records every applied fault as a
   * {@link FaultRecord} (stamping {@link TraceFrame.faultApplied}). DETERMINISTIC:
   * faults are seed-derived via the label-fork PRNG; the SAME `(seed, plan)`
   * regenerates an identical `FaultRecord[]` and a bit-identical traceHash.
   */
  readonly faults?: FaultPlan
}

/**
 * Result of driving one macrostep: the frames recorded in this step (Adapter-
 * seam frames during the drain + the single settle-boundary frame) and whether
 * the macrostep reached quiescence.
 */
export interface DriverStepResult {
  readonly step: number
  readonly t: number
  readonly frames: readonly TraceFrame[]
  readonly quiescent: boolean
}

/** Live sink the driver swaps in around each fire so captured writes get context-stamped. */
interface LiveSink extends CaptureSink {
  /** Drain the writes accumulated since the last drain. */
  drain(): CapturedWrite[]
}

/**
 * Every REGIONS-BEARING composite id of a config, as the engine renders its dotted
 * path (`root`, `root.region.child`, …). Duck-typed on the same structural fields
 * `buildConfigGraph` walks, so it has no dependency on any topology type.
 *
 * ALL composites are enumerated, not only those with a declared `done.state.<C>`:
 * a parallel composite that reaches all-final and STAYS there has no join
 * transition to leave it, and its done-ness is exactly what the liveness
 * `terminal` derivation needs to see.
 */
function compositeIdsOf(config: unknown): string[] {
  const out: string[] = []
  const visit = (name: string, node: unknown, prefix: string): void => {
    const path = prefix === '' ? name : `${prefix}.${name}`
    const n = (node ?? {}) as Record<string, unknown>
    const regions = n['regions']
    if (regions && typeof regions === 'object') {
      out.push(path)
      for (const [rn, rstates] of Object.entries(regions as Record<string, unknown>)) {
        if (rstates && typeof rstates === 'object') {
          for (const [sn, sv] of Object.entries(rstates as Record<string, unknown>)) {
            visit(sn, sv, `${path}.${rn}`)
          }
        }
      }
    }
    const states = n['states']
    if (states && typeof states === 'object') {
      for (const [sn, sv] of Object.entries(states as Record<string, unknown>)) {
        visit(sn, sv, path)
      }
    }
  }
  const cfg = (config ?? {}) as Record<string, unknown>
  const top = cfg['states']
  if (top && typeof top === 'object') {
    for (const [name, node] of Object.entries(top as Record<string, unknown>)) {
      visit(name, node, '')
    }
  }
  return out
}

function makeLiveSink(): LiveSink {
  let buf: CapturedWrite[] = []
  return {
    onStateWrite(w: CapturedWrite): void {
      buf.push(w)
    },
    drain(): CapturedWrite[] {
      const out = buf
      buf = []
      return out
    },
  }
}

/**
 * The Step-3 deterministic driver. Construct, then `await init()`, then call
 * `step(op)` per macrostep. `trace()` returns the canonical content-only trace.
 */
export class SimDriver<T extends object> {
  private readonly sink: LiveSink
  private readonly env: Env
  private readonly wrapped: Adapter<T>
  private readonly sm: StateMachine<T, StateMachineConfig<T>>
  private readonly frames: TraceFrame[] = []
  private readonly header: CanonicalHeader
  private readonly initialNormalized: string
  /**
   * W8/V5b — every REGIONS-BEARING composite id of the wired config, as the engine
   * renders its dotted path. Sampled through the PUBLIC `isDone(C)` at every settle
   * boundary and stamped onto the boundary frame as {@link TraceFrame.doneDelta}.
   * Empty for a config with no composite (the sampling is then a no-op and the
   * frames stay byte-identical to a pre-W8 run).
   */
  private readonly doneComposites: readonly string[]
  private stepIndex = 0
  private initialized = false

  // ── fault state (active only when cfg.faults is a non-empty plan) ───────────
  /** The resolved fault plan (empty when no faults wired). */
  private readonly plan: FaultPlan
  /** True iff a non-empty fault plan is wired — gates the fault-aware fire path. */
  private readonly faultsActive: boolean
  /** Monotonic per-opportunity cursor (one PRNG-aligned draw per fire op). */
  private readonly faultCursor: FaultCursor = makeFaultCursor()
  /** Every fault APPLIED during this run, in apply order (regenerates on replay). */
  private readonly faultRecords: FaultRecord[] = []
  /**
   * Fault sites whose injected `throw` fired at the harness boundary since the
   * last drain, so the resulting frame can be stamped `faultApplied:'throw'`.
   */
  private throwFiredSites: FaultSite[] = []

  constructor(private readonly cfg: DriverConfig<T>) {
    this.sink = makeLiveSink()
    const counter = makeAsyncCounter()
    const baseEnv = makeEnv(counter, cfg.schedulerView)
    // W8/V8 (ISS-030) — COMPOSE the settledness signal from BOTH in-flight sources.
    //
    // `bracketAsync` wraps FUNCTION-VALUED invoke actions at the CONFIG layer, so a
    // STRING-METHOD invoke action — resolved INSIDE `callAction`, past that wrap
    // boundary — was invisible to `inFlightAsyncCount`. A machine legitimately
    // awaiting one settled as `pending ∧ inFlight===0`, which settle.ts classifies
    // WAITING_ON_INTERNAL — the I-3 witness. That was ISS-030: a reachable I-3
    // FALSE POSITIVE on a correct machine, and the sole reason I-3 was opt-in.
    //
    // The W8/V1b lifecycle channel wraps the CALL rather than the action VALUE, so
    // `invoke.action` begin/end pairs cover the string-method case identically. Only
    // `invoke.action` is folded in — NOT `invoke.operation`, whose pair spans the
    // ENTIRE lifetime of a long-running `src` promise (a subscription-style
    // operation would hold `inFlightAsyncCount` non-zero forever and no macrostep
    // could ever reach quiescence), and NOT the `invoke.abort` POINT pair (adjacent
    // begin+end, net zero).
    //
    // A function-valued invoke action is counted TWICE (bracket + channel). That is
    // harmless by construction: settle.ts only ever asks `> 0` / `=== 0`, and both
    // counters are incremented and decremented around the SAME call, so they reach
    // zero together.
    //
    // Enter/exit HOOKS are also observable on the channel but are deliberately NOT
    // folded in. They are awaited inside `applyMicrostep`, where
    // `isProcessingEvents()` is already `true`, so the structural conjunct of the
    // quiescence predicate covers them. The one place it does not — the
    // construction-time fire-and-forget `executeEnterActions` — is covered by the
    // pump's QUIET_FLUSH window by design (settle.ts); folding it in here would move
    // the settle fixed point itself, which is a separate change from ISS-030.
    const monitor = cfg.monitor
    this.env = {
      ...baseEnv,
      inFlightAsyncCount(): number {
        return baseEnv.inFlightAsyncCount() + monitor.invokeActionInFlightCount()
      },
    }
    this.plan = cfg.faults ?? { faults: [] }
    this.faultsActive = this.plan.faults.length > 0

    // Wrap the owner adapter with the capture seam (Step 2) so EVERY engine
    // state-write feeds the live sink. The SAME wrapped instance is reused as the
    // explicit 2nd positional fireEvent arg (ADR-7 c13).
    const wrapped = wrapAdapterForCapture(cfg.owner, cfg.config.stateAttribute, this.sink)
    this.wrapped = wrapped

    // (a) Apply callback THROW faults FIRST (config-mutation): replace each
    // function-valued targeted callback with a wrapThrowingCallback wrapper that
    // throws an InjectedFault at the harness boundary AND brackets the call with
    // inFlightAsyncCount (the wrapper shares the bracket point — tech-spec §4.2 /
    // ADR-4/5). String-method callbacks are collected as uncovered markers (never
    // wrapped). This runs before bracketInvokeActions so a throw-wrapped action is
    // not double-bracketed (the wrapper already brackets).
    const { config: throwConfig } = applyThrowFaults(cfg.config, this.plan, this.env, (site) => {
      // Record the applied throw fault the instant it fires at the harness
      // boundary (deterministic: the per-site latch fires once, in engine order).
      this.faultRecords.push({ faultStep: this.faultCursor.faultStep, kind: 'throw', site })
      this.throwFiredSites.push(site)
    })

    // (b) Bracket the REMAINING function-valued invoke actions with the
    // inFlightAsyncCount wrapper (ISS-030 wrappable scope) so the settledness count
    // is honest. Actions already throw-wrapped in (a) are bracketed by the wrapper
    // itself; bracketInvokeActions only wraps PLAIN function actions (it re-wraps a
    // wrapThrowingCallback result harmlessly, but to keep the count exact we skip
    // any action already wrapped — detected by the marker the wrapper does not set,
    // so plain double-bracket is avoided by applying throw-faults to a DISJOINT
    // site set from the bracket: the bracket only adds the in-flight count, the
    // throw wrapper adds it too, so an action that is BOTH would be counted twice.
    // We therefore bracket only actions NOT targeted by a throw fault site).
    const bracketedConfig = this.bracketInvokeActions(throwConfig)

    // Construct with ALL FIVE seams forwarded together (ADR-3 c1). Omitting
    // scheduler is the worst footgun; the driver never omits it. The wrapped
    // adapter is structurally a valid Adapter<PropertiesOf<T>> (the seam
    // delegates get/set/adaptee verbatim and preserves isAdapter); the cast
    // bridges the generic Adapter<T> -> Adapter<PropertiesOf<T>> the engine
    // expects (PropertiesOf strips methods, which the seam never touches).
    this.sm = new StateMachine<T, StateMachineConfig<T>>(bracketedConfig, wrapped as unknown as Adapter<PropertiesOf<T>>, {
      clock: cfg.clock.now,
      scheduler: cfg.scheduler,
      monitor: cfg.monitor,
      errorHandler: cfg.errorHandler,
      logger: cfg.logger,
      ...(cfg.transitionTimeout !== undefined ? { transitionTimeout: cfg.transitionTimeout } : {}),
      ...(cfg.errorState !== undefined ? { errorState: cfg.errorState } : {}),
      ...(cfg.abortOnExitError !== undefined ? { abortOnExitError: cfg.abortOnExitError } : {}),
      ...(cfg.maxQueueDepth !== undefined ? { maxQueueDepth: cfg.maxQueueDepth } : {}),
    })

    this.initialNormalized = normalizeParts(String(cfg.config.initialState))
    this.doneComposites = compositeIdsOf(cfg.config)
    this.header = {
      seed: cfg.prng.seed.toString(),
      configHash: configHash(cfg.config),
      engine: '@vedmalex/statemachine',
      // '5' (was '1'→'2'→'3'→'4'): '2' added the hashed `settleReason` field (C1);
      // '3' re-semantized its closed union (U1: the `pending ∧ inFlight==0` case
      // that hashed as WAITING_ON_TRANSITION_TIMEOUT now hashes as
      // WAITING_ON_INTERNAL).
      // '4' (W8/V5b) POPULATES the hashed `doneDelta` field on this path for the
      // first time: the boundary frame of every step now carries the sampled
      // isDone(C) projection per declared composite. `doneDelta` was always part of
      // the frame schema and always hashed, but only coverage.ts ever set it — a
      // Simulator trace of a composite machine now hashes DIFFERENTLY than it did
      // under '3'.
      // '5' (W9/Г2) EXTENDS the `SettleReason` closed union with
      // `'budget-progressing'`: a budget exhaustion where the machine was still
      // observably moving no longer hashes as `'microtask-budget'`. Any trace of a
      // machine long enough to exhaust the pump budget therefore hashes DIFFERENTLY
      // than it did under '4'.
      // '6' POPULATES the hashed `settleReason` field on TWO paths that always
      // dropped it: the mandatory post-construction drain (frame 0 and every
      // during-drain init frame recorded `quiescent` but no reason, so a machine
      // that wedged during CONSTRUCTION was completely silent) and the step's
      // PRE-fire drain (whose result was discarded outright, so a budget
      // exhaustion the following fire happened to clear left no trace). Any trace
      // of a machine that is non-quiescent on either path therefore hashes
      // DIFFERENTLY than it did under '5'.
      // Per the trace.ts version contract ("bump on closed-union/hashed-field
      // change") each of these is corpus-breaking and the schema version advances.
      // MUST stay in lockstep with public.ts `emptyHeader` — pinned by
      // `src/tests/sim/budget_truncation.test.ts` (the two constants are equal).
      version: '6',
      runtime: cfg.runtime,
      prngVersion: 'splitmix64-bigint-v1',
      errorHandlerEnabled: true,
    }
  }

  /**
   * Wrap every FUNCTION-VALUED `invoke[].action` with {@link bracketAsync} so a
   * pending invoke/resume action is visible to `inFlightAsyncCount`. String
   * method-name actions are left untouched (the wrap boundary is the config
   * layer; string resolution happens inside `callAction` — documented v1 gap).
   */
  private bracketInvokeActions(config: StateMachineConfig<T>): StateMachineConfig<T> {
    const env = this.env
    // The invoke-action sites a THROW fault already targets — those actions are
    // wrapped by wrapThrowingCallback, which ALREADY brackets the call with
    // inFlightAsyncCount. Bracketing them again would double-count the in-flight
    // action and break the settledness predicate, so skip them here.
    const throwInvokeIdx = new Set<number>()
    for (const f of this.plan.faults) {
      if (f.kind === 'throw' && f.site.callbackKind === 'invoke.action' && f.site.invokeIndex !== undefined) {
        throwInvokeIdx.add(f.site.invokeIndex)
      }
    }
    const wrapState = (state: Record<string, unknown>): Record<string, unknown> => {
      const next: Record<string, unknown> = { ...state }
      const invoke = state['invoke']
      if (Array.isArray(invoke)) {
        next['invoke'] = invoke.map((inv, idx) => {
          const i = inv as Record<string, unknown>
          if (typeof i['action'] === 'function' && !throwInvokeIdx.has(idx)) {
            return { ...i, action: bracketAsync(env, i['action'] as (o: unknown, ...a: unknown[]) => unknown) }
          }
          return i
        })
      }
      // Recurse into composite regions / nested states.
      const regions = state['regions']
      if (regions && typeof regions === 'object') {
        const nextRegions: Record<string, unknown> = {}
        for (const [rk, rv] of Object.entries(regions as Record<string, unknown>)) {
          const nextRegion: Record<string, unknown> = {}
          for (const [sk, sv] of Object.entries(rv as Record<string, unknown>)) {
            nextRegion[sk] = wrapState(sv as Record<string, unknown>)
          }
          nextRegions[rk] = nextRegion
        }
        next['regions'] = nextRegions
      }
      const states = state['states']
      if (states && typeof states === 'object') {
        const nextStates: Record<string, unknown> = {}
        for (const [sk, sv] of Object.entries(states as Record<string, unknown>)) {
          nextStates[sk] = wrapState(sv as Record<string, unknown>)
        }
        next['states'] = nextStates
      }
      return next
    }

    const nextStates: Record<string, unknown> = {}
    for (const [name, state] of Object.entries(config.states as Record<string, unknown>)) {
      nextStates[name] = wrapState(state as Record<string, unknown>)
    }
    return { ...config, states: nextStates as StateMachineConfig<T>['states'] }
  }

  /**
   * The invariant part of every {@link settleMacrostep} THIS DRIVER makes. Built
   * in ONE place so a new DRIVER settle site cannot silently drop the configured
   * `maxTurns` (the budget knob must reach every drain the driver runs, or raising
   * it would fix only some of them).
   *
   * The scope is the driver, not the harness. `Simulator.runSentinelProbe`
   * (public.ts) constructs its settle args INLINE with a hardcoded `maxTurns: 64`
   * and a throwaway env, deliberately: it is a one-shot behavioural assertion that
   * a harness-owned sentinel timer fires through the injected scheduler, not a
   * drain of consumer work, and it must stay a fixed cost that a consumer's
   * `maxTurns` cannot inflate. It is outside this helper and outside the claim.
   */
  private settleArgs(policy: SettlePolicy): {
    sm: StateMachine<T, StateMachineConfig<T>>
    scheduler: DriverConfig<T>['scheduler']
    clock: SimClock
    env: Env
    policy: SettlePolicy
    maxTurns?: number
  } {
    return {
      sm: this.sm,
      scheduler: this.cfg.scheduler,
      clock: this.cfg.clock,
      env: this.env,
      policy,
      ...(this.cfg.maxTurns !== undefined ? { maxTurns: this.cfg.maxTurns } : {}),
    }
  }

  /** Logical time. */
  get t(): number {
    return this.cfg.clock.now()
  }

  /** The wired engine (read-only access for tests/Step-6 plug-in). */
  get machine(): StateMachine<T, StateMachineConfig<T>> {
    return this.sm
  }

  /** The harness {@link Env} (exposes inFlightAsyncCount for the CRIT-1 proof). */
  get environment(): Env {
    return this.env
  }

  /**
   * MANDATORY post-construction drain (ADR-4 c7). Settles the construction-time
   * fire-and-forget `executeEnterActions` + deferred `checkCompletion`, THEN
   * records frame 0 (the init snapshot) plus any `done.state.<C>` frames captured
   * DURING that drain via the Adapter seam.
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return
    }
    // Discard any construction-time writes captured before the drain settles;
    // frame 0 is the post-drain snapshot, and DURING-drain writes are recorded
    // as their own frames below.
    this.sink.drain()
    // The post-construction drain ALWAYS settles with 'safety': it must never
    // jump the clock at construction (frame 0 records the INITIAL configuration
    // at the start instant; a liveness jump here would skip past it and fire
    // armed timers before any op runs). A configured 'liveness' policy applies
    // only to step() drains.
    const result = await settleMacrostep(this.settleArgs('safety'))
    const drainedWrites = this.sink.drain()

    // Frame 0: the init snapshot, recorded AFTER the drain. cause:'init',
    // normalized from===to===initialState. W8/V5b: it carries the init-boundary
    // doneDelta sample (a degenerate all-final initial configuration is done
    // immediately) — the same boundary coverage.ts has always sampled.
    const initDone = this.sampleDoneDelta()
    this.frames.push({
      step: this.stepIndex,
      t: this.cfg.clock.now(),
      cause: 'init',
      from: this.initialNormalized,
      to: this.initialNormalized,
      queue: this.queueSnapshot(),
      quiescent: result.quiescent,
      // The init drain's REASON, on the same terms as every step boundary. It was
      // dropped here until now, which made a machine that wedges during
      // CONSTRUCTION completely silent: frame 0 stamped `quiescent:false` and no
      // `settleReason`, so nothing downstream could say WHY. Populating a hashed
      // field on the init path is corpus-breaking — see `header.version` '6'.
      //
      // SCOPE, precisely (do not read this as "a construction wedge is now
      // reported"): frame 0 has no `fireOutcome` and never can — nothing was fired.
      // Every INVARIANT that reads a settle boundary keys on `fireOutcome`
      // (I-3: `fireOutcome === 'resolve-true' && quiescent === false`), so NO
      // invariant can see this field on the init frame. Its only consumers are the
      // advisory warning counters in public.ts, which scan frames by
      // `settleReason` irrespective of cause. A construction-time non-quiescence is
      // therefore reported iff its reason has a warning attached — the two budget
      // reasons and, since the wave-B demotion, `WAITING_ON_INTERNAL` via
      // `rtc-unobserved` — and is silent for `WAITING_ON_TIMER` /
      // `WAITING_ON_TRANSITION_TIMEOUT`, which at construction are the NORMAL
      // outcome (an initial state that arms a timer is not a defect).
      ...(result.reason ? { settleReason: result.reason } : {}),
      ...(initDone !== undefined ? { doneDelta: initDone } : {}),
    })

    // Any state-writes captured DURING the construction drain (e.g. a
    // delay:0 invoke or a done.state.<C> raise) become their own 'init'-caused
    // frames in write order, carrying the actual transition target. A timer-jitter
    // fault perturbs the FIRST armed invoke timer (which arms during this drain),
    // so the init frames carry the 'timer-jitter' channel tag when a jitter fault
    // is wired (deterministic per (seed, plan)).
    const jitterTag: FaultKind | undefined = this.recordPlanJitter() ? 'timer-jitter' : undefined
    for (const w of drainedWrites) {
      // The 7th arg (settleReason) was omitted here, so every during-drain init
      // frame silently carried `undefined` while frame 0 recorded the quiescence
      // boolean it belongs to. Pass it explicitly.
      this.frames.push(this.frameFromWrite('init', w, result.quiescent, undefined, undefined, jitterTag, result.reason))
    }
    // If the jitter perturbed a timer but no writes landed during the construction
    // drain, the init snapshot frame still records the jitter tag so the applied
    // fault is observable in the trace.
    if (jitterTag !== undefined && drainedWrites.length === 0) {
      const frame0 = this.frames[0]
      if (frame0 !== undefined) {
        this.frames[0] = { ...frame0, faultApplied: 'timer-jitter' }
      }
    }

    this.initialized = true
  }

  /**
   * Record a deterministic {@link FaultRecord} for each `timer-jitter` fault in the
   * plan (one per fault, in plan order). The perturbation itself is applied inside
   * the caller-built scheduler via {@link buildPlanJitter}; this records that the
   * fault was wired for THIS run (regenerates identically on replay). Returns true
   * iff at least one timer-jitter fault was recorded.
   */
  private recordPlanJitter(): boolean {
    let any = false
    for (const f of this.plan.faults) {
      if (f.kind === 'timer-jitter') {
        this.faultRecords.push({
          faultStep: this.faultCursor.faultStep,
          kind: 'timer-jitter',
          site: f.site,
          ...(f.site.opId !== undefined ? { opId: f.site.opId } : {}),
        })
        any = true
      }
    }
    return any
  }

  /**
   * Drive exactly ONE macrostep with the given op (ADR-4 line 259 ordering).
   *
   * @throws if called before {@link init}.
   */
  async step(op: DriverOp): Promise<DriverStepResult> {
    if (!this.initialized) {
      throw new Error('SimDriver.step() called before init()')
    }
    this.stepIndex += 1
    const policy = this.cfg.policy ?? 'safety'
    const before = this.frames.length
    this.throwFiredSites = []

    // Resolve the per-op channel fault (if any) keyed by the STABLE opId. The
    // cursor advances by exactly one per fire opportunity (one PRNG-aligned draw),
    // so adding/removing a fault elsewhere never shifts a surviving op's faultStep
    // (R22 stable op-id addressing; AC-2 replay identity). When no fault plan is
    // wired this is skipped entirely so the no-fault path is byte-identical to the
    // original Step-3 driver (zero fault overhead — the perf plane is unaffected).
    const opFault = this.faultsActive && op.kind === 'fire' && op.opId !== undefined ? this.resolveOpFault(op.opId) : undefined

    /** The channel-fault tag stamped onto this step's frames (if a fault applied). */
    let faultApplied: FaultKind | undefined

    // (a) clock.set(nextT) — monotonic forward advance for 'advance' ops; other
    // ops keep the current instant. A clock-skew fault adds a forward-only delta
    // (Math.max guard) so the logical clock stays monotonic (ADR-5).
    if (op.kind === 'advance') {
      const skew = this.faultsActive ? this.clockSkewAt(op.opId) : 0
      if (skew > 0) {
        faultApplied = 'clock-skew'
      }
      const nextT = this.cfg.clock.now() + Math.max(0, op.dtMs) + Math.max(0, skew)
      // monotonic: clock.set throws on backward; the +skew can only move forward.
      this.cfg.clock.set(Math.max(this.cfg.clock.now(), nextT))
    }

    // (b) settle BEFORE the fire (drain anything armed by the clock advance).
    const preFire = await settleMacrostep(this.settleArgs(policy))
    this.sink.drain() // pre-fire writes already framed in prior steps / init

    // (c) the op itself.
    const cause: TraceCause = op.kind === 'advance' ? 'timer' : 'external'
    const beforeState = this.safeCurrentState()
    let fireOutcome: FireOutcome | undefined
    let errorClassOnFire: TraceFrame['errorClass']

    if (op.kind === 'fire') {
      if (this.faultsActive) {
        const fireResult = await this.fireWithFaults(op, opFault)
        fireOutcome = fireResult.outcome
        if (fireResult.errorClass !== undefined) {
          errorClassOnFire = fireResult.errorClass
        }
        if (fireResult.faultApplied !== undefined) {
          faultApplied = fireResult.faultApplied
        }
      } else {
        // No-fault fast path: the ORIGINAL Step-3 raw fire (ADR-7 c13 explicit
        // Adapter), byte-identical to the pre-Step-5 driver so a clean run's trace,
        // hash and PERF are unchanged by the fault wiring.
        // W8: args are forwarded VERBATIM (`unknown[]`) — no number-filter. The
        // explicit-Adapter 2nd positional arg keeps the :469-471 unshift path out
        // of reach, so an object payload is safe here (see module doc).
        const r = await this.fireOne(op.event, op.args ?? [])
        fireOutcome = r.outcome
        if (r.errorClass !== undefined) {
          errorClassOnFire = r.errorClass
        }
      }
    }

    // (d) settle AFTER the fire to a joint fixed point.
    const result = await settleMacrostep(this.settleArgs(policy))

    // A throw fault that fired DURING this step's drain (e.g. an invoke-action
    // throw) stamps the channel tag 'throw' on this step's frames.
    if (faultApplied === undefined && this.throwFiredSites.length > 0) {
      faultApplied = 'throw'
    }

    /**
     * The reason recorded for THIS step: the post-fire drain's when it has one,
     * otherwise the pre-fire drain's (whose result was previously dropped on the
     * floor). See the boundary frame below and TraceFrame.settleReason.
     *
     * TWO IMPRECISIONS, both known, both currently harmless, and neither fixable
     * without moving a hashed field:
     *
     *  1. A step runs TWO settles (pre-fire and post-fire) but records at most ONE
     *     reason, so when the post-fire drain converged and the fallback supplies
     *     the PRE-fire drain's reason, the boundary frame — which describes the
     *     post-fire settle, and may well be `quiescent:true` — carries a reason
     *     produced by a DIFFERENT settle. Nothing reads the pair as a unit today
     *     (the invariants gate on `quiescent === false`, and a frame that is
     *     quiescent with a stale reason attached is excluded by that conjunct), so
     *     this is latent rather than live. Separating them needs a second hashed
     *     field on TraceFrame, which is corpus-breaking.
     *
     *  2. The one reason is then stamped on EVERY frame this step emits — the
     *     boundary frame plus one per state-write captured during the drain — so a
     *     frame COUNT of a given reason over-reports a single non-quiescent
     *     macrostep by however many transitions landed in it. The advisory warning
     *     counters in public.ts therefore count DISTINCT STEPS, not frames.
     */
    const settleReasonForStep: SettleReason | undefined = result.reason ?? preFire.reason

    // (e) per-transition frames via the Adapter seam DURING the drain.
    const writes = this.sink.drain()
    for (const w of writes) {
      this.frames.push(
        this.frameFromWrite(cause, w, result.quiescent, op.kind === 'fire' ? op.event : undefined, fireOutcome, faultApplied, settleReasonForStep),
      )
    }

    // (f) exactly ONE settle-boundary frame AFTER. For state-changing fires this
    // is a no-op snapshot; for resolve-false / reject / errorState fallback it is
    // the BACKSTOP record (ADR-1 c10) — a try/catch-wrapped getCurrentState diff.
    const afterState = this.safeCurrentState()
    // W8/V5b: the settle-boundary doneDelta sample — the SAME boundary and the same
    // PUBLIC isDone(C) reader coverage.ts injects post-hoc, now recorded inline so
    // the Simulator/runSafety VERDICT path carries it too (it previously did not,
    // which made every doneDelta-keyed oracle and the liveness `terminal`
    // derivation vacuous e2e).
    const doneDelta = this.sampleDoneDelta()
    const boundaryFrame: TraceFrame = {
      step: this.stepIndex,
      t: this.cfg.clock.now(),
      cause,
      from: normalizeParts(beforeState),
      to: normalizeParts(afterState),
      queue: this.queueSnapshot(),
      quiescent: result.quiescent,
      ...(op.kind === 'fire' ? { event: op.event } : {}),
      ...(fireOutcome ? { fireOutcome } : {}),
      ...(errorClassOnFire ? { errorClass: errorClassOnFire } : {}),
      ...(faultApplied ? { faultApplied } : {}),
      // C1: record WHY a non-quiescent boundary is non-quiescent so I-3 can exclude
      // a legitimate WAITING_ON_* (a concurrent region's own future timer).
      //
      // FALLBACK to the PRE-fire drain's reason. That settle's result used to be
      // discarded outright, so a step whose pre-fire drain exhausted its budget and
      // whose post-fire drain then converged recorded NOTHING — the advisory budget
      // warnings under-counted, and a wedge cleared by the very next fire was
      // invisible. The post-fire reason always wins when present, so this only ever
      // fills a slot that would otherwise be empty. See TraceFrame.settleReason for
      // why `quiescent:true` alongside a reason is well-defined here.
      ...(settleReasonForStep !== undefined ? { settleReason: settleReasonForStep } : {}),
      ...(doneDelta !== undefined ? { doneDelta } : {}),
    }
    this.frames.push(boundaryFrame)

    // (g) onFrame hook for every frame this step emitted.
    const emitted = this.frames.slice(before)
    if (this.cfg.onFrame) {
      for (const f of emitted) {
        this.cfg.onFrame(f)
      }
    }

    return { step: this.stepIndex, t: this.cfg.clock.now(), frames: emitted, quiescent: result.quiescent }
  }

  /** The canonical content-only trace recorded so far. */
  trace(): CanonicalTrace {
    return { header: this.header, frames: this.frames.slice() }
  }

  /**
   * Every fault APPLIED during this run so far, in apply order. Regenerates
   * IDENTICALLY on replay for the same `(seed, plan)` (AC-2): channel/clock/jitter
   * faults are recorded at deterministic opportunities, throw faults at the
   * single-shot harness boundary in engine order.
   */
  faultRecordsList(): readonly FaultRecord[] {
    return this.faultRecords.slice()
  }

  // ── fault internals ────────────────────────────────────────────────────────

  /**
   * Resolve the queue/overflow channel fault scheduled at `opId` (if any),
   * recording the {@link FaultRecord} and advancing the per-opportunity cursor by
   * exactly one (one PRNG-aligned draw per fire op). Clock-skew/timer-jitter/throw
   * faults are NOT resolved here (skew is applied at the clock; jitter inside the
   * scheduler; throw at the callback boundary); they are recorded at their own
   * apply points.
   */
  private resolveOpFault(opId: string): { kind: 'reorder' | 'drop' | 'dup' | 'overflow'; floodCount?: number } | undefined {
    const faultStep = this.faultCursor.faultStep
    this.faultCursor.faultStep += 1
    const spec = this.plan.faults.find(
      (f) =>
        (f.kind === 'reorder' || f.kind === 'drop' || f.kind === 'dup' || f.kind === 'overflow') &&
        'opId' in f &&
        f.opId === opId,
    )
    if (spec === undefined) {
      return undefined
    }
    this.faultRecords.push({
      faultStep,
      kind: spec.kind,
      site: spec.site,
      ...(('opId' in spec && spec.opId !== undefined) ? { opId: spec.opId } : {}),
    })
    if (spec.kind === 'overflow') {
      return { kind: 'overflow', floodCount: spec.floodCount }
    }
    // narrow: the find predicate already excluded clock-skew/timer-jitter/throw.
    if (spec.kind === 'reorder' || spec.kind === 'drop' || spec.kind === 'dup') {
      return { kind: spec.kind }
    }
    /* c8 ignore next */
    return undefined
  }

  /**
   * The forward-only clock-skew delta scheduled at `opId` (0 if none). Records the
   * {@link FaultRecord} the first time the skew is applied. Monotonic (the caller
   * Math.max-guards the result; ADR-5).
   */
  private clockSkewAt(opId?: string): number {
    if (opId === undefined) {
      return 0
    }
    const spec = this.plan.faults.find((f) => f.kind === 'clock-skew' && f.site.opId === opId)
    if (spec === undefined || spec.kind !== 'clock-skew') {
      return 0
    }
    const faultStep = this.faultCursor.faultStep
    this.faultRecords.push({
      faultStep,
      kind: 'clock-skew',
      site: spec.site,
      ...(spec.site.opId !== undefined ? { opId: spec.site.opId } : {}),
    })
    return Math.max(0, spec.deltaMs)
  }

  /**
   * Fire ONE op through the fault-aware submission path. Builds a one-entry
   * submission buffer (or an overflow flood), applies the queue channel faults
   * (reorder/drop/dup) to it, then fires each surviving entry through the
   * fault-aware {@link fireBuffered} (which classifies overflow-vs-depth by
   * per-fire IDENTITY, never by message). A `drop` removes the only entry, so the
   * fire is a no-op (resolve-false). When no fault plan is wired, this is a single
   * raw fire through `fireBuffered` (identical observable outcome to the legacy
   * raw `sm.fireEvent`, but routed through the harness boundary).
   */
  private async fireWithFaults(
    op: { kind: 'fire'; event: string; args?: readonly unknown[]; opId?: string },
    opFault: { kind: 'reorder' | 'drop' | 'dup' | 'overflow'; floodCount?: number } | undefined,
  ): Promise<{ outcome: FireOutcome; errorClass?: TraceFrame['errorClass']; faultApplied?: FaultKind }> {
    const opId = op.opId ?? `step-${this.stepIndex}`
    // W8: the FAULT path carries the payload IDENTICALLY to the no-fault path —
    // args are forwarded VERBATIM into the submission entry (no number-filter), so
    // every downstream consumer (applyQueueFaults dup/reorder/drop, the overflow
    // flood, fireOne) fires with the SAME arguments a fault-free run would use.
    // Dropping the payload here would make a fault run observably diverge from its
    // no-fault twin for reasons unrelated to the fault — a new class of
    // irreproducibility.
    const entry: SubmissionEntry = { opId, event: op.event, args: op.args ?? [] }

    // Overflow: flood maxQueueDepth+1 copies; the (max+1)-th fire rejects
    // synchronously at enqueue (state_machine.ts:228-240). The flood entries are
    // fired back-to-back WITHOUT a settle between them so the external queue fills.
    // ONLY the overflow path uses fireBuffered (which supplies the per-fire
    // `origin` that splits queue-overflow vs max-transition-depth by identity);
    // every OTHER fire is a single raw fireEvent classified with origin=undefined,
    // so an `invalid-event` reject (same {state,event} context shape as overflow)
    // is NOT misclassified as a queue error.
    if (opFault?.kind === 'overflow') {
      const floodCount = opFault.floodCount ?? ((this.cfg.maxQueueDepth ?? 1000) + 1)
      const flood = buildOverflowFlood(entry, floodCount)
      let outcome: FireOutcome = 'resolve-false'
      let errorClass: TraceFrame['errorClass']
      // Fire all flood copies concurrently (no settle between) so the queue fills
      // past maxQueueDepth and the overflow gate (state_machine.ts:228-240) trips.
      // The overflow reject carries the REAL fired event name in its context (vs the
      // synthetic 'processQueues' a drain-time depth reject carries — :305), so we
      // classify it structurally (message-free): a non-'processQueues' reject from
      // the flood IS the overflow gate. This is robust under concurrent firing where
      // the per-fire sync-tick heuristic cannot attribute the reject.
      const fires = flood.map((e) =>
        this.boundFireEvent()(e.event as never, this.wrapped as never, ...e.args).then(
          () => ({ ok: true as const }),
          (err: unknown) => ({ ok: false as const, err }),
        ),
      )
      const results = await Promise.all(fires)
      for (const r of results) {
        if (!r.ok) {
          const ec = classifyError(r.err, { syncAtEnqueue: true })
          if (ec === 'queue-overflow') {
            outcome = 'reject'
            errorClass = ec
            break
          }
        }
      }
      return { outcome, faultApplied: 'overflow', ...(errorClass !== undefined ? { errorClass } : {}) }
    }

    // reorder/drop/dup operate on the external submission buffer. With a single op
    // in flight per step, drop removes it (no-op fire) and dup fires it twice;
    // reorder needs a ≥2-entry window (the buffer here is a single entry, so a
    // reorder targeting a lone entry is a structural no-op but is still RECORDED
    // and tagged — a multi-op reorder window is exercised by the integration test
    // via fireMany).
    let buffer: SubmissionEntry[] = [entry]
    if (opFault !== undefined) {
      buffer = applyQueueFaults(buffer, {
        faults: [
          opFault.kind === 'drop'
            ? { kind: 'drop', site: { seam: 'event-queue', opId }, opId }
            : opFault.kind === 'dup'
              ? { kind: 'dup', site: { seam: 'event-queue', opId }, opId }
              : { kind: 'reorder', site: { seam: 'event-queue', opId }, opId },
        ],
        ...(this.plan.reorderWindow !== undefined ? { reorderWindow: this.plan.reorderWindow } : {}),
      })
    }

    const faultApplied: FaultKind | undefined = opFault?.kind

    if (buffer.length === 0) {
      // drop: nothing fired. The op is observably a no-op (resolve-false).
      return { outcome: 'resolve-false', ...(faultApplied !== undefined ? { faultApplied } : {}) }
    }

    let outcome: FireOutcome = 'resolve-false'
    let errorClass: TraceFrame['errorClass']
    for (const e of buffer) {
      const r = await this.fireOne(e.event, e.args)
      // last fire wins for the boundary outcome; a reject is surfaced.
      outcome = r.outcome
      if (r.errorClass !== undefined) {
        errorClass = r.errorClass
      }
    }
    return { outcome, ...(errorClass !== undefined ? { errorClass } : {}), ...(faultApplied !== undefined ? { faultApplied } : {}) }
  }

  /**
   * Fire ONE event through the explicit-Adapter path (ADR-7 c13) and classify any
   * reject with `origin=undefined`, so an `invalid-event` reject (which shares the
   * `{state,event}` context shape with queue-overflow) is classified correctly by
   * the FROZEN structural classifier — never misread as a queue error. Used for
   * every non-overflow fire (no fault, drop, dup).
   */
  private async fireOne(event: string, args: readonly unknown[]): Promise<{ outcome: FireOutcome; errorClass?: ErrorClass }> {
    try {
      const resolved = await this.sm.fireEvent(event as never, this.wrapped as never, ...args)
      return { outcome: resolved ? 'resolve-true' : 'resolve-false' }
    } catch (e) {
      const errorClass = classifyError(e)
      return errorClass !== undefined ? { outcome: 'reject', errorClass } : { outcome: 'reject' }
    }
  }

  /**
   * Fire MANY ops in one macrostep WITHOUT a settle between them, applying the
   * queue channel faults to the whole submission buffer (so a reorder window of
   * ≥2 ops is exercised). Returns the per-entry {@link FireResult}s. Used by the
   * reorder/overflow integration tests; the normal {@link step} drives one op.
   */
  async fireMany(
    ops: ReadonlyArray<{ event: string; args?: readonly unknown[]; opId: string }>,
  ): Promise<readonly FireResult[]> {
    if (!this.initialized) {
      throw new Error('SimDriver.fireMany() called before init()')
    }
    let buffer: SubmissionEntry[] = ops.map((o) => ({ opId: o.opId, event: o.event, args: o.args ?? [] }))
    // Apply ALL queue faults whose opId is in this buffer, recording each.
    for (const o of ops) {
      const f = this.resolveOpFault(o.opId)
      void f // recording happens inside resolveOpFault; mutation is applied below
    }
    buffer = applyQueueFaults(buffer, this.plan)
    const results: FireResult[] = []
    for (const e of buffer) {
      results.push(await fireBuffered(this.boundFireEvent(), this.wrapped, e))
    }
    const policy = this.cfg.policy ?? 'safety'
    await settleMacrostep(this.settleArgs(policy))
    return results
  }

  /**
   * The engine `fireEvent` bound for {@link fireBuffered} (explicit-Adapter path).
   * W8: the rest parameter is `unknown[]` so an OBJECT payload reaches the
   * machine's callbacks. The adapter stays the EXPLICIT 2nd positional arg, so the
   * `isAdapter` unshift branch (state_machine.ts:469-471) is never entered.
   */
  private boundFireEvent(): (event: never, adapter: never, ...args: unknown[]) => Promise<boolean> {
    return ((event: never, adapter: never, ...args: unknown[]) =>
      this.sm.fireEvent(event, adapter, ...(args as never[]))) as (
      event: never,
      adapter: never,
      ...args: unknown[]
    ) => Promise<boolean>
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Build a content frame from a raw captured write, normalizing from/to. */
  private frameFromWrite(
    cause: TraceCause,
    w: CapturedWrite,
    quiescent: boolean,
    event?: string,
    fireOutcome?: FireOutcome,
    faultApplied?: FaultKind,
    settleReason?: SettleReason,
  ): TraceFrame {
    return {
      step: this.stepIndex,
      t: this.cfg.clock.now(),
      cause,
      from: normalizeParts(w.from),
      to: normalizeParts(w.to),
      queue: this.queueSnapshot(),
      quiescent,
      ...(event ? { event } : {}),
      ...(fireOutcome ? { fireOutcome } : {}),
      ...(faultApplied ? { faultApplied } : {}),
      ...(settleReason ? { settleReason } : {}),
    }
  }

  private queueSnapshot(): { internal: number; external: number } {
    const q = this.sm.getQueueDepth()
    return { internal: q.internal, external: q.external }
  }

  /**
   * W8/V5b — sample the PUBLIC `isDone(C)` for every composite of the config at the
   * CURRENT (settled) instant. The RUNNER legitimately drives the engine here; the
   * result is stored as DERIVED frame data so the checkers read the captured
   * projection and never make a live call (ADR-6 c3 purity).
   *
   * Returns `undefined` for a config with no composite, so the frame keeps its
   * pre-W8 shape (an absent optional is dropped by the hash serializer) and a
   * composite-free scenario's traceHash is unchanged by this feature.
   */
  private sampleDoneDelta(): ReadonlyArray<{ composite: string; done: boolean }> | undefined {
    if (this.doneComposites.length === 0) {
      return undefined
    }
    return this.doneComposites.map((composite) => {
      let done = false
      try {
        done = this.sm.isDone(composite)
      } catch {
        // A corrupt-state probe can make the read path throw; an unreadable
        // configuration is reported as not-done rather than crashing the driver.
        done = false
      }
      return { composite, done }
    })
  }

  /**
   * Read getCurrentState defensively: the errorState fallback (:2017-2021) and
   * a corrupt read-path can THROW; the backstop frame must not crash the driver.
   */
  private safeCurrentState(): string {
    try {
      return this.sm.getCurrentState() ?? ''
    } catch {
      return ''
    }
  }

}
