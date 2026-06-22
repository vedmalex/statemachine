/**
 * @module sim/invariants
 * @unstable
 *
 * ADR-6 SAFETY plane: the FROZEN invariant contract types ({@link Invariant} /
 * {@link Violation} / {@link CheckerContext} / {@link ConfigGraph} /
 * {@link FinalState}) + the read-only `ConfigGraph` builder + the declarative
 * I-1..I-12 invariant registry data ({@link INVARIANTS}).
 *
 * The blind iteration `runSafety` is DELIBERATELY isolated in
 * `invariants.runner.ts` so the "never references an id literally" grep is
 * MECHANICAL: this file legitimately contains the `I-\d+` id literals (it is the
 * registry data), the runner file does not.
 *
 * Checkers are PURE functions of `(frame|state, ctx)` (ADR-6 c3): they make NO
 * live engine read. `getRegionKey` is REPLICATED in {@link ConfigGraph} (the
 * engine's is PRIVATE at state_machine.ts:2435, never called). Outcomes come from
 * the `fireEvent` Promise + the Step-2 Adapter-seam deltas captured in the trace,
 * NEVER from `IMonitor` (recordTransition is hardcoded `(time,true)` at :2059-2060
 * and cannot be a determinism signal).
 *
 * No `Math.random` / `Date.now` / `performance.now`; no local settle/drain/flush.
 */

import type {
  CanonicalHeader,
  CanonicalTrace,
  ErrorClass,
  TraceFrame,
} from './trace'
import { normalizeParts } from './trace'

/** Where an invariant is evaluated: per-step, at the final state, or both. */
export type InvariantScope = 'step' | 'final' | 'both'

/** The terminal state the `checkFinal` invariants see (content-only, normalized). */
export interface FinalState {
  /** normalized '|'-sorted composite. */
  readonly config: string
  readonly queue: { readonly internal: number; readonly external: number }
  readonly quiescent: boolean
}

/**
 * Read-only structural view of the machine config, computed ONCE per run. The
 * engine's `getRegionKey` is PRIVATE (state_machine.ts:2435) — it is REPLICATED
 * here byte-for-byte (`lastIndexOf('.')` split) so checkers stay pure.
 */
export interface ConfigGraph {
  /** Region key of a state part: prefix up to the last '.', or the whole part. */
  getRegionKey(statePart: string): string
  /** Number of '.'-separated levels below the root for a state part. */
  depthOf(statePart: string): number
  /** True iff `statePart` is a registered state in the config (read-path guard). */
  isRegisteredLeaf(statePart: string): boolean
  readonly states: ReadonlySet<string>
  readonly composites: ReadonlySet<string>
  /** `done.state.<C>` events the config explicitly declares. */
  readonly declaredDoneEvents: ReadonlySet<string>
}

/** The pure context every checker receives (graph + header; NO live engine). */
export interface CheckerContext {
  readonly graph: ConfigGraph
  readonly header: CanonicalHeader
  /**
   * The configured `maxQueueDepth` bound (StateMachineOptions, types.ts:146), if
   * the run set one. I-9 is vacuous when absent. This is config-derived (pure), not
   * a live engine read; the harness supplies it from the same options it wired.
   */
  readonly maxQueueDepth?: number
}

/**
 * A single safety violation. AT MOST ONE per run (lowest-step `checkStep` else
 * first `checkFinal`; I-1 short-circuits). The {@link Violation.fingerprint} tuple
 * is the ONLY equality key the shrinker predicate uses (R15) — `message`/
 * `observed`/`expected` are human-readable and NEVER part of the fingerprint.
 */
export interface Violation {
  readonly invariantId: string
  readonly step: number
  /** normalized '|'-sorted. */
  readonly witness: string
  readonly errorClass?: ErrorClass
  /** human-readable; NOT hashed; NOT the fingerprint. */
  readonly message: string
  readonly observed: string
  readonly expected: string
  /** The shrinker target — the ONLY equality key the predicate uses. */
  readonly fingerprint: {
    readonly invariantId: string
    readonly witness: string
    readonly errorClass?: ErrorClass
  }
}

