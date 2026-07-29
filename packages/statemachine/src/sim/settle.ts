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

/**
 * Why a settle did NOT reach quiescence (only populated when `quiescent:false`).
 *
 * NONE of these five reasons can convict a machine. The two BUDGET reasons are
 * advisory readings of a truncated 1024-turn window; `WAITING_ON_TIMER` and
 * `WAITING_ON_TRANSITION_TIMEOUT` name legitimate waits on time; and
 * `WAITING_ON_INTERNAL` — which DID carry the RTC oracle's teeth — is the same
 * truncation over the 16-turn `QUIET_FLUSH` window. Its early break (exit (b))
 * looked like a stronger observation than a budget exhaustion but is not: see the
 * note at exit (b) for the measurement that refuted it.
 */
export type SettleReason =
  | 'microtask-budget' // pump exhausted maxTurns with no RECENT observable progress — advisory: a wedge OR a hook doing long internal work
  | 'budget-progressing' // pump exhausted maxTurns while the machine was STILL progressing — advisory: it was working when we stopped watching
  | 'WAITING_ON_TIMER' // queues+inFlight empty but a future timer is pending (safety: no jump)
  | 'WAITING_ON_TRANSITION_TIMEOUT' // GENUINE in-flight async (inFlight>0) racing a future deadline (safety: no jump)
  | 'WAITING_ON_INTERNAL' // pending queue/processing with NO tracked in-flight async + a future timer — a wedged-flag / undrained-queue RTC concern (U1)

/**
 * ONE observation of the three engine-observable settle components, taken at a
 * MICROTASK CHECKPOINT inside the pump.
 *
 * ## THE SAMPLE DEFINITION — read this before adding any second read site
 * A sample is the observation taken IMMEDIATELY AFTER `await Promise.resolve()`
 * in {@link settleMacrostep}'s inner pump, EXACTLY ONCE PER TURN, AND NOWHERE
 * ELSE. That is not a stylistic preference; it is the entire premise of the I-13
 * oracle, whose soundness rests on there being a real microtask boundary — and
 * therefore a full drain of every microtask queued before it — BETWEEN any two
 * consecutive samples.
 *
 * The natural place to hang a second read is the `prev = fingerprint()`
 * initializer at the top of each OUTER iteration, which runs after a SYNCHRONOUS
 * `scheduler.process` and executes no `await` at all. Two "consecutive" samples
 * with no microtask boundary between them would let I-13 convict a correct
 * machine — the exact shape of the four RTC oracles that failed before it. The
 * relation `sampleCount === SettleResult.turns` is therefore an INVARIANT of this
 * file, and it is pinned by `src/tests/sim/rtc_stall_oracle.test.ts` precisely so
 * a second sampling site turns red instead of turning the oracle unsound.
 *
 * `turn` is the 1-based pump-turn index WITHIN one {@link settleMacrostep} call.
 * It is what makes "consecutive" checkable by a consumer without a settle-instance
 * id: two samples are microtask-adjacent iff `b.turn === a.turn + 1`, and since
 * every settle restarts at 1 the first sample of a NEW settle can never chain
 * onto the last sample of the previous one.
 */
export interface SettleSample {
  /** 1-based pump-turn index within THIS `settleMacrostep` call. */
  readonly turn: number
  /** `sm.getQueueDepth().total` at the checkpoint. */
  readonly queueTotal: number
  /** `sm.isProcessingEvents()` at the checkpoint. */
  readonly processing: boolean
  /** `env.inFlightAsyncCount()` at the checkpoint — the SIM-side composed count. */
  readonly inFlight: number
}

/**
 * What `makeRtcStallRecorder` accumulates across a run, and the ONLY thing
 * the I-13 oracle reads. See `makeRtcStallRecorder` for the predicate and
 * `invariants.ts` (I-13) for the soundness argument.
 */
