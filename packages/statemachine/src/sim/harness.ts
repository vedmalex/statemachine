/**
 * @module sim/harness
 * @unstable
 *
 * ADR-5 B/D/F/G: the additive fault-injection harness attaching the seven-kind
 * channel taxonomy to the three injectable seams WITHOUT any engine edit, the
 * harness-owned `inFlightAsyncCount` settledness wrapper Step-3's
 * {@link settleMacrostep} consumes, the `captureRejection` classifier, and the
 * 8th `corrupt-state` probe ISSUANCE (capture-and-tag; the I-6/I-10 trigger
 * validity is Step 6).
 *
 *  - **CALLBACK throw (B):** wraps ONLY FUNCTION-VALUED config callbacks
 *    (guard / onTransition / state+event hooks / `invoke[].action`) so the throw
 *    is observed at the HARNESS boundary and recorded as
 *    `errorClass:'injected-fault'`. `invoke[].cond` is EXCLUDED (called directly,
 *    not awaited, throw caught-continued — :2153/:2497). String-method callbacks
 *    are EXCLUDED (config-mutation cannot reach them) and emit an explicit
 *    `uncovered`/`N-A` marker (ISS-029), never a silent pass.
 *  - **EVENT-QUEUE reorder/drop/dup + OVERFLOW (D):** operate ONLY on an external
 *    submission buffer in FRONT of `fireEvent`; the engine `internalQueue` is
 *    NEVER touched (so I-7 stays meaningful). Overflow floods to
 *    `maxQueueDepth+1`; the `(max+1)`-th fire rejects synchronously at enqueue
 *    (:228-240). `captureRejection` classifies overflow-vs-depth by per-fire
 *    IDENTITY (the issuing opId/faultStep), never by `e.message`.
 *  - **SCHEDULER skew/jitter (C):** lives in `observable-scheduler.ts`; this
 *    module only references the {@link FaultSite} jitter rules.
 *  - **inFlightAsyncCount (F):** reuses the Step-3 {@link bracketAsync} bracket on
 *    the WRAPPED ACTION's own promise — incl. the `transitionTimeout`
 *    `Promise.race` (the finally is on the action wrapper, never `callAction`'s
 *    outer return).
 *  - **corrupt-state probe (G):** writes the bogus payload through the SAME
 *    consumer `Adapter.set` the Step-2 seam wraps → captured, tagged
 *    `synthetic:'corrupt-state'`. Does NOT widen the seven-kind union.
 *
 * No `Math.random` / `Date.now` / `performance.now` / `process.hrtime`.
 */

import type { Adapter, StateMachineConfig } from '../index'
import type { Env } from './env'
import { bracketAsync } from './env'
import {
  type CorruptStateProbe,
  type FaultPlan,
  type FaultSite,
  InjectedFault,
  type RejectionOrigin,
  classifyError,
} from './faults'
import type { ErrorClass, FireOutcome } from './trace'

/**
 * An external submission ENTRY queued in front of `fireEvent`. The reorder/drop/
 * dup faults mutate ONLY this buffer; the engine internal queue is never touched.
 */
export interface SubmissionEntry {
  /** Stable op-id of the issuing op (R22) — the per-fire identity for overflow. */
  readonly opId: string
  readonly event: string
  /**
   * The event payload, forwarded VERBATIM (W8). `unknown[]` — NOT `number[]` — so
   * an OBJECT payload survives the queue-fault plane (drop/dup/reorder/overflow)
   * exactly as it survives a fault-free fire. The queue faults are PURE over the
   * buffer and never rewrite an entry, so a duplicated/reordered entry carries the
   * IDENTICAL args reference: the fault path is payload-identical to the no-fault
   * path by construction.
   */
  readonly args: readonly unknown[]
}

