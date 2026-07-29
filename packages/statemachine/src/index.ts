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
 * @stable — discriminated result of `fireEventDetailed` (SPEC §7).
 * @category Stable
 */
export type { FireResult } from './types'

/**
 * @stable — what `StateMachine.detachOwner` released for one owner (B3).
 * @category Stable
 */
export type { OwnerDetachResult } from './types'

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
  InvokeTimer,
  InvokeOperation,
  ExitContext,
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
  // W8: the payload type of the optional `IMonitor.recordLifecycle` observability
  // channel — a consumer implementing that method must be able to name it.
  LifecycleEvent,
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

// === П13/EO-8 — observability RUNTIME surface ===
// Previously only the TYPE (IMonitor / MonitoringConfig) reached consumers; the
// monitor CLASS and its default factory were unreachable, so metrics could only
// be scraped via `(sm as any).monitor`. Exported ONLY AFTER EO-3 fixed the lying
// errorRate/health/successCount — the public surface must not carry the lie.

/**
 * @category Unstable
 * @unstable — comprehensive monitor implementation (metrics + health). Read the
 * machine's live instance via `StateMachine#getMonitor()`, or construct one to
 * inject through `StateMachineOptions.monitor`.
 */
export { StateMachineMonitor, createDefaultMonitor, HealthStatus } from './monitoring'

// === W8/V2 — lifecycle TRACER (consumer-side debugging instrument) ===
// The raw `IMonitor.recordLifecycle` channel is a time-free, un-aggregated
// stream. The tracer is the consumer-side half: it pairs begin/end edges,
// stamps subscriber time, and renders the callback timeline — so "why was my
// onExit never called?" / "which callback is hung?" is a `format()` call rather
// than a hundred lines of bespoke bookkeeping.

/**
 * @category Unstable
 * @unstable — lifecycle tracer factory. Pass the result straight to
 * `StateMachineOptions.monitor`, or decorate an existing monitor with
 * `tracer.wrap(myMonitor)`.
 *
 * @see docs/lifecycle-tracing.md
 *
 * @example
 * ```ts
 * const tracer = createLifecycleTracer()
 * const sm = new StateMachine(config, owner, { monitor: tracer })
 * await sm.fireEvent('go')
 * console.log(tracer.format())
 * ```
 */
export { createLifecycleTracer } from './lifecycle-tracer'

/**
 * @category Unstable
 * @unstable — lifecycle tracer surface and its payload / option shapes.
 */
export type {
  LifecycleTracer,
  LifecycleRecord,
  LifecycleTracerOptions,
  LifecycleTracerStats,
  LifecycleFormatOptions,
  GuardCoverage,
} from './lifecycle-tracer'

// === П13/EO-8 — logger RUNTIME surface ===

/**
 * @category Unstable
 * @unstable — the machine's default logger and the level control. Import
 * `setDefaultLogLevel` to raise/lower verbosity of the built-in logging.
 */
export {
  stateMachineLogger,
  setDefaultLogLevel,
  getLogger,
  Logger,
  LogLevel,
} from './logger'

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
 * @unstable — async-context tracking injection contract, backing PRECISE
 * reentrancy detection. Implement (and pass via
 * `StateMachineOptions.contextTracker`) to restore precise detection on a
 * runtime that has an equivalent primitive but exposes it under neither
 * `AsyncLocalStorage` nor `AsyncContext.Variable`.
 *
 * @see StateMachine#contextTrackerKind
 */
export type { IContextTracker } from './types'

/**
 * @category Unstable
 * @unstable — the primitive backing a machine's reentrancy detection, as
 * reported by `StateMachine#contextTrackerKind`.
 */
export type { ContextTrackerKind } from './context_tracker'

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
