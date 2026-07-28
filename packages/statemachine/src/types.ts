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
   * Named-function registry consulted by `fromJSON` / `fromSecureJSON` to
   * restore serialized function references (guards / actions / onError / …).
   *
   * Security invariant (W0 / defect П1): NO deserialization path turns an
   * attacker-controlled STRING into executable code. Serialized machines store
   * a function's NAME only — never its body — and restoration resolves that
   * name against THIS registry. A serialized function reference whose name is
   * not present here throws {@link StateMachineError}; a body is never compiled.
   *
   * Keys are function identities (a function's own `.name`, i.e. what
   * `serializeAction` recorded); values are the actual functions supplied by
   * the consumer.
   */
  actions?: FunctionRegistry
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

// Type for deeply nested state names (parent.region.child.subregion)
export type DeepNestedStateName<S> = {
  [K in keyof S & string]: S[K] extends { regions?: infer R }
  ? R extends Record<string, any>
  ? {
    [RegKey in keyof R & string]: R[RegKey] extends Record<string, any>
    ? {
      [ChildKey in keyof R[RegKey] &
      string]: R[RegKey][ChildKey] extends {
        regions?: infer CR
      }
      ? CR extends Record<string, any>
      ? `${K}.${RegKey}.${ChildKey}.${StringKey & keyof CR}`
      : never
      : never
    }[keyof R[RegKey] & string]
    : never
  }[keyof R & string]
  : never
  : never
}[keyof S & string]

// Composable StatePaths type - union of all possible path types
export type StatePaths<S> =
  | SimpleStateName<S>
  | RegionStateName<S>
  | NestedStateName<S>
  | DeepNestedStateName<S>

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

export interface StateInvocation<T extends object> {
  /** Время задержки в миллисекундах */
  delay: number
  /** Событие, которое будет вызвано после задержки */
  event: EventName
  /** Условие запуска поручения */
  cond?: (adaptee: T) => boolean
  /** Действие, выполняемое перед событием */
  action?: ActionOrString<T>
}

// Использовать для полей from, to в Transition
export type Transition<T extends object, S extends States<T>> = {
  from: StatePaths<S>
  to: StatePaths<S>
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
