/**
 * @module sim/faults
 * @unstable
 *
 * ADR-5 fault taxonomy + the structural errorClass classifier + the 8th
 * harness-only `corrupt-state` probe types. This module owns the FROZEN seven-kind
 * channel union and the {@link InjectedFault} plain-Error class; {@link harness.ts}
 * applies the faults to the three injectable seams and {@link observable-scheduler.ts}
 * provides the timer-visibility decorator.
 *
 * KEY INVARIANTS (grep/tsc-enforced by faults.test.ts):
 *  - {@link FaultKind} is EXACTLY seven literals; `'corrupt-state'` is NOT a member
 *    (it is the 8th harness-only PROBE, carried only by {@link FaultRecord.kind} and
 *    {@link CorruptStateProbe}). It NEVER widens the channel union.
 *  - {@link InjectedFault} is a PLAIN `Error`, never `StateMachineError` /
 *    `EnhancedStateMachineError` (those bake `Date.now()` into `errorCode`/
 *    `timestamp`, error_handling.ts:79/88) — so it carries no wall-clock.
 *  - {@link classifyError} reads ONLY the FROZEN enum by FIELD-SELECTION on the
 *    structured `StateMachineError.context` + the error's identity (`instanceof` /
 *    `cause`), NEVER `error.message` (the frame strips message; R10/R20). It DROPS
 *    `error.context` entirely — no context field reaches the hashed frame.
 *  - A monotonic `faultStep` drives ONE PRNG draw per opportunity → identical
 *    {@link FaultRecord}[] on replay (AC-2).
 *
 * No `Math.random` / `Date.now` / `performance.now` / `process.hrtime` anywhere
 * (ADR-1 / §5.1); the only randomness is the injected {@link Prng}.
 */

import type { FaultKind } from './trace'
import type { ErrorClass } from './trace'

// Re-export the FROZEN seven-kind union (owned conceptually by Step 1's trace.ts
// so the TraceFrame.faultApplied field is self-contained). The two declarations
// are the SAME literal set; this re-export is the Step-5 canonical name.
export type { FaultKind } from './trace'

/**
 * Where a fault is injected. Harness-owned (NEVER `context.phase`, which
 * `callAction` hardcodes to `'action'` at state_machine.ts:1738). The three seams
 * map 1:1 to the three injectable points (event queue / scheduler / callback).
 */
export interface FaultSite {
  readonly seam: 'event-queue' | 'scheduler' | 'callback'
  readonly stateName?: string
  readonly invokeIndex?: number
  /** Derives ONLY from logical clock / stateEntryTimes (never wall-clock). */
  readonly armEpoch?: number
  /** Function-valued callbacks dispatched through `callAction` (state_machine.ts:1726). */
  readonly callbackKind?:
    | 'guard'
    | 'onTransition'
    | 'state.onBeforeEnter'
    | 'state.onEnter'
    | 'state.onAfterEnter'
    | 'state.onBeforeExit'
    | 'state.onExit'
    | 'state.onAfterExit'
    | 'event.onBefore'
    | 'event.onAfter'
    | 'event.onSuccess'
    | 'invoke.action'
  readonly opId?: string
}

/**
 * The fault plan attached to a scenario. `transitionTimeoutMs` is the wire-time
 * `options.transitionTimeout` (types.ts:133), NOT a per-state setting.
 */
export interface FaultPlan {
  readonly faults: readonly FaultSpec[]
  readonly transitionTimeoutMs?: number
  readonly reorderWindow?: number
}

/**
 * One scheduled fault. A closed discriminated union over the seven channel kinds.
 * Each variant carries the FROZEN per-kind payload (tech-spec §3.5).
 */
export type FaultSpec =
  | { readonly kind: 'reorder' | 'drop' | 'dup'; readonly site: FaultSite; readonly opId: string }
  | { readonly kind: 'overflow'; readonly site: FaultSite; readonly opId: string; readonly floodCount: number }
  | { readonly kind: 'clock-skew'; readonly site: FaultSite; readonly deltaMs: number }
  | { readonly kind: 'timer-jitter'; readonly site: FaultSite; readonly jitterMs: number }
  | { readonly kind: 'throw'; readonly site: FaultSite }

