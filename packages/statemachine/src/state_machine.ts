import { TimerScheduler } from './scheduler'
import { type SafeSerializedAction, safeFunctionSerializer } from './security'
import {
  type ActionOrString,
  type Adapter,
  type ErrorContext,
  type ErrorHandler,
  type ErrorHandlerOrString,
  type Event,
  type EventAction,
  type Events,
  type ILogger,
  type IMonitor,
  isAdapter,
  type KeysOf,
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

// Removed unused helper functions serializeAction and deserializeAction
// These functions are available through safeFunctionSerializer directly when needed

// ✅ НОВОЕ: Default implementation для Lite режима (No-Op или Console)
const ConsoleLogger: ILogger = {
  debug: () => { }, // По умолчанию выключено для Lite
  info: () => { },
  warn: (msg, ctx) => console.warn(msg, ctx),
  error: (msg, ctx, err) => console.error(msg, ctx, err),
}

const NoOpMonitor: IMonitor = {
  recordTransition: () => { },
  recordError: () => { },
}

export interface StateInfo {
  name: string
  display?: string
  isComposite: boolean
  regions?: string[]
  parent?: string
  children?: string[]
}

export interface QueuedEvent<TOwner extends object = object> {
  id: string
  eventName: string
  obj: Adapter<PropertiesOf<TOwner>>
  args: any[]
  resolve?: (value: boolean) => void
  reject?: (error: any) => void
  timestamp: number
  type: 'internal' | 'external'
}

export interface QueuedEventInfo {
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

  // Свойства
  private states: Map<keyof SMConfig['states'], State<TOwner>>
  private events: Map<
    keyof SMConfig['events'],
    Event<TOwner, SMConfig['states']>
  >
  private stateAttribute: KeysOf<PropertiesOf<TOwner>, string>
  private onError?: ErrorHandlerOrString<TOwner>
  private adaptee?: Adapter<PropertiesOf<TOwner>>
  private context?: MethodsOf<TOwner>
  private historyMap: Map<StateName, string> = new Map()
  private initialState: keyof SMConfig['states']
  private persistenceAdapter?: StatePersistenceAdapter
  private activeTimers: Map<string, any[]> = new Map()
  private stateEntryTimes: Map<string, number> = new Map()

  // Event Queue Infrastructure (SCXML Run-to-Completion)
  private externalQueue: QueuedEvent<TOwner>[] = []
  private internalQueue: QueuedEvent<TOwner>[] = []
  private isProcessing = false
  private eventIdCounter = 0
  private transitionDepth = 0
  private readonly MAX_TRANSITION_DEPTH = 100

  // Optional configuration
  private transitionTimeout?: number
  private errorState?: string
  private abortOnExitError?: boolean
  private maxQueueDepth = 1000

  // Transition state visibility
  private _isTransitioning = false
  private _targetState?: string

  public get isTransitioning() {
    return this._isTransitioning
  }

  public get targetState() {
    return this._targetState
  }

  // Геттеры и сеттеры
  public set currentState(state: StateName) {
    if (!this.adaptee) throw new StateMachineError('no adaptee', { state })
    this.setCurrentState(state, this.adaptee)
  }

  public get currentState() {
    if (!this.adaptee)
      throw new StateMachineError('no adaptee', {
        state: this.getCurrentState(),
      })
    return this.getCurrentState(this.adaptee)
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
    this.logger = options?.logger || ConsoleLogger
    this.monitor = options?.monitor || NoOpMonitor

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
    this.transitionTimeout = options?.transitionTimeout
    this.errorState = options?.errorState
    this.abortOnExitError = options?.abortOnExitError
    if (options?.maxQueueDepth !== undefined) {
      this.maxQueueDepth = options.maxQueueDepth
    }
    this.onError = config.onError
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
    this.processStates(config.states)
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

  private enqueueEvent(
    eventName: string,
    obj: Adapter<PropertiesOf<TOwner>>,
    args: any[],
    type: 'internal' | 'external',
  ): Promise<boolean> {
    if (
      this.externalQueue.length + this.internalQueue.length >=
      this.maxQueueDepth
    ) {
      return Promise.reject(
        new StateMachineError('Event queue overflow — possible infinite loop', {
          state: this.getCurrentState(obj),
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
          timestamp: Date.now(),
          type: 'external',
        })
        this.scheduleProcessing()
      })
    }

    this.internalQueue.push({
      id: `int_${++this.eventIdCounter}`,
      eventName,
      obj,
      args,
      timestamp: Date.now(),
      type: 'internal',
    })
    return Promise.resolve(true)
  }

  private raiseEvent(
    eventName: string,
    obj: Adapter<PropertiesOf<TOwner>>,
    ...args: any[]
  ): void {
    this.internalQueue.push({
      id: `int_${++this.eventIdCounter}`,
      eventName,
      obj,
      args,
      timestamp: Date.now(),
      type: 'internal',
    })
  }

  private scheduleProcessing(): void {
    if (this.isProcessing) return
    queueMicrotask(() => this.processQueues())
  }

  private async processQueues(): Promise<void> {
    if (this.isProcessing) return
    this.isProcessing = true

    try {
      while (this.internalQueue.length > 0 || this.externalQueue.length > 0) {
        if (this.transitionDepth >= this.MAX_TRANSITION_DEPTH) {
          const error = new StateMachineError(
            'Max transition depth exceeded — possible infinite loop',
            { state: this.getCurrentState(), event: 'processQueues' },
          )
          while (this.externalQueue.length > 0) {
            const evt = this.externalQueue.shift()!
            evt.reject?.(error)
          }
          this.internalQueue.length = 0
          throw error
        }

        if (this.internalQueue.length > 0) {
          const evt = this.internalQueue.shift()!
          this.transitionDepth++
          try {
            await this.executeQueuedTransition(evt)
          } finally {
            this.transitionDepth--
          }
        } else {
          const evt = this.externalQueue.shift()!
          this.transitionDepth++
          try {
            const result = await this.executeQueuedTransition(evt)
            evt.resolve?.(result)
          } catch (error) {
            evt.reject?.(error)
          } finally {
            this.transitionDepth--
          }
        }
      }
    } finally {
      this.isProcessing = false
      this.transitionDepth = 0
    }
  }

  private async executeQueuedTransition(
    queuedEvent: QueuedEvent<TOwner>,
  ): Promise<boolean> {
    const { eventName, obj, args } = queuedEvent
    const targetObj = obj

    let currentState = this.getCurrentState(targetObj)
    if (!currentState) {
      this.setInitialState(this.initialState as string, targetObj)
      currentState = this.getCurrentState(targetObj)
    }

    let event = this.events.get(eventName as keyof SMConfig['events'])
    let transitions = event
      ? event.transitions.filter((t) =>
        this.isTransitionPossible(t, currentState),
      )
      : []

    if (!transitions.length) {
      const wildcardEvent = this.events.get('*' as keyof SMConfig['events'])
      if (wildcardEvent) {
        const wildcardTransitions = wildcardEvent.transitions.filter((t) =>
          this.isTransitionPossible(t, currentState),
        )
        if (wildcardTransitions.length > 0) {
          event = wildcardEvent
          transitions = wildcardTransitions
        }
      }
    }

    if (!event || !transitions.length) {
      throw new StateMachineError(
        `Invalid event: ${eventName} for state: ${currentState}`,
        { state: currentState, event: eventName },
      )
    }

    const allowedTransition = await this.getAllowedTransitions(
      targetObj,
      transitions,
      ...args,
    ).catch((error) => {
      this.logger.error(
        'Error determining allowed transition',
        { event: eventName, state: currentState },
        error instanceof Error ? error : new Error(String(error)),
      )
      return undefined
    })

    if (!allowedTransition) {
      return false
    }

    const toState = await this.applyTransition(
      targetObj as any,
      currentState,
      allowedTransition,
      args,
      eventName as keyof SMConfig['events'],
      event,
    ).catch((error) => {
      this.logger.error(
        'Error applying transition',
        {
          event: eventName,
          state: currentState,
          transition: `${allowedTransition.from} -> ${allowedTransition.to}`,
        },
        error instanceof Error ? error : new Error(String(error)),
      )
      throw error // Propagate error to caller (e.g. fireEvent rejection)
    })

    if (!toState) {
      return false
    }

    this.setCurrentState(toState.name, targetObj)
    return true
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
  public async fireEvent(
    eventName: keyof SMConfig['events'] | '*',
    ...args: any[]
  ): Promise<boolean>
  public async fireEvent(
    eventName: keyof SMConfig['events'] | '*',
    obj?: Adapter<PropertiesOf<TOwner>>,
    ...args
  ): Promise<boolean> {
    let targetObj: Adapter<PropertiesOf<TOwner>>
    if (!obj) {
      if (this.adaptee) targetObj = this.adaptee
      else
        throw new StateMachineError('no adaptee or object passed', {
          event: String(eventName),
        })
    } else if (!isAdapter(obj)) {
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
    const now = Date.now()
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
    const targetAdaptee = adaptee || this.adaptee
    if (!targetAdaptee) return false

    const currentState = this.getCurrentState(targetAdaptee)
    const effectiveState =
      currentState === ''
        ? this.getInitialCompositeState(this.initialState as string)
        : currentState
    if (effectiveState === undefined) return false

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
      throw new StateMachineError('no adaptee', {
        state: this.getCurrentState(),
      })
    }

    this.historyMap.clear()

    // Clear all active timers
    for (const timers of this.activeTimers.values()) {
      for (const id of timers) {
        this.clearTimer(id)
      }
    }
    this.activeTimers.clear()
    this.stateEntryTimes.clear()

    this.setInitialState(this.initialState as string, targetAdaptee)
  }

  public getStateHistory(): Record<string, string> {
    return Object.fromEntries(this.historyMap)
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
    if (!state) return undefined

    const parent = currentState.includes('.')
      ? currentState.split('.').slice(0, -1).join('.')
      : undefined

    const children = this.getDirectChildren(currentState)
    const regions = state.regions ? Object.keys(state.regions) : undefined

    return {
      name: currentState,
      display: state.display,
      isComposite: Boolean(state.regions),
      regions,
      parent,
      children: children.length ? children : undefined,
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

    if (currentParts.length !== expectedParts.length) return false

    return currentParts.every((part, index) => part === expectedParts[index])
  }

  public attachToObject(
    object: any,
    eventMap: { [key: string]: string },
  ): void {
    for (const objectEventName in eventMap) {
      if (eventMap.hasOwnProperty(objectEventName)) {
        const stateMachineEventName = eventMap[objectEventName]
        if (typeof object.addEventListener === 'function') {
          object.addEventListener(objectEventName, (...args: any[]) => {
            this.fireEvent(stateMachineEventName, object, ...args).catch((e) =>
              this.logger.error(
                'Error firing event',
                {
                  objectEventName,
                  stateMachineEventName,
                },
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
                  e instanceof Error ? e : new Error(String(e)),
                ),
            )
          }
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

    const currentState = this.getCurrentState()
    const history = Object.fromEntries(this.historyMap)
    const stateData = {
      currentState,
      history,
      stateEntryTimes: Object.fromEntries(this.stateEntryTimes),
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
    this.historyMap = new Map(Object.entries(result.history))
    if (result.stateEntryTimes) {
      this.stateEntryTimes = new Map(Object.entries(result.stateEntryTimes))
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

    const deserializedStates = StateMachine.deserializeStates<TOwner>(
      config.states,
    )
    const deserializedEvents = StateMachine.deserializeEvents<TOwner>(
      config.events,
    )

    const smConfig: StateMachineConfig<TOwner> = {
      name: 'DeserializedStateMachine',
      initialState: config.initialState,
      stateAttribute: config.stateAttribute,
      states: deserializedStates,
      events: deserializedEvents,
      onError: StateMachine.deserializeAction(config.onError) as KeysOf<
        TOwner,
        ErrorHandler<TOwner>
      >,
    }

    const sm = new StateMachine<TOwner, StateMachineConfig<TOwner>>(
      smConfig as SMConfig,
      obj as any,
      options,
    )

    sm.historyMap = new Map(historyMap)
    if (stateEntryTimes) {
      sm.stateEntryTimes = new Map(stateEntryTimes)
    }
    if (sm.adaptee && currentState) {
      sm.setCurrentState(currentState)
      sm.resumeTimers()
    }

    return sm
  }

  /**
   * Securely deserializes a StateMachine from JSON string (Async).
   * Verifies cryptographic hashes of serialized functions.
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

    // Async deserialization of states and events
    const deserializedStates =
      await StateMachine.deserializeStatesAsync<TOwner>(config.states)
    const deserializedEvents =
      await StateMachine.deserializeEventsAsync<TOwner>(config.events)

    const smConfig: StateMachineConfig<TOwner> = {
      name: 'DeserializedStateMachine',
      initialState: config.initialState,
      stateAttribute: config.stateAttribute,
      states: deserializedStates,
      events: deserializedEvents,
      onError: (await StateMachine.deserializeActionAsync(
        config.onError,
      )) as KeysOf<TOwner, ErrorHandler<TOwner>>,
    }

    const sm = new StateMachine<TOwner, StateMachineConfig<TOwner>>(
      smConfig as SMConfig,
      obj as any,
      options,
    )

    sm.historyMap = new Map(historyMap)
    if (stateEntryTimes) {
      sm.stateEntryTimes = new Map(stateEntryTimes)
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
  ): Promise<States<TOwner>> {
    const result: States<TOwner> = {}
    for (const [name, stateData] of Object.entries(statesConfig) as [
      string,
      any,
    ][]) {
      const deserializedState = {
        ...stateData,
        onBeforeEnter: await StateMachine.deserializeActionAsync(
          stateData.onBeforeEnter,
        ),
        onEnter: await StateMachine.deserializeActionAsync(stateData.onEnter),
        onAfterEnter: await StateMachine.deserializeActionAsync(
          stateData.onAfterEnter,
        ),
        onBeforeExit: await StateMachine.deserializeActionAsync(
          stateData.onBeforeExit,
        ),
        onExit: await StateMachine.deserializeActionAsync(stateData.onExit),
        onAfterExit: await StateMachine.deserializeActionAsync(
          stateData.onAfterExit,
        ),
        onError: await StateMachine.deserializeActionAsync(stateData.onError),
      }

      if (stateData.invoke && Array.isArray(stateData.invoke)) {
        deserializedState.invoke = await Promise.all(
          stateData.invoke.map(async (inv: any) => ({
            ...inv,
            cond: await StateMachine.deserializeActionAsync(inv.cond),
            action: await StateMachine.deserializeActionAsync(inv.action),
          })),
        )
      }

      result[name] = deserializedState
    }
    return result
  }

  /**
   * Deserialize states configuration
   */
  private static deserializeStates<TOwner extends object>(
    statesConfig: any,
  ): States<TOwner> {
    return Object.entries(statesConfig).reduce(
      (acc, [name, stateData]: [string, any]) => {
        const deserializedState = {
          ...stateData,
          onBeforeEnter: StateMachine.deserializeAction(
            stateData.onBeforeEnter,
          ),
          onEnter: StateMachine.deserializeAction(stateData.onEnter),
          onAfterEnter: StateMachine.deserializeAction(stateData.onAfterEnter),
          onBeforeExit: StateMachine.deserializeAction(stateData.onBeforeExit),
          onExit: StateMachine.deserializeAction(stateData.onExit),
          onAfterExit: StateMachine.deserializeAction(stateData.onAfterExit),
          onError: StateMachine.deserializeAction(stateData.onError),
        }

        if (stateData.invoke && Array.isArray(stateData.invoke)) {
          deserializedState.invoke = stateData.invoke.map((inv: any) => ({
            ...inv,
            cond: StateMachine.deserializeAction(inv.cond),
            action: StateMachine.deserializeAction(inv.action),
          }))
        }

        acc[name] = deserializedState
        return acc
      },
      {} as States<TOwner>,
    )
  }

  /**
   * Deserialize events configuration (Async)
   */
  private static async deserializeEventsAsync<TOwner extends object>(
    eventsConfig: any,
  ): Promise<Events<TOwner, States<TOwner>>> {
    const result: Events<TOwner, States<TOwner>> = {}
    for (const [name, eventData] of Object.entries(eventsConfig) as [
      string,
      any,
    ][]) {
      result[name] = {
        ...eventData,
        onBefore: await StateMachine.deserializeActionAsync(eventData.onBefore),
        onAfter: await StateMachine.deserializeActionAsync(eventData.onAfter),
        onSuccess: await StateMachine.deserializeActionAsync(
          eventData.onSuccess,
        ),
        onError: await StateMachine.deserializeActionAsync(eventData.onError),
        transitions: await Promise.all(
          eventData.transitions.map((transitionData: any) =>
            StateMachine.deserializeTransitionAsync(transitionData),
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
  ): Events<TOwner, States<TOwner>> {
    return Object.entries(eventsConfig).reduce(
      (acc, [name, eventData]: [string, any]) => {
        acc[name] = {
          ...eventData,
          onBefore: StateMachine.deserializeAction(eventData.onBefore),
          onAfter: StateMachine.deserializeAction(eventData.onAfter),
          onSuccess: StateMachine.deserializeAction(eventData.onSuccess),
          onError: StateMachine.deserializeAction(eventData.onError),
          transitions: eventData.transitions.map((transitionData: any) =>
            StateMachine.deserializeTransition(transitionData),
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
  ): Promise<any> {
    return {
      ...transitionData,
      guard: await StateMachine.deserializeActionAsync(transitionData.guard),
      // Support 'action' alias for 'onTransition'
      onTransition: await StateMachine.deserializeActionAsync(
        transitionData.onTransition || transitionData.action,
      ),
      onError: await StateMachine.deserializeActionAsync(
        transitionData.onError,
      ),
    }
  }

  /**
   * Deserialize transition configuration
   */
  private static deserializeTransition(transitionData: any): any {
    return {
      ...transitionData,
      guard: StateMachine.deserializeAction(transitionData.guard),
      // Support 'action' alias for 'onTransition' for compatibility
      onTransition: StateMachine.deserializeAction(
        transitionData.onTransition || transitionData.action
      ),
      onError: StateMachine.deserializeAction(transitionData.onError),
    }
  }

  /**
   * Static method for deserializing actions (Async)
   */
  private static async deserializeActionAsync(action: any): Promise<any> {
    if (!action) return action

    if (typeof action === 'object' && action.type === 'function') {
      return safeFunctionSerializer.deserializeActionAsync(action)
    }

    return StateMachine.deserializeAction(action)
  }

  /**
   * Static method for deserializing actions (now using safe deserializer)
   */
  private static deserializeAction(action: any): any {
    if (!action) return action

    // 1. Modern secure format with type and hash validation
    if (typeof action === 'object' && action.type === 'function') {
      return safeFunctionSerializer.deserializeAction(action)
    }

    // 2. Legacy string format (function or arrow function)
    if (typeof action === 'string') {
      const trimmed = action.trim()

      // Check if it looks like function code (not just a function name)
      if (
        trimmed.startsWith('function') ||
        trimmed.startsWith('(') ||
        trimmed.includes('=>')
      ) {
        // Use secure deserializer for legacy strings
        const safeFn = safeFunctionSerializer.deserializeLegacyString(action)
        if (safeFn) {
          return safeFn
        }
        // If validation failed, return undefined to prevent execution
        return undefined
      }
    }

    // 3. Action name reference (regular string like 'onEnter')
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
    sm.setContext(context)
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
      const historyState = this.historyMap.get(state)
      if (historyState) {
        const currentState = this.getCurrentState(adaptee)
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
      const historyState = this.historyMap.get(state)
      if (historyState) {
        adaptee.set(
          this.stateAttribute,
          historyState as TOwner[KeysOf<PropertiesOf<TOwner>, string>],
        )
        return
      }
    }

    this.setCurrentStateInternal(state, adaptee)
  }

  private setCurrentStateInternal(
    state: StateName,
    adaptee: Adapter<PropertiesOf<TOwner>>,
  ) {
    const currentState = this.getCurrentState(adaptee) || ''
    const currentStateMap = this.parseCompositeState(currentState)

    const newStateParts = state.split('|')
    const isRootState = newStateParts.length === 1 && !state.includes('.')
    if (isRootState) {
      currentStateMap.clear()
      currentStateMap.set(state, state)
    } else {
      for (const newStatePart of newStateParts) {
        if (!this.states.has(newStatePart)) {
          throw new StateMachineError(
            `Invalid state path: ${newStatePart} in composite state: ${state} states: ${Array.from(this.states.keys()).join(',')}`,
            { state: newStatePart },
          )
        }

        const regionKey = this.getRegionKey(newStatePart)
        const stateConfig = this.states.get(newStatePart)

        for (const [existingRegionKey] of currentStateMap.entries()) {
          if (
            existingRegionKey === regionKey ||
            existingRegionKey.startsWith(regionKey + '.') ||
            regionKey.startsWith(existingRegionKey + '.')
          ) {
            currentStateMap.delete(existingRegionKey)
          }
        }

        if (stateConfig?.regions) {
          const initialStatesForRegions = this.getInitialStatesForRegions(
            stateConfig.regions,
            newStatePart,
          )
          const regionStates = initialStatesForRegions.split('|')
          for (const regionState of regionStates) {
            const regionKeyNested = this.getRegionKey(regionState)
            currentStateMap.set(regionKeyNested, regionState)
          }
        } else {
          currentStateMap.set(regionKey, newStatePart)
        }
      }

      for (const [key, value] of currentStateMap.entries()) {
        if (!value.includes('.')) {
          currentStateMap.delete(key)
        }
      }
    }

    const newCompositeState = Array.from(currentStateMap.values()).join('|')
    this.validateCompositeState(newCompositeState)
    adaptee.set(
      this.stateAttribute,
      newCompositeState as TOwner[KeysOf<PropertiesOf<TOwner>, string>],
    )
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
      initialStates = this.getInitialStatesForRegions(
        stateConfig.regions,
        initialState,
      )
    } else {
      initialStates = initialState
    }

    this.setCurrentState(initialStates, targetAdaptee)

    // Trigger enter actions for initial state(s) to start timers and other logic
    const stateParts = initialStates.split('|')
    const context: ErrorContext = {
      state: initialStates,
      phase: 'enter',
    }

    for (const statePart of stateParts) {
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
  }

  private getInitialCompositeState(initialState: string): string {
    const stateConfig = this.states.get(initialState)
    if (stateConfig?.regions) {
      return this.getInitialStatesForRegions(stateConfig.regions, initialState)
    }
    return initialState
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
  ): string {
    const regionStates: string[] = []
    for (const [regionName, regionStatesConfig] of Object.entries(regions)) {
      const regionPath = `${parentPath}.${regionName}`
      const initialState =
        regionStatesConfig.initial || Object.keys(regionStatesConfig)[0]
      const fullPath = `${regionPath}.${initialState}`

      const stateConfig = this.states.get(fullPath)
      if (stateConfig?.regions) {
        const nestedInitialStates = this.getInitialStatesForRegions(
          stateConfig.regions,
          fullPath,
        )
        regionStates.push(...nestedInitialStates.split('|'))
      } else {
        regionStates.push(fullPath)
      }
    }
    return regionStates.join('|')
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
          )
        } else {
          currentState = context.state || ''
        }
      } catch {
        currentState = context.state || ''
      }

      const errorContext: ErrorContext = {
        ...context,
        state: currentState,
        phase:
          err instanceof StateMachineError
            ? (err.context.phase ?? context.phase)
            : context.phase,
        event:
          err instanceof StateMachineError
            ? (err.context.event ?? context.event)
            : context.event,
        action:
          err instanceof StateMachineError
            ? (err.context.action ?? context.action)
            : context.action,
        transition:
          err instanceof StateMachineError
            ? (err.context.transition ?? context.transition)
            : context.transition,
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
              : (this.context &&
                (this.context[action as string] as ErrorHandler<TOwner>)) ||
              (adaptee.get(action) as ErrorHandler<TOwner>)
            : undefined,
        )
        .filter(Boolean)
        .find((t) => t)
      if (r) handler = r
    }
    return (...args: any[]) => {
      const targetAdaptee = args.length >= 2 ? args[0] : adaptee
      const error = args.length >= 2 ? args[1] : args[0]
      return handler(targetAdaptee, error)
    }
  }

  private async callAction<CallResult>(
    obj: Adapter<TOwner>,
    actionName: ActionOrString<TOwner, CallResult>,
    ...args: any[]
  ): Promise<CallResult | void> {
    const context: ErrorContext = {
      state: this.getCurrentState(
        obj as unknown as Adapter<PropertiesOf<TOwner>>,
      ),
      phase: 'action',
      action: typeof actionName === 'string' ? actionName : 'anonymous',
    }

    const executeAction = async (): Promise<CallResult | void> => {
      try {
        // 1. Check in Context (Dependency Injection)
        if (this.context?.[actionName as string]) {
          const action = this.context[actionName as string] as EventAction<
            TOwner,
            CallResult
          >
          if (typeof action === 'function') {
            const result = action(this.context as any, ...args)
            return result instanceof Promise ? await result : result
          }
        }

        // 2. Check if it's an inline function (Compatibility mode)
        else if (typeof actionName === 'function') {
          const result = actionName(obj, ...args)
          return result instanceof Promise ? await result : result
        }

        // 3. Check in Object/Adaptee (Data Context)
        else if (obj.get(actionName as any)) {
          const action = obj.get(actionName as any)
          if (typeof action === 'function') {
            const result = action(obj, ...args)
            return result instanceof Promise ? await result : result
          }
        }
        throw new StateMachineError('No action found', context)
      } catch (error) {
        if (error instanceof StateMachineError) throw error
        throw new StateMachineError(
          `Error executing action: ${error instanceof Error ? error.message : String(error)}`,
          context,
          error instanceof Error ? error : undefined,
        )
      }
    }

    // Apply timeout if configured
    if (this.transitionTimeout && this.transitionTimeout > 0) {
      return Promise.race([
        executeAction(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new StateMachineError('Transition timeout', {
              action: typeof actionName === 'string' ? actionName : 'anonymous',
              phase: 'action'
            })),
            this.transitionTimeout
          )
        )
      ])
    }

    return executeAction()
  }

  private async getAllowedTransitions(
    obj: Adapter<PropertiesOf<TOwner>>,
    transitions: Array<Transition<TOwner, SMConfig['states']>>,
    ...args
  ) {
    let highestPriority = Number.NEGATIVE_INFINITY
    let selectedTransition: Transition<TOwner, SMConfig['states']> | undefined

    for (const transition of transitions) {
      if ((transition.priority ?? Number.NEGATIVE_INFINITY) < highestPriority) {
        continue
      }

      const context: ErrorContext = {
        state: this.getCurrentState(obj),
        phase: 'guard',
        transition: `${transition.from} -> ${transition.to}`,
      }

      const guardResult = transition.guard
        ? await this.callAction(obj as any, transition.guard, ...args).catch(
          this.processError(
            obj as any,
            context,
            transition.onError,
            this.onError,
          ),
        )
        : true
      if (!guardResult) {
        continue
      }

      highestPriority = transition.priority ?? Number.NEGATIVE_INFINITY
      selectedTransition = transition
    }

    return selectedTransition
  }

  private isTransitionPossible(
    transition: Transition<TOwner, SMConfig['states']>,
    currentState: string,
  ): boolean {
    const currentStates = this.parseCompositeState(currentState)

    // Handle wildcard transition
    if (transition.from === '*') {
      return true
    }

    const fromStates = transition.from.split('|')

    return fromStates.every((fromState) => {
      // Handle wildcard in parallel state part (e.g. "lobby|*")
      if (fromState === '*') return true

      const regionKey = this.getRegionKey(fromState)
      const currentStateForRegion = currentStates.get(regionKey)
      if (!currentStateForRegion) return false

      return (
        currentStateForRegion === fromState ||
        this.isParentState(currentStateForRegion, fromState)
      )
    })
  }

  private isParentState(parentState: string, childState: string): boolean {
    return (
      childState.startsWith(parentState + '.') || childState === parentState
    )
  }

  private async applyTransition(
    obj: Adapter<TOwner>,
    currentState: string,
    transition: Transition<TOwner, SMConfig['states']>,
    args: any[],
    eventName: keyof SMConfig['events'],
    event: Event<TOwner, SMConfig['states']>,
  ): Promise<State<TOwner> | undefined> {
    const context: ErrorContext = {
      state: currentState,
      event: String(eventName),
      transition: `${transition.from} -> ${transition.to}`,
      phase: 'transition',
    }

    const targetState = transition.to === '*' ? currentState : transition.to
    this._isTransitioning = true
    this._targetState = targetState as string

    try {
      // Phase 1: Guard validation
      if (transition.guard) {
        const allow = await this.callAction(obj, transition.guard, ...args).catch(
          this.processError(
            obj,
            { ...context, phase: 'guard' },
            transition.onError,
            this.onError,
          ),
        )
        if (!allow) {
          return undefined
        }
      }

      // Phase 2: Before event action
      if (event.onBefore) {
        await this.callAction(obj, event.onBefore, ...args).catch(
          this.processError(
            obj,
            { ...context },
            transition.onError,
            this.onError,
          ),
        )
      }

      // Phase 3: Exit actions
      try {
        await this.executeExitActions(obj, transition.from, args, context)
      } catch (error) {
        if (this.abortOnExitError) {
          this.logger.warn('Transition aborted due to onExit error', { state: currentState, error })
          return undefined // Stay in source state
        }
        throw error // Propagate error (likely stopping transition but potentially leaving inconsistent state if not handled by caller)
      }

      // Phase 4: History management
      this.manageStateHistory(transition.from, currentState, obj)

      // Phase 5: Transition action
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

      // Phase 6: Enter actions
      try {
        await this.executeEnterActions(obj, transition.to, args, context)
      } catch (error) {
        // ZOMBIE STATE PREVENTION
        if (this.errorState) {
          this.logger.error(`Failed to enter state '${targetState}'. Fallback to error state '${this.errorState}'`, { error })
          const newState = this.updateState(currentState, this.errorState)
          this.setCurrentState(newState, obj as any)
          return this.states.get(this.errorState)
        }
        throw error
      }

      // Phase 7: After event action
      if (event.onAfter) {
        try {
          await this.callAction(obj, event.onAfter, ...args)
        } catch (error) {
          const errorHandler = this.processError(
            obj,
            { ...context },
            event.onError,
            this.onError,
          )
          errorHandler(obj as any, error)
        }
      }

      // Phase 8: State update
      const transitionStartTime = Date.now()
      const newState = this.updateState(currentState, targetState)
      this.setCurrentState(newState, obj as any)

      // Record successful transition
      const transitionTime = Date.now() - transitionStartTime
      this.monitor.recordTransition(transitionTime, true)

      return this.states.get(targetState)
    } finally {
      this._isTransitioning = false
      this._targetState = undefined
    }
  }

  /**
   * Execute exit actions for a state
   */
  private async executeExitActions(
    obj: Adapter<TOwner>,
    fromStateName: string,
    args: any[],
    context: ErrorContext,
  ): Promise<void> {
    const fromState = this.states.get(fromStateName)

    // Clear timers when exiting the state
    if (this.activeTimers.has(fromStateName)) {
      const timers = this.activeTimers.get(fromStateName) || []
      for (const timerId of timers) {
        this.clearTimer(timerId)
      }
      this.activeTimers.delete(fromStateName)
    }

    // Clear entry time
    this.stateEntryTimes.delete(fromStateName)

    if (!fromState) return

    const exitContext = { ...context, phase: 'exit' as const }

    // Execute exit actions in sequence
    const exitActions = [
      fromState.onBeforeExit,
      fromState.onExit,
      fromState.onAfterExit,
    ]

    for (const action of exitActions) {
      if (action) {
        await this.callAction(obj, action, ...args).catch(
          this.processError(obj, exitContext, fromState.onError, this.onError),
        )
      }
    }
  }

  /**
   * Execute enter actions for a state
   */
  private async executeEnterActions(
    obj: Adapter<TOwner>,
    toStateName: string,
    args: any[],
    context: ErrorContext,
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

    for (const action of enterActions) {
      if (action) {
        await this.callAction(obj, action, ...args).catch(
          this.processError(obj, enterContext, toState.onError, this.onError),
        )
      }
    }

    // Handle time-based transitions (invoke)
    if (toState.invoke && toState.invoke.length > 0) {
      // Record entry time if not already recorded (e.g. from resumeTimers)
      if (!this.stateEntryTimes.has(toStateName)) {
        this.stateEntryTimes.set(toStateName, Date.now())
      }

      const timers: any[] = []
      for (const invocation of toState.invoke) {
        // Check condition (cond) before starting the timer
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

        const callback = async () => {
          const currentState = this.getCurrentState(obj as any)
          if (currentState?.split('|').includes(toStateName)) {
            try {
              if (invocation.action) {
                await this.callAction(obj, invocation.action)
              }
              this.raiseEvent(invocation.event as string, obj as any)
              this.scheduleProcessing()
            } catch (err) {
              this.logger.error(
                'Invocation error',
                { state: toStateName, event: invocation.event },
                err as Error,
              )
            }
          }
        }

        const timerId = this.setTimer(callback, invocation.delay)
        timers.push(timerId)
      }
      this.activeTimers.set(toStateName, timers)
    }
  }

  /**
   * Helper to set timer (native or scheduled)
   */
  private setTimer(callback: () => void, delay: number): any {
    // If scheduler is running (lazy mode enabled), use it.
    // Otherwise fallback to native setTimeout for standard behavior.
    const scheduler = TimerScheduler.getInstance()
    if (scheduler.isActive()) {
      return scheduler.schedule(delay, callback)
    }
    return setTimeout(callback, delay)
  }

  /**
   * Helper to clear timer
   */
  private clearTimer(timerId: any): void {
    const scheduler = TimerScheduler.getInstance()
    // We can try to cancel in scheduler even if inactive (it handles untracked tokens gracefully)
    // But to be safe and correct with types:
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

    // Handle state history
    if (fromState?.history) {
      if (fromState.history === 'deep') {
        this.historyMap.set(fromState.name, currentState)
      } else if (fromState.history === 'shallow' && fromState.regions) {
        this.historyMap.set(fromState.name, this.getCurrentState(obj as any))
      }
    }

    // Handle parent state history
    const fromStateParent = this.findParentStateWithHistory(fromStateName)
    if (fromStateParent?.history) {
      this.historyMap.set(fromStateParent.name, currentState)
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
      .filter((m) => m)

    if (!updatedParts.some((part) => this.getRegionKey(part) === regionKey)) {
      const regionState = this.states.get(newSubstate)
      if (regionState?.regions) {
        return currentState
      } else {
        updatedParts.push(newSubstate)
      }
    }

    updatedParts = updatedParts.filter((part) => part !== null) as string[]

    const newCompositeState = updatedParts.join('|')
    this.validateCompositeState(newCompositeState)

    return newCompositeState
  }

  private updateState(currentState: string, toState: string): string {
    const currentStateMap = this.parseCompositeState(currentState)
    const toStateParts = toState.split('|')

    // Handle simple root state transition
    if (toStateParts.length === 1 && !toState.includes('.')) {
      currentStateMap.clear()
      currentStateMap.set(toState, toState)
      return toState
    }

    // Handle complex state transitions with regions
    for (const toStatePart of toStateParts) {
      const regionKey = this.getRegionKey(toStatePart)
      const stateConfig = this.states.get(toStatePart)

      // Remove conflicting states efficiently
      this.removeConflictingStates(currentStateMap, regionKey)

      // Add new state or region states
      if (stateConfig?.regions) {
        this.addRegionStates(currentStateMap, stateConfig, toStatePart)
      } else {
        currentStateMap.set(regionKey, toStatePart)
      }
    }

    // Clean up root states
    this.cleanupRootStates(currentStateMap)

    const newCompositeState = Array.from(currentStateMap.values()).join('|')
    this.validateCompositeState(newCompositeState)
    return newCompositeState
  }

  /**
   * Remove conflicting states from the state map
   */
  private removeConflictingStates(
    currentStateMap: Map<string, string>,
    regionKey: string,
  ): void {
    const keysToDelete: string[] = []

    for (const [key, value] of currentStateMap.entries()) {
      const existingRegionKey = this.getRegionKey(value)
      if (
        existingRegionKey === regionKey ||
        existingRegionKey.startsWith(`${regionKey}.`)
      ) {
        keysToDelete.push(key)
      }
    }

    // Batch delete for better performance
    for (const key of keysToDelete) {
      currentStateMap.delete(key)
    }
  }

  /**
   * Add region states to the state map
   */
  private addRegionStates(
    currentStateMap: Map<string, string>,
    stateConfig: State<TOwner>,
    toStatePart: string,
  ): void {
    const initialStatesForRegions = this.getInitialStatesForRegions(
      stateConfig.regions!,
      toStatePart,
    )
    const regionStates = initialStatesForRegions.split('|')

    for (const regionState of regionStates) {
      const regionKeyNested = this.getRegionKey(regionState)
      currentStateMap.set(regionKeyNested, regionState)
    }
  }

  /**
   * Clean up root states from the state map
   */
  private cleanupRootStates(currentStateMap: Map<string, string>): void {
    const keysToDelete: string[] = []

    for (const [key, value] of currentStateMap.entries()) {
      if (!value.includes('.')) {
        keysToDelete.push(key)
      }
    }

    // Batch delete for better performance
    for (const key of keysToDelete) {
      currentStateMap.delete(key)
    }
  }

  private parseCompositeState(compositeState: string): Map<string, string> {
    const stateMap = new Map<string, string>()
    if (!compositeState) return stateMap

    // Optimized parsing with single split operation
    const stateParts = compositeState.split('|')
    for (let i = 0; i < stateParts.length; i++) {
      const statePart = stateParts[i]
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

  private resumeTimers() {
    // Clear any existing active timers first
    for (const timers of this.activeTimers.values()) {
      for (const id of timers) {
        this.clearTimer(id)
      }
    }
    this.activeTimers.clear()

    const currentState = this.getCurrentState()
    if (!currentState) return

    const activeStates = currentState.split('|')
    const activeStatesSet = new Set(activeStates)

    // GC: Remove times for inactive states to prevent memory leaks in stateEntryTimes
    for (const stateName of this.stateEntryTimes.keys()) {
      if (!activeStatesSet.has(stateName)) {
        this.stateEntryTimes.delete(stateName)
      }
    }

    const now = Date.now()

    for (const stateName of activeStates) {
      const state = this.states.get(stateName)
      if (!state || !state.invoke || state.invoke.length === 0) continue

      const entryTime = this.stateEntryTimes.get(stateName)
      // If no entry time recorded, assume just entered (fallback for old data)
      const startTime = entryTime || now
      if (!entryTime) {
        this.stateEntryTimes.set(stateName, startTime)
      }

      const elapsed = now - startTime
      const timers: any[] = []

      for (const invocation of state.invoke) {
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
                await this.callAction(this.adaptee as any, invocation.action)
              }
              await this.fireEvent(invocation.event as any).catch((err) => {
                this.logger.error(
                  'Resumed timer transition error',
                  { state: stateName, event: invocation.event },
                  err,
                )
              })
            } catch (_err) {
              /* log */
            }
          }
        }

        const timerId = this.setTimer(callback, remaining)
        timers.push(timerId)
      }
      this.activeTimers.set(stateName, timers)
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
      onError: this.serializeAction(this.onError, 'config_onError'),
    }

    return JSON.stringify({
      config,
      currentState: this.getCurrentState(),
      historyMap: Array.from(this.historyMap.entries()),
      stateEntryTimes: Array.from(this.stateEntryTimes.entries()),
    })
  }

  /**
   * Securely serializes the StateMachine to JSON (Async).
   * Generates cryptographic hashes for all functions.
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
      onError: await this.serializeActionAsync(this.onError, 'config_onError'),
    }

    return JSON.stringify({
      config,
      currentState: this.getCurrentState(),
      historyMap: Array.from(this.historyMap.entries()),
      stateEntryTimes: Array.from(this.stateEntryTimes.entries()),
    })
  }

  /**
   * Serialize state with optimized performance (Async)
   */
  private async serializeStateAsync(state: State<TOwner>): Promise<any> {
    const { name: _name, ...stateWithoutName } = state

    const serializedState: any = {
      ...stateWithoutName,
      onBeforeEnter: await this.serializeActionAsync(
        state.onBeforeEnter,
        'onBeforeEnter',
      ),
      onEnter: await this.serializeActionAsync(state.onEnter, 'onEnter'),
      onAfterEnter: await this.serializeActionAsync(
        state.onAfterEnter,
        'onAfterEnter',
      ),
      onBeforeExit: await this.serializeActionAsync(
        state.onBeforeExit,
        'onBeforeExit',
      ),
      onExit: await this.serializeActionAsync(state.onExit, 'onExit'),
      onAfterExit: await this.serializeActionAsync(
        state.onAfterExit,
        'onAfterExit',
      ),
      onError: await this.serializeActionAsync(state.onError, 'state_onError'),
    }

    if (state.invoke) {
      serializedState.invoke = await Promise.all(
        state.invoke.map(async (inv) => ({
          ...inv,
          cond: await safeFunctionSerializer.serializeActionAsync(
            inv.cond,
            'invoke_cond',
          ),
          action: await safeFunctionSerializer.serializeActionAsync(
            inv.action,
            'invoke_action',
          ),
        })),
      )
    }

    return serializedState
  }

  /**
   * Serialize state with optimized performance
   */
  private serializeState(state: State<TOwner>): any {
    const { name: _name, ...stateWithoutName } = state

    const serializedState: any = {
      ...stateWithoutName,
      onBeforeEnter: this.serializeAction(state.onBeforeEnter, 'onBeforeEnter'),
      onEnter: this.serializeAction(state.onEnter, 'onEnter'),
      onAfterEnter: this.serializeAction(state.onAfterEnter, 'onAfterEnter'),
      onBeforeExit: this.serializeAction(state.onBeforeExit, 'onBeforeExit'),
      onExit: this.serializeAction(state.onExit, 'onExit'),
      onAfterExit: this.serializeAction(state.onAfterExit, 'onAfterExit'),
      onError: this.serializeAction(state.onError, 'state_onError'),
    }

    if (state.invoke) {
      serializedState.invoke = state.invoke.map((inv) => ({
        ...inv,
        cond: safeFunctionSerializer.serializeAction(inv.cond, 'invoke_cond'),
        action: safeFunctionSerializer.serializeAction(
          inv.action,
          'invoke_action',
        ),
      }))
    }

    return serializedState
  }

  /**
   * Serialize event with optimized performance (Async)
   */
  private async serializeEventAsync(event: Event<TOwner, any>): Promise<any> {
    const { name: _name, ...eventWithoutName } = event

    return {
      ...eventWithoutName,
      onBefore: await this.serializeActionAsync(
        event.onBefore,
        'event_onBefore',
      ),
      onAfter: await this.serializeActionAsync(event.onAfter, 'event_onAfter'),
      onSuccess: await this.serializeActionAsync(
        event.onSuccess,
        'event_onSuccess',
      ),
      onError: await this.serializeActionAsync(event.onError, 'event_onError'),
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
      guard: await this.serializeActionAsync(
        transition.guard,
        'transition_guard',
      ),
      onTransition: await this.serializeActionAsync(
        transition.onTransition,
        'transition_onTransition',
      ),
      onError: await this.serializeActionAsync(
        transition.onError,
        'transition_onError',
      ),
    }
  }

  /**
   * Serialize event with optimized performance
   */
  private serializeEvent(event: Event<TOwner, any>): any {
    const { name: _name, ...eventWithoutName } = event

    return {
      ...eventWithoutName,
      onBefore: this.serializeAction(event.onBefore, 'event_onBefore'),
      onAfter: this.serializeAction(event.onAfter, 'event_onAfter'),
      onSuccess: this.serializeAction(event.onSuccess, 'event_onSuccess'),
      onError: this.serializeAction(event.onError, 'event_onError'),
      transitions: event.transitions.map((transition) => ({
        ...transition,
        guard: this.serializeAction(transition.guard, 'transition_guard'),
        onTransition: this.serializeAction(
          transition.onTransition,
          'transition_onTransition',
        ),
        onError: this.serializeAction(transition.onError, 'transition_onError'),
      })),
    }
  }

  private async serializeActionAsync(
    action: any,
    name: string,
  ): Promise<SafeSerializedAction | undefined> {
    if (!action) return undefined
    return safeFunctionSerializer.serializeActionAsync(action, name)
  }

  /**
   * Optimized action serialization using safe serializer
   */
  private serializeAction(action: any, functionName?: string): any {
    if (typeof action === 'function') {
      return safeFunctionSerializer.serializeAction(action, functionName)
    }
    return action
  }
}
