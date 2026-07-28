/**
 * @module sim/liveness
 * @unstable
 *
 * ADR-6/4 LIVENESS plane: an explicit `PROGRESSED|STUCK|TIMEOUT_BUDGET_EXCEEDED`
 * verdict over a normalized {@link ProgressFingerprint}, with the five-kind
 * {@link Quiescence} classifier, the fire-boolean guard-blocked demotion, and a
 * `K = states.length + 1` configuration-cycle detector.
 *
 * Liveness CONSUMES — never re-defines — the Step-3 {@link settleMacrostep} (it
 * runs with `policy:'liveness'`, which owns the SINGLE clock-jump to
 * `earliestExecuteAt()`; Liveness itself owns NO jump). `pendingTimers` /
 * `earliestTimerAt` come from the Step-5 `ObservableScheduler`. This module is
 * PURE over the per-step liveness samples the harness feeds it; it makes NO live
 * engine call and runs NO local settle/drain/flush, and contains no
 * `Math.random` / `Date.now` / `performance.now`.
 *
 * Demotion semantics (ADR-6):
 *  - `maybeFireEnabledEvent` fires ONLY structurally-enabled events
 *    (getAvailableEvents :520; guards NOT executed there).
 *  - resolve-false + unchanged config + healthy ⇒ QUIESCENT_NO_WORK (a guard
 *    legitimately blocked; not a livelock).
 *  - resolve-true + unchanged config ⇒ STUCK (a self-loop with no progress).
 *  - reject (invalid-event :381-386) is routed DISTINCTLY (.catch so it never
 *    crashes the loop) and never counts as progress.
 */

import { normalizeParts } from './trace'

/**
 * The five-kind quiescence classification at a settle boundary (R12 adds
 * `WAITING_ON_TRANSITION_TIMEOUT` to the original four):
 *  - TERMINAL_FINAL: all declared composites done / a final leaf reached.
 *  - QUIESCENT_NO_WORK: no queued/in-flight work, no pending timer (idle).
 *  - WAITING_ON_TIMER: idle queues but a FUTURE timer is armed.
 *  - WAITING_ON_TRANSITION_TIMEOUT: in-flight/queued work blocked on a future
 *    transitionTimeout deadline only a clock-jump can clear.
 *  - ACTIVE: queue/processing/in-flight work still pending right now.
 */
export type Quiescence =
  | 'TERMINAL_FINAL'
  | 'QUIESCENT_NO_WORK'
  | 'WAITING_ON_TIMER'
  | 'WAITING_ON_TRANSITION_TIMEOUT'
  | 'ACTIVE'

/** The liveness verdict for a run. */
export type LivenessVerdict = 'PROGRESSED' | 'STUCK' | 'TIMEOUT_BUDGET_EXCEEDED'

/**
 * The normalized per-step liveness fingerprint. Two adjacent fingerprints that
 * compare EQUAL mean "no observable progress". `config` is '|'-normalized so a
 * region-order render difference (state_machine.ts:1202) is not mistaken for
 * progress.
 */
export interface ProgressFingerprint {
  /** normalized '|'-sorted composite. */
  readonly config: string
  readonly queueDepth: number
  readonly pendingTimers: number
  readonly earliestTimerAt: number | null
}

/** The liveness result for a run. */
export interface LivenessResult {
  readonly verdict: LivenessVerdict
  readonly quiescence: Quiescence
  readonly witness?: string
  readonly reason?: string
}

/**
 * One per-step liveness sample the harness feeds the analyzer. Carries the
 * normalized config, the queue/timer observations (from the ObservableScheduler),
 * the fire outcome of the step's `maybeFireEnabledEvent`, whether the config
 * changed, the health flag (fairness suppression), and whether the engine is
 * still in-flight (inFlightAsyncCount > 0).
 */
