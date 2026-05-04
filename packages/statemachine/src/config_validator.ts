/**
 * Configuration validation module for StateMachine library
 * Validates StateMachine configurations to prevent runtime errors
 */

// Removed unused imports from error_handling
import { stateMachineLogger } from './logger'
import type { Event, Events, State, StateMachineConfig, States } from './types'

// Validation result types
export interface ValidationResult {
  isValid: boolean
  errors: ValidationError[]
  warnings: ValidationWarning[]
}

export interface ValidationError {
  code: string
  message: string
  severity: 'error' | 'warning'
  path: string
  details?: Record<string, any>
  // ✅ НОВЫЕ ПОЛЯ
  suggestion?: string // Текстовая подсказка "Как исправить"
  documentationUrl?: string // Ссылка на раздел документации
}

export interface ValidationWarning extends ValidationError {
  severity: 'warning'
}

// ✅ НОВЫЕ ИНТЕРФЕЙСЫ ДЛЯ КАСТОМНЫХ ПРАВИЛ
export interface ValidationContext {
  addError(
    code: string,
    message: string,
    path: string,
    suggestion?: string,
  ): void
  addWarning(
    code: string,
    message: string,
    path: string,
    suggestion?: string,
  ): void
}

export type CustomRule<T extends object = any> = {
  id: string
  validate: (config: StateMachineConfig<T>, context: ValidationContext) => void
}

// Validation rules configuration
export interface ValidationConfig {
  strictMode: boolean
  allowEmptyStates: boolean
  allowEmptyEvents: boolean
  maxStateDepth: number
  maxStatesCount: number
  maxEventsCount: number
  requireInitialState: boolean
  validateTransitionPaths: boolean
  validateActionReferences: boolean
  customRules?: CustomRule[] // ✅ Добавлено
}

export const DEFAULT_VALIDATION_CONFIG: ValidationConfig = {
  strictMode: false,
  allowEmptyStates: false,
  allowEmptyEvents: false,
  maxStateDepth: 10,
  maxStatesCount: 1000,
  maxEventsCount: 1000,
  requireInitialState: true,
  validateTransitionPaths: true,
  validateActionReferences: false, // Disabled by default as actions might be dynamic
}

// Configuration validator class
export class ConfigValidator {
  private config: ValidationConfig
  private errors: ValidationError[] = []
  private warnings: ValidationWarning[] = []

  constructor(config: Partial<ValidationConfig> = {}) {
    this.config = { ...DEFAULT_VALIDATION_CONFIG, ...config }
  }

  /**
   * Validates a complete StateMachine configuration
   */
  validate<T extends object>(
    smConfig: StateMachineConfig<T>,
  ): ValidationResult {
    this.errors = []
    this.warnings = []

    try {
      // Basic structure validation
      this.validateBasicStructure(smConfig)

      // States validation
      this.validateStates(smConfig.states, 'states')

      // Events validation
      this.validateEvents(smConfig.events, smConfig.states, 'events')

      // Initial state validation
      this.validateInitialState(smConfig)

      // Cross-references validation
      this.validateCrossReferences(smConfig)

      // Performance validation
      this.validatePerformanceConstraints(smConfig)

      // ✅ Запуск кастомных правил
      this.runCustomRules(smConfig)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.addError(
        'VALIDATION_FAILED',
        `Validation process failed: ${msg}`,
        'validation',
      )
    }

    const result: ValidationResult = {
      isValid: this.errors.length === 0,
      errors: this.errors,
      warnings: this.warnings,
    }

    // Log validation results
    if (!result.isValid) {
      stateMachineLogger.error('StateMachine configuration validation failed', {
        errorCount: this.errors.length,
        warningCount: this.warnings.length,
        configName: smConfig.name,
      })
    } else if (this.warnings.length > 0) {
      stateMachineLogger.warn('StateMachine configuration has warnings', {
        warningCount: this.warnings.length,
        configName: smConfig.name,
      })
    }

    return result
  }

  /**
   * Runs custom validation rules
   */
  private runCustomRules<T extends object>(
    smConfig: StateMachineConfig<T>,
  ): void {
    if (!this.config.customRules || this.config.customRules.length === 0) return

    const context: ValidationContext = {
      addError: (code, msg, path, sugg) =>
        this.addError(code, msg, path, undefined, sugg),
      addWarning: (code, msg, path, sugg) =>
        this.addWarning(code, msg, path, undefined, sugg),
    }

    for (const rule of this.config.customRules) {
      try {
        rule.validate(smConfig, context)
      } catch (e) {
        this.addError(
          'CUSTOM_RULE_ERROR',
          `Rule ${rule.id} failed: ${e instanceof Error ? e.message : String(e)}`,
          'root',
        )
      }
    }
  }

