export type StateName = string
export type EventName = string
export type EventAction<T, R = void> = (adaptee: T, ...args: unknown[]) => R
export type ErrorHandler<T> = EventAction<T, void>

// Helper type to extract only methods from a type T
export type MethodsOf<T> = {
  [K in keyof T as T[K] extends (...args: any[]) => any ? K : never]: T[K]
}

// Helper type to extract only properties (non-functions) from a type T
export type PropertiesOf<T> = {
  [K in keyof T as T[K] extends (...args: any[]) => any ? never : K]: T[K]
}

export type KeysOf<T, R> = {
  [K in keyof T]: T[K] extends R ? K : never
}[keyof T]

export type ErrorContext = {
  state?: StateName
  event?: EventName
  action?: string
  transition?: string
  phase?: 'guard' | 'action' | 'transition' | 'enter' | 'exit'
  /**
   * Composite per-slot function-registry path (`<stateName>.<hook>`) implicated
   * in a restore failure (W0.2 C1). Present only on registry-resolution errors.
   */
  slot?: string
}

export class StateMachineError extends Error {
  readonly context: ErrorContext

  constructor(message: string, context: ErrorContext, cause?: Error) {
    super(message)
    this.name = 'StateMachineError'
    this.context = context
    this.cause = cause
    /* c8 ignore next 3 */
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, StateMachineError)
    }
  }

  override toString(): string {
    const { state, event, action, transition, phase } = this.context
    const details = []
    if (state) details.push(`state: ${state}`)
    if (event) details.push(`event: ${event}`)
    if (action) details.push(`action: ${action}`)
    if (transition) details.push(`transition: ${transition}`)
    if (phase) details.push(`phase: ${phase}`)

    return `${this.name}: ${this.message}${details.length ? ` (${details.join(', ')})` : ''}`
  }
}

// ✅ НОВОЕ: Абстракция логгера
export interface ILogger {
  debug(message: string, context?: any): void
  info(message: string, context?: any): void
  warn(message: string, context?: any, error?: Error): void
  error(message: string, context?: any, error?: Error): void
}

// === WASM-friendly injection contracts (per TD-T4-2a, TD-T4-2, TD-T4-2b) ===

/** @unstable — timer scheduling injection contract; consumed by StateMachine. */
export interface ITimerScheduler {
  isActive(): boolean
  schedule(delay: number, callback: () => void): object
  cancel(token: object): void
  /**
   * Optional manual drain — advance virtual time and fire all timers whose
   * `executeAt <= now` (default `now` is the scheduler's own clock). Real-time
   * schedulers driven by setInterval may leave this unimplemented.
   */
  process?(now?: number): void
}

/** @unstable — transition observability context (additive on IMonitor). */
export interface TransitionContext {
  fromState: string
  toState: string
  eventName?: string
}

/** @unstable — minimal aggregate observability snapshot for tests. */
export interface MonitorMetricsSnapshot {
  totalTransitions: number
  successCount: number
  errorCount: number
  averageDuration: number
  /**
   * W4.1 #1 — штатные ОТКАЗЫ перехода (guard-rejected / abort / errorState),
   * counted SEPARATELY from `errorCount` (genuine errors). Optional (additive).
   */
  failedTransitions?: number
}

