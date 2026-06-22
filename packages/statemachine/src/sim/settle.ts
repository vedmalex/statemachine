/**
 * @module sim/settle
 * @unstable
 *
 * ADR-4 (R2): the ONE converged-macrostep settle primitive. This is the SOLE
 * settle surface in `src/sim/**`. There is NO `flush(N)` / `drainToQuiescence` /
 * `untilIdle` / `Op.flush` anywhere — a CODE_REVIEW grep
 * (`rg 'flush\(|drainToQuiescence|Op\.flush|untilIdle' src/sim`) returns zero,
 * and the only async pump in this file is `await Promise.resolve()`
 * (`rg 'setTimeout|setImmediate|process\.nextTick|setInterval' src/sim/settle.ts`
 * returns zero — no real timer ever runs in the hashed path; ADR-1).
 *
 * The converged inner loop interleaves scheduler reprocessing (same-instant
 * re-arms) with microtask draining until the JOINT fixed point:
 *
 *   getQueueDepth().total === 0
 *   && isProcessingEvents() === false
 *   && env.inFlightAsyncCount() === 0          ← CRIT-1 settledness signal
 *   && schedulerEmptyAt(clock.now()) === true
 *
 * `env.inFlightAsyncCount() === 0` is load-bearing (CRIT-1): the engine awaits a
 * consumer invoke/resume action (`await this.callAction(...)`,
 * `state_machine.ts:2170`/`:2504`) BEFORE it `raiseEvent`s and
 * `scheduleProcessing`s (`:2172-2173`). A purely structural predicate (queue +
 * processing only) would report `quiescent:true` while a follow-on event is
 * still un-enqueued behind a pending action; the in-flight conjunct holds the
 * macrostep until the action body actually settles.
 */

import type { SimClock } from './clock'
import type { Env } from './env'

/**
 * The minimal engine surface {@link settleMacrostep} reads. Every method is a
 * verified PUBLIC `StateMachine` accessor (so this never touches private state):
 *   - `getQueueDepth()`       state_machine.ts:483
 *   - `isProcessingEvents()`  state_machine.ts:509
 *
 * A real `StateMachine` is structurally assignable to this (it has both methods),
 * so callers pass the machine directly.
 */
export interface SettleTarget {
  getQueueDepth(): { internal: number; external: number; total: number }
  isProcessingEvents(): boolean
}

/** The scheduler control surface {@link settleMacrostep} drives to reprocess. */
export interface SettleScheduler {
  /** Drain every task whose `executeAt <= now` (default `now` = clock()). */
  process(now?: number): void
}

/** Settle policy: `'safety'` never jumps the clock; `'liveness'` may jump it forward. */
export type SettlePolicy = 'safety' | 'liveness'

/** Why a settle did NOT reach quiescence (only populated when `quiescent:false`). */
export type SettleReason =
  | 'microtask-budget' // microtask pump exhausted maxTurns before the predicate held
  | 'WAITING_ON_TIMER' // queues+inFlight empty but a future timer is pending (safety: no jump)
  | 'WAITING_ON_TRANSITION_TIMEOUT' // in-flight/queued work blocked on a future transitionTimeout (safety: no jump)

/** Outcome of one {@link settleMacrostep} call. */
export interface SettleResult {
  /** True iff the full quiescence predicate held within budget. */
  readonly quiescent: boolean
  /** Number of microtask-pump turns spent (across all jump re-entries). */
  readonly turns: number
  /** Populated only when `quiescent:false`. */
  readonly reason?: SettleReason
  /** Logical time at which the settle returned (post any liveness jump). */
  readonly t: number
}

/**
 * Default microtask-pump budget. Asserted `!== 16` and `!== 100` (DoD 5) so it
 * is not confused with the engine's `MAX_TRANSITION_DEPTH = 100` or the legacy
 * `flush(16)` idiom. On exhaustion {@link settleMacrostep} returns a budget
 * SIGNAL — it never throws or truncates silently.
 */
export const DEFAULT_MAX_TURNS = 1024

/**
 * Tunables passed to {@link settleMacrostep}. The microtask pump and the
 * scheduler/clock observation are all injected so the primitive has no hidden
 * global state.
 */
export interface SettleArgs {
  readonly sm: SettleTarget
  readonly scheduler: SettleScheduler
  readonly clock: SimClock
  readonly env: Env
  readonly policy: SettlePolicy
  /** Override the microtask-pump budget (defaults to {@link DEFAULT_MAX_TURNS}). */
  readonly maxTurns?: number
  /**
   * Optional sink the primitive calls once per liveness clock-jump, so the
   * driver can record a trace frame for the jump (ADR-4 c5: every jump is a
   * frame). Not called in `'safety'` mode.
   */
  readonly onClockJump?: (to: number) => void
}

