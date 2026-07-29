/**
 * @module sim/sim-monitor
 * @unstable
 *
 * ADR-3 c2 (R1, R18-adjacent) deterministic observability seam.
 *
 * FRESH hand-written {@link IMonitor} — NOT `new StateMachineMonitor()` /
 * `createDefaultMonitor()`, and NEVER delegating to `MetricsCollector` (whose
 * ctor stamps `startTime = Date.now()` at monitoring.ts:77 and a per-record
 * `timestamp: Date.now()` at :97). `recordTransition` / `recordError` are plain
 * integer counters that read NO wall clock.
 *
 * `recordTransition(duration, success)` is called by the engine on EVERY drained
 * outcome: `success===true` for a committed transition, and (post-W4)
 * `success===false` for a REFUSAL — a guard-rejected event, an onExit-abort, or an
 * errorState recovery (see state_machine.ts `applyMicrostep` / the `enabled.length
 * === 0` and abort branches). The `success` FLAG — not a hardcoded `true` — is the
 * discriminator; `recordTransition` is NEVER the capture point for `(from,to)`
 * state writes (that is the Adapter.set seam in capture.ts). Only the SUCCESS
 * `duration` values are stored on the NON-hashed latency accumulator (W4.1 LOW —
 * refusals pass `duration===0` and would dilute the perf channel with zeros), so
 * Step 8's perf channel reads real transition latencies WITHOUT a new engine
 * method and WITHOUT ever reaching {@link hashTrace} (ADR-1 exclusion).
 *
 * Source-grep DoD: this file contains ZERO `Date.now` / `performance.now` /
 * `MetricsCollector` / `StateMachineMonitor` / `createDefaultMonitor` / `.start(`.
 */

import type { ErrorContext, IMonitor, LifecycleEvent, TransitionContext } from '../index'
import type { LifecycleObservation } from './invariants'

/**
 * Hard cap on the retained {@link LifecycleObservation} buffer. The channel emits
 * a `begin` + `end` pair per engine-invoked callback, so a long fuzz run can emit
 * hundreds of thousands of records; retaining them all would turn an unbounded
 * memory leak into the sim's dominant cost. On overflow the buffer STOPS growing
 * (it never rotates): a truncated PREFIX keeps every window it did capture intact,
 * so the order oracle stays SOUND — it can only miss a late violation
 * (false-NEGATIVE), never invent one. Rotating a ring buffer instead would slice
 * microstep windows in half and manufacture false positives.
 */
const LIFECYCLE_BUFFER_LIMIT = 200_000

/**
 * W9/Г1 — SEPARATE hard cap for the `kind:'raise'` stream, with its OWN truncation
 * flag. Two reasons it is not folded into {@link LIFECYCLE_BUFFER_LIMIT}:
 *
 * 1. VOLUME ASYMMETRY. Raises are point events emitted only by the five internal
 *    raise sites, so a run emits ORDERS OF MAGNITUDE fewer of them than callback
 *    begin/end pairs. Sharing one cap would let a hook-heavy run exhaust the budget
 *    and silently blind the I-5 join oracle even though the raise stream itself is
 *    tiny — the same reasoning that keeps `invokeActionInFlight` maintained
 *    REGARDLESS of the buffer cap.
 * 2. INDEPENDENT VACUITY. I-5 must go vacuous exactly when the RAISE stream is
 *    incomplete, not when an unrelated callback stream overflowed. A shared flag
 *    would couple the two oracles' soundness windows.
 *
 * Truncation semantics match the main buffer: the buffer STOPS growing (never
 * rotates), so a truncated PREFIX is intact and the counting oracle can only miss a
 * late violation (false-NEGATIVE) — and it is told to go vacuous anyway.
 */
const RAISE_BUFFER_LIMIT = 50_000