/**
 * A record of one applied fault. Regenerates IDENTICALLY on replay (AC-2): the
 * monotonic `faultStep` indexes the per-opportunity PRNG draw, so the same
 * `(seed, scenario, faultPlan)` yields a byte-identical `FaultRecord[]`.
 *
 * `kind` INCLUDES the `'corrupt-state'` probe literal (the kind union is wider
 * than the channel {@link FaultKind} union by exactly the one probe literal); the
 * CHANNEL union {@link FaultKind} does NOT.
 */
export interface FaultRecord {
  readonly faultStep: number
  readonly kind: FaultKind | 'corrupt-state'
  readonly site: FaultSite
  readonly opId?: string
}

/**
 * PLAIN `Error` raised by an injected `throw`-kind callback fault. NEVER a
 * `StateMachineError` / `EnhancedStateMachineError` (which bake `Date.now()` into
 * `errorCode`/`timestamp`). A unique marker symbol lets {@link classifyError}
 * detect it through the engine's catch-and-rewrap (callAction wraps the original
 * as `StateMachineError(..., context, cause: original)` at ~:1774) by IDENTITY,
 * never by message.
 */
export class InjectedFault extends Error {
  /** Brand so a re-wrapped fault is detectable via `cause` identity (not message). */
  readonly injectedFault = true as const

  constructor(site?: FaultSite) {
    super('injected fault')
    this.name = 'InjectedFault'
    if (site !== undefined) {
      this.site = site
    }
  }

  readonly site?: FaultSite
}

/** True iff `e` is (or wraps, via `cause`) an {@link InjectedFault}. Identity-only. */
function isInjectedFault(e: unknown): boolean {
  if (e instanceof InjectedFault) {
    return true
  }
  const cause = (e as { cause?: unknown } | undefined)?.cause
  return cause instanceof InjectedFault
}

/**
 * The structured context of a `StateMachineError`, read by field-selection only.
 * We deliberately type ONLY the fields we select on — `error.context` is NEVER
 * folded into the hashed frame (R20 / §3.5 conform-5 LOW: the non-normalized
 * `state`/`event`/`action`/`phase` carried at :232-238/:1790-1794 are dropped).
 */
interface SelectableContext {
  readonly event?: string
  readonly action?: string
  readonly phase?: string
  readonly state?: string
  readonly transition?: string
}

function contextOf(e: unknown): SelectableContext | undefined {
  return (e as { context?: SelectableContext } | undefined)?.context
}

/**
 * The two engine message strings kept ONLY as drift fixtures — NEVER a
 * classification input. If the engine ever changes a message, the fixture test
 * fails loudly so the structural classifier can be re-verified; the classifier
 * itself never reads `.message`.
 */
export const ENGINE_MESSAGE_FIXTURES = {
  queueOverflow: 'Event queue overflow — possible infinite loop', // state_machine.ts:234
  maxTransitionDepth: 'Max transition depth exceeded — possible infinite loop', // :303
  transitionTimeout: 'Transition timeout', // :1790
  invalidEventPrefix: 'Invalid event:', // :383
  contradictoryStatePrefix: 'Contradictory state detected', // :1615
  invalidStatePathPrefix: 'Invalid state path in current state', // :1221
} as const

/**
 * Disambiguates the two queue-error classes by per-fire IDENTITY, not microtask
 * timing (conform-5 MED). The harness tags each flood `fireEvent` with the
 * issuing `faultStep`/`opId`; a SYNCHRONOUSLY-rejecting flood fire (rejected at
 * enqueue, before the promise leaves the call frame) is `'queue-overflow'`; a
 * rejection surfacing on a previously-pending, already-enqueued fire DURING the
 * `processQueues` drain is `'max-transition-depth'`.
 */
export interface RejectionOrigin {
  /** True iff the rejection was observed synchronously at enqueue (sync-throw path). */
  readonly syncAtEnqueue: boolean
}

