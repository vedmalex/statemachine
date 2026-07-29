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
 * engine's is PRIVATE in state_machine.ts, never called). Outcomes come from the
 * `fireEvent` Promise + the Step-2 Adapter-seam deltas captured in the trace,
 * NEVER from `IMonitor`. Post-W4 `recordTransition` carries a `success` FLAG
 * (`true` commit / `false` refusal), but it still runs AFTER the write and is not
 * a determinism signal — the Adapter-seam deltas remain the sole outcome source.
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

/**
 * W8/V3a — ONE retained record of the engine's PUBLIC lifecycle observability
 * channel (`IMonitor.recordLifecycle`, types.ts `LifecycleEvent`), as the harness
 * projects it into the SAFETY plane.
 *
 * This is deliberately a LOCAL STRUCTURAL restatement, not an import of the
 * engine's `LifecycleEvent`: the SAFETY plane owns its own closed observation
 * vocabulary (the same reason {@link ConfigGraph} REPLICATES `getRegionKey` and
 * `TraceFrame` restates `FaultKind`). Any `LifecycleEvent` is structurally
 * assignable to it, so the projection cannot silently drift.
 *
 * Reading these records is NOT a live engine read (ADR-6 c3): they are CAPTURED
 * observations recorded by the monitor seam during the drain, exactly like the
 * `doneDelta` projection — the checker never calls the machine.
 *
 * ## Field caveats a checker MUST honor
 * - `state` is a full dot-path ONLY for `kind:'enter'|'exit'|'invoke'`. For
 *   `kind:'guard'` it is the transition's `from` SELECTOR, which may be `'*'`,
 *   `'p.*'` or a multi-source `'a|b'` list — NEVER dot-parse it.
 * - `microstep === 0` is the RESERVED "no microstep" id shared by construction,
 *   `reset` and `resumeTimers`. Records from those three UNRELATED paths are
 *   therefore indistinguishable, so a per-microstep window keyed on `0` would
 *   conflate them.
 * - `owner` is a REFERENCE-identity discriminator (one machine can drive many
 *   objects). Never serialize it; never compare it structurally.
 * - `kind:'raise'` is an INSTANTANEOUS point record (an adjacent `begin`+`end`
 *   pair, the `invoke.abort` precedent), NOT a callback bracket. Its `event` is the
 *   RAISED event name and is always present; its `state` is the raise ORIGIN (the
 *   composite for `raise.done`, the invoke-owning leaf otherwise). Its `microstep`
 *   is the arming id for the `raise.invoke.*` hooks and the CURRENT id for
 *   `raise.done` (see types.ts RAISE ASYMMETRY) — never the step in which the
 *   raised event is later PROCESSED.
 */
