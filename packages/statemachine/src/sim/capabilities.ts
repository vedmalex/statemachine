/**
 * @module sim/capabilities
 * @unstable
 *
 * ADR-8 capability registry: a GENUINE closed string-literal {@link CapabilityId}
 * union (one literal per design §6 row — NO `string` / NO `string & {}` member)
 * and a TOTAL `Record<CapabilityId, Capability>` ({@link CAPABILITIES}) — `tsc
 * --noEmit` FAILS if any id lacks an entry (R19; proven by
 * `capabilities_totality.test.ts`).
 *
 * Every {@link CapabilityProbe} is PURE over a {@link SimTrace}: it reads ONLY
 * the content-only frame fields (`event` / `fireOutcome` / `from` / `to` /
 * `errorClass` / `cause` / `queue` / `doneDelta`). It switches on the FROZEN
 * {@link ErrorClass} enum, NEVER on `error.message` (the frame strips message,
 * R20), and NEVER calls a live `sm.isDone()` / `getCurrentState()` /
 * `getCurrentStateInfo()` at probe time — `inspection.isDone` /
 * `composite.join.done-state` read the CAPTURED `doneDelta` projection the
 * coverage runner samples at each settle boundary (the harness samples isDone(C)
 * per declared composite — state_machine.ts:1433 — and stores it on the frame;
 * the probe reads THAT, ADR-8 c2 purity).
 *
 * `coverageStatus` is NOT a static pass flag: it is COMPUTED at run time by
 * {@link computeCoverage} (an id whose probe never fired is UNCOVERED regardless
 * of any hand-set status). {@link DOCUMENTED_GAP_IDS} is the EXPLICIT committed
 * set of ids legitimately allowed uncovered (function-valued-callback error
 * throws on string-method machines + the dormant max-transition bound), so an
 * implementer cannot quietly move a failing id into "gap".
 */

import type { ErrorClass, SimTrace, TraceFrame } from './trace'

/**
 * GENUINE closed string-literal union — one literal per design §6 capability row.
 * There is NO `string` and NO `string & {}` member: those would collapse
 * {@link CAPABILITIES} to `Record<string, …>` and defeat the totality teeth
 * (R19, overrides design §4.9:432).
 */
export type CapabilityId =
  | 'event.fire.external'
  | 'event.raise.internal'
  | 'queue.internal-before-external'
  | 'transition.guard.pass'
  | 'transition.guard.block'
  | 'transition.priority'
  | 'transition.onTransition'
  | 'event.wildcard'
  | 'hook.entry.onBeforeEnter'
  | 'hook.entry.onEnter'
  | 'hook.entry.onAfterEnter'
  | 'hook.exit.onBeforeExit'
  | 'hook.exit.onExit'
  | 'hook.exit.onAfterExit'
  | 'event.onBefore'
  | 'event.onAfter'
  | 'event.onSuccess'
  | 'event.onError'
  | 'hierarchy.nested-enter'
  | 'composite.parallel-regions'
  | 'composite.join.done-state'
  | 'history.shallow'
  | 'history.deep'
  | 'timer.invoke.fire'
  | 'timer.invoke.cond-skip'
  | 'timer.invoke.cancel-on-exit'
  | 'timer.transitionTimeout'
  | 'timer.resume'
  | 'error.action-throw'
  | 'error.guard-throw'
  | 'error.recovery.errorState'
  | 'error.recovery.abortOnExitError'
  | 'queue.backpressure.overflow'
  | 'queue.depth-bound.max-transition'
  | 'persistence.serialize'
  | 'persistence.deserialize'
  | 'inspection.getQueueDepth'
  | 'inspection.getCurrentStateInfo'
  | 'inspection.isDone'

/**
 * A PURE capability probe over the canonical content-only {@link SimTrace}.
 * Switches on the {@link ErrorClass} enum, never `e.message`; reads the captured
 * `doneDelta` projection, never a live `sm.*` / IMonitor / wall-clock.
 */
export type CapabilityProbe = (trace: SimTrace) => boolean