  private validateBasicStructure<T extends object>(
    smConfig: StateMachineConfig<T>,
  ): void {
    // Required fields
    if (!smConfig.name || typeof smConfig.name !== 'string') {
      this.addError(
        'MISSING_NAME',
        'StateMachine must have a valid name',
        'name',
      )
    }

    if (
      !smConfig.stateAttribute ||
      typeof smConfig.stateAttribute !== 'string'
    ) {
      this.addError(
        'MISSING_STATE_ATTRIBUTE',
        'StateMachine must have a valid stateAttribute',
        'stateAttribute',
      )
    }

    if (!smConfig.states || typeof smConfig.states !== 'object') {
      this.addError(
        'MISSING_STATES',
        'StateMachine must have states configuration',
        'states',
      )
      return
    }

    if (!smConfig.events || typeof smConfig.events !== 'object') {
      this.addError(
        'MISSING_EVENTS',
        'StateMachine must have events configuration',
        'events',
      )
      return
    }

    // Empty collections check
    if (
      !this.config.allowEmptyStates &&
      Object.keys(smConfig.states).length === 0
    ) {
      this.addError(
        'EMPTY_STATES',
        'StateMachine cannot have empty states collection',
        'states',
      )
    }

    if (
      !this.config.allowEmptyEvents &&
      Object.keys(smConfig.events).length === 0
    ) {
      this.addError(
        'EMPTY_EVENTS',
        'StateMachine cannot have empty events collection',
        'events',
      )
    }
  }

  private validateStates<T extends object>(
    states: States<T>,
    basePath: string,
    depth = 0,
  ): void {
    if (depth > this.config.maxStateDepth) {
      this.addError(
        'MAX_DEPTH_EXCEEDED',
        `State nesting depth exceeds maximum of ${this.config.maxStateDepth}`,
        basePath,
      )
      return
    }

    for (const [stateName, stateConfig] of Object.entries(states)) {
      const statePath = `${basePath}.${stateName}`
      this.validateState(stateConfig, statePath, depth)
    }
  }

  private validateState<T extends object>(
    state: Omit<State<T>, 'name'>,
    path: string,
    depth: number,
  ): void {
    // State name validation
    if (!path.split('.').pop()) {
      this.addError('INVALID_STATE_NAME', 'State name cannot be empty', path)
    }

    // Display name validation
    if (state.display && typeof state.display !== 'string') {
      this.addWarning(
        'INVALID_DISPLAY',
        'State display should be a string',
        `${path}.display`,
      )
    }

    // Regions validation
    if (state.regions) {
      if (typeof state.regions !== 'object') {
        this.addError(
          'INVALID_REGIONS',
          'State regions must be an object',
          `${path}.regions`,
        )
      } else {
        for (const [regionName, regionStates] of Object.entries(
          state.regions,
        )) {
          if (!regionName) {
            this.addError(
              'EMPTY_REGION_NAME',
              'Region name cannot be empty',
              `${path}.regions`,
            )
            continue
          }

          this.validateStates(
            regionStates,
            `${path}.regions.${regionName}`,
            depth + 1,
          )
        }
      }
    }

    // History validation
    if (state.history && !['deep', 'shallow'].includes(state.history)) {
      this.addError(
        'INVALID_HISTORY',
        'State history must be "deep" or "shallow"',
        `${path}.history`,
      )
    }

    // Initial state validation for regions
    if (state.regions && state.initial) {
      const hasInitialState = Object.values(state.regions).some(
        (regionStates) => Object.keys(regionStates).includes(state.initial!),
      )
      if (!hasInitialState) {
        this.addError(
          'INVALID_INITIAL_STATE',
          `Initial state "${state.initial}" not found in any region`,
          `${path}.initial`,
        )
      }
    }

    // Invoke (StateInvocation) validation
    if (state.invoke) {
      if (!Array.isArray(state.invoke)) {
        this.addError(
          'INVALID_INVOKE',
          'State "invoke" must be an array of StateInvocation',
          `${path}.invoke`,
        )
      } else {
        state.invoke.forEach((inv, index) => {
          const invPath = `${path}.invoke[${index}]`
          if (typeof inv.delay !== 'number' || inv.delay < 0) {
            this.addError(
              'INVALID_DELAY',
              'Delay must be a positive number',
              `${invPath}.delay`,
            )
          }
          if (!inv.event || typeof inv.event !== 'string') {
            this.addError(
              'INVALID_EVENT_NAME',
              'Event name must be a string',
              `${invPath}.event`,
            )
          }
          if (inv.cond && typeof inv.cond !== 'function') {
            this.addError(
              'INVALID_COND',
              'Condition must be a function',
              `${invPath}.cond`,
            )
          }
        })
      }
    }
  }