/**
 * @unstable — W8/V1 public LIFECYCLE OBSERVABILITY record: one `begin` or `end`
 * edge of ONE engine-invoked callback (state enter/exit hook, invoke action /
 * operation, transition guard).
 *
 * ## Why it exists
 * The ORDER and the FACT of enter/exit callback invocation were not observable
 * from outside the machine at all: a consumer could not answer "why was my
 * `onExit` never called?", "in which order did the regions enter?", or "which
 * callback is hung?". This channel makes the drain's callback timeline a
 * first-class, subscribable stream.
 *
 * ## Delivery contract
 * Delivery is SYNCHRONOUS, inside the drain, on {@link IMonitor.recordLifecycle}.
 * There is deliberately NO `ts` / `durationMs` field: the subscriber stamps its
 * own clock (and a simulation plane, where `Date.now` is forbidden, stamps a
 * virtual one), so the record itself stays fully deterministic.
 *
 * Every dispatch is wrapped in a SINK GUARD: a `recordLifecycle` implementation
 * that throws can NEVER break the drain. The guard swallows sink failures only —
 * it never swallows the callback's own error, which continues to route through
 * `onError` / `monitor.recordError` byte-for-byte unchanged.
 *
 * ## Pairing
 * A callback that STARTS emits `edge:'begin'`; when that same callback SETTLES it
 * emits `edge:'end'`. A `begin` with no matching `end` therefore means the
 * callback never settled — a HUNG callback (that is the intended diagnosis, not a
 * bug in the channel). `failed:true` on an `end` means the callback THREW.
 *
 * The `end` edge is emitted at the settle of the CALLBACK ITSELF — strictly
 * BEFORE the error is routed into `processError` / `onError`. Emitting after
 * error routing would let a hung `onError` masquerade as a hung `onEnter`.
 *
 * `invoke.abort` is the one exception to "begin starts something": an abort is an
 * instantaneous POINT, so it is emitted as an ADJACENT `begin`+`end` pair with no
 * work in between (`edge` has no `'point'` member and the union is kept narrow).
 *
 * ## What this channel does NOT see
 * - the TRANSITION's own callbacks: `onTransition`, the event-level `onBefore` /
 *   `onAfter`. Only STATE hooks, invoke work and guards are instrumented.
 * - the `onError` handler itself (by construction — see the pairing note above).
 * - the `errorState` fallback path emits NO `enter` events: that recovery commits
 *   the error configuration DIRECTLY, bypassing the enter-hook executor. This is
 *   EXPECTED, not an anomaly — a consumer or oracle must NOT read the missing
 *   `enter` records as "the error state was never entered".
 * - `invoke.cond` predicates (evaluated at arm time, outside the callback lane).
 *
 * ## Relationship to the error channel
 * ONE throwing callback produces BOTH a `failed:true` `end` record here AND a
 * separate `monitor.recordError`. They are two views of the SAME failure — a
 * consumer that adds them up will double-count.
 *
 * ## Hierarchy
 * For `kind:'enter'|'exit'|'invoke'`, `state` is the FULL dot-path of the state.
 * Ancestry is recovered by dot-parsing it (`'parent.r1.child'`); `regionKey` /
 * `depth` are deliberately NOT duplicated into the record.
 *
 * EXCEPTION — for `kind:'guard'`, `state` is the transition's `from` SELECTOR,
 * which may be a wildcard (`'*'`, `'p.*'`) or a multi-source list (`'a|b'`) and
 * is therefore NOT always a dot-path. Key guard records by {@link
 * LifecycleEvent.transition}, and dot-parse `state` only after checking `kind`.
 *
 * ## Stability
 * `kind` and `hook` form an EXTENSIBLE union — new members will be added without
 * a major bump. Do NOT write an exhaustive `switch` over them; always keep a
 * default branch.
 */