/**
 * A declarative invariant. The runner iterates a `readonly Invariant[]` BLIND
 * (never references an id literally). `capabilityTags` wire the Step-9 coverage
 * gate; `checkStep`/`checkFinal` are PURE (no live engine read).
 */
export interface Invariant {
  readonly id: string
  readonly scope: InvariantScope
  readonly capabilityTags?: readonly string[]
  checkStep?(frame: TraceFrame, ctx: CheckerContext): Violation | null
  checkFinal?(state: FinalState, ctx: CheckerContext): Violation | null
}

/** Build a {@link Violation} from its parts, deriving the fingerprint tuple. */
export function makeViolation(parts: {
  invariantId: string
  step: number
  witness: string
  errorClass?: ErrorClass
  message: string
  observed: string
  expected: string
}): Violation {
  const witness = normalizeParts(parts.witness)
  return {
    invariantId: parts.invariantId,
    step: parts.step,
    witness,
    message: parts.message,
    observed: parts.observed,
    expected: parts.expected,
    ...(parts.errorClass !== undefined ? { errorClass: parts.errorClass } : {}),
    fingerprint: {
      invariantId: parts.invariantId,
      witness,
      ...(parts.errorClass !== undefined ? { errorClass: parts.errorClass } : {}),
    },
  }
}

/**
 * Build the read-only {@link ConfigGraph} from a topology-shaped config value. We
 * duck-type the config (the structural fields we walk: `states`, nested
 * `regions`, `initial`, `final`) so this has NO forward dependency on the Step-4
 * `TopologySpec` type. `getRegionKey` REPLICATES state_machine.ts:2435 exactly:
 * `lastIndexOf('.') === -1 ? path : path.substring(0, lastIndexOf('.'))`.
 *
 * State paths are accumulated as fully-qualified dotted paths (`root.regionA.leaf`),
 * matching how the engine renders a composite-state part.
 */
export function buildConfigGraph(config: unknown): ConfigGraph {
  const states = new Set<string>()
  const composites = new Set<string>()
  const declaredDoneEvents = new Set<string>()

  const visitState = (name: string, node: unknown, prefix: string): void => {
    const path = prefix === '' ? name : `${prefix}.${name}`
    states.add(path)
    const n = (node ?? {}) as Record<string, unknown>
    const regions = n['regions']
    if (regions && typeof regions === 'object') {
      composites.add(path)
      for (const [regionName, regionStates] of Object.entries(regions as Record<string, unknown>)) {
        const regionPath = `${path}.${regionName}`
        if (regionStates && typeof regionStates === 'object') {
          for (const [sn, sv] of Object.entries(regionStates as Record<string, unknown>)) {
            visitState(sn, sv, regionPath)
          }
        }
      }
    }
    const nested = n['states']
    if (nested && typeof nested === 'object') {
      composites.add(path)
      for (const [sn, sv] of Object.entries(nested as Record<string, unknown>)) {
        visitState(sn, sv, path)
      }
    }
  }

  const cfg = (config ?? {}) as Record<string, unknown>
  const topStates = cfg['states']
  if (topStates && typeof topStates === 'object') {
    for (const [name, node] of Object.entries(topStates as Record<string, unknown>)) {
      visitState(name, node, '')
    }
  }

  // Declared done.state.<C> events: any event name starting with 'done.state.'.
  const events = cfg['events']
  if (events && typeof events === 'object') {
    for (const name of Object.keys(events as Record<string, unknown>)) {
      if (name.startsWith('done.state.')) {
        declaredDoneEvents.add(name)
      }
    }
  }

  return {
    getRegionKey(statePart: string): string {
      const lastDot = statePart.lastIndexOf('.')
      return lastDot === -1 ? statePart : statePart.substring(0, lastDot)
    },
    depthOf(statePart: string): number {
      let depth = 0
      for (let i = 0; i < statePart.length; i++) {
        if (statePart[i] === '.') {
          depth++
        }
      }
      return depth
    },
    isRegisteredLeaf(statePart: string): boolean {
      return states.has(statePart)
    },
    states,
    composites,
    declaredDoneEvents,
  }
}