export interface LivenessSample {
  /** normalized '|'-sorted composite. */
  readonly config: string
  readonly queueDepth: number
  readonly pendingTimers: number
  readonly earliestTimerAt: number | null
  /** Outcome of the step's structurally-enabled fire (undefined ⇒ no fire issued). */
  readonly fireOutcome?: 'resolve-true' | 'resolve-false' | 'reject'
  /** True iff the normalized config changed across this step. */
  readonly configChanged: boolean
  /** Fairness gate: false ⇒ a progress-blocking fault window is active (suppress STUCK). */
  readonly healthy: boolean
  /** True iff an awaited consumer action is still in flight (inFlightAsyncCount > 0). */
  readonly inFlight: boolean
  /** True iff all declared composites are done / a final leaf was reached. */
  readonly terminal: boolean
  /** True iff a transitionTimeout is the only pending deadline (in-flight + future timer). */
  readonly waitingOnTransitionTimeout?: boolean
  /** Logical virtual time of this sample (never wall-clock). */
  readonly t: number
}

/** Build a {@link ProgressFingerprint} from a sample, normalizing `config`. */
export function fingerprintOf(sample: LivenessSample): ProgressFingerprint {
  return {
    config: normalizeParts(sample.config),
    queueDepth: sample.queueDepth,
    pendingTimers: sample.pendingTimers,
    earliestTimerAt: sample.earliestTimerAt,
  }
}

/** True iff two fingerprints are observably identical (no progress between them). */
export function fingerprintsEqual(a: ProgressFingerprint, b: ProgressFingerprint): boolean {
  return (
    a.config === b.config &&
    a.queueDepth === b.queueDepth &&
    a.pendingTimers === b.pendingTimers &&
    a.earliestTimerAt === b.earliestTimerAt
  )
}

/** Classify the five-kind quiescence of a single sample. */
export function classifyQuiescence(sample: LivenessSample): Quiescence {
  if (sample.terminal) {
    return 'TERMINAL_FINAL'
  }
  if (sample.queueDepth > 0 || sample.inFlight) {
    if (sample.waitingOnTransitionTimeout === true) {
      return 'WAITING_ON_TRANSITION_TIMEOUT'
    }
    return 'ACTIVE'
  }
  // queues + in-flight clear.
  if (sample.pendingTimers > 0) {
    return 'WAITING_ON_TIMER'
  }
  return 'QUIESCENT_NO_WORK'
}

/** Tunables for {@link analyzeLiveness}. */
export interface LivenessParams {
  /** Configuration-cycle window: K = states.length + 1 (ADR-6). */
  readonly stateCount: number
  /**
   * Virtual-time budget; the longest legal armed-timer chain
   * (Bounds.maxArmedDelay) must dominate it so a healthy run is not falsely
   * TIMEOUT_BUDGET_EXCEEDED. Exceeding it ⇒ TIMEOUT_BUDGET_EXCEEDED.
   */
  readonly budgetVirtualMs: number
  /**
   * If the underlying settleMacrostep returned a `microtask-budget`
   * non-quiescence, the harness sets this so the liveness verdict surfaces it.
   */
  readonly microtaskBudgetExhausted?: boolean
}

/**
 * Analyze a sequence of per-step liveness samples into a {@link LivenessResult}.
 *
 * Rules (ADR-6):
 *  - The settleMacrostep `microtask-budget` non-quiescence surfaces as
 *    TIMEOUT_BUDGET_EXCEEDED (a liveness finding, never a throw).
 *  - A virtual-time budget overrun ⇒ TIMEOUT_BUDGET_EXCEEDED.
 *  - A configuration cycle within the healthy window — the SAME normalized
 *    fingerprint recurs after K = stateCount + 1 distinct steps while
 *    `resolve-true` keeps firing without terminal progress ⇒ STUCK
 *    'configuration cycle'.
 *  - resolve-true + unchanged config (a self-loop with no progress) ⇒ STUCK.
 *  - resolve-false + unchanged + healthy (a guard legitimately blocked) ⇒
 *    QUIESCENT_NO_WORK (PROGRESSED-equivalent: not a livelock).
 *  - A `reject` is routed distinctly and never counts as progress (it also never
 *    crashes the analysis).
 *  - While `healthy === false` (a progress-blocking fault window) STUCK is
 *    SUPPRESSED (fairness): no STUCK verdict can be reached on an unhealthy sample.
 *  - Otherwise the run PROGRESSED (reached a terminal/quiescent fingerprint).
 */