export interface LifecycleEvent {
  /**
   * Coarse family of the instrumented callback. EXTENSIBLE — never switch
   * exhaustively.
   */
  readonly kind: 'enter' | 'exit' | 'invoke' | 'guard'
  /**
   * Precise callback slot. EXTENSIBLE. Currently one of `'onBeforeEnter'`,
   * `'onEnter'`, `'onAfterEnter'`, `'onBeforeExit'`, `'onExit'`, `'onAfterExit'`,
   * `'invoke.action'`, `'invoke.operation'`, `'invoke.abort'`, `'guard'`.
   */
  readonly hook: string
  /**
   * Full dot-path of the state the callback belongs to (for `kind:'guard'`, the
   * transition's `from` selector). Hierarchy = dot-parsing of this string.
   */
  readonly state: string
  /**
   * The OWNER object this callback ran for, by REFERENCE identity (never
   * serialize it). One machine can drive MANY objects (`attachToObject`), and
   * without this discriminator the traces of two owners interleave into one
   * unreadable stream. For an owner-less internal path this is the machine
   * instance itself, used as a stable sentinel.
   */
  readonly owner: object
  /**
   * Monotonic per-machine id of the microstep this callback belongs to.
   *
   * The boundary MATTERS: enter hooks run BEFORE the point of no return, so an
   * ABORTED microstep (a throw under `abortOnExitError`, a contradictory target,
   * a `transitionTimeout`) has already emitted `enter` records for a state that
   * was never committed. Grouping by `microstep` lets a consumer discard exactly
   * those records.
   *
   * The counter is incremented once per event-driven selection attempt (at the
   * start of the OTS computation, so a guard and the enter/exit hooks it selects
   * share ONE id). Paths that have no microstep at all — initial construction,
   * `reset`, `resumeTimers` — report `0`, a reserved id the counter never
   * produces (it starts at 1).
   *
   * IDs are NOT DENSE: a selection attempt that enables nothing consumes an id
   * and emits no hook records, so gaps in the id sequence are normal. Do not
   * infer "records are missing" from a gap.
   *
   * INVOKE ASYMMETRY: an `invoke` record carries the microstep of the step that
   * ARMED the operation, while its `invoke.abort` carries the microstep of the
   * EXIT step that cancelled it — so an operation's begin and its abort
   * legitimately report DIFFERENT ids. Pair them by `owner` + `state` +
   * adjacency, not by `microstep`.
   */
  readonly microstep: number
  /** Per-machine monotonic record counter; the total order of this stream. */
  readonly seq: number
  /**
   * Which edge of the callback this record is. Named `edge` (NOT `phase`) to
   * avoid colliding with the unrelated {@link ErrorContext.phase}.
   */
  readonly edge: 'begin' | 'end'
  /** Name of the event that drove this microstep, when there is one. */
  readonly event?: string
  /** Present on `edge:'end'`: `true` when the callback THREW / rejected. */
  readonly failed?: boolean
  /**
   * Present on `kind:'guard'`, `edge:'end'`: the predicate's boolean result. A
   * guard that THREW reports `failed:true` and `outcome:false` (the transition
   * stays disabled).
   */
  readonly outcome?: boolean
  /**
   * Present on `kind:'guard'`: the `"<from> -> <to>"` transition label — the SAME
   * vocabulary as {@link ErrorContext.transition}. Required to key guard COVERAGE:
   * two transitions leaving the same source are otherwise indistinguishable by
   * `state` alone.
   */
  readonly transition?: string
}

/**
 * @unstable — observability injection contract.
 * EXPANDED additively in TASK-004 per TD-T4-2: third param of `recordTransition`
 * is parameter-optional; `recordEvent?` and `getMetrics?` are interface-optional.
 * Existing 2-arg call site at state_machine.ts:1665 remains valid.
 */
export interface IMonitor {
  recordTransition(duration: number, success: boolean, context?: TransitionContext): void
  recordError(error: Error, context?: ErrorContext): void
  recordEvent?(eventName: string, duration: number): void
  getMetrics?(): MonitorMetricsSnapshot
  /**
   * @unstable — W8/V1 lifecycle observability sink (OPTIONAL, additive: a monitor
   * that omits it keeps the exact previous contract, and the engine then does NO
   * lifecycle work at all — the channel is near-zero-cost when unsubscribed).
   *
   * Called SYNCHRONOUSLY from inside the drain for each `begin` / `end` edge of an
   * engine-invoked callback. See {@link LifecycleEvent} for the full contract:
   * pairing, the hung-callback signature, `microstep` grouping, multi-owner
   * discrimination, and what the channel deliberately does NOT observe.
   *
   * An implementation that THROWS cannot break the machine — every dispatch is
   * wrapped in a sink guard and the failure is swallowed. Keep it cheap and
   * side-effect-free anyway: it runs on the hot path, inside the run-to-completion
   * drain, and any work done here delays the callbacks it is observing.
   *
   * PRESENCE IS SAMPLED ONCE, at machine construction: the monitor you pass to
   * `StateMachineOptions.monitor` must ALREADY define this method. Attaching it
   * later (e.g. `sm.getMonitor().recordLifecycle = fn`) is a silent no-op — the
   * engine cached "unsubscribed" and skips the channel entirely. Removing it
   * later is safe (the dispatch is optional-chained), it merely wastes the event
   * construction.
   */
  recordLifecycle?(event: LifecycleEvent): void
}

/** @unstable — error-handler injection contract; surfaces methods consumed by host integrations. */
export interface IErrorHandler {
  isEnabled(): boolean
  enable(): void
  disable(): void
  addRecoveryStrategy(strategy: import('./error_handling').ErrorRecoveryStrategy): void
  removeRecoveryStrategy(strategyName: string): void
  getAnalytics(): import('./error_handling').ErrorAnalytics
}