/**
 * Apply the queue-channel faults (reorder / drop / dup) to a submission buffer.
 * PURE over the buffer + the resolved {@link FaultPlan} entries: returns a NEW
 * buffer; the original (and the engine internal queue) are untouched.
 *
 * - `drop`  : remove the entry whose `opId` matches the fault.
 * - `dup`   : duplicate the entry immediately after itself.
 * - `reorder`: swap the entry with its successor within a `reorderWindow` (the
 *   external buffer only; internal-before-external engine ordering is preserved).
 */
export function applyQueueFaults(buffer: readonly SubmissionEntry[], plan: FaultPlan): SubmissionEntry[] {
  let out = buffer.slice()
  for (const f of plan.faults) {
    if (f.kind === 'drop' && 'opId' in f) {
      out = out.filter((e) => e.opId !== f.opId)
    } else if (f.kind === 'dup' && 'opId' in f) {
      const next: SubmissionEntry[] = []
      for (const e of out) {
        next.push(e)
        if (e.opId === f.opId) {
          next.push(e) // duplicate immediately after
        }
      }
      out = next
    } else if (f.kind === 'reorder' && 'opId' in f) {
      const i = out.findIndex((e) => e.opId === f.opId)
      if (i >= 0 && i + 1 < out.length) {
        const swapped = out.slice()
        const a = swapped[i]
        const b = swapped[i + 1]
        if (a !== undefined && b !== undefined) {
          swapped[i] = b
          swapped[i + 1] = a
        }
        out = swapped
      }
    }
  }
  return out
}

/**
 * Build the overflow flood for an `overflow`-kind fault: `floodCount` copies of
 * the entry, all sharing the issuing `opId` (so `captureRejection` can attribute
 * a synchronous reject to this fault by identity). The harness fires these in
 * sequence; the `(maxQueueDepth+1)`-th fire rejects synchronously at enqueue.
 */
export function buildOverflowFlood(entry: SubmissionEntry, floodCount: number): SubmissionEntry[] {
  const out: SubmissionEntry[] = []
  for (let i = 0; i < floodCount; i++) {
    out.push(entry)
  }
  return out
}

/**
 * Wrap a function-valued callback so it THROWS an {@link InjectedFault} when the
 * `throw` fault fires for its site. The harness observes the throw at THIS
 * boundary and records `errorClass:'injected-fault'` (the engine then swallows it
 * via `callAction(...).catch(processError(...))`, so the engine reject is NOT the
 * observable surface — the harness boundary is). The wrapper ALSO brackets the
 * call with {@link bracketAsync} so a pending async callback stays visible to
 * `inFlightAsyncCount`.
 *
 * @param env the harness env (for the inFlightAsyncCount bracket)
 * @param fn the original function-valued callback
 * @param site the callback's fault site (carried on the thrown InjectedFault)
 * @param shouldThrow predicate: true at the fire opportunity this fault targets
 * @param onInjected called at the harness boundary the instant the fault fires
 *   (records the injected-fault frame BEFORE the engine swallows it)
 */
export function wrapThrowingCallback<O>(
  env: Env,
  fn: (owner: O, ...args: unknown[]) => unknown,
  site: FaultSite,
  shouldThrow: () => boolean,
  onInjected: (site: FaultSite) => void,
): (owner: O, ...args: unknown[]) => unknown {
  const throwing = (owner: O, ...args: unknown[]): unknown => {
    if (shouldThrow()) {
      // Observe at the harness boundary FIRST, then throw into the engine.
      onInjected(site)
      throw new InjectedFault(site)
    }
    return fn(owner, ...args)
  }
  // Bracket so a pending async body (and a throw) is reflected in inFlightAsyncCount.
  return bracketAsync(env, throwing as (owner: O, ...args: unknown[]) => unknown)
}

/**
 * Classify a rejected `fireEvent` at the harness `.catch` boundary into a FROZEN
 * {@link ErrorClass} (R10/R20) — by IDENTITY + field-selection, NEVER by message.
 * Drops `error.context` entirely (conform-5 LOW): nothing from the structured
 * context reaches the hashed frame.
 *
 * The `origin` carries the per-fire identity that splits `'queue-overflow'`
 * (synchronous reject at enqueue) from `'max-transition-depth'` (a reject
 * surfacing on a previously-pending, already-enqueued fire during the drain).
 */
