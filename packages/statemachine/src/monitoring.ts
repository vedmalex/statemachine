// Monitoring and metrics module for StateMachine
// Provides essential monitoring for state machine transitions and errors

import { stateMachineLogger } from './logger'

/**
 * Performance metrics interface
 */
export interface PerformanceMetrics {
  transitionTime: number
  stateChangeCount: number
  errorCount: number
  timestamp: number
}

/**
 * Health check status
 */
export const HealthStatus = {
  HEALTHY: 'healthy',
  WARNING: 'warning',
  CRITICAL: 'critical',
  UNKNOWN: 'unknown',
} as const

export type HealthStatus = (typeof HealthStatus)[keyof typeof HealthStatus]

/**
 * Health check result
 */
export interface HealthCheckResult {
  status: HealthStatus
  message: string
  timestamp: number
  metrics?: Record<string, any>
}

/**
 * Monitoring configuration
 */
export interface MonitoringConfig {
  enabled: boolean
  metricsInterval: number // milliseconds
  healthCheckInterval: number // milliseconds
  maxMetricsHistory: number
  thresholds: {
    transitionTimeWarning: number // milliseconds
    transitionTimeCritical: number // milliseconds
    errorRateWarning: number // percentage
    errorRateCritical: number // percentage
  }
}

/**
 * Default monitoring configuration
 */
export const DEFAULT_MONITORING_CONFIG: MonitoringConfig = {
  enabled: true,
  metricsInterval: 5000, // 5 seconds
  healthCheckInterval: 30000, // 30 seconds
  maxMetricsHistory: 1000,
  thresholds: {
    transitionTimeWarning: 100, // 100ms
    transitionTimeCritical: 500, // 500ms
    errorRateWarning: 5, // 5%
    errorRateCritical: 15, // 15%
  },
}

/**
 * Metrics collector for StateMachine performance monitoring
 */
export class MetricsCollector {
  private metrics: PerformanceMetrics[] = []
  private config: MonitoringConfig
  private startTime: number = Date.now()
  private transitionCount = 0
  private errorCount = 0

  constructor(config: Partial<MonitoringConfig> = {}) {
    this.config = { ...DEFAULT_MONITORING_CONFIG, ...config }
  }

  /**
   * Record a state transition
   */
  recordTransition(transitionTime: number): void {
    if (!this.config.enabled) return

    this.transitionCount++

    const metrics: PerformanceMetrics = {
      transitionTime,
      stateChangeCount: this.transitionCount,
      errorCount: this.errorCount,
      timestamp: Date.now(),
    }

    this.addMetrics(metrics)
    this.logMetrics(metrics)
  }

  /**
   * Record an error
   */
  recordError(): void {
    if (!this.config.enabled) return
    this.errorCount++
  }

  /**
   * Get current metrics summary
   */
  getMetricsSummary(): {
    totalTransitions: number
    totalErrors: number
    averageTransitionTime: number
    errorRate: number
    uptime: number
  } {
    const now = Date.now()
    const uptime = now - this.startTime
    const recentMetrics = this.getRecentMetrics(60000) // Last minute

    const averageTransitionTime =
      recentMetrics.length > 0
        ? recentMetrics.reduce((sum, m) => sum + m.transitionTime, 0) /
        recentMetrics.length
        : 0

    const errorRate =
      this.transitionCount > 0
        ? (this.errorCount / this.transitionCount) * 100
        : 0

    return {
      totalTransitions: this.transitionCount,
      totalErrors: this.errorCount,
      averageTransitionTime,
      errorRate,
      uptime,
    }
  }

  /**
   * Get metrics history
   */
  getMetricsHistory(timeRange?: number): PerformanceMetrics[] {
    if (timeRange) {
      return this.getRecentMetrics(timeRange)
    }
    return [...this.metrics]
  }

  /**
   * Clear metrics history
   */
  clearMetrics(): void {
    this.metrics = []
    this.transitionCount = 0
    this.errorCount = 0
    this.startTime = Date.now()
  }

  /**
   * Get recent metrics within time range
   */
  private getRecentMetrics(timeRange: number): PerformanceMetrics[] {
    const cutoff = Date.now() - timeRange
    return this.metrics.filter((m) => m.timestamp >= cutoff)
  }

