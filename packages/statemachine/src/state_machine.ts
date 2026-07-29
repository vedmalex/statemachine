import {
  type ContextTrackerKind,
  createDefaultContextTracker,
} from './context_tracker'
import { securityLogger, stateMachineLogger } from './logger'
import { createDefaultScheduler } from './scheduler'
import {
  type SafeSerializedAction,
  serializeActionRef,
  serializeActionRefAsync,
} from './serialize-actions'
import { createDefaultMonitor } from './monitoring'
import { createDefaultErrorHandler } from './error_handling'
import { compileModel, type CompiledModel } from './model'
import { MODEL_ERROR_CODES, validateConfig } from './config_validator'
import {
  type ActionOrString,
  type Adapter,
  type ErrorContext,
  type ErrorHandler,
  type ErrorHandlerOrString,
  type Event,
  type EventAction,
  type EventName,
  type Events,
  type ExitContext,
  type FireResult,
  type InvokeOperation,
  type InvokeTimer,
  type StateInvocation,
  type FunctionRegistry,
  type IContextTracker,
  type IErrorHandler,
  type ILogger,
  type IMonitor,
  type MonitorMetricsSnapshot,
  type ITimerScheduler,
  isAdapter,
  type KeysOf,
  type LifecycleEvent,
  MemoryAdapter,
  type MethodsOf,
  type PropertiesOf,
  type RegionsConfig,
  type State,
  type StateMachineConfig,
  StateMachineError,
  type StateMachineOptions,
  type StateName,
  type StatePersistenceAdapter,
  type States,
  type Transition,
} from './types'

/**
 * П2 (dedup): marks an error whose `monitor.recordError` was ALREADY emitted at
 * the point it was caught (in `executeQueuedTransition`), so a downstream
 * `reportRuntimeError` on the SAME object does not record it a SECOND time.
 * Doubled error counters are fatal for the quantitative simulator oracles (W5).
 */
const RUNTIME_ERROR_REPORTED = Symbol('mb3.runtimeErrorReported')

/**
 * W8/V1 — `LifecycleEvent.hook` labels for the enter-hook slots, positionally
 * aligned with the `enterActions` array in `executeEnterActions`. Module-level so
 * an unsubscribed machine allocates nothing for it.
 */
const ENTER_HOOK_NAMES = ['onBeforeEnter', 'onEnter', 'onAfterEnter'] as const

/**
 * W9/Г1 — the CLOSED set of engine-internal raise origins, one per `raiseEvent`
 * call site. It is a closed union ON PURPOSE: adding a sixth raise site forces the
 * author to name it here and to pass a {@link RaiseOrigin}, which is what makes
 * the `kind:'raise'` observation plane structurally complete rather than
 * best-effort. (On the PUBLIC `LifecycleEvent.hook` these are still plain strings
 * — that union stays EXTENSIBLE for consumers.)
 */
type RaiseHook =
  /** `checkCompletion` raised `done.state.<C>` for a newly all-final composite. */
  | 'raise.done'
  /** An `invoke` TIMER elapsed and raised its `event`. */
  | 'raise.invoke.timer'
  /** An `invoke` OPERATION resolved and raised its `onDone`. */
  | 'raise.invoke.onDone'
  /** An `invoke` OPERATION rejected and raised its `onError`. */
  | 'raise.invoke.onError'
  /** A timer RESUMED from a deserialized snapshot elapsed and raised its `event`. */
  | 'raise.invoke.resume'

/**
 * W9/Г1 — the REQUIRED provenance every `raiseEvent` call must declare. `state` is
 * a real dot-path (the composite for `raise.done`, the invoke-owning leaf
 * otherwise) and `microstep` follows the RAISE ASYMMETRY documented on
 * {@link LifecycleEvent.microstep}.
 */
interface RaiseOrigin {
  readonly hook: RaiseHook
  readonly state: string
  readonly microstep: number
}

/**
 * Prototype-chain builtin names that must NEVER be call-time-resolved as an
 * action / guard / error-handler by bare-name lookup (W0 B1).
 *
 * A serialized (untrusted-JSON) action whose name is a member of
 * `Object.prototype` / `Function.prototype` — `constructor`, `toString`,
 * `valueOf`, `hasOwnProperty`, `__proto__`, … — would otherwise resolve, via a
 * bare bracket access (`adaptee[name]` inside `MemoryAdapter.get`), to a
 * prototype builtin. Each such builtin is itself `typeof 'function'`, so it is
 * invoked as if it were a legitimate guard; the invocation returns a truthy
 * value and the transition is ALLOWED — an authorization/allow bypass straight
 * out of untrusted JSON, with no function registry involved. This is the
 * string-branch sibling of the object-branch V6b fix in `deserializeAction`.
 *
 * The gate is applied at the RESOLUTION call-site (before `obj.get(name)`), not
 * inside `MemoryAdapter.get`, so legitimate *data* reads through `get` keep
 * their prior behavior, and a legitimate owner method whose name is NOT a
 * prototype builtin still resolves normally. A name that is neither an own
 * property nor a member of this set simply reads back `undefined` and fails
 * closed to the existing "No action found" throw.
 */
const RESERVED_ACTION_NAMES: ReadonlySet<string> = new Set<string>([
  ...Object.getOwnPropertyNames(Object.prototype),
  ...Object.getOwnPropertyNames(Function.prototype),
  'prototype',
  '__proto__',
])

/**
 * True when `name` is a prototype-builtin identifier that must not be
 * call-time-resolved as an action/guard/handler by bare-name lookup (W0 B1).
 */
function isReservedActionName(name: unknown): boolean {
  return typeof name === 'string' && RESERVED_ACTION_NAMES.has(name)
}

// W4.1 #5 — the engine's DEFAULT logger is the logger.ts `stateMachineLogger`
// (a `getLogger('StateMachine')` instance), NOT a raw console shim. The old
// ConsoleLogger bypassed logger.ts entirely, so `setDefaultLogLevel` (which only
// reconfigures logger.ts consumers) silently failed to silence the engine's
// warn/error — a no-op control surface. Routing the default through logger.ts
// makes `setDefaultLogLevel` genuinely govern engine verbosity (level WARN by
// default → debug/info stay suppressed, warn/error reach the console appender,
// preserving the previous observable behaviour). An explicitly injected
// `options.logger` still wins.
const DefaultEngineLogger: ILogger = stateMachineLogger

/**
 * U7 / #15 (MASTER §4б) — TEST-ONLY perf counting probe. Symbol-gated on
 * `globalThis` so the core public surface, exports, and `.d.ts` declarations
 * are UNCHANGED: production never registers the probe, so no consumer can see
 * it. The instrumented hot path ({@link StateMachine.computeInternalWrite})
 * reads the probe ONCE per call into a local and the conflict-scan inner loop
 * pays a single truthy check — near-zero overhead in the OFF (production) state.
 *
 * When a counting-probe test installs a probe object under
 * {@link PERF_PROBE_KEY}, each unit of conflict-scan work in the region-write
 * path increments `internalWriteScan`. This lets the probe ASSERT the write
 * path grows O(R) (not Θ(R²)) in the region count R deterministically — a
 * counted metric, not wall-clock ms (MASTER §4б: CI hardware makes ms flaky).
 * Behaviour is unchanged; this is pure observability. See
 * `src/tests/perf_counting.test.ts`.
 */
const PERF_PROBE_KEY = Symbol.for('@vedmalex/statemachine:perfProbe')

interface SmPerfProbe {
  /**
   * Units of conflict-scan work performed by {@link StateMachine.computeInternalWrite}:
   * incremented once per existing map entry examined while removing the region
   * conflicts of an incoming composite part. Θ(R²) here would be the PERF-03
   * regression; the probe asserts it stays O(R).
   */
  internalWriteScan: number
  /**
   * Units of region-membership work performed by {@link StateMachine.isCompositeDone}:
   * incremented once per atomic-leaf comparison while locating each region's
   * active leaf. The per-region full leaf scan made a completing R-region
   * composite Θ(R²) (PERF-02, reached unconditionally from checkCompletion); the
   * probe asserts it stays O(R) after the region→leaf index fix.
   */
  completionScan: number
}

/**
 * Fetch the currently-installed {@link SmPerfProbe}, or `undefined` in the
 * normal (production) case. One `globalThis` symbol read; callers cache it in a
 * local so the guarded increment is a single truthy check.
 */
function currentPerfProbe(): SmPerfProbe | undefined {
  // The probe key lives in the GLOBAL Symbol registry, so any code in the process
  // could set it. Validate the shape: a non-object truthy value (or null) would
  // make the guarded `probe.field++` throw a TypeError in strict-mode ESM and wedge
  // the engine on every state write. Only accept an actual object; anything else is
  // treated as "no probe".
  const v = (globalThis as Record<symbol, unknown>)[PERF_PROBE_KEY]
  return typeof v === 'object' && v !== null ? (v as SmPerfProbe) : undefined
}

/**
 * Number of `.` segments-boundaries in a region key (allocation-free). Used by
 * {@link StateMachine.computeInternalWrite} to gate the descendant conflict
 * scan (PERF-03): a strict descendant of a region key is always deeper, so a
 * scan is needed only when a key deeper than the incoming one can exist.
 */
function countDots(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 46 /* '.' */) n++
  }
  return n
}

interface StateInfo {
  name: string
  display?: string
  isComposite: boolean
  regions?: string[]
  parent?: string
  children?: string[]
}

interface QueuedEvent<TOwner extends object = object> {
  id: string
  eventName: string
  obj: Adapter<PropertiesOf<TOwner>>
  args: any[]
  resolve?: (value: boolean) => void
  reject?: (error: any) => void
  timestamp: number
  type: 'internal' | 'external'
  /**
   * SPEC §7: when set, this event was posted via `fireEventDetailed`. The drain
   * settles the caller through `resolveDetailed` with the {@link FireResult}
   * `executeQueuedTransition` writes into `detailResult`, and NO-candidate no
   * longer throws — it resolves `{ fired:false, reason:'no-transition' }`.
   */
  detailed?: boolean
  resolveDetailed?: (result: FireResult) => void
  detailResult?: FireResult
}

/**
 * SPEC §4 / PERF-07 — a transition with its STATIC ordering keys precomputed
 * ONCE in the constructor (`from` is immutable, so `priority` / `specificity` /
 * `docIndex` never change). The per-event candidate list is stored pre-sorted by
 * `(priority ↓, specificity ↑, docIndex ↑)`, so a naive per-event ancestor walk
 * is avoided on the hot path; only descendant-dominance (which depends on the
 * live active configuration) and lazy guards run at fire time.
 */
interface PreparedTransition<
  TOwner extends object,
  S extends States<TOwner>,
> {
  transition: Transition<TOwner, S>
  /** `priority ?? 0` — SPEC §4.1: absent === 0, NOT -Infinity (the F9 fix). */
  priority: number
  /** SPEC §4.2 specificity class: 0 explicit `from` · 1 partial `'a|*'` · 2 `'*'`. */
  specificity: 0 | 1 | 2
  /** Declaration index in `event.transitions` — the sole document-order source. */
  docIndex: number
}

interface QueuedEventInfo {
  id: string
  event: string
  age: number
  type: 'internal' | 'external'
}

export class StateMachine<
  TOwner extends object,
  SMConfig extends StateMachineConfig<TOwner>,