/**
 * FROZEN structural error classifier (R10/R20). Maps a thrown/rejected engine
 * error to a {@link ErrorClass} by FIELD-SELECTION on the structured context +
 * the error's IDENTITY, NEVER by reading `error.message`. Returns `undefined`
 * for an error shape the harness does not classify (the frame then carries no
 * errorClass).
 *
 * The `origin` hint disambiguates `'queue-overflow'` (sync reject at enqueue,
 * :234) from `'max-transition-depth'` (pending-drain reject, :303) — both have
 * `context.event` and no `phase`, so the per-fire identity (not the message) is
 * the discriminator.
 *
 * Classification order (most specific identity first):
 *  1. injected fault (our {@link InjectedFault}, possibly re-wrapped via `cause`)
 *  2. corrupt-state family (contradictory / invalid-path, by context shape)
 *  3. transition-timeout (phase:'action', action set, no transition/state, no cause)
 *  4. queue errors (context.event present; origin splits overflow vs depth)
 *  5. invalid-event (context.event + context.state, no phase)
 */
export function classifyError(e: unknown, origin?: RejectionOrigin): ErrorClass | undefined {
  // (1) injected fault — identity, survives callAction re-wrap via `cause`.
  if (isInjectedFault(e)) {
    return 'injected-fault'
  }

  const ctx = contextOf(e)
  if (ctx === undefined) {
    return undefined
  }

  // (2) corrupt-state family — distinguished by the harness boundary that drives
  // the probe (see classifyCorruptState); here we recognize the engine's two
  // composite-validation throws by their context SHAPE. Both carry only `state`
  // (the composite string) and nothing else; the harness corrupt-state boundary
  // calls classifyCorruptState with the probe's expected class, so this path is
  // a structural backstop, never the primary corrupt-state route.

  // (3) transition-timeout: StateMachineError('Transition timeout', {action, phase})
  // — phase:'action', action present, NO transition/state, and (critically) NO
  // `cause` (an injected-fault rewrap WOULD carry a cause and was caught in (1)).
  if (
    ctx.phase === 'action' &&
    ctx.action !== undefined &&
    ctx.transition === undefined &&
    ctx.state === undefined &&
    (e as { cause?: unknown }).cause === undefined
  ) {
    return 'transition-timeout'
  }

  // (4) queue errors vs invalid-event: all three carry `context.event` and NO
  // `phase`. The per-fire IDENTITY is the discriminator (never the message):
  //   - a queue error is ALWAYS observed through `fireBuffered`, which supplies an
  //     `origin` (sync-at-enqueue ⇒ overflow :234; drain-time ⇒ depth :303);
  //   - the `event:'processQueues'` synthetic-event identity also marks depth even
  //     without an origin hint (the engine sets it at :305);
  //   - invalid-event (:383) is thrown DIRECTLY from fireEvent (no origin, real
  //     user event name + concrete state).
  if (ctx.event !== undefined && ctx.phase === undefined) {
    if (ctx.event === 'processQueues') {
      return 'max-transition-depth'
    }
    if (origin !== undefined) {
      return origin.syncAtEnqueue ? 'queue-overflow' : 'max-transition-depth'
    }
    // No origin and a real user event name alongside a concrete state ⇒
    // invalid-event (the direct fireEvent throw).
    if (ctx.state !== undefined) {
      return 'invalid-event'
    }
    return undefined
  }

  return undefined
}

/**
 * Classify a corrupt-state throw at the harness try/catch boundary by
 * FIELD-SELECTION (the probe declares which invariant it drives, so the expected
 * class is known). The engine messages (`:1615`/`:1221`) are pinned ONLY as
 * fixtures; this never reads them. Returns the FROZEN `'corrupt-state'`-family
 * class.
 */
export function classifyCorruptState(probe: CorruptStateProbe): ErrorClass {
  return probe.expectedErrorClass
}