  /**
   * Add metrics to history with size limit
   */
  private addMetrics(metrics: PerformanceMetrics): void {
    this.metrics.push(metrics)

    // Maintain size limit
    if (this.metrics.length > this.config.maxMetricsHistory) {
      this.metrics = this.metrics.slice(-this.config.maxMetricsHistory)
    }
  }

  /**
   * Log metrics if significant
   */
  private logMetrics(metrics: PerformanceMetrics): void {
    const { thresholds } = this.config

    if (metrics.transitionTime > thresholds.transitionTimeCritical) {
      stateMachineLogger.error('Critical transition time detected', {
        transitionTime: metrics.transitionTime,
        threshold: thresholds.transitionTimeCritical,
      })
    } else if (metrics.transitionTime > thresholds.transitionTimeWarning) {
      stateMachineLogger.warn('Slow transition detected', {
        transitionTime: metrics.transitionTime,
        threshold: thresholds.transitionTimeWarning,
      })
    }
  }
}

/**
 * Performance monitor for real-time tracking
 */
export class PerformanceMonitor {
  private metricsCollector: MetricsCollector
  private config: MonitoringConfig
  private intervalId: NodeJS.Timeout | undefined
  private isRunning = false

  constructor(
    metricsCollector: MetricsCollector,
    config: Partial<MonitoringConfig> = {},
  ) {
    this.metricsCollector = metricsCollector
    this.config = { ...DEFAULT_MONITORING_CONFIG, ...config }
  }

  /**
   * Start performance monitoring
   */
  start(): void {
    if (this.isRunning || !this.config.enabled) return

    this.isRunning = true
    this.intervalId = setInterval(() => {
      this.collectMetrics()
    }, this.config.metricsInterval)

    stateMachineLogger.info('Performance monitoring started', {
      interval: this.config.metricsInterval,
    })
  }

  /**
   * Stop performance monitoring
   */
  stop(): void {
    if (!this.isRunning) return

    this.isRunning = false
    /* c8 ignore next 4 */
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
    }

    stateMachineLogger.info('Performance monitoring stopped')
  }

  /**
   * Get current performance status
   */
  getPerformanceStatus(): {
    status: HealthStatus
    summary: ReturnType<MetricsCollector['getMetricsSummary']>
    issues: string[]
  } {
    const summary = this.metricsCollector.getMetricsSummary()
    const issues: string[] = []
    let status: HealthStatus = HealthStatus.HEALTHY

    // Check error rate
    if (summary.errorRate >= this.config.thresholds.errorRateCritical) {
      status = HealthStatus.CRITICAL
      issues.push(`Critical error rate: ${summary.errorRate.toFixed(2)}%`)
    } else if (summary.errorRate >= this.config.thresholds.errorRateWarning) {
      status = HealthStatus.WARNING
      issues.push(`High error rate: ${summary.errorRate.toFixed(2)}%`)
    }

    // Check transition time
    if (
      summary.averageTransitionTime >=
      this.config.thresholds.transitionTimeCritical
    ) {
      status = HealthStatus.CRITICAL
      issues.push(
        `Critical transition time: ${summary.averageTransitionTime.toFixed(2)}ms`,
      )
    } else if (
      summary.averageTransitionTime >=
      this.config.thresholds.transitionTimeWarning
    ) {
      if (status === HealthStatus.HEALTHY) status = HealthStatus.WARNING
      issues.push(
        `Slow transitions: ${summary.averageTransitionTime.toFixed(2)}ms`,
      )
    }

    return { status, summary, issues }
  }

  /**
   * Collect current metrics
   */
  private collectMetrics(): void {
    const summary = this.metricsCollector.getMetricsSummary()

    stateMachineLogger.debug('Performance metrics collected', {
      totalTransitions: summary.totalTransitions,
      errorRate: summary.errorRate,
      averageTransitionTime: summary.averageTransitionTime,
    })
  }
}

/**
 * Health checker for StateMachine instances
 */
export class HealthChecker {
  private performanceMonitor: PerformanceMonitor
  private config: MonitoringConfig
  private intervalId: NodeJS.Timeout | undefined
  private isRunning = false
  private lastHealthCheck: HealthCheckResult | undefined

  constructor(
    performanceMonitor: PerformanceMonitor,
    config: Partial<MonitoringConfig> = {},
  ) {
    this.performanceMonitor = performanceMonitor
    this.config = { ...DEFAULT_MONITORING_CONFIG, ...config }
  }

