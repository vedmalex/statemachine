/**
 * @module sim/sim-error-handler
 * @unstable
 *
 * ADR-3 c4 deterministic error-handler seam. Full six-method
 * {@link IErrorHandler} (types.ts:107-114).
 *
 * Registers NO `RetryRecoveryStrategy` (its real `setTimeout` at
 * error_handling.ts:154 would be an unreachable timer in the hashed path).
 * `isEnabled()` returns a PINNED `true` and STAYS true through
 * `disable()`/`enable()` (both no-ops) so the engine's real `recordError` gate
 * (state_machine.ts:424 — `if (this.errorHandler.isEnabled())`) is exercised.
 *
 * `getAnalytics()` returns a FROZEN {@link ErrorAnalytics} that the harness
 * NEVER feeds an error: the determinism comes from "zero errors fed", NOT from
 * `Object.freeze`. `ErrorAnalytics.getErrorStats()` internally reads `Date.now()`
 * (error_handling.ts:249) but returns the constant zero-state for an empty error
 * set, so two calls deep-equal. A DoD asserts the harness never invokes
 * `recordError` on this instance.
 *
 * Source-grep DoD: ZERO `RetryRecoveryStrategy` / `setTimeout` in this file.
 */

import { ErrorAnalytics, type ErrorRecoveryStrategy, type IErrorHandler } from '../index'

/**
 * Deterministic {@link IErrorHandler}. `isEnabled()` is pinned true; recovery
 * strategy registration is a structural no-op (no strategy is ever stored, so
 * no real-timer retry path is reachable); `getAnalytics()` returns a frozen,
 * never-fed {@link ErrorAnalytics}.
 */
export class SimErrorHandler implements IErrorHandler {
  /** FROZEN never-fed analytics. Empty error set => constant zero-state. */
  private readonly analytics: ErrorAnalytics

  constructor() {
    const analytics = new ErrorAnalytics()
    // Freeze the live instance (Object.freeze returns the same reference); the
    // determinism comes from "zero errors fed", the freeze just prevents a
    // consumer mutating the shared seam.
    Object.freeze(analytics)
    this.analytics = analytics
  }

  isEnabled(): boolean {
    return true
  }

  enable(): void {
    // no-op — isEnabled() stays pinned true
  }

  disable(): void {
    // no-op — isEnabled() stays pinned true (does NOT flip the gate)
  }

  addRecoveryStrategy(_strategy: ErrorRecoveryStrategy): void {
    // no-op — NO strategy is stored; the RetryRecoveryStrategy setTimeout path
    // (error_handling.ts:154) is therefore unreachable through this seam.
  }

  removeRecoveryStrategy(_strategyName: string): void {
    // no-op — nothing is ever registered
  }

  getAnalytics(): ErrorAnalytics {
    return this.analytics
  }
}
