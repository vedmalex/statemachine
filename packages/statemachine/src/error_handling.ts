/**
 * Enhanced error handling module for StateMachine library
 * Provides comprehensive error context, recovery strategies, and error analytics
 */

import { stateMachineLogger } from './logger'
import { type ErrorContext, StateMachineError } from './types'

// Extended error context with more detailed information
export interface ExtendedErrorContext extends ErrorContext {
  timestamp: number
  machineId?: string
  currentStateHistory?: string[]
  attemptedTransition?: {
    from: string
    to: string
    event: string
  }
  stackTrace?: string
  userAgent?: string
  sessionId?: string
  additionalData?: Record<string, any>
}

// Error severity levels
export const ErrorSeverity = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
} as const

export type ErrorSeverity = (typeof ErrorSeverity)[keyof typeof ErrorSeverity]

// Error categories for better classification
export const ErrorCategory = {
  VALIDATION: 'validation',
  TRANSITION: 'transition',
  ACTION: 'action',
  SERIALIZATION: 'serialization',
  CONFIGURATION: 'configuration',
  SECURITY: 'security',
  PERFORMANCE: 'performance',
  NETWORK: 'network',
  UNKNOWN: 'unknown',
} as const

export type ErrorCategory = (typeof ErrorCategory)[keyof typeof ErrorCategory]

// Enhanced error class with additional metadata
export class EnhancedStateMachineError extends StateMachineError {
  readonly severity: ErrorSeverity
  readonly category: ErrorCategory
  readonly extendedContext: ExtendedErrorContext
  readonly recoverable: boolean
  readonly errorCode: string

  constructor(
    message: string,
    context: ErrorContext,
    options: {
      severity?: ErrorSeverity
      category?: ErrorCategory
      recoverable?: boolean
      errorCode?: string
      additionalData?: Record<string, any>
      cause?: Error
    } = {},
  ) {
    super(message, context, options.cause)

    this.severity = options.severity || ErrorSeverity.MEDIUM
    this.category = options.category || ErrorCategory.UNKNOWN
    this.recoverable = options.recoverable ?? true
    this.errorCode = options.errorCode || this.generateErrorCode()

    this.extendedContext = {
      ...context,
      timestamp: Date.now(),
      stackTrace: this.stack,
      additionalData: options.additionalData,
    }
  }

  private generateErrorCode(): string {
    const categoryCode = this.category.toUpperCase().substring(0, 3)
    const severityCode = this.severity.toUpperCase().substring(0, 1)
    const timestamp = Date.now().toString().slice(-6)
    return `SM_${categoryCode}_${severityCode}_${timestamp}`
  }

  toJSON(): Record<string, any> {
    return {
      name: this.name,
      message: this.message,
      errorCode: this.errorCode,
      severity: this.severity,
      category: this.category,
      recoverable: this.recoverable,
      context: this.extendedContext,
      stack: this.stack,
    }
  }
}

// Error recovery strategies
export interface ErrorRecoveryStrategy {
  name: string
  canRecover(error: EnhancedStateMachineError): boolean
  recover(error: EnhancedStateMachineError, context: any): Promise<boolean>
}

// Default recovery strategies
export class RetryRecoveryStrategy implements ErrorRecoveryStrategy {
  name = 'retry'
  private maxRetries: number
  private retryDelay: number

  constructor(maxRetries = 3, retryDelay = 1000) {
    this.maxRetries = maxRetries
    this.retryDelay = retryDelay
  }

  canRecover(error: EnhancedStateMachineError): boolean {
    return (
      error.recoverable &&
      error.category !== ErrorCategory.SECURITY &&
      error.severity !== ErrorSeverity.CRITICAL
    )
  }

  async recover(
    error: EnhancedStateMachineError,
    context: any,
  ): Promise<boolean> {
    const retryCount = context.retryCount || 0

    if (retryCount >= this.maxRetries) {
      stateMachineLogger.warn('Max retries exceeded', {
        errorCode: error.errorCode,
        retryCount,
        maxRetries: this.maxRetries,
      })
      return false
    }

    stateMachineLogger.info('Attempting error recovery', {
      errorCode: error.errorCode,
      strategy: this.name,
      attempt: retryCount + 1,
    })

    // Wait before retry
    await new Promise((resolve) => setTimeout(resolve, this.retryDelay))

    context.retryCount = retryCount + 1
    return true
  }
}