/**
 * Deterministic {@link IMonitor}. All state is integer counters plus a
 * non-hashed latency accumulator (the Step-8 perf hook) and the W8/V3a lifecycle
 * observation buffer.
 *
 * ## W8/V3a — the lifecycle channel subscription
 * Declaring {@link recordLifecycle} SWITCHES THE CHANNEL ON for every simulated
 * machine (the engine samples the method's presence ONCE at construction —
 * types.ts `IMonitor.recordLifecycle`). That is deliberate: the callback ORDER the
 * I-4 hierarchy-order oracle checks, and the string-method invoke actions the
 * ISS-030 in-flight gap loses, exist NOWHERE ELSE in the observation plane.
 *
 * The retained records are DETERMINISTIC and time-free (the channel carries no
 * clock — the subscriber would have to stamp its own), and they are stored OUTSIDE
 * the trace: nothing here reaches {@link hashTrace}. `owner` is kept by REFERENCE
 * as an opaque discriminator and is NEVER serialized.
 */
export class SimMonitor implements IMonitor {
  /** Count of recordTransition calls (success === true). */
  private transitionCount = 0
  /** Count of recordTransition calls (success === false). */
  private failureCount = 0
  /** Count of recordError calls. */
  private errorCount = 0
  /**
   * NON-HASHED latency accumulator. Holds ONLY the engine-passed `duration`
   * arguments verbatim. This is the perf hook Step 8 reads; it is structurally
   * walled off from the trace hash plane (ADR-1) — nothing in this array ever
   * reaches {@link hashTrace}.
   */
  private readonly durations: number[] = []
  /**
   * W8/V3a — the retained lifecycle observation stream, in engine `seq` order.
   * Read by the I-4 hierarchy-order checker through {@link CheckerContext.lifecycle}.
   * NEVER hashed.
   */
  private readonly lifecycle: LifecycleObservation[] = []
  /** True once {@link LIFECYCLE_BUFFER_LIMIT} was hit and records started dropping. */
  private lifecycleTruncated = false
  /**
   * W9/Г1 — the retained `kind:'raise'` stream, in engine `seq` order. Read by the
   * I-5 join checker through {@link CheckerContext.raises}. NEVER hashed.
   *
   * Raise records live HERE and are deliberately NOT also pushed into
   * {@link lifecycle}: the main buffer is the CALLBACK TIMELINE (what I-4 orders),
   * and interleaving instantaneous point records into it would consume the shared
   * cap without adding anything any callback-keyed oracle reads.
   */
  private readonly raises: LifecycleObservation[] = []
  /** True once {@link RAISE_BUFFER_LIMIT} was hit and raise records started dropping. */
  private raisesTruncated = false
  /**
   * W8/V8 — live count of `invoke.action` callbacks whose `begin` has no matching
   * `end` yet. This is the ISS-030 half of the settledness signal: a STRING-METHOD
   * invoke action is resolved INSIDE `callAction`, past the config-layer wrap
   * boundary, so `bracketAsync` cannot see it — but the channel wraps the CALL, so
   * this counter does.
   */
  private invokeActionInFlight = 0
  /**
   * W8/V5a — the {@link TransitionContext} of every recorded transition, in call
   * order. The engine now supplies it on the SUCCESS path too, which is the only
   * surface on which an INTERNALLY raised cause (`done.state.<C>`, an invoke
   * `onDone`) is attributable to the state write it produced.
   */
  private readonly transitionContexts: TransitionContext[] = []

  recordTransition(duration: number, success: boolean, context?: TransitionContext): void {
    if (context !== undefined) {
      this.transitionContexts.push(context)
    }
    if (success) {
      // W4.1 LOW: accumulate latency for SUCCESSES only. Refusals arrive with
      // duration===0 (guard-reject / abort / errorState) and would dilute the
      // Step-8 perf channel with meaningless zeros. Failure counting stays exact.
      this.durations.push(duration)
      this.transitionCount += 1
    } else {
      this.failureCount += 1
    }
  }

  recordError(_error: Error, _context?: ErrorContext): void {
    this.errorCount += 1
  }