/**
 * True iff every conjunct of the FULL quiescence predicate holds: queues empty,
 * not processing, no in-flight action, AND no pending timer AT ALL
 * (`earliestExecuteAt() === null`). A FUTURE timer (due after `now`) is NOT
 * quiescent — it is a `WAITING_ON_TIMER` finding in `'safety'` and a clock-jump
 * opportunity in `'liveness'`. The `schedulerEmptyAt(now)` view method is used
 * by callers/probes for the "due right now" question; full settledness requires
 * the strictly stronger "no timer pending" condition (ADR-4 / 5-kind Quiescence).
 */
function isQuiescent(args: SettleArgs): boolean {
  const { sm, env, clock } = args
  return (
    sm.getQueueDepth().total === 0 &&
    sm.isProcessingEvents() === false &&
    env.inFlightAsyncCount() === 0 &&
    env.schedulerEmptyAt(clock.now()) === true &&
    // strictly stronger than "nothing due now": no FUTURE timer is pending
    // either, so this is true settledness, not a WAITING_ON_TIMER finding.
    env.earliestExecuteAt() === null
  )
}

/** True iff there is queue/processing/in-flight work still pending (NOT timer-only). */
function hasPendingWork(args: SettleArgs): boolean {
  const { sm, env } = args
  return (
    sm.getQueueDepth().total > 0 ||
    sm.isProcessingEvents() === true ||
    env.inFlightAsyncCount() > 0
  )
}

/**
 * Run the converged macrostep settle to a joint fixed point.
 *
 * Mechanism (ADR-4 lines 232-239):
 *  1. `scheduler.process(clock.now())` — fire every due timer at the current
 *     instant (and any it re-arms for the same instant).
 *  2. Microtask pump: `while (hasPendingWork && turns < maxTurns) await
 *     Promise.resolve()` — let queued microtasks (invoke → raiseEvent →
 *     processQueues, awaited actions) run one layer per turn, reprocessing the
 *     scheduler each turn so same-instant re-arms are caught.
 *  3. When neither queue/processing/in-flight work remains, check the timer
 *     conjunct: if a FUTURE timer is pending, `'safety'` records a
 *     WAITING_ON_* reason and returns (NO jump); `'liveness'` jumps
 *     `clock.set(earliestExecuteAt())` (forward-only) and re-enters from step 1.
 *
 * Idempotency (dst.test.ts:#3): a second convergence pass at the same `t` does
 * not re-fire an already-extracted timer because the scheduler extracts the task
 * before firing (`scheduler.ts:108-132`) and the shim forgets it on fire.
 */