export function analyzeLiveness(
  samples: readonly LivenessSample[],
  params: LivenessParams,
): LivenessResult {
  const last = samples[samples.length - 1]
  const finalQuiescence = last !== undefined ? classifyQuiescence(last) : 'QUIESCENT_NO_WORK'

  // (0) microtask-budget livelock from settleMacrostep → liveness finding.
  if (params.microtaskBudgetExhausted === true) {
    return {
      verdict: 'TIMEOUT_BUDGET_EXCEEDED',
      quiescence: finalQuiescence,
      reason: 'macrostep microtask-budget exhausted',
    }
  }

  // (1) virtual-time budget overrun.
  if (last !== undefined && last.t > params.budgetVirtualMs) {
    return {
      verdict: 'TIMEOUT_BUDGET_EXCEEDED',
      quiescence: finalQuiescence,
      reason: `virtual time ${last.t} exceeded budget ${params.budgetVirtualMs}`,
    }
  }

  // (2) configuration-cycle detector over the HEALTHY window.
  const K = params.stateCount + 1
  const healthyFps: { fp: ProgressFingerprint; idx: number }[] = []
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    if (s === undefined || !s.healthy) {
      continue
    }
    const fp = fingerprintOf(s)
    // A recurring fingerprint within the K-window, with resolve-true still firing
    // and no terminal reached, is a configuration cycle ⇒ STUCK.
    const prior = healthyFps.find((e) => fingerprintsEqual(e.fp, fp))
    if (prior !== undefined && i - prior.idx <= K && !s.terminal && s.fireOutcome === 'resolve-true') {
      return {
        verdict: 'STUCK',
        quiescence: classifyQuiescence(s),
        witness: fp.config,
        reason: 'configuration cycle',
      }
    }
    healthyFps.push({ fp, idx: i })
  }

  // (3) self-loop STUCK: resolve-true + config unchanged on a HEALTHY sample —
  // BUT only when NO observable progress accompanies the unchanged config (C2).
  // A resolve-true self-transition that leaves the composite unchanged yet keeps
  // GROWING (or shrinking) an observable — the queue depth, the pending-timer
  // count, or the earliest armed deadline — is doing real work, not livelocking.
  // Ignoring that progress (the pre-C2 `!configChanged`-only branch) falsely
  // classified a legitimate progressing self-loop as STUCK. We therefore compare
  // each unchanged-config self-loop sample against its immediate predecessor and
  // only declare STUCK when the observables ALSO held identical (true no-progress).
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    if (s === undefined) {
      continue
    }
    if (!(s.healthy && s.fireOutcome === 'resolve-true' && !s.configChanged && !s.terminal)) {
      continue
    }
    const prev = samples[i - 1]
    const observableProgress =
      prev !== undefined &&
      (s.queueDepth !== prev.queueDepth ||
        s.pendingTimers !== prev.pendingTimers ||
        s.earliestTimerAt !== prev.earliestTimerAt)
    if (observableProgress) {
      // The config held but an observable moved: real progress, not a self-loop.
      continue
    }
    // A resolve-true that changed NEITHER the config NOR any observable and did
    // not terminate is a genuine no-progress self-loop ⇒ STUCK (healthy only —
    // fairness gate).
    return {
      verdict: 'STUCK',
      quiescence: classifyQuiescence(s),
      witness: normalizeParts(s.config),
      reason: 'resolve-true with no configuration change (self-loop)',
    }
  }

  // (4) PROGRESSED: a guard-blocked resolve-false (QUIESCENT_NO_WORK) or a clean
  // terminal/idle run. resolve-false + unchanged + healthy is the legitimate
  // guard-block demotion (not a livelock).
  return {
    verdict: 'PROGRESSED',
    quiescence: finalQuiescence,
  }
}