  /**
   * W8/V3a/V8 lifecycle sink. Runs SYNCHRONOUSLY inside the engine drain, so it
   * stays allocation-light: one projected record push plus one counter update.
   *
   * The projection drops `owner` to a bare reference and keeps only the fields the
   * oracles read; nothing here reads a clock, so the retained stream is a pure
   * function of the seeded run.
   */
  recordLifecycle(event: LifecycleEvent): void {
    // The `invoke.action` bracket is maintained REGARDLESS of the buffer cap: it is
    // a running count, and dropping one edge of a pair would wedge it non-zero for
    // the rest of the run (settle would then never see quiescence).
    if (event.kind === 'invoke' && event.hook === 'invoke.action') {
      if (event.edge === 'begin') {
        this.invokeActionInFlight += 1
      } else if (this.invokeActionInFlight > 0) {
        this.invokeActionInFlight -= 1
      }
    }
    // W9/Г1 — the raise plane is retained in its OWN buffer under its OWN cap, and
    // is routed BEFORE the callback-buffer cap test so a saturated callback stream
    // can never silently blind the I-5 join oracle.
    if (event.kind === 'raise') {
      if (this.raises.length >= RAISE_BUFFER_LIMIT) {
        this.raisesTruncated = true
        return
      }
      this.raises.push({
        kind: event.kind,
        hook: event.hook,
        state: event.state,
        owner: event.owner,
        microstep: event.microstep,
        seq: event.seq,
        edge: event.edge,
        ...(event.event !== undefined ? { event: event.event } : {}),
      })
      return
    }
    if (this.lifecycle.length >= LIFECYCLE_BUFFER_LIMIT) {
      this.lifecycleTruncated = true
      return
    }
    this.lifecycle.push({
      kind: event.kind,
      hook: event.hook,
      state: event.state,
      owner: event.owner,
      microstep: event.microstep,
      seq: event.seq,
      edge: event.edge,
      ...(event.event !== undefined ? { event: event.event } : {}),
      ...(event.failed !== undefined ? { failed: event.failed } : {}),
      ...(event.transition !== undefined ? { transition: event.transition } : {}),
    })
  }

  /**
   * The retained lifecycle stream, in engine `seq` order. Returned BY REFERENCE so
   * a {@link CheckerContext} built once at `init()` observes the run as it grows —
   * the same live-view contract {@link getDurations} already uses. Consumers MUST
   * treat it as read-only.
   */
  getLifecycle(): readonly LifecycleObservation[] {
    return this.lifecycle
  }

  /** True iff the lifecycle buffer hit its cap and stopped retaining records. */
  isLifecycleTruncated(): boolean {
    return this.lifecycleTruncated
  }

  /**
   * W9/Г1 — the retained `kind:'raise'` stream, in engine `seq` order. Returned BY
   * REFERENCE (same live-view contract as {@link getLifecycle}) so a
   * {@link CheckerContext} built once at `init()` observes the run as it grows.
   * Consumers MUST treat it as read-only.
   */
  getRaises(): readonly LifecycleObservation[] {
    return this.raises
  }

  /**
   * True iff the RAISE buffer hit its cap and stopped retaining records. The I-5
   * join oracle MUST go vacuous on this: a counting predicate over a truncated
   * raise stream would see fewer raises than the run really performed and
   * manufacture a false positive.
   */
  isRaisesTruncated(): boolean {
    return this.raisesTruncated
  }

  /**
   * W8/V8 — live count of in-flight `invoke.action` callbacks (ISS-030 scope).
   * Composed into the harness `Env.inFlightAsyncCount` by the driver so a
   * string-method invoke action holds the macrostep open exactly like a
   * `bracketAsync`-wrapped inline function does.
   */
  invokeActionInFlightCount(): number {
    return this.invokeActionInFlight
  }

  /**
   * W8/V5a — every {@link TransitionContext} the engine supplied, in call order
   * (success AND refusal sites). The `eventName` is the only attribution of an
   * internally-raised cause to the state write it produced.
   */
  getTransitionContexts(): readonly TransitionContext[] {
    return this.transitionContexts
  }

  /** Total successful transitions recorded. */
  getTransitionCount(): number {
    return this.transitionCount
  }

  /** Total failed transitions recorded. */
  getFailureCount(): number {
    return this.failureCount
  }

  /** Total errors recorded. */
  getErrorCount(): number {
    return this.errorCount
  }

  /**
   * The NON-HASHED engine-supplied durations, in call order. Step-8 perf channel
   * reads this; it MUST NOT feed the trace hash.
   */
  getDurations(): readonly number[] {
    return this.durations
  }
}