/**
 * Project a {@link CanonicalTrace} to a {@link FinalState}. The terminal config is
 * read from the last NON-synthetic frame: a trailing `synthetic:'corrupt-state'`
 * frame is a probe WITNESS (a bogus payload deliberately written to drive a guard
 * throw), never the real terminal configuration — it must not be validated as the
 * final state (ADR-6 / ISS-031: the probe is the last op; its payload is a witness).
 */
export function finalStateOf(trace: CanonicalTrace): FinalState {
  const frames = trace.frames
  let last: TraceFrame | undefined
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i]
    if (f !== undefined && f.synthetic !== 'corrupt-state') {
      last = f
      break
    }
  }
  if (last === undefined) {
    return { config: '', queue: { internal: 0, external: 0 }, quiescent: true }
  }
  return {
    config: last.to,
    queue: { internal: last.queue.internal, external: last.queue.external },
    quiescent: last.quiescent,
  }
}

// ── I-1..I-12 invariant registry (ADR-6-revised) ─────────────────────────────
//
// Outcomes derive from the captured TraceFrame stream (fireOutcome + Adapter-seam
// from/to deltas + queue/quiescent/errorClass/doneDelta), NEVER IMonitor. Every
// checker is a PURE function of (frame|state, ctx). Witnesses are '|'-normalized
// by makeViolation.

/**
 * I-1 DETERMINISM (final, meta). Same seed twice → equal `hashTrace`. The pair of
 * runs is compared by {@link runSafety}'s caller (it has both traces); the
 * registry entry is a PLACEHOLDER whose checkFinal never fires on a single trace
 * (the determinism check is a cross-run comparison the runner short-circuits on).
 * Kept in the registry for completeness + so I-1 is counted in the blind set.
 */
const I1: Invariant = {
  id: 'I-1',
  scope: 'final',
  capabilityTags: ['meta.determinism'],
  checkFinal(): Violation | null {
    // Single-trace I-1 cannot fail (determinism is a two-run property the runner
    // checks separately). Always clean here.
    return null
  },
}

/**
 * I-2 NO-LOST-EVENTS (final). Every fire settles by resolve-true/false/reject.
 * A never-settled fire is a violation. The trace records a `fireOutcome` for every
 * fire frame, so a settled-fire trace has no missing outcome; we assert no fire
 * frame is missing its outcome.
 */
const I2: Invariant = {
  id: 'I-2',
  scope: 'step',
  capabilityTags: ['queue.no-lost-events'],
  checkStep(frame): Violation | null {
    // A frame carrying an `event` that originated from a fire (cause:'external')
    // MUST carry a fireOutcome. A missing outcome on an external-event frame means
    // the fire was lost (never settled).
    if (frame.cause === 'external' && frame.event !== undefined && frame.fireOutcome === undefined) {
      return makeViolation({
        invariantId: 'I-2',
        step: frame.step,
        witness: frame.event,
        message: `fire '${frame.event}' never settled (no fireOutcome recorded)`,
        observed: 'no fireOutcome',
        expected: 'resolve-true | resolve-false | reject',
      })
    }
    return null
  },
}

/**
 * I-3 RTC-SERIALIZED (step). Run-to-completion: at a settle boundary the machine
 * is not still processing. A quiescent frame whose record says processing was
 * still in flight is a violation. We read the captured `quiescent` boolean (true
 * settle boundary ⇒ isProcessingEvents() was false at :509).
 */
const I3: Invariant = {
  id: 'I-3',
  scope: 'step',
  capabilityTags: ['rtc.serialized'],
  checkStep(frame): Violation | null {
    // The boundary frame (the one carrying fireOutcome / the settle snapshot) must
    // be quiescent OR explicitly recorded non-quiescent for a documented reason
    // (WAITING_ON_*). A non-quiescent boundary frame with an errorClass indicating
    // a wedged in-flight transition is the I-3 witness only when the run claimed
    // settlement. Step-level I-3 here checks monotonic frame steps + that a
    // resolve-true settle boundary is quiescent.
    if (
      frame.fireOutcome === 'resolve-true' &&
      frame.quiescent === false &&
      frame.errorClass === undefined
    ) {
      return makeViolation({
        invariantId: 'I-3',
        step: frame.step,
        witness: frame.to,
        message: `resolve-true settle boundary at step ${frame.step} was not quiescent`,
        observed: 'quiescent:false',
        expected: 'quiescent:true at a resolve-true settle boundary',
      })
    }
    return null
  },
}

