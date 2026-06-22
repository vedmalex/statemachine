/**
 * @module sim/observable-scheduler
 * @unstable
 *
 * ADR-5 C: the `ObservableScheduler` timer-visibility decorator over
 * `createVirtualScheduler` (scheduler.ts:259). It is the canonical replacement
 * for the Step-3 {@link makeObservableScheduler} shim — same `SchedulerView`
 * surface, plus:
 *  - site-keyed timer-JITTER: `eff = Math.max(0, delay + j)` where `j` is drawn
 *    from `fork('jitter:'+timerSiteId)` so the SAME timer site re-derives the
 *    SAME perturbation on `resumeTimers` re-arm (R9 / conform-5 LOW). `armEpoch`
 *    derives ONLY from the logical clock / `stateEntryTimes`, never wall-clock or
 *    a schedule-call counter.
 *  - forward-only clock-SKEW is NOT applied here — `makeSimClock` is forward-only
 *    and the single clock-jump lives in `settleMacrostep` (Step 3).
 *
 * Determinism: `j` is reproduced; `eff` may legitimately differ between a
 * first-arm (`delay`) and a `resumeTimers` re-arm (`remaining = max(0, delay -
 * elapsed)`, state_machine.ts:2486) because the BASE delay differs — the jitter
 * perturbation applied to that base is what is site-stable.
 *
 * No `Math.random` / `Date.now` / `performance.now` / `process.hrtime`; the only
 * randomness is the injected jitter {@link Prng} forks.
 */

import { createVirtualScheduler } from '../index'
import type { ITimerScheduler } from '../index'
import type { SimClock } from './clock'
import type { FaultPlan } from './faults'
import type { Prng } from './prng'
import type { SchedulerView } from './env'

/**
 * The timer-visibility seam. Mirrors `executeAt = clock() + eff` into a
 * `Map<token, executeAt>` and exposes the observation surface (the sole
 * timer-visibility seam; the engine scheduler's heap is otherwise opaque).
 * Cancel mirrors lazy-cancel (scheduler.ts:99-103): the entry is removed at
 * cancel time, never fires.
 */
export interface ObservableScheduler extends SchedulerView {
  /** Number of still-armed (uncancelled, unfired) tasks. */
  pendingCount(): number
}

/**
 * A jitter rule, keyed by STABLE timer-site identity. The perturbation `j` for a
 * site is `prng.fork('jitter:'+timerSiteId).int(2*jitterMs+1) - jitterMs`, drawn
 * ONCE per site and memoized, so every re-arm of the same site uses the same `j`.
 */
export interface JitterRule {
  /** Stable site id: `${stateName}#${invokeIndex}@${armEpoch}` (no wall-clock). */
  readonly timerSiteId: string
  /** Symmetric jitter half-window in ms (drawn `j ∈ [-jitterMs, +jitterMs]`). */
  readonly jitterMs: number
}

/** Build the stable timer-site id from the site coordinates (no wall-clock). */
export function timerSiteId(stateName: string, invokeIndex: number, armEpoch: number): string {
  return `${stateName}#${invokeIndex}@${armEpoch}`
}

/**
 * The bundle returned by {@link makeObservableSchedulerWithJitter}: the engine DI
 * `scheduler` seam plus the {@link ObservableScheduler} observation view over the
 * SAME armed tasks.
 */
export interface ObservableSchedulerBundle {
  readonly scheduler: ITimerScheduler
  readonly view: ObservableScheduler
}

/**
 * The function the caller installs to compute a site's jitter perturbation. It is
 * invoked once per `schedule()` call; an implementation that always returns 0 is
 * the no-jitter identity (Step 3 parity). The jitter is keyed by `timerSiteId`
 * inside the implementation (memoized via `prng.fork`), so the perturbation is
 * site-stable across re-arms.
 */
export type JitterFn = (delay: number) => number

/**
 * Build a jitter perturbation function from a {@link Prng} and a set of
 * {@link JitterRule}s. The perturbation for the next `schedule()` call is read
 * from `nextSite()` — the caller (harness) supplies the current site id before
 * the engine's `setTimer` calls `schedule`, so the decorator can key the fork by
 * site identity rather than schedule-call order (which would NOT be re-arm
 * stable). Each site's `j` is drawn once via `prng.fork('jitter:'+id)` and
 * memoized.
 */