/** One capability registry row. */
export interface Capability {
  readonly id: CapabilityId
  readonly title: string
  /** file:line citations into the engine source. */
  readonly engineRefs: readonly string[]
  readonly probe: CapabilityProbe
  readonly tier?: 'core' | 'advanced'
  /** COMPUTED at run-time by {@link computeCoverage}; never a static pass flag. */
  readonly coverageStatus?: 'covered' | 'dormant' | 'n/a-string-method'
}

// ── probe helpers (pure; no live engine read) ──────────────────────────────

/** True iff any frame satisfies `pred`. */
function some(trace: SimTrace, pred: (f: TraceFrame) => boolean): boolean {
  return trace.frames.some(pred)
}

/** A frame is a real state change iff its normalized `from` differs from `to`. */
function isStateChange(f: TraceFrame): boolean {
  return f.from !== f.to
}

/** True iff a part of a normalized composite string is/ends with the given leaf token. */
function hasLeaf(composite: string, leaf: string): boolean {
  return composite.split('|').some((p) => p === leaf || p.endsWith(`.${leaf}`))
}

/** True iff the given dotted segment appears ANYWHERE in any |-part (not only as a leaf). */
function hasSegment(composite: string, segment: string): boolean {
  return composite.split('|').some((p) => p === segment || p.split('.').includes(segment))
}

/** A frame whose errorClass equals `ec`. */
function hasErrorClass(trace: SimTrace, ec: ErrorClass): boolean {
  return some(trace, (f) => f.errorClass === ec)
}

/**
 * The capability registry. TOTAL over {@link CapabilityId} — `tsc --noEmit` FAILS
 * if any id lacks an entry. Each probe is PURE (content-only trace; ErrorClass
 * enum; captured doneDelta).
 *
 * Probe design uses dedicated SENTINEL event names emitted by the registered
 * `scenarios/*.ts` so each probe is unambiguous: a sentinel `event` name + a
 * `fireOutcome` (and, where the capability is a state effect, a `to`/`from`
 * delta) is the witness. Hook-firing — which is a side effect NOT carried in the
 * content-only trace — is observed INDIRECTLY: a hook pushes a marker the
 * downstream sentinel guard reads, so a `resolve-true` on the sentinel event is
 * the proof the hook ran (no live engine read; the trace alone witnesses it).
 */