> {
  // Приватные поля для зависимостей
  private logger: ILogger
  private monitor: IMonitor
  private scheduler: ITimerScheduler
  private errorHandler: IErrorHandler
  private clock: () => number
  private schedulerProvided: boolean

  // Свойства
  private states: Map<keyof SMConfig['states'], State<TOwner>>
  /**
   * W2a: нормализованная модель конфига, скомпилированная ОДИН раз в
   * конструкторе (см. model.ts). Единый источник детерминированного
   * `documentIndex` / `depth` — используется для КАНОНИЧЕСКОГО порядка
   * активной конфигурации (взамен порядка вставки в Map) и для depth-сортировки
   * в checkCompletion (взамен `split('.').length`). Внутренний API для
   * валидатора (W2b) и селекции (W3).
   */
  private model!: CompiledModel
  private events: Map<
    keyof SMConfig['events'],
    Event<TOwner, SMConfig['states']>
  >
  /**
   * SPEC §4 / PERF-07: per-event transitions pre-sorted ONCE by the static
   * ordering keys `(priority ↓, specificity ↑, docIndex ↑)`. Selection filters
   * this list by the live active configuration (stable — preserves the sorted
   * order), applies the descendant-dominance filter, then runs guards lazily.
   * Keyed by event name (includes the `'*'` wildcard event).
   */
  private orderedTransitions!: Map<
    string,
    PreparedTransition<TOwner, SMConfig['states']>[]
  >
  /**
   * U7/#15 (PERF-02): `true` iff the config declares at least one
   * `done.state.<C>` completion event. Precomputed ONCE (the declared event set
   * is immutable) so {@link checkCompletion} can early-return without touching
   * the per-write completion machinery when no completion event can ever fire —
   * the common case. Every `done.state.<C>` emission is already gated on
   * `this.events.has(...)`, so skipping is behaviour-identical.
   */
  private readonly hasCompletionEvents: boolean
  private stateAttribute: KeysOf<PropertiesOf<TOwner>, string>
  private onError?: ErrorHandlerOrString<TOwner>
  private adaptee?: Adapter<PropertiesOf<TOwner>>
  private context?: MethodsOf<TOwner>
  // П6 (multi-object isolation) — the public contract binds ONE machine to MANY
  // objects (`fireEvent(event, obj)` / `attachToObject`); the active state lives
  // in each object, NOT on the machine. So the per-state timers / in-flight
  // operations / history / entry-times MUST be keyed by the OWNER first, then by
  // state name — a bare `Map<stateName, …>` collides across owners: a second
  // object entering the SAME state overwrote the first's record, and either
  // object's EXIT tore down EVERY owner's timers/operations for that state.
  // WeakMap<owner> keeps each owner's records isolated (and GC-friendly). The
  // owner key is the raw adaptee object (see {@link ownerKey}); owner-less
  // internal / serialization paths fall back to the primary construction adaptee.
  private historyByOwner: WeakMap<object, Map<StateName, string>> = new WeakMap()
  private initialState: keyof SMConfig['states']
  private persistenceAdapter?: StatePersistenceAdapter
  private activeTimersByOwner: WeakMap<object, Map<string, any[]>> = new WeakMap()
  // W3b (SPEC §6а) — per-leaf AbortControllers for in-flight `invoke.src`
  // operations, kept ALONGSIDE activeTimers (same lifecycle: armed on entry in
  // armStateInvoke, aborted before onExit in executeExitActions, dropped in
  // teardownStateTimers). Keyed (per owner, П6) by the leaf state name, one
  // controller per running operation of that leaf.
  private activeInvokesByOwner: WeakMap<object, Map<string, AbortController[]>> =
    new WeakMap()
  // W3b.1 livelock bound: consecutive invoke-operation restarts after an
  // aborted-without-commit microstep, per source leaf. Reset on a committed
  // exit of the leaf. A deterministically-throwing onExit would otherwise loop
  // relaunch→onDone→exit-throw→re-abort→relaunch forever; past the cap the
  // operation is left cancelled and the fact is recorded (observable), not spun.
  //
  // W4.1 #2 — PER-OWNER (WeakMap<owner, Map<leaf,count>>). A single flat
  // Map<leaf,count> on the machine let multiple owners SHARE one budget for the
  // same leaf name, and `commitConfiguration`'s global `.clear()` reset EVERY
  // owner's counters on ANY commit — so owner B's successful commit zeroed owner
  // A's restart budget, letting A relaunch unboundedly (the livelock bound W3b.1
  // establishes was silently defeated in the multi-owner case). Now each owner
  // counts independently and a commit clears ONLY the committing owner's exit-set.
  private invokeRestartCountByOwner: WeakMap<object, Map<string, number>> =
    new WeakMap()
  private readonly MAX_INVOKE_RESTARTS = 3
  private stateEntryTimesByOwner: WeakMap<object, Map<string, number>> =
    new WeakMap()
  // OTS (SPEC §6.1): per-microstep guard-result memo so a candidate governing
  // several active leaves has its guard evaluated at most once. Set/cleared by
  // computeEnabledSet; undefined outside an OTS selection.
  private microstepGuardCache:
    | Map<
        Transition<TOwner, SMConfig['states']>,
        { passed: boolean; threw: boolean; error?: Error }
      >
    | undefined

  // ── W8/V1: public lifecycle observability channel ───────────────────────────
  /**
   * W8/V1 — near-zero gate. Resolved ONCE in the constructor (the monitor is
   * injected there and never reassigned), so an unsubscribed machine pays a
   * single boolean test per instrumented callback and builds NO event object,
   * takes NO extra promise hop, and allocates nothing. Every emission site is
   * wrapped in `if (this.lifecycleEnabled)`.
   */
  private lifecycleEnabled = false
  /** W8/V1 — per-machine monotonic record counter (`LifecycleEvent.seq`). */
  private lifecycleSeq = 0
  /**
   * W8/V1 — per-machine monotonic microstep id (`LifecycleEvent.microstep`).
   * Incremented at the START of {@link computeEnabledSet}, i.e. before the first
   * guard of an event-driven selection attempt, so a guard and the enter/exit
   * hooks of the microstep it selects share ONE id. Starts at 0 and is
   * pre-incremented, so `0` is RESERVED for the paths that have no microstep at
   * all (construction / reset / resumeTimers).
   */
  private microstepCounter = 0
  /**
   * W8/V1 — id of the microstep currently being selected / applied. Set by
   * {@link computeEnabledSet} and read by the guard emission site and by
   * {@link applyMicrostep}, which run strictly INSIDE that same run-to-completion
   * step (a nested drain is structurally impossible: `fireEvent` from a callback
   * is rejected as reentrant and `raiseEvent` only queues). Each reader still
   * copies it into a local before its first `await`, so even a future nesting
   * cannot retag an in-flight record.
   */
  private currentMicrostep = 0

  // Event Queue Infrastructure (SCXML Run-to-Completion)
  private externalQueue: QueuedEvent<TOwner>[] = []
  private internalQueue: QueuedEvent<TOwner>[] = []
  private isProcessing = false
  private eventIdCounter = 0
  private transitionDepth = 0
  // П8: run-away bound is now configurable via StateMachineOptions.maxTransitionDepth
  // (default 100). A legitimate FINITE internal cascade longer than the old
  // hard-coded 100 (e.g. a long auto-advance gated-pipeline through `done.state`)
  // was falsely killed; raising the bound lets it complete while STILL catching a
  // genuinely self-sustaining loop. Default matches the historical constant.
  private maxTransitionDepth = 100

  // П3: precise reentrancy detection. Each drain tags the actions/guards it runs
  // with its own epoch via AsyncLocalStorage. A `fireEvent` whose async context
  // carries the CURRENTLY-active drain epoch is a TRUE reentrant call (issued from
  // WITHIN an onEnter/onExit/onTransition/guard on the drain's logical stack). An
  // external `fireEvent` from an INDEPENDENT async callback (a timer/IO macrotask
  // scheduled outside the drain, or a caller woken by `resolve()` before the drain
  // finished) carries NO drain epoch (getStore() === undefined) and is a legitimate
  // queue — exactly what the external queue exists for. The epoch (not a mere
  // boolean) guards against a context that leaked into a timer set INSIDE an action
  // but fires AFTER the drain has ended: its stale epoch no longer matches the
  // active one, so it is not misread as reentrant.
  //
  // The tracker is INJECTED (options.contextTracker) or resolved from the
  // runtime at construction — never hard-imported. `node:async_hooks` is emitted
  // by the bundler as the BARE specifier `async_hooks`, which a browser cannot
  // resolve and Deno rejects, making the entire core bundle unloadable there.
  // See src/context_tracker.ts. Where no primitive exists the tracker degrades
  // to a no-op: `getStore()` is then permanently `undefined`, which can never
  // equal the numeric `activeDrainEpoch`, so the reject conditions below become
  // UNREACHABLE — legitimate fires are never falsely rejected, and the only loss
  // is missed detection of a TRUE reentrant (which parks that drain).
  private readonly drainContext: IContextTracker
  private readonly _contextTrackerKind: ContextTrackerKind
  private drainEpoch = 0
  private activeDrainEpoch: number | null = null

  // Optional configuration
  private transitionTimeout?: number
  private errorState?: string
  private abortOnExitError?: boolean
  private maxQueueDepth = 1000

  // Transition state visibility
  private _isTransitioning = false
  private _targetState: string | undefined

  public get isTransitioning() {
    return this._isTransitioning
  }

  public get targetState() {
    return this._targetState
  }

  /**
   * @unstable — WHICH async-context primitive backs this machine's reentrancy
   * detection, so a host or test can assert the mode instead of inferring it.
   *
   * - `'async-local-storage'` / `'async-context'` — PRECISE detection: a true
   *   reentrant `fireEvent` from inside an action/guard rejects with a clear
   *   error.
   * - `'none'` — DEGRADED: no primitive in this runtime (a browser, typically).
   *   Legitimate concurrent fires still queue and resolve — they are never
   *   falsely rejected — but a true reentrant one is NOT detected and parks that
   *   drain unless {@link StateMachineOptions.transitionTimeout} bounds it. One
   *   WARN is logged at construction when this branch is taken.
   * - `'injected'` — a tracker came from {@link StateMachineOptions.contextTracker};
   *   its capability is the injector's to state (it may itself be a no-op).
   */
  public get contextTrackerKind(): ContextTrackerKind {
    return this._contextTrackerKind
  }

  // Геттеры и сеттеры
  public set currentState(state: StateName) {
    if (!this.adaptee) throw new StateMachineError('no adaptee', { state })
    this.setCurrentState(state, this.adaptee)
  }

  public get currentState(): string {
    if (!this.adaptee) {
      const s = this.getCurrentState()
      /* c8 ignore next */
      throw new StateMachineError('no adaptee', s !== undefined ? { state: s } : {})
    }
    /* c8 ignore next */
    return this.getCurrentState(this.adaptee) ?? ''
  }

  // Конструктор
  constructor(
    config: SMConfig,
    adaptee?: Adapter<PropertiesOf<TOwner>> | PropertiesOf<TOwner>,
    options?: StateMachineOptions, // ⬅️ Внедрение через опции
  ) {
    this.initialState = config.initialState

    // ✅ Внедрение зависимостей (Dependency Injection)
    // Если передали - используем, если нет - fallback на легковесные версии
    this.logger = options?.logger ?? DefaultEngineLogger
    this.monitor = options?.monitor ?? createDefaultMonitor()
    // W8/V1 — cache the lifecycle subscription once: `monitor` is never
    // reassigned after construction, and this keeps the unsubscribed hot path at
    // a single boolean test (see {@link lifecycleEnabled}).
    this.lifecycleEnabled = typeof this.monitor.recordLifecycle === 'function'
    this.schedulerProvided = options?.scheduler !== undefined
    this.scheduler = options?.scheduler ?? createDefaultScheduler()
    this.clock = options?.clock ?? Date.now
    this.errorHandler = options?.errorHandler ?? createDefaultErrorHandler()

    // П3 / runtime portability: resolve the async-context tracker that backs
    // precise reentrancy detection. An injected tracker is taken on trust (the
    // capability is then the caller's to state); otherwise the runtime is probed.
    if (options?.contextTracker !== undefined) {
      this.drainContext = options.contextTracker
      this._contextTrackerKind = 'injected'
    } else {
      const resolved = createDefaultContextTracker()
      this.drainContext = resolved.tracker
      this._contextTrackerKind = resolved.kind
      if (resolved.kind === 'none') {
        // DISCLOSE the degradation exactly once, at construction. WARN is the
        // default logger level, so this is visible with no consumer setup and
        // silenceable through `setDefaultLogLevel`. Deliberately NOT routed
        // through `monitor.recordError`: a construction-time environment
        // capability is not a runtime error, and counting it as one would
        // pollute the sim's quantitative oracles.
        this.logger.warn(
          'Precise reentrancy detection is unavailable in this runtime (no ' +
            'AsyncLocalStorage, no AsyncContext.Variable). The machine works and ' +
            'legitimate concurrent fireEvent calls are never falsely rejected, but a ' +
            'TRUE reentrant fireEvent issued from inside an action/guard will PARK ' +
            'that drain instead of rejecting with a clear error. Set ' +
            '`transitionTimeout` to bound it, or inject `options.contextTracker`.',
          { name: config.name, contextTracker: 'none' },
        )
      }
    }

    if (adaptee) {
      if (!isAdapter<TOwner>(adaptee)) {
        this.adaptee = new MemoryAdapter(adaptee) as Adapter<
          PropertiesOf<TOwner>
        >
      } else {
        this.adaptee = adaptee as Adapter<PropertiesOf<TOwner>>
      }
    }

    // Apply options
    if (options?.transitionTimeout !== undefined) {
      this.transitionTimeout = options.transitionTimeout
    }
    if (options?.errorState !== undefined) {
      this.errorState = options.errorState
    }
    if (options?.abortOnExitError !== undefined) {
      this.abortOnExitError = options.abortOnExitError
    }
    if (options?.maxQueueDepth !== undefined) {
      this.maxQueueDepth = options.maxQueueDepth
    }
    if (options?.maxTransitionDepth !== undefined) {
      this.maxTransitionDepth = options.maxTransitionDepth
    }
    if (config.onError !== undefined) {
      this.onError = config.onError
    }
    this.stateAttribute = config.stateAttribute
    this.states = new Map()
    this.events = new Map(
      Object.entries(config.events).map(([name, value]) => [
        name,
        {
          name,
          ...value,
          transitions: value.transitions.map((t) => ({
            ...t,
            // Support 'action' alias for 'onTransition'
            onTransition: t.onTransition || (t as any).action,
          })),
        },
      ]),
    )
    // U7/#15 (PERF-02): does ANY declared event name denote a completion event?
    // Computed once so checkCompletion can skip its per-write work when none can
    // ever be raised.
    let anyCompletion = false
    for (const name of this.events.keys()) {
      if (String(name).startsWith('done.state.')) {
        anyCompletion = true
        break
      }
    }
    this.hasCompletionEvents = anyCompletion
    this.processStates(config.states)
    // W2a: компилируем конфиг в нормализованную модель ОДИН раз, СРАЗУ после
    // построения плоской карты состояний и ДО первой активации
    // (setInitialState). Модель — источник детерминированного documentIndex,
    // на который опирается канонический порядок активной конфигурации.
    this.model = compileModel(config.states as any)

    // SPEC §4 / PERF-07: precompute the per-event ordered candidate lists ONCE.
    // `from` is immutable, so priority/specificity/document-order are static —
    // sorting per fireEvent would redo constant work on the hot path. Descendant
    // dominance stays dynamic (needs the live active configuration) and runs at
    // fire time; everything sortable is frozen here.
    this.orderedTransitions = new Map()
    for (const [name, ev] of this.events) {
      const prepared = ev.transitions.map((transition, docIndex) => ({
        transition,
        priority: transition.priority ?? 0,
        specificity: this.sourceSpecificity(transition.from as string),
        docIndex,
      }))
      // Stable sort by (priority DESC, specificity ASC, docIndex ASC). docIndex
      // is the final, total tie-break, so the order is fully deterministic and
      // document order (first-declared) wins on an otherwise exact tie (§4.4).
      prepared.sort(
        (a, b) =>
          b.priority - a.priority ||
          a.specificity - b.specificity ||
          a.docIndex - b.docIndex,
      )
      this.orderedTransitions.set(String(name), prepared)
    }

    // SPEC §1а throw policy (M-5: comment synced with MODEL_ERROR_CODES). ONLY
    // the codes in MODEL_ERROR_CODES make the machine UNBUILDABLE and throw at
    // construction — today that set is exactly {INVALID_STATE_PATH} (a broken
    // path names a state that cannot exist, so the machine literally cannot be
    // built). Every OTHER model-level error (REGION_STARTS_FINAL, UNSATISFIABLE_
    // FROM/TO, REGION_NO_PATH_TO_FINAL, DUPLICATE_REGION_NAME, …) is a
    // DELIBERATELY-SUPPORTED-but-diagnosed config: `validateConfig` reports it
    // (isValid:false) yet construction proceeds — e.g. a final-only region (D12
    // all-final) builds and immediately raises its done.state join. Advisory
    // warnings likewise stay non-fatal and remain available via validateConfig.
    const modelErrors = validateConfig(config as any).errors.filter((e) =>
      MODEL_ERROR_CODES.has(e.code),
    )
    if (modelErrors.length > 0) {
      throw new StateMachineError(
        `StateMachine config "${config.name}" has model errors that make it unbuildable: ` +
          modelErrors.map((e) => `${e.code} (${e.path}): ${e.message}`).join('; '),
        {},
      )
    }

    // W3b.1 LOW (§0.6) — advisory cross-check: an invoke that raises an event
    // absent from the events map (a typo'd `onDone`/`onError`, or a timer
    // `event`) can never be handled → a silent no-handler stall. Warn once at
    // construction; non-fatal (parity with the other advisory model diagnostics).
    this.warnUnknownInvokeEvents()

    if (adaptee) {
      this.persistenceAdapter = adaptee as unknown as StatePersistenceAdapter
      this.setInitialState(config.initialState as string)
    }

    // Логируем инициализацию
    this.logger.info('StateMachine initialized', { name: config.name })
  }

  // Основные публичные методы
  public setContext(context: MethodsOf<TOwner>): void {
    this.context = context
  }

  /**
   * П13/EO-8 — public access to the injected observability monitor. Before this,
   * the monitor was reachable only via `(sm as any).monitor`, so a consumer could
   * not read transition/error metrics or drive a health check without reaching
   * into a private field. Returns the same {@link IMonitor} instance the machine
   * records into (the injected `options.monitor` or the default monitor).
   */
  public getMonitor(): IMonitor {
    return this.monitor
  }

  /**
   * П13/EO-8 — public snapshot of the aggregate observability metrics, or
   * `undefined` when the injected monitor does not implement `getMetrics`
   * (the optional {@link IMonitor} extension). The snapshot reflects the
   * EO-3-honest counters (non-negative `successCount`, truthful `errorCount`).
   */
  public getMetrics(): MonitorMetricsSnapshot | undefined {
    return this.monitor.getMetrics?.()
  }

  private resolveCallbackOwner(value: Adapter<any> | TOwner): TOwner {
    return isAdapter<TOwner>(value)
      ? (value.adaptee as TOwner)
      : (value as TOwner)
  }

  // ── П6: per-owner map access ────────────────────────────────────────────────
  /**
   * П6 — resolve the OWNER key for the per-owner timer/operation/history/entry
   * maps. The owner is the raw adaptee object whose `stateAttribute` actually
   * holds the state; keying by it (not by shared state-name) isolates every
   * object attached to the same machine. Owner-less internal / serialization
   * paths fall back to the primary construction adaptee, and a machine with no
   * adaptee at all uses `this` as a stable sentinel so its single logical owner
   * shares one map.
   */
  private ownerKey(obj?: Adapter<any>): object {
    const raw = (obj?.adaptee ?? this.adaptee?.adaptee) as object | undefined
    return raw ?? this
  }

  // ── W8/V1: lifecycle observability emission ─────────────────────────────────
  /**
   * W8/V1 — build and dispatch ONE {@link LifecycleEvent}. The SOLE call site of
   * `monitor.recordLifecycle` in the engine, so the SINK GUARD below covers every
   * emission by construction.
   *
   * The guard swallows a failure of the SINK only. It never sees — and therefore
   * never swallows — the observed callback's own error: that is raised by
   * `callAction` and routed by `processError` on a separate path.
   *
   * CALLERS MUST GATE on {@link lifecycleEnabled} before calling, so an
   * unsubscribed machine never even reaches the argument evaluation.
   */
  private emitLifecycle(
    kind: LifecycleEvent['kind'],
    hook: string,
    state: string,
    owner: object,
    microstep: number,
    edge: LifecycleEvent['edge'],
    extra?: { event?: string; failed?: boolean; outcome?: boolean; transition?: string },
  ): void {
    const record: LifecycleEvent = {
      kind,
      hook,
      state,
      owner,
      microstep,
      seq: this.lifecycleSeq++,
      edge,
      ...(extra?.event !== undefined ? { event: extra.event } : {}),
      ...(extra?.failed !== undefined ? { failed: extra.failed } : {}),
      ...(extra?.outcome !== undefined ? { outcome: extra.outcome } : {}),
      ...(extra?.transition !== undefined ? { transition: extra.transition } : {}),
    }
    try {
      this.monitor.recordLifecycle?.(record)
    } catch {
      /* a monitor sink must never break the drain */
    }
  }

  /**
   * W8/V1 — run ONE engine-invoked callback through {@link callAction} with a
   * `begin` / `end` lifecycle pair around it, preserving the caller's error
   * routing BYTE-FOR-BYTE.
   *
   * Two invariants shape the shape of the chain:
   *
   * 1. When nothing is subscribed the call is the ORIGINAL
   *    `callAction(...).catch(route)` expression — not merely "cheap", but the
   *    IDENTICAL promise chain, so the number of microtask hops before the error
   *    handler runs is unchanged and no existing timing-sensitive behaviour can
   *    shift.
   * 2. When subscribed, `end` is emitted at the settle of the CALLBACK, in a
   *    `.catch` that RETHROWS, so the caller's `route` still receives the very
   *    same error afterwards. Emitting after `route` would attribute a hung /
   *    slow `onError` to the callback it recovers.
   */
  private async runLifecycleAction(
    obj: Adapter<TOwner>,
    action: ActionOrString<TOwner>,
    callArgs: any[],
    route: (error: any) => unknown,
    kind: LifecycleEvent['kind'],
    hook: string,
    state: string,
    microstep: number,
    eventName?: string,
  ): Promise<void> {
    if (!this.lifecycleEnabled) {
      await this.callAction(obj, action, ...callArgs).catch(route)
      return
    }
    const owner = this.ownerKey(obj)
    const ctx = eventName !== undefined ? { event: eventName } : undefined
    this.emitLifecycle(kind, hook, state, owner, microstep, 'begin', ctx)
    await this.callAction(obj, action, ...callArgs)
      .then(() => {
        this.emitLifecycle(kind, hook, state, owner, microstep, 'end', {
          ...ctx,
          failed: false,
        })
      })
      .catch((error) => {
        this.emitLifecycle(kind, hook, state, owner, microstep, 'end', {
          ...ctx,
          failed: true,
        })
        throw error
      })
      .catch(route)
  }

  /**
   * W8/V1b — run ONE invoke ACTION with a `begin` / `end` lifecycle pair, WITHOUT
   * touching its error routing (the invoke lanes contain their own try/catch and
   * do not use `processError`, so the error is simply rethrown to them).
   *
   * This is the path that closes the ISS-030 observability gap: a STRING-method
   * invoke action is resolved and called by `callAction` without any `bracketAsync`
   * wrapper, so it was previously invisible to every observability surface. The
   * channel wraps the CALL, not the action value, so a string action and an inline
   * function action are equally observable.
   *
   * When nothing is subscribed this is the ORIGINAL bare `await callAction(...)`.
   */
  private async runTracedInvokeAction(
    obj: Adapter<TOwner>,
    action: ActionOrString<TOwner>,
    state: string,
    microstep: number,
    eventName?: string,
  ): Promise<void> {
    if (!this.lifecycleEnabled) {
      await this.callAction(obj, action)
      return
    }
    const owner = this.ownerKey(obj)
    const ctx = eventName !== undefined ? { event: eventName } : undefined
    this.emitLifecycle('invoke', 'invoke.action', state, owner, microstep, 'begin', ctx)
    try {
      await this.callAction(obj, action)
      this.emitLifecycle('invoke', 'invoke.action', state, owner, microstep, 'end', {
        ...ctx,
        failed: false,
      })
    } catch (error) {
      this.emitLifecycle('invoke', 'invoke.action', state, owner, microstep, 'end', {
        ...ctx,
        failed: true,
      })
      throw error
    }
  }

  /** П6 — the current owner's per-state timer map (created on first access). */
  private timersFor(obj?: Adapter<any>): Map<string, any[]> {
    const key = this.ownerKey(obj)
    let m = this.activeTimersByOwner.get(key)
    if (!m) {
      m = new Map()
      this.activeTimersByOwner.set(key, m)
    }
    return m
  }

  /** П6 — the current owner's per-state in-flight operation map. */
  private invokesFor(obj?: Adapter<any>): Map<string, AbortController[]> {
    const key = this.ownerKey(obj)
    let m = this.activeInvokesByOwner.get(key)
    if (!m) {
      m = new Map()
      this.activeInvokesByOwner.set(key, m)
    }
    return m
  }

  /**
   * W4.1 #2 — the current owner's per-leaf invoke-restart counter map (created on
   * first access). Keyed by the owner adaptee like every other per-owner map, so
   * one owner's abort-restart budget is isolated from another's and a commit can
   * clear ONLY the committing owner's counters (see {@link commitConfiguration}).
   */
  private restartCountsFor(obj?: Adapter<any>): Map<string, number> {
    const key = this.ownerKey(obj)
    let m = this.invokeRestartCountByOwner.get(key)
    if (!m) {
      m = new Map()
      this.invokeRestartCountByOwner.set(key, m)
    }
    return m
  }

  /** П6 — the current owner's per-state entry-time map. */
  private entryTimesFor(obj?: Adapter<any>): Map<string, number> {
    const key = this.ownerKey(obj)
    let m = this.stateEntryTimesByOwner.get(key)
    if (!m) {
      m = new Map()
      this.stateEntryTimesByOwner.set(key, m)
    }
    return m
  }

  /** П6 — the current owner's per-state history map. */
  private historyFor(obj?: Adapter<any>): Map<StateName, string> {
    const key = this.ownerKey(obj)
    let m = this.historyByOwner.get(key)
    if (!m) {
      m = new Map()
      this.historyByOwner.set(key, m)
    }
    return m
  }

  /**
   * П6 — seed the PRIMARY owner's history map wholesale (deserialization /
   * restore paths that previously assigned `this.historyMap = new Map(…)`).
   */
  private seedHistory(map: Map<StateName, string>): void {
    this.historyByOwner.set(this.ownerKey(this.adaptee), map)
  }

  /** П6 — seed the PRIMARY owner's entry-time map wholesale (restore paths). */
  private seedEntryTimes(map: Map<string, number>): void {
    this.stateEntryTimesByOwner.set(this.ownerKey(this.adaptee), map)
  }

  private enqueueEvent(
    eventName: string,
    obj: Adapter<PropertiesOf<TOwner>>,
    args: any[],
    type: 'internal' | 'external',
  ): Promise<boolean> {
    // П3: a reentrant external `fireEvent` issued from WITHIN the processing
    // stack (an onEnter/onExit/onTransition/guard that does `await
    // sm.fireEvent(...)`) can never be drained — the single-threaded drain is
    // already suspended on that very action, the reentrant event sits behind it
    // forever, the outer promise never settles, and the public API
    // (canFireEvent/getAvailableEvents) lies. Reject it immediately with a clear
    // error.
    //
    // Detection is PRECISE via AsyncLocalStorage, NOT the coarse `isProcessing`
    // flag. `isProcessing` stays true through EVERY `await` of the drain
    // (including an `await` inside an async onEnter), so it falsely flagged
    // LEGITIMATE external events that merely landed in that window — an
    // independent timer/IO callback, an `onError`-issued fireEvent, or a caller
    // woken by `resolve()` before the internal cascade finished draining. The
    // external queue exists PRECISELY to accept events "while busy". Instead, the
    // drain tags the actions/guards it runs with its epoch; a TRUE reentrant call
    // runs on that logical stack and its async context carries the currently
    // active epoch, whereas an independent async callback carries none. The
    // internal `raiseEvent` path (used by invoke timers and `done.state.*`
    // completion) bypasses enqueueEvent entirely and stays the legal way to
    // post an event from within an action.
    if (
      type === 'external' &&
      this.activeDrainEpoch !== null &&
      this.drainContext.getStore() === this.activeDrainEpoch
    ) {
      const _sr = this.safeGetCurrentState(obj)
      return Promise.reject(
        new StateMachineError(
          'Reentrant fireEvent from within an action/guard is not supported; ' +
            'model the follow-up as an internal transition (an `invoke` timer or a ' +
            '`done.state.*` completion event), or dispatch it from an independent ' +
            'async callback (e.g. a timer/IO continuation) rather than inline',
          {
            ...(_sr !== undefined ? { state: _sr } : {}),
            event: eventName,
          },
        ),
      )
    }
    if (
      this.externalQueue.length + this.internalQueue.length >=
      this.maxQueueDepth
    ) {
      const _s0 = this.getCurrentState(obj)
      return Promise.reject(
        new StateMachineError('Event queue overflow — possible infinite loop', {
          /* c8 ignore next */
          ...(_s0 !== undefined ? { state: _s0 } : {}),
          event: eventName,
        }),
      )
    }

    if (type === 'external') {
      return new Promise<boolean>((resolve, reject) => {
        this.externalQueue.push({
          id: `ext_${++this.eventIdCounter}`,
          eventName,
          obj,
          args,
          resolve,
          reject,
          timestamp: this.clock(),
          type: 'external',
        })
        this.scheduleProcessing()
      })
    }

    /* c8 ignore next 7 */
    this.internalQueue.push({
      id: `int_${++this.eventIdCounter}`,
      eventName,
      obj,
      args,
      timestamp: this.clock(),
      type: 'internal',
    })
    /* c8 ignore next */
    return Promise.resolve(true)
  }

  /**
   * SPEC §7: enqueue an external event whose caller wants the detailed
   * {@link FireResult} rather than a bare boolean. Shares the reentrancy and
   * overflow preconditions with {@link enqueueEvent} (both are genuine
   * programming errors and still REJECT), but on the normal path the drain
   * settles the caller via `resolveDetailed` with the FireResult the transition
   * computes — including the non-throwing `no-transition` outcome.
   */
  private enqueueDetailedEvent(
    eventName: string,
    obj: Adapter<PropertiesOf<TOwner>>,
    args: any[],
  ): Promise<FireResult> {
    if (
      this.activeDrainEpoch !== null &&
      this.drainContext.getStore() === this.activeDrainEpoch
    ) {
      const _sr = this.safeGetCurrentState(obj)
      return Promise.reject(
        new StateMachineError(
          'Reentrant fireEventDetailed from within an action/guard is not ' +
            'supported; model the follow-up as an internal transition, or ' +
            'dispatch it from an independent async callback rather than inline',
          {
            ...(_sr !== undefined ? { state: _sr } : {}),
            event: eventName,
          },
        ),
      )
    }
    if (
      this.externalQueue.length + this.internalQueue.length >=
      this.maxQueueDepth
    ) {
      const _s0 = this.getCurrentState(obj)
      return Promise.reject(
        new StateMachineError('Event queue overflow — possible infinite loop', {
          /* c8 ignore next */
          ...(_s0 !== undefined ? { state: _s0 } : {}),
          event: eventName,
        }),
      )
    }
    return new Promise<FireResult>((resolve, reject) => {
      this.externalQueue.push({
        id: `ext_${++this.eventIdCounter}`,
        eventName,
        obj,
        args,
        // `reject` also settles the boolean path if applyTransition throws.
        reject,
        resolveDetailed: resolve,
        detailed: true,
        timestamp: this.clock(),
        type: 'external',
      })
      this.scheduleProcessing()
    })
  }

  /**
   * W9/Г1 — push ONE engine-internal event onto the internal queue AND make that
   * raise OBSERVABLE on the lifecycle channel (`kind:'raise'`).
   *
   * ## Why the emission lives HERE and not at the call sites
   * `raiseEvent` is the SINGLE private funnel through which every engine-internal
   * event enters the queue. Emitting inside it makes the observation STRUCTURALLY
   * complete: a future sixth raise site cannot "forget" to report itself, because
   * {@link RaiseOrigin} is a REQUIRED parameter — omitting it is a compile error,
   * not a silent observability hole.
   *
   * ## Why the raise must be observable at all
   * A raised event that matches NO candidate transition records NOTHING anywhere
   * else: `selectTransition` writes no commit, no refusal and no guard record when
   * `rejected.length === 0`. From outside, "the engine raised `done.state.<C>` and
   * nothing was listening" was therefore INDISTINGUISHABLE from "the engine never
   * raised it" — which is precisely why the I-5 parallel-join oracle could not have
   * sound teeth. This record closes that gap on the ENGINE side, so the oracle can
   * COUNT raises instead of re-implementing selection semantics.
   *
   * The record is an ADJACENT `begin`+`end` pair (the `invoke.abort` precedent): a
   * raise is an instantaneous point, and widening `edge` would blur the
   * "`begin` without `end` = HUNG callback" contract. `args` are NOT carried (see
   * {@link LifecycleEvent.event}).
   */
  private raiseEvent(
    eventName: string,
    obj: Adapter<PropertiesOf<TOwner>>,
    origin: RaiseOrigin,
    ...args: any[]
  ): void {
    this.internalQueue.push({
      id: `int_${++this.eventIdCounter}`,
      eventName,
      obj,
      args,
      timestamp: this.clock(),
      type: 'internal',
    })
    // Same near-zero-when-unsubscribed discipline as every other emission site:
    // one boolean test, and NOTHING is allocated for an unsubscribed machine.
    if (this.lifecycleEnabled) {
      const owner = this.ownerKey(obj)
      const ctx = { event: eventName }
      this.emitLifecycle('raise', origin.hook, origin.state, owner, origin.microstep, 'begin', ctx)
      this.emitLifecycle('raise', origin.hook, origin.state, owner, origin.microstep, 'end', ctx)
    }
  }

  private scheduleProcessing(): void {
    /* c8 ignore next */
    if (this.isProcessing) return
    queueMicrotask(() => this.processQueues())
  }

  private async processQueues(): Promise<void> {
    /* c8 ignore next */
    if (this.isProcessing) return
    this.isProcessing = true
    // П3: stamp this drain with a fresh epoch so the actions/guards it runs (all
    // wrapped in `drainContext.run(epoch, …)` below) can be distinguished, via
    // AsyncLocalStorage, from independent async callbacks — see `enqueueEvent`.
    const epoch = ++this.drainEpoch
    this.activeDrainEpoch = epoch
    // П8: run-away bound is counted PER DRAIN — the number of transitions this
    // single continuous drain has processed — NOT the recursion depth around one
    // `await`. The old `transitionDepth++/--` around a single await could only
    // ever reach {0,1}, so maxTransitionDepth was unreachable by construction
    // and a self-sustaining internal loop (queue held at 0-1) starved the
    // macrotask queue forever. A flat per-drain iteration counter closes that.
    this.transitionDepth = 0

    try {
      while (this.internalQueue.length > 0 || this.externalQueue.length > 0) {
        if (this.transitionDepth >= this.maxTransitionDepth) {
          const _s1 = this.safeGetCurrentState()
          const runawayCtx: ErrorContext = {
            ...(_s1 !== undefined ? { state: _s1 } : {}),
            event: 'processQueues',
          }
          const error = new StateMachineError(
            'Max transition depth exceeded — possible infinite loop',
            runawayCtx,
          )
          // П8: the run-away MUST be OBSERVABLE (monitor / onError), not a silent
          // self-limit and not a floating `unhandledRejection` out of the drain
          // microtask — the simulator has to see it as a violation, not silence.
          this.reportRuntimeError(error, runawayCtx, this.adaptee)
          // Pending EXTERNAL callers must be settled, never left hanging.
          while (this.externalQueue.length > 0) {
            const evt = this.externalQueue.shift()!
            evt.reject?.(error)
          }
          this.internalQueue.length = 0
          break
        }

        if (this.internalQueue.length > 0) {
          // П8: the run-away bound counts ONLY internal (raised) transitions —
          // a self-sustaining loop is an ACTION re-raising the same event. An
          // EXTERNAL event is a fresh RTC macrostep (see the external branch,
          // which resets the counter), so a legitimate synchronous batch of
          // >100 external fireEvent calls drained in one processQueues pass must
          // NOT trip the bound. Incrementing before the branch (as the first П8
          // fix did) counted external events too and falsely rejected the 101st.
          this.transitionDepth++
          const evt = this.internalQueue.shift()!
          try {
            await this.drainContext.run(epoch, () =>
              this.executeQueuedTransition(evt),
            )
          } catch (error) {
            // П2: a throw in the INTERNAL branch (e.g. an invoke timer that
            // raised an unknown event, or a `done.state.*` completion event with
            // no matching transition) must NOT kill the drain nor escape the
            // floating `queueMicrotask(processQueues)` as a real process
            // `unhandledRejection`. Report it through the OBSERVABLE channel and
            // keep draining the remaining queued events.
            const err = error instanceof Error ? error : new Error(String(error))
            const _s = this.safeGetCurrentState(evt.obj)
            this.reportRuntimeError(
              err,
              {
                ...(_s !== undefined ? { state: _s } : {}),
                event: String(evt.eventName),
              },
              evt.obj,
            )
          }
        } else {
          // An external event begins a fresh RTC macrostep — reset the run-away
          // counter so a long batch/stream of external events never accumulates
          // toward maxTransitionDepth (that bound is for internal self-loops).
          this.transitionDepth = 0
          const evt = this.externalQueue.shift()!
          // П3: settle the caller OUTSIDE `drainContext.run` — the run wraps only
          // the transition's actions/guards, so a reentrant `fireEvent` from
          // within them is detected, while the caller's woken continuation stays
          // free of this drain's epoch.
          let result: boolean | undefined
          let threw = false
          let thrownError: unknown
          try {
            result = await this.drainContext.run(epoch, () =>
              this.executeQueuedTransition(evt),
            )
          } catch (error) {
            threw = true
            thrownError = error
          }
          if (threw) {
            // A genuine apply/runtime error rejects BOTH the boolean and the
            // detailed callers (evt.reject is set on both paths).
            evt.reject?.(thrownError)
          } else if (evt.detailed) {
            // SPEC §7: settle `fireEventDetailed` with the FireResult that
            // executeQueuedTransition wrote (no-candidate/guard cases never
            // threw, so this branch, not reject, is taken).
            evt.resolveDetailed?.(
              evt.detailResult ?? { fired: false, reason: 'no-transition' },
            )
          } else {
            evt.resolve?.(result as boolean)
          }
        }
      }
    } finally {
      this.isProcessing = false
      this.activeDrainEpoch = null
      this.transitionDepth = 0
    }
  }

  /**
   * П2 / П8: route a runtime/internal-drain error to an OBSERVABLE channel
   * (`monitor.recordError` and/or the config-level `onError`) WITHOUT letting it
   * escape the floating drain microtask as a process `unhandledRejection`. This
   * is the visibility contract the simulator (W5 sim A1) relies on to see a
   * failure as a violation instead of silence. Never throws.
   */
  private reportRuntimeError(
    error: Error,
    context: ErrorContext,
    obj?: Adapter<PropertiesOf<TOwner>>,
  ): void {
    // Error reporting runs OUTSIDE the drain's AsyncLocalStorage context. This
    // method is invoked synchronously from within the drain (activeDrainEpoch is
    // set, getStore() carries the epoch), and an `onError` handler is a
    // legitimate error-recovery point that may issue a fresh external
    // `fireEvent`. Without exiting the context that fire would inherit the drain
    // epoch and be FALSELY rejected as reentrant (П3 case б) — yet the drain
    // does NOT await onError, so a queued recovery event would in fact be
    // drained. exit() clears getStore() so such a fire queues normally, while a
    // TRUE reentrant (await fireEvent directly inside onEnter/guard) still runs
    // under the epoch and is still rejected.
    this.drainContext.exit(() =>
      this.reportRuntimeErrorInContextFree(error, context, obj),
    )
  }

  private reportRuntimeErrorInContextFree(
    error: Error,
    context: ErrorContext,
    obj?: Adapter<PropertiesOf<TOwner>>,
  ): void {
    // Tracks whether the error reached ANY observable channel, so the П2 floor
    // below only fires when it would otherwise vanish silently.
    let surfaced = false
    // Channel #1 — monitor.recordError, gated by the error handler exactly like
    // the external-branch path in applyTransition. П2 dedup: if the error was
    // ALREADY recorded where it was caught (executeQueuedTransition), do NOT
    // record it a SECOND time — doubled counters are fatal for the quantitative
    // simulator oracles (W5). It was still surfaced, so the floor stays off.
    if (this.errorHandler.isEnabled()) {
      const alreadyReported =
        typeof error === 'object' &&
        error !== null &&
        (error as unknown as Record<symbol, unknown>)[
          RUNTIME_ERROR_REPORTED
        ] === true
      if (!alreadyReported) {
        try {
          this.monitor.recordError(error, context)
        } catch {
          /* a monitor sink must never break the drain */
        }
      }
      surfaced = true
    }
    // Channel #2 — config-level onError (best-effort). A rejecting/throwing
    // handler is logged, never re-thrown into the drain.
    if (this.onError !== undefined) {
      const target = (obj ?? this.adaptee) as unknown as
        | Adapter<TOwner>
        | undefined
      if (target) {
        surfaced = true
        try {
          const handler = this.processError(target, context, this.onError)
          const r = handler(target, error) as unknown
          if (r instanceof Promise) {
            r.catch((e) =>
              this.logger.error(
                'onError handler rejected',
                context,
                e instanceof Error ? e : new Error(String(e)),
              ),
            )
          }
        } catch (e) {
          this.logger.error(
            'onError handler threw',
            context,
            e instanceof Error ? e : new Error(String(e)),
          )
        }
      }
    }
    // П2 (silent-hole floor): with the error handler disabled AND no config-level
    // `onError`, both channels above are inert, so a drain error would vanish with
    // NO trace at all — a REGRESSION from the loud `unhandledRejection` this code
    // replaced. Guarantee at least a `logger.error` so a runtime failure is never
    // completely silent.
    if (!surfaced) {
      this.logger.error(
        'Unhandled state machine runtime error (no monitor/onError sink)',
        context,
        error,
      )
    }
  }

  private async executeQueuedTransition(
    queuedEvent: QueuedEvent<TOwner>,
  ): Promise<boolean> {
    const { eventName, obj, args } = queuedEvent
    const targetObj = obj

    let currentStateRaw = this.getCurrentState(targetObj)
    if (!currentStateRaw) {
      this.setInitialState(this.initialState as string, targetObj)
      currentStateRaw = this.getCurrentState(targetObj)
    }
    /* c8 ignore next */
    const currentState: string = currentStateRaw ?? ''

    // PERF-01: parse the active configuration ONCE for this fireEvent and reuse
    // it across every candidate's eligibility check and for dominance's active
    // leaves — the naive path re-parsed `currentState` per transition.
    const parsed = this.parseCompositeState(currentState)
    const activeLeaves = Array.from(parsed.values())

    let event = this.events.get(eventName as keyof SMConfig['events'])
    // SPEC §4 / PERF-07: candidates come from the pre-sorted per-event list;
    // filtering by eligibility is stable, so the ordering survives untouched.
    let candidates = event
      ? (this.orderedTransitions.get(String(eventName)) ?? []).filter((p) =>
          this.isTransitionPossible(p.transition, currentState, parsed),
        )
      : []

    // D11: engine-generated `done.state.<id>` completion events must NEVER fall
    // through to a user `from: '*'` wildcard transition — that would fire a
    // spurious transition on a machine that uses `*` as a catch-all. They only
    // ever match an explicitly-declared `done.state.<id>` event (handled above).
    const isEngineDoneEvent = String(eventName).startsWith('done.state.')
    if (!candidates.length && !isEngineDoneEvent) {
      const wildcardEvent = this.events.get('*' as keyof SMConfig['events'])
      if (wildcardEvent) {
        const wildcardCandidates = (
          this.orderedTransitions.get('*') ?? []
        ).filter((p) =>
          this.isTransitionPossible(p.transition, currentState, parsed),
        )
        if (wildcardCandidates.length > 0) {
          event = wildcardEvent
          candidates = wildcardCandidates
        }
      }
    }

    if (!event || !candidates.length) {
      // SPEC §7: `fireEventDetailed` NEVER throws on no candidate — it resolves
      // `{ fired:false, reason:'no-transition' }`. `fireEvent` keeps throwing.
      if (queuedEvent.detailed) {
        queuedEvent.detailResult = { fired: false, reason: 'no-transition' }
        return false
      }
      throw new StateMachineError(
        `Invalid event: ${eventName} for state: ${currentState}`,
        { state: currentState, event: eventName },
      )
    }

    // SPEC §6.1 (OTS) — build the OPTIMAL TRANSITION SET: for each active atomic
    // leaf (documentIndex order, W2a) climb its ancestor chain and pick the first
    // guard-passing candidate governing it (via {@link selectTransition}: W3-B
    // descendant-dominance + W3-B.1 lazy guard ancestor fallback), claiming the
    // leaves it covers so each region contributes at most one transition. The
    // single-region case (exactly one active leaf) collapses to the previous
    // single `selectTransition` call — selection stays characterization-stable.
    const { enabled, rejected } = await this.computeEnabledSet(
      targetObj,
      candidates,
      activeLeaves,
      args,
    ).catch((error) => {
      this.logger.error(
        'Error determining allowed transition',
        { event: eventName, state: currentState },
        /* c8 ignore next */
        error instanceof Error ? error : new Error(String(error)),
      )
      return {
        enabled: [] as Array<{
          transition: Transition<TOwner, SMConfig['states']>
          source: string
          coveredLeaves: string[]
          order: number
        }>,
        rejected: [] as Array<{
          transition: string
          reason: 'guard-rejected' | 'guard-error'
          error?: Error
        }>,
      }
    })

    if (enabled.length === 0) {
      // П9/EO-3: a guard REJECTION is an observable FAILURE path, not a no-op —
      // record it as an unsuccessful transition so the W5 sim oracle and the
      // health metrics see the refusal. A pure no-candidate case
      // (rejected.length === 0) is genuinely "nothing to do" and is NOT recorded.
      // A guard-ERROR is EXCLUDED here: it was already surfaced via
      // monitor.recordError in selectTransition (F7); recording it again as a
      // failed transition double-counts it in the default monitor (errorCount=2,
      // errorRate>100%). Only a clean guard-rejected (no error) is recorded here.
      const hadGuardError = rejected.some((r) => r.reason === 'guard-error')
      if (rejected.length > 0 && !hadGuardError) {
        this.monitor.recordTransition(0, false, {
          fromState: currentState,
          toState: currentState,
          eventName: String(eventName),
        })
      }
      // SPEC §7: distinguish guard-error from an honest guard-rejected (F4).
      if (queuedEvent.detailed) {
        const hadError = rejected.some((r) => r.reason === 'guard-error')
        queuedEvent.detailResult = {
          fired: false,
          reason: hadError
            ? 'guard-error'
            : rejected.length > 0
              ? 'guard-rejected'
              : 'no-transition',
          ...(rejected.length > 0 ? { rejected } : {}),
        }
      }
      return false
    }

    // SPEC §6.2 — remove conflicting transitions (overlapping exit sets): a
    // descendant source preempts its ancestor, otherwise the earlier leaf
    // (documentIndex) wins.
    const fired = this.resolveConflicts(currentState, enabled)

    // SPEC §6.3 — execute the whole set as ONE atomic microstep (unified exit /
    // enter / commit / timer teardown+arm / done.state), with timer teardown and
    // re-arm strictly AFTER the point of no return (П5).
    const committed = await this.applyMicrostep(
      targetObj as any,
      currentState,
      fired,
      args,
      eventName as keyof SMConfig['events'],
      event,
    ).catch((error) => {
      this.logger.error(
        'Error applying transition',
        {
          event: eventName,
          state: currentState,
          transition: fired
            .map((f) => `${f.transition.from} -> ${f.transition.to}`)
            .join(', '),
        },
        /* c8 ignore next */
        error instanceof Error ? error : new Error(String(error)),
      )
      if (this.errorHandler.isEnabled()) {
        this.monitor.recordError(
          error instanceof Error ? error : new Error(String(error)),
          { state: currentState, event: eventName },
        )
        // П2 dedup: mark this error as ALREADY recorded so that when it is
        // rethrown into the INTERNAL-branch catch of processQueues,
        // `reportRuntimeError` does NOT emit a SECOND `monitor.recordError` for
        // the same failure. External events settle via `evt.reject` (no second
        // report), so this only affects the internal-drain path — exactly the
        // double-count the simulator oracles (W5) must not see. Marking the
        // ORIGINAL rethrown object keeps the flag visible downstream.
        if (typeof error === 'object' && error !== null) {
          try {
            ;(error as Record<symbol, unknown>)[RUNTIME_ERROR_REPORTED] = true
          } catch {
            /* frozen/exotic error object — dedup simply degrades to prior behavior */
          }
        }
      }
      throw error // Propagate error to caller (e.g. fireEvent rejection)
    })

    if (!committed) {
      // abort-observability (W3-C.1 / EO-5 residual): a candidate WAS selected and
      // the microstep BEGAN, but did not commit (onExit threw under
      // abortOnExitError, or the target configuration was contradictory). This is
      // observably DISTINCT from "no candidate matched": report reason 'aborted'
      // (§7 union) and record an unsuccessful transition so the W5 oracle and the
      // health metrics see the cancelled microstep — not a silent no-transition.
      this.monitor.recordTransition(0, false, {
        fromState: currentState,
        toState: currentState,
        eventName: String(eventName),
      })
      if (queuedEvent.detailed) {
        queuedEvent.detailResult = { fired: false, reason: 'aborted' }
      }
      return false
    }

    if (committed.kind === 'error-state') {
      // W4.1 #3: the requested target FAILED (onEnter threw) and the machine
      // recovered into `errorState`. applyMicrostep already recorded a FAILED
      // transition on the monitor and committed the errorState. The requested
      // transition did NOT fire — so the detailed channel MUST report fired:false
      // (reason 'error-state'), matching the monitor and the observable state.
      // Reporting fired:true here (the old behaviour) made two public channels
      // contradict each other.
      if (queuedEvent.detailed) {
        queuedEvent.detailResult = { fired: false, reason: 'error-state' }
      }
      return false
    }

    // applyMicrostep already committed the configuration (history-resolved) as
    // the single point of no return — do NOT re-write it here.
    if (queuedEvent.detailed) {
      // CONTRACT: fireEvent boolean = "at least one transition fired";
      // fireEventDetailed.transitions = EVERY fired transition (SPEC §7).
      queuedEvent.detailResult = {
        fired: true,
        transitions: fired.map((f) => ({
          event: String(eventName),
          from: f.transition.from as string,
          to: (f.transition.to === '*' ? currentState : f.transition.to) as string,
        })),
      }
    }
    return true
  }

  /**
   * SPEC §6.1 (OTS) — compute the Optimal Transition Set for one event over the
   * active configuration. Iterates the active atomic leaves in documentIndex
   * order (W2a); for each still-UNCLAIMED leaf it selects the first guard-passing
   * candidate that GOVERNS the leaf (its {@link computeCoverMap} covers it),
   * ordered/guarded by {@link selectTransition} (W3-B descendant dominance +
   * W3-B.1 lazy ancestor fallback — the per-node ancestor climb collapses into
   * selectTransition, which already tries a governing descendant before the
   * ancestor it dominates). The chosen transition's covered leaves are marked
   * claimed so each orthogonal region yields at most one transition.
   */
  private async computeEnabledSet(
    obj: Adapter<PropertiesOf<TOwner>>,
    candidates: PreparedTransition<TOwner, SMConfig['states']>[],
    activeLeaves: string[],
    args: unknown[],
  ): Promise<{
    enabled: Array<{
      transition: Transition<TOwner, SMConfig['states']>
      source: string
      coveredLeaves: string[]
      order: number
    }>
    rejected: Array<{
      transition: string
      reason: 'guard-rejected' | 'guard-error'
      error?: Error
    }>
  }> {
    const enabled: Array<{
      transition: Transition<TOwner, SMConfig['states']>
      source: string
      coveredLeaves: string[]
      order: number
    }> = []
    const rejected: Array<{
      transition: string
      reason: 'guard-rejected' | 'guard-error'
      error?: Error
    }> = []
    const claimed = new Set<string>()
    // Per-microstep guard memo (see field docs): each candidate's guard runs at
    // most once even when it governs several leaves.
    this.microstepGuardCache = new Map()
    // W8/V1 — the microstep BEGINS here, at the first guard evaluation, NOT at
    // {@link applyMicrostep}: guards run during selection, before the transition
    // set exists, and a selection attempt that ends with NO enabled transition is
    // still a distinct microstep whose guard records must not be folded into the
    // previous (committed) one. Incrementing here makes a guard and the enter /
    // exit hooks it selects share ONE id, which is what a consumer correlates on.
    this.currentMicrostep = ++this.microstepCounter

    // Active leaves in canonical documentIndex order (W2a) so region priority
    // is deterministic and independent of the activation path.
    const leaves = [...activeLeaves].sort(
      (a, b) =>
        (this.model?.documentIndexOf(a) ?? Number.POSITIVE_INFINITY) -
        (this.model?.documentIndexOf(b) ?? Number.POSITIVE_INFINITY),
    )

    // Memoize cover maps: the same candidate is inspected for several leaves.
    const coverCache = new Map<
      PreparedTransition<TOwner, SMConfig['states']>,
      Map<string, string>
    >()
    const coverOf = (c: PreparedTransition<TOwner, SMConfig['states']>) => {
      let m = coverCache.get(c)
      if (!m) {
        m = this.computeCoverMap(c.transition.from as string, activeLeaves)
        coverCache.set(c, m)
      }
      return m
    }

    try {
      for (const leaf of leaves) {
        if (claimed.has(leaf)) continue
        const governing = candidates.filter((c) => coverOf(c).has(leaf))
        if (governing.length === 0) continue
        const { selected, rejected: rej } = await this.selectTransition(
          obj,
          governing,
          activeLeaves,
          ...args,
        )
        // Dedup rejected by transition label: a candidate governing several
        // leaves is offered to selectTransition once per leaf, so the same
        // rejection would otherwise appear once per governed leaf (§7 contract:
        // one entry per transition). Prefer a record that carries `error`
        // (guard-error) over a bare guard-rejected for the same transition.
        for (const r of rej) {
          const prev = rejected.find((p) => p.transition === r.transition)
          if (!prev) {
            rejected.push(r)
          } else if (prev.error === undefined && r.error !== undefined) {
            prev.reason = r.reason
            prev.error = r.error
          }
        }
        if (!selected) continue
        const cover = this.computeCoverMap(selected.from as string, activeLeaves)
        const coveredLeaves = Array.from(cover.keys())
        // Selection precedence: the candidate's index in the pre-sorted
        // (priority ↓, specificity ↑, docIndex ↑) list — the same order
        // {@link selectTransition} would pick a single winner by. Used as the
        // conflict tiebreak between incomparable sources (SPEC §4.4).
        const order = candidates.findIndex((c) => c.transition === selected)
        enabled.push({
          transition: selected,
          source: selected.from as string,
          coveredLeaves,
          order: order < 0 ? Number.POSITIVE_INFINITY : order,
        })
        for (const l of coveredLeaves) claimed.add(l)
      }
    } finally {
      this.microstepGuardCache = undefined
    }

    return { enabled, rejected }
  }

  /**
   * SPEC §6.2 — conflict removal over an enabled set. Two transitions conflict
   * when their exit-sets ({@link exitSetForTransition}) intersect. On a conflict:
   * if one source is a STRICT DESCENDANT of the other, the descendant preempts
   * the ancestor (drop the ancestor — SCXML descendant preemption); otherwise the
   * sources are incomparable (sibling regions both targeting a common ancestor's
   * exterior) and the WINNER is the one selection would have picked as a single
   * transition — lower `order` (priority ↓, specificity ↑, DECLARATION docIndex
   * ↑, §4.4). Using declaration order (not leaf documentIndex) keeps the
   * single-selection semantics the selection_scxml/characterization gates pin:
   * two cross-region transitions whose targets both exit the shared parent still
   * resolve to the FIRST-DECLARED. Disjoint-exit transitions (the OTS common
   * case — one per region, targets stay inside each region) never intersect, so
   * they all survive and fire together. Resolves one conflict at a time and
   * restarts — deterministic and total for the tiny per-event set.
   */
  private resolveConflicts(
    currentState: string,
    enabled: Array<{
      transition: Transition<TOwner, SMConfig['states']>
      source: string
      coveredLeaves: string[]
      order: number
    }>,
  ): Array<{
    transition: Transition<TOwner, SMConfig['states']>
    source: string
    coveredLeaves: string[]
    order: number
  }> {
    if (enabled.length <= 1) return enabled

    const exitSetOf = new Map<(typeof enabled)[number], Set<string>>()
    for (const item of enabled) {
      exitSetOf.set(
        item,
        new Set(this.exitSetForTransition(currentState, item.transition)),
      )
    }
    const intersects = (a: Set<string>, b: Set<string>): boolean => {
      for (const x of a) if (b.has(x)) return true
      return false
    }
    const strictDescendant = (child: string, parent: string): boolean =>
      child !== parent && child.startsWith(parent + '.')

    const items = enabled.slice()
    let changed = true
    while (changed) {
      changed = false
      outer: for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const A = items[i]!
          const B = items[j]!
          if (!intersects(exitSetOf.get(A)!, exitSetOf.get(B)!)) continue
          if (strictDescendant(A.source, B.source)) {
            // A's source is a descendant of B's → A preempts B.
            items.splice(j, 1)
          } else if (strictDescendant(B.source, A.source)) {
            // B's source is a descendant of A's → B preempts A.
            items.splice(i, 1)
          } else {
            // Incomparable sources: keep the one selection would pick first.
            if (A.order <= B.order) items.splice(j, 1)
            else items.splice(i, 1)
          }
          changed = true
          break outer
        }
      }
    }
    return items
  }

  /**
   * SPEC §6.2 — the active states a single transition would EXIT: the exit
   * portion of the enter/exit delta between the current configuration and the
   * configuration produced by applying only this transition (history-aware). A
   * `to:'*'` self-transition exits nothing.
   */
  private exitSetForTransition(
    currentState: string,
    transition: Transition<TOwner, SMConfig['states']>,
  ): string[] {
    const raw = transition.to as string
    if (raw === '*') return []
    let afterT: string
    try {
      afterT = this.orderComposite(
        this.previewCommitState(currentState, raw as StateName),
      )
    } catch {
      return []
    }
    return this.computeEnterExitSets(currentState, afterT).exitStates
  }

  /**
   * Fires an event to trigger a state transition.
   *
   * @param eventName - The name of the event to fire. Use '*' for wildcard events.
   * @param args - Additional arguments to pass to guards, actions, and callbacks.
   * @returns Promise<boolean> - True if a transition occurred, false otherwise.
   *
   * @throws StateMachineError if the event is invalid or no transition is possible (unless configured otherwise).
   *
   * @example
   * const success = await sm.fireEvent('submit', payload);
   */
  /**
   * W8/V10 diagnostic. A non-Adapter 2nd positional is an EVENT ARGUMENT, not an
   * owner — that is what makes `fireEvent(event, arg1, arg2)` work without an
   * adapter, so the owner stays the primary adaptee. A MULTI-OWNER caller who
   * passes a RAW object means it as the owner, but it is indistinguishable from a
   * payload: the event then resolves against the PRIMARY adaptee and typically
   * fails with a baffling `Invalid event: X for state: Y` naming a state the
   * caller's object was never in. Detect the tell-tale shape (a plain object
   * carrying this machine's `stateAttribute`) and say so. ADVISORY ONLY — the
   * argument is still forwarded verbatim, so a legitimate payload that happens to
   * carry that field keeps working.
   */
  private warnIfRawOwnerMisuse(obj: unknown, eventName: string): void {
    if (typeof obj !== 'object' || obj === null) return
    if (!(this.stateAttribute in (obj as Record<string, unknown>))) return
    // The COMMON and correct pattern `new StateMachine(cfg, obj)` +
    // `sm.fireEvent(e, obj)` passes the machine's OWN owner back in. The owner
    // resolved from it is the same object either way, so there is nothing to warn
    // about — only a DIFFERENT raw object is the multi-owner mistake.
    if (this.adaptee !== undefined && obj === this.ownerKey(this.adaptee)) return
    this.logger?.warn?.(
      `fireEvent('${eventName}'): the 2nd positional argument is a RAW object carrying '${String(this.stateAttribute)}'. It is passed as an EVENT ARGUMENT, not as the owner, so the event resolves against this machine's primary owner. For multi-owner use wrap it: fireEvent(event, new MemoryAdapter(obj)).`,
    )
  }

  /**
   * Cache of `rawOwner -> Adapter`, so the `*For` family does not allocate a fresh
   * adapter per call. Weak keys: a forgotten owner is collectable. Correct by
   * construction — every per-owner map keys on `ownerKey(adapter) === adaptee`, so
   * a freshly-wrapped adapter lands in the SAME timers/invokes/history buckets as
   * the object itself.
   */
  private readonly ownerAdapters = new WeakMap<object, Adapter<PropertiesOf<TOwner>>>()

  /** Normalize an owner (raw object or Adapter) to an Adapter. */
  private resolveOwnerAdapter(
    owner: PropertiesOf<TOwner> | Adapter<PropertiesOf<TOwner>>,
  ): Adapter<PropertiesOf<TOwner>> {
    if (isAdapter<PropertiesOf<TOwner>>(owner)) {
      return owner
    }
    const raw = owner as unknown as object
    let cached = this.ownerAdapters.get(raw)
    if (!cached) {
      cached = new MemoryAdapter(owner as PropertiesOf<TOwner>) as Adapter<PropertiesOf<TOwner>>
      this.ownerAdapters.set(raw, cached)
    }
    return cached
  }

  /**
   * Fire an event AGAINST AN EXPLICIT OWNER — the multi-owner form.
   *
   * ## Why this exists
   * `fireEvent(event, x, ...)` cannot tell a second OWNER from an event ARGUMENT:
   * a non-Adapter 2nd positional is (deliberately) treated as an argument, which is
   * what makes `fireEvent(event, arg1, arg2)` work. So driving a second object with
   * a raw `fireEvent` silently resolved against the PRIMARY owner.
   *
   * Here the ambiguity is removed STRUCTURALLY rather than by sniffing: slot 1 is
   * ALWAYS the owner, slots 3+ are ALWAYS arguments. A raw object is accepted and
   * wrapped internally (cached per object), so the caller needs no `MemoryAdapter`
   * ceremony — and because every per-owner structure keys on the adaptee, the
   * object keeps its own timers, invokes and history.
   *
   * @example
   * ```ts
   * const a = { state: 'idle' }, b = { state: 'idle' }
   * const sm = new StateMachine(config, a)
   * await sm.fireEventFor(a, 'go')   // moves a only
   * await sm.fireEventFor(b, 'go')   // moves b only
   * ```
   *
   * ## CAVEAT — the owner SLOT is structural, the owner KIND is a duck test
   * Which POSITION holds the owner is unambiguous, but deciding whether the value
   * in that position is already an `Adapter` or a raw object to be wrapped is NOT:
   * `resolveOwnerAdapter` asks `isAdapter` (`src/types.ts:700`), which is the duck
   * test `!!x && typeof x === 'object' && 'set' in x && 'get' in x` — nothing
   * more, and in particular it never inspects arity, prototype or `adaptee`. A raw
   * DOMAIN object that merely happens to expose `get`/`set` methods (a cache, a
   * `Map`-backed store, a config bag, an ORM record) therefore satisfies it and is
   * accepted AS an adapter: it is returned unwrapped, and the machine drives the
   * state through THAT object's own `get('state')`/`set('state', …)` rather than
   * through a `MemoryAdapter` over its properties. If those methods mean something
   * else (a key-value store, say), the state lands somewhere the caller does not
   * expect and no error is raised.
   *
   * If your owner type has `get`/`set` of its own, wrap it explicitly:
   * `sm.fireEventFor(new MemoryAdapter(owner), 'go')` — or give the machine a
   * real `Adapter` implementation for it.
   *
   * This is DOCUMENTED, not fixed. `isAdapter` is exported and load-bearing on
   * several other paths, so tightening it (e.g. also requiring an `adaptee`
   * accessor) is a behavioural change to a public surface and belongs to its own
   * deliberate decision, not to a drive-by edit. The same caveat applies to
   * {@link fireEventDetailedFor}, {@link canFireEventFor} and
   * {@link getAvailableEventsFor}, which share `resolveOwnerAdapter`.
   */
  public async fireEventFor(
    owner: PropertiesOf<TOwner> | Adapter<PropertiesOf<TOwner>>,
    eventName: keyof SMConfig['events'] | '*',
    ...args: unknown[]
  ): Promise<boolean> {
    return this.fireEvent(eventName, this.resolveOwnerAdapter(owner), ...args)
  }

  /** {@link fireEventDetailed} against an EXPLICIT owner — see {@link fireEventFor}. */
  public async fireEventDetailedFor(
    owner: PropertiesOf<TOwner> | Adapter<PropertiesOf<TOwner>>,
    eventName: keyof SMConfig['events'] | '*',
    ...args: unknown[]
  ): Promise<FireResult> {
    return this.fireEventDetailed(eventName, this.resolveOwnerAdapter(owner), ...args)
  }

  /** {@link canFireEvent} against an EXPLICIT owner — see {@link fireEventFor}. */
  public canFireEventFor(
    owner: PropertiesOf<TOwner> | Adapter<PropertiesOf<TOwner>>,
    eventName: keyof SMConfig['events'] | '*',
  ): boolean {
    return this.canFireEvent(eventName, this.resolveOwnerAdapter(owner))
  }

  /** {@link getAvailableEvents} for an EXPLICIT owner — see {@link fireEventFor}. */
  public getAvailableEventsFor(
    owner: PropertiesOf<TOwner> | Adapter<PropertiesOf<TOwner>>,
  ): string[] {
    return this.getAvailableEvents(this.resolveOwnerAdapter(owner))
  }

  public async fireEvent(
    eventName: keyof SMConfig['events'] | '*',
    ...args: any[]
  ): Promise<boolean>
  public async fireEvent(
    eventName: keyof SMConfig['events'] | '*',
    obj?: Adapter<PropertiesOf<TOwner>>,
    ...args: unknown[]
  ): Promise<boolean> {
    let targetObj: Adapter<PropertiesOf<TOwner>>
    if (!obj) {
      if (this.adaptee) targetObj = this.adaptee
      else
        throw new StateMachineError('no adaptee or object passed', {
          event: String(eventName),
        })
    } else if (!isAdapter(obj)) {
      this.warnIfRawOwnerMisuse(obj, String(eventName))
      args.unshift(obj)
      if (this.adaptee) targetObj = this.adaptee
      else
        throw new StateMachineError('no adaptee or object passed', {
          event: String(eventName),
        })
    } else {
      targetObj = obj
    }

    return this.enqueueEvent(String(eventName), targetObj, args, 'external')
  }

  /**
   * SPEC §7 — additive, NON-throwing counterpart to {@link fireEvent}. Returns a
   * {@link FireResult} discriminated union: on success `{ fired:true,
   * transitions }`; otherwise `{ fired:false, reason }` where `reason`
   * distinguishes `no-transition` (no candidate matched), `guard-rejected` (the
   * ordered candidates' guards all refused), and `guard-error` (a guard THREW —
   * now observably distinct from an honest refusal, closing F4).
   *
   * `fireEvent` is UNCHANGED and still returns `boolean` (throwing on no
   * candidate): a `{ fired:false }` object is truthy, so switching the return
   * shape would silently invert every `if (await sm.fireEvent(e))`.
   */
  public async fireEventDetailed(
    eventName: keyof SMConfig['events'] | '*',
    ...args: any[]
  ): Promise<FireResult>
  public async fireEventDetailed(
    eventName: keyof SMConfig['events'] | '*',
    obj?: Adapter<PropertiesOf<TOwner>>,
    ...args: unknown[]
  ): Promise<FireResult> {
    let targetObj: Adapter<PropertiesOf<TOwner>>
    if (!obj) {
      if (this.adaptee) targetObj = this.adaptee
      else
        throw new StateMachineError('no adaptee or object passed', {
          event: String(eventName),
        })
    } else if (!isAdapter(obj)) {
      this.warnIfRawOwnerMisuse(obj, String(eventName))
      args.unshift(obj)
      if (this.adaptee) targetObj = this.adaptee
      else
        throw new StateMachineError('no adaptee or object passed', {
          event: String(eventName),
        })
    } else {
      targetObj = obj
    }

    return this.enqueueDetailedEvent(String(eventName), targetObj, args)
  }

  public getQueueDepth(): {
    internal: number
    external: number
    total: number
  } {
    return {
      internal: this.internalQueue.length,
      external: this.externalQueue.length,
      total: this.internalQueue.length + this.externalQueue.length,
    }
  }

  public getQueuedEvents(): QueuedEventInfo[] {
    const now = this.clock()
    const mapEvent = (evt: QueuedEvent<TOwner>): QueuedEventInfo => ({
      id: evt.id,
      event: evt.eventName,
      age: now - evt.timestamp,
      type: evt.type,
    })
    return [
      ...this.internalQueue.map(mapEvent),
      ...this.externalQueue.map(mapEvent),
    ]
  }

  public isProcessingEvents(): boolean {
    return this.isProcessing
  }

  /**
   * Checks if an event can be fired in the current state.
   *
   * @param eventName - The name of the event to check.
   * @param adaptee - Optional adapter/object to check against (defaults to internal adaptee).
   * @returns boolean - True if the event has a valid transition from the current state (guards are not executed).
   */
  public canFireEvent(
    eventName: keyof SMConfig['events'] | '*',
    adaptee?: Adapter<PropertiesOf<TOwner>>,
  ): boolean {
    // W9/Г4: the parameter is TYPED as an Adapter but nothing enforced it at
    // runtime, so a raw object slipped through and was read via `getCurrentState`
    // as if it were one — silently yielding garbage instead of that object's state.
    // Normalize it (the `*For` family is the intended multi-owner entry point).
    const normalized =
      adaptee !== undefined && !isAdapter<PropertiesOf<TOwner>>(adaptee)
        ? this.resolveOwnerAdapter(adaptee as unknown as PropertiesOf<TOwner>)
        : adaptee
    const targetAdaptee = normalized || this.adaptee
    if (!targetAdaptee) return false

    const currentState = this.getCurrentState(targetAdaptee)
    const effectiveState =
      currentState === ''
        ? this.getInitialCompositeState(this.initialState as string)
        : currentState
    /* c8 ignore next */ if (effectiveState === undefined) return false

    const event = this.events.get(String(eventName))
    if (
      !event ||
      !event.transitions.some((t) =>
        this.isTransitionPossible(t, effectiveState),
      )
    ) {
      const wildcardEvent = this.events.get('*')
      if (wildcardEvent) {
        return wildcardEvent.transitions.some((t) =>
          this.isTransitionPossible(t, effectiveState),
        )
      }
      return false
    }

    return true
  }

  public getAvailableEvents(adaptee?: Adapter<PropertiesOf<TOwner>>): string[] {
    const available: string[] = []
    for (const [name] of this.events) {
      if (this.canFireEvent(name, adaptee)) {
        available.push(String(name))
      }
    }
    return available
  }

  public async reset(adaptee?: Adapter<PropertiesOf<TOwner>>): Promise<void> {
    const targetAdaptee = adaptee || this.adaptee
    if (!targetAdaptee) {
      const _s2 = this.getCurrentState()
      throw new StateMachineError('no adaptee', _s2 !== undefined ? { state: _s2 } : {})
    }

    // П6: reset only the target owner's records — resetting one attached object
    // must not tear down another object's live timers/operations.
    this.historyFor(targetAdaptee).clear()

    // Clear all active timers for this owner
    const ownerTimers = this.timersFor(targetAdaptee)
    for (const timers of ownerTimers.values()) {
      for (const id of timers) {
        this.clearTimer(id)
      }
    }
    ownerTimers.clear()
    // W3b: abort + drop this owner's in-flight invoke operations on reset.
    const ownerInvokes = this.invokesFor(targetAdaptee)
    for (const controllers of ownerInvokes.values()) {
      for (const controller of controllers) controller.abort()
    }
    ownerInvokes.clear()
    this.entryTimesFor(targetAdaptee).clear()

    this.setInitialState(this.initialState as string, targetAdaptee)
  }

  public getStateHistory(): Record<string, string> {
    return Object.fromEntries(this.historyFor(this.adaptee))
  }

  public getCurrentStateInfo(): StateInfo | undefined {
    const currentState = this.getCurrentState()
    if (currentState === undefined) return undefined

    const isComposite = currentState.includes('|')
    if (isComposite) {
      const activeStates = currentState.split('|').filter(Boolean)
      const regions = activeStates.map((s) => this.getRegionKey(s))
      return {
        name: currentState,
        isComposite: true,
        regions,
        children: activeStates,
      }
    }

    const state = this.states.get(currentState)
    /* c8 ignore next */ if (!state) return undefined

    const parent = currentState.includes('.')
      ? currentState.split('.').slice(0, -1).join('.')
      : undefined

    const children = this.getDirectChildren(currentState)
    const regions = state.regions ? Object.keys(state.regions) : undefined

    return {
      name: currentState,
      ...(state.display !== undefined ? { display: state.display } : {}),
      isComposite: Boolean(state.regions),
      ...(regions !== undefined ? { regions } : {}),
      ...(parent !== undefined ? { parent } : {}),
      ...(children.length ? { children } : {}),
    }
  }

  /**
   * Checks if the machine is in a specific state.
   * Supports hierarchical states (e.g. 'parent' matches 'parent.child').
   *
   * @param expectedState - The state name to check.
   * @param adaptee - Optional adapter to check against.
   * @returns boolean - True if the current state matches or is a substate of the expected state.
   */
  public isInState(
    expectedState: StateName,
    adaptee?: Adapter<PropertiesOf<TOwner>>,
  ): boolean {
    const currentState = this.getCurrentState(adaptee)
    if (!currentState) return expectedState === ''

    const currentParts = currentState.split('|').sort()
    const expectedParts = expectedState.split('|').sort()

    // D5: ancestor-aware matching — true when every expected '|'-part equals OR
    // is an ancestor (isParentState) of some active leaf. Keeps isInState('C')
    // and isInState('C.region') true after a composite root expands to leaves.
    const ancestorMatch = expectedParts.every((expectedPart) =>
      currentParts.some((leaf) => this.isParentState(expectedPart, leaf)),
    )
    if (ancestorMatch) return true

    if (currentParts.length !== expectedParts.length) return false

    return currentParts.every((part, index) => part === expectedParts[index])
  }

  public attachToObject(
    object: any,
    eventMap: { [key: string]: string },
  ): void {
    for (const objectEventName of Object.keys(eventMap)) {
      const stateMachineEventName = eventMap[objectEventName]
      /* c8 ignore next */ if (stateMachineEventName === undefined) continue
      if (typeof object.addEventListener === 'function') {
        object.addEventListener(objectEventName, (...args: any[]) => {
          this.fireEvent(stateMachineEventName, object, ...args).catch((e) =>
            this.logger.error(
              'Error firing event',
              {
                objectEventName,
                stateMachineEventName,
              },
              /* c8 ignore next */
              e instanceof Error ? e : new Error(String(e)),
            ),
          )
        })
      } else if (typeof object.on === 'function') {
        object.on(objectEventName, (...args: any[]) => {
          this.fireEvent(stateMachineEventName, object, ...args).catch((e) =>
            this.logger.error(
              'Error firing event',
              {
                objectEventName,
                stateMachineEventName,
              },
              /* c8 ignore next */
              e instanceof Error ? e : new Error(String(e)),
            ),
          )
        })
      } else {
        object[`on${objectEventName}`] = async (...args: any[]) => {
          return this.fireEvent(stateMachineEventName, object, ...args).catch(
            (e) =>
              this.logger.error(
                'Error firing event',
                {
                  objectEventName,
                  stateMachineEventName,
                },
                /* c8 ignore next */
                e instanceof Error ? e : new Error(String(e)),
              ),
          )
        }
      }
    }
  }

  // Методы для работы с состоянием
  public async saveState(adapter?: StatePersistenceAdapter) {
    const targetAdapter = adapter || this.persistenceAdapter
    if (!targetAdapter) {
      return
    }

    const currentState = this.getCurrentState() ?? ''
    const history = Object.fromEntries(this.historyFor(this.adaptee))
    const stateData = {
      currentState,
      history,
      stateEntryTimes: Object.fromEntries(this.entryTimesFor(this.adaptee)),
    }

    await targetAdapter.save(stateData)
  }

  public async restoreState(adapter?: StatePersistenceAdapter): Promise<void> {
    const targetAdapter = adapter || this.persistenceAdapter
    if (!targetAdapter) {
      return
    }

    const result = await targetAdapter.restore()
    this.validateCompositeState(result.currentState)
    this.seedHistory(new Map(Object.entries(result.history)))
    if (result.stateEntryTimes) {
      this.seedEntryTimes(new Map(Object.entries(result.stateEntryTimes)))
    }
    this.setCurrentState(result.currentState)
    this.resumeTimers()
  }

  // Статические методы
  public static fromData<
    TOwner extends object,
    SMConfig extends StateMachineConfig<TOwner>,
  >(
    config: SMConfig,
    initialState?: string,
    context?: TOwner,
    options?: StateMachineOptions, // ⬅️ Добавляем опции
  ): StateMachine<TOwner, SMConfig> {
    const sm = new StateMachine<TOwner, SMConfig>(config, context, options)

    if (sm.adaptee) {
      sm.setCurrentState(initialState || (config.initialState as string))
    }

    return sm
  }

  public static fromJSON<
    TOwner extends object,
    SMConfig extends StateMachineConfig<TOwner>,
  >(
    jsonData: string,
    obj?: TOwner | Adapter<TOwner>,
    options?: StateMachineOptions,
  ): StateMachine<TOwner, SMConfig> {
    const parsedData = JSON.parse(jsonData)
    const { config, currentState, historyMap, stateEntryTimes } = parsedData

    const registry = options?.actions
    const strict = options?.strictActions ?? false
    const deserializedStates = StateMachine.deserializeStates<TOwner>(
      config.states,
      registry,
      strict,
    )
    const deserializedEvents = StateMachine.deserializeEvents<TOwner>(
      config.events,
      registry,
      strict,
    )

    const smConfig: StateMachineConfig<TOwner> = {
      name: 'DeserializedStateMachine',
      initialState: config.initialState,
      stateAttribute: config.stateAttribute,
      states: deserializedStates,
      events: deserializedEvents,
      onError: StateMachine.deserializeAction(
        config.onError,
        registry,
        strict,
      ) as KeysOf<TOwner, ErrorHandler<TOwner>>,
    }

    const sm = new StateMachine<TOwner, StateMachineConfig<TOwner>>(
      smConfig as SMConfig,
      obj as any,
      options,
    )

    sm.seedHistory(new Map(historyMap))
    if (stateEntryTimes) {
      sm.seedEntryTimes(new Map(stateEntryTimes))
    }
    if (sm.adaptee && currentState) {
      sm.setCurrentState(currentState)
      sm.resumeTimers()
    }

    return sm
  }

  /**
   * Deserializes a StateMachine from a JSON string (Async).
   *
   * Behaviorally IDENTICAL to {@link fromJSON}, differing only in that it awaits
   * the async deserialization path; it is retained as an async-compatible form.
   * It does NOT verify cryptographic hashes and does NOT compile serialized
   * function bodies — since W0 (defect П1) function bodies are never restored to
   * executable code by any deserialization path; functions are resolved BY NAME
   * from the caller-supplied `options.actions` registry. There is no
   * "secure/insecure" distinction: `fromJSON` is equally non-compiling.
   *
   * The name is a historical misnomer (an earlier keyed-hash scheme, now
   * removed). Payload authenticity/integrity is NOT checked here and is the
   * responsibility of the TRANSPORT (e.g. TLS, a signed envelope) — a forged
   * payload cannot inject executable code, but it can still forge configuration.
   */
  public static async fromSecureJSON<
    TOwner extends object,
    SMConfig extends StateMachineConfig<TOwner>,
  >(
    jsonData: string,
    obj?: TOwner | Adapter<TOwner>,
    options?: StateMachineOptions,
  ): Promise<StateMachine<TOwner, SMConfig>> {
    const parsedData = JSON.parse(jsonData)
    const { config, currentState, historyMap, stateEntryTimes } = parsedData

    const registry = options?.actions
    const strict = options?.strictActions ?? false
    // Async deserialization of states and events
    const deserializedStates =
      await StateMachine.deserializeStatesAsync<TOwner>(
        config.states,
        registry,
        strict,
      )
    const deserializedEvents =
      await StateMachine.deserializeEventsAsync<TOwner>(
        config.events,
        registry,
        strict,
      )

    const smConfig: StateMachineConfig<TOwner> = {
      name: 'DeserializedStateMachine',
      initialState: config.initialState,
      stateAttribute: config.stateAttribute,
      states: deserializedStates,
      events: deserializedEvents,
      onError: (await StateMachine.deserializeActionAsync(
        config.onError,
        registry,
        strict,
      )) as KeysOf<TOwner, ErrorHandler<TOwner>>,
    }

    const sm = new StateMachine<TOwner, StateMachineConfig<TOwner>>(
      smConfig as SMConfig,
      obj as any,
      options,
    )

    sm.seedHistory(new Map(historyMap))
    if (stateEntryTimes) {
      sm.seedEntryTimes(new Map(stateEntryTimes))
    }
    if (sm.adaptee && currentState) {
      sm.setCurrentState(currentState)
      sm.resumeTimers()
    }

    return sm
  }

  /**
   * Deserialize states configuration (Async)
   */
  private static async deserializeStatesAsync<TOwner extends object>(
    statesConfig: any,
    registry?: FunctionRegistry,
    strict = false,
  ): Promise<States<TOwner>> {
    const result: States<TOwner> = {}
    for (const [name, stateData] of Object.entries(statesConfig) as [
      string,
      any,
    ][]) {
      // The `initial` marker inside a nested states-config is a plain string,
      // not a state — pass it through verbatim (W0.2 regions recursion).
      if (name === 'initial') {
        result[name] = stateData
        continue
      }
      const deserializedState = {
        ...stateData,
        onBeforeEnter: await StateMachine.deserializeActionAsync(
          stateData.onBeforeEnter,
          registry,
          strict,
        ),
        onEnter: await StateMachine.deserializeActionAsync(
          stateData.onEnter,
          registry,
          strict,
        ),
        onAfterEnter: await StateMachine.deserializeActionAsync(
          stateData.onAfterEnter,
          registry,
          strict,
        ),
        onBeforeExit: await StateMachine.deserializeActionAsync(
          stateData.onBeforeExit,
          registry,
          strict,
        ),
        onExit: await StateMachine.deserializeActionAsync(
          stateData.onExit,
          registry,
          strict,
        ),
        onAfterExit: await StateMachine.deserializeActionAsync(
          stateData.onAfterExit,
          registry,
          strict,
        ),
        onError: await StateMachine.deserializeActionAsync(
          stateData.onError,
          registry,
          strict,
        ),
      }

      if (stateData.invoke && Array.isArray(stateData.invoke)) {
        deserializedState.invoke = stateData.invoke.map((inv: any) =>
          StateMachine.deserializeInvokeEntry(inv, registry, strict),
        )
      }

      // W0.2 regions recursion: nested region states run through the SAME
      // registry resolver rather than being spread verbatim (a spread lets
      // JSON.stringify silently drop their callbacks on the serialize side).
      if (stateData.regions && typeof stateData.regions === 'object') {
        deserializedState.regions = await StateMachine.deserializeRegionsAsync<
          TOwner
        >(stateData.regions, registry, strict)
      }

      result[name] = deserializedState
    }
    return result
  }

  /**
   * Deserialize a `regions` map (Async): each region is a nested states-config
   * resolved through {@link deserializeStatesAsync}. Symmetric to
   * {@link serializeRegions} on the serialize side (W0.2 §0.6 completeness).
   */
  private static async deserializeRegionsAsync<TOwner extends object>(
    regionsConfig: any,
    registry?: FunctionRegistry,
    strict = false,
  ): Promise<any> {
    const result: any = {}
    for (const [regionName, regionStates] of Object.entries(regionsConfig)) {
      result[regionName] = await StateMachine.deserializeStatesAsync<TOwner>(
        regionStates,
        registry,
        strict,
      )
    }
    return result
  }

  /**
   * Deserialize states configuration
   */
  private static deserializeStates<TOwner extends object>(
    statesConfig: any,
    registry?: FunctionRegistry,
    strict = false,
  ): States<TOwner> {
    return Object.entries(statesConfig).reduce(
      (acc, [name, stateData]: [string, any]) => {
        // The `initial` marker inside a nested states-config is a plain string,
        // not a state — pass it through verbatim (W0.2 regions recursion).
        if (name === 'initial') {
          acc[name] = stateData as any
          return acc
        }
        const deserializedState = {
          ...stateData,
          onBeforeEnter: StateMachine.deserializeAction(
            stateData.onBeforeEnter,
            registry,
            strict,
          ),
          onEnter: StateMachine.deserializeAction(
            stateData.onEnter,
            registry,
            strict,
          ),
          onAfterEnter: StateMachine.deserializeAction(
            stateData.onAfterEnter,
            registry,
            strict,
          ),
          onBeforeExit: StateMachine.deserializeAction(
            stateData.onBeforeExit,
            registry,
            strict,
          ),
          onExit: StateMachine.deserializeAction(
            stateData.onExit,
            registry,
            strict,
          ),
          onAfterExit: StateMachine.deserializeAction(
            stateData.onAfterExit,
            registry,
            strict,
          ),
          onError: StateMachine.deserializeAction(
            stateData.onError,
            registry,
            strict,
          ),
        }

        if (stateData.invoke && Array.isArray(stateData.invoke)) {
          deserializedState.invoke = stateData.invoke.map((inv: any) =>
            StateMachine.deserializeInvokeEntry(inv, registry, strict),
          )
        }

        // W0.2 regions recursion: nested region states run through the SAME
        // registry resolver rather than being spread verbatim (a spread lets
        // JSON.stringify silently drop their callbacks on the serialize side).
        if (stateData.regions && typeof stateData.regions === 'object') {
          deserializedState.regions = StateMachine.deserializeRegions<TOwner>(
            stateData.regions,
            registry,
            strict,
          )
        }

        acc[name] = deserializedState
        return acc
      },
      {} as States<TOwner>,
    )
  }

  /**
   * Deserialize a `regions` map: each region is a nested states-config resolved
   * through {@link deserializeStates}. Symmetric to {@link serializeRegions} on
   * the serialize side (W0.2 §0.6 completeness).
   */
  private static deserializeRegions<TOwner extends object>(
    regionsConfig: any,
    registry?: FunctionRegistry,
    strict = false,
  ): any {
    const result: any = {}
    for (const [regionName, regionStates] of Object.entries(regionsConfig)) {
      result[regionName] = StateMachine.deserializeStates<TOwner>(
        regionStates,
        registry,
        strict,
      )
    }
    return result
  }

  /**
   * Deserialize events configuration (Async)
   */
  private static async deserializeEventsAsync<TOwner extends object>(
    eventsConfig: any,
    registry?: FunctionRegistry,
    strict = false,
  ): Promise<Events<TOwner, States<TOwner>>> {
    const result: Events<TOwner, States<TOwner>> = {}
    for (const [name, eventData] of Object.entries(eventsConfig) as [
      string,
      any,
    ][]) {
      result[name] = {
        ...eventData,
        onBefore: await StateMachine.deserializeActionAsync(
          eventData.onBefore,
          registry,
          strict,
        ),
        onAfter: await StateMachine.deserializeActionAsync(
          eventData.onAfter,
          registry,
          strict,
        ),
        onSuccess: await StateMachine.deserializeActionAsync(
          eventData.onSuccess,
          registry,
          strict,
        ),
        onError: await StateMachine.deserializeActionAsync(
          eventData.onError,
          registry,
          strict,
        ),
        transitions: await Promise.all(
          eventData.transitions.map((transitionData: any) =>
            StateMachine.deserializeTransitionAsync(
              transitionData,
              registry,
              strict,
            ),
          ),
        ),
      }
    }
    return result
  }

  /**
   * Deserialize events configuration
   */
  private static deserializeEvents<TOwner extends object>(
    eventsConfig: any,
    registry?: FunctionRegistry,
    strict = false,
  ): Events<TOwner, States<TOwner>> {
    return Object.entries(eventsConfig).reduce(
      (acc, [name, eventData]: [string, any]) => {
        acc[name] = {
          ...eventData,
          onBefore: StateMachine.deserializeAction(
            eventData.onBefore,
            registry,
            strict,
          ),
          onAfter: StateMachine.deserializeAction(
            eventData.onAfter,
            registry,
            strict,
          ),
          onSuccess: StateMachine.deserializeAction(
            eventData.onSuccess,
            registry,
            strict,
          ),
          onError: StateMachine.deserializeAction(
            eventData.onError,
            registry,
            strict,
          ),
          transitions: eventData.transitions.map((transitionData: any) =>
            StateMachine.deserializeTransition(transitionData, registry, strict),
          ),
        }
        return acc
      },
      {} as Events<TOwner, States<TOwner>>,
    )
  }

  /**
   * Deserialize transition configuration (Async)
   */
  private static async deserializeTransitionAsync(
    transitionData: any,
    registry?: FunctionRegistry,
    strict = false,
  ): Promise<any> {
    return {
      ...transitionData,
      guard: await StateMachine.deserializeActionAsync(
        transitionData.guard,
        registry,
        strict,
      ),
      // Support 'action' alias for 'onTransition'
      onTransition: await StateMachine.deserializeActionAsync(
        transitionData.onTransition || transitionData.action,
        registry,
        strict,
      ),
      onError: await StateMachine.deserializeActionAsync(
        transitionData.onError,
        registry,
        strict,
      ),
    }
  }

  /**
   * Deserialize transition configuration
   */
  private static deserializeTransition(
    transitionData: any,
    registry?: FunctionRegistry,
    strict = false,
  ): any {
    return {
      ...transitionData,
      guard: StateMachine.deserializeAction(
        transitionData.guard,
        registry,
        strict,
      ),
      // Support 'action' alias for 'onTransition' for compatibility
      onTransition: StateMachine.deserializeAction(
        transitionData.onTransition || transitionData.action,
        registry,
        strict,
      ),
      onError: StateMachine.deserializeAction(
        transitionData.onError,
        registry,
        strict,
      ),
    }
  }

  /**
   * Static method for deserializing actions (Async).
   *
   * Identical resolution to the sync path — restoration is registry-based and
   * never compiles a body, so no asynchronous work remains. Retained async for
   * the `fromSecureJSON` call-site.
   */
  private static async deserializeActionAsync(
    action: any,
    registry?: FunctionRegistry,
    strict = false,
  ): Promise<any> {
    return StateMachine.deserializeAction(action, registry, strict)
  }

  /**
   * П.7 (W3b.1) — restore ONE serialized `invoke` entry.
   *
   * A `{ type:'operation' }` MARKER (emitted by {@link serializeInvokeEntry}
   * for the long-running form) carries NO `src` body (W0 invariant П1). Re-link
   * the `src` from the consumer registry (`options.actions`) by its
   * slot/id/name when supplied; otherwise the entry stays src-less and both the
   * entry ({@link armStateInvoke}) and resume ({@link resumeTimers}) paths skip
   * it via {@link isResumableTimerInvocation} — never a NaN phantom timer. The
   * TIMER form is restored exactly as before (cond/action registry resolution).
   */
  private static deserializeInvokeEntry(
    inv: any,
    registry?: FunctionRegistry,
    strict = false,
  ): any {
    const cond = StateMachine.deserializeAction(inv.cond, registry, strict)

    if (inv && inv.type === 'operation') {
      const { type: _type, slot, name, ...rest } = inv
      const src = StateMachine.resolveInvokeSrc(slot, inv.id, name, registry)
      const restored: any = { ...rest, cond }
      if (src) restored.src = src
      return restored
    }

    return {
      ...inv,
      cond,
      action: StateMachine.deserializeAction(inv.action, registry, strict),
    }
  }

  /**
   * П.7 (W3b.1) — resolve an operation-marker `src` from the consumer registry
   * by (in order) its per-slot key, its `states.`-prefixed form, its `id`, then
   * its bare `name`. OWN-key lookup only (`Object.hasOwn`) — parity with
   * {@link deserializeAction}'s resolver (a bracket index would leak an
   * Object.prototype builtin). Returns `undefined` when nothing resolves; the
   * body is NEVER compiled.
   */
  private static resolveInvokeSrc(
    slot: string | undefined,
    id: string | undefined,
    name: string | undefined,
    registry?: FunctionRegistry,
  ): ((...a: any[]) => any) | undefined {
    if (!registry) return undefined
    const keys = [
      slot,
      slot ? `states.${slot}` : undefined,
      id,
      name && name.length > 0 ? name : undefined,
    ]
    for (const key of keys) {
      if (key && Object.hasOwn(registry, key)) {
        const candidate = registry[key]
        if (typeof candidate === 'function') return candidate
      }
    }
    return undefined
  }

  /**
   * Restores a serialized action reference WITHOUT ever compiling a string.
   *
   * W0 security invariant (defect П1): no deserialization path turns an
   * attacker-controlled string into executable code.
   *
   *  - `{ type: 'function', name, slot? }` — a function reference. Resolved
   *    SLOT-FIRST against the consumer-supplied registry (`options.actions`):
   *    the composite `slot` path (and its `states.`-prefixed form) is a STABLE
   *    per-slot identity and is tried before the bare `name`, which is only a
   *    shared slot LABEL (W0.2 C1: three distinct `onEnter` callbacks all report
   *    `.name === 'onEnter'`). An unknown reference (no slot key AND no name
   *    key) THROWS {@link StateMachineError} — never a silent no-op, never a
   *    compile. Resolving a slot only by its shared bare name is a
   *    silent-collision risk: it `warn`s (or, under `strictActions`, THROWS). A
   *    nameless entry (an anonymous function, or a poisoned legacy body-carrying
   *    form) with no slot match restores to `undefined` and is loudly logged
   *    (or, under `strictActions`, THROWS) — its body is NEVER compiled.
   *  - `{ type: 'string', name }` — a method-name reference; returned as the
   *    bare name and resolved lazily at call time against the owner/context.
   *  - a bare string — a method-name reference; returned verbatim. A
   *    code-looking string is NOT compiled; it is simply an action name that
   *    fails to resolve and throws at call time.
   *  - ANY OTHER object shape (W8/V6b) — not a reference this library can emit,
   *    so the payload is hand-written or forged. It is passed through untouched
   *    (unchanged behaviour) but is no longer SILENT: it `warn`s on
   *    {@link securityLogger} (or, under `strictActions`, THROWS). Left
   *    unsignalled it fails only at call time, and for a guard that failure is
   *    absorbed into "transition disabled" — a forged `{ source: '…' }` guard
   *    otherwise makes an event no-op with no error anywhere.
   */
  private static deserializeAction(
    action: any,
    registry?: FunctionRegistry,
    strict = false,
  ): any {
    if (!action) return action

    if (typeof action === 'object') {
      if (action.type === 'string') {
        return action.name
      }

      if (action.type === 'function') {
        const name = typeof action.name === 'string' ? action.name : ''
        const slot =
          typeof action.slot === 'string' && action.slot.length > 0
            ? action.slot
            : undefined

        // (W0.2 nameless-asymmetry) A body/hash-carrying payload is a poisoned
        // legacy form whose body is NEVER compiled. Log it REGARDLESS of whether
        // a valid name/slot accompanies it — a `{ name:'onEnter', body:'...' }`
        // (valid label + poisoned body) must be flagged too, not only the
        // nameless case. This warn precedes any name/slot check.
        if (
          Object.prototype.hasOwnProperty.call(action, 'body') ||
          Object.prototype.hasOwnProperty.call(action, 'hash')
        ) {
          securityLogger.warn(
            'Serialized function carries a body/hash payload; function bodies are never compiled (W0). Ignoring the body and resolving by slot/name only.',
            { keys: Object.keys(action) },
          )
        }

        // OWN-key lookup only (`Object.hasOwn`). A bracket index
        // (`registry[key]`) walks the prototype chain, so a serialized key of
        // 'constructor' / 'toString' / 'valueOf' / 'hasOwnProperty' would
        // resolve to an Object.prototype builtin (the Object constructor is
        // itself `typeof 'function'`) and slip past the unknown-name throw.
        // Object.hasOwn confines resolution to the registry's OWN entries, so
        // any inherited key fails closed (W0 defense-in-depth; not RCE — a
        // leaked builtin cannot compile code — but the 'unknown → throw'
        // contract must hold).
        const resolveOwn = (key: string): ((...a: any[]) => any) | undefined => {
          if (registry && Object.hasOwn(registry, key)) {
            const candidate = registry[key]
            if (typeof candidate === 'function') return candidate
          }
          return undefined
        }

        // Slot-first: an exact per-slot key is a stable identity. Accept both
        // the bare slot path ('green.onEnter') and its 'states.'-prefixed form
        // ('states.green.onEnter') so a consumer may key the registry either way.
        if (slot) {
          const slotFn = resolveOwn(slot) ?? resolveOwn(`states.${slot}`)
          if (slotFn) return slotFn
        }

        if (name.length === 0) {
          // Nameless AND no slot match: no stable identity to resolve.
          if (strict) {
            throw new StateMachineError(
              `Cannot restore a nameless serialized function${
                slot ? ` for slot '${slot}'` : ''
              } under strictActions: no per-slot registry key and no name to fall back to.`,
              slot ? { slot } : {},
            )
          }
          securityLogger.warn(
            'Serialized function reference has no name (and no slot match) and cannot be resolved from the registry; restoring as undefined.',
            slot ? { slot } : {},
          )
          return undefined
        }

        // Bare-name fallback: the name is a shared slot LABEL, not a stable
        // identity. If a slot identity was present but only the shared name
        // resolves, a same-named sibling's function may be silently substituted
        // (W0.2 C1 collision) — refuse under strictActions, warn otherwise.
        const fn = resolveOwn(name)
        if (!fn) {
          throw new StateMachineError(
            `Cannot restore function '${name}'${
              slot ? ` (slot '${slot}')` : ''
            }: it is not present in the provided function registry (options.actions). ` +
              'Serialized state machines restore functions by slot/name from a consumer-supplied registry; function bodies are never compiled.',
            slot ? { action: name, slot } : { action: name },
          )
        }
        if (slot) {
          if (strict) {
            throw new StateMachineError(
              `Refusing to restore slot '${slot}' by its shared bare name '${name}' under strictActions: provide a per-slot registry key ('${slot}' or 'states.${slot}') to disambiguate. Bare-name resolution risks serving a same-named sibling's function.`,
              { slot, action: name },
            )
          }
          securityLogger.warn(
            `Serialized function for slot '${slot}' resolved only by its shared bare name '${name}' (no per-slot registry key). If several slots share this name, a sibling's function may be substituted; add a '${slot}' or 'states.${slot}' registry key to disambiguate.`,
            { slot, name },
          )
        }
        return fn
      }

      // W8/V6b — UNRECOGNIZED OBJECT SHAPE. {@link serializeActionRef} emits
      // ONLY `{type:'string',name}`, `{type:'function',name,slot?}` or
      // `undefined`, so no round-trip of a machine this library serialized can
      // land here: reaching this branch means the payload was hand-written,
      // forged, or written by a foreign producer.
      //
      // The object is then installed VERBATIM into the action slot and nothing
      // downstream rejects it. `callAction` cannot resolve a non-string,
      // non-function action and throws 'No action found' at FIRE time — far
      // from the payload that caused it. For a GUARD that throw is absorbed by
      // the guard-error path (SPEC §7): the transition is merely DISABLED, so a
      // forged `{ source: '…' }` guard makes `fireEvent` return `false` forever
      // with nothing thrown. Empirically confirmed: a `{source,name}` guard is
      // installed as-is and its event silently no-ops.
      //
      // Signal it HERE, at the payload, instead of leaving the slot silent.
      // Policy matches the sibling unresolvable-identity branches above: warn by
      // default, THROW under `strictActions`.
      if (strict) {
        throw new StateMachineError(
          `Refusing to restore an unrecognized serialized action shape (keys: ${
            Object.keys(action).join(', ') || '<none>'
          }) under strictActions: expected { type: 'string', name } or { type: 'function', name, slot? }. ` +
            'An unrecognized object is installed verbatim and fails only at call time — as a guard it silently disables the transition.',
          {},
        )
      }
      securityLogger.warn(
        'Unrecognized serialized action shape; this library never emits it (expected { type: \'string\', name } or { type: \'function\', name, slot? }). ' +
          'The value is passed through untouched and will fail to resolve at call time — as a guard it silently disables the transition rather than throwing. ' +
          'Re-serialize the machine with toJSON(), or drop the slot from the payload.',
        { keys: Object.keys(action) },
      )
      return action
    }

    // Bare string: a method-name reference resolved lazily at call time. Never
    // compiled — a code-looking string is just a name that will fail to resolve.
    if (typeof action === 'string') {
      return action
    }

    // Anything else (already a function, etc.) passes through untouched.
    return action
  }

  public static fromJSONWithContext<
    TOwner extends object,
    SMConfig extends StateMachineConfig<TOwner>,
  >(
    jsonData: string,
    context?: MethodsOf<TOwner>,
    options?: StateMachineOptions, // ⬅️ Добавляем опции
  ): StateMachine<TOwner, SMConfig> {
    const sm = StateMachine.fromJSON<TOwner, SMConfig>(
      jsonData,
      undefined,
      options,
    )
    if (context !== undefined) {
      sm.setContext(context)
    }
    return sm
  }

  // Приватные методы
  private setCurrentState(
    state: StateName,
    obj?: Adapter<PropertiesOf<TOwner>>,
  ) {
    const adaptee = obj || this.adaptee
    const stateConfig = this.states.get(state)

    if (
      stateConfig?.history &&
      stateConfig.history !== 'deep' &&
      stateConfig.regions
    ) {
      const historyState = this.historyFor(adaptee).get(state)
      if (historyState && adaptee) {
        const currentState = this.getCurrentState(adaptee) ?? ''
        const newCompositeState = this.updatePartialState(
          currentState,
          state,
          historyState,
        )
        adaptee.set(
          this.stateAttribute,
          newCompositeState as TOwner[KeysOf<PropertiesOf<TOwner>, string>],
        )
        return
      }
    }
    if (stateConfig?.history === 'deep' && stateConfig.regions) {
      const historyState = this.historyFor(adaptee).get(state)
      if (historyState && adaptee) {
        // W2a: канонизируем восстановленную deep-history конфигурацию тем же
        // documentIndex-порядком, что и прямой путь персистенции.
        adaptee.set(
          this.stateAttribute,
          this.orderComposite(historyState) as TOwner[KeysOf<PropertiesOf<TOwner>, string>],
        )
        return
      }
    }

    if (adaptee) {
      this.setCurrentStateInternal(state, adaptee)
    }
  }

  private setCurrentStateInternal(
    state: StateName,
    adaptee: Adapter<PropertiesOf<TOwner>>,
  ) {
    const currentState = this.getCurrentState(adaptee) || ''
    const newCompositeState = this.computeInternalWrite(currentState, state)
    adaptee.set(
      this.stateAttribute,
      newCompositeState as TOwner[KeysOf<PropertiesOf<TOwner>, string>],
    )
  }

  /**
   * OTS/П5 — pure (non-writing) counterpart of {@link setCurrentStateInternal}:
   * given an explicit `currentState` string, compute the canonical composite
   * configuration that entering `state` produces (region expansion + conflict
   * removal + documentIndex ordering), WITHOUT touching the adaptee. Consumed by
   * {@link previewCommitState} so the microstep can resolve the fully-committed
   * target configuration (incl. history) BEFORE it runs enter/exit actions and
   * arms timers, then write it exactly once (SPEC §6.3 point-of-no-return).
   */
  private computeInternalWrite(
    currentState: string,
    state: StateName,
  ): string {
    const currentStateMap = this.parseCompositeState(currentState || '')

    // U7/#15: TEST-ONLY perf probe, read ONCE per call (undefined in prod).
    const perfProbe = currentPerfProbe()

    const newStateParts = state.split('|')
    // D1: a bare-root composite that declares regions must NOT short-circuit
    // as a simple root; it falls through to the region-expansion branch below
    // (1158-1167) so its regions expand identically to initialState/dotted
    // entry. A genuine region-less leaf root still short-circuits unchanged.
    const isRootState =
      newStateParts.length === 1 &&
      !state.includes('.') &&
      !this.states.get(state)?.regions
    if (isRootState) {
      currentStateMap.clear()
      currentStateMap.set(state, state)
    } else {
      // U7/#15 (PERF-03): the per-part conflict removal below previously scanned
      // the WHOLE (growing) config map for every incoming part, so writing an
      // R-region composite configuration (R parts × up-to-R entries) was Θ(R²).
      // It is replaced by two behaviour-identical but cheaper steps: (1)+(3) an
      // O(depth) exact-match + ancestor prefix-walk, and (2) a strict-descendant
      // scan GATED on `maxRegionDots` — the monotonic upper bound on any key's
      // depth. A descendant of `regionKey` is always deeper, so when no key can
      // be deeper the scan is provably empty and is skipped, which is exactly the
      // flat sibling-parallel write that dominates. Union of deletions (and thus
      // the resulting configuration) is identical to the old full scan.
      let maxRegionDots = 0
      for (const key of currentStateMap.keys()) {
        const d = countDots(key)
        if (d > maxRegionDots) maxRegionDots = d
      }

      for (const newStatePart of newStateParts) {
        if (!this.states.has(newStatePart)) {
          throw new StateMachineError(
            `Invalid state path: ${newStatePart} in composite state: ${state} states: ${Array.from(this.states.keys()).join(',')}`,
            { state: newStatePart },
          )
        }

        const regionKey = this.getRegionKey(newStatePart)
        const stateConfig = this.states.get(newStatePart)

        // (1) exact match + (3) every ancestor prefix of regionKey — O(depth).
        let ancestor: string | undefined = regionKey
        while (ancestor !== undefined) {
          if (perfProbe) perfProbe.internalWriteScan++
          currentStateMap.delete(ancestor)
          const dot = ancestor.lastIndexOf('.')
          ancestor = dot === -1 ? undefined : ancestor.substring(0, dot)
        }
        // (2) strict descendants of regionKey (existing.startsWith(regionKey+'.')):
        // only reachable when a deeper key can exist. For the flat write every
        // key shares regionKey's depth, so the guard is false and the Θ(R²) scan
        // never runs; genuine hierarchical replacement (small R) still scans.
        if (maxRegionDots > countDots(regionKey)) {
          const descPrefix = regionKey + '.'
          for (const existingRegionKey of currentStateMap.keys()) {
            if (perfProbe) perfProbe.internalWriteScan++
            if (existingRegionKey.startsWith(descPrefix)) {
              currentStateMap.delete(existingRegionKey)
            }
          }
        }

        if (stateConfig?.regions) {
          const initialStatesForRegions = this.getInitialStatesForRegions(
            stateConfig.regions,
            newStatePart,
            // M-1: entering a composite via a transition uses the same composite
            // `initial` source of truth as initial construction.
            stateConfig.initial,
          )
          const regionStates = initialStatesForRegions.split('|')
          for (const regionState of regionStates) {
            const regionKeyNested = this.getRegionKey(regionState)
            currentStateMap.set(regionKeyNested, regionState)
            const nd = countDots(regionKeyNested)
            if (nd > maxRegionDots) maxRegionDots = nd
          }
        } else {
          currentStateMap.set(regionKey, newStatePart)
          const nd = countDots(regionKey)
          if (nd > maxRegionDots) maxRegionDots = nd
        }
      }

      for (const [key, value] of currentStateMap.entries()) {
        if (!value.includes('.')) {
          currentStateMap.delete(key)
        }
      }
    }

    // W2a: сериализуем активную конфигурацию в КАНОНИЧЕСКОМ documentIndex-порядке
    // (взамен порядка вставки в Map), чтобы getCurrentState был детерминирован и
    // не зависел от пути активации.
    const newCompositeState = this.orderComposite(
      Array.from(currentStateMap.values()).join('|'),
    )
    this.validateCompositeState(newCompositeState)
    return newCompositeState
  }

  /**
   * OTS/П5 (SPEC §6.3, T3 deep/shallow-history fix) — pure preview of the
   * committed configuration that entering `state` from `currentStateStr`
   * produces, INCLUDING history restoration. Mirrors {@link setCurrentState}'s
   * history branches so the microstep can compute the enter-set from the
   * ACTUALLY-committed (restored) configuration, not the regional default —
   * closing T3 where onEnter/invoke previously armed the default leaf while the
   * real committed leaf was the restored one.
   */
  private previewCommitState(
    currentStateStr: string,
    state: StateName,
    // П6 — the owner whose history is consulted for restoration. Threaded from
    // the microstep's `obj` so history restore is per-owner; owner-less preview
    // callers (e.g. exit-set queries) fall back to the primary adaptee.
    obj?: Adapter<any>,
  ): string {
    // Compute the default (non-history) expansion FIRST — mirroring the historic
    // two-step write (updateState default-expansion → setCurrentState history
    // overlay): the base strips conflicting/root states (e.g. a `stopped` root
    // that the target replaces) so a shallow-history overlay restores onto the
    // already-cleaned configuration rather than leaking the source root.
    const base = this.computeInternalWrite(currentStateStr, state)
    const stateConfig = this.states.get(state)
    if (
      stateConfig?.history &&
      stateConfig.history !== 'deep' &&
      stateConfig.regions
    ) {
      const historyState = this.historyFor(obj).get(state)
      if (historyState) {
        return this.updatePartialState(base, state, historyState)
      }
    }
    if (stateConfig?.history === 'deep' && stateConfig.regions) {
      const historyState = this.historyFor(obj).get(state)
      if (historyState) {
        return this.orderComposite(historyState)
      }
    }
    return base
  }

  /**
   * П2: `getCurrentState` can THROW ('Invalid state path…') when an adaptee's
   * persisted state string is corrupted. In the drain's error-reporting paths
   * (run-away context, internal-catch context) that throw would escape the
   * floating `queueMicrotask(processQueues)` as a real process
   * `unhandledRejection` — resurrecting the very failure mode the observable
   * error channel was built to prevent. This never-throwing variant returns
   * `undefined` instead, so error contexts degrade gracefully on a corrupted
   * adaptee rather than crashing the drain.
   */
  private safeGetCurrentState(
    adaptee?: Adapter<PropertiesOf<TOwner>>,
  ): string | undefined {
    try {
      return this.getCurrentState(adaptee)
    } catch {
      return undefined
    }
  }

  public getCurrentState(adaptee?: Adapter<PropertiesOf<TOwner>>) {
    const targetAdaptee = adaptee || this.adaptee
    if (!targetAdaptee) return

    const currentState = targetAdaptee.get(this.stateAttribute) as string
    if (!currentState) return ''

    const stateParts = currentState.split('|')
    for (const statePart of stateParts) {
      if (!this.states.has(statePart)) {
        throw new StateMachineError(
          `Invalid state path in current state: ${statePart}`,
          { state: currentState },
        )
      }
    }
    return currentState
  }

  private setInitialState(
    initialState: string,
    obj?: Adapter<PropertiesOf<TOwner>>,
  ) {
    const targetAdaptee = obj || this.adaptee
    if (!targetAdaptee) return

    const stateConfig = this.states.get(initialState)
    let initialStates: string
    if (stateConfig?.regions) {
      // M-1: honour the composite `State.initial` so each region enters the leaf
      // the author pinned, not the region's first insertion-order key.
      initialStates = this.getInitialStatesForRegions(
        stateConfig.regions,
        initialState,
        stateConfig.initial,
      )
    } else {
      initialStates = initialState
    }

    this.setCurrentState(initialStates, targetAdaptee)

    // D8: drive enter actions through the SAME ancestor-first enter set used by
    // a transition (computeEnterExitSets from the empty old configuration), so
    // initial entry (and reset, which delegates here) fires a composite
    // parent's onEnter BEFORE its region children — identical ordering to a
    // transition into the same composite. Fire-and-forget with .catch to keep
    // construction non-blocking, as the prior per-leaf loop did.
    const { enterStates } = this.computeEnterExitSets('', initialStates)
    const enterFireOrder =
      enterStates.length > 0 ? enterStates : [initialStates]
    const context: ErrorContext = {
      state: initialStates,
      phase: 'enter',
    }

    for (const statePart of enterFireOrder) {
      this.executeEnterActions(
        targetAdaptee as unknown as Adapter<TOwner>,
        statePart,
        [],
        context,
      ).catch((err) => {
        this.logger.error(
          'Error in initial state enter actions',
          { state: statePart },
          err,
        )
      })
    }

    // D12: a degenerate all-final initial configuration should raise
    // done.state.<C> just like a transition that reaches it. setInitialState
    // runs in the constructor; checkCompletion only ever uses raiseEvent +
    // scheduleProcessing (queueMicrotask), so the join fires AFTER construction
    // returns, never on a half-constructed instance.
    this.checkCompletion(
      targetAdaptee as Adapter<PropertiesOf<TOwner>>,
      '',
      initialStates,
    )
  }

  private getInitialCompositeState(initialState: string): string {
    const stateConfig = this.states.get(initialState)
    if (stateConfig?.regions) {
      return this.getInitialStatesForRegions(
        stateConfig.regions,
        initialState,
        stateConfig.initial,
      )
    }
    return initialState
  }

  /**
   * M-1 — resolve a composite `State.initial` into per-region entry-state keys.
   *
   * The composite `initial` is the SINGLE SOURCE OF TRUTH for where each region
   * of the composite starts. It is a `|`-joined list of per-region entries in
   * one of the documented forms:
   *   - region-qualified  `'a.work'` / `'a.work|b.run'` — the segment before the
   *     first dot names the region, the next segment its entry state;
   *   - bare              `'work'`  — no dot: the state key is matched against the
   *     regions and pins the (unique) region that declares it.
   * Returns a map `regionName -> entryStateKey`. Regions absent from the map fall
   * back to first-key insertion order at the call site (unchanged legacy
   * behaviour, still flagged REGION_MISSING_INITIAL by the validator).
   */
  private parseCompositeInitial(
    compositeInitial: string | undefined,
    regions: RegionsConfig<TOwner>,
  ): Map<string, string> {
    const perRegion = new Map<string, string>()
    if (typeof compositeInitial !== 'string' || !compositeInitial) {
      return perRegion
    }
    const regionNames = Object.keys(regions)
    for (const rawEntry of compositeInitial.split('|')) {
      const entry = rawEntry.trim()
      if (!entry) continue
      const dot = entry.indexOf('.')
      if (dot >= 0) {
        const regionName = entry.slice(0, dot)
        if (Object.prototype.hasOwnProperty.call(regions, regionName)) {
          // The next segment is the region's direct entry state; any deeper
          // path is resolved by that state's OWN `initial` during recursion.
          const entryKey = entry.slice(dot + 1).split('.')[0]
          if (entryKey) perRegion.set(regionName, entryKey)
        }
      } else {
        // Bare key: pin the unique region whose states-map declares it.
        const matches = regionNames.filter((rn) =>
          Object.prototype.hasOwnProperty.call(regions[rn], entry),
        )
        if (matches.length === 1) perRegion.set(matches[0]!, entry)
      }
    }
    return perRegion
  }

  private getDirectChildren(stateName: string): string[] {
    const prefix = `${stateName}.`
    const depth = stateName.split('.').length + 1

    const children: string[] = []
    for (const name of this.states.keys()) {
      const nameStr = String(name)
      if (!nameStr.startsWith(prefix)) continue
      if (nameStr.split('.').length !== depth) continue
      children.push(nameStr)
    }
    return children
  }

  private getInitialStatesForRegions(
    regions: RegionsConfig<TOwner>,
    parentPath: string,
    compositeInitial?: string,
  ): string {
    // M-1: the composite `State.initial` decides each region's entry state; only
    // regions it does NOT name fall back to first-key insertion order.
    const perRegionInitial = this.parseCompositeInitial(
      compositeInitial,
      regions,
    )
    const regionStates: string[] = []
    for (const [regionName, regionStatesConfig] of Object.entries(regions)) {
      const regionPath = `${parentPath}.${regionName}`
      const initialState =
        perRegionInitial.get(regionName) ??
        regionStatesConfig.initial ??
        Object.keys(regionStatesConfig)[0]
      const fullPath = `${regionPath}.${initialState}`

      const stateConfig = this.states.get(fullPath)
      if (stateConfig?.regions) {
        const nestedInitialStates = this.getInitialStatesForRegions(
          stateConfig.regions,
          fullPath,
          // A nested composite carries its OWN `initial`; honour it so deep
          // composite entry is resolved end-to-end (not first-key at depth).
          stateConfig.initial,
        )
        regionStates.push(...nestedInitialStates.split('|'))
      } else {
        regionStates.push(fullPath)
      }
    }
    return regionStates.join('|')
  }

  /**
   * Whether `leaf` is a UML/SCXML `<final>` atomic state of its region.
   *
   * Reads the `final` marker straight from the flattened state map populated by
   * processStates, so it works for any registered atomic leaf regardless of
   * nesting depth. Returns `false` for unregistered names and for composites
   * (the all-regions-final join derives doneness from atomic leaves, not from a
   * `final` flag on a composite parent).
   */
  private isStateFinal(leaf: string): boolean {
    return Boolean(this.states.get(leaf)?.final)
  }

  /**
   * Whether composite `compositeId` has reached its UML/SCXML "done"
   * configuration: every one of its regions has its active atomic leaf in a
   * `final` state (recursively, for nested composites).
   *
   * D10 (mustFix): doneness is derived by scanning the active atomic `|`-leaves
   * against the STATIC regions tree (`this.states.get(C)?.regions`), NEVER via a
   * region-key Map lookup (`configMap.get`) — that map keys leaves by their
   * deepest region container and so cannot answer "which leaf is active in
   * region X of composite C". For each region we locate the active leaf via the
   * `C.region.` dotted prefix; the region is final iff that leaf is `final`, or
   * the leaf lives under a nested composite that is itself `isCompositeDone`.
   *
   * Returns `false` for a non-composite id, for a composite with no active leaf
   * in some region, or when no substate under it is ever `final` (cheap miss).
   */
  private isCompositeDone(compositeId: string, atomicLeaves: string[]): boolean {
    const regions = this.states.get(compositeId)?.regions
    if (!regions) return false

    // U7/#15 (PERF-02): the previous per-region `atomicLeaves.find` scanned all R
    // leaves for each of the R regions, so a completing R-region composite was
    // Θ(R²) — and checkCompletion reaches this unconditionally on every write.
    // Instead index the leaves by their region segment in ONE O(R) pass, then
    // resolve each region in O(1). First-seen-per-region reproduces `find`'s
    // first-match; a leaf that is not `${compositeId}.<segment>.…` is ignored.
    const perfProbe = currentPerfProbe()
    const prefix = `${compositeId}.`
    const leafByRegion = new Map<string, string>()
    for (const leaf of atomicLeaves) {
      if (perfProbe) perfProbe.completionScan++
      if (!leaf.startsWith(prefix)) continue
      const rest = leaf.slice(prefix.length)
      const dot = rest.indexOf('.')
      if (dot === -1) continue
      const regionName = rest.slice(0, dot)
      if (!leafByRegion.has(regionName)) leafByRegion.set(regionName, leaf)
    }

    for (const regionName of Object.keys(regions)) {
      const regionPrefix = `${compositeId}.${regionName}.`
      const activeLeaf = leafByRegion.get(regionName)
      if (!activeLeaf) return false

      // Determine whether the region's active sub-configuration is complete.
      // If the region holds a NESTED COMPOSITE (e.g. region p -> composite D),
      // the region is final iff that composite is all-regions-final — checking
      // a single parallel branch leaf's `final` flag is NOT sufficient (one
      // branch being final does not finalize the whole nested composite). We
      // therefore defer to isCompositeDone on the region's OUTERMOST nested
      // composite first, and only fall back to a direct atomic `final` check
      // when the region holds a simple state.
      const nestedComposite = this.regionComposite(activeLeaf, regionPrefix)
      if (nestedComposite) {
        if (this.isCompositeDone(nestedComposite, atomicLeaves)) continue
        return false
      }
      if (this.isStateFinal(activeLeaf)) continue
      return false
    }
    return true
  }

  /**
   * The OUTERMOST registered composite (regions-bearing) ancestor of `leaf`
   * that lives strictly under `regionPrefix`, or `undefined` if the region
   * holds a simple atomic state directly. Used by {@link isCompositeDone} to
   * delegate a region's completeness to its nested composite (recursing over
   * every parallel branch), independent of whether any single branch leaf
   * happens to carry the `final` flag.
   *
   * ancestorChain is root-to-leaf, so the FIRST matching ancestor is the
   * region's direct composite child (e.g. `C.p.D` for leaf `C.p.D.s.s2` under
   * region prefix `C.p.`); isCompositeDone then recurses into its regions.
   */
  private regionComposite(
    leaf: string,
    regionPrefix: string,
  ): string | undefined {
    for (const ancestor of this.ancestorChain(leaf)) {
      if (
        ancestor !== leaf &&
        ancestor.startsWith(regionPrefix) &&
        this.states.get(ancestor)?.regions
      ) {
        return ancestor
      }
    }
    return undefined
  }

  /**
   * Whether composite `compositeId` has reached its all-regions-final ("done")
   * configuration in the CURRENT active state. Public guard surface (`@stable`)
   * for authoring a join as `guard: () => sm.isDone('C')` instead of (or
   * alongside) listening on the engine `done.state.<C>` event.
   *
   * @param compositeId - The dotted id of the composite/parallel state.
   * @returns `true` iff every region's active atomic leaf is `final`.
   */
  public isDone(
    compositeId: string,
    adaptee?: Adapter<PropertiesOf<TOwner>>,
  ): boolean {
    const currentState = this.getCurrentState(adaptee)
    if (!currentState) return false
    const atomicLeaves = currentState.split('|').filter(Boolean)
    return this.isCompositeDone(compositeId, atomicLeaves)
  }

  /**
   * SCXML completion hook (D10/D11/D12): after a new configuration is written,
   * raise `done.state.<C>` for each composite that became all-regions-final.
   *
   * - Scans only composites that GAINED an active leaf (the ancestor chain of
   *   each `|`-leaf of `newState`), so unaffected composites are not re-checked.
   * - Emits INNERMOST-first (a deeper composite's `done.state` precedes its
   *   parent's), matching SCXML's inner-before-outer completion ordering, via a
   *   per-config emitted-id Set so each id is raised at most once per call.
   * - Gates each emission on `this.events.has('done.state.'+C)` (D11 mustFix):
   *   raising an undeclared event would hit the `Invalid event` throw
   *   (executeQueuedTransition) as an unhandled microtask rejection. No declared
   *   `done.state.<C>` event => no emission, no crash, no observable effect.
   * - Uses the internal queue (`raiseEvent`) + `scheduleProcessing` so the
   *   completion event is processed before subsequent external events.
   */
  private checkCompletion(
    obj: Adapter<PropertiesOf<TOwner>>,
    oldState: string,
    newState: string,
  ): void {
    // U7/#15 (PERF-02): every path below exists only to raise a `done.state.<C>`
    // event, and each raise is already gated on `this.events.has(...)`. When the
    // config declares NO completion event, the whole scan (incl. the O(R)
    // isCompositeDone probes) is dead work on every write — skip it wholesale.
    if (!this.hasCompletionEvents) return

    const atomicLeaves = newState.split('|').filter(Boolean)
    if (atomicLeaves.length === 0) return

    // EDGE-TRIGGERED (SCXML): done.state.<C> is generated once, when the done
    // configuration is ENTERED — not on every macrostep that leaves C all-final.
    // We therefore emit only for composites that became done ON THIS transition:
    // done in `newState` AND NOT already done in `oldState`. A composite that
    // stays all-final across an unrelated (e.g. sibling-region) transition is
    // not re-signalled; a composite that leaves and later re-enters its done
    // configuration is correctly re-signalled. `oldState === ''` (initial/reset)
    // makes every all-final composite newly-done, so a degenerate all-final
    // initial config still raises done.state once.
    const oldLeaves = oldState.split('|').filter(Boolean)

    // Collect the composite ancestors of the newly-active leaves, then sort
    // DEEPEST-first so a nested inner composite's done.state is enqueued before
    // its parent's (SCXML inner-before-outer). Sorting by depth is required:
    // relying on leaf iteration order is unsound because the `|`-leaf order is
    // map-insertion dependent, so an outer-only leaf (e.g. a sibling region of
    // the inner composite) can otherwise surface the parent before the child.
    const seen = new Set<string>()
    for (const leaf of atomicLeaves) {
      for (const ancestor of this.ancestorChain(leaf)) {
        if (ancestor === leaf) continue
        if (seen.has(ancestor)) continue
        if (!this.states.get(ancestor)?.regions) continue
        seen.add(ancestor)
      }
    }
    // W2a: DEEPEST-first по DEPTH МОДЕЛИ (взамен `split('.').length`). Для
    // зарегистрированного композита оба метрики монотонны по вложенности, так
    // что относительный «внутренний-раньше-внешнего» порядок неизменен; модель
    // делает источник depth единым и детерминированным. Fallback на сегменты —
    // только для узла вне модели (не должно случаться для композита-кандидата).
    const depthFor = (id: string): number =>
      this.model?.depthOf(id) ?? id.split('.').length
    const candidates = Array.from(seen).sort(
      (a, b) => depthFor(b) - depthFor(a),
    )

    const emitted = new Set<string>()
    for (const compositeId of candidates) {
      if (emitted.has(compositeId)) continue
      if (!this.isCompositeDone(compositeId, atomicLeaves)) continue
      // Edge gate: skip if C was ALREADY all-final before this transition.
      if (this.isCompositeDone(compositeId, oldLeaves)) continue
      emitted.add(compositeId)
      const doneEvent = `done.state.${compositeId}`
      if (!this.events.has(doneEvent as keyof SMConfig['events'])) continue
      // W9/Г1 — `state` is the COMPOSITE whose completion produced the event, and
      // the microstep is the CURRENT one: the completion scan runs inside the very
      // microstep whose state write made C all-final (see the RAISE ASYMMETRY note
      // on LifecycleEvent.microstep — this origin, unlike the invoke ones, is NOT
      // an arming-step id).
      this.raiseEvent(doneEvent, obj, {
        hook: 'raise.done',
        state: compositeId,
        microstep: this.currentMicrostep,
      })
      this.scheduleProcessing()
    }
  }

  /**
   * Build the registered ancestor chain for an atomic leaf, ordered root-to-leaf.
   *
   * Walks every dot-prefix of `leaf` and keeps only the ones that are real
   * registered states (`this.states.has`). Region containers are never
   * registered (only composite parents and atomic leaves are — see
   * processStates/processRegions), so they are filtered out automatically. The
   * result is exactly `[parent..leaf]` for a leaf inside a composite, and
   * `[leaf]` for a flat state.
   *
   * Example: `ancestorChain('a.r1.c1')` -> `['a', 'a.r1.c1']` (the `a.r1`
   * region container is excluded). Nested:
   * `ancestorChain('a.r1.c1.r3.x')` -> `['a', 'a.r1.c1', 'a.r1.c1.r3.x']`.
   */
  private ancestorChain(leaf: string): string[] {
    const chain: string[] = []
    let dotIndex = leaf.indexOf('.')
    while (dotIndex !== -1) {
      const prefix = leaf.substring(0, dotIndex)
      if (this.states.has(prefix)) {
        chain.push(prefix)
      }
      dotIndex = leaf.indexOf('.', dotIndex + 1)
    }
    if (this.states.has(leaf)) {
      chain.push(leaf)
    }
    return chain
  }

  /**
   * Compute the ordered enter/exit sets between two composite configurations
   * (SCXML ancestor-first entry / descendant-first exit).
   *
   * For each `|`-separated atomic leaf in `oldComposite` and `newComposite` the
   * union of its {@link ancestorChain} forms the old/new active ancestry. A
   * state shared by both ancestries lands in NEITHER diff, so a surviving
   * ancestor is never re-entered nor exited (no onEnter/onExit re-fire, no
   * timer re-arm/leak).
   *
   * ORDER (W8/V11 — W3C SCXML §3.13, canonical):
   * - `enterStates` = new ancestry MINUS old, sorted ASCENDING by the compiled
   *   model's `documentIndex` = DOCUMENT ORDER (DFS preorder of the config
   *   tree) -> ancestor-before-descendant AND each region walked contiguously.
   * - `exitStates` = old ancestry MINUS new, sorted DESCENDING by the same
   *   `documentIndex` = REVERSE DOCUMENT ORDER -> descendant-before-ancestor
   *   AND sibling regions unwound back-to-front (r3, r2, r1).
   *
   * `documentIndex` IS the DFS preorder rank (see model.ts `compileModel`), so
   * ONE sort key delivers both the layer relation (an ancestor is always
   * assigned a smaller index than any of its descendants, because the index is
   * handed out on ENTERING the node) and the sibling/traversal shape. It
   * replaces the pre-V11 `(depth, insertion-order)` key, which produced a
   * DEPTH-MAJOR (level-order) interleaving across parallel regions and a
   * FORWARD sibling order on exit — both divergent from §3.13.
   *
   * A state absent from the compiled model (defensive: `ancestorChain` only
   * ever yields states registered by `processStates`, which walks the SAME
   * config `compileModel` does) falls back to a FINITE sentinel rank, then to
   * the depth axis, then to collection order — deterministic, never NaN, and
   * still layer-correct among such nodes.
   *
   * Consumed by BOTH R1 (applyTransition / setInitialState / reset) and R2.
   */
  private computeEnterExitSets(
    oldComposite: string,
    newComposite: string,
  ): { enterStates: string[]; exitStates: string[] } {
    const collectAncestry = (composite: string): Set<string> => {
      const ancestry = new Set<string>()
      if (!composite) return ancestry
      for (const leaf of composite.split('|')) {
        if (!leaf) continue
        for (const ancestor of this.ancestorChain(leaf)) {
          ancestry.add(ancestor)
        }
      }
      return ancestry
    }

    const oldAncestry = collectAncestry(oldComposite)
    const newAncestry = collectAncestry(newComposite)

    const depthOf = (state: string): number => {
      let depth = 0
      for (let i = 0; i < state.length; i++) {
        if (state[i] === '.') depth++
      }
      return depth
    }

    // Canonical rank = the compiled model's documentIndex (DFS preorder). The
    // sentinel MUST be finite: `Infinity - Infinity` is NaN, which would make
    // the comparator incoherent for two unranked states.
    const UNRANKED = Number.MAX_SAFE_INTEGER
    const rankOf = (state: string): number =>
      this.model?.documentIndexOf(state) ?? UNRANKED

    const enterRaw: string[] = []
    for (const state of newAncestry) {
      if (!oldAncestry.has(state)) enterRaw.push(state)
    }
    const exitRaw: string[] = []
    for (const state of oldAncestry) {
      if (!newAncestry.has(state)) exitRaw.push(state)
    }

    const enterStates = enterRaw
      .map((state, index) => ({
        state,
        index,
        depth: depthOf(state),
        rank: rankOf(state),
      }))
      // ENTRY = document order (ascending documentIndex).
      .sort(
        (a, b) => a.rank - b.rank || a.depth - b.depth || a.index - b.index,
      )
      .map((entry) => entry.state)
    const exitStates = exitRaw
      .map((state, index) => ({
        state,
        index,
        depth: depthOf(state),
        rank: rankOf(state),
      }))
      // EXIT = reverse document order (descending documentIndex).
      .sort(
        (a, b) => b.rank - a.rank || b.depth - a.depth || a.index - b.index,
      )
      .map((entry) => entry.state)

    return { enterStates, exitStates }
  }

  private validateCompositeState(compositeState: string): void {
    const stateParts = compositeState.split('|')
    const regionKeys = new Set<string>()
    for (const statePart of stateParts) {
      const regionKey = this.getRegionKey(statePart)
      if (regionKeys.has(regionKey)) {
        throw new StateMachineError(
          `Contradictory state detected: multiple states for region ${regionKey} in composite state ${compositeState}`,
          { state: compositeState },
        )
      }
      regionKeys.add(regionKey)
    }
  }

  private processStates(
    statesConfig: States<TOwner>,
    parentStateName?: StateName,
  ) {
    for (const [name, value] of Object.entries(statesConfig)) {
      if (name === 'initial') continue

      const stateName = parentStateName ? `${parentStateName}.${name}` : name
      const state: State<TOwner> = { name: stateName, ...value }
      this.states.set(stateName, state)

      if (value.regions) {
        this.processRegions(value.regions, stateName)
      }
    }
  }

  private processRegions(
    regionsConfig: RegionsConfig<TOwner>,
    parentStateName: StateName,
  ) {
    for (const [regionName, regionStatesConfig] of Object.entries(
      regionsConfig,
    )) {
      this.processStates(regionStatesConfig, `${parentStateName}.${regionName}`)
    }
  }

  private processError(
    adaptee: Adapter<TOwner>,
    context: ErrorContext,
    ...fallback: Array<ErrorHandlerOrString<TOwner> | undefined>
  ) {
    let handler: ErrorHandler<TOwner> = (adaptee, err) => {
      // Safely get current state, fallback to context.state if adaptee is invalid
      let currentState: string
      try {
        if (adaptee && typeof (adaptee as any).get === 'function') {
          currentState = this.getCurrentState(
            adaptee as unknown as Adapter<PropertiesOf<TOwner>>,
          ) ?? ''
        } else {
          /* c8 ignore next */
          currentState = context.state || ''
        }
      } catch {
        /* c8 ignore next */
        currentState = context.state || ''
      }

      const _phase = err instanceof StateMachineError
        ? (err.context.phase ?? context.phase)
        : context.phase
      const _event = err instanceof StateMachineError
        ? (err.context.event ?? context.event)
        : context.event
      const _action = err instanceof StateMachineError
        ? (err.context.action ?? context.action)
        : context.action
      const _transition = err instanceof StateMachineError
        ? (err.context.transition ?? context.transition)
        : context.transition
      const errorContext: ErrorContext = {
        state: currentState,
        ...(_phase !== undefined ? { phase: _phase } : {}),
        ...(_event !== undefined ? { event: _event } : {}),
        ...(_action !== undefined ? { action: _action } : {}),
        ...(_transition !== undefined ? { transition: _transition } : {}),
      }

      throw new StateMachineError(
        `Error in state machine: ${err ? (err instanceof Error ? err.message : String(err)) : 'Unknown error'}`,
        errorContext,
        (err instanceof StateMachineError
          ? err.cause
          : err instanceof Error
            ? err
            : undefined) as Error | undefined,
      )
    }
    const handlers = (fallback ?? [this.onError]).filter(Boolean)
    if (handlers.length > 0) {
      const r = handlers
        .map((action) =>
          action
            ? typeof action === 'function'
              ? action
              // OWN-key on context + prototype-builtin rejection on the adaptee
              // path: an untrusted onError name like 'constructor' / 'toString'
              // must not resolve to an Object.prototype builtin and run (W0 B1).
              : (this.context &&
                Object.hasOwn(this.context as object, action as string)
                ? (this.context as Record<string, unknown>)[action as string] as ErrorHandler<TOwner>
                : undefined) ||
              (isReservedActionName(action)
                ? undefined
                : (adaptee.get(action) as ErrorHandler<TOwner>))
            : undefined,
        )
        .filter(Boolean)
        .find((t) => t)
      if (r) handler = r
    }
    return (...args: any[]) => {
      const targetAdaptee = args.length >= 2 ? args[0] : adaptee
      const error = args.length >= 2 ? args[1] : args[0]
      // Run the (possibly user-supplied) error handler OUTSIDE the drain's
      // AsyncLocalStorage context. An `onError` handler is a legitimate
      // error-recovery point that may issue a fresh external `fireEvent`; under
      // the drain epoch that fire is FALSELY rejected as reentrant (П3 case б),
      // yet the drain does not await it, so a queued recovery event would be
      // drained. exit() clears getStore() so recovery fires queue normally,
      // while a TRUE reentrant (await fireEvent directly inside onEnter/guard,
      // which runs under the epoch, not via processError) still rejects. The
      // default rethrow handler above propagates its throw through exit()
      // unchanged (exit only swaps the ALS context, it does not catch).
      return this.drainContext.exit(() =>
        handler(this.resolveCallbackOwner(targetAdaptee), error),
      )
    }
  }

  private async callAction<CallResult>(
    obj: Adapter<TOwner>,
    actionName: ActionOrString<TOwner, CallResult>,
    ...args: any[]
  ): Promise<CallResult | void> {
    const targetOwner = this.resolveCallbackOwner(obj)
    const _callActionState = this.getCurrentState(
      obj as unknown as Adapter<PropertiesOf<TOwner>>,
    )
    const context: ErrorContext = {
      /* c8 ignore next */
      ...(_callActionState !== undefined ? { state: _callActionState } : {}),
      phase: 'action',
      action: typeof actionName === 'string' ? actionName : 'anonymous',
    }

    const executeAction = async (): Promise<CallResult | void> => {
      try {
        // 1. Check in Context (Dependency Injection). OWN-key only: a bare
        // bracket access walks the prototype chain, so an untrusted name like
        // 'constructor' / 'toString' would resolve to an Object.prototype
        // builtin (itself typeof 'function') and be invoked as a guard/action —
        // an authorization bypass out of untrusted JSON (W0 B1). Object.hasOwn
        // confines resolution to the context's OWN DI entries.
        if (
          this.context &&
          Object.hasOwn(this.context as object, actionName as string)
        ) {
          const action = (this.context as Record<string, unknown>)[actionName as string] as EventAction<
            TOwner,
            CallResult
          >
          /* c8 ignore next */
          if (typeof action === 'function') {
            const result = action(targetOwner, ...args)
            return result instanceof Promise ? await result : result
          }
        }

        // 2. Check if it's an inline function (Compatibility mode)
        else if (typeof actionName === 'function') {
          const result = actionName(targetOwner, ...args)
          return result instanceof Promise ? await result : result
        }

        // 3. Check in Object/Adaptee (Data Context). Reject prototype-builtin
        // names BEFORE the lookup so the bare bracket read inside the adapter's
        // get() cannot resolve 'constructor' / 'toString' / … to a callable
        // builtin and invoke it (W0 B1). Legitimate own/method names whose
        // identifier is not a prototype builtin are unaffected.
        else if (!isReservedActionName(actionName) && obj.get(actionName as any)) {
          const action = obj.get(actionName as any)
          /* c8 ignore next */
          if (typeof action === 'function') {
            const result = action(targetOwner, ...args)
            /* c8 ignore next */
            return result instanceof Promise ? await result : result
          }
        }
        throw new StateMachineError('No action found', context)
      } catch (error) {
        if (error instanceof StateMachineError) throw error
        throw new StateMachineError(
          `Error executing action: ${error instanceof Error ? error.message : String(error)}`,
          context,
          /* c8 ignore next */
          error instanceof Error ? error : undefined,
        )
      }
    }

    // Apply timeout if configured
    if (this.transitionTimeout && this.transitionTimeout > 0) {
      const timeoutMs = this.transitionTimeout
      let timeoutHandle: any
      const timeoutPromise = new Promise<never>((_, reject) => {
        const fire = () => reject(new StateMachineError('Transition timeout', {
          /* c8 ignore next */
          action: typeof actionName === 'string' ? actionName : 'anonymous',
          phase: 'action',
        }))
        timeoutHandle = this.setTimer(fire, timeoutMs)
      })
      // The deadline handle is disposed on EVERY outcome and on EVERY scheduler.
      // The cleanup used to be attached only when a scheduler was injected, so
      // with the DEFAULT scheduler a winning (fast) action left a real
      // `setTimeout` pending for the whole `transitionTimeout` on every single
      // action call — and a pending Node timer keeps the event loop alive, so a
      // process that had finished its work could hang for up to one
      // `transitionTimeout` per outstanding handle.
      //
      // Calling `clearTimer` on the default path is safe: the default scheduler
      // is never `start()`-ed by the machine, so `isActive()` is permanently
      // false and `setTimer`/`clearTimer` degrade to a plain
      // `setTimeout`/`clearTimeout` pair. `timeoutHandle` is a local assigned
      // synchronously by the executor above, is never published anywhere else,
      // and `finally` runs exactly once — so this can neither double-clear nor
      // clear a foreign handle. When the TIMEOUT wins, the handle has already
      // fired and `clearTimeout` is a harmless no-op.
      return Promise.race([executeAction(), timeoutPromise]).finally(() => {
        this.clearTimer(timeoutHandle)
      })
    }

    return executeAction()
  }

  /**
   * SPEC §4.2 — specificity class of a transition source: `0` fully-explicit
   * `from`, `1` partial wildcard (`'a|*'` — some but not all parts are `'*'`),
   * `2` the full `'*'`. Lower = higher precedence, so an explicit source ALWAYS
   * beats a wildcard regardless of declaration order (the F9/V2 fix).
   */
  private sourceSpecificity(from: string): 0 | 1 | 2 {
    if (from === '*') return 2
    return from.split('|').some((part) => part === '*') ? 1 : 0
  }

  /**
   * SPEC §3 / §4.3 — `matchedSources` for descendant dominance: map each active
   * atomic leaf this transition's `from` governs to the concrete declared source
   * part that governs it. Pointwise (per active leaf), NOT a numeric depth, so
   * only genuine ancestor↔descendant pairs are ranked and sibling regions stay
   * incomparable. Assumes the transition already passed `isTransitionPossible`.
   */
  private computeCoverMap(
    from: string,
    activeLeaves: string[],
  ): Map<string, string> {
    const map = new Map<string, string>()
    for (const part of from.split('|')) {
      if (part === '*') {
        // A wildcard part governs every active leaf with source '*'. Never
        // overrides a more specific part that already claimed a leaf.
        for (const leaf of activeLeaves) {
          if (!map.has(leaf)) map.set(leaf, '*')
        }
        continue
      }
      let matchedAny = false
      for (const leaf of activeLeaves) {
        // `part` is ancestor-or-equal of this active leaf → it governs it.
        if (leaf === part || leaf.startsWith(part + '.')) {
          const existing = map.get(leaf)
          // The DEEPER (more specific) source wins governance of a leaf.
          if (existing === undefined || part.startsWith(existing + '.')) {
            map.set(leaf, part)
          }
          matchedAny = true
        }
      }
      if (!matchedAny) {
        // Exotic fast-path: `part` is DEEPER than the active leaf in its region
        // (isTransitionPossible matched via isParentState(activeLeaf, part)).
        // Attribute it to that region's active leaf so coverage stays non-empty.
        const regionKey = this.getRegionKey(part)
        for (const leaf of activeLeaves) {
          if (this.getRegionKey(leaf) === regionKey || leaf === regionKey) {
            if (!map.has(leaf)) map.set(leaf, part)
          }
        }
      }
    }
    return map
  }

  /**
   * SPEC §4.3 — does `T1` (cover map `m1`) STRICTLY dominate `T2` (`m2`)?
   *
   * SUBSET dominance (W3-B.1 fix, finding #1): `T1` dominates `T2` iff T1's
   * governed leaves are a SUBSET of T2's, and on every leaf T1 governs, T1's
   * source equals or is a descendant of T2's, strictly deeper on at least one.
   * This makes a narrow deep candidate (a lane leaf `RUN.read.busy`, covering
   * one leaf) dominate a broad shallow one (the parent `RUN`, covering both
   * lanes) — the descendant preempts the ancestor even when their coverage
   * differs, as SCXML/UML require and §6a/§9.1 promise. The earlier size-equality
   * gate made these INCOMPARABLE, so document order decided and a first-declared
   * parent could beat a lane leaf (last-declared regression). Subset dominance
   * stays a strict partial order: reflexive-free (needs a strict descendant),
   * transitive (A⊆B⊆C with pointwise descent ⇒ A⊆C), antisymmetric.
   *
   * Incomparable coverage (sibling regions/branches, neither a subset of the
   * other) → `false`, so such candidates diverge at document order (§4.4).
   */
  private dominates(
    m1: Map<string, string>,
    m2: Map<string, string>,
  ): boolean {
    let strict = false
    for (const [leaf, s1] of m1) {
      const s2 = m2.get(leaf)
      if (s2 === undefined) return false // T1 governs a leaf T2 doesn't → not a subset
      if (s1 === s2) continue
      if (s1.startsWith(s2 + '.')) {
        strict = true // s1 is a strict descendant of s2 on this leaf
        continue
      }
      return false // s1 is an ancestor of s2, or unrelated → not dominating
    }
    return strict
  }

  /**
   * SPEC §4 + §5 — order the already-eligible candidates and run guards LAZILY.
   *
   * Candidates arrive pre-sorted by the static keys `(priority ↓, specificity ↑,
   * docIndex ↑)` (constructor, PERF-07). Here we apply the dynamic descendant-
   * dominance FILTER (never a comparator branch — dominance is a PARTIAL order,
   * and branching it would break sort transitivity/stability, §4), then evaluate
   * guards in that final order up to the FIRST that passes; the remaining
   * candidates' guards are NOT evaluated. A throwing guard is recorded (F7) and
   * distinguished as `guard-error` from an honest `guard-rejected` (SPEC §7 / F4).
   */
  private async selectTransition(
    obj: Adapter<PropertiesOf<TOwner>>,
    candidates: PreparedTransition<TOwner, SMConfig['states']>[],
    activeLeaves: string[],
    ...args: unknown[]
  ): Promise<{
    selected: Transition<TOwner, SMConfig['states']> | undefined
    rejected: Array<{
      transition: string
      reason: 'guard-rejected' | 'guard-error'
      error?: Error
    }>
  }> {
    const rejected: Array<{
      transition: string
      reason: 'guard-rejected' | 'guard-error'
      error?: Error
    }> = []

    // W8/V1c — copy the microstep id BEFORE the first `await` so a guard record
    // can never be retagged by a later microstep (see {@link currentMicrostep}).
    const guardMicrostep = this.currentMicrostep

    // Descendant-dominance as ORDER (§4, W3-B.1): a dominating descendant is
    // ordered BEFORE the ancestor it dominates (never a comparator branch —
    // dominance is a PARTIAL order; a stable topological reorder is used below).
    //
    // Perf (W3-B residual): dominance only ever applies WITHIN a group of equal
    // (priority, specificity). On a wide event whose candidates differ in those
    // cheap integer keys — the common case — no pair qualifies, so a cover map
    // must never be built. Compute cover maps LAZILY, memoized, and only after
    // the O(1) key check passes; a candidate that shares its keys with no other
    // costs zero cover-map work. Fast-paths: ≤1 candidate, or all keys distinct.
    let survivors = candidates
    if (candidates.length > 1) {
      // A group exists only if some (priority, specificity) key repeats.
      const keyCount = new Map<string, number>()
      let anyGroup = false
      for (const c of candidates) {
        const k = `${c.priority} ${c.specificity}`
        const n = (keyCount.get(k) ?? 0) + 1
        keyCount.set(k, n)
        if (n > 1) anyGroup = true
      }
      if (anyGroup) {
        const coverCache: Array<
          ReturnType<StateMachine<TOwner, SMConfig>['computeCoverMap']> | undefined
        > = new Array(candidates.length)
        const coverOf = (i: number) => {
          let m = coverCache[i]
          if (!m) {
            m = this.computeCoverMap(
              candidates[i]!.transition.from as string,
              activeLeaves,
            )
            coverCache[i] = m
          }
          return m
        }
        // W3-B.1 finding #2: dominance is an ORDER, not a filter. A dominating
        // descendant is placed BEFORE the ancestor it dominates, but the
        // ancestor is NOT removed — the lazy guard loop tries the descendant
        // first and FALLS BACK to the ancestor if the descendant's guard rejects
        // (SCXML/UML bubble-up; §6.1). STABLE topological reorder: repeatedly
        // take the first remaining candidate (in pre-sorted order) not dominated
        // by any other remaining one. Dominance is a strict partial order, so a
        // maximal element always exists → terminates, deterministic.
        const idxOf = new Map(candidates.map((c, i) => [c, i]))
        const domOrder = (
          a: PreparedTransition<TOwner, SMConfig['states']>,
          b: PreparedTransition<TOwner, SMConfig['states']>,
        ) =>
          a.priority === b.priority &&
          a.specificity === b.specificity &&
          this.dominates(coverOf(idxOf.get(a)!), coverOf(idxOf.get(b)!))
        const remaining = candidates.slice()
        const ordered: PreparedTransition<TOwner, SMConfig['states']>[] = []
        while (remaining.length > 0) {
          let idx = remaining.findIndex(
            (c) => !remaining.some((o) => o !== c && domOrder(o, c)),
          )
          if (idx < 0) idx = 0 // cycle-safety (unreachable for a partial order)
          ordered.push(remaining.splice(idx, 1)[0]!)
        }
        survivors = ordered
      }
    }

    // Lazy guards: first candidate whose guard passes wins; the rest are skipped.
    for (const { transition } of survivors) {
      const label = `${transition.from} -> ${transition.to}`
      if (!transition.guard) {
        return { selected: transition, rejected }
      }

      // OTS (SPEC §6.1) — a candidate can GOVERN several active leaves, so the
      // per-leaf climb would otherwise evaluate its guard once per governed leaf.
      // A guard is deterministic for the microstep, so its result is cached
      // (keyed by transition reference) and reused: each guard runs AT MOST ONCE
      // per microstep, preserving the single-region "guard called exactly once"
      // contract even when firing across regions (side-effecting done.state
      // guards must not double-count).
      const cache = this.microstepGuardCache
      const cached = cache?.get(transition)
      if (cached) {
        if (cached.passed) return { selected: transition, rejected }
        rejected.push({
          transition: label,
          reason: cached.threw ? 'guard-error' : 'guard-rejected',
          // The cache carries the guard error so a cross-region re-offer of the
          // same transition reports guard-error WITH its `error` (§7), not a
          // bare label — the earlier cache dropped it.
          ...(cached.error !== undefined ? { error: cached.error } : {}),
        })
        continue
      }

      const _guardState = this.getCurrentState(obj)
      const context: ErrorContext = {
        /* c8 ignore next */
        ...(_guardState !== undefined ? { state: _guardState } : {}),
        phase: 'guard',
        transition: label,
      }

      let passed = false
      let threw = false
      let guardError: Error | undefined
      // W8/V1c — emit ONLY around a REAL evaluation. The cache-hit branch above
      // returns early, so a candidate governing several leaves still produces
      // exactly ONE guard pair per microstep — the channel reports guard
      // EXECUTIONS, matching the engine's "each guard runs at most once per
      // microstep" contract rather than the number of times it was consulted.
      const guardOwner = this.lifecycleEnabled
        ? this.ownerKey(obj as unknown as Adapter<any>)
        : (undefined as unknown as object)
      if (this.lifecycleEnabled) {
        this.emitLifecycle('guard', 'guard', transition.from as string, guardOwner, guardMicrostep, 'begin', {
          transition: label,
        })
      }
      try {
        passed = Boolean(
          await this.callAction(obj as any, transition.guard, ...args),
        )
        if (this.lifecycleEnabled) {
          this.emitLifecycle('guard', 'guard', transition.from as string, guardOwner, guardMicrostep, 'end', {
            transition: label,
            failed: false,
            outcome: passed,
          })
        }
      } catch (error) {
        if (this.lifecycleEnabled) {
          // A THROWING guard leaves the transition DISABLED, so the outcome the
          // consumer must count for coverage is `false` — alongside `failed:true`,
          // which distinguishes it from an honest rejection.
          this.emitLifecycle('guard', 'guard', transition.from as string, guardOwner, guardMicrostep, 'end', {
            transition: label,
            failed: true,
            outcome: false,
          })
        }
        threw = true
        // F7: a guard EXCEPTION must reach the OBSERVABLE monitor.recordError
        // channel (context phase:'guard') — invisible otherwise to a consumer's
        // monitor and to the quantitative simulator oracles (A1/W5). The
        // transition stays DISABLED (never a throw). SPEC §7/F4: the cause is
        // now distinguishable as `guard-error` vs an honest `guard-rejected`.
        const errObj = error instanceof Error ? error : new Error(String(error))
        guardError = errObj
        if (this.errorHandler.isEnabled()) {
          const alreadyReported =
            typeof errObj === 'object' &&
            errObj !== null &&
            (errObj as unknown as Record<symbol, unknown>)[
              RUNTIME_ERROR_REPORTED
            ] === true
          if (!alreadyReported) {
            try {
              this.monitor.recordError(errObj, context)
            } catch {
              /* a monitor sink must never break selection */
            }
          }
          // П2 dedup (W1 parity): mark so a later surfacing of the SAME error
          // object does not double-count recordError for the oracles (W5).
          try {
            ;(errObj as unknown as Record<symbol, unknown>)[
              RUNTIME_ERROR_REPORTED
            ] = true
          } catch {
            /* frozen/exotic error object — dedup degrades to prior behavior */
          }
        }
        // Preserve the config-level onError side effect (best-effort); its
        // result never re-enables the disabled transition, and a rejection from
        // it must not escape selection.
        try {
          await this.processError(
            obj as any,
            context,
            transition.onError,
            this.onError,
          )(error)
        } catch {
          /* onError best-effort: a throwing/rejecting handler stays contained */
        }
        rejected.push({ transition: label, reason: 'guard-error', error: errObj })
      }

      this.microstepGuardCache?.set(transition, {
        passed,
        threw,
        ...(guardError !== undefined ? { error: guardError } : {}),
      })

      if (passed) {
        return { selected: transition, rejected }
      }
      if (!threw) {
        rejected.push({ transition: label, reason: 'guard-rejected' })
      }
    }

    return { selected: undefined, rejected }
  }

  private isTransitionPossible(
    transition: Transition<TOwner, SMConfig['states']>,
    currentState: string,
    // PERF-01: callers on the hot path (a single fireEvent over many candidates)
    // pass the ONE parsed active configuration so it is not re-parsed per
    // transition. `currentState` stays for the standalone (canFireEvent) callers.
    parsed?: Map<string, string>,
  ): boolean {
    const currentStates = parsed ?? this.parseCompositeState(currentState)

    // Handle wildcard transition
    if (transition.from === '*') {
      return true
    }

    const fromStates = transition.from.split('|')

    return fromStates.every((fromState) => {
      // Handle wildcard in parallel state part (e.g. "lobby|*")
      if (fromState === '*') return true

      // Fast path: exact region-key lookup (leaf or in-region ancestor `from`).
      const regionKey = this.getRegionKey(fromState)
      const currentStateForRegion = currentStates.get(regionKey)
      if (
        currentStateForRegion &&
        (currentStateForRegion === fromState ||
          this.isParentState(currentStateForRegion, fromState))
      ) {
        return true
      }

      // Ancestor-scan fallback (D3): a transition whose source is a composite
      // parent is eligible whenever its parent is in the active configuration,
      // i.e. `fromState` equals or is an ancestor of any active atomic leaf.
      // Mirrors SCXML source-in-active-configuration; preserves the outer
      // .every() so a multi-part `from` still requires every part to match.
      return Array.from(currentStates.values()).some(
        (leaf) => leaf === fromState || this.isParentState(fromState, leaf),
      )
    })
  }

  private isParentState(parentState: string, childState: string): boolean {
    return (
      childState.startsWith(parentState + '.') || childState === parentState
    )
  }

  /**
   * SPEC §6.3 — execute the Optimal Transition Set (one or many transitions) as
   * ONE atomic microstep. Returns an OUTCOME discriminator:
   *   • `{ kind: 'ok' }`          — the requested target was committed (success);
   *   • `{ kind: 'error-state' }` — the target FAILED (onEnter threw) and the
   *     machine recovered into the configured `errorState` (W4.1 #3: a FAILED
   *     transition, NOT a success — the caller reports `fired:false` so the
   *     detailed channel agrees with the monitor and the observable state);
   *   • `undefined`               — the microstep aborted (invalid target /
   *     onExit-abort / transitionTimeout).
   * Throws only to PROPAGATE an unhandled action error (the caller records+rethrows).
   *
   * П5 (single root): timer teardown and invoke re-arming happen strictly AFTER
   * the point of no return (the configuration write), and the enter-set is
   * computed from the ACTUALLY-committed configuration — so an aborted or
   * timed-out microstep never destroys the source's still-live timers, a throw
   * in `onAfter`/`onEnter` never orphans a target timer, and a history restore
   * arms the RESTORED leaves rather than the regional default.
   */
  private async applyMicrostep(
    obj: Adapter<TOwner>,
    currentState: string,
    enabled: Array<{
      transition: Transition<TOwner, SMConfig['states']>
      source: string
      coveredLeaves: string[]
      order: number
    }>,
    args: any[],
    eventName: keyof SMConfig['events'],
    event: Event<TOwner, SMConfig['states']>,
  ): Promise<{ kind: 'ok' | 'error-state' } | undefined> {
    const label = enabled
      .map((e) => `${e.transition.from} -> ${e.transition.to}`)
      .join(', ')
    const context: ErrorContext = {
      state: currentState,
      event: String(eventName),
      transition: label,
      phase: 'transition',
    }

    // W8/V1 — the id assigned when this microstep's selection began
    // ({@link computeEnabledSet}), copied before the first `await` so the whole
    // exit → enter → commit → arm span carries ONE stable id, including when the
    // microstep aborts and its enter records must be discarded by the consumer.
    const microstep = this.currentMicrostep

    // Resolve the fully-committed target configuration (region expansion +
    // conflict removal + HISTORY restoration) BEFORE any action runs, and derive
    // the enter/exit sets from it. Folding each fired transition's target over a
    // working copy generalises `updateState` to the whole set (updateState /
    // previewCommitState are side-effect free). A contradictory target throws
    // here and aborts cleanly with no half-run action.
    let finalConfig: string
    let enterStates: string[]
    let exitStates: string[]
    try {
      let working = currentState
      for (const { transition } of enabled) {
        const raw = transition.to as string
        // T1: a `to:'*'` self-transition resolves to the CURRENT configuration —
        // no state change, onEnter is not lost (nothing to enter/exit), only the
        // transition action runs. (Never the old broken `enterFireOrder:['*']`.)
        if (raw === '*') continue
        working = this.previewCommitState(working, raw as StateName, obj)
      }
      finalConfig = this.orderComposite(working)
      const sets = this.computeEnterExitSets(currentState, finalConfig)
      enterStates = sets.enterStates
      exitStates = sets.exitStates
    } catch (error) {
      this.logger.warn('Transition aborted: invalid target configuration', {
        state: currentState,
        target: label,
        error,
      })
      return undefined
    }

    this._isTransitioning = true
    this._targetState = finalConfig

    // SPEC §11 — transitionTimeout is enforced per-action inside {@link callAction}
    // (a `Promise.race` against a scheduler-driven deadline that REJECTS with a
    // StateMachineError). A microstep is atomic under RTC, so a hung action
    // surfaces as a normal action throw here and aborts the whole microstep
    // BEFORE the point of no return — no extra race is needed at this level.
    type Outcome =
      | { kind: 'ok' }
      | { kind: 'abort-exit' }
      | { kind: 'error-state' }
      | { kind: 'throw'; error: unknown }

    const risky = async (): Promise<Outcome> => {
      // Phase 2: before-event action.
      if (event.onBefore) {
        await this.callAction(obj, event.onBefore, ...args).catch(
          this.processError(obj, { ...context }, undefined, this.onError),
        )
      }

      // Phase 3: exit ACTIONS — descendant-first over the combined exit set. NO
      // timer teardown here (П5); timers are torn down post-commit only. W3b:
      // each exiting leaf's onExit receives an ExitContext (SPEC §6а «б»), built
      // from the SOURCE configuration (`currentState`) and the resolved target.
      const sourceLeaves = currentState.split('|').filter(Boolean)
      try {
        for (const exitStateName of exitStates) {
          const exitCtx = this.buildExitContext(
            exitStateName,
            sourceLeaves,
            finalConfig,
            String(eventName),
          )
          await this.executeExitActions(obj, exitStateName, args, context, exitCtx, microstep)
        }
      } catch (error) {
        if (this.abortOnExitError) return { kind: 'abort-exit' }
        return { kind: 'throw', error }
      }

      // Phase 4: history — record for every fired transition's source.
      for (const { transition } of enabled) {
        this.manageStateHistory(transition.from, currentState, obj)
      }

      // Phase 5: transition actions — one per fired transition.
      for (const { transition } of enabled) {
        if (transition.onTransition) {
          await this.callAction(obj, transition.onTransition, ...args).catch(
            this.processError(
              obj,
              { ...context },
              transition.onError,
              this.onError,
            ),
          )
        }
      }

      // Phase 6: enter ACTIONS — ancestor-first over the combined enter set.
      // Invoke arming is DEFERRED to post-commit (armTimers=false) so a later
      // throw / timeout aborts before any target timer is armed (EO-4).
      try {
        for (const enterStateName of enterStates) {
          await this.executeEnterActions(obj, enterStateName, args, context, false, microstep)
        }
      } catch (error) {
        if (this.errorState) return { kind: 'error-state' }
        return { kind: 'throw', error }
      }

      // Phase 7: after-event action — BEFORE the commit so a throw aborts the
      // microstep cleanly with NO committed state and NO orphan timer (EO-4).
      if (event.onAfter) {
        try {
          await this.callAction(obj, event.onAfter, ...args)
        } catch (error) {
          try {
            const errorHandler = this.processError(
              obj,
              { ...context },
              event.onError,
              this.onError,
            )
            errorHandler(this.resolveCallbackOwner(obj), error)
          } catch (rethrown) {
            return { kind: 'throw', error: rethrown }
          }
        }
      }

      return { kind: 'ok' }
    }

    try {
      const result = await risky()

      if (result.kind === 'abort-exit') {
        // EO-5: an aborted (onExit-failed) microstep returns to the source with
        // its TIMERS intact — never a silent torn-down zombie. Because teardown
        // is post-commit only, the source's invoke/watchdog timers were never
        // touched, so no timer re-arm is required (re-arming a one-shot timer
        // that already fired is the reentrancy double-fire trap).
        this.logger.warn('Transition aborted due to onExit error', {
          state: currentState,
        })
        // П.1д (W3b.1) — ASYMMETRY WITH TIMERS: {@link executeExitActions}
        // `abort()`-ed the exited leaves' invoke OPERATIONS BEFORE onExit ran,
        // but the microstep did NOT commit, so those leaves are still active and
        // their operations are now dead forever (their onDone is suppressed by
        // `signal.aborted`) → a silent STALL. Unlike a one-shot timer, an
        // operation is RESTARTABLE (fresh signal, no double-fire trap), so
        // relaunch the operations of every still-active exited source leaf.
        for (const s of exitStates) {
          this.rearmInvokeOperationsAfterAbort(obj, s, microstep)
        }
        return undefined
      }

      if (result.kind === 'throw') {
        // An unhandled action error propagates. The microstep never committed
        // and teardown is post-commit, so the source timers stand as-is (the
        // invoke that fired the event was already consumed by the scheduler and
        // must NOT be re-armed — that would re-trigger the failing event in a
        // loop). But the exited leaves' invoke OPERATIONS were abort()-ed in
        // executeExitActions before the throw, and — like the abort-exit branch
        // (W3b.1) — those leaves remain active without a commit, so their
        // operations are dead forever (silent stall) unless relaunched. This
        // covers throw from onEnter-without-errorState / onExit-without-
        // abortOnExitError / onTransition / onAfter. Bounded to avoid the
        // deterministic-throw livelock (see rearmInvokeOperationsAfterAbort).
        for (const s of exitStates) {
          this.rearmInvokeOperationsAfterAbort(obj, s, microstep)
        }
        throw result.error
      }

      if (result.kind === 'error-state') {
        // ZOMBIE STATE PREVENTION: onEnter failed → commit the configured error
        // state rather than a half-entered zombie. Teardown/arm from the error
        // configuration, after the write (П5).
        const errorConfig = this.previewCommitState(
          currentState,
          this.errorState as StateName,
          obj,
        )
        const errSets = this.computeEnterExitSets(currentState, errorConfig)
        this.logger.error(
          `Failed to enter target '${finalConfig}'. Fallback to error state '${this.errorState}'`,
        )
        // W4 (EO-3): the errorState recovery is a FAILED transition and MUST be
        // observable — a machine repeatedly swallowing onEnter errors into
        // errorState otherwise reports health 'healthy' (the exact false-healthy
        // class EO-3 targets). recordTransition(false) once here (no double-count:
        // this branch never called recordError — errorCount goes 0→1). The commit
        // to errorConfig is a recovery, not a success, so success is NOT recorded.
        try {
          this.monitor.recordTransition(0, false, {
            fromState: currentState,
            toState: errorConfig,
            eventName: String(eventName),
          })
        } catch {
          /* a monitor sink must never break the drain */
        }
        this.commitConfiguration(obj, errorConfig, errSets.exitStates)
        for (const s of errSets.exitStates) this.teardownStateTimers(s, obj)
        for (const s of errSets.enterStates) this.armStateInvoke(obj, s, microstep)
        // W9: the recovery configuration can itself be ALL-FINAL (e.g. `errorState`
        // points at a region's final leaf while the sibling regions are already
        // final). The success path has always signalled completion here; this path
        // did NOT, so `isDone(C)` reported true while `done.state.<C>` was never
        // raised — a consumer's completion handler silently never ran. Recovery is
        // still a recovery (the requested target did not fire, and success is not
        // recorded), but a composite that BECAME done must say so: completion is a
        // property of the committed configuration, not of how it was reached.
        // `checkCompletion` is edge-triggered, so a configuration that was already
        // done does not re-raise.
        this.checkCompletion(obj as any, currentState, errorConfig)
        // W4.1 #3: signal error-state recovery distinctly. The requested target
        // did NOT fire — the caller reports fired:false so the detailed channel
        // matches the monitor's recordTransition(false) above and the machine's
        // now-committed errorState.
        return { kind: 'error-state' }
      }

      // POINT OF NO RETURN — commit the resolved configuration exactly once.
      // Intentional wall-clock telemetry (NOT this.clock()): measures real
      // transition latency for monitor.recordTransition. Do not virtualize.
      const transitionStartTime = Date.now()
      this.commitConfiguration(obj, finalConfig, exitStates)

      // П5: teardown the timers of leaves that ACTUALLY left the configuration,
      // then arm invoke timers for the entered leaves — from the ACTUALLY-written
      // configuration (never the regional default — T3 deep/shallow history).
      for (const s of exitStates) this.teardownStateTimers(s, obj)
      for (const s of enterStates) this.armStateInvoke(obj, s, microstep)

      // done.state.<C> innermost-first for composites that just became all-final.
      this.checkCompletion(obj as any, currentState, finalConfig)

      // W8/V5a — ADDITIVE: the SUCCESS path now carries the same
      // {@link TransitionContext} the two REFUSAL sites already pass (:1322 guard-
      // rejected, :1402 aborted, :4376 errorState). Without it the monitor could see
      // WHICH transitions committed but never WHY: an INTERNALLY raised event
      // (`done.state.<C>`, an invoke `onDone`) never appears on any external surface,
      // so a `recordTransition(success)` was an anonymous state write. The third
      // parameter has always been optional (types.ts `IMonitor.recordTransition`) and
      // every existing monitor ignores extra arguments, so this is purely additive.
      this.monitor.recordTransition(Date.now() - transitionStartTime, true, {
        fromState: currentState,
        toState: finalConfig,
        eventName: String(eventName),
      })
      return { kind: 'ok' }
    } finally {
      this._isTransitioning = false
      this._targetState = undefined
    }
  }

  /**
   * SPEC §6.3 point of no return — write an ALREADY-RESOLVED configuration
   * string (region-expanded, history-restored, documentIndex-ordered) directly,
   * in one operation over all targets. Bypasses {@link setCurrentState}'s history
   * branches because {@link previewCommitState} already applied them.
   */
  private commitConfiguration(
    obj: Adapter<TOwner>,
    config: string,
    exitStates: string[] = [],
  ): void {
    this.validateCompositeState(config)
    ;(obj as unknown as Adapter<PropertiesOf<TOwner>>).set(
      this.stateAttribute,
      config as TOwner[KeysOf<PropertiesOf<TOwner>, string>],
    )
    // A committed configuration clears the invoke-restart counters for the
    // leaves that left it — the abort-restart loop is broken, so a later
    // aborted microstep on a fresh entry starts counting from zero (W3b.1).
    //
    // W4.1 #2: clear ONLY THIS OWNER's counters, and only for the leaves that
    // ACTUALLY left in this commit (the exit set). The old global `.clear()` wiped
    // every owner's budget on any commit, so a co-resident owner's successful
    // transition reset an unrelated owner's abort-restart counter and defeated the
    // livelock bound. Scoping to the committing owner's exit set keeps each owner
    // independently bounded.
    const restarts = this.restartCountsFor(obj)
    for (const leaf of exitStates) restarts.delete(leaf)
  }

  /**
   * Execute exit actions for a state
   */
  private async executeExitActions(
    obj: Adapter<TOwner>,
    fromStateName: string,
    args: any[],
    context: ErrorContext,
    // W3b (SPEC §6а, decision «б») — supplemental context appended as the LAST
    // argument to `onExit` (never replacing the event payload).
    exitCtx: ExitContext,
    // W8/V1 — id of the microstep these exit hooks belong to (0 = no microstep;
    // see {@link microstepCounter}). Observability only: never read by the engine.
    microstep = 0,
  ): Promise<void> {
    // W3b (SPEC §6а, decision «а») — abort any in-flight invoke operations of
    // this leaf BEFORE its onExit runs, so the exit handler observes
    // `signal.aborted`. Synchronous and non-blocking; the post-commit
    // teardownStateTimers drops the (already-aborted) controllers. Done even
    // when there is no fromState config, harmless if there are no operations.
    const controllers = this.invokesFor(obj).get(fromStateName)
    if (controllers) {
      for (const controller of controllers) controller.abort()
      // W8/V1b — an abort is an instantaneous POINT, so it is reported as an
      // ADJACENT begin+end pair (the `edge` union has no 'point' member). Without
      // it an in-flight tracker cannot tell "cancelled" from "still running":
      // an aborted operation's own settle may never arrive.
      if (this.lifecycleEnabled) {
        const owner = this.ownerKey(obj)
        const abortCtx = { event: exitCtx.event }
        for (let i = 0; i < controllers.length; i++) {
          this.emitLifecycle('invoke', 'invoke.abort', fromStateName, owner, microstep, 'begin', abortCtx)
          this.emitLifecycle('invoke', 'invoke.abort', fromStateName, owner, microstep, 'end', abortCtx)
        }
      }
    }

    const fromState = this.states.get(fromStateName)

    // П5 (SPEC §6.3): exit ACTIONS only — the per-leaf invoke-timer teardown and
    // stateEntryTimes cleanup were REMOVED from here and moved AFTER the
    // point of no return ({@link teardownStateTimers}, called post-commit). Doing
    // teardown here unconditionally destroyed the SOURCE watchdog/invoke timers
    // BEFORE the transition committed, so an aborted/timed-out transition (Q4)
    // lost them forever. Timers are now torn down only for states that ACTUALLY
    // left the committed configuration.
    if (!fromState) return

    const exitErrorContext = { ...context, phase: 'exit' as const }

    // Execute exit actions in sequence. Only `onExit` receives the ExitContext
    // as a trailing argument (SPEC §6а): onExit(adaptee, ...payload, exitCtx).
    await this.runExitAction(obj, fromState, fromStateName, 'onBeforeExit', fromState.onBeforeExit, args, exitErrorContext, microstep)
    await this.runExitAction(obj, fromState, fromStateName, 'onExit', fromState.onExit, [...args, exitCtx], exitErrorContext, microstep)
    await this.runExitAction(obj, fromState, fromStateName, 'onAfterExit', fromState.onAfterExit, args, exitErrorContext, microstep)
  }

  /**
   * W3b helper — run one exit hook with its error routing (or skip if absent).
   * W8/V1 — also the emission point of the hook's `exit` begin/end pair; error
   * routing is delegated to {@link runLifecycleAction} unchanged.
   */
  private async runExitAction(
    obj: Adapter<TOwner>,
    fromState: State<TOwner>,
    fromStateName: string,
    hook: string,
    action: ActionOrString<TOwner> | undefined,
    callArgs: any[],
    exitErrorContext: ErrorContext,
    microstep: number,
  ): Promise<void> {
    if (!action) return
    await this.runLifecycleAction(
      obj,
      action,
      callArgs,
      this.processError(obj, exitErrorContext, fromState.onError, this.onError),
      'exit',
      hook,
      fromStateName,
      microstep,
      exitErrorContext.event,
    )
  }

  /**
   * W3b (SPEC §6а, decision «б») — assemble the {@link ExitContext} for a node
   * leaving the configuration.
   *
   * - `wasFinal` — the node itself is `final` at exit.
   * - `preempted` — the node was swept from OUTSIDE before completing (`true`)
   *   vs its region/composite reached its final ("done") configuration
   *   (`false`). Completion is judged on the SOURCE leaves: the nearest
   *   enclosing composite is `done` (a region-leaf that reached final), or a
   *   composite node is itself `done`, or a flat leaf is itself `final`.
   *   A node swept while its composite is NOT done (e.g. a parallel-exit, or a
   *   final leaf killed while its sibling region is still running) is preempted.
   */
  private buildExitContext(
    fromStateName: string,
    sourceLeaves: string[],
    target: string,
    event: string,
  ): ExitContext {
    const wasFinal = this.isStateFinal(fromStateName)
    const node = this.states.get(fromStateName)
    let completed: boolean
    if (node?.regions) {
      // A composite node: it completed iff it is all-regions-final at source.
      completed = this.isCompositeDone(fromStateName, sourceLeaves)
    } else {
      const enclosing = this.enclosingComposite(fromStateName)
      completed = enclosing
        ? this.isCompositeDone(enclosing, sourceLeaves)
        : wasFinal
    }
    return { event, preempted: !completed, wasFinal, target }
  }

  /**
   * W3b — the NEAREST (deepest) registered composite ancestor of `leaf`,
   * excluding `leaf` itself, or `undefined` when `leaf` has no enclosing
   * composite (a top-level state). ancestorChain is root-to-leaf, so the last
   * regions-bearing entry before the leaf is the closest enclosing composite.
   */
  private enclosingComposite(leaf: string): string | undefined {
    const chain = this.ancestorChain(leaf)
    for (let i = chain.length - 1; i >= 0; i--) {
      const id = chain[i]!
      if (id === leaf) continue
      if (this.states.get(id)?.regions) return id
    }
    return undefined
  }

  /**
   * Execute enter actions for a state
   */
  private async executeEnterActions(
    obj: Adapter<TOwner>,
    toStateName: string,
    args: any[],
    context: ErrorContext,
    // П5 (SPEC §6.3): when false, run enter ACTIONS only and DEFER invoke-timer
    // arming to {@link armStateInvoke} (called post-commit, from the actually
    // written configuration). The microstep path passes false so a throw in a
    // later phase (onAfter/onEnter of a sibling) or a transitionTimeout aborts
    // BEFORE any target timer is armed — no orphan timer (EO-4). The construction
    // / reset / resume paths keep the default (true): the configuration is
    // already committed when they enter, so arming inline stays correct.
    armTimers = true,
    // W8/V1 — id of the microstep these enter hooks belong to. The default `0` is
    // the RESERVED "no microstep" id used by the construction / reset / resume
    // paths, which enter a configuration outside any event-driven microstep (see
    // {@link microstepCounter}). Observability only: never read by the engine.
    microstep = 0,
  ): Promise<void> {
    const toState = this.states.get(toStateName)
    if (!toState) return

    const enterContext = { ...context, phase: 'enter' as const }

    // Execute enter actions in sequence
    const enterActions = [
      toState.onBeforeEnter,
      toState.onEnter,
      toState.onAfterEnter,
    ]

    for (let i = 0; i < enterActions.length; i++) {
      const action = enterActions[i]
      if (action) {
        await this.runLifecycleAction(
          obj,
          action,
          args,
          this.processError(obj, enterContext, toState.onError, this.onError),
          'enter',
          ENTER_HOOK_NAMES[i] as string,
          toStateName,
          microstep,
          enterContext.event,
        )
      }
    }

    if (armTimers) {
      this.armStateInvoke(obj, toStateName, microstep)
    }
  }

  /**
   * П5/EO-4 (SPEC §6.3) — arm the per-leaf invoke timers for a state that has
   * just (or already) entered the COMMITTED configuration. Any handles left over
   * for this state are cleared FIRST ("activeTimers.set clears the old handle"),
   * so a re-entry never orphans a prior attempt's timer. Extracted from
   * {@link executeEnterActions} so the microstep can arm strictly AFTER the point
   * of no return, while enter ACTIONS still run before it.
   */
  private armStateInvoke(
    obj: Adapter<TOwner>,
    toStateName: string,
    // W8/V1b — the microstep that ARMED these invokes. Captured into the launch /
    // fire closures so an operation that starts and settles LONG after the
    // microstep committed is still attributable to the entry that armed it.
    microstep = 0,
  ): void {
    const toState = this.states.get(toStateName)
    if (!toState || !toState.invoke || toState.invoke.length === 0) return

    // П6: all timer/operation/entry-time bookkeeping is scoped to THIS owner.
    const ownerTimers = this.timersFor(obj)
    const ownerInvokes = this.invokesFor(obj)
    const ownerEntryTimes = this.entryTimesFor(obj)

    // Clear any stale handles for this state before re-arming (EO-4).
    const existing = ownerTimers.get(toStateName)
    if (existing) {
      for (const timerId of existing) this.clearTimer(timerId)
      ownerTimers.delete(toStateName)
    }
    // W3b: abort + drop any stale invoke operations for this state before
    // re-arming (parity with the timer stale-clear above).
    const staleOps = ownerInvokes.get(toStateName)
    if (staleOps) {
      for (const controller of staleOps) controller.abort()
      ownerInvokes.delete(toStateName)
    }

    // Record entry time if not already recorded (e.g. from resumeTimers)
    if (!ownerEntryTimes.has(toStateName)) {
      ownerEntryTimes.set(toStateName, this.clock())
    }

    const timers: any[] = []
    const controllers: AbortController[] = []
    for (const invocation of toState.invoke) {
      // Check condition (cond) before starting the timer / operation.
      if (invocation.cond) {
        try {
          const shouldInvoke = invocation.cond(obj.adaptee)
          if (!shouldInvoke) continue
        } catch (e) {
          this.logger.error(
            'Error in invoke condition',
            { state: toStateName },
            e as Error,
          )
          continue
        }
      }

      // W3b (SPEC §6а, decision «а») — the long-running operation form. The
      // operation is STARTED via the scheduler (setTimer delay 0) so, under an
      // injected scheduler, its launch is deterministic just like a timer; its
      // AbortController lives here alongside the timers and is aborted before
      // onExit (executeExitActions). onDone/onError are raised as INTERNAL
      // events; the event of an already-aborted operation is dropped.
      if (this.isInvokeOperation(invocation)) {
        const { controller, timerId } = this.launchInvokeOperation(
          obj,
          toStateName,
          invocation,
          microstep,
        )
        controllers.push(controller)
        timers.push(timerId)
        continue
      }

      // П.7 (W3b.1) — a restored OPERATION marker (`type:'operation'`) whose
      // `src` could NOT be re-linked from the registry is NOT a timer: it has no
      // numeric `delay` and no `event`. Falling through would `setTimer(cb,
      // undefined→NaN)` and later `raiseEvent(undefined)` — a phantom event on
      // every entry. Skip it explicitly (parity with the resumeTimers guard).
      if (!this.isResumableTimerInvocation(invocation)) {
        this.logger.warn(
          'invoke operation not serializable; skipping non-resumable invoke on entry',
          { state: toStateName },
        )
        continue
      }

      // Timer form (PRESERVED): raise `event` after `delay` ms.
      const timer = invocation
      const callback = async () => {
        const currentState = this.getCurrentState(obj as any)
        if (currentState?.split('|').includes(toStateName)) {
          try {
            if (timer.action) {
              await this.runTracedInvokeAction(
                obj,
                timer.action,
                toStateName,
                microstep,
                timer.event !== undefined ? String(timer.event) : undefined,
              )
            }
            this.raiseEvent(timer.event as string, obj as any, {
              hook: 'raise.invoke.timer',
              state: toStateName,
              // The ARMING microstep from the enclosing closure (INVOKE ASYMMETRY).
              microstep,
            })
            this.scheduleProcessing()
          } catch (err) {
            this.logger.error(
              'Invocation error',
              { state: toStateName, event: timer.event },
              err as Error,
            )
            this.reportInvokeTimerFailure(err, toStateName, timer.event, obj)
          }
        }
      }

      const timerId = this.setTimer(callback, timer.delay)
      timers.push(timerId)
    }
    ownerTimers.set(toStateName, timers)
    if (controllers.length > 0) {
      ownerInvokes.set(toStateName, controllers)
    }
  }

  /**
   * W3b (SPEC §6а) — start ONE long-running invoke operation via the scheduler
   * (setTimer delay 0) so its launch is deterministic under an injected
   * scheduler, returning the fresh {@link AbortController} and the launch timer
   * id. Extracted from {@link armStateInvoke} so the П.1д abort-exit re-arm
   * ({@link rearmInvokeOperationsAfterAbort}) can relaunch a source leaf's
   * operation with a FRESH signal without duplicating the launch body.
   */
  private launchInvokeOperation(
    obj: Adapter<TOwner>,
    toStateName: string,
    op: InvokeOperation<TOwner>,
    // W8/V1b — the microstep that armed this operation, carried into the launch
    // closure so a long-running `src` settling many microsteps later is still
    // attributed to the entry that started it.
    microstep = 0,
  ): { controller: AbortController; timerId: any } {
    const controller = new AbortController()
    const startOp = () => {
      // Still in the leaf, and not already aborted by an exit that raced the
      // scheduled start.
      const currentState = this.getCurrentState(obj as any)
      if (!currentState?.split('|').includes(toStateName)) return
      if (controller.signal.aborted) return
      // W8/V1b — `begin` marks the moment `src` is ACTUALLY invoked (after the
      // still-in-leaf / not-yet-aborted checks), so a scheduled-then-cancelled
      // launch never opens a pair that will not close.
      const traced = this.lifecycleEnabled
      const owner = traced ? this.ownerKey(obj) : (undefined as unknown as object)
      const opCtx =
        op.onDone !== undefined ? { event: String(op.onDone) } : undefined
      if (traced) {
        this.emitLifecycle('invoke', 'invoke.operation', toStateName, owner, microstep, 'begin', opCtx)
      }
      let result: Promise<unknown>
      try {
        result = op.src(obj.adaptee, controller.signal)
      } catch (err) {
        if (traced) {
          this.emitLifecycle('invoke', 'invoke.operation', toStateName, owner, microstep, 'end', {
            ...opCtx,
            failed: true,
          })
        }
        this.handleInvokeRejection(obj, op, controller, err, toStateName, microstep)
        return
      }
      Promise.resolve(result).then(
        (value) => {
          // W8/V1b — `end` is emitted on SETTLE, even when the operation was
          // aborted meanwhile: the work really did finish, and the dropped
          // completion event below is a separate fact. An operation whose `src`
          // never settles correctly shows as a `begin` with no `end`.
          if (traced) {
            this.emitLifecycle('invoke', 'invoke.operation', toStateName, owner, microstep, 'end', {
              ...opCtx,
              failed: false,
            })
          }
          // Cancelled (leaf left before settle) → drop the completion event.
          if (controller.signal.aborted) return
          if (op.onDone) {
            this.raiseEvent(
              op.onDone as string,
              obj as any,
              {
                hook: 'raise.invoke.onDone',
                state: toStateName,
                // ARMING microstep (INVOKE ASYMMETRY): a long-running `src` can
                // settle many microsteps after the entry that launched it.
                microstep,
              },
              value,
            )
            this.scheduleProcessing()
          }
        },
        (err) => {
          if (traced) {
            this.emitLifecycle('invoke', 'invoke.operation', toStateName, owner, microstep, 'end', {
              ...opCtx,
              failed: true,
            })
          }
          this.handleInvokeRejection(obj, op, controller, err, toStateName, microstep)
        },
      )
    }
    const timerId = this.setTimer(startOp, 0)
    return { controller, timerId }
  }

  /**
   * П.1д (W3b.1) — after an ABORTED (non-committed) microstep the machine is
   * back in the SOURCE configuration, but {@link executeExitActions} already
   * `abort()`-ed the source leaves' invoke OPERATIONS before `onExit` ran. The
   * leaf is still active, so its operation must LIVE AGAIN: relaunch it with a
   * FRESH AbortSignal (an operation is restartable — `src` re-runs cleanly and,
   * unlike a one-shot EO-5 timer, there is no re-arm double-fire trap). ONLY the
   * operation arms are restarted; timer-form invokes are LEFT UNTOUCHED (EO-5 —
   * their handles were never torn down and re-arming would duplicate a live /
   * already-fired one-shot timer). No-op when the leaf has no operations, has
   * left the configuration, or its `cond` now declines.
   */
  private rearmInvokeOperationsAfterAbort(
    obj: Adapter<TOwner>,
    stateName: string,
    // W8/V1b — the ABORTED microstep whose rollback triggers this relaunch; the
    // relaunched operation's records are attributed to it.
    microstep = 0,
  ): void {
    const toState = this.states.get(stateName)
    if (!toState || !toState.invoke || toState.invoke.length === 0) return
    if (!toState.invoke.some((inv) => this.isInvokeOperation(inv))) return
    // Only relaunch for a leaf that REMAINS in the (uncommitted) configuration.
    const currentState = this.getCurrentState(obj as any)
    if (!currentState?.split('|').includes(stateName)) return

    // Livelock bound (W3b.1): cap consecutive restarts of a leaf whose exit keeps
    // failing. Past the cap, leave the operation cancelled and record it so the
    // failure is observable (W5) instead of an unbounded relaunch loop.
    // W4.1 #2: count restarts in THIS OWNER's map so a co-resident owner neither
    // shares nor resets this owner's budget.
    const ownerRestarts = this.restartCountsFor(obj)
    const restarts = (ownerRestarts.get(stateName) ?? 0) + 1
    ownerRestarts.set(stateName, restarts)
    if (restarts > this.MAX_INVOKE_RESTARTS) {
      this.reportRuntimeError(
        new StateMachineError(
          `invoke operation of "${stateName}" left cancelled: exit kept aborting ` +
            `(${this.MAX_INVOKE_RESTARTS} restarts exceeded — possible always-throwing onExit)`,
          { state: stateName },
        ),
        { state: stateName },
        obj as unknown as Adapter<PropertiesOf<TOwner>>,
      )
      return
    }

    // The already-aborted controllers are useless — discard the refs; the launch
    // timers stay tracked in activeTimers (the fired one-shot startOp is inert).
    const ownerInvokes = this.invokesFor(obj)
    const ownerTimers = this.timersFor(obj)
    ownerInvokes.delete(stateName)

    const controllers: AbortController[] = []
    const timers = ownerTimers.get(stateName) ?? []
    for (const invocation of toState.invoke) {
      if (!this.isInvokeOperation(invocation)) continue
      if (invocation.cond) {
        try {
          if (!invocation.cond(obj.adaptee)) continue
        } catch (e) {
          this.logger.error(
            'Error in invoke condition',
            { state: stateName },
            e as Error,
          )
          continue
        }
      }
      const { controller, timerId } = this.launchInvokeOperation(
        obj,
        stateName,
        invocation,
        microstep,
      )
      controllers.push(controller)
      timers.push(timerId)
    }
    if (controllers.length > 0) {
      ownerInvokes.set(stateName, controllers)
      ownerTimers.set(stateName, timers)
    }
  }

  /**
   * W3b.1 LOW (§0.6) — advisory INVOKE_UNKNOWN_EVENT scan. Every event an
   * invoke can raise (the operation form's `onDone`/`onError`, the timer form's
   * `event`) is cross-checked against the declared events map; a reference to
   * an undeclared event is warned once at construction (never handled → a
   * silent no-handler stall otherwise). Advisory only — never throws.
   */
  private warnUnknownInvokeEvents(): void {
    for (const [stateName, state] of this.states) {
      if (!state.invoke || state.invoke.length === 0) continue
      for (const invocation of state.invoke) {
        const referenced = this.isInvokeOperation(invocation)
          ? [invocation.onDone, invocation.onError]
          : [(invocation as InvokeTimer<TOwner>).event]
        for (const eventName of referenced) {
          if (eventName === undefined) continue
          if (!this.events.has(eventName as keyof SMConfig['events'])) {
            this.logger.warn(
              'INVOKE_UNKNOWN_EVENT: invoke references an event not in the events map',
              { state: String(stateName), event: String(eventName) },
            )
          }
        }
      }
    }
  }

  /**
   * W3b (SPEC §6а) — discriminate the {@link StateInvocation} union: the
   * long-running operation arm carries a `src` FUNCTION; the timer arm does not.
   */
  private isInvokeOperation(
    invocation: StateInvocation<TOwner>,
  ): invocation is InvokeOperation<TOwner> {
    return typeof (invocation as InvokeOperation<TOwner>).src === 'function'
  }

  /**
   * П.7 (W3b.1) — a genuine TIMER-form invocation must carry a finite numeric
   * `delay` and an `event` to raise. A restored OPERATION marker whose `src`
   * was not re-linked from the registry has NEITHER — treating it as a timer
   * yields `Math.max(0, undefined - elapsed) = NaN` → an immediate
   * `setTimer` → `raiseEvent(undefined)` phantom event. This guard rejects such
   * non-resumable entries on both the entry ({@link armStateInvoke}) and resume
   * ({@link resumeTimers}) paths.
   */
  private isResumableTimerInvocation(
    invocation: StateInvocation<TOwner>,
  ): boolean {
    const timer = invocation as InvokeTimer<TOwner>
    return (
      typeof timer.delay === 'number' &&
      Number.isFinite(timer.delay) &&
      timer.event !== undefined
    )
  }

  /**
   * W3b (SPEC §6а) — route an `invoke.src` REJECTION. A cancelled (aborted)
   * operation is silent (the leaf was left). Otherwise: with `onError`, raise it
   * as an internal event carrying the error payload; with NO `onError`, surface
   * the failure through `monitor.recordError` — the SAME observable policy as a
   * throwing guard (F7).
   */
  private handleInvokeRejection(
    obj: Adapter<TOwner>,
    op: InvokeOperation<TOwner>,
    controller: AbortController,
    err: unknown,
    stateName: string,
    // W9/Г1 — the ARMING microstep of the operation that rejected, threaded from
    // the launch closure so the `raise.invoke.onError` record carries the same id
    // as the `invoke.operation` records of the very same operation.
    microstep = 0,
  ): void {
    if (controller.signal.aborted) return
    const errObj = err instanceof Error ? err : new Error(String(err))
    if (op.onError) {
      this.raiseEvent(
        op.onError as string,
        obj as any,
        {
          hook: 'raise.invoke.onError',
          state: stateName,
          microstep,
        },
        errObj,
      )
      this.scheduleProcessing()
      return
    }
    this.reportRuntimeError(
      errObj,
      { state: stateName, action: op.id ?? 'invoke', phase: 'action' },
      obj as unknown as Adapter<PropertiesOf<TOwner>>,
    )
  }

  /**
   * Route a TIMER-form ({@link InvokeTimer}) invocation failure onto the same
   * observable channels the OPERATION form already uses
   * ({@link handleInvokeRejection}): `monitor.recordError` and the config-level
   * `onError`, via {@link reportRuntimeError}.
   *
   * WHY this shape:
   *  - A timer-form invoke action can fail in exactly two ways — it THROWS, or
   *    it blows its `transitionTimeout` — and both land in the same `catch`.
   *    They are two failure modes of one action and must not report
   *    differently, so both take this route. Previously BOTH were swallowed
   *    into a bare `logger.error` (and, on the resume path, into nothing at
   *    all): the invoke's `event` was never raised, the machine simply stopped,
   *    and no error handler ever ran — a failure invisible on every channel a
   *    consumer can subscribe to.
   *  - No NEW error surface is introduced. `reportRuntimeError` is the existing
   *    route for exactly this situation (a failure raised from a floating
   *    timer/drain callback with no caller to catch it) and it already carries
   *    the П2 dedup, the `onError` best-effort contract and the silent-hole
   *    floor. `InvokeTimer` deliberately gains no `onError` field — the
   *    operation form is the arm that owns event-shaped error routing.
   *  - It never throws. The timer callback runs detached from any caller, so
   *    rethrowing here would surface as an `unhandledRejection`;
   *    `reportRuntimeError` is documented never to throw.
   *  - Non-cancellation is untouched: a timed-out action keeps running and its
   *    side effects still land (SPEC §11). What changes is only that the
   *    failure is now REPORTED. The invoke's `event` still is not raised — the
   *    action did not succeed, and raising it would fabricate a completion.
   */
  private reportInvokeTimerFailure(
    err: unknown,
    stateName: string,
    event: EventName | undefined,
    obj?: Adapter<TOwner>,
  ): void {
    const errObj = err instanceof Error ? err : new Error(String(err))
    this.reportRuntimeError(
      errObj,
      {
        state: stateName,
        action: event !== undefined ? `invoke:${String(event)}` : 'invoke',
        phase: 'action',
      },
      obj as unknown as Adapter<PropertiesOf<TOwner>>,
    )
  }

  /**
   * П5 (SPEC §6.3) — tear down a state's per-leaf invoke timers and entry time.
   * Called AFTER the point of no return for every state that ACTUALLY left the
   * committed configuration (the microstep's exit set), so an aborted transition
   * never destroys a source state's still-live timers.
   */
  private teardownStateTimers(stateName: string, obj?: Adapter<TOwner>): void {
    // П6: tear down only THIS owner's records for the leaf — another object still
    // in the same state keeps its own live timers/operations.
    const ownerTimers = this.timersFor(obj)
    const timers = ownerTimers.get(stateName)
    if (timers) {
      for (const timerId of timers) this.clearTimer(timerId)
      ownerTimers.delete(stateName)
    }
    // W3b: abort + drop any in-flight invoke operations of this leaf. The abort
    // is idempotent — executeExitActions already aborted it BEFORE onExit; this
    // is the post-commit cleanup (and the safety net for teardown paths that do
    // not run executeExitActions, e.g. the errorState fallback).
    const ownerInvokes = this.invokesFor(obj)
    const controllers = ownerInvokes.get(stateName)
    if (controllers) {
      for (const controller of controllers) controller.abort()
      ownerInvokes.delete(stateName)
    }
    this.entryTimesFor(obj).delete(stateName)
  }

  /**
   * Helper to set timer (native or scheduled)
   */
  private setTimer(callback: () => void, delay: number): any {
    const scheduler = this.scheduler
    // Blocker #2: when a scheduler was EXPLICITLY provided (e.g. a virtual
    // scheduler), ALWAYS route through it — never fall back to real setTimeout.
    // The scheduler computes executeAt against its own injected clock.
    if (this.schedulerProvided) {
      return scheduler.schedule(delay, callback)
    }
    // Default (no scheduler option): preserve the original isActive()-gated
    // behavior — use the lazy real scheduler if running, else native setTimeout.
    if (scheduler.isActive()) {
      return scheduler.schedule(delay, callback)
    }
    return setTimeout(callback, delay)
  }

  /**
   * Helper to clear timer
   */
  private clearTimer(timerId: any): void {
    const scheduler = this.scheduler
    // Blocker #2 symmetry: explicitly-provided scheduler always cancels via it.
    // (cancel() handles unknown tokens gracefully.)
    if (this.schedulerProvided) {
      if (timerId !== undefined) scheduler.cancel(timerId)
      return
    }
    // Default: preserve the original token-heuristic gating.
    // Note: TimerToken is object, setTimeout returns Timeout (Node) or number (Browser).
    // We check if it looks like our token (simple object) or native handle.
    if (
      scheduler.isActive() &&
      typeof timerId === 'object' &&
      timerId !== null &&
      !('ref' in timerId)
    ) {
      scheduler.cancel(timerId)
    } else {
      clearTimeout(timerId)
    }
  }

  /**
   * Manage state history for transitions
   */
  private manageStateHistory(
    fromStateName: string,
    currentState: string,
    obj: Adapter<TOwner>,
  ): void {
    const fromState = this.states.get(fromStateName)
    // П6: record history against THIS owner's map.
    const ownerHistory = this.historyFor(obj)

    // Handle state history
    if (fromState?.history) {
      if (fromState.history === 'deep') {
        ownerHistory.set(fromState.name, currentState)
      } else if (fromState.history === 'shallow' && fromState.regions) {
        ownerHistory.set(fromState.name, this.getCurrentState(obj as any) ?? '')
      }
    }

    // Handle parent state history
    const fromStateParent = this.findParentStateWithHistory(fromStateName)
    if (fromStateParent?.history) {
      ownerHistory.set(fromStateParent.name, currentState)
    }
  }

  private findParentStateWithHistory(
    stateName: string,
  ): State<TOwner> | undefined {
    let current = stateName
    while (current.includes('.')) {
      current = current.split('.').slice(0, -1).join('.')
      const state = this.states.get(current)
      if (state?.history) return state
    }
    return undefined
  }

  private updatePartialState(
    currentState: string,
    parentState: StateName,
    newSubstate: string,
  ): string {
    if (!currentState) return newSubstate

    const currentParts = currentState.split('|')
    const regionKey = parentState.split('.').slice(0, -1).join('.')

    let updatedParts = currentParts
      .map((part) => {
        const partRegionKey = this.getRegionKey(part)
        if (partRegionKey === regionKey) {
          return newSubstate
        }
        if (partRegionKey.startsWith(`${regionKey}.`)) {
          return null
        }
        return part
      })
      .filter((m): m is string => m !== null && m !== undefined)

    if (!updatedParts.some((part) => this.getRegionKey(part) === regionKey)) {
      const regionState = this.states.get(newSubstate)
      if (regionState?.regions) {
        return currentState
      } else {
        updatedParts.push(newSubstate)
      }
    }

    updatedParts = updatedParts.filter((part) => part !== null) as string[]

    // W2a: канонический documentIndex-порядок для восстановленной из истории
    // конфигурации — тот же инвариант, что и на прямом пути персистенции.
    const newCompositeState = this.orderComposite(updatedParts.join('|'))
    this.validateCompositeState(newCompositeState)

    return newCompositeState
  }

  private parseCompositeState(compositeState: string): Map<string, string> {
    const stateMap = new Map<string, string>()
    if (!compositeState) return stateMap

    // Optimized parsing with single split operation
    const stateParts = compositeState.split('|')
    for (let i = 0; i < stateParts.length; i++) {
      const statePart = stateParts[i]
      /* c8 ignore next */ if (statePart === undefined) continue
      const regionKey = this.getRegionKey(statePart)
      stateMap.set(regionKey, statePart)
    }
    return stateMap
  }

  private getRegionKey(statePath: string): string {
    // Optimized with lastIndexOf for better performance
    const lastDotIndex = statePath.lastIndexOf('.')
    return lastDotIndex === -1
      ? statePath
      : statePath.substring(0, lastDotIndex)
  }

  /**
   * W2a: канонизировать серийный `|`-порядок композитного состояния по
   * `documentIndex` модели.
   *
   * Взамен ПОРЯДКА ВСТАВКИ в Map (который зависит от ПУТИ активации — какой
   * регион перезаписан последним) активная конфигурация упорядочивается по
   * ПОЗИЦИИ листа в документе: тот же набор активных листов → тот же серийный
   * порядок, независимо от пути активации/процесса (см. model_determinism
   * часть B). Это НЕ смена правила селекции победителя (W3) — только источник
   * ПОРЯДКА сериализации.
   *
   * Стабильна и тотальна: сортировка стабильная (равные documentIndex сохраняют
   * относительный порядок), а лист, отсутствующий в модели (напр.
   * root/error-псевдосостояние без регионов), получает документ-индекс +∞ и
   * уходит в хвост, сохраняя исходный относительный порядок — так граничные
   * строки не теряются и поведение для не-параллельных состояний неизменно.
   */
  private orderComposite(composite: string): string {
    if (!composite || composite.indexOf('|') === -1) return composite
    const parts = composite.split('|')
    return parts
      .map((part, index) => ({
        part,
        index,
        di: this.model?.documentIndexOf(part) ?? Number.POSITIVE_INFINITY,
      }))
      .sort((a, b) => a.di - b.di || a.index - b.index)
      .map((entry) => entry.part)
      .join('|')
  }

  /**
   * W2a internal API: скомпилированная нормализованная модель конфига.
   * Потребители — валидатор (W2b) и селекция (W3). Не входит в публичную
   * поверхность пакета (см. public_surface.test.ts): доступ только через
   * инстанс, `src/index.ts` модель НЕ реэкспортирует.
   * @internal
   */
  public getCompiledModel(): CompiledModel {
    return this.model
  }

  private resumeTimers() {
    // П6: resume operates on the PRIMARY construction owner (the (de)serialized
    // machine has one adaptee); bind the per-owner maps once.
    const ownerTimers = this.timersFor(this.adaptee)
    const ownerInvokes = this.invokesFor(this.adaptee)
    const ownerEntryTimes = this.entryTimesFor(this.adaptee)

    // Clear any existing active timers first
    for (const timers of ownerTimers.values()) {
      for (const id of timers) {
        this.clearTimer(id)
      }
    }
    ownerTimers.clear()
    // W3b: abort + drop any in-flight invoke operations before re-arming.
    for (const controllers of ownerInvokes.values()) {
      for (const controller of controllers) controller.abort()
    }
    ownerInvokes.clear()

    const currentState = this.getCurrentState()
    if (!currentState) return

    const activeStates = currentState.split('|')
    const activeStatesSet = new Set(activeStates)

    // GC: Remove times for inactive states to prevent memory leaks in stateEntryTimes
    for (const stateName of ownerEntryTimes.keys()) {
      if (!activeStatesSet.has(stateName)) {
        ownerEntryTimes.delete(stateName)
      }
    }

    const now = this.clock()

    for (const stateName of activeStates) {
      const state = this.states.get(stateName)
      if (!state || !state.invoke || state.invoke.length === 0) continue

      const entryTime = ownerEntryTimes.get(stateName)
      // If no entry time recorded, assume just entered (fallback for old data).
      // Use ?? / === undefined (not ||) so a legitimate entry time of 0 — valid
      // under an injected virtual clock that starts at t=0 — is preserved
      // instead of being treated as "missing". With the default Date.now clock
      // an entry time is never 0, so the default path stays byte-identical.
      const startTime = entryTime ?? now
      if (entryTime === undefined) {
        ownerEntryTimes.set(stateName, startTime)
      }

      const elapsed = now - startTime
      const timers: any[] = []

      for (const invocation of state.invoke) {
        // W3b: a long-running `invoke.src` operation cannot be resumed from a
        // serialized snapshot (its promise/AbortSignal do not survive) — skip it
        // here; a fresh entry re-launches it via armStateInvoke.
        if (this.isInvokeOperation(invocation)) continue
        // П.7 (W3b.1) — a restored OPERATION marker (`type:'operation'`, src
        // dropped on serialize) is NOT a timer: it has no numeric `delay` and no
        // `event`. Without this guard it would fall through to `Math.max(0,
        // undefined - elapsed) = NaN` → an immediate `setTimer` → a phantom
        // `raiseEvent(undefined)`. Skip it (honestly, with a warn) — there is no
        // live src to resume, and any registry re-link happens on fresh entry.
        if (!this.isResumableTimerInvocation(invocation)) {
          this.logger.warn(
            'invoke operation not serializable; skipping non-resumable invoke on resume',
            { state: stateName },
          )
          continue
        }
        const remaining = Math.max(0, invocation.delay - elapsed)

        // If time already passed, fire immediately (in next tick)
        const callback = async () => {
          // Verify we are still in this state
          const current = this.getCurrentState(this.adaptee)
          if (current?.split('|').includes(stateName)) {
            try {
              // Check condition (cond) at execution time, not at setup time
              if (invocation.cond && this.adaptee) {
                try {
                  if (!invocation.cond(this.adaptee.adaptee as any)) return
                } catch (_e) {
                  return
                }
              }

              if (invocation.action && this.adaptee) {
                // W8/V1b — microstep 0: a RESUMED timer fires outside any
                // event-driven microstep (see {@link microstepCounter}).
                await this.runTracedInvokeAction(
                  this.adaptee as any,
                  invocation.action,
                  stateName,
                  0,
                  invocation.event !== undefined
                    ? String(invocation.event)
                    : undefined,
                )
              }
              // П3: an invoke-generated event is engine-internal, so it goes on
              // the INTERNAL queue (like the primary invoke path in
              // executeEnterActions) — never through the public external
              // fireEvent, which the reentrancy guard would reject if this
              // resumed timer happened to fire while a drain is in flight.
              if (this.adaptee) {
                this.raiseEvent(invocation.event as string, this.adaptee, {
                  hook: 'raise.invoke.resume',
                  state: stateName,
                  // Reserved id 0: a RESUMED timer fires outside any event-driven
                  // microstep (same convention as the runTracedInvokeAction call
                  // a few lines above).
                  microstep: 0,
                })
                this.scheduleProcessing()
              }
            } catch (err) {
              // Parity with the fresh-entry timer lane above: a RESUMED timer
              // whose action throws or blows its `transitionTimeout` used to be
              // swallowed here without so much as a log line.
              this.logger.error(
                'Invocation error',
                { state: stateName, event: invocation.event },
                err as Error,
              )
              this.reportInvokeTimerFailure(
                err,
                stateName,
                invocation.event,
                this.adaptee as Adapter<TOwner> | undefined,
              )
            }
          }
        }

        const timerId = this.setTimer(callback, remaining)
        timers.push(timerId)
      }
      ownerTimers.set(stateName, timers)
    }
  }

  // Методы сериализации
  public toJSON(): string {
    // Pre-allocate objects for better performance
    const serializedStates: Record<string, any> = {}
    const serializedEvents: Record<string, any> = {}

    // Serialize states with optimized approach
    for (const [name, state] of this.states) {
      serializedStates[name as string] = this.serializeState(state)
    }

    // Serialize events with optimized approach
    for (const [name, event] of this.events) {
      serializedEvents[name as string] = this.serializeEvent(event)
    }

    const config = {
      initialState: this.initialState,
      stateAttribute: this.stateAttribute,
      states: serializedStates,
      events: serializedEvents,
      // Config-level onError has no state-slot identity → name-only reference.
      onError: this.serializeAction(this.onError),
    }

    return JSON.stringify({
      config,
      currentState: this.getCurrentState(),
      historyMap: Array.from(this.historyFor(this.adaptee).entries()),
      stateEntryTimes: Array.from(this.entryTimesFor(this.adaptee).entries()),
    })
  }

  /**
   * Serializes the StateMachine to JSON (Async). Behaviourally the async form
   * of {@link toJSON}: functions are serialized as NAME references only — no
   * body, no hashing, no crypto (W0 defect П1: the keyed-hash scheme was
   * removed). The "secure" name is a historical misnomer kept for API
   * compatibility. Payload integrity/authenticity is the transport's
   * responsibility (TLS / a signed envelope); a forged payload cannot inject
   * code but can still forge configuration.
   */
  public async toSecureJSON(): Promise<string> {
    const serializedStates: Record<string, any> = {}
    const serializedEvents: Record<string, any> = {}

    for (const [name, state] of this.states) {
      serializedStates[name as string] = await this.serializeStateAsync(state)
    }

    for (const [name, event] of this.events) {
      serializedEvents[name as string] = await this.serializeEventAsync(event)
    }

    const config = {
      initialState: this.initialState,
      stateAttribute: this.stateAttribute,
      states: serializedStates,
      events: serializedEvents,
      // Config-level onError has no state-slot identity → name-only reference.
      onError: await this.serializeActionAsync(this.onError),
    }

    return JSON.stringify({
      config,
      currentState: this.getCurrentState(),
      historyMap: Array.from(this.historyFor(this.adaptee).entries()),
      stateEntryTimes: Array.from(this.entryTimesFor(this.adaptee).entries()),
    })
  }

  /**
   * Serialize state with optimized performance (Async). Async form of
   * {@link serializeState} — slot-aware, recursing into `regions`.
   */
  private async serializeStateAsync(state: State<TOwner>): Promise<any> {
    return this.serializeStateNodeAsync(state, state.name as string)
  }

  /** Async form of {@link serializeStateNode}. */
  private async serializeStateNodeAsync(
    node: any,
    slotBase: string,
  ): Promise<any> {
    const { name: _name, ...rest } = node

    const serializedState: any = {
      ...rest,
      onBeforeEnter: await this.serializeActionAsync(
        node.onBeforeEnter,
        `${slotBase}.onBeforeEnter`,
      ),
      onEnter: await this.serializeActionAsync(
        node.onEnter,
        `${slotBase}.onEnter`,
      ),
      onAfterEnter: await this.serializeActionAsync(
        node.onAfterEnter,
        `${slotBase}.onAfterEnter`,
      ),
      onBeforeExit: await this.serializeActionAsync(
        node.onBeforeExit,
        `${slotBase}.onBeforeExit`,
      ),
      onExit: await this.serializeActionAsync(node.onExit, `${slotBase}.onExit`),
      onAfterExit: await this.serializeActionAsync(
        node.onAfterExit,
        `${slotBase}.onAfterExit`,
      ),
      onError: await this.serializeActionAsync(
        node.onError,
        `${slotBase}.onError`,
      ),
    }

    if (node.invoke) {
      serializedState.invoke = node.invoke.map((inv: any) =>
        this.serializeInvokeEntry(inv, slotBase),
      )
    }

    if (node.regions && typeof node.regions === 'object') {
      serializedState.regions = await this.serializeRegionsAsync(
        node.regions,
        slotBase,
      )
    }

    return serializedState
  }

  /** Async form of {@link serializeRegions}. */
  private async serializeRegionsAsync(
    regionsConfig: any,
    parentSlot: string,
  ): Promise<any> {
    const result: any = {}
    for (const [regionName, regionStates] of Object.entries(regionsConfig)) {
      result[regionName] = await this.serializeRegionStatesAsync(
        regionStates,
        `${parentSlot}.${regionName}`,
      )
    }
    return result
  }

  /** Async form of {@link serializeRegionStates}. */
  private async serializeRegionStatesAsync(
    statesConfig: any,
    pathPrefix: string,
  ): Promise<any> {
    const result: any = {}
    for (const [name, stateCfg] of Object.entries(
      statesConfig as Record<string, any>,
    )) {
      if (name === 'initial') {
        result[name] = stateCfg
        continue
      }
      result[name] = await this.serializeStateNodeAsync(
        stateCfg,
        `${pathPrefix}.${name}`,
      )
    }
    return result
  }

  /**
   * П.7 (W3b.1) — serialize ONE `invoke` entry body-free.
   *
   * The long-running OPERATION form ({@link InvokeOperation}) carries a `src`
   * FUNCTION. Spreading `...inv` sent it straight into `JSON.stringify`, which
   * SILENTLY DROPS a function — leaving a bare `{onDone}` that the restore path
   * mistakes for a timer (undefined delay → NaN timer → `raiseEvent(undefined)`
   * phantom events). Instead the operation is serialized as an EXPLICIT
   * body-free MARKER (`type:'operation'`, keeping `id`/`onDone`/`onError`/`cond`
   * and a `slot`/`name` handle for registry re-link) — symmetric to the W0.2
   * action-slot reference. The `src` body is NEVER serialized (W0 invariant П1);
   * {@link deserializeInvokeEntry} re-links it from `options.actions` by
   * slot/id/name when available, else the entry is honestly skipped on resume.
   *
   * The TIMER form is preserved verbatim (minus the resolved `cond`/`action`
   * body-free refs), byte-identical to the previous spread.
   */
  private serializeInvokeEntry(inv: any, slotBase: string): any {
    const cond =
      inv.cond != null
        ? serializeActionRef(inv.cond, `${slotBase}.invoke.cond`)
        : undefined

    if (typeof inv.src === 'function') {
      const marker: any = {
        type: 'operation',
        slot: `${slotBase}.invoke.src`,
        onDone: inv.onDone,
        onError: inv.onError,
        cond,
      }
      if (inv.id !== undefined) marker.id = inv.id
      if (inv.src.name) marker.name = inv.src.name
      return marker
    }

    return {
      ...inv,
      cond,
      action:
        inv.action != null
          ? serializeActionRef(inv.action, `${slotBase}.invoke.action`)
          : undefined,
    }
  }

  /**
   * Serialize state with optimized performance.
   *
   * The flat map key is the state's dotted path (`state.name`), used as the
   * slot base so each hook serializes with a composite `<stateName>.<hook>`
   * identity (W0.2 C1). Nested `regions` are serialized RECURSIVELY through the
   * same slot-aware path — not spread verbatim, which would let JSON.stringify
   * silently drop their callbacks (W0.2 §0.6 completeness).
   */
  private serializeState(state: State<TOwner>): any {
    return this.serializeStateNode(state, state.name as string)
  }

  /**
   * Serialize one state node (a flat top-level state or a nested region leaf)
   * at slot base `slotBase`. The `name` field (only present on flat states) is
   * stripped — reconstruction re-derives it from the map key / region path.
   */
  private serializeStateNode(node: any, slotBase: string): any {
    const { name: _name, ...rest } = node

    const serializedState: any = {
      ...rest,
      onBeforeEnter: this.serializeAction(
        node.onBeforeEnter,
        `${slotBase}.onBeforeEnter`,
      ),
      onEnter: this.serializeAction(node.onEnter, `${slotBase}.onEnter`),
      onAfterEnter: this.serializeAction(
        node.onAfterEnter,
        `${slotBase}.onAfterEnter`,
      ),
      onBeforeExit: this.serializeAction(
        node.onBeforeExit,
        `${slotBase}.onBeforeExit`,
      ),
      onExit: this.serializeAction(node.onExit, `${slotBase}.onExit`),
      onAfterExit: this.serializeAction(
        node.onAfterExit,
        `${slotBase}.onAfterExit`,
      ),
      onError: this.serializeAction(node.onError, `${slotBase}.onError`),
    }

    if (node.invoke) {
      serializedState.invoke = node.invoke.map((inv: any) =>
        this.serializeInvokeEntry(inv, slotBase),
      )
    }

    if (node.regions && typeof node.regions === 'object') {
      serializedState.regions = this.serializeRegions(node.regions, slotBase)
    }

    return serializedState
  }

  /**
   * Serialize a `regions` map: each region is a nested states-config whose
   * states are serialized through {@link serializeStateNode} under the
   * `<parentSlot>.<regionName>.<stateName>` slot path.
   */
  private serializeRegions(regionsConfig: any, parentSlot: string): any {
    const result: any = {}
    for (const [regionName, regionStates] of Object.entries(regionsConfig)) {
      result[regionName] = this.serializeRegionStates(
        regionStates,
        `${parentSlot}.${regionName}`,
      )
    }
    return result
  }

  /** Serialize the states-config of a single region. */
  private serializeRegionStates(statesConfig: any, pathPrefix: string): any {
    const result: any = {}
    for (const [name, stateCfg] of Object.entries(
      statesConfig as Record<string, any>,
    )) {
      // The `initial` marker is a plain string, not a state — keep it verbatim.
      if (name === 'initial') {
        result[name] = stateCfg
        continue
      }
      result[name] = this.serializeStateNode(stateCfg, `${pathPrefix}.${name}`)
    }
    return result
  }

  /**
   * Serialize event with optimized performance (Async)
   */
  private async serializeEventAsync(event: Event<TOwner, any>): Promise<any> {
    const { name: _name, ...eventWithoutName } = event

    // Event/transition hooks have no state-slot identity → name-only references
    // (consumers key the registry by function name, as fromJSON tests do).
    return {
      ...eventWithoutName,
      onBefore: await this.serializeActionAsync(event.onBefore),
      onAfter: await this.serializeActionAsync(event.onAfter),
      onSuccess: await this.serializeActionAsync(event.onSuccess),
      onError: await this.serializeActionAsync(event.onError),
      transitions: await Promise.all(
        event.transitions.map((t) => this.serializeTransitionAsync(t)),
      ),
    }
  }

  /**
   * Serialize transition (Async)
   */
  private async serializeTransitionAsync(
    transition: Transition<TOwner, any>,
  ): Promise<any> {
    return {
      ...transition,
      guard: await this.serializeActionAsync(transition.guard),
      onTransition: await this.serializeActionAsync(transition.onTransition),
      onError: await this.serializeActionAsync(transition.onError),
    }
  }

  /**
   * Serialize event with optimized performance
   */
  private serializeEvent(event: Event<TOwner, any>): any {
    const { name: _name, ...eventWithoutName } = event

    // Event/transition hooks have no state-slot identity → name-only references
    // (consumers key the registry by function name, as fromJSON tests do).
    return {
      ...eventWithoutName,
      onBefore: this.serializeAction(event.onBefore),
      onAfter: this.serializeAction(event.onAfter),
      onSuccess: this.serializeAction(event.onSuccess),
      onError: this.serializeAction(event.onError),
      transitions: event.transitions.map((transition) => ({
        ...transition,
        guard: this.serializeAction(transition.guard),
        onTransition: this.serializeAction(transition.onTransition),
        onError: this.serializeAction(transition.onError),
      })),
    }
  }

  /**
   * Serialize a single action to a body-free reference (Async).
   *
   * `slot` (when supplied) is the composite state-path identity
   * (`<stateName>.<hook>`) emitted for per-slot disambiguation (W0.2 C1);
   * event/transition/config hooks have no state-path identity and pass none.
   */
  private async serializeActionAsync(
    action: any,
    slot?: string,
  ): Promise<SafeSerializedAction | undefined> {
    if (!action) return undefined
    return serializeActionRefAsync(action, slot)
  }

  /**
   * Serialize a single action to a body-free reference.
   *
   * A function is stored by NAME (plus an optional composite `slot` path for
   * per-slot disambiguation — W0.2 C1); a non-function (e.g. a bare string
   * method-name) is returned verbatim.
   */
  private serializeAction(action: any, slot?: string): any {
    if (typeof action === 'function') {
      return serializeActionRef(action, slot)
    }
    return action
  }
}
