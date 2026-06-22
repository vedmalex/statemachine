/**
 * @module sim/fairness
 * @unstable
 *
 * ADR-6 FAIRNESS: the eventually-healthy fault schedule. Liveness STUCK verdicts
 * are SUPPRESSED while a progress-blocking fault window is active
 * (`isHealthyAt(clock.t) === false`): a drop/throw/overflow/corrupt-state fault
 * legitimately prevents progress until `healAtVirtualMs`, so a STUCK during that
 * window would be a FALSE POSITIVE. After healing, progress-blocking faults cease
 * and the machine must reach PROGRESSED / TERMINAL_FINAL. Perturb-only faults
 * (reorder / dup / timer-jitter) may continue indefinitely (they do not block
 * progress, only reorder/perturb it).
 *
 * `healWindow` is the virtual-time budget; it MUST dominate the longest legal
 * armed-timer chain (`Bounds.maxArmedDelay`, fed in by the harness) so a healthy
 * run is never falsely TIMEOUT_BUDGET_EXCEEDED.
 *
 * This module is PURE: it reads only its declared fields + the supplied virtual
 * time; NO `Math.random` / `Date.now` / `performance.now`, no engine call, no
 * local settle/drain.
 */

import type { FaultKind } from './trace'

/**
 * The set of fault kinds that BLOCK progress (and so must cease after healing for
 * a liveness verdict to be meaningful). `corrupt-state` is the 8th probe; it is
 * progress-blocking too. Perturb-only kinds (reorder/dup/timer-jitter) are NOT
 * here — they may continue indefinitely.
 */
export const PROGRESS_BLOCKING_FAULTS: ReadonlySet<FaultKind | 'corrupt-state'> = new Set<
  FaultKind | 'corrupt-state'
>(['drop', 'throw', 'overflow', 'corrupt-state'])

/** Perturb-only fault kinds — reorder/perturb but do not block progress. */
export const PERTURB_ONLY_FAULTS: ReadonlySet<FaultKind> = new Set<FaultKind>([
  'reorder',
  'dup',
  'timer-jitter',
])

/** True iff `kind` blocks progress (must cease after healAtVirtualMs). */
export function isProgressBlocking(kind: FaultKind | 'corrupt-state'): boolean {
  return PROGRESS_BLOCKING_FAULTS.has(kind)
}

/**
 * The eventually-healthy fault schedule. Progress-blocking faults are active
 * (machine may legitimately not progress) until `healAtVirtualMs`; after that the
 * machine is HEALTHY and must make progress. `clock-skew` is treated as
 * progress-affecting-but-not-blocking once the single forward jump has applied, so
 * it heals like the perturb-only family.
 */
export interface FaultSchedule {
  /** Virtual time (logical ms) at which progress-blocking faults cease. */
  readonly healAtVirtualMs: number
  /**
   * The total virtual-time budget. Dominates the longest legal armed-timer chain
   * (`Bounds.maxArmedDelay`) so a healthy run is not falsely budget-exceeded.
   */
  readonly budgetVirtualMs: number
  /** True iff the machine is HEALTHY at logical time `t` (faults have healed). */
  isHealthyAt(t: number): boolean
}

/**
 * Build a {@link FaultSchedule}. `healAtVirtualMs` must be < `budgetVirtualMs`
 * (there must be a healthy window before the budget is hit), and `budgetVirtualMs`
 * must dominate `longestArmedChainMs` (the longest legal timer chain) so the
 * healthy machine has time to make progress. Both constraints are validated.
 */
export function makeFaultSchedule(opts: {
  healAtVirtualMs: number
  budgetVirtualMs: number
  longestArmedChainMs: number
}): FaultSchedule {
  const { healAtVirtualMs, budgetVirtualMs, longestArmedChainMs } = opts
  if (!(healAtVirtualMs < budgetVirtualMs)) {
    throw new Error(
      `makeFaultSchedule: healAtVirtualMs (${healAtVirtualMs}) must be < budgetVirtualMs (${budgetVirtualMs})`,
    )
  }
  if (!(budgetVirtualMs >= longestArmedChainMs)) {
    throw new Error(
      `makeFaultSchedule: budgetVirtualMs (${budgetVirtualMs}) must dominate the longest armed chain (${longestArmedChainMs})`,
    )
  }
  return {
    healAtVirtualMs,
    budgetVirtualMs,
    isHealthyAt(t: number): boolean {
      return t >= healAtVirtualMs
    },
  }
}

/**
 * True iff a STUCK verdict on a sample at virtual time `t` should be SUPPRESSED by
 * fairness: a progress-blocking fault window is still active (`isHealthyAt(t)` is
 * false). After healing this returns false and STUCK becomes a legitimate verdict.
 */
export function suppressesStuck(schedule: FaultSchedule, t: number): boolean {
  return !schedule.isHealthyAt(t)
}