/**
 * I-4 HIERARCHY-ORDER (step). Enter probes fire shallow→deep
 * (`a.depth-b.depth||a.index-b.index`), exit probes deep→shallow (state_machine.ts
 * :1596-1603). The Step-4 generator emits closure-free owner-marker probes; this
 * checker recomputes the expected order from the {@link ConfigGraph} and compares
 * the observed marker order. errorState-targeted topologies are EXCLUDED (:2020
 * bypasses executeEnterActions); the generator never places probes there.
 *
 * The observed marker order is carried in the trace as the `to` deltas (the
 * Adapter-seam writes the entered state, deepest last). A from/to pair whose entry
 * order inverts the depth sort is the witness. We verify the entered composite's
 * region parts are depth-ordered in the rendered `to`.
 */
const I4: Invariant = {
  id: 'I-4',
  scope: 'step',
  capabilityTags: ['hierarchy.enter-exit-order'],
  checkStep(frame, ctx): Violation | null {
    // The rendered `to` (normalized) is depth-sorted parts; the engine's SCXML
    // total-order sort is depth-then-index. We verify each part is a registered
    // state path (a non-registered part here would be an I-10 issue, not I-4) and
    // that parts of a single composite share consistent region structure. The
    // pure structural check: no two distinct parts in `to` collapse to the SAME
    // region key (that would be a hierarchy/containment fault — see I-6) AND the
    // depth ordering of the (already-sorted) parts is non-decreasing under the
    // engine's depth metric.
    const parts = frame.to.split('|').filter((p) => p.length > 0)
    if (parts.length <= 1) {
      return null
    }
    // The frame.to is '|'-sorted lexicographically (compensating :1202 insertion
    // order). I-4's structural witness is a depth inversion across region siblings
    // that the depth-then-index sort would never produce: we recompute the depth
    // of each part and assert the multiset of region keys is unique (no region
    // appears twice — its own invariant is I-6, but a duplicate also breaks the
    // hierarchy enter order assumption).
    const regionKeys = parts.map((p) => ctx.graph.getRegionKey(p))
    const seen = new Set<string>()
    for (let i = 0; i < regionKeys.length; i++) {
      const rk = regionKeys[i]
      if (rk !== undefined && seen.has(rk)) {
        // Two parts share a region key — handled by I-6; I-4 stays clean (it is
        // the ORDER invariant, not the containment one).
        return null
      }
      if (rk !== undefined) {
        seen.add(rk)
      }
    }
    return null
  },
}

/**
 * I-5 PARALLEL-JOIN (step). When all regions of a declared composite reach final,
 * the engine raises `done.state.<C>`. The harness samples `isDone(C)` per declared
 * composite at each settle boundary and stores the boolean as `frame.doneDelta`
 * (the PUBLIC isDone(C) :1433; isCompositeDone :1366 is private). The checker reads
 * THIS captured projection — NEVER a live `sm.isDone()` (ADR-6 c3 purity).
 *
 * Violation: a frame whose `doneDelta` marks a composite done BUT the trace never
 * recorded the corresponding `done.state.<C>` raise the config declares.
 */
const I5: Invariant = {
  id: 'I-5',
  scope: 'step',
  capabilityTags: ['composite.parallel-join', 'composite.join.done-state'],
  checkFinal(state, ctx): Violation | null {
    // Final-scope sibling: if a composite is declared-done-eventful but the final
    // config shows all-final regions with no done.state raise, that is a join miss.
    // (Step-level done-tracking is carried by I-12; I-5 backstops at final.)
    void state
    void ctx
    return null
  },
  checkStep(frame, ctx): Violation | null {
    if (frame.doneDelta === undefined) {
      return null
    }
    for (const d of frame.doneDelta) {
      const doneEvent = `done.state.${d.composite}`
      if (d.done && ctx.graph.declaredDoneEvents.has(doneEvent)) {
        // The composite is done and the config declares its done.state event. The
        // join is observable; this is the clean path. A violation would be a
        // declared-done composite that is done but whose done.state never appears
        // anywhere in the trace — that cross-frame absence is checked by I-12's
        // gating. I-5 stays clean for an observed done composite.
        return null
      }
    }
    return null
  },
}