/**
 * The 8th harness-only `corrupt-state` PROBE. SEPARATE from the seven-kind
 * {@link FaultKind} channel union — it is never assignable to `FaultKind`. Drives
 * the engine's OWN validation guards to throw via a VERIFIED throwing site (NOT
 * the silent-dedup `:1203` path; see tech-spec §5):
 *  - I-6 (`'restore'`): the raw duplicate-region string is validated by
 *    `validateCompositeState` on the restore path (`:734`) → throws `:1614`.
 *  - I-10 (`'unregistered-leaf'`): the unregistered leaf written via the wrapped
 *    `Adapter.set` is rejected by `getCurrentState`'s per-part `this.states.has`
 *    guard (`:1219`) → throws `:1220`.
 *
 * Step 5 guarantees ONLY capture-and-tag (the synthetic frame); the I-6/I-10
 * trigger-validity assertion is Step 6.
 */
export interface CorruptStateProbe {
  readonly kind: 'corrupt-state'
  readonly invariant: 'I-6' | 'I-10'
  readonly delivery: 'restore' | 'transition-target' | 'unregistered-leaf'
  /** Bogus composite string written via adaptee.set / returned by restore(). */
  readonly payload: string
  readonly expectedErrorClass: 'contradictory-state' | 'invalid-state-path'
  /** Drift fixture; NEVER a classification input. */
  readonly expectedMessagePrefix: string
}

/**
 * FROZEN I-6 probe primary (tech-spec §5): a duplicate-region restore payload
 * whose `validateCompositeState(:734)` collision throw is the witness. Both parts
 * share region key `root.regionA`.
 */
export const I6_PROBE: CorruptStateProbe = {
  kind: 'corrupt-state',
  invariant: 'I-6',
  delivery: 'restore',
  payload: 'root.regionA.leaf1|root.regionA.leaf2',
  expectedErrorClass: 'contradictory-state',
  expectedMessagePrefix: 'Contradictory state detected: multiple states for region',
}

/**
 * FROZEN I-10 probe primary (tech-spec §5): an unregistered-leaf payload written
 * via the wrapped `Adapter.set`, whose read-back `getCurrentState(:1219)` throw
 * is the witness. `root.regionA.bogusLeaf` is NOT a registered state.
 */
export const I10_PROBE: CorruptStateProbe = {
  kind: 'corrupt-state',
  invariant: 'I-10',
  delivery: 'unregistered-leaf',
  payload: 'root.regionA.leaf1|root.regionA.bogusLeaf',
  expectedErrorClass: 'invalid-state-path',
  expectedMessagePrefix: 'Invalid state path in current state',
}

/**
 * Per-opportunity PRNG draw → at-most-one {@link FaultRecord} per channel
 * opportunity. The monotonic `faultStep` indexes the draw so replay is bit-exact
 * (AC-2). A spec maps a stable `opId` → its {@link FaultSpec}; this resolver
 * returns the spec (if any) that fires at the given `opId`, and the next
 * `faultStep`. The single PRNG draw per opportunity is what makes replay
 * deterministic — even a no-fire opportunity consumes its draw so the stream
 * stays aligned when faults are added/removed between adjacent opIds.
 */
export interface FaultCursor {
  /** Monotonic opportunity counter; one PRNG draw per increment. */
  faultStep: number
}

/** Construct a fresh cursor at faultStep 0. */
export function makeFaultCursor(): FaultCursor {
  return { faultStep: 0 }
}

/**
 * Resolve the {@link FaultSpec} (if any) scheduled at `opId`, recording a
 * {@link FaultRecord} when one fires. Advances `cursor.faultStep` by exactly one
 * (one opportunity = one draw), so adding/removing a fault elsewhere does not
 * shift the faultStep of surviving opportunities — the cursor is keyed by the
 * opportunity, the spec is keyed by `opId` (R22 stable op-id addressing).
 */
export function resolveFaultAt(
  plan: FaultPlan,
  opId: string,
  cursor: FaultCursor,
  records: FaultRecord[],
): FaultSpec | undefined {
  const faultStep = cursor.faultStep
  cursor.faultStep += 1
  const spec = plan.faults.find((f) => 'opId' in f && f.opId === opId)
  if (spec !== undefined) {
    records.push({
      faultStep,
      kind: spec.kind,
      site: spec.site,
      ...(('opId' in spec && spec.opId !== undefined) ? { opId: spec.opId } : {}),
    })
  }
  return spec
}
