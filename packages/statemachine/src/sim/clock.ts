/**
 * @module sim/clock
 * @unstable
 *
 * Logical monotonic simulation clock (TASK-013 seam). The whole hashed plane
 * reads logical time from here — NEVER Date.now() / performance.now() (ADR-1).
 *
 * `SimClock.now` is shape-compatible with the engine's `Clock = () => number`
 * (scheduler.ts:7 / types.ts:128) so `const c: Clock = clk.now` typechecks and
 * drives `createVirtualScheduler`'s `executeAt = clock() + delay`
 * (scheduler.ts:85).
 *
 * Forward-only: a backward `set` THROWS. Monotonicity is the ADR-5 clock-skew
 * substrate (skew only ever advances time). There is NO settle/flush/drain here
 * — Step 3 owns the single `settleMacrostep` primitive (R2).
 */

import { SimError } from './prng'

/**
 * A logical, monotonic clock. `now()` and `t` always agree; `set(t)` is
 * forward-only.
 */
export interface SimClock {
  /** Current logical time. Identical to {@link SimClock.t}. */
  now(): number
  /**
   * Advance logical time to `t`. Forward-only (and stay-put allowed).
   * @throws {SimError} when `t` is less than the current time, or not a finite number.
   */
  set(t: number): void
  /** Current logical time (read-only view; agrees with {@link SimClock.now}). */
  readonly t: number
}

class MonotonicSimClock implements SimClock {
  private current: number

  constructor(start: number) {
    if (!Number.isFinite(start)) {
      throw new SimError(`makeSimClock(start) requires a finite number, got ${start}`)
    }
    this.current = start
  }

  get t(): number {
    return this.current
  }

  now = (): number => {
    return this.current
  }

  set(t: number): void {
    if (!Number.isFinite(t)) {
      throw new SimError(`SimClock.set(t) requires a finite number, got ${t}`)
    }
    if (t < this.current) {
      throw new SimError(`SimClock.set(${t}) would move time backward from ${this.current} (forward-only)`)
    }
    this.current = t
  }
}

/**
 * Construct a forward-only logical clock starting at `start` (default 0).
 */
export function makeSimClock(start = 0): SimClock {
  return new MonotonicSimClock(start)
}
