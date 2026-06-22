/**
 * @module sim/env
 * @unstable
 *
 * Step-3 harness execution environment: the `inFlightAsyncCount` settledness
 * signal (CRIT-1 / ISS-030), the `SchedulerView` observation interface, the
 * `bracketAsync` action wrapper, and a thin `SchedulerView` shim over the
 * engine's `createVirtualScheduler`.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ISS-030 SCOPE (explicit, per ADR-5 RR-4 + tech-spec §4):
 *
 * `inFlightAsyncCount()` is maintained by {@link bracketAsync}, which wraps
 * FUNCTION-VALUED invoke/callback actions at the config layer. This covers ONLY
 * the path-2 `callAction` arm (`state_machine.ts:1758-1761`, inline-fn await).
 *
 * String-method invoke actions — resolved INSIDE `callAction` via `context`
 * (`state_machine.ts:1745`) or `adaptee.get` (`state_machine.ts:1764`) — are
 * resolved AFTER the wrap boundary and are NOT wrappable at the config layer.
 * They are a documented v1 GAP (consistent with ADR-5 RR-4) carried to Step 5's
 * wire-time wrapper and Step 4's "function-valued only" generator constraint.
 *
 * The two VERIFIED awaited consumer-callback sites the count must cover:
 *   - invoke action  : `await this.callAction(obj, invocation.action)`        :2170
 *                      (runs BEFORE raiseEvent + scheduleProcessing :2172-2173)
 *   - resume action  : `await this.callAction(this.adaptee, invocation.action)` :2504
 *                      then `await this.fireEvent(...)`                          :2506
 *
 * The whole module has NO Math.random / Date.now / performance.now / real timer
 * (ADR-1 / §5.1). Logical time comes only from the injected {@link SimClock}.
 * ──────────────────────────────────────────────────────────────────────────
 */

import type { ITimerScheduler } from '../index'
import { createVirtualScheduler } from '../index'
import type { SimClock } from './clock'

/**
 * Read-only scheduler observation interface. Lets {@link settleMacrostep} decide
 * the timer conjunct of the quiescence predicate and lets `policy:'liveness'`
 * find the next deadline to jump to — WITHOUT reading the engine's private
 * scheduler/queues (zero core-ABI; ADR-7 c8 / ADR-4 c5).
 *
 * In Step 3 this is backed by a shim over `createVirtualScheduler` (see
 * {@link makeObservableScheduler}); Step 5/6 replaces the shim with the
 * canonical `ObservableScheduler` behind the SAME interface.
 */
export interface SchedulerView {
  /** True iff no UNCANCELLED task is due at or before `t` AND none is pending. */
  schedulerEmptyAt(t: number): boolean
  /** Logical time of the earliest UNCANCELLED pending task, or null if none. */
  earliestExecuteAt(): number | null
}

/**
 * Harness execution environment. Carries the {@link SchedulerView} plus the
 * `inFlightAsyncCount` settledness counter.
 *
 * `inFlightAsyncCount() === 0` is a NECESSARY conjunct of the macrostep fixed
 * point (ADR-4): a pending awaited consumer action means more engine work can
 * still be enqueued (`raiseEvent` runs AFTER `await callAction` at :2172), so a
 * purely structural (queue/processing) predicate would report premature
 * quiescence. {@link enterAsync}/{@link exitAsync} are called ONLY by the
 * {@link bracketAsync} wrapper; nothing else mutates the count.
 */
export interface Env extends SchedulerView {
  /** Live count of awaited consumer actions currently in flight. */
  inFlightAsyncCount(): number
  /** Increment — only caller is the {@link bracketAsync} bracket. */
  enterAsync(): void
  /** Decrement — only caller is the {@link bracketAsync} bracket (in `finally`). */
  exitAsync(): void
}

/**
 * A function-valued action the engine dispatches through `callAction`
 * (`state_machine.ts:1726`). The harness wraps these at the config layer so the
 * action's own pending promise is tracked by `inFlightAsyncCount`.
 */
export type WrappableAction<O> = (owner: O, ...args: unknown[]) => unknown | Promise<unknown>