export const CAPABILITIES: Record<CapabilityId, Capability> = {
  'event.fire.external': {
    id: 'event.fire.external',
    title: 'external event fire drives a transition',
    engineRefs: ['state_machine.ts:445', 'state_machine.ts:1204'],
    tier: 'core',
    probe: (t) => some(t, (f) => f.cause === 'external' && f.fireOutcome === 'resolve-true' && isStateChange(f)),
  },
  'event.raise.internal': {
    id: 'event.raise.internal',
    title: 'internal raised event (delay:0 invoke / done.state) processed',
    engineRefs: ['state_machine.ts:1456', 'state_machine.ts:2170'],
    tier: 'core',
    // A delay:0 invoke at the initial state raises its event during the init drain;
    // the resulting transition is a cause:'init' state change (or a cause:'timer'
    // one for a later armed invoke).
    probe: (t) => some(t, (f) => (f.cause === 'timer' || f.cause === 'init') && isStateChange(f)),
  },
  'queue.internal-before-external': {
    id: 'queue.internal-before-external',
    title: 'internal queue drained before external (DOCUMENTED_GAP: boundary-only invisible)',
    engineRefs: ['state_machine.ts:1456', 'state_machine.ts:445'],
    tier: 'advanced',
    // DOCUMENTED_GAP (structurally unreachable; EMPIRICALLY confirmed, F-PF-1): the
    // engine drains the internal queue fully before each external and before the
    // macrostep settles, so EVERY captured frame — both the Adapter-seam writes
    // DURING the drain and the settle-boundary frame — reads queue.internal===0. A
    // non-zero internal depth would require sampling INSIDE the engine's private
    // drain loop, which ADR-7 c8 forbids (zero core-ABI). Verified: an external fire
    // driving a chain of delay:0 internal raises never yields a frame with
    // internal>0. Kept gapped.
    probe: (t) => some(t, (f) => f.queue.internal > 0),
  },
  'transition.guard.pass': {
    id: 'transition.guard.pass',
    title: 'guard returns true → transition proceeds',
    engineRefs: ['state_machine.ts:1830'],
    tier: 'core',
    // Sentinel: an event whose ONLY transition has a guard, resolving true with a
    // state change.
    probe: (t) => some(t, (f) => f.event === 'wGuardPass' && f.fireOutcome === 'resolve-true' && isStateChange(f)),
  },
  'transition.guard.block': {
    id: 'transition.guard.block',
    title: 'guard returns false → transition blocked (resolve-false)',
    engineRefs: ['state_machine.ts:402'],
    tier: 'core',
    // R21: read fireOutcome:'resolve-false' (source 2), NEVER a state-write frame.
    probe: (t) => some(t, (f) => f.event === 'wGuardBlock' && f.fireOutcome === 'resolve-false'),
  },
  'transition.priority': {
    id: 'transition.priority',
    title: 'higher-priority competing transition wins',
    engineRefs: ['state_machine.ts:1808'],
    tier: 'advanced',
    // CONCRETE non-vacuous probe: the sentinel event has two competing transitions
    // and the higher-priority target ('phi', reachable ONLY via priority) is hit.
    probe: (t) => some(t, (f) => f.event === 'wPrio' && f.fireOutcome === 'resolve-true' && hasLeaf(f.to, 'phi')),
  },
  'transition.onTransition': {
    id: 'transition.onTransition',
    title: 'onTransition callback fires (observed via downstream marker)',
    engineRefs: ['state_machine.ts:1997'],
    tier: 'advanced',
    probe: (t) => some(t, (f) => f.event === 'wOnTransition' && f.fireOutcome === 'resolve-true' && isStateChange(f)),
  },
  'event.wildcard': {
    id: 'event.wildcard',
    title: 'wildcard "*" event matches an undeclared event name',
    engineRefs: ['state_machine.ts:520'],
    tier: 'advanced',
    // Sentinel: the event name is NOT declared but a '*' transition fires it.
    probe: (t) => some(t, (f) => f.event === 'wWildcard' && f.fireOutcome === 'resolve-true' && isStateChange(f)),
  },
  'hook.entry.onBeforeEnter': {
    id: 'hook.entry.onBeforeEnter',
    title: 'onBeforeEnter hook fires (observed via downstream marker)',
    engineRefs: ['state_machine.ts:2105'],
    probe: (t) => some(t, (f) => f.event === 'wOnBeforeEnter' && f.fireOutcome === 'resolve-true' && isStateChange(f)),
  },
  'hook.entry.onEnter': {
    id: 'hook.entry.onEnter',
    title: 'onEnter hook fires (observed via downstream marker)',
    engineRefs: ['state_machine.ts:2135'],
    probe: (t) => some(t, (f) => f.event === 'wOnEnter' && f.fireOutcome === 'resolve-true' && isStateChange(f)),
  },
  'hook.entry.onAfterEnter': {
    id: 'hook.entry.onAfterEnter',
    title: 'onAfterEnter hook fires (observed via downstream marker)',
    engineRefs: ['state_machine.ts:2135'],
    probe: (t) => some(t, (f) => f.event === 'wOnAfterEnter' && f.fireOutcome === 'resolve-true' && isStateChange(f)),
  },
  'hook.exit.onBeforeExit': {
    id: 'hook.exit.onBeforeExit',
    title: 'onBeforeExit hook fires (observed via downstream marker)',
    engineRefs: ['state_machine.ts:2105'],
    probe: (t) => some(t, (f) => f.event === 'wOnBeforeExit' && f.fireOutcome === 'resolve-true' && isStateChange(f)),
  },
  'hook.exit.onExit': {
    id: 'hook.exit.onExit',
    title: 'onExit hook fires (observed via downstream marker)',
    engineRefs: ['state_machine.ts:2105'],
    probe: (t) => some(t, (f) => f.event === 'wOnExit' && f.fireOutcome === 'resolve-true' && isStateChange(f)),
  },
  'hook.exit.onAfterExit': {
    id: 'hook.exit.onAfterExit',
    title: 'onAfterExit hook fires (observed via downstream marker)',
    engineRefs: ['state_machine.ts:2105'],
    probe: (t) => some(t, (f) => f.event === 'wOnAfterExit' && f.fireOutcome === 'resolve-true' && isStateChange(f)),
  },
  'event.onBefore': {
    id: 'event.onBefore',
    title: 'event-level onBefore fires (observed via downstream marker)',
    engineRefs: ['state_machine.ts:1967'],
    probe: (t) => some(t, (f) => f.event === 'wOnBefore' && f.fireOutcome === 'resolve-true' && isStateChange(f)),
  },
  'event.onAfter': {
    id: 'event.onAfter',
    title: 'event-level onAfter fires (observed via downstream marker)',
    engineRefs: ['state_machine.ts:2029'],
    probe: (t) => some(t, (f) => f.event === 'wOnAfter' && f.fireOutcome === 'resolve-true' && isStateChange(f)),
  },
  'event.onSuccess': {
    id: 'event.onSuccess',
    title: 'event-level onSuccess (DOCUMENTED_GAP: engine never invokes onSuccess)',
    engineRefs: ['state_machine.ts:956', 'state_machine.ts:2688'],
    // DOCUMENTED_GAP (structurally unreachable): the engine ONLY (de)serializes
    // onSuccess (:956/:982/:2688); it is NEVER dispatched in the transition flow,
    // so no honest content-trace scenario can fire it. Kept gapped (F-PF-1).
    probe: (t) => some(t, (f) => f.event === 'wOnSuccess' && f.fireOutcome === 'resolve-true' && isStateChange(f)),
  },
  'event.onError': {
    id: 'event.onError',
    title: 'event-level onError (DOCUMENTED_GAP: dispatched un-awaited)',
    engineRefs: ['state_machine.ts:2037'],
    // DOCUMENTED_GAP (structurally unreachable): onError is dispatched UN-AWAITED
    // (:2037, tech-spec §4.1) and only on an awaited-callback throw; ErrorHandler<T>
    // returns void so it carries no tracked async work observable in the content
    // trace. Kept gapped (F-PF-1).
    probe: (t) => some(t, (f) => f.event === 'wOnError' && f.fireOutcome === 'resolve-true' && isStateChange(f)),
  },
  'hierarchy.nested-enter': {
    id: 'hierarchy.nested-enter',
    title: 'entering a composite enters its initial child',
    engineRefs: ['state_machine.ts:1317'],
    tier: 'advanced',
    // Witness: a transition into a composite ('C') that resolves true.
    probe: (t) => some(t, (f) => f.event === 'wNestedEnter' && f.fireOutcome === 'resolve-true' && hasLeaf(f.to, 'C')),
  },
  'composite.parallel-regions': {
    id: 'composite.parallel-regions',
    title: 'parallel regions render a |-joined composite',
    engineRefs: ['state_machine.ts:1202', 'state_machine.ts:639'],
    tier: 'advanced',
    // Witness: any frame whose from OR to is a multi-part '|'-composite.
    probe: (t) => some(t, (f) => f.from.includes('|') || f.to.includes('|')),
  },
  'composite.join.done-state': {
    id: 'composite.join.done-state',
    title: 'all regions final → done.state.<C> + captured isDone delta',
    engineRefs: ['state_machine.ts:1443', 'state_machine.ts:1433'],
    tier: 'advanced',
    // Two-source witness: a captured doneDelta marks a composite done (read the
    // projection, NEVER a live sm.isDone()).
    probe: (t) => some(t, (f) => (f.doneDelta ?? []).some((d) => d.done)),
  },
  'history.shallow': {
    id: 'history.shallow',
    title: 'shallow history restores the last region child',
    engineRefs: ['state_machine.ts:1116'],
    tier: 'advanced',
    // Shallow restore re-enters the remembered first-level region child ('hs2', a
    // composite) — resetting its grandchildren; the witness is the 'hs2' SEGMENT
    // appearing in the restored path (distinct from a fresh enter on the initial
    // 'hs1'). 'hs2' is an intermediate segment, not a leaf, so hasSegment is used.
    probe: (t) =>
      some(t, (f) => f.event === 'wHistShallow' && f.fireOutcome === 'resolve-true' && hasSegment(f.to, 'hs2')),
  },
  'history.deep': {
    id: 'history.deep',
    title: 'deep history restores the full nested grandchild path',
    engineRefs: ['state_machine.ts:1126'],
    tier: 'advanced',
    // Deep restore remembers the FULL nested path; the witness is reaching the
    // remembered grandchild leaf 'hdy' (distinct from the initial 'hd1').
    probe: (t) => some(t, (f) => f.event === 'wHistDeep' && f.fireOutcome === 'resolve-true' && hasLeaf(f.to, 'hdy')),
  },
  'timer.invoke.fire': {
    id: 'timer.invoke.fire',
    title: 'an armed invoke timer fires and reaches its target leaf',
    engineRefs: ['state_machine.ts:2170', 'scheduler.ts:108'],
    tier: 'advanced',
    // Witness: a cause:'timer' frame whose `to` reaches the sentinel timer target
    // leaf 'tfired'. (The Step-3 driver settles a clock-advance in the pre-fire
    // drain, so the timer's state-write may be reflected only on the cause:'timer'
    // boundary frame's `to` rather than a from!==to delta; reaching 'tfired' under
    // a timer cause is the unambiguous witness.)
    probe: (t) => some(t, (f) => f.cause === 'timer' && hasLeaf(f.to, 'tfired')),
  },
  'timer.invoke.cond-skip': {
    id: 'timer.invoke.cond-skip',
    title: 'invoke.cond returns false → timer armed but no transition',
    engineRefs: ['state_machine.ts:2153'],
    tier: 'advanced',
    // The legitimate cond-skip path: a timer-caused boundary frame at advanced
    // time with NO state change (cond false, no raise) AND NO timer-caused
    // transition reaching the would-be target leaf 'skiptarget' EVER happened.
    probe: (t) =>
      some(t, (f) => f.cause === 'timer' && f.t > 0 && !isStateChange(f)) &&
      !some(t, (f) => f.cause === 'timer' && hasLeaf(f.to, 'skiptarget')),
  },
  'timer.invoke.cancel-on-exit': {
    id: 'timer.invoke.cancel-on-exit',
    title: 'leaving a state cancels its armed invoke timer',
    engineRefs: ['scheduler.ts:99', 'state_machine.ts:1985'],
    tier: 'advanced',
    // Sentinel: 'wCancelArm' moves out of the timer-bearing state before its delay;
    // the timer is lazily cancelled and never fires (no later timer state change).
    probe: (t) =>
      some(t, (f) => f.event === 'wCancelArm' && f.fireOutcome === 'resolve-true') &&
      !some(t, (f) => f.cause === 'timer' && hasLeaf(f.to, 'cancelTarget')),
  },
  'timer.transitionTimeout': {
    id: 'timer.transitionTimeout',
    title: 'transitionTimeout fires → transition-timeout errorClass',
    engineRefs: ['state_machine.ts:1790', 'state_machine.ts:1798'],
    tier: 'advanced',
    // COVERED (F-PF-1): the coverage runner's wire-time transitionTimeout drive path
    // fires a hanging-onTransition event and advances the virtual clock past the
    // timeout so the Promise.race timeout leg rejects → 'transition-timeout'.
    probe: (t) => hasErrorClass(t, 'transition-timeout'),
  },
  'timer.resume': {
    id: 'timer.resume',
    title: 'resume re-arms timers after restore (post-restore frame)',
    engineRefs: ['state_machine.ts:2503'],
    tier: 'advanced',
    // COVERED (F-PF-1): the coverage runner's wire-time snapshot/restore drive path
    // calls restoreState (→ resumeTimers, re-arming the pending invoke timer) and
    // appends a synthetic:'post-restore' frame.
    probe: (t) => some(t, (f) => f.synthetic === 'post-restore'),
  },
  'error.action-throw': {
    id: 'error.action-throw',
    title: 'a function-valued action throws → injected-fault errorClass',
    engineRefs: ['state_machine.ts:1774'],
    tier: 'advanced',
    probe: (t) => hasErrorClass(t, 'injected-fault') && some(t, (f) => f.event === 'actThrow'),
  },
  'error.guard-throw': {
    id: 'error.guard-throw',
    title: 'a function-valued guard throws → injected-fault errorClass',
    engineRefs: ['state_machine.ts:1774', 'state_machine.ts:1830'],
    tier: 'advanced',
    probe: (t) => hasErrorClass(t, 'injected-fault') && some(t, (f) => f.event === 'guardThrow'),
  },
  'error.recovery.errorState': {
    id: 'error.recovery.errorState',
    title: 'throwing onEnter routes to the configured errorState',
    engineRefs: ['state_machine.ts:2020'],
    tier: 'advanced',
    // Witness: a transition whose normalized `to` reaches the sentinel errorState
    // 'errst'.
    probe: (t) => some(t, (f) => f.event === 'wErrorState' && hasLeaf(f.to, 'errst')),
  },
  'error.recovery.abortOnExitError': {
    id: 'error.recovery.abortOnExitError',
    title: 'abortOnExitError stays-in-source when an onExit throws',
    engineRefs: ['state_machine.ts:1985'],
    tier: 'advanced',
    // Stay-in-source (:1985-1988): the fire that triggers the throwing onExit
    // leaves config stable (resolve-false / no state change) AND raises injected.
    probe: (t) =>
      hasErrorClass(t, 'injected-fault') &&
      some(t, (f) => f.event === 'exitThrow' && !isStateChange(f)),
  },
  'queue.backpressure.overflow': {
    id: 'queue.backpressure.overflow',
    title: 'queue overflow → queue-overflow errorClass (sync at enqueue)',
    engineRefs: ['state_machine.ts:234'],
    tier: 'advanced',
    // COVERED (F-PF-1): the coverage runner's wire-time overflow drive path floods
    // the bounded queue (maxQueueDepth:2) so the (max+1)-th enqueue rejects
    // synchronously → 'queue-overflow'.
    probe: (t) => hasErrorClass(t, 'queue-overflow'),
  },
  'queue.depth-bound.max-transition': {
    id: 'queue.depth-bound.max-transition',
    title: 'max transition depth → max-transition-depth errorClass (DORMANT)',
    engineRefs: ['state_machine.ts:303'],
    tier: 'advanced',
    // DORMANT: no non-fault scenario reaches it; DOCUMENTED_GAP_IDS member.
    probe: (t) => hasErrorClass(t, 'max-transition-depth'),
  },
  'persistence.serialize': {
    id: 'persistence.serialize',
    title: 'snapshot serializes the machine state',
    engineRefs: ['state_machine.ts:724'],
    tier: 'advanced',
    // COVERED (F-PF-1): the coverage runner's wire-time snapshot/restore drive path
    // calls saveState (serialize) then restoreState (deserialize); the round-trip
    // lands a synthetic:'post-restore' frame the probe reads.
    probe: (t) => some(t, (f) => f.synthetic === 'post-restore'),
  },
  'persistence.deserialize': {
    id: 'persistence.deserialize',
    title: 'restore deserializes a snapshot and re-arms timers',
    engineRefs: ['state_machine.ts:733'],
    tier: 'advanced',
    // COVERED (F-PF-1): see persistence.serialize — the same restoreState round-trip
    // (deserialize + resumeTimers) lands the synthetic:'post-restore' frame.
    probe: (t) => some(t, (f) => f.synthetic === 'post-restore'),
  },
  'inspection.getQueueDepth': {
    id: 'inspection.getQueueDepth',
    title: 'getQueueDepth is reflected in every captured frame',
    engineRefs: ['state_machine.ts:512'],
    tier: 'core',
    // Every frame carries the queue snapshot (getQueueDepth projection). Witness:
    // a frame exists (queue is structurally present).
    probe: (t) => t.frames.length > 0,
  },
  'inspection.getCurrentStateInfo': {
    id: 'inspection.getCurrentStateInfo',
    title: 'getCurrentStateInfo: from/to are captured per frame',
    engineRefs: ['state_machine.ts:639'],
    tier: 'core',
    // The from/to '|'-normalized projection of getCurrentState(Info). Witness: a
    // real state-change frame exists.
    probe: (t) => some(t, isStateChange),
  },
  'inspection.isDone': {
    id: 'inspection.isDone',
    title: 'isDone(C) captured as a per-composite doneDelta projection',
    engineRefs: ['state_machine.ts:1433'],
    tier: 'advanced',
    // Reads the captured doneDelta projection, NEVER a live sm.isDone().
    probe: (t) => some(t, (f) => f.doneDelta !== undefined && f.doneDelta.length > 0),
  },
}