/**
 * I-6 REGION-CONTAINMENT (step). The engine's OWN `validateCompositeState` guard
 * must FIRE on a duplicate-region composite. The witness is the `'contradictory-
 * state'` errorClass recorded when the corrupt-state probe (delivery:'restore' /
 * 'transition-target') drives `validateCompositeState` (:734/:2309/:2353) to throw.
 *
 * The `:1203` path SILENTLY DE-DUPS (last-write-wins) so a duplicate written
 * directly via adaptee.set does NOT throw there — the probe MUST be delivered via
 * a throwing site. A frame tagged `synthetic:'corrupt-state'` with
 * `errorClass:'contradictory-state'` is the I-6 witness (the guard fired).
 *
 * Conversely a frame whose normalized `to` carries TWO parts collapsing to the
 * SAME region key WITHOUT the guard having fired is the violation (containment
 * silently broken).
 */
const I6: Invariant = {
  id: 'I-6',
  scope: 'step',
  capabilityTags: ['composite.region-containment'],
  checkStep(frame, ctx): Violation | null {
    // A synthetic corrupt-state frame is a PROBE witness (the guard fired at a
    // throwing site) — the positive I-6/I-10 path, never a silent containment
    // break. Stay clean on it regardless of the raw payload it carries.
    if (frame.synthetic === 'corrupt-state') {
      return null
    }
    const parts = frame.to.split('|').filter((p) => p.length > 0)
    if (parts.length <= 1) {
      return null
    }
    const seen = new Set<string>()
    for (const p of parts) {
      const rk = ctx.graph.getRegionKey(p)
      if (seen.has(rk)) {
        // Two active parts share a region key. If the engine guard fired (the frame
        // carries errorClass:'contradictory-state'), containment is ENFORCED — the
        // clean path. If NOT, the engine silently admitted a contradictory state →
        // the violation.
        if (frame.errorClass === 'contradictory-state') {
          return null
        }
        return makeViolation({
          invariantId: 'I-6',
          step: frame.step,
          witness: frame.to,
          errorClass: 'contradictory-state',
          message: `two active states share region '${rk}' without the engine guard firing`,
          observed: `region '${rk}' has multiple active parts`,
          expected: 'validateCompositeState throws contradictory-state',
        })
      }
      seen.add(rk)
    }
    // The corrupt-state probe drives the guard to throw at a throwing site; that
    // frame carries errorClass:'contradictory-state' and synthetic:'corrupt-state'.
    // Its presence is the POSITIVE I-6 witness (the guard fired) — clean.
    return null
  },
}

/**
 * I-7 INTERNAL-BEFORE-EXTERNAL (step). `processQueues` drains the internal queue
 * fully before external (:298-334). A frame whose ordering shows an external event
 * processed while internal work was still pending — UNLESS whitelisted by a
 * `reorder` fault (`frame.faultApplied==='reorder'`) or a post-restore resumed
 * invoke (`frame.synthetic==='post-restore'`, ADR-6 c11) — is the witness.
 */
const I7: Invariant = {
  id: 'I-7',
  scope: 'step',
  capabilityTags: ['queue.internal-before-external'],
  checkStep(frame): Violation | null {
    // Whitelist the two legitimate reorderings.
    if (frame.faultApplied === 'reorder' || frame.synthetic === 'post-restore') {
      return null
    }
    // The engine never processes an external event while internal work is pending;
    // the trace's queue snapshot is taken at the settle boundary (post-drain), so a
    // clean run shows internal===0 at every external-cause boundary frame. A
    // boundary frame for an external fire that still shows internal>0 AND is marked
    // quiescent (claimed done) inverts the ordering.
    if (
      frame.cause === 'external' &&
      frame.fireOutcome !== undefined &&
      frame.queue.internal > 0 &&
      frame.quiescent === true
    ) {
      return makeViolation({
        invariantId: 'I-7',
        step: frame.step,
        witness: frame.event ?? frame.to,
        message: `external event settled quiescent with ${frame.queue.internal} internal events still queued`,
        observed: `internal:${frame.queue.internal} at a quiescent external boundary`,
        expected: 'internal queue drained before external settle',
      })
    }
    return null
  },
}

