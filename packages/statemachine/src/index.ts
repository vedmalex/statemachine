// src/index.ts (canonical public surface for @vedmalex/statemachine)
// All public exports flow through this file. lite.ts is internal-only and exposes the factory only.

export { createMachine } from './lite'

export * from './adapters'
export * from './config_validator'
export * from './logger'
export * from './monitoring'
export * from './presets'
export * from './security'
export * from './state_machine'
export * from './types'

// error_handling: curated named exports (preserved verbatim from legacy index.ts).
// Star export here would clash with state_machine's transitive StateMachineError
// only if state_machine re-exported it; verified at Step 7.7 below.
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