export interface RtcStallObservation {
  /** Total samples taken across every settle the recorder was wired into. */
  readonly samples: number
  /**
   * Longest run of MICROTASK-ADJACENT samples for which the stall predicate
   * `queueTotal > 0 && !processing && inFlight === 0` held. `>= 2` is the I-13
   * witness; `1` is a reading a CORRECT machine legitimately produces.
   *
   * FORCED TO 0 unless {@link RtcStallObservation.hostMicrotaskPlane} is
   * `'verified'` — see {@link makeRtcStallRecorder}.
   */
  readonly maxRun: number
  /** `queueTotal` observed at the sample that set {@link maxRun} (0 when none). */
  readonly witnessQueueTotal: number
  /**
   * Whether this host's `queueMicrotask` was OBSERVED to share the promise-
   * continuation FIFO, which is the premise the I-13 one-turn bound rests on.
   *
   * - `'verified'` — a self-probe confirmed it; `maxRun` is a real reading.
   * - `'foreign'` — the probe FAILED (a faked/deferring/synchronous
   *   `queueMicrotask`); the observation is VACUOUS.
   * - `'pending'` — the probe has not settled yet; vacuous until it does.
   */
  readonly hostMicrotaskPlane: 'verified' | 'foreign' | 'pending'
}

/** Mutable probe result slot; `verified === undefined` means "not settled yet". */
interface HostPlaneProbe {
  verified: boolean | undefined
}

/**
 * One probe per DISTINCT `queueMicrotask` implementation, so the normal case
 * costs nothing: the module-load probe below claims the native function, and
 * every later {@link makeRtcStallRecorder} is a lookup hit that queues no
 * microtasks and therefore cannot perturb the sample stream it observes.
 */
const HOST_PLANE_PROBES = new WeakMap<object, HostPlaneProbe>()

/**
 * Establish, by OBSERVATION rather than by assertion, that `qmt` behaves like
 * the native `queueMicrotask`: a callback handed to it must run
 *
 *  - NOT synchronously (it is a microtask, not a direct call), and
 *  - BEFORE a promise continuation queued AFTER it (one shared FIFO queue).
 *
 * That second half is exactly the step the I-13 one-turn bound is built on —
 * "any microtask already queued at sample n runs before sample n+1". A
 * `Function.prototype.toString` native-code sniff would be weaker: a wrapper
 * that defers is trivially able to defeat it, and a legitimate polyfill would
 * fail it. A behavioural probe judges the behaviour.
 */
function probeHostPlane(qmt: typeof queueMicrotask): HostPlaneProbe {
  const key = qmt as unknown as object
  const hit = HOST_PLANE_PROBES.get(key)
  if (hit !== undefined) {
    return hit
  }
  const slot: HostPlaneProbe = { verified: undefined }
  HOST_PLANE_PROBES.set(key, slot)
  void (async (): Promise<void> => {
    let ran = false
    try {
      qmt(() => {
        ran = true
      })
    } catch {
      slot.verified = false // not callable as a microtask sink at all
      return
    }
    if (ran) {
      slot.verified = false // ran SYNCHRONOUSLY — not a microtask
      return
    }
    // The continuation of this await is queued STRICTLY AFTER the callback
    // above. Under one shared FIFO plane the callback has already run.
    await Promise.resolve()
    slot.verified = ran
  })()
  return slot
}

// Claim the load-time `queueMicrotask` eagerly, at import, so no recorder
// constructed during a run ever pays for a probe on the normal path.
probeHostPlane(globalThis.queueMicrotask)