export class FallbackStateRecoveryStrategy implements ErrorRecoveryStrategy {
  name = 'fallback_state'
  private fallbackState: string

  constructor(fallbackState = 'error_state') {
    this.fallbackState = fallbackState
  }

  canRecover(error: EnhancedStateMachineError): boolean {
    return (
      error.category === ErrorCategory.TRANSITION ||
      error.category === ErrorCategory.ACTION
    )
  }

  async recover(
    error: EnhancedStateMachineError,
    context: any,
  ): Promise<boolean> {
    try {
      if (
        context.stateMachine &&
        typeof context.stateMachine.setCurrentState === 'function'
      ) {
        stateMachineLogger.info('Recovering to fallback state', {
          errorCode: error.errorCode,
          fallbackState: this.fallbackState,
          originalState: error.context.state,
        })

        context.stateMachine.setCurrentState(this.fallbackState)
        return true
      }
    } catch (recoveryError) {
      stateMachineLogger.error(
        'Fallback recovery failed',
        {
          errorCode: error.errorCode,
          fallbackState: this.fallbackState,
        },
        recoveryError instanceof Error
          ? recoveryError
          : new Error(String(recoveryError)),
      )
    }

    return false
  }
}

// Error analytics and reporting
export class ErrorAnalytics {
  private errors: EnhancedStateMachineError[] = []
  private maxStoredErrors: number

  constructor(maxStoredErrors = 1000) {
    this.maxStoredErrors = maxStoredErrors
  }

  recordError(error: EnhancedStateMachineError): void {
    this.errors.push(error)

    // Keep only recent errors
    if (this.errors.length > this.maxStoredErrors) {
      this.errors = this.errors.slice(-this.maxStoredErrors)
    }

    // Log error for immediate attention
    stateMachineLogger.error(
      'StateMachine error recorded',
      {
        errorCode: error.errorCode,
        severity: error.severity,
        category: error.category,
        recoverable: error.recoverable,
      },
      error,
    )
  }

  getErrorStats(): {
    total: number
    bySeverity: Record<ErrorSeverity, number>
    byCategory: Record<ErrorCategory, number>
    recentErrors: number
    errorRate: number
  } {
    const now = Date.now()
    const oneHourAgo = now - 60 * 60 * 1000

    const recentErrors = this.errors.filter(
      (e) => e.extendedContext.timestamp > oneHourAgo,
    )

    const bySeverity = Object.values(ErrorSeverity).reduce(
      (acc, severity) => {
        acc[severity] = this.errors.filter(
          (e) => e.severity === severity,
        ).length
        return acc
      },
      {} as Record<ErrorSeverity, number>,
    )

    const byCategory = Object.values(ErrorCategory).reduce(
      (acc, category) => {
        acc[category] = this.errors.filter(
          (e) => e.category === category,
        ).length
        return acc
      },
      {} as Record<ErrorCategory, number>,
    )

    return {
      total: this.errors.length,
      bySeverity,
      byCategory,
      recentErrors: recentErrors.length,
      errorRate: recentErrors.length / 60, // errors per minute
    }
  }

  getTopErrors(limit = 10): Array<{
    errorCode: string
    message: string
    count: number
    lastOccurrence: number
    severity: ErrorSeverity
    category: ErrorCategory
  }> {
    const errorGroups = new Map<
      string,
      {
        errorCode: string
        message: string
        count: number
        lastOccurrence: number
        severity: ErrorSeverity
        category: ErrorCategory
      }
    >()

    this.errors.forEach((error) => {
      const key = `${error.message}_${error.category}`
      const existing = errorGroups.get(key)

      if (existing) {
        existing.count++
        existing.lastOccurrence = Math.max(
          existing.lastOccurrence,
          error.extendedContext.timestamp,
        )
      } else {
        errorGroups.set(key, {
          errorCode: error.errorCode,
          message: error.message,
          count: 1,
          lastOccurrence: error.extendedContext.timestamp,
          severity: error.severity,
          category: error.category,
        })
      }
    })

    return Array.from(errorGroups.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
  }

  clearErrors(): void {
    this.errors = []
  }
}

// Main error handler class
export class ErrorHandler {
  private recoveryStrategies: ErrorRecoveryStrategy[] = []
  private analytics: ErrorAnalytics
  private enabled = true

