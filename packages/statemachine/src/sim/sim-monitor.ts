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
 * `recordTransition(transitionTime, true)` is the engine's SOLE call site
 * (state_machine.ts:2059-2060 — hardcoded `true`, no context); it is NEVER the
 * capture point for `(from,to)` state writes (that is the Adapter.set seam in
 * capture.ts). The engine-supplied `duration` arg is stored on a NON-hashed
 * latency accumulator so Step 8's perf channel can read it WITHOUT a new engine
 * method and WITHOUT it ever reaching {@link hashTrace} (ADR-1 exclusion).
 *
 * Source-grep DoD: this file contains ZERO `Date.now` / `performance.now` /
 * `MetricsCollector` / `StateMachineMonitor` / `createDefaultMonitor` / `.start(`.
 */

import type { ErrorContext, IMonitor, TransitionContext } from '../index'

/**
 * Deterministic {@link IMonitor}. All state is integer counters plus a
 * non-hashed latency accumulator (the Step-8 perf hook).
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

  recordTransition(duration: number, success: boolean, _context?: TransitionContext): void {
    this.durations.push(duration)
    if (success) {
      this.transitionCount += 1
    } else {
      this.failureCount += 1
    }
  }

  recordError(_error: Error, _context?: ErrorContext): void {
    this.errorCount += 1
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