/**
 * FROZEN bracket rule (tech-spec §4.2): increment BEFORE the wrapped body runs;
 * decrement in a `finally` on the **wrapped action's own promise** — NEVER on
 * `callAction`'s outer return.
 *
 * With `transitionTimeout` set, `callAction` returns
 * `Promise.race([executeAction(), timeoutPromise])` (`state_machine.ts:1798/1802`):
 * the timeout leg can reject while `executeAction()`'s wrapped action is still
 * pending. Bracketing the OUTER return would decrement on a timeout-win →
 * premature quiescence while the real action body still runs. Bracketing the
 * action's own promise keeps the count honest until the body actually settles.
 *
 * - synchronous throw → `exit()` immediately, then rethrow (settles now).
 * - promise result    → `exit()` in `.finally` on THAT promise.
 * - sync non-promise  → `exit()` immediately.
 */
export function bracketAsync<O>(env: Env, fn: WrappableAction<O>): WrappableAction<O> {
  return (owner: O, ...args: unknown[]): unknown | Promise<unknown> => {
    env.enterAsync()
    let r: unknown
    try {
      r = fn(owner, ...args)
    } catch (e) {
      env.exitAsync()
      throw e
    }
    if (r instanceof Promise) {
      return r.finally(() => {
        env.exitAsync()
      })
    }
    env.exitAsync()
    return r
  }
}

/**
 * Mutable async-count slice. Split out so {@link makeEnv} can compose it with a
 * {@link SchedulerView} into a single {@link Env}.
 */
export interface AsyncCounter {
  inFlightAsyncCount(): number
  enterAsync(): void
  exitAsync(): void
}

/** Construct a fresh async counter starting at zero. */
export function makeAsyncCounter(): AsyncCounter {
  let count = 0
  return {
    inFlightAsyncCount(): number {
      return count
    },
    enterAsync(): void {
      count += 1
    },
    exitAsync(): void {
      count -= 1
    },
  }
}

/**
 * The Step-3 {@link SchedulerView} shim over `createVirtualScheduler`
 * (`scheduler.ts:259`). It records every `executeAt = clock() + delay`
 * (`scheduler.ts:85`) and honors lazy-cancel (`scheduler.ts:99-103`: `cancel`
 * only removes the token; the heap entry is skipped at process time), so a
 * lazily-cancelled task is invisible to {@link SchedulerView.schedulerEmptyAt}
 * and {@link SchedulerView.earliestExecuteAt}.
 *
 * The returned `scheduler` is the real engine scheduler the harness forwards as
 * the DI `scheduler` seam; `view` observes the SAME armed tasks.
 */
export interface ObservableSchedulerShim {
  readonly scheduler: ITimerScheduler
  readonly view: SchedulerView
}

/**
 * Build a virtual scheduler plus a {@link SchedulerView} over it. A pending task
 * is identified by the token the scheduler returns from `schedule`; cancelling
 * via `scheduler.cancel(token)` drops it from the view (lazy-cancel parity).
 *
 * @param clock the logical clock driving `executeAt = clock() + delay`
 */
export function makeObservableScheduler(clock: SimClock): ObservableSchedulerShim {
  const inner = createVirtualScheduler(clock.now)
  /** token -> executeAt for every still-armed (uncancelled, unfired) task. */
  const pending = new Map<object, number>()

  const scheduler: ITimerScheduler = {
    isActive(): boolean {
      return true
    },
    schedule(delay: number, callback: () => void): object {
      const executeAt = clock.now() + delay
      // Wrap the callback so the view forgets the task the instant it fires.
      const token = inner.schedule(delay, () => {
        pending.delete(token)
        callback()
      })
      pending.set(token, executeAt)
      return token
    },
    cancel(token: object): void {
      pending.delete(token)
      inner.cancel(token)
    },
    process(now?: number): void {
      // createVirtualScheduler always implements process (scheduler.ts:274); the
      // optional-method guard satisfies the ITimerScheduler.process? type.
      inner.process?.(now)
    },
  }

  const view: SchedulerView = {
    schedulerEmptyAt(t: number): boolean {
      for (const executeAt of pending.values()) {
        if (executeAt <= t) {
          return false
        }
      }
      return true
    },
    earliestExecuteAt(): number | null {
      let earliest: number | null = null
      for (const executeAt of pending.values()) {
        if (earliest === null || executeAt < earliest) {
          earliest = executeAt
        }
      }
      return earliest
    },
  }

  return { scheduler, view }
}

/** Compose an {@link AsyncCounter} and a {@link SchedulerView} into one {@link Env}. */
export function makeEnv(counter: AsyncCounter, view: SchedulerView): Env {
  return {
    inFlightAsyncCount: counter.inFlightAsyncCount,
    enterAsync: counter.enterAsync,
    exitAsync: counter.exitAsync,
    schedulerEmptyAt: view.schedulerEmptyAt,
    earliestExecuteAt: view.earliestExecuteAt,
  }
}