  private validateEvents<T extends object>(
    events: Events<T, States<T>>,
    states: States<T>,
    basePath: string,
  ): void {
    for (const [eventName, eventConfig] of Object.entries(events)) {
      const eventPath = `${basePath}.${eventName}`
      this.validateEvent(eventConfig, eventPath, states)
    }
  }

  private validateEvent<T extends object>(
    event: Omit<Event<T, States<T>>, 'name'>,
    path: string,
    states: States<T>,
  ): void {
    // Transitions validation
    if (!event.transitions || !Array.isArray(event.transitions)) {
      this.addError(
        'MISSING_TRANSITIONS',
        'Event must have transitions array',
        `${path}.transitions`,
      )
      return
    }

    if (event.transitions.length === 0) {
      this.addWarning(
        'EMPTY_TRANSITIONS',
        'Event has no transitions',
        `${path}.transitions`,
      )
    }

    // Validate each transition
    event.transitions.forEach((transition, index) => {
      this.validateTransition(
        transition,
        `${path}.transitions[${index}]`,
        states,
      )
    })

    // Priority validation
    const priorities = event.transitions
      .map((t) => t.priority)
      .filter((p) => p !== undefined) as number[]

    if (
      priorities.length > 0 &&
      priorities.length !== event.transitions.length
    ) {
      this.addWarning(
        'MIXED_PRIORITIES',
        'Some transitions have priority while others do not',
        `${path}.transitions`,
      )
    }
  }

  private validateTransition<T extends object>(
    transition: any,
    path: string,
    states: States<T>,
  ): void {
    // From state validation
    if (!transition.from || typeof transition.from !== 'string') {
      this.addError(
        'INVALID_FROM_STATE',
        'Transition must have a valid from state',
        `${path}.from`,
      )
    } else if (this.config.validateTransitionPaths) {
      this.validateStatePath(transition.from, states, `${path}.from`)
    }

    // To state validation
    if (!transition.to || typeof transition.to !== 'string') {
      this.addError(
        'INVALID_TO_STATE',
        'Transition must have a valid to state',
        `${path}.to`,
      )
    } else if (this.config.validateTransitionPaths) {
      this.validateStatePath(transition.to, states, `${path}.to`)
    }

    // Priority validation
    if (
      transition.priority !== undefined &&
      typeof transition.priority !== 'number'
    ) {
      this.addError(
        'INVALID_PRIORITY',
        'Transition priority must be a number',
        `${path}.priority`,
      )
    }

    // Self-transition warning
    if (transition.from === transition.to) {
      this.addWarning(
        'SELF_TRANSITION',
        'Transition from and to states are the same',
        path,
      )
    }
  }

  private validateStatePath<T extends object>(
    statePath: string,
    states: States<T>,
    path: string,
  ): void {
    // Handle composite states (separated by |)
    const stateParts = statePath.split('|')

    for (const part of stateParts) {
      if (!this.isValidStatePath(part, states)) {
        this.addError(
          'INVALID_STATE_PATH',
          `State path "${part}" does not exist`,
          path,
        )
      }
    }
  }

  private isValidStatePath<T extends object>(
    statePath: string,
    states: States<T>,
  ): boolean {
    const parts = statePath.split('.')
    let currentStates = states

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (part === undefined) return false

      if (i === 0) {
        // Root state
        if (!currentStates[part]) {
          return false
        }
        const state = currentStates[part]
        if (parts.length === 1) {
          return true // Simple state path
        }
        if (!state.regions) {
          return false // No regions but path continues
        }
        // Continue with regions
      } else if (i === 1) {
        // Region name
        const rootStatePart = parts[0]
        if (rootStatePart === undefined) return false
        const rootState = currentStates[rootStatePart]
        if (!rootState || !rootState.regions || !rootState.regions[part]) {
          return false
        }
        currentStates = rootState.regions[part]
      } else {
        // Nested state in region
        if (!currentStates[part]) {
          return false
        }
        const state = currentStates[part]
        if (i === parts.length - 1) {
          return true // Last part
        }
        if (!state.regions) {
          return false
        }
        // Continue deeper...
      }
    }

