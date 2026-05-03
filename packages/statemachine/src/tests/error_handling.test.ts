/**
 * Tests for enhanced error handling module
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import {
  EnhancedStateMachineError,
  ErrorAnalytics,
  ErrorCategory,
  ErrorHandler,
  ErrorSeverity,
  FallbackStateRecoveryStrategy,
  RetryRecoveryStrategy,
  createEnhancedError,
  globalErrorHandler,
  isRecoverableError,
} from '../error_handling'
import { StateMachine } from '../state_machine'
import {
  type Events,
  MemoryAdapter,
  StateMachineError,
  type StateMachineConfig,
  type States,
} from '../types'

describe('Enhanced Error Handling', () => {
  describe('EnhancedStateMachineError', () => {
    it('should create enhanced error with default values', () => {
      const error = new EnhancedStateMachineError('Test error', {
        state: 'test',
      })

      expect(error.message).toBe('Test error')
      expect(error.severity).toBe(ErrorSeverity.MEDIUM)
      expect(error.category).toBe(ErrorCategory.UNKNOWN)
      expect(error.recoverable).toBe(true)
      expect(error.errorCode).toMatch(/^SM_UNK_M_\d+$/)
      expect(error.extendedContext.state).toBe('test')
      expect(error.extendedContext.timestamp).toBeGreaterThan(0)
    })

    it('should create enhanced error with custom options', () => {
      const error = new EnhancedStateMachineError(
        'Validation error',
        { state: 'test' },
        {
          severity: ErrorSeverity.HIGH,
          category: ErrorCategory.VALIDATION,
          recoverable: false,
          errorCode: 'CUSTOM_001',
          additionalData: { field: 'name' },
        },
      )

      expect(error.severity).toBe(ErrorSeverity.HIGH)
      expect(error.category).toBe(ErrorCategory.VALIDATION)
      expect(error.recoverable).toBe(false)
      expect(error.errorCode).toBe('CUSTOM_001')
      expect(error.extendedContext.additionalData?.field).toBe('name')
    })

    it('should serialize to JSON correctly', () => {
      const error = new EnhancedStateMachineError('Test error', {
        state: 'test',
      })
      const json = error.toJSON()

      expect(json.name).toBe('StateMachineError')
      expect(json.message).toBe('Test error')
      expect(json.severity).toBe(ErrorSeverity.MEDIUM)
      expect(json.category).toBe(ErrorCategory.UNKNOWN)
      expect(json.recoverable).toBe(true)
      expect(json.context.state).toBe('test')
    })
  })

  describe('RetryRecoveryStrategy', () => {
    it('should determine if error is recoverable', () => {
      const strategy = new RetryRecoveryStrategy()

      const recoverableError = new EnhancedStateMachineError(
        'Network error',
        {},
        {
          category: ErrorCategory.NETWORK,
          severity: ErrorSeverity.MEDIUM,
        },
      )

      const nonRecoverableError = new EnhancedStateMachineError(
        'Security error',
        {},
        {
          category: ErrorCategory.SECURITY,
          severity: ErrorSeverity.CRITICAL,
        },
      )

      expect(strategy.canRecover(recoverableError)).toBe(true)
      expect(strategy.canRecover(nonRecoverableError)).toBe(false)
    })

    it('should attempt recovery with retry logic', async () => {
      const strategy = new RetryRecoveryStrategy(2, 10) // 2 retries, 10ms delay
      const error = new EnhancedStateMachineError(
        'Temporary error',
        {},
        {
          category: ErrorCategory.NETWORK,
        },
      )

      const context: any = {}

      // First attempt should succeed
      const result1 = await strategy.recover(error, context)
      expect(result1).toBe(true)
      expect(context.retryCount).toBe(1)

      // Second attempt should succeed
      const result2 = await strategy.recover(error, context)
      expect(result2).toBe(true)
      expect(context.retryCount).toBe(2)

      // Third attempt should fail (max retries exceeded)
      const result3 = await strategy.recover(error, context)
      expect(result3).toBe(false)
    })
  })

  describe('FallbackStateRecoveryStrategy', () => {
    it('should determine if error is recoverable', () => {
      const strategy = new FallbackStateRecoveryStrategy()

      const transitionError = new EnhancedStateMachineError(
        'Transition failed',
        {},
        {
          category: ErrorCategory.TRANSITION,
        },
      )

      const actionError = new EnhancedStateMachineError(
        'Action failed',
        {},
        {
          category: ErrorCategory.ACTION,
        },
      )

      const securityError = new EnhancedStateMachineError(
        'Security error',
        {},
        {
          category: ErrorCategory.SECURITY,
        },
      )

      expect(strategy.canRecover(transitionError)).toBe(true)
      expect(strategy.canRecover(actionError)).toBe(true)
      expect(strategy.canRecover(securityError)).toBe(false)
    })

    it('should attempt fallback state recovery', async () => {
      const strategy = new FallbackStateRecoveryStrategy('safe_state')
      const error = new EnhancedStateMachineError(
        'Transition failed',
        {},
        {
          category: ErrorCategory.TRANSITION,
        },
      )

      let currentState = 'error_state'
      const mockStateMachine = {
        setCurrentState: (state: string) => {
          currentState = state
        },
      }

      const context = { stateMachine: mockStateMachine }
      const result = await strategy.recover(error, context)

      expect(result).toBe(true)
      expect(currentState).toBe('safe_state')
    })
  })

  describe('ErrorAnalytics', () => {
    let analytics: ErrorAnalytics

    beforeEach(() => {
      analytics = new ErrorAnalytics(100) // Small limit for testing
    })

    it('should record and track errors', () => {
      const error1 = new EnhancedStateMachineError(
        'Error 1',
        {},
        {
          severity: ErrorSeverity.HIGH,
          category: ErrorCategory.VALIDATION,
        },
      )

      const error2 = new EnhancedStateMachineError(
        'Error 2',
        {},
        {
          severity: ErrorSeverity.LOW,
          category: ErrorCategory.ACTION,
        },
      )

      analytics.recordError(error1)
      analytics.recordError(error2)

      const stats = analytics.getErrorStats()
      expect(stats.total).toBe(2)
      expect(stats.bySeverity[ErrorSeverity.HIGH]).toBe(1)
      expect(stats.bySeverity[ErrorSeverity.LOW]).toBe(1)
      expect(stats.byCategory[ErrorCategory.VALIDATION]).toBe(1)
      expect(stats.byCategory[ErrorCategory.ACTION]).toBe(1)
    })

    it('should get top errors by frequency', () => {
      const error1 = new EnhancedStateMachineError(
        'Common error',
        {},
        {
          category: ErrorCategory.VALIDATION,
        },
      )

      const error2 = new EnhancedStateMachineError(
        'Rare error',
        {},
        {
          category: ErrorCategory.ACTION,
        },
      )

      // Record common error multiple times
      analytics.recordError(error1)
      analytics.recordError(error1)
      analytics.recordError(error1)
      analytics.recordError(error2)

      const topErrors = analytics.getTopErrors(2)
      expect(topErrors).toHaveLength(2)
      expect(topErrors[0].count).toBe(3)
      expect(topErrors[0].message).toBe('Common error')
      expect(topErrors[1].count).toBe(1)
      expect(topErrors[1].message).toBe('Rare error')
    })

    it('should clear errors', () => {
      const error = new EnhancedStateMachineError('Test error', {})
      analytics.recordError(error)

      expect(analytics.getErrorStats().total).toBe(1)

      analytics.clearErrors()
      expect(analytics.getErrorStats().total).toBe(0)
    })
  })

  describe('ErrorHandler', () => {
    let errorHandler: ErrorHandler

    beforeEach(() => {
      errorHandler = new ErrorHandler()
    })

    it('should handle enhanced errors', async () => {
      const error = new EnhancedStateMachineError(
        'Test error',
        {},
        {
          category: ErrorCategory.NETWORK,
          recoverable: true,
        },
      )

      const context: any = {}
      const result = await errorHandler.handleError(error, context)

      // Should succeed with retry strategy
      expect(result).toBe(true)
      expect(context.retryCount).toBe(1)
    })

    it('should convert regular errors to enhanced errors', async () => {
      const error = new Error('validation failed')
      const context = { errorContext: { state: 'test' } }

      const result = await errorHandler.handleError(error, context)

      // Should be converted and handled
      expect(result).toBe(true)
    })

    it('should try multiple recovery strategies', async () => {
      const error = new EnhancedStateMachineError(
        'Transition error',
        {},
        {
          category: ErrorCategory.TRANSITION,
          recoverable: false, // Make it non-recoverable for retry strategy
        },
      )

      let fallbackCalled = false
      const mockStateMachine = {
        setCurrentState: () => {
          fallbackCalled = true
        },
      }

      const context = { stateMachine: mockStateMachine }
      const result = await errorHandler.handleError(error, context)

      expect(result).toBe(true)
      // Should skip retry (non-recoverable) and use fallback
      expect(fallbackCalled).toBe(true)
    })

    it('should be able to enable/disable error handling', async () => {
      const error = new Error('Test error')

      errorHandler.disable()
      expect(errorHandler.isEnabled()).toBe(false)

      const result1 = await errorHandler.handleError(error)
      expect(result1).toBe(false)

      errorHandler.enable()
      expect(errorHandler.isEnabled()).toBe(true)

      const result2 = await errorHandler.handleError(error)
      expect(result2).toBe(true)
    })
  })

  describe('Utility functions', () => {
    it('should create enhanced error', () => {
      const error = createEnhancedError(
        'Test error',
        { state: 'test' },
        {
          severity: ErrorSeverity.HIGH,
          category: ErrorCategory.VALIDATION,
        },
      )

      expect(error).toBeInstanceOf(EnhancedStateMachineError)
      expect(error.severity).toBe(ErrorSeverity.HIGH)
      expect(error.category).toBe(ErrorCategory.VALIDATION)
    })

    it('should check if error is recoverable', () => {
      const recoverableError = new EnhancedStateMachineError(
        'Test',
        {},
        { recoverable: true },
      )
      const nonRecoverableError = new EnhancedStateMachineError(
        'Test',
        {},
        { recoverable: false },
      )
      const regularError = new Error('Regular error')

      expect(isRecoverableError(recoverableError)).toBe(true)
      expect(isRecoverableError(nonRecoverableError)).toBe(false)
      expect(isRecoverableError(regularError)).toBe(true) // Default to recoverable
    })
  })

  describe('Global error handler', () => {
    it('should be available as singleton', () => {
      expect(globalErrorHandler).toBeInstanceOf(ErrorHandler)
      expect(globalErrorHandler.isEnabled()).toBe(true)
    })
  })
})

describe('StateMachine error handling', () => {
  it('should return false when transition action throws', async () => {
    const action = () => {
      throw new Error('Test error')
    }

    const states = {
      state1: {},
      state2: {},
    } satisfies States<any>

    const events = {
      event1: {
        transitions: [{ from: 'state1', to: 'state2', onTransition: action }],
      },
    } satisfies Events<any, typeof states>

    const config = {
      name: 'ErrorHandlingSM',
      initialState: 'state1',
      stateAttribute: 'state',
      states,
      events,
    } satisfies StateMachineConfig<any>

    const adaptee = new MemoryAdapter({ state: 'state1' })
    const sm = new StateMachine(config, adaptee)

    await expect(sm.fireEvent('event1')).rejects.toThrow('Test error')
    expect(sm.currentState).toBe('state1')
  })
})