  /**
   * Start health checking
   */
  start(): void {
    if (this.isRunning || !this.config.enabled) return

    this.isRunning = true
    this.intervalId = setInterval(() => {
      this.performHealthCheck()
    }, this.config.healthCheckInterval)

    stateMachineLogger.info('Health checking started', {
      interval: this.config.healthCheckInterval,
    })
  }

  /**
   * Stop health checking
   */
  stop(): void {
    if (!this.isRunning) return

    this.isRunning = false
    /* c8 ignore next 4 */
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
    }

    stateMachineLogger.info('Health checking stopped')
  }

  /**
   * Perform immediate health check
   */
  performHealthCheck(): HealthCheckResult {
    const performanceStatus = this.performanceMonitor.getPerformanceStatus()

    const result: HealthCheckResult = {
      status: performanceStatus.status,
      message: this.generateHealthMessage(performanceStatus),
      timestamp: Date.now(),
      metrics: performanceStatus.summary,
    }

    this.lastHealthCheck = result
    this.logHealthCheck(result)

    return result
  }

  /**
   * Get last health check result
   */
  getLastHealthCheck(): HealthCheckResult | undefined {
    return this.lastHealthCheck
  }

  /**
   * Generate health message based on status
   */
  private generateHealthMessage(
    performanceStatus: ReturnType<PerformanceMonitor['getPerformanceStatus']>,
  ): string {
    const { status, issues, summary } = performanceStatus

    if (status === HealthStatus.HEALTHY) {
      return `StateMachine is healthy. ${summary.totalTransitions} transitions, ${summary.errorRate.toFixed(2)}% error rate`
    }

    if (status === HealthStatus.WARNING) {
      return `StateMachine has warnings: ${issues.join(', ')}`
    }

    /* c8 ignore next */
    if (status === HealthStatus.CRITICAL) {
      /* c8 ignore next */
      return `StateMachine is in critical state: ${issues.join(', ')}`
    }

    /* c8 ignore next */
    return 'StateMachine health status unknown'
  }

  /**
   * Log health check results
   */
  private logHealthCheck(result: HealthCheckResult): void {
    const logData = {
      status: result.status,
      message: result.message,
      metrics: result.metrics,
    }

    switch (result.status) {
      case HealthStatus.HEALTHY:
        stateMachineLogger.debug('Health check passed', logData)
        break
      case HealthStatus.WARNING:
        stateMachineLogger.warn('Health check warning', logData)
        break
      case HealthStatus.CRITICAL:
        stateMachineLogger.error('Health check critical', logData)
        break
      /* c8 ignore next 2 */
      default:
        stateMachineLogger.info('Health check completed', logData)
    }
  }
}

/**
 * Comprehensive monitoring system
 */
export class StateMachineMonitor {
  private metricsCollector: MetricsCollector
  private performanceMonitor: PerformanceMonitor
  private healthChecker: HealthChecker
  private config: MonitoringConfig

  constructor(config: Partial<MonitoringConfig> = {}) {
    this.config = { ...DEFAULT_MONITORING_CONFIG, ...config }
    this.metricsCollector = new MetricsCollector(this.config)
    this.performanceMonitor = new PerformanceMonitor(
      this.metricsCollector,
      this.config,
    )
    this.healthChecker = new HealthChecker(this.performanceMonitor, this.config)
  }

  /**
   * Start all monitoring components
   */
  start(): void {
    this.performanceMonitor.start()
    this.healthChecker.start()

    stateMachineLogger.info('StateMachine monitoring started', {
      config: this.config,
    })
  }

  /**
   * Stop all monitoring components
   */
  stop(): void {
    this.performanceMonitor.stop()
    this.healthChecker.stop()

    stateMachineLogger.info('StateMachine monitoring stopped')
  }

  /**
   * Record a transition for monitoring
   */
  recordTransition(transitionTime: number): void {
    this.metricsCollector.recordTransition(transitionTime)
  }

  /**
   * Record an error for monitoring
   */
  recordError(): void {
    this.metricsCollector.recordError()
  }