export interface LifecycleObservation {
  readonly kind: 'enter' | 'exit' | 'invoke' | 'guard' | 'raise'
  readonly hook: string
  readonly state: string
  readonly owner: object
  readonly microstep: number
  readonly seq: number
  readonly edge: 'begin' | 'end'
  readonly event?: string
  readonly failed?: boolean
  readonly transition?: string
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
  /**
   * W8/V3a — the CAPTURED lifecycle observation stream of this run, in engine
   * `seq` order (the harness monitor's live view). Absent when the run wired no
   * lifecycle sink, which makes every lifecycle-keyed oracle VACUOUS rather than
   * failing — a missing observation plane must never manufacture a violation.
   *
   * It lives on the CONTEXT, not on {@link TraceFrame}, for two reasons: the
   * callback timeline is a per-MICROSTEP structure with no 1:1 frame mapping, and
   * putting it on a frame would drag a non-deterministic `owner` object reference
   * into the content hash.
   *
   * Carries the CALLBACK TIMELINE only — `kind:'raise'` records live on their own
   * stream ({@link raises}) with their own cap and truncation flag.
   */
  readonly lifecycle?: readonly LifecycleObservation[]
  /**
   * W9/Г1 — the CAPTURED `kind:'raise'` stream of this run, in engine `seq` order
   * (every record has `kind === 'raise'`). This is the ENGINE-side proof that an
   * internal event was actually raised — the signal that lets the I-5 join oracle
   * COUNT raises instead of re-implementing the engine's selection semantics.
   *
   * ABSENT when the run wired no lifecycle sink ⇒ every raise-keyed oracle is
   * VACUOUS (the I-4 convention: a missing observation plane must never manufacture
   * a violation).
   */
  readonly raises?: readonly LifecycleObservation[]
  /**
   * W9/Г1 — true iff the raise buffer hit its cap and STOPPED retaining records.
   * A counting oracle MUST treat this as VACUOUS: a truncated stream under-counts
   * raises, and an under-count in a `edges > raises` predicate is exactly a FALSE
   * POSITIVE on a correct machine.
   */
  readonly raisesTruncated?: boolean
  /**
   * The trace frames the sweep is running over, supplied by the RUNNER (which
   * already holds the trace) so a `checkFinal` predicate can be a function of the
   * whole frame sequence and not just the terminal {@link FinalState}.
   *
   * This does NOT weaken checker purity: they are the SAME captured frames a
   * `checkStep` checker already receives one at a time — no live engine read is
   * added. It exists because some sound predicates are inherently SEQUENCE-shaped
   * (I-5 counts `false → true` transitions of the `doneDelta` projection across
   * ADJACENT boundary frames), and a per-frame hook cannot see its predecessor.
   */
  readonly frames?: readonly TraceFrame[]
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
    // Two DOCUMENTED, legitimate non-quiescence waits are EXCLUDED (not RTC breaks):
    //  - WAITING_ON_TIMER (C1): the fired region observably completed
    //    (`hasPendingWork()===false`); only a sibling's future timer remains.
    //  - WAITING_ON_TRANSITION_TIMEOUT (U1 precision): settle.ts now assigns this
    //    ONLY when `inFlightAsyncCount() > 0` — a GENUINE awaited async action racing
    //    a future deadline (liveness' jurisdiction), not a wedged flag. Before U1 it
    //    fired on ANY pending work + a timer, so excluding it risked a false-negative;
    //    now the inFlight>0 guarantee makes the exclusion SOUND.
    //  - BOTH BUDGET REASONS — `budget-progressing` AND `microtask-budget`. A budget
    //    exhaustion is a TRUNCATED observation, and a truncated observation cannot
    //    convict. The frozen `maxTurns`-turn prefix left by an `onEnter` hook that
    //    finishes at turn 2000 is byte-identical to the prefix left by a hook that
    //    never finishes: enter/exit hooks are deliberately NOT counted in
    //    `inFlightAsyncCount` (driver.ts), so while one runs all three fingerprint
    //    components are frozen with no timer armed. `microtask-budget` used to be an
    //    I-3 witness and convicted exactly such a CORRECT machine — reproduced with
    //    `s0 -E-> h1 -(invoke delay:0)-> slow`, `slow.onEnter = async () => { for
    //    (let i=0;i<1000;i++) await Promise.resolve() }`, which reaches `slow`
    //    every time yet failed I-3 at N>=1000 and passed at N<=100. The deciding
    //    variable was `DEFAULT_MAX_TURNS`, an internal harness constant — never the
    //    machine. Both reasons are now surfaced as WARNINGS (public.ts) instead.
    // STILL flagged as I-3 witnesses:
    //  - WAITING_ON_INTERNAL (U1): pending queue/processing with NO tracked in-flight
    //    async + a timer — a wedged processing-flag / undrained internal queue. This
    //    is where I-3's teeth now rest, and it is a POSITIVE observation rather than
    //    a truncation: the pump reached it at its EARLY break (exit (b): a stable
    //    fingerprint for QUIET_FLUSH turns WHILE a future timer is armed), inside
    //    budget, so the "nothing is moving" reading is something the harness
    //    observed rather than something it ran out of time to disprove.
    //  - a resolve-true boundary with NO settleReason at all (should have settled).
    // ISS-030 — CLOSED in W8/V8, which is what promoted I-3 into the DEFAULT builtin
    // set (public.ts). The residual was: `bracketAsync` wraps only FUNCTION-VALUED
    // invoke actions at the CONFIG layer, so a STRING-METHOD invoke action — resolved
    // by name INSIDE `callAction`, past that boundary — was untracked, and a machine
    // legitimately awaiting one could surface as WAITING_ON_INTERNAL (an I-3
    // false-positive on a CORRECT machine). The W8/V1b lifecycle channel wraps the
    // CALL rather than the action VALUE, so `invoke.action` begin/end pairs cover the
    // string-method form; driver.ts composes that count into `Env.inFlightAsyncCount`,
    // and such a boundary now classifies as WAITING_ON_TRANSITION_TIMEOUT (excluded)
    // or reaches true quiescence. NOTE the scope: this covers awaited INVOKE actions.
    // Enter/exit hooks are awaited where `isProcessingEvents()` is already true, so
    // the structural conjunct covers them; `invoke.operation` is deliberately NOT
    // counted (its begin/end pair spans a whole long-running `src`).
    // The §4а.2 zero-false-positive corpus carries string-method-invoke and
    // composite-join machines as the standing guard on this promotion.
    const legitimateWait =
      frame.settleReason === 'WAITING_ON_TIMER' ||
      frame.settleReason === 'WAITING_ON_TRANSITION_TIMEOUT' ||
      // Both budget exhaustions: the HARNESS stopped watching. Neither says
      // anything about the machine — see the truncation note above.
      frame.settleReason === 'budget-progressing' ||
      frame.settleReason === 'microtask-budget'
    if (
      frame.fireOutcome === 'resolve-true' &&
      frame.quiescent === false &&
      frame.errorClass === undefined &&
      !legitimateWait
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
 * True iff `descendant` is a STRICT descendant of `ancestor` in the dotted state
 * hierarchy (`'p'` is an ancestor of `'p.r.c'`; `'p'` is NOT an ancestor of
 * `'px'`). The `'.'` in the prefix test is what makes it a segment boundary
 * rather than a string prefix.
 *
 * This is the ANCESTOR RELATION, deliberately NOT a depth NUMBER. A
 * depth-comparison predicate would order two SIBLING branches against each other
 * (`a.r1.leaf` vs `a.r2` differ in depth but neither contains the other), and the
 * W3C order the engine implements only constrains ancestor/descendant pairs —
 * sibling order is document order and is free to interleave. Comparing depths
 * would therefore FALSE-POSITIVE on a legitimate parallel-region entry.
 */
function isStrictDescendant(descendant: string, ancestor: string): boolean {
  return descendant.length > ancestor.length + 1 && descendant.startsWith(`${ancestor}.`)
}

/**
 * I-4 HIERARCHY-ORDER (final, lifecycle-keyed). W8/V11 aligned the engine's
 * callback order to W3C: entry runs in DOCUMENT ORDER (DFS preorder, ancestor
 * before descendant) and exit in REVERSE document order (descendant before
 * ancestor). W8/V1 made that order OBSERVABLE for the first time through the
 * public `IMonitor.recordLifecycle` channel, so I-4 is no longer a no-op backstop:
 * it now checks the real callback timeline the engine emitted.
 *
 * ## Predicate (per MICROSTEP window, per owner)
 * - enter: there is NO pair `enter(s1)` before `enter(s2)` where s1 is a
 *   DESCENDANT of s2 (a child must never be entered before its parent).
 * - exit:  there is NO pair `exit(s1)` before `exit(s2)` where s1 is an ANCESTOR
 *   of s2 (a parent must never exit before its child).
 *
 * Relation is the dot-prefix ANCESTOR relation, never a depth number — see
 * {@link isStrictDescendant} for why depth comparison is unsound here.
 *
 * ## Why this is SOUND (no false positive is reachable)
 * - Only `edge:'begin'` records define the order. The engine awaits each hook
 *   sequentially (`executeEnterActions` / `executeExitActions` loop over states,
 *   and over the three hook slots inside a state), so `begin` order IS invocation
 *   order.
 * - A state with NO hook emits NO record. The observed sequence is therefore a
 *   SUBSEQUENCE of the real one — and a subsequence of a correctly-ordered
 *   sequence still satisfies the predicate, so a hook-less state can never
 *   manufacture an inversion.
 * - `kind:'guard'` is EXCLUDED: its `state` is the transition's `from` SELECTOR
 *   (`'*'` / `'p.*'` / `'a|b'`), not a path — dot-parsing it would compare
 *   selectors against paths and invent ancestry.
 * - `kind:'invoke'` is EXCLUDED: an invoke is not an entry/exit hook at all, and
 *   its `microstep` is the ARMING step (types.ts INVOKE ASYMMETRY), so it would
 *   land in the wrong window.
 * - `microstep === 0` is EXCLUDED: it is the RESERVED id shared by construction,
 *   `reset` and `resumeTimers`. Those are three UNRELATED entry passes; merging
 *   them into one window would compare a construction entry against a later
 *   `resumeTimers` entry and report a phantom inversion. Their ordering is covered
 *   by the engine's own conformance tests, which observe each pass in isolation.
 * - An ABORTED microstep (a throw before the point of no return) HAS emitted enter
 *   records for a configuration that was never committed — but those records were
 *   still emitted in hook order, so the predicate holds on them too. No exclusion
 *   is needed and none is made.
 * - Windows are split by (`microstep`, `owner`): a machine driving several owners
 *   interleaves their timelines, and comparing across owners would compare two
 *   independent hierarchies.
 *
 * A run that wired no lifecycle sink leaves `ctx.lifecycle` absent and I-4 is
 * VACUOUS — a missing observation plane never fabricates a violation.
 */
const I4: Invariant = {
  id: 'I-4',
  scope: 'final',
  capabilityTags: ['hierarchy.enter-exit-order'],
  checkFinal(_state, ctx): Violation | null {
    const stream = ctx.lifecycle
    if (stream === undefined || stream.length === 0) {
      return null
    }
    // ONE linear pass over the seq-ordered stream, carrying the current
    // (microstep, owner) window. Enter/exit hooks run INSIDE their microstep and
    // microsteps are run-to-completion serialized, so the relevant records arrive
    // window-contiguous. If they ever did not, the window would merely SPLIT — a
    // conservative outcome that can drop a comparison but never invent one.
    let windowKind: 'enter' | 'exit' | null = null
    let windowStep = -1
    let windowOwner: object | null = null
    /** `state` paths seen so far in the current window, in begin order. */
    let seen: string[] = []

    const inversionIn = (kind: 'enter' | 'exit', earlier: string, later: string): boolean =>
      kind === 'enter'
        ? // a DESCENDANT was entered before its ANCESTOR
          isStrictDescendant(earlier, later)
        : // an ANCESTOR exited before its DESCENDANT
          isStrictDescendant(later, earlier)

    for (const rec of stream) {
      if (rec.edge !== 'begin') {
        continue
      }
      if (rec.kind !== 'enter' && rec.kind !== 'exit') {
        continue // guard selectors + invoke arming steps are not orderable here
      }
      if (rec.microstep === 0) {
        continue // reserved construction / reset / resumeTimers id
      }
      if (rec.kind !== windowKind || rec.microstep !== windowStep || rec.owner !== windowOwner) {
        windowKind = rec.kind
        windowStep = rec.microstep
        windowOwner = rec.owner
        seen = []
      }
      for (const earlier of seen) {
        if (inversionIn(rec.kind, earlier, rec.state)) {
          const order = rec.kind === 'enter' ? 'ancestor before descendant' : 'descendant before ancestor'
          return makeViolation({
            invariantId: 'I-4',
            // A lifecycle window has no TRACE step (the callback timeline is a
            // per-microstep structure with no 1:1 frame mapping), so the final-scope
            // sentinel is used and the microstep is carried in the witness/message.
            step: Number.MAX_SAFE_INTEGER,
            witness: `${rec.kind}@${rec.microstep}:${earlier}>${rec.state}`,
            message: `${rec.kind} hooks ran out of hierarchy order in microstep ${rec.microstep}: '${earlier}' before '${rec.state}'`,
            observed: `${rec.kind}('${earlier}') preceded ${rec.kind}('${rec.state}')`,
            expected: `${rec.kind} runs ${order}`,
          })
        }
      }
      seen.push(rec.state)
    }
    return null
  },
}

/**
 * I-5 PARALLEL-JOIN (final, COUNTING). When all regions of a declared composite
 * reach final, the engine MUST raise `done.state.<C>` — otherwise a consumer's
 * completion handler silently never runs.
 *
 * ## The two halves of the observation
 * - "it SHOULD have been raised": the harness samples `isDone(C)` per declared
 *   composite at each settle boundary and stores the boolean as `frame.doneDelta`
 *   (the PUBLIC isDone(C); `isCompositeDone` is private). ENTERING the done
 *   configuration is a `false → true` EDGE of that projection.
 * - "it WAS raised": the engine's `kind:'raise'` lifecycle records
 *   ({@link CheckerContext.raises}) — W9/Г1 made the internal raise OBSERVABLE.
 *
 * Both halves are CAPTURED projections read from the context; the checker makes no
 * live engine read (ADR-6 c3 purity).
 *
 * ## Predicate (per declared composite C)
 * ```
 * edges(C)  = # of ADJACENT boundary-frame pairs (prev,cur) with
 *             prev.doneDelta[C] === false && cur.doneDelta[C] === true
 * raises(C) = # of raise records with edge:'begin' and event === 'done.state.'+C
 * VIOLATION ⇔ edges(C) > raises(C)
 * ```
 *
 * ## Why `>` and not a per-edge match — the ONLY sound direction
 * The two sides are counted at DIFFERENT GRANULARITIES, deliberately. The engine
 * checks the done edge per MICROSTEP; the harness samples `doneDelta` per settle
 * BOUNDARY (macrostep). Inside one macrostep a composite's configuration may blink
 * done → undone → done: the engine correctly raises TWICE, while the boundary diff
 * sees ONE edge. Every granularity mismatch therefore pushes in the SAME direction,
 * `raises >= edges`, so it can only make the predicate MORE permissive. A DEFICIT
 * (`edges > raises`) has no such explanation: it means the run entered a declared
 * composite's done configuration more times than the engine raised its event.
 *
 * Note what this does NOT do: it never asks "was a transition for `done.state.<C>`
 * ENABLED here?". That question is the fabricated-oracle trap this invariant
 * already fell into once (the shipped W5b false positive) — answering it means
 * REPLICATING selection semantics (wildcard/ancestor `from` selectors, `'a|b'`
 * lists, LCA conflict resolution, documentIndex priority), and every divergence
 * from the engine would be a false positive on a CORRECT machine. Counting needs
 * none of it: a raise that matched no candidate transition is still a RAISE, and it
 * is now recorded as one.
 *
 * ## The false-positive surfaces this predicate must (and does) avoid
 * - EDGE-TRIGGERED join: a composite that STAYS all-final is not re-raised. Only
 *   `false → true` counts, so a plateau creates no expectation.
 * - `restoreState` deliberately does NOT re-fire the join (persistence.test.ts), so
 *   any step carrying a `synthetic:'post-restore'` frame is excluded wholesale.
 * - A composite already all-final AT START: boundary index 0 has no predecessor, so
 *   the init edge is never counted (an initial done configuration DOES raise, which
 *   would only add to `raises` — the exclusion stays on the safe side either way).
 * - The corrupt-state probe writes an all-final configuration DIRECTLY through the
 *   adapter seam, bypassing `checkCompletion` entirely — `synthetic:'corrupt-state'`
 *   steps are excluded on the same rule.
 * - An UNDECLARED `done.state.<C>` is never raised by the engine (it gates on
 *   `events.has`), so the predicate keys ONLY on `graph.declaredDoneEvents`.
 * - A TRUNCATED raise buffer under-counts raises ⇒ VACUOUS.
 * - No lifecycle plane at all (`ctx.raises === undefined`) ⇒ VACUOUS (the I-4
 *   convention: a missing observation plane never manufactures a violation).
 *
 * ## CLOSED RESIDUAL — the errorState fallback (fixed in the ENGINE, W9)
 * This block used to document an OPEN residual: the `errorState` zombie-state
 * recovery committed its error configuration directly (state_machine.ts, the
 * `kind:'error-state'` branch) WITHOUT running `checkCompletion`, so an all-final
 * recovery configuration would show a boundary edge the engine never signalled and
 * this predicate could fire on a machine behaving as the engine specified.
 *
 * That is no longer true. The recovery path now calls
 * `this.checkCompletion(obj, currentState, errorConfig)`
 * from the `kind:'error-state'` branch of `state_machine.ts` (~:4651), pinned by
 * `src/tests/error_state_join.test.ts`.
 * Completion is a property of the COMMITTED configuration, not of how it was
 * reached; `checkCompletion` is edge-triggered, so a configuration that was already
 * done is not re-raised, and the recovery is still reported as a recovery
 * (`fired:false`, `recordTransition(false)`). The engine question this note left
 * open — harness tag vs. engine signal — was answered in favour of the ENGINE
 * signalling completion, which is also why the oracle needed no broad exclusion
 * that would have blunted it.
 *
 * The `'errorState-fallback'` synthetic tag remains in the exclusion set below and
 * still has no producer; it is now HISTORICAL — reserved rather than load-bearing.
 * Its exclusion is harmless (a tag nothing emits excludes nothing) and is kept so
 * the exclusion exists before any future harness that does emit it.
 *
 * `doneDelta` is deliberately KEPT rather than replaced by the raise stream: the
 * predicate is a CONJUNCTION of two independent halves (the raise proves "it
 * happened", `doneDelta` proves "it had to happen"), and `doneDelta` also feeds the
 * liveness `terminal` derivation.
 *
 * The CONVERSE direction ("a done event fired that was not declared / fell through
 * a wildcard") is enforced separately, with its own teeth, by I-12.
 */
const I5: Invariant = {
  id: 'I-5',
  scope: 'final',
  capabilityTags: ['composite.parallel-join', 'composite.join.done-state'],
  checkFinal(_state, ctx): Violation | null {
    const raises = ctx.raises
    // VACUITY, in the two shapes that both mean "the raise plane cannot be
    // counted": no plane wired at all, and a plane that stopped retaining records.
    if (raises === undefined || ctx.raisesTruncated === true) {
      return null
    }
    const frames = ctx.frames
    if (frames === undefined || frames.length === 0) {
      return null
    }
    const declared = ctx.graph.declaredDoneEvents
    if (declared.size === 0) {
      return null
    }

    // Steps carrying ANY harness-synthetic frame are excluded WHOLESALE:
    // 'post-restore' (the engine deliberately does not re-fire the join),
    // 'corrupt-state' (the probe writes the configuration past checkCompletion)
    // and 'errorState-fallback' — HISTORICAL: the recovery path DOES run
    // checkCompletion now (the `kind:'error-state'` branch of state_machine.ts,
    // ~:4651, W9), so this tag no longer names
    // a real gap; it has no producer and is kept only so the exclusion exists
    // before any future harness that emits it (see the CLOSED RESIDUAL note above).
    // The first two produce a done configuration the engine was never asked to signal.
    const syntheticSteps = new Set<number>()
    for (const f of frames) {
      if (f.synthetic !== undefined) {
        syntheticSteps.add(f.step)
      }
    }

    // BOUNDARY frames are exactly the ones carrying the doneDelta projection (the
    // driver stamps it at the settle boundary of each step).
    const boundaries = frames.filter(
      (f) => f.doneDelta !== undefined && f.doneDelta.length > 0,
    )
    if (boundaries.length < 2) {
      return null // no adjacent pair ⇒ no edge is observable
    }

    const edges = new Map<string, number>()
    for (let i = 1; i < boundaries.length; i++) {
      const prev = boundaries[i - 1]
      const cur = boundaries[i]
      if (prev === undefined || cur === undefined) {
        continue
      }
      if (syntheticSteps.has(cur.step)) {
        continue
      }
      const prevDone = new Map<string, boolean>()
      for (const d of prev.doneDelta ?? []) {
        prevDone.set(d.composite, d.done)
      }
      for (const d of cur.doneDelta ?? []) {
        // Strict `false → true`: an ABSENT predecessor entry is NOT an edge (the
        // composite was not sampled, so "it was not done" is not established).
        if (d.done && prevDone.get(d.composite) === false) {
          edges.set(d.composite, (edges.get(d.composite) ?? 0) + 1)
        }
      }
    }
    if (edges.size === 0) {
      return null
    }

    // One `begin` per raise (the pair is adjacent begin+end); counting `end` too
    // would double every raise and make the predicate unfirable.
    const raised = new Map<string, number>()
    for (const r of raises) {
      if (r.kind !== 'raise' || r.edge !== 'begin' || r.event === undefined) {
        continue
      }
      raised.set(r.event, (raised.get(r.event) ?? 0) + 1)
    }

    // Sorted so the reported witness is a deterministic function of the run and not
    // of Map insertion order (the fingerprint is the shrinker's equality key).
    for (const composite of Array.from(edges.keys()).sort()) {
      const doneEvent = `done.state.${composite}`
      if (!declared.has(doneEvent)) {
        continue
      }
      const expectedCount = edges.get(composite) ?? 0
      const actualCount = raised.get(doneEvent) ?? 0
      if (expectedCount > actualCount) {
        return makeViolation({
          invariantId: 'I-5',
          // A counting predicate spans the whole trace and has no single guilty
          // frame, so it uses the final-scope sentinel (the I-4 convention) and
          // carries the composite in the witness.
          step: Number.MAX_SAFE_INTEGER,
          witness: composite,
          message: `composite '${composite}' entered its all-final configuration ${expectedCount} time(s) but '${doneEvent}' was raised only ${actualCount} time(s) — a declared completion event was NOT raised, so a consumer's completion handler silently never runs`,
          observed: `${actualCount} raise(s) of '${doneEvent}'`,
          expected: `at least ${expectedCount} raise(s) of '${doneEvent}'`,
        })
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
    // A3 SOUNDNESS: the engine gates `maxQueueDepth` at EXTERNAL enqueue only
    // (state_machine.ts:611/:684) — an internal `raiseEvent` is NOT gated, so the
    // internal queue may TRANSIENTLY exceed the bound MID-drain and legitimately
    // drain back below it. The combined bound is a REST invariant: only a
    // QUIESCENT boundary that still shows depth > bound is a real breach (the
    // engine came to rest over its own limit). Checking non-quiescent frames would
    // FALSE-POSITIVE on ordinary internal backpressure. (Transient over-bound is
    // therefore NOT observable here — the enforcement oracle for that is the
    // `errorClass:'queue-overflow'` reject classification, not I-9.)
    if (frame.quiescent !== true) {
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