/**
 * EXPLICIT committed set of ids legitimately allowed uncovered — the FROZEN
 * MINIMAL gap set (tech-spec §3.7, restored under F-PF-1). An implementer cannot
 * quietly move a failing id into "gap" — this constant is the only place the gate
 * excludes ids from the `uncovered>0` failure, and `capabilities_gap_pin.test.ts`
 * deep-equal pins it so it cannot silently re-widen. Each member has a GENUINELY
 * STRUCTURAL reason it cannot be exercised in v1; none is a silent pass (ISS-029).
 *
 * The four frozen-minimal members (string-method-resolved error throws + the
 * dormant queue-depth bound):
 *  - `error.guard-throw` / `error.action-throw` / `error.recovery.abortOnExitError`:
 *    the engine SWALLOWS a function-valued callback throw inside callAction's
 *    `.catch(processError)` (state_machine.ts:1774) — the throw is a HARNESS-boundary
 *    signal (Step-5 `applyThrowFaults` onInjected callback), NOT an `errorClass` in
 *    the content trace. On a STRING-METHOD machine they are additionally structurally
 *    unreachable (the config-mutation throw wrapper cannot reach a string method name
 *    resolved inside callAction) — reported `n/a-string-method` (ISS-029).
 *  - `queue.depth-bound.max-transition`: DORMANT — reaching the :303 throw requires an
 *    injected infinite-loop the registered scenarios deliberately do not build.
 *
 * The three additionally-kept-gapped members (F-PF-1 amendment to tech-spec §3.7 —
 * recorded in the canonical TECH_SPEC artifact; each is STRUCTURALLY unreachable by
 * an honest v1 content-trace scenario, NOT merely un-driven):
 *  - `queue.internal-before-external`: EMPIRICALLY confirmed unreachable. The content
 *    trace samples `getQueueDepth()` at the Adapter-seam write AND the settle
 *    boundary; the engine drains the internal queue fully before each external and
 *    before the macrostep settles, so EVERY captured frame reads `queue.internal===0`
 *    (verified: an external fire driving a chain of delay:0 internal raises never
 *    yields a frame with `internal>0`). A non-zero internal depth is structurally
 *    invisible to a boundary-only content trace — it would require sampling INSIDE
 *    the engine's private drain loop, which ADR-7 c8 forbids.
 *  - `event.onSuccess`: the engine NEVER dispatches `event.onSuccess` at runtime — it
 *    is ONLY (de)serialized (state_machine.ts:956/982/2688) and is read nowhere in the
 *    transition flow (verified: no `event.onSuccess(...)` / awaited call site exists).
 *    A dormant engine config field; no scenario can fire it.
 *  - `event.onError`: dispatched UN-AWAITED (state_machine.ts:2037) and only on an
 *    awaited-callback throw; `ErrorHandler<T>` returns `void` (tech-spec §4.1 OUT OF
 *    SCOPE) so it carries no tracked async work observable in the content trace.
 *
 * NOTE — five ids that WERE gapped are now COVERED (F-PF-1): `queue.backpressure.overflow`
 * (wire-time overflow flood → `queue-overflow` errorClass), `timer.transitionTimeout`
 * (wire-time transitionTimeout race → `transition-timeout` errorClass), and
 * `timer.resume` / `persistence.serialize` / `persistence.deserialize` (wire-time
 * snapshot/restore → `synthetic:'post-restore'` frame). See `coverage.ts` drive paths
 * and `scenarios/{persistence,backpressure-timeout}.ts`.
 */
export const DOCUMENTED_GAP_IDS: ReadonlySet<CapabilityId> = new Set<CapabilityId>([
  'error.guard-throw',
  'error.action-throw',
  'error.recovery.abortOnExitError',
  'queue.depth-bound.max-transition',
  'queue.internal-before-external',
  'event.onSuccess',
  'event.onError',
])

/** Sorted live key-set of {@link CAPABILITIES} (the source of `etc/sim-capabilities.txt`). */
export function capabilityKeys(): CapabilityId[] {
  return (Object.keys(CAPABILITIES) as CapabilityId[]).sort()
}