/**
 * A live, run-scoped accumulator over {@link SettleSample}s implementing the I-13
 * stall predicate.
 *
 * THE PREDICATE: `queueTotal > 0 && processing === false && inFlight === 0` — the
 * machine has queued work, is not draining it, and has no in-flight async
 * operation that could still be about to enqueue+schedule.
 *
 * WHY A RUN OF 2, NEVER 1. `processQueues` sets `isProcessing = true`
 * SYNCHRONOUSLY before its first `await` (state_machine.ts `processQueues`), so a
 * pending `queueMicrotask(processQueues)` that runs between two samples is
 * observable at the SECOND one. Conversely a correct machine DOES produce a
 * single positive reading whenever the enqueue happens in a floating microtask
 * that was already queued ahead of the pump's own continuation: that continuation
 * runs BEFORE the freshly-queued `processQueues`, so it sees `queue > 0 &&
 * !processing` once. One positive is therefore NOT a finding; two consecutive
 * ones are.
 *
 * THE HOST IS PART OF THE PREMISE, AND IT IS CHECKED. Every step of the
 * one-turn bound above is about the ENGINE except one: "a pending
 * `queueMicrotask(processQueues)` runs between two samples". That is a property
 * of the HOST — it holds because `queueMicrotask` callbacks and promise
 * continuations share one FIFO microtask queue. Under a harness that FAKES
 * `queueMicrotask` (sinon fake-timers supports it; `vi.useFakeTimers({ toFake:
 * [...] })` can reach it) `scheduleProcessing`'s continuation is deferred
 * arbitrarily and the predicate holds for the whole budget on a PERFECTLY
 * CORRECT machine.
 *
 * That is not hypothetical. MEASURED on `a -(invoke delay:0, async action)-> b`
 * — the fixture whose native reading is `maxRun: 1` — with `queueMicrotask`
 * replaced by a deferring stub: `maxRun: 44` in a 64-turn budget, which is the
 * SAME number `invariants.ts` records for the deliberately MUTATED engine. The
 * deciding variable was the observer, not the machine: exactly the failure
 * family that withdrew four earlier RTC oracles.
 *
 * So the recorder ESTABLISHES the premise instead of asserting it in a comment
 * (`header.runtime` pins a STRING, not the fact). {@link probeHostPlane} runs a
 * one-shot behavioural self-probe and `observation()` reports
 * `hostMicrotaskPlane` with `maxRun` FORCED TO 0 whenever it is not
 * `'verified'` — a missing premise makes the oracle vacuous, never a conviction
 * (the I-4 convention).
 *
 * LIMIT, stated: the plane is re-resolved from `globalThis` at `observation()`
 * time, so a fake installed at any point before the observation is read is
 * caught. A fake installed and REMOVED entirely within one run is not
 * observable by this design.
 *
 * The returned `onSample` is an ARROW closure with no `this`, so it can be
 * detached and handed straight to {@link SettleArgs.onSample}.
 */