    return true
  }

  private validateInitialState<T extends object>(
    smConfig: StateMachineConfig<T>,
  ): void {
    if (this.config.requireInitialState) {
      if (!smConfig.initialState) {
        this.addError(
          'MISSING_INITIAL_STATE',
          'StateMachine must have an initial state',
          'initialState',
        )
        return
      }

      if (!smConfig.states[smConfig.initialState as string]) {
        this.addError(
          'INVALID_INITIAL_STATE',
          `Initial state "${smConfig.initialState}" does not exist`,
          'initialState',
          undefined,
          `Check the 'states' object. Ensure that '${smConfig.initialState}' is defined as a root state.`,
        )
      }
    }
  }

  private validateCrossReferences<T extends object>(
    smConfig: StateMachineConfig<T>,
  ): void {
    // Collect all state names (including nested)
    const allStateNames = new Set<string>()
    this.collectStateNames(smConfig.states, '', allStateNames)

    // Event names are available through Object.keys(smConfig.events)

    // Check for unreachable states
    const reachableStates = new Set<string>()
    if (smConfig.initialState) {
      reachableStates.add(smConfig.initialState as string)
    }

    // Add states reachable through transitions
    for (const event of Object.values(smConfig.events)) {
      for (const transition of event.transitions) {
        if (transition.to) {
          const toParts = transition.to.split('|')
          toParts.forEach((part) => reachableStates.add(part))
        }
      }
    }

    // Report unreachable states
    for (const stateName of allStateNames) {
      if (!reachableStates.has(stateName)) {
        this.addWarning(
          'UNREACHABLE_STATE',
          `State "${stateName}" is not reachable`,
          `states.${stateName}`,
        )
      }
    }

    // Check for unused events (events with no valid transitions)
    for (const [eventName, event] of Object.entries(smConfig.events)) {
      const hasValidTransitions = event.transitions.some(
        (t) => allStateNames.has(t.from) && allStateNames.has(t.to),
      )
      if (!hasValidTransitions) {
        this.addWarning(
          'UNUSED_EVENT',
          `Event "${eventName}" has no valid transitions`,
          `events.${eventName}`,
        )
      }
    }
  }

  private collectStateNames<T extends object>(
    states: States<T>,
    prefix: string,
    collector: Set<string>,
  ): void {
    for (const [stateName, state] of Object.entries(states)) {
      const fullName = prefix ? `${prefix}.${stateName}` : stateName
      collector.add(fullName)

      if (state.regions) {
        for (const [regionName, regionStates] of Object.entries(
          state.regions,
        )) {
          this.collectStateNames(
            regionStates,
            `${fullName}.${regionName}`,
            collector,
          )
        }
      }
    }
  }

  private validatePerformanceConstraints<T extends object>(
    smConfig: StateMachineConfig<T>,
  ): void {
    const stateCount = this.countStates(smConfig.states)
    const eventCount = Object.keys(smConfig.events).length

    if (stateCount > this.config.maxStatesCount) {
      this.addWarning(
        'TOO_MANY_STATES',
        `State count (${stateCount}) exceeds recommended maximum (${this.config.maxStatesCount})`,
        'states',
      )
    }

    if (eventCount > this.config.maxEventsCount) {
      this.addWarning(
        'TOO_MANY_EVENTS',
        `Event count (${eventCount}) exceeds recommended maximum (${this.config.maxEventsCount})`,
        'events',
      )
    }

    // Check for complex transition patterns
    let totalTransitions = 0
    for (const event of Object.values(smConfig.events)) {
      totalTransitions += event.transitions.length
    }

    if (totalTransitions > stateCount * 3) {
      this.addWarning(
        'COMPLEX_TRANSITIONS',
        'High transition-to-state ratio may impact performance',
        'events',
      )
    }
  }

  private countStates<T extends object>(states: States<T>): number {
    let count = Object.keys(states).length

    for (const state of Object.values(states)) {
      if (state.regions) {
        for (const regionStates of Object.values(state.regions)) {
          count += this.countStates(regionStates)
        }
      }
    }

    return count
  }

  private addError(
    code: string,
    message: string,
    path: string,
    details?: Record<string, any>,
    suggestion?: string,
  ): void {
    this.errors.push({
      code,
      message,
      severity: 'error',
      path,
      ...(details !== undefined ? { details } : {}),
      ...(suggestion !== undefined ? { suggestion } : {}),
    })
  }

  private addWarning(
    code: string,
    message: string,
    path: string,
    details?: Record<string, any>,
    suggestion?: string,
  ): void {
    this.warnings.push({
      code,
      message,
      severity: 'warning',
      path,
      ...(details !== undefined ? { details } : {}),
      ...(suggestion !== undefined ? { suggestion } : {}),
    })
  }
}

// Utility functions
export function validateConfig<T extends object>(
  config: StateMachineConfig<T>,
  validationConfig?: Partial<ValidationConfig>,
): ValidationResult {
  const validator = new ConfigValidator(validationConfig)
  return validator.validate(config)
}

export function validateConfigStrict<T extends object>(
  config: StateMachineConfig<T>,
): ValidationResult {
  return validateConfig(config, { strictMode: true })
}

export function isValidConfig<T extends object>(
  config: StateMachineConfig<T>,
): boolean {
  return validateConfig(config).isValid
}