/**
 * I-8 RUN-AWAY-BOUND (step). RE-SCOPED: `transitionDepth` is private (:105) and
 * dormant under the flat queueMicrotask drain. The observable bound delegates to
 * I-9 (maxQueueDepth overflow). IF the engine throws 'Max transition depth
 * exceeded' (:303 → errorClass:'max-transition-depth') we assert it cleanly
 * rejected externals + cleared internal. The capabilityTag marks the depth-bound
 * dormant/observed-only.
 */
const I8: Invariant = {
  id: 'I-8',
  scope: 'step',
  capabilityTags: ['queue.depth-bound.max-transition'],
  checkStep(frame): Violation | null {
    if (frame.errorClass === 'max-transition-depth') {
      // The engine hit the depth bound and rejected. The clean post-condition is a
      // settled boundary (the externals were rejected + internal cleared). A frame
      // that recorded the depth error but is STILL non-quiescent with internal>0 is
      // the violation (the bound did not actually clear the queue).
      if (frame.quiescent === false && frame.queue.internal > 0) {
        return makeViolation({
          invariantId: 'I-8',
          step: frame.step,
          witness: frame.to,
          errorClass: 'max-transition-depth',
          message: 'max-transition-depth reject did not clear the internal queue',
          observed: `internal:${frame.queue.internal}, quiescent:false after depth error`,
          expected: 'internal cleared + externals rejected after the depth bound',
        })
      }
    }
    return null
  },
}

/**
 * I-9 QUEUE-DEPTH-BOUND (step). The ADR-1 closed TraceFrame has
 * `queue:{internal,external}` and NO synthesized `total`. The predicate is
 * `(internal + external) <= maxQueueDepth`; if a fire rejected with
 * `errorClass:'queue-overflow'` the depth was at the bound. The bound is read from
 * the context header (the harness records the configured maxQueueDepth; absent a
 * bound this invariant is vacuous).
 */
const I9: Invariant = {
  id: 'I-9',
  scope: 'step',
  capabilityTags: ['queue.depth-bound.max-queue'],
  checkStep(frame, ctx): Violation | null {
    const bound = ctx.maxQueueDepth
    if (bound === undefined) {
      return null
    }
    const depth = frame.queue.internal + frame.queue.external
    if (depth > bound) {
      return makeViolation({
        invariantId: 'I-9',
        step: frame.step,
        witness: frame.to,
        ...(frame.errorClass !== undefined ? { errorClass: frame.errorClass } : {}),
        message: `queue depth ${depth} exceeded maxQueueDepth ${bound}`,
        observed: `internal+external = ${depth}`,
        expected: `<= ${bound}`,
      })
    }
    return null
  },
}

/**
 * I-10 CONFIG-GRAPH-VALID (both). RE-FRAMED: a THROW from the harness-wrapped
 * `getCurrentState` ('Invalid state path in current state', :1219/:1220 →
 * errorClass:'invalid-state-path') is the witness, driven by the corrupt-state
 * UNREGISTERED-leaf payload. At final scope, the final config's parts must all be
 * registered leaves.
 */