// ✅ НОВОЕ: Опции инъекции для StateMachine
export interface StateMachineOptions {
  logger?: ILogger
  monitor?: IMonitor        // EXISTING; element type evolves additively per TD-T4-2
  scheduler?: ITimerScheduler   // NEW per TD-T4-2a
  errorHandler?: IErrorHandler  // NEW per TD-T4-2b
  /**
   * Clock function returning the current time in milliseconds.
   * Default: `Date.now`. Inject a virtual clock together with a
   * `scheduler` (see `createVirtualScheduler`) for deterministic replay / DST.
   * Used for `stateEntryTimes`, `resumeTimers`, and `getQueuedEvents` age math.
   */
  clock?: () => number
  /**
   * Maximum time (ms) to wait for async entry/exit actions.
   * If exceeded, the transition aborts with an error.
   */
  transitionTimeout?: number
  /**
   * State to transition to if an error occurs during a transition (Zombie State Prevention).
   */
  errorState?: string
  /**
   * If true, aborts the transition if onExit fails, keeping the state machine in the source state.
   */
  abortOnExitError?: boolean
  /**
   * Maximum depth of the event queue before rejecting new events.
   * Default: 1000
   */
  maxQueueDepth?: number
  /**
   * Maximum number of INTERNAL (raised) transitions a single continuous drain
   * may process before the run-away guard trips (`StateMachineError`, reported
   * through the observable monitor/onError channel). Guards against a
   * self-sustaining internal loop (e.g. `done.state` ping-pong) starving the
   * macrotask queue. Raise it to admit a legitimate FINITE cascade longer than
   * the default (e.g. a long auto-advance gated-pipeline). Default: 100.
   *
   * Note: this bounds STARVATION (internal self-loops within one drain), NOT
   * every conceivable non-termination — a timer-driven ping-pong (`invoke`
   * with `delay:0`) yields to the macrotask queue each hop, so it is outside
   * this bound by construction (and does not starve).
   */
  maxTransitionDepth?: number
  /**
   * Named-function registry consulted by `fromJSON` / `fromSecureJSON` to
   * restore serialized function references (guards / actions / onError / …).
   *
   * Security invariant (W0 / defect П1): NO deserialization path turns an
   * attacker-controlled STRING into executable code. Serialized machines store
   * a function's NAME only — never its body — and restoration resolves that
   * name against THIS registry. A serialized function reference whose name is
   * not present here throws {@link StateMachineError}; a body is never compiled.
   *
   * Keys are function identities: either a composite per-slot path
   * (`<stateName>.<hook>` — e.g. `'green.onEnter'`, `'parent.r1.child.onEnter'`,
   * or its `states.`-prefixed form), which is the STABLE identity restoration
   * prefers, OR a bare function `.name` (a slot LABEL shared across slots) used
   * only as a last-resort fallback. Values are the actual functions supplied by
   * the consumer.
   */
  actions?: FunctionRegistry
  /**
   * Strict function-registry resolution (W0.2 C1). When `true`, restoration
   * refuses the ambiguous fallbacks that can silently substitute the wrong
   * function:
   *  - a serialized slot that resolves only by its shared bare `.name` (no
   *    per-slot registry key) THROWS instead of risking a same-named sibling's
   *    function;
   *  - a nameless serialized function reference THROWS instead of restoring to
   *    `undefined` (symmetry with the named unknown-name throw).
   * Default: `false` (fallback with a `warn`).
   */
  strictActions?: boolean
}

/**
 * Consumer-supplied map of function identity name → function, used by
 * `StateMachine.fromJSON` / `fromSecureJSON` to restore serialized function
 * references. See {@link StateMachineOptions.actions}.
 */
export type FunctionRegistry = Record<string, (...args: any[]) => any>

// Simplified and composable StatePaths types for better TypeScript performance
type StringKey = string & {}

// Base type for simple state names (no regions)
export type SimpleStateName<S> = StringKey & keyof S

// Type for region-based state names (parent.region)
export type RegionStateName<S> = {
  [K in keyof S & string]: S[K] extends { regions?: infer R }
  ? R extends Record<string, any>
  ? `${K}.${StringKey & keyof R}`
  : never
  : never
}[keyof S & string]

// Type for nested state names (parent.region.child)
export type NestedStateName<S> = {
  [K in keyof S & string]: S[K] extends { regions?: infer R }
  ? R extends Record<string, any>
  ? {
    [RegKey in keyof R & string]: R[RegKey] extends Record<string, any>
    ? `${K}.${RegKey}.${StringKey & keyof R[RegKey]}`
    : never
  }[keyof R & string]
  : never
  : never
}[keyof S & string]