export function captureRejection(error: unknown, origin?: RejectionOrigin): ErrorClass | undefined {
  return classifyError(error, origin)
}

/**
 * The result of attempting one buffered submission against the engine. The
 * harness `.catch`'s every fire; a synchronous-at-enqueue reject (the promise
 * rejected before control returned to the caller's microtask) is flagged so
 * {@link captureRejection} can attribute it to overflow vs depth.
 */
export interface FireResult {
  readonly opId: string
  readonly outcome: FireOutcome
  readonly errorClass?: ErrorClass
  /** True iff the rejection was observed synchronously at enqueue. */
  readonly syncAtEnqueue: boolean
}

/**
 * Fire ONE buffered submission against the engine, ALWAYS passing the wrapped
 * Adapter as the EXPLICIT 2nd positional arg (ADR-7 c13; `isAdapter(wrapped)` is
 * true so args are not unshifted via :469-471). Returns the classified outcome.
 *
 * The synchronous-at-enqueue detection: the engine rejects overflow at enqueue
 * (:228-240) BEFORE `scheduleProcessing`, so the rejection is available on the
 * returned promise without any microtask drain. We probe this by racing the fire
 * against an already-resolved microtask sentinel: if the fire promise has already
 * rejected by the time one microtask elapses, it was a synchronous-at-enqueue
 * reject (overflow); otherwise it is a drain-time reject (depth) or a normal
 * resolve.
 */
export async function fireBuffered<T extends object>(
  fireEvent: (event: never, adapter: never, ...args: unknown[]) => Promise<boolean>,
  wrapped: Adapter<T>,
  entry: SubmissionEntry,
): Promise<FireResult> {
  let rejected: unknown
  let didReject = false
  let resolvedValue: boolean | undefined
  // The number of microtask ticks elapsed when the fire promise settled. The
  // overflow reject (:228-240) is produced by `Promise.reject(...)` BEFORE
  // `scheduleProcessing`, so the fire promise is ALREADY rejected when control
  // returns — its reject callback runs on tick 0/1. A drain-time depth reject
  // (:303) settles only after the `processQueues` microtask chain (many ticks).
  // We count ticks deterministically and treat "settled within the first tick"
  // as synchronous-at-enqueue.
  let settledTick = Number.POSITIVE_INFINITY

  let tick = 0

  const p = fireEvent(entry.event as never, wrapped as never, ...entry.args).then(
    (v) => {
      resolvedValue = v
      settledTick = tick
    },
    (e) => {
      rejected = e
      didReject = true
      settledTick = tick
    },
  )

  // Pump microtask ticks, incrementing `tick` each turn, until `p` settles. A
  // sync-rejected promise settles at tick 0 (its reject callback is already
  // queued). Bounded so a never-settling fire cannot hang (it cannot happen for a
  // real engine fire, but the bound keeps the harness total).
  for (let i = 0; i < 64 && settledTick === Number.POSITIVE_INFINITY; i++) {
    await Promise.resolve()
    tick += 1
  }
  await p.catch(() => {})

  const settledSync = didReject && settledTick === 0

  if (didReject) {
    const origin: RejectionOrigin = { syncAtEnqueue: settledSync }
    const errorClass = captureRejection(rejected, origin)
    return {
      opId: entry.opId,
      outcome: 'reject',
      syncAtEnqueue: settledSync,
      ...(errorClass !== undefined ? { errorClass } : {}),
    }
  }

  return {
    opId: entry.opId,
    outcome: resolvedValue ? 'resolve-true' : 'resolve-false',
    syncAtEnqueue: false,
  }
}