export function makeSiteKeyedJitter(prng: Prng, rules: readonly JitterRule[]): {
  /** Set the site id the NEXT schedule() call belongs to (harness calls before setTimer). */
  enterSite(timerSiteId: string): void
  /** Clear the current site (after the schedule lands). */
  exitSite(): void
  /** The {@link JitterFn} to pass to {@link makeObservableSchedulerWithJitter}. */
  jitterFn: JitterFn
} {
  const ruleById = new Map<string, JitterRule>()
  for (const r of rules) {
    ruleById.set(r.timerSiteId, r)
  }
  /** Memoized per-site perturbation so a re-arm reuses the SAME `j`. */
  const memo = new Map<string, number>()
  let current: string | undefined

  const perturbationFor = (id: string, jitterMs: number): number => {
    const cached = memo.get(id)
    if (cached !== undefined) {
      return cached
    }
    // Site-keyed fork: same id ⇒ same fork stream ⇒ same draw on every re-arm.
    const draw = prng.fork(`jitter:${id}`).int(2 * jitterMs + 1) - jitterMs
    memo.set(id, draw)
    return draw
  }

  return {
    enterSite(id: string): void {
      current = id
    },
    exitSite(): void {
      current = undefined
    },
    jitterFn(_delay: number): number {
      if (current === undefined) {
        return 0
      }
      const rule = ruleById.get(current)
      if (rule === undefined) {
        return 0
      }
      return perturbationFor(current, rule.jitterMs)
    },
  }
}

/**
 * Build a {@link JitterFn} from a {@link FaultPlan} + a {@link Prng}. Each
 * `timer-jitter` fault contributes a perturbation drawn ONCE from
 * `fork('jitter:'+timerSiteId)` and memoized, so a `resumeTimers` re-arm of the
 * SAME timer site re-derives the SAME perturbation (R9). When the plan has no
 * timer-jitter fault the returned function is the no-jitter identity (`()=>0`).
 *
 * The perturbation is keyed by the schedule-call ORDINAL of arms that match a
 * timer-jitter site delay (a deterministic surrogate for the engine timer-site
 * identity, which the engine does not expose to the scheduler): for a given
 * `(seed, plan)` the engine arms timers in identical order, so the ordinal is a
 * stable replay key. Each timer-jitter fault's `jitterMs` half-window draws
 * `j ∈ [-jitterMs, +jitterMs]`; `eff = Math.max(0, delay + j)` is applied in
 * {@link makeObservableSchedulerWithJitter}.
 *
 * @returns a {@link JitterFn} plus a `recordedSites()` accessor listing the
 *   {@link timerSiteId}s a perturbation was actually drawn for (so the driver can
 *   emit a deterministic timer-jitter FaultRecord).
 */
export function buildPlanJitter(
  plan: FaultPlan,
  prng: Prng,
): { jitterFn: JitterFn; drawnSites(): readonly string[] } {
  const jitterFaults = plan.faults.filter((f) => f.kind === 'timer-jitter')
  if (jitterFaults.length === 0) {
    return { jitterFn: () => 0, drawnSites: () => [] }
  }
  // One memo per arm-ordinal so a re-arm at the same ordinal reuses the SAME j.
  const memo = new Map<number, number>()
  const drawn = new Set<string>()
  let ordinal = 0
  const jitterFn: JitterFn = (_delay: number): number => {
    // Round-robin the jitter faults across arms so each fault site perturbs at
    // least one arm; the ordinal makes the draw replay-stable.
    const fault = jitterFaults[ordinal % jitterFaults.length]
    const armOrdinal = ordinal
    ordinal += 1
    if (fault === undefined || fault.kind !== 'timer-jitter') {
      return 0
    }
    const cached = memo.get(armOrdinal)
    if (cached !== undefined) {
      return cached
    }
    const siteId = timerSiteId(
      fault.site.stateName ?? 'arm',
      fault.site.invokeIndex ?? 0,
      fault.site.armEpoch ?? armOrdinal,
    )
    drawn.add(siteId)
    const jm = fault.jitterMs
    const draw = prng.fork(`jitter:${siteId}`).int(2 * jm + 1) - jm
    memo.set(armOrdinal, draw)
    return draw
  }
  return { jitterFn, drawnSites: () => [...drawn] }
}

/**
 * Decorate `createVirtualScheduler` with timer-visibility + jitter. `eff =
 * Math.max(0, delay + jitterFn(delay))` is the effective delay armed on the inner
 * scheduler; `executeAt = clock() + eff` is mirrored into the view. `isActive()`
 * stays `true` (scheduler.ts:266 parity) so the engine routes timers through this
 * scheduler. Cancel mirrors lazy-cancel: the view entry is removed at cancel.
 *
 * @param clock the logical clock driving `executeAt = clock() + eff`
 * @param jitterFn perturbation per schedule call; pass `() => 0` for no jitter
 */
export function makeObservableSchedulerWithJitter(
  clock: SimClock,
  jitterFn: JitterFn = () => 0,
): ObservableSchedulerBundle {
  const inner = createVirtualScheduler(clock.now)
  /** token -> executeAt for every still-armed (uncancelled, unfired) task. */
  const pending = new Map<object, number>()

  const scheduler: ITimerScheduler = {
    isActive(): boolean {
      return true
    },
    schedule(delay: number, callback: () => void): object {
      const eff = Math.max(0, delay + jitterFn(delay))
      const executeAt = clock.now() + eff
      const token = inner.schedule(eff, () => {
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

  const view: ObservableScheduler = {
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
    pendingCount(): number {
      return pending.size
    },
  }

  return { scheduler, view }
}