// H-1 — Recursively enumerate every ADDRESSABLE state path in a states-map `S`.
//
// A path is addressable iff it terminates at a STATE (a leaf OR a composite),
// NEVER at a region container. From a states-map, the addressable paths are:
//   - each state key `K` itself (`p`, `p.r.child`, …); and
//   - when `K` is a composite, `K.<region>.<addressable-within-that-region>`
//     for every region and every path addressable inside its states-map.
// The alternation is state → region → state → region → …, so the LAST segment
// is always a state. Region-container paths (`p.r`, `p.r.child.sub`) — which
// throw INVALID_STATE_PATH at runtime — are excluded at EVERY depth, and the
// recursion admits leaves of ARBITRARY depth (the depth ≥ 4 leaves the previous
// fixed-arity `DeepNestedStateName` wrongly rejected).
export type StatePathsOf<S> = {
  [K in keyof S & string]:
  | K
  | (S[K] extends { regions?: infer R }
    ? R extends Record<string, any>
    ? {
      [RegKey in keyof R & string]: R[RegKey] extends Record<string, any>
      ? `${K}.${RegKey}.${StatePathsOf<R[RegKey]>}`
      : never
    }[keyof R & string]
    : never
    : never)
}[keyof S & string]

// Retained for backward-compatible export (index.ts re-exports it). Now an alias
// of the recursive form so "deeply nested state name" honestly denotes an
// addressable deep LEAF/composite path rather than a region-container path.
export type DeepNestedStateName<S> = StatePathsOf<S>

// Composable StatePaths type — the complete set of addressable state paths.
// Built from the recursive `StatePathsOf` so leaves of any depth are accepted
// and region-container paths are rejected (H-1). `SimpleStateName`/
// `RegionStateName`/`NestedStateName` remain exported for API stability.
export type StatePaths<S> = StatePathsOf<S>

// Config callbacks and setContext-resolved string callbacks run against the
// underlying owner object, not the adapter wrapper.
export type ActionOrString<T extends object, R = void> =
  | KeysOf<T, EventAction<T, R>>
  | EventAction<T, R>
export type ErrorHandlerOrString<T extends object> =
  | KeysOf<T, ErrorHandler<T>>
  | ErrorHandler<T>

// Тип для имени региона
export type RegionName = string
// Конфигурация регионов
export type RegionsConfig<T extends object> = Record<
  RegionName,
  StateMachineConfig<T>['states']
>

export type State<T extends object> = {
  name: StateName
  display?: string
  comment?: string
  iconCls?: string
  onBeforeEnter?: ActionOrString<T>
  onEnter?: ActionOrString<T>
  onAfterEnter?: ActionOrString<T>
  onBeforeExit?: ActionOrString<T>
  onExit?: ActionOrString<T>
  onAfterExit?: ActionOrString<T>
  onError?: ErrorHandlerOrString<T>
  regions?: RegionsConfig<T> // Заменяем `states` на `regions`
  initial?: StateName // Добавляем initial для регионов и иерархических состояний
  history?: 'deep' | 'shallow' // Добавляем свойство для истории состояний
  /**
   * Marks this atomic state as the SCXML/UML `<final>` pseudo-substate of its
   * region. When every region of a composite has its active atomic leaf marked
   * `final`, that composite is "done": the engine raises the `done.state.<id>`
   * event and {@link StateMachine.isDone} returns `true`. Only meaningful on a
   * leaf state (a state without `regions`); set on a composite it is ignored at
   * runtime and flagged by the config validator.
   */
  final?: boolean
  invoke?: StateInvocation<T>[] // Поручения (выполняются при входе в состояние)
}

/**
 * SPEC §6а — the ORIGINAL timer form of an invocation: after `delay` ms (armed
 * on leaf entry, torn down on leaf exit) the engine raises `event` internally.
 * PRESERVED verbatim so existing configs keep working; it is one arm of the
 * {@link StateInvocation} union.
 */
export interface InvokeTimer<T extends object> {
  /** Время задержки в миллисекундах */
  delay: number
  /** Событие, которое будет вызвано после задержки */
  event: EventName
  /** Условие запуска поручения */
  cond?: (adaptee: T) => boolean
  /** Действие, выполняемое перед событием */
  action?: ActionOrString<T>
}

