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

/**
 * @stable — primary factory; the canonical consumer entry point.
 * @category Stable
 */
export { createMachine } from './lite'

/**
 * @stable — class form for advanced consumers needing direct instance access.
 * @category Stable
 */
export { StateMachine } from './state_machine'

// === Stable type re-exports ===

/**
 * @stable — top-level machine configuration interface.
 * @category Stable
 */
export type { StateMachineConfig } from './types'

/**
 * @stable — transition descriptor used in events.
 * @category Stable
 */
export type { Transition } from './types'

/**
 * @stable — state node shape; consumed by States<T> map.
 * @category Stable
 */
export type { State } from './types'

// === @unstable type re-exports (inherit package-level @unstable default) ===

/**
 * @category Unstable
 */
export type {
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

/**
 * @category Unstable
 * @unstable — validation preset/config shape used by validation helpers and presets.
 */
export type { ValidationConfig } from './config_validator'

/**
 * @category Unstable
 * @unstable — monitoring preset/config shape used by monitoring helpers and presets.
 */
export type { MonitoringConfig } from './monitoring'

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
  isRecoverableError,
  RetryRecoveryStrategy,
} from './error_handling'

// globalErrorHandler removed in TASK-004 (singleton elimination per ISS-007/ISS-008).

// === Public config validator entry points ===

export {
  validateConfig,
  validateConfigStrict,
  isValidConfig,
  type ValidationResult,
  type ValidationError,
  type ValidationWarning,
  type ValidationInfo,
} from './config_validator'

// === Extension-point interfaces (per TASK-006 EP catalog) — @unstable ===

/**
 * @category Unstable
 * @unstable — observability injection contract; implement to collect per-machine metrics.
 */
export type { IMonitor } from './types'

/**
 * @category Unstable
 * @unstable — timer scheduling injection contract; implement for WASM/host portability.
 */
export type { ITimerScheduler } from './types'

/**
 * @category Unstable
 * @unstable — virtual-clock type alias; matches the `clock` option in StateMachineOptions.
 */
export type { Clock } from './scheduler'

/**
 * @category Unstable
 * @unstable — factory for a deterministic, non-real-time scheduler. Pass the
 * returned scheduler together with the same `clock` function in StateMachine
 * options to enable virtual-time (DST) testing without real setTimeout.
 *
 * @example
 * ```ts
 * let t = 0
 * const clock = () => t
 * const scheduler = createVirtualScheduler(clock)
 * const sm = new StateMachine(config, adapter, { clock, scheduler })
 * await Promise.resolve() // flush microtasks: enter initial state + arm invoke timers
 * t = 1000
 * scheduler.process() // advance virtual time to 1000 ms
 * ```
 */
export { createVirtualScheduler } from './scheduler'

/**
 * @category Unstable
 * @unstable — error-handler injection contract; implement to replace built-in recovery.
 */
export type { IErrorHandler } from './types'

/**
 * @category Unstable
 * @unstable — logging injection contract; implement to route logs to host logging stack.
 */
export type { ILogger } from './types'

/**
 * @category Unstable
 * @unstable — persistence adapter contract; implement to save/restore machine state.
 */
export type { StatePersistenceAdapter } from './types'

/**
 * @category Unstable
 * @unstable — transition observability context passed to IMonitor.recordTransition.
 */
export type { TransitionContext } from './types'

/**
 * @category Unstable
 * @unstable — aggregate observability snapshot returned by IMonitor.getMetrics.
 */
export type { MonitorMetricsSnapshot } from './types'