  constructor() {
    this.analytics = new ErrorAnalytics()

    // Add default recovery strategies
    this.addRecoveryStrategy(new RetryRecoveryStrategy())
    this.addRecoveryStrategy(new FallbackStateRecoveryStrategy())
  }

  addRecoveryStrategy(strategy: ErrorRecoveryStrategy): void {
    this.recoveryStrategies.push(strategy)
  }

  removeRecoveryStrategy(strategyName: string): void {
    this.recoveryStrategies = this.recoveryStrategies.filter(
      (s) => s.name !== strategyName,
    )
  }

  async handleError(
    error: Error | EnhancedStateMachineError,
    context: any = {},
  ): Promise<boolean> {
    if (!this.enabled) {
      return false
    }

    // Convert to enhanced error if needed
    const enhancedError =
      error instanceof EnhancedStateMachineError
        ? error
        : this.convertToEnhancedError(error, context)

    // Record error for analytics
    this.analytics.recordError(enhancedError)

    // Attempt recovery
    for (const strategy of this.recoveryStrategies) {
      if (strategy.canRecover(enhancedError)) {
        try {
          const recovered = await strategy.recover(enhancedError, context)
          if (recovered) {
            stateMachineLogger.info('Error recovery successful', {
              errorCode: enhancedError.errorCode,
              strategy: strategy.name,
            })
            return true
          }
        } catch (recoveryError) {
          stateMachineLogger.error(
            'Recovery strategy failed',
            {
              errorCode: enhancedError.errorCode,
              strategy: strategy.name,
            },
            recoveryError instanceof Error
              ? recoveryError
              : new Error(String(recoveryError)),
          )
        }
      }
    }

    stateMachineLogger.error('All recovery strategies failed', {
      errorCode: enhancedError.errorCode,
      severity: enhancedError.severity,
      category: enhancedError.category,
    })

    return false
  }

  private convertToEnhancedError(
    error: Error,
    context: any,
  ): EnhancedStateMachineError {
    // Determine category based on error message and context
    let category: ErrorCategory = ErrorCategory.UNKNOWN
    let severity: ErrorSeverity = ErrorSeverity.MEDIUM

    if (
      error.message.includes('transition') ||
      error.message.includes('state')
    ) {
      category = ErrorCategory.TRANSITION
    } else if (error.message.includes('action')) {
      category = ErrorCategory.ACTION
    } else if (error.message.includes('validation')) {
      category = ErrorCategory.VALIDATION
      severity = ErrorSeverity.HIGH
    } else if (
      error.message.includes('security') ||
      error.message.includes('injection')
    ) {
      category = ErrorCategory.SECURITY
      severity = ErrorSeverity.CRITICAL
    }

    return new EnhancedStateMachineError(
      error.message,
      context.errorContext || {},
      {
        category,
        severity,
        cause: error,
        additionalData: context,
      },
    )
  }

  getAnalytics(): ErrorAnalytics {
    return this.analytics
  }

  enable(): void {
    this.enabled = true
  }

  disable(): void {
    this.enabled = false
  }

  isEnabled(): boolean {
    return this.enabled
  }
}

// Global error handler instance
export const globalErrorHandler = new ErrorHandler()

// Utility functions
export function createEnhancedError(
  message: string,
  context: ErrorContext,
  options?: {
    severity?: ErrorSeverity
    category?: ErrorCategory
    recoverable?: boolean
    additionalData?: Record<string, any>
  },
): EnhancedStateMachineError {
  return new EnhancedStateMachineError(message, context, options)
}

export function isRecoverableError(error: Error): boolean {
  if (error instanceof EnhancedStateMachineError) {
    return error.recoverable
  }
  return true // Assume recoverable by default
}