/**
 * SPEC §6а (decision «а») — a LONG-RUNNING invoked operation with cancellation.
 * `src` is started on leaf entry (after `onEnter`) and receives an
 * {@link AbortSignal} that is `abort()`-ed when the leaf is exited (BEFORE its
 * `onExit`, so the exit handler observes `signal.aborted`).
 *
 * - `onDone` — internal event raised on fulfilment; the resolved value is the
 *   event payload.
 * - `onError` — internal event raised on rejection; the error is the payload.
 *   With NO `onError`, a rejection is routed to `monitor.recordError` (the same
 *   observable policy as a throwing guard, F7).
 * - An event produced by an operation that was already cancelled
 *   (`signal.aborted` at settle time) is DROPPED — the leaf has been left.
 */
export interface InvokeOperation<T extends object> {
  /** The operation. Started on entry; receives an AbortSignal cancelled on exit. */
  src: (adaptee: T, signal: AbortSignal, ...args: any[]) => Promise<unknown>
  /** Internal event raised on success; the resolved value is the payload. */
  onDone?: EventName
  /** Internal event raised on failure; the error is the payload. */
  onError?: EventName
  /** Условие запуска операции (checked on entry). */
  cond?: (adaptee: T) => boolean
  /** Optional stable identity for diagnostics / recordError context. */
  id?: string
}

/**
 * SPEC §6а — a state invocation is EITHER the timer form ({@link InvokeTimer})
 * or the long-running operation form ({@link InvokeOperation}). The union is
 * discriminated at runtime by the presence of a `src` function.
 */
export type StateInvocation<T extends object> =
  | InvokeTimer<T>
  | InvokeOperation<T>

/**
 * SPEC §6а (decision «б») — supplemental context passed as the LAST argument to
 * a leaf's `onExit` (in addition to, never replacing, the event payload):
 * `onExit(adaptee, ...eventPayload, exitContext)`. Lets a region/lane tell
 * "I was swept" from "I reached final".
 */
export interface ExitContext {
  /** Name of the event that drove this exit. */
  event: string
  /**
   * `true` — the node was swept from OUTSIDE before its region completed
   * (parallel-exit / abort); `false` — the region reached its final
   * configuration (natural completion).
   *
   * CONVENTION (W3b.1 LOW): `preempted` is judged on COMPLETION, not on WHO
   * fired the transition. A flat, non-`final` leaf that fires its OWN outgoing
   * transition (it is the transition's `source`) is a self-initiated exit yet
   * still reports `preempted: true`, because the leaf had not reached a final
   * configuration — "preempted" here means "left before completing", and a
   * self-initiated exit of a non-final leaf is exactly that. A caller that must
   * distinguish a self-initiated flat exit from an outside sweep should compare
   * the exiting leaf against the fired transition's source itself, rather than
   * read that distinction into `preempted`.
   */
  preempted: boolean
  /** Whether the node being exited was itself `final` at the moment of exit. */
  wasFinal: boolean
  /** The target configuration being entered. */
  target: string
}

// Wildcard `from` forms are a documented (README) and validator-supported (V2)
// feature: `from: '*'` (any state) and `from: 'prefix.*'` (any state under a
// prefix / a parallel region). With a literal `S`, `StatePaths<S>` is a finite
// union that excludes these, so authoring a legit wildcard would be a FALSE type
// error (W2c regression from the V8 literal-key narrowing). Allow them on `from`
// only. `to` additionally permits '*' (the runtime self-transition target), but
// NOT a `prefix.*` set — a transition target must be a concrete state.
export type WildcardFrom = '*' | `${string}.*`

// Использовать для полей from, to в Transition
export type Transition<T extends object, S extends States<T>> = {
  from: StatePaths<S> | WildcardFrom
  to: StatePaths<S> | '*'
  priority?: number
  guard?: ActionOrString<T, boolean>
  /**
   * Action executed during the transition (after leaving `from`, before entering `to`).
   * Receives the current owner context. Use for side-effects scoped to this edge.
   */
  onTransition?: ActionOrString<T>
  onError?: ErrorHandlerOrString<T>
}

export type Event<T extends object, S extends States<T>> = {
  name: EventName
  display?: string
  comment?: string
  transitions: Array<Transition<T, S>>
  onBefore?: ActionOrString<T>
  onAfter?: ActionOrString<T>
  onSuccess?: ActionOrString<T>
  onError?: ErrorHandlerOrString<T>
}

