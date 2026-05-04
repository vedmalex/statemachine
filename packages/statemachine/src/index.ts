/**
 * @packageDocumentation
 *
 * @vedmalex/statemachine — hierarchical state machine for TypeScript.
 *
 * @unstable — full surface defaults to @unstable per the package's STABILITY policy.
 * Per-symbol @stable tags below mark firm exports for the 1.0.0-beta.x consumer contract.
 *
 * @see README.md for usage and stability policy.
 */

// === Stable public surface (5 firm symbols) ===

/** @stable — primary factory; the canonical consumer entry point. */
export { createMachine } from './lite'

/** @stable — class form for advanced consumers needing direct instance access. */
export { StateMachine } from './state_machine'

// === Stable and unstable type re-exports ===

export type {
  /** @stable — top-level machine configuration interface. */
  StateMachineConfig,
  /** @stable — transition descriptor used in events. */
  Transition,
  /** @stable — state node shape; consumed by States<T> map. */
  State,
  // === @unstable type re-exports (inherit package-level @unstable default) ===
  States,
  Events,
  Event,
  Adapter,
  StateMachineOptions,
  RegionsConfig,
  StateInvocation,
  StateName,
  EventName,
  RegionName,
  EventAction,
  ErrorHandler,
  ActionOrString,
  ErrorHandlerOrString,
  RegionStateName,
  NestedStateName,
  DeepNestedStateName,
  StatePaths,
  SimpleStateName,
  MethodsOf,
  PropertiesOf,
  KeysOf,
  ExtractAdaptee,
  ErrorContext,
} from './types'

// === Public adapter classes (live in types.ts) ===

export {
  MemoryAdapter,
  LocalStorageAdapter,
  SessionStorageAdapter,
  ServerAdapter,
  StateMachineError,
  isAdapter,
} from './types'

// === Curated error types (preserved from TASK-002) ===

export {
  createEnhancedError,
  EnhancedStateMachineError,
  ErrorAnalytics,
  ErrorCategory,
  type ErrorCategory as ErrorCategoryType,
  ErrorHandler as EnhancedErrorHandler,
  type ErrorRecoveryStrategy,
  ErrorSeverity,
  type ErrorSeverity as ErrorSeverityType,
  type ExtendedErrorContext,
  FallbackStateRecoveryStrategy,
  globalErrorHandler,
  isRecoverableError,
  RetryRecoveryStrategy,
} from './error_handling'

// === Public config validator entry points ===

export {
  validateConfig,
  validateConfigStrict,
  isValidConfig,
  type ValidationResult,
  type ValidationError,
  type ValidationWarning,
} from './config_validator'