export function makeRtcStallRecorder(): {
  readonly onSample: (sample: SettleSample) => void
  observation(): RtcStallObservation
} {
  probeHostPlane(globalThis.queueMicrotask)
  let samples = 0
  let run = 0
  let maxRun = 0
  let witnessQueueTotal = 0
  let prevTurn = -1
  return {
    onSample: (s: SettleSample): void => {
      samples += 1
      const holds = s.queueTotal > 0 && s.processing === false && s.inFlight === 0
      if (!holds) {
        run = 0
        prevTurn = s.turn
        return
      }
      // Chain ONLY onto the immediately preceding turn of the SAME settle. A new
      // settle restarts `turn` at 1, and `prevTurn + 1 === 1` would require
      // `prevTurn === 0`, which no sample ever carries — so a run can never span
      // two settleMacrostep calls (between which arbitrary synchronous driver
      // work, not a microtask boundary, has happened).
      run = s.turn === prevTurn + 1 ? run + 1 : 1
      prevTurn = s.turn
      if (run > maxRun) {
        maxRun = run
        witnessQueueTotal = s.queueTotal
      }
    },
    observation(): RtcStallObservation {
      const { verified } = probeHostPlane(globalThis.queueMicrotask)
      if (verified !== true) {
        // VACUOUS. `samples` stays honest so a caller can see the plane was
        // wired and still produced no reading, rather than mistaking this for
        // "never sampled".
        return {
          samples,
          maxRun: 0,
          witnessQueueTotal: 0,
          hostMicrotaskPlane: verified === false ? 'foreign' : 'pending',
        }
      }
      return { samples, maxRun, witnessQueueTotal, hostMicrotaskPlane: 'verified' }
    },
  }
}

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
 * A small quiet-flush window: how many consecutive no-change turns the pump
 * treats as the structural stability witness.
 *
 * The engine arms invoke timers and queues `checkCompletion` via FLOATING
 * microtasks during construction enter-actions and after each transition
 * (state_machine.ts:executeEnterActions(...).catch() + queueMicrotask). Those are
 * NOT observable via getQueueDepth / isProcessingEvents / inFlightAsyncCount
 * until they run, so the pump keeps draining microtasks for a few quiet turns
 * even when the structural predicate momentarily reads empty — otherwise it
 * would conclude before a `delay:0` invoke timer is even armed.
 *
 * CRITICAL ORDERING: timers must be `process`ed only AFTER the microtask queue
 * is quiet, never on every turn. An invoke timer is ARMED inside
 * `executeEnterActions` (state_machine.ts:2184) which runs in Phase 6, BEFORE
 * `setCurrentState(newState)` commits the entered state in Phase 8 (:2048).
 * Firing the timer eagerly (before the state write lands) makes the invoke
 * callback's `getCurrentState().includes(stateName)` guard (:2167) FALSE, so the
 * raised event is silently dropped and a `delay:0` re-arm chain stalls. The
 * engine's own DST idiom is flush-to-quiet THEN `process()` — the loop mirrors
 * it: drain microtasks to quiescence, then fire due timers once, then re-enter.
 *
 * The value must exceed the deepest engine microtask chain between an observable
 * becoming idle and its delayed follow-on enqueue. After an awaited invoke action
 * resolves (inFlightAsyncCount -> 0) the engine takes several microtasks before
 * the raised event lands in the queue (the resolved-action continuation ->
 * raiseEvent -> scheduleProcessing -> queueMicrotask chain, empirically ~5-6
 * turns); a generous window absorbs it without ever masking true quiescence (an
 * idle machine keeps a stable fingerprint forever). The 1024 turn budget leaves
 * ample headroom.
 */
const QUIET_FLUSH = 16

/**
 * Nominal RECENCY window for the budget-exhaustion classification: how many
 * turns may have passed since the fingerprint last MOVED for the exhaustion to
 * still be described as "the machine was working".
 *
 * MEASURED, NOT STRUCTURAL. 16 (`QUIET_FLUSH`) is the largest quiet gap OBSERVED
 * on the zero-delay chain fixtures (`budget_progressing.test.ts`, chains of
 * 5/20/40/60/120 hops), with 9-11 turns at the exhaustion site itself; the wedge
 * fixture (`budget_wedge.test.ts`) sat at 1007. `4 * QUIET_FLUSH` therefore
 * carries a 4x margin over the measured worst case. It is NOT a bound the pump's
 * break conditions imply — see the note at the exhaustion site — which is exactly
 * why the resulting classification is ADVISORY and never a verdict.
 */
export const PROGRESS_RECENCY_WINDOW = 4 * QUIET_FLUSH

/**
 * The EFFECTIVE recency window for a given pump budget.
 *
 * {@link PROGRESS_RECENCY_WINDOW} is an absolute 64 while `maxTurns` is per-call.
 * For any caller with `maxTurns <= 64` the recency test `turns - lastMoveTurn <=
 * 64` is unconditionally TRUE the moment anything has moved (the whole settle is
 * shorter than the window), so the moving/frozen distinction silently collapses
 * to "moving" — the classification stops carrying information without saying so.
 * The public sentinel probe already runs at exactly `maxTurns: 64`.
 *
 * The window is therefore capped at HALF the budget: the largest fraction that
 * still leaves an equally-sized STALE region the predicate can observe. At the
 * default 1024 the cap is inactive (512 > 64) and the constant applies unchanged.
 * The floor of 1 keeps a degenerate 1-2 turn budget from producing a zero-width
 * window that would call every exhaustion frozen.
 */