/**
 * SPEC §7 — result of {@link StateMachine.fireEventDetailed}. A discriminated
 * union that, unlike `fireEvent`'s bare `boolean`, NEVER throws and distinguishes
 * the three no-fire causes:
 *  - `no-transition` — no candidate matched the active configuration;
 *  - `guard-rejected` — the ordered candidates' guards all returned falsy;
 *  - `guard-error` — a candidate's guard THREW (now observably distinct from an
 *    honest refusal — closes F4).
 *  - `aborted` — a candidate WAS selected and the microstep BEGAN, but was
 *    cancelled before it committed (onExit threw under `abortOnExitError`, or the
 *    target configuration was contradictory). Observably distinct from
 *    `no-transition` (no candidate at all) so the W5 sim oracle can tell "nothing
 *    to do" from "a started microstep was rolled back".
 *  - `error-state` (W4.1 #3) — the requested transition FAILED (onEnter threw) and
 *    the machine recovered into the configured `errorState`. The target transition
 *    did NOT fire, so `fired` is `false` — consistent with the monitor, which
 *    records this as a failed transition, and with the observable state now sitting
 *    in `errorState`. (The old code returned `fired:true` with the requested
 *    `a→b`, contradicting both other public channels.)
 *
 * `fireEvent` deliberately keeps returning `boolean`: `{ fired: false }` is a
 * truthy object, so any `if (await sm.fireEvent(e))` would silently invert.
 */
export type FireResult =
  | {
      fired: true
      /** Every transition that fired this microstep (single-transition in W3-B). */
      transitions: Array<{ event: string; from: string; to: string }>
    }
  | {
      fired: false
      reason: 'no-transition' | 'guard-rejected' | 'guard-error' | 'aborted' | 'error-state'
      /** Per-candidate rejection detail, present for the guard-* reasons. */
      rejected?: Array<{
        /** `'from -> to'` label of the rejected transition. */
        transition: string
        reason: 'guard-rejected' | 'guard-error'
        error?: Error
      }>
    }

///Record<StateName, Omit<State<T>, 'name'>>
export type States<T extends object> = Record<StateName, Omit<State<T>, 'name'>>
export type Events<T extends object, S extends States<T>> = Record<
  EventName,
  Omit<Event<T, S>, 'name'>
>

export interface Adapter<T extends object> {
  get adaptee(): T
  set(property: keyof T, value: T[keyof T]): void
  get(property: keyof T): T[keyof T]
}

export type ExtractAdaptee<T> = T extends MemoryAdapter<infer R> ? R : T

export function isAdapter<T extends object>(inp: unknown): inp is Adapter<T> {
  return !!inp && typeof inp === 'object' && 'set' in inp && 'get' in inp
}

export interface StateMachineConfig<T extends object = object> {
  name: string
  description?: string
  stateAttribute: KeysOf<PropertiesOf<T>, string>
  // initialState: StateName; // initialState теперь просто StateName, может быть в регионе
  initialState: keyof StateMachineConfig<T>['states']
  events: Record<
    EventName,
    Omit<Event<T, StateMachineConfig<T>['states']>, 'name'>
  >
  states: States<T> // Корневые состояния машины
  // states: Record<StateName, Omit<State<T>, 'name'>>
  onError?: ErrorHandlerOrString<T>
}

/**
 * Author-facing config shape that PRESERVES the literal state keys so that
 * `initialState`, and every transition `from` / `to`, are checked against the
 * ACTUAL declared states rather than degrading to `string`.
 *
 * {@link StateMachineConfig} declares `states: States<T>` where
 * `States<T> = Record<StateName /* = string *\/, …>` — that `Record<string, …>`
 * collapses the state keys to `string`, so `initialState: keyof states` and
 * `from`/`to: StatePaths<states>` become `string` and typos slip through the
 * compiler. `TypedMachineConfig<T, S>` keeps `S` (the exact `states` object)
 * as its own type parameter; the {@link createMachine} factory infers `S` with
 * a `const` type parameter so `S` retains the literal keys, making
 * `StatePaths<S>` a finite union and turning a typo into a compile error.
 *
 * A `TypedMachineConfig<T, S>` is structurally assignable to
 * `StateMachineConfig<T>` (since `S extends States<T>` and
 * `StatePaths<S> ⊆ string`), so it flows into the runtime constructor unchanged.
 */