  /**
   * Get comprehensive monitoring report
   */
  getMonitoringReport(): {
    health: HealthCheckResult
    performance: ReturnType<PerformanceMonitor['getPerformanceStatus']>
    metrics: ReturnType<MetricsCollector['getMetricsSummary']>
    config: MonitoringConfig
  } {
    const health = this.healthChecker.performHealthCheck()
    const performance = this.performanceMonitor.getPerformanceStatus()
    const metrics = this.metricsCollector.getMetricsSummary()

    return {
      health,
      performance,
      metrics,
      config: this.config,
    }
  }

  /**
   * Export metrics for external monitoring systems
   */
  exportMetrics(): {
    prometheus?: string
    json: any
  } {
    const metrics = this.metricsCollector.getMetricsSummary()
    const health = this.healthChecker.getLastHealthCheck()

    const jsonExport = {
      timestamp: Date.now(),
      metrics,
      health,
      config: this.config,
    }

    // Prometheus format
    const prometheusExport = this.generatePrometheusMetrics(metrics, health)

    return {
      prometheus: prometheusExport,
      json: jsonExport,
    }
  }

  /**
   * Generate Prometheus-compatible metrics (without memory metrics)
   */
  private generatePrometheusMetrics(
    metrics: ReturnType<MetricsCollector['getMetricsSummary']>,
    health?: HealthCheckResult,
  ): string {
    const lines: string[] = []

    // Transitions counter
    lines.push(
      '# HELP statemachine_transitions_total Total number of state transitions',
    )
    lines.push('# TYPE statemachine_transitions_total counter')
    lines.push(`statemachine_transitions_total ${metrics.totalTransitions}`)

    // Errors counter
    lines.push('# HELP statemachine_errors_total Total number of errors')
    lines.push('# TYPE statemachine_errors_total counter')
    lines.push(`statemachine_errors_total ${metrics.totalErrors}`)

    // Average transition time
    lines.push(
      '# HELP statemachine_transition_time_avg Average transition time in milliseconds',
    )
    lines.push('# TYPE statemachine_transition_time_avg gauge')
    lines.push(
      `statemachine_transition_time_avg ${metrics.averageTransitionTime}`,
    )

    // Error rate
    lines.push('# HELP statemachine_error_rate Error rate percentage')
    lines.push('# TYPE statemachine_error_rate gauge')
    lines.push(`statemachine_error_rate ${metrics.errorRate}`)

    // Uptime
    lines.push('# HELP statemachine_uptime Uptime in milliseconds')
    lines.push('# TYPE statemachine_uptime gauge')
    lines.push(`statemachine_uptime ${metrics.uptime}`)

    // Health status
    if (health) {
      const healthValue =
        health.status === HealthStatus.HEALTHY
          ? 1
          : health.status === HealthStatus.WARNING
            ? 0.5
            : 0
      lines.push(
        '# HELP statemachine_health Health status (1=healthy, 0.5=warning, 0=critical)',
      )
      lines.push('# TYPE statemachine_health gauge')
      lines.push(`statemachine_health ${healthValue}`)
    }

    return lines.join('\n')
  }
}

/**
 * Global monitoring instance
 */
export const globalStateMachineMonitor = new StateMachineMonitor()

/**
 * Utility functions for monitoring integration
 */
export const MonitoringUtils = {
  /**
   * Create monitoring decorator for StateMachine methods
   */
  withMonitoring<T extends (...args: any[]) => any>(
    fn: T,
    monitor: StateMachineMonitor,
    _operationName: string,
  ): T {
    return ((...args: any[]) => {
      const startTime = Date.now()

      try {
        const result = fn(...args)

        if (result instanceof Promise) {
          return result
            .then((value) => {
              monitor.recordTransition(Date.now() - startTime)
              return value
            })
            .catch((error) => {
              monitor.recordError()
              throw error
            })
        } else {
          monitor.recordTransition(Date.now() - startTime)
          return result
        }
      } catch (error) {
        monitor.recordError()
        throw error
      }
    }) as T
  },

  /**
   * Create monitoring middleware
   */
  createMonitoringMiddleware(monitor: StateMachineMonitor) {
    return {
      beforeTransition: (context: any) => {
        context._monitoringStartTime = Date.now()
      },
      afterTransition: (context: any) => {
        if (context._monitoringStartTime) {
          monitor.recordTransition(Date.now() - context._monitoringStartTime)
        }
      },
      onError: (_context: any, _error: any) => {
        monitor.recordError()
      },
    }
  },
}