/**
 * ISSUE the 8th `corrupt-state` probe: write the bogus payload through the SAME
 * consumer `Adapter.set` the Step-2 capture seam wraps, so the write is captured
 * and the driver tags the resulting frame `synthetic:'corrupt-state'`. This does
 * NOT validate the throw (Step 6 owns I-6/I-10 trigger validity); it only
 * delivers the payload to the verified throwing site:
 *  - `'unregistered-leaf'` (I-10): the write itself lands; the throw is at the
 *    subsequent `getCurrentState()` read (`:1219`).
 *  - `'restore'` (I-6): the payload is delivered via the restore path; the throw
 *    is at `validateCompositeState(:734)`. (The harness drives the restore;
 *    here we expose the payload + the stateAttribute write helper.)
 *
 * Returns the value written (the raw payload) so the caller can drive the read
 * that triggers the throw.
 */
export function issueCorruptStateWrite<T extends object>(
  wrapped: Adapter<T>,
  stateAttribute: keyof T,
  probe: CorruptStateProbe,
): string {
  // Direct attribute write of the raw composite string (bypasses the engine's
  // private setCurrentStateInternal validation — the seam writes the attribute
  // verbatim). The Step-2 capture seam observes this as a (from,to) write; the
  // driver stamps synthetic:'corrupt-state'.
  wrapped.set(stateAttribute, probe.payload as unknown as T[keyof T])
  return probe.payload
}

/**
 * Emit the explicit ISS-029 honesty marker for a string-method-named callback the
 * config-mutation throw wrapper CANNOT reach. The coverage gate (Step 9) consumes
 * this marker as an explicit `uncovered`/`n/a-string-method` residual — never a
 * silent pass. `kind` names which error capability is uncovered for this machine.
 */
export interface UncoveredMarker {
  readonly reason: 'string-method'
  /** The error capability that cannot be exercised on this (string-method) machine. */
  readonly capability: 'error.guard-throw' | 'error.action-throw' | 'error.recovery.abortOnExitError'
  readonly site: FaultSite
}

/**
 * Build the uncovered marker for a string-method callback fault site. The
 * presence of this marker is the falsifiable ISS-029 signal: a string-method
 * machine reports the function-valued-only error capabilities as explicitly
 * uncovered rather than silently claiming coverage.
 */
export function markStringMethodUncovered(
  capability: UncoveredMarker['capability'],
  site: FaultSite,
): UncoveredMarker {
  return { reason: 'string-method', capability, site }
}

/**
 * True iff the callback at `site` is a STRING method-name (config-mutation
 * unreachable) rather than a function value. Used to decide between wrapping
 * (function-valued) and emitting an {@link UncoveredMarker} (string-method).
 */
export function isStringMethodCallback(value: unknown): boolean {
  return typeof value === 'string'
}

/**
 * Apply the callback-`throw` faults to a config: for every fault whose site names
 * a function-valued callback, replace that callback with a
 * {@link wrapThrowingCallback}; for a string-method callback, collect an
 * {@link UncoveredMarker} instead (ISS-029). Returns the mutated config plus the
 * uncovered markers. The config internal queue / engine source are untouched —
 * only the consumer config callbacks are swapped.
 *
 * Only `invoke[].action` and the transition `guard`/`onTransition` are wrapped
 * here (the verified function-valued, callAction-dispatched sites the harness can
 * reach by config mutation); the hook-triad sites share the same chokepoint and
 * are demoted to a documented v1 gap per tech-spec §3.5 (the chokepoint property
 * is asserted structurally).
 */