export async function settleMacrostep(args: SettleArgs): Promise<SettleResult> {
  const { scheduler, clock, env, policy } = args
  const maxTurns = args.maxTurns ?? DEFAULT_MAX_TURNS
  let turns = 0

  // A small quiet-flush window. The engine arms invoke timers and queues
  // `checkCompletion` via FLOATING microtasks during construction enter-actions
  // and after each transition (state_machine.ts:executeEnterActions(...).catch()
  // + queueMicrotask). Those are NOT observable via getQueueDepth /
  // isProcessingEvents / inFlightAsyncCount until they run, so the pump keeps
  // draining microtasks for a few quiet turns even when the structural predicate
  // momentarily reads empty — otherwise it would conclude before a delay:0
  // invoke timer is even armed. QUIET_FLUSH consecutive no-change turns is the
  // structural stability witness.
  //
  // CRITICAL ORDERING: timers must be `process`ed only AFTER the microtask queue
  // is quiet, never on every turn. An invoke timer is ARMED inside
  // `executeEnterActions` (state_machine.ts:2184) which runs in Phase 6, BEFORE
  // `setCurrentState(newState)` commits the entered state in Phase 8 (:2048).
  // Firing the timer eagerly (before the state write lands) makes the invoke
  // callback's `getCurrentState().includes(stateName)` guard (:2167) FALSE, so
  // the raised event is silently dropped and a delay:0 re-arm chain stalls. The
  // engine's own DST idiom is flush-to-quiet THEN `process()` — this loop
  // mirrors it: drain microtasks to quiescence, then fire due timers once, then
  // re-enter.
  //
  // QUIET_FLUSH must exceed the deepest engine microtask chain between an
  // observable becoming idle and its delayed follow-on enqueue. After an awaited
  // invoke action resolves (inFlightAsyncCount -> 0) the engine takes several
  // microtasks before the raised event lands in the queue (the resolved-action
  // continuation -> raiseEvent -> scheduleProcessing -> queueMicrotask chain,
  // empirically ~5-6 turns); a generous window absorbs it without ever masking
  // true quiescence (an idle machine keeps a stable fingerprint forever). The
  // 1024 turn budget leaves ample headroom.
  const QUIET_FLUSH = 16

  /** Observable settle fingerprint at the current instant. */
  const fingerprint = (): string => {
    const q = args.sm.getQueueDepth()
    return `${q.total}|${args.sm.isProcessingEvents()}|${env.inFlightAsyncCount()}`
  }

  // The outer loop re-fires due timers after each microtask-quiet window (and
  // re-enters after each liveness clock-jump). Bounded by the SAME `turns`
  // budget across all iterations.
  for (;;) {
    // (1) Microtask pump WITHOUT eager scheduler.process — drain queued work and
    // floating construction/post-transition microtasks to a stable quiet point
    // so any entered state's write has committed before timers fire.
    //
    // Two stable exits: (a) IDLE — no pending work, fingerprint held QUIET_FLUSH
    // turns (true quiescence candidate); (b) TIMER-GATED — pending work whose
    // fingerprint has held stable for QUIET_FLUSH turns WHILE a FUTURE timer is
    // armed (e.g. an in-flight transitionTimeout that only a clock-jump can
    // clear). Without exit (b), a liveness settle would burn the whole microtask
    // budget on `isProcessingEvents() === true` and never reach the clock-jump.
    let quiet = 0
    let stuck = 0
    let prev = fingerprint()
    while (turns < maxTurns) {
      const pending = hasPendingWork(args)
      if (!pending && quiet >= QUIET_FLUSH) {
        break // (a) idle
      }
      if (pending && stuck >= QUIET_FLUSH && env.earliestExecuteAt() !== null) {
        break // (b) timer-gated: stable pending work + a future deadline
      }
      await Promise.resolve()
      turns += 1
      const cur = fingerprint()
      if (cur === prev) {
        if (pending) {
          stuck += 1
        } else {
          quiet += 1
        }
      } else {
        quiet = 0
        stuck = 0
        prev = cur
      }
    }

    // (2) The microtask queue is quiet. Fire every timer due at the current
    // instant; their callbacks raise events + scheduleProcessing on fresh
    // microtasks, which the next outer iteration's pump drains.
    const firedAtThisInstant = env.earliestExecuteAt()
    scheduler.process(clock.now())
    if (firedAtThisInstant !== null && firedAtThisInstant <= clock.now()) {
      // A due timer just fired (or was a no-op extract); re-enter to drain its
      // microtask fallout and catch same-instant re-arms.
      if (turns < maxTurns) {
        continue
      }
    }

    const pendingNow = hasPendingWork(args)
    const earliest = env.earliestExecuteAt()

    if (turns >= maxTurns && pendingNow && earliest === null) {
      // Budget exhausted with pending work and NO future deadline that could
      // clear it: a genuine microtask-budget livelock finding (never a
      // throw/truncate). Timer-gated pending work falls through to the policy
      // decision below regardless of budget (the pump broke early on exit (b)).
      return { quiescent: false, turns, reason: 'microtask-budget', t: clock.now() }
    }

    // (3) Full quiescence: queue/processing/in-flight clear AND no timer pending.
    if (isQuiescent(args)) {
      return { quiescent: true, turns, t: clock.now() }
    }

    // Something is still un-settled. If there is NO future timer it can only be
    // pending work the pump could not clear within budget (covered above when
    // turns exhausted); guard defensively.
    /* c8 ignore next 3 */
    if (earliest === null) {
      return { quiescent: false, turns, reason: 'microtask-budget', t: clock.now() }
    }

    if (policy === 'safety') {
      // A FUTURE timer is armed (the single clock-jump lives in 'liveness').
      // Distinguish the two waits by whether non-timer work is still pending:
      //  - pendingNow === true  -> in-flight/queued work blocked on a future
      //    deadline only a jump can fire: WAITING_ON_TRANSITION_TIMEOUT.
      //  - pendingNow === false -> a plain empty-queue armed timer:
      //    WAITING_ON_TIMER.
      const reason: SettleReason = pendingNow ? 'WAITING_ON_TRANSITION_TIMEOUT' : 'WAITING_ON_TIMER'
      return { quiescent: false, turns, reason, t: clock.now() }
    }

    // policy === 'liveness': jump forward to the earliest deadline and re-enter.
    clock.set(earliest)
    args.onClockJump?.(earliest)
    // loop re-enters: scheduler.process(now) now fires the jumped-to timer.
  }
}