export interface TypedMachineConfig<T extends object, S extends States<T>> {
  name: string
  description?: string
  stateAttribute: KeysOf<PropertiesOf<T>, string>
  initialState: StatePaths<S>
  events: Record<EventName, Omit<Event<T, S>, 'name'>>
  states: S
  onError?: ErrorHandlerOrString<T>
}

// `Adaptee<T>`, `Configuree<T>`, and `Config<T>` type-utilities were removed in TASK-003 CODE_REVIEW.
// They had zero internal usage and were not exported from the curated public surface (TD-T3-4).
// If a downstream consumer use case emerges, re-introduce as `export type` and add to `src/index.ts`.

// New interface for state persistence
export interface StatePersistenceAdapter {
  save(state?: {
    currentState: string
    history: any
    stateEntryTimes: any
  }): Promise<void>
  restore(): Promise<{
    currentState: string
    history: any
    stateEntryTimes: any
  }>
}

// Memory Adapter (renamed from AdapterJSON)
export class MemoryAdapter<T extends object>
  implements Adapter<T>, StatePersistenceAdapter {
  adaptee: T
  private _savedState: unknown

  constructor(data: T) {
    this.adaptee = data
  }

  set(property: keyof T, value: T[keyof T]) {
    this.adaptee[property] = value
  }

  get(property: keyof T): T[keyof T] {
    return this.adaptee[property]
  }

  // StatePersistenceAdapter implementation
  async save(state?: { currentState: string; history: unknown; stateEntryTimes: unknown }) {
    this._savedState = state
  }

  async restore(): Promise<{ currentState: string; history: unknown; stateEntryTimes: unknown }> {
    return this._savedState as { currentState: string; history: unknown; stateEntryTimes: unknown }
  }
}

// LocalStorage Adapter
export class LocalStorageAdapter<T extends object>
  implements Adapter<T>, StatePersistenceAdapter {
  adaptee: T
  private key: string

  constructor(data: T, storageKey = 'state_machine') {
    this.adaptee = data
    this.key = storageKey
  }

  set(property: keyof T, value: T[keyof T]) {
    this.adaptee[property] = value
  }

  get(property: keyof T): T[keyof T] {
    return this.adaptee[property]
  }

  // StatePersistenceAdapter implementation
  async save(state?: any) {
    const data = { ...this.adaptee, state }
    globalThis.localStorage.setItem(this.key, JSON.stringify(data))
  }

  async restore() {
    const stored = globalThis.localStorage.getItem(this.key)
    /* c8 ignore next */
    return stored ? JSON.parse(stored).state : { currentState: '', history: {} }
  }
}

// SessionStorage Adapter
export class SessionStorageAdapter<T extends object>
  implements Adapter<T>, StatePersistenceAdapter {
  adaptee: T
  private key: string

  constructor(data: T, storageKey = 'state_machine') {
    this.adaptee = data
    this.key = storageKey
  }

  set(property: keyof T, value: T[keyof T]) {
    this.adaptee[property] = value
  }

  get(property: keyof T): T[keyof T] {
    return this.adaptee[property]
  }

  // StatePersistenceAdapter implementation
  async save(state?: any) {
    const data = { ...this.adaptee, state }
    globalThis.sessionStorage.setItem(this.key, JSON.stringify(data))
  }

  async restore() {
    const stored = globalThis.sessionStorage.getItem(this.key)
    /* c8 ignore next */
    return stored ? JSON.parse(stored).state : undefined
  }
}

// Server Adapter (async example)
export class ServerAdapter<T extends object>
  implements Adapter<T>, StatePersistenceAdapter {
  adaptee: T
  static data: Record<string, unknown> = {}
  private endpoint: string

  constructor(data: T, endpoint = '/api/state') {
    this.adaptee = data
    this.endpoint = endpoint
  }

  set(property: keyof T, value: T[keyof T]) {
    this.adaptee[property] = value
  }

  get(property: keyof T): T[keyof T] {
    return this.adaptee[property]
  }

  // StatePersistenceAdapter implementation (simulated async)
  async save(state?: any): Promise<void> {
    if (state) {
      // Simulate server call
      await new Promise((resolve) => setTimeout(resolve, 100))
      ServerAdapter.data[this.endpoint] = state
    }
  }

  async restore(): Promise<any> {
    // Simulate server fetch
    await new Promise((resolve) => setTimeout(resolve, 100))
    return (
      ServerAdapter.data[this.endpoint] || { currentState: '', history: {} }
    )
  }
}