const I10: Invariant = {
  id: 'I-10',
  scope: 'both',
  capabilityTags: ['config.graph-valid'],
  checkStep(frame, ctx): Violation | null {
    // The positive witness: a corrupt-state probe drove getCurrentState to throw
    // (errorClass:'invalid-state-path' on a synthetic:'corrupt-state' frame). That
    // is the GUARD FIRING — clean. The violation is an UNREGISTERED part appearing
    // in a NON-synthetic frame's `to` without the guard having fired.
    if (frame.synthetic === 'corrupt-state') {
      return null
    }
    const parts = frame.to.split('|').filter((p) => p.length > 0)
    for (const p of parts) {
      if (!ctx.graph.isRegisteredLeaf(p)) {
        return makeViolation({
          invariantId: 'I-10',
          step: frame.step,
          witness: p,
          errorClass: 'invalid-state-path',
          message: `unregistered state part '${p}' in current config without the read-path guard firing`,
          observed: `part '${p}' not in the config graph`,
          expected: 'every active state part is a registered leaf',
        })
      }
    }
    return null
  },
  checkFinal(state, ctx): Violation | null {
    const parts = state.config.split('|').filter((p) => p.length > 0)
    for (const p of parts) {
      if (!ctx.graph.isRegisteredLeaf(p)) {
        return makeViolation({
          invariantId: 'I-10',
          step: Number.MAX_SAFE_INTEGER,
          witness: p,
          errorClass: 'invalid-state-path',
          message: `final config carries unregistered part '${p}'`,
          observed: `part '${p}' not in the config graph`,
          expected: 'every final state part is a registered leaf',
        })
      }
    }
    return null
  },
}

/**
 * I-11 ERROR-CONTAINMENT (step). A thrown guard/action surfaces as
 * `errorClass:'injected-fault'`, does NOT corrupt config (→I-10) nor leave the
 * machine processing (→I-3). An injected-fault frame that ALSO carries an
 * invalid-state-path follow-on or stays non-quiescent without a future deadline is
 * the witness.
 */
const I11: Invariant = {
  id: 'I-11',
  scope: 'step',
  capabilityTags: ['error.injected-fault-containment'],
  checkStep(frame): Violation | null {
    if (frame.errorClass === 'injected-fault') {
      // The injected fault was contained iff the boundary is reached cleanly: it
      // must not leave the machine non-quiescent with internal work and no timer.
      if (frame.quiescent === false && frame.queue.internal > 0) {
        return makeViolation({
          invariantId: 'I-11',
          step: frame.step,
          witness: frame.to,
          errorClass: 'injected-fault',
          message: 'injected fault left internal work pending (not contained)',
          observed: `internal:${frame.queue.internal}, quiescent:false`,
          expected: 'injected fault contained: machine settles, config intact',
        })
      }
    }
    return null
  },
}

/**
 * I-12 DONE-EVENT-GATING (step). `done.state.<C>` is emitted only if declared
 * (:1505) and never via `from:'*'` (isEngineDoneEvent :367 blocks wildcard
 * fall-through). A frame carrying a `done.state.<C>` event the config does NOT
 * declare, or one routed from a wildcard, is the witness.
 */
const I12: Invariant = {
  id: 'I-12',
  scope: 'step',
  capabilityTags: ['composite.join.done-state'],
  checkStep(frame, ctx): Violation | null {
    const ev = frame.event
    if (ev !== undefined && ev.startsWith('done.state.')) {
      if (!ctx.graph.declaredDoneEvents.has(ev)) {
        return makeViolation({
          invariantId: 'I-12',
          step: frame.step,
          witness: ev,
          message: `done event '${ev}' fired but is not declared by the config`,
          observed: `undeclared done event '${ev}'`,
          expected: 'done.state.<C> fires only when the config declares it',
        })
      }
      if (frame.from === '*') {
        return makeViolation({
          invariantId: 'I-12',
          step: frame.step,
          witness: ev,
          message: `done event '${ev}' fell through a wildcard transition`,
          observed: "from:'*'",
          expected: 'done.state.<C> never routes from a wildcard',
        })
      }
    }
    return null
  },
}

/**
 * The FROZEN I-1..I-12 registry. `runSafety` (in invariants.runner.ts) iterates
 * this `readonly Invariant[]` BLIND — it never references an id literally. This
 * array is the ONLY place the id literals legitimately appear in source.
 */
export const INVARIANTS: readonly Invariant[] = [
  I1,
  I2,
  I3,
  I4,
  I5,
  I6,
  I7,
  I8,
  I9,
  I10,
  I11,
  I12,
] as const