export function progressRecencyWindow(maxTurns: number): number {
  return Math.min(PROGRESS_RECENCY_WINDOW, Math.max(1, Math.floor(maxTurns / 2)))
}

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
  /**
   * Optional sink called EXACTLY ONCE PER PUMP TURN, immediately after the pump's
   * `await Promise.resolve()` and nowhere else — see {@link SettleSample} for why
   * that placement is load-bearing rather than incidental.
   *
   * The number of calls equals {@link SettleResult.turns} for every settle,
   * unconditionally. Wire `makeRtcStallRecorder` here to feed the I-13
   * oracle; absent ⇒ zero cost and the oracle is vacuous.
   */
  readonly onSample?: (sample: SettleSample) => void
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
  /**
   * The turn index at which the observable fingerprint LAST moved, or `null` if
   * it has not moved once during this settle. Kept across the whole settle (the
   * outer `for(;;)` re-samples `prev` per inner pass, so `prev` alone cannot
   * carry the history). Read at the budget-exhaustion sites via
   * {@link classifyExhaustion}.
   */
  let lastMoveTurn: number | null = null

  /**
   * The EFFECTIVE recency window for THIS settle's budget. See
   * {@link progressRecencyWindow}: the nominal 64 is capped at half `maxTurns`
   * so a small per-call budget cannot make the recency test trivially true.
   */
  const recencyWindow = progressRecencyWindow(maxTurns)

  /**
   * The shared budget-exhaustion classification (both exhaustion return sites
   * MUST use this — a divergence between them is exactly how the sticky-flag
   * defect stayed invisible).
   *
   * ADVISORY, NEVER A VERDICT. Both outcomes describe the SAME event — the pump
   * stopped watching — and neither can convict. A frozen `maxTurns`-turn prefix
   * produced by a hook that finishes at turn 2000 is byte-identical to one
   * produced by a hook that never finishes; the classification only says which
   * of the two READINGS the observed prefix is more consistent with, so the
   * consumer knows which question to ask next. Nothing downstream may turn
   * either value into a `FailCause`, an invariant violation, or a liveness
   * verdict (see the I-3 note in `invariants.ts` and the removal note in
   * `liveness.ts`).
   */
  const classifyExhaustion = (): SettleReason => {
    if (lastMoveTurn === null) {
      return 'microtask-budget' // nothing moved during the whole window
    }
    return turns - lastMoveTurn <= recencyWindow ? 'budget-progressing' : 'microtask-budget'
  }

  /**
   * Read the three observable components at the current instant. PURE — no sink
   * is notified from here. {@link SettleArgs.onSample} is driven from the ONE
   * post-await site inside the pump; every other caller of this helper (notably
   * the per-outer-iteration `prev = fingerprint()`) is deliberately silent
   * because it observes NO microtask boundary. See {@link SettleSample}.
   */
  const observe = (): Omit<SettleSample, 'turn'> => ({
    queueTotal: args.sm.getQueueDepth().total,
    processing: args.sm.isProcessingEvents(),
    inFlight: env.inFlightAsyncCount(),
  })

  /** The frozen fingerprint string form (`total|processing|inFlight`). */
  const fingerprintOf = (o: Omit<SettleSample, 'turn'>): string =>
    `${o.queueTotal}|${o.processing}|${o.inFlight}`

  /** Observable settle fingerprint at the current instant. */
  const fingerprint = (): string => fingerprintOf(observe())

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
        // (b) timer-gated: stable pending work + a future deadline.
        //
        // WHAT THIS BREAK DOES AND DOES NOT OBSERVE. Its entire content is "the
        // fingerprint has not moved for QUIET_FLUSH turns and SOME timer is armed".
        // That is the same frozen-prefix object a budget exhaustion produces, over a
        // window 64x smaller — and the armed timer may belong to a completely
        // unrelated parallel region. It was long described as an observation made
        // "inside budget" and therefore stronger than a truncation; it is not.
        //
        // `stuck` counts turns over `queueDepth|isProcessingEvents|inFlightAsyncCount`,
        // and that fingerprint stays frozen across an ENTIRE ordinary microstep. The
        // reason is width, and it has THREE distinct sources — NOT the single one
        // this note used to give. (Method names, not line numbers: the previous
        // citations here had rotted to unrelated code, which is exactly how a wrong
        // derivation survived.)
        //
        //  1. SELECTION — the dominant term, and the one that has nothing to do with
        //     hooks. `computeEnabledSet` awaits `selectTransition` ONCE PER ACTIVE
        //     LEAF, so an N-region machine pays at least N awaits per selection even
        //     with no hook and no guard anywhere in the config.
        //  2. THE EXIT SIDE — `executeExitActions` awaits `runExitAction` three times
        //     per exited state UNCONDITIONALLY; its `if (!action) return` sits INSIDE
        //     the awaited callee. Three hops per exited state, hooks or no hooks.
        //  3. THE ENTER SIDE IS NOT LIKE THAT — and the old wording, which claimed
        //     the engine "awaits once per hook slot per state even when no hook is
        //     defined" as a symmetric fact, was simply FALSE for it.
        //     `executeEnterActions` tests `if (action)` OUTSIDE the await, so a
        //     hookless enter slot costs NO hop at all.
        //
        // The O(width) conclusion therefore still holds — via (1) alone, and more
        // strongly via (1)+(2) — but not for the stated reason.
        //
        // MEASURED at HEAD on a flat N-region parallel machine, one event exiting
        // every region, counting the longest frozen-fingerprint run inside the
        // pending-work window (`probe_gap`, A1/A2 wave):
        //
        //     N regions:        1    2    4    8   16   32
        //     no hooks:        11   17   29   53  101  197      (= 6N + 5)
        //     onEnter+onExit:  16   27   49   93  181  357      (= 11N + 5)
        //
        // A fixed 16-turn window is thus refuted by a CORRECT machine at N=2 with no
        // hooks at all. Consequently the `WAITING_ON_INTERNAL` this break leads to is
        // ADVISORY (see SettleReason).
        //
        // The direct observation this proxy was standing in for now exists:
        // `StateMachine#getProgress()` (A2) exposes a monotonic engine phase-advance
        // `tick`, and over the SAME runs the longest frozen-TICK run is 1 (no hooks)
        // and 3 (with hooks) — CONSTANT in N, because every tick site sits adjacent
        // to an existing drain-path await. Its companion `openDispatches` (A1) names
        // which consumer callable is holding the drain when the tick does not move.
        // This note stays here rather than being replaced by that reading: nothing in
        // this file consumes `getProgress()`, and wiring a live engine read into the
        // settle predicate would breach the zero-core-ABI rule the harness is built on.
        break
      }
      await Promise.resolve()
      turns += 1
      // ===================================================================
      // THE SINGLE SAMPLING SITE. Do not add a second one. `onSample` must
      // appear exactly once in this file: the I-13 oracle's soundness is the
      // claim that consecutive samples are separated by a REAL microtask
      // boundary, and the only place in this pump where that is true is right
      // here, one statement after the `await`. `sampleCount === turns` is
      // pinned by src/tests/sim/rtc_stall_oracle.test.ts, both behaviourally
      // and by a source-text count of this call.
      // ===================================================================
      const observed = observe()
      args.onSample?.({ turn: turns, ...observed })
      const cur = fingerprintOf(observed)
      if (cur === prev) {
        if (pending) {
          stuck += 1
        } else {
          quiet += 1
        }
      } else {
        // The observable fingerprint MOVED: the machine is doing real work. WHEN
        // it last moved is the discriminator between "wedged" and "still
        // working" once the budget runs out (see {@link classifyExhaustion}).
        lastMoveTurn = turns
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
      // clear it. This is a TRUNCATED OBSERVATION, not a finding: the pump
      // stopped watching, and it cannot report what the machine did afterwards.
      // Never a throw/truncate. Timer-gated pending work falls through to the
      // policy decision below regardless of budget (the pump broke early on exit
      // (b)).
      //
      // WHY THE CLASSIFICATION IS ADVISORY. The quiet gap of a LEGITIMATE hop is
      // not bounded by the pump's break conditions. Exit (a) needs
      // `!pending`, exit (b) needs an armed timer — in the region
      // `pending && earliestExecuteAt() === null` NEITHER applies, so the inner
      // loop simply runs to `maxTurns` and the gap is unbounded. That region is
      // EXACTLY the one this site fires in: an `onEnter`/`onExit` hook is awaited
      // where `isProcessingEvents()` is already true and is deliberately not
      // counted in `inFlightAsyncCount` (driver.ts), so a hook doing a long but
      // FINITE amount of internal microtask work freezes all three fingerprint
      // components with no timer armed — indistinguishable from a wedge over any
      // truncated window. 16 is a MEASURED number on the chain fixtures, not a
      // structural bound, and no structural bound exists here.
      //
      // Consequently neither value may convict. Downstream both are surfaced as
      // warnings only; see `classifyExhaustion` above.
      return {
        quiescent: false,
        turns,
        reason: classifyExhaustion(),
        t: clock.now(),
      }
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
      return {
        quiescent: false,
        turns,
        // Same truncated observation as the site above, reached defensively;
        // same advisory classification, same prohibition on convicting from it.
        reason: classifyExhaustion(),
        t: clock.now(),
      }
    }

    if (policy === 'safety') {
      // A FUTURE timer is armed (the single clock-jump lives in 'liveness').
      // THREE-WAY taxonomy (U1 I-3 precision) by WHAT is still pending:
      //  - !pendingNow                    -> a plain empty-queue armed timer:
      //    WAITING_ON_TIMER (the fired region observably completed; only a
      //    sibling's future deadline remains — legitimate, I-3 excludes it).
      //  - pendingNow && inFlight > 0     -> a genuine AWAITED async action racing
      //    a future deadline only a jump can fire: WAITING_ON_TRANSITION_TIMEOUT
      //    (legitimate async-in-flight — the jurisdiction of liveness, not an RTC
      //    break; I-3 now excludes it SOUNDLY because inFlight>0 proves real
      //    in-flight work, not a wedged flag).
      //  - pendingNow && inFlight === 0   -> queued/processing work with NO tracked
      //    in-flight async, accompanied by a future timer: WAITING_ON_INTERNAL.
      //    ADVISORY — it is a pointer to a macrostep, never a verdict. This was
      //    briefly the I-3 witness (W8/V8 promoted I-3 into the DEFAULT builtin set
      //    on the strength of it); the promotion has been REVERTED because the break
      //    it rests on cannot distinguish a wedge from a correct machine — see the
      //    note at exit (b), `SettleReason`, and the `rtc-unobserved` warning in
      //    public.ts. `inFlightAsyncCount` does also count un-settled `invoke.action`
      //    callbacks from the `recordLifecycle` channel (ISS-030 / W8/V8), so a
      //    STRING-METHOD invoke action no longer lands here — but closing that one
      //    path never made the remaining reading sound.
      let reason: SettleReason
      if (!pendingNow) {
        reason = 'WAITING_ON_TIMER'
      } else if (args.env.inFlightAsyncCount() > 0) {
        reason = 'WAITING_ON_TRANSITION_TIMEOUT'
      } else {
        reason = 'WAITING_ON_INTERNAL'
      }
      return { quiescent: false, turns, reason, t: clock.now() }
    }

    // policy === 'liveness': jump forward to the earliest deadline and re-enter.
    clock.set(earliest)
    args.onClockJump?.(earliest)
    // loop re-enters: scheduler.process(now) now fires the jumped-to timer.
  }
}