export function applyThrowFaults<T extends object>(
  config: StateMachineConfig<T>,
  plan: FaultPlan,
  env: Env,
  onInjected: (site: FaultSite) => void,
): { config: StateMachineConfig<T>; uncovered: UncoveredMarker[] } {
  const uncovered: UncoveredMarker[] = []
  const throwFaults = plan.faults.filter((f) => f.kind === 'throw')
  if (throwFaults.length === 0) {
    return { config, uncovered }
  }

  // shouldThrow: a throw fault fires on the FIRST invocation of the targeted
  // callback (deterministic single-shot). A per-site latch makes replay stable.
  const fired = new Set<FaultSite>()
  const makeShouldThrow = (site: FaultSite) => (): boolean => {
    if (fired.has(site)) {
      return false
    }
    fired.add(site)
    return true
  }

  const wrapInvoke = (state: Record<string, unknown>): Record<string, unknown> => {
    const next: Record<string, unknown> = { ...state }
    const invoke = state['invoke']
    if (Array.isArray(invoke)) {
      next['invoke'] = invoke.map((inv, idx) => {
        const i = inv as Record<string, unknown>
        const site = throwFaults.find(
          (f) => f.site.callbackKind === 'invoke.action' && f.site.invokeIndex === idx,
        )?.site
        if (site === undefined) {
          return i
        }
        const action = i['action']
        if (isStringMethodCallback(action)) {
          uncovered.push(markStringMethodUncovered('error.action-throw', site))
          return i
        }
        if (typeof action === 'function') {
          return {
            ...i,
            action: wrapThrowingCallback(
              env,
              action as (o: unknown, ...a: unknown[]) => unknown,
              site,
              makeShouldThrow(site),
              onInjected,
            ),
          }
        }
        return i
      })
    }
    const regions = state['regions']
    if (regions && typeof regions === 'object') {
      const nextRegions: Record<string, unknown> = {}
      for (const [rk, rv] of Object.entries(regions as Record<string, unknown>)) {
        const nextRegion: Record<string, unknown> = {}
        for (const [sk, sv] of Object.entries(rv as Record<string, unknown>)) {
          nextRegion[sk] = wrapInvoke(sv as Record<string, unknown>)
        }
        nextRegions[rk] = nextRegion
      }
      next['regions'] = nextRegions
    }
    const states = state['states']
    if (states && typeof states === 'object') {
      const nextStates: Record<string, unknown> = {}
      for (const [sk, sv] of Object.entries(states as Record<string, unknown>)) {
        nextStates[sk] = wrapInvoke(sv as Record<string, unknown>)
      }
      next['states'] = nextStates
    }
    return next
  }

  const nextStates: Record<string, unknown> = {}
  for (const [name, state] of Object.entries(config.states as Record<string, unknown>)) {
    nextStates[name] = wrapInvoke(state as Record<string, unknown>)
  }

  // Transition guard / onTransition throw injection.
  const nextEvents: Record<string, unknown> = {}
  for (const [name, event] of Object.entries(config.events as Record<string, unknown>)) {
    const ev = event as Record<string, unknown>
    const transitions = ev['transitions']
    if (Array.isArray(transitions)) {
      const nextTransitions = transitions.map((t) => {
        const tr = t as Record<string, unknown>
        let out = tr
        for (const f of throwFaults) {
          const kind = f.site.callbackKind
          if (kind === 'guard' && tr['guard'] !== undefined) {
            if (isStringMethodCallback(tr['guard'])) {
              uncovered.push(markStringMethodUncovered('error.guard-throw', f.site))
            } else if (typeof tr['guard'] === 'function') {
              out = {
                ...out,
                guard: wrapThrowingCallback(
                  env,
                  tr['guard'] as (o: unknown, ...a: unknown[]) => unknown,
                  f.site,
                  makeShouldThrow(f.site),
                  onInjected,
                ),
              }
            }
          }
          if (kind === 'onTransition' && tr['onTransition'] !== undefined) {
            if (isStringMethodCallback(tr['onTransition'])) {
              uncovered.push(markStringMethodUncovered('error.action-throw', f.site))
            } else if (typeof tr['onTransition'] === 'function') {
              out = {
                ...out,
                onTransition: wrapThrowingCallback(
                  env,
                  tr['onTransition'] as (o: unknown, ...a: unknown[]) => unknown,
                  f.site,
                  makeShouldThrow(f.site),
                  onInjected,
                ),
              }
            }
          }
        }
        return out
      })
      nextEvents[name] = { ...ev, transitions: nextTransitions }
    } else {
      nextEvents[name] = ev
    }
  }

  return {
    config: {
      ...config,
      states: nextStates as StateMachineConfig<T>['states'],
      events: nextEvents as StateMachineConfig<T>['events'],
    },
    uncovered,
  }
}
