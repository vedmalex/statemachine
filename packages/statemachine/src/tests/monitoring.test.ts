// Tests for StateMachine monitoring system
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  DEFAULT_MONITORING_CONFIG,
  HealthChecker,
  HealthStatus,
  MetricsCollector,
  MonitoringUtils,
  PerformanceMonitor,
  StateMachineMonitor,
  globalStateMachineMonitor,
} from '../monitoring'

describe('StateMachine Monitoring System', () => {
  describe('MetricsCollector', () => {
    let collector: MetricsCollector

    beforeEach(() => {
      collector = new MetricsCollector()
    })

    it('should record transitions correctly', () => {
      collector.recordTransition(50)
      collector.recordTransition(75)
      collector.recordTransition(100)

      const summary = collector.getMetricsSummary()
      expect(summary.totalTransitions).toBe(3)
      expect(summary.averageTransitionTime).toBeCloseTo(75, 1)
    })

    it('should record errors correctly', () => {
      collector.recordError()
      collector.recordError()
      collector.recordTransition(50)

      const summary = collector.getMetricsSummary()
      expect(summary.totalErrors).toBe(2)
      expect(summary.errorRate).toBe(200) // 2 errors / 1 transition * 100
    })

    it('should calculate error rate correctly', () => {
      collector.recordTransition(50)
      collector.recordTransition(75)
      collector.recordError()

      const summary = collector.getMetricsSummary()
      expect(summary.errorRate).toBe(50) // 1 error / 2 transitions * 100
    })

    it('should maintain metrics history with size limit', () => {
      const smallCollector = new MetricsCollector({ maxMetricsHistory: 5 })

      // Add more metrics than the limit
      for (let i = 0; i < 10; i++) {
        smallCollector.recordTransition(i * 10)
      }

      const history = smallCollector.getMetricsHistory()
      expect(history.length).toBe(5)
    })

    it('should filter metrics by time range', () => {
      collector.recordTransition(50)

      // Wait a bit and record another
      setTimeout(() => {
        collector.recordTransition(75)
      }, 10)

      setTimeout(() => {
        const recentMetrics = collector.getMetricsHistory(5) // Last 5ms
        expect(recentMetrics.length).toBeLessThanOrEqual(1)
      }, 20)
    })

    it('should clear metrics correctly', () => {
      collector.recordTransition(50)
      collector.recordError()

      collector.clearMetrics()

      const summary = collector.getMetricsSummary()
      expect(summary.totalTransitions).toBe(0)
      expect(summary.totalErrors).toBe(0)
    })

    it('should handle disabled state', () => {
      const disabledCollector = new MetricsCollector({ enabled: false })

      disabledCollector.recordTransition(50)
      disabledCollector.recordError()

      const summary = disabledCollector.getMetricsSummary()
      expect(summary.totalTransitions).toBe(0)
      expect(summary.totalErrors).toBe(0)
    })
  })

  describe('PerformanceMonitor', () => {
    let collector: MetricsCollector
    let monitor: PerformanceMonitor

    beforeEach(() => {
      collector = new MetricsCollector()
      monitor = new PerformanceMonitor(collector, { metricsInterval: 100 })
    })

    afterEach(() => {
      monitor.stop()
    })

    it('should start and stop monitoring', () => {
      expect(() => monitor.start()).not.toThrow()
      expect(() => monitor.stop()).not.toThrow()
    })

    it('should detect healthy performance status', () => {
      collector.recordTransition(50) // Below warning threshold

      const status = monitor.getPerformanceStatus()
      expect(status.status).toBe(HealthStatus.HEALTHY)
      expect(status.issues).toHaveLength(0)
    })

    it('should detect warning performance status', () => {
      // Record slow transitions (above warning threshold)
      collector.recordTransition(150) // Above 100ms warning threshold

      const status = monitor.getPerformanceStatus()
      expect(status.status).toBe(HealthStatus.WARNING)
      expect(status.issues.length).toBeGreaterThan(0)
    })

    it('should detect critical performance status', () => {
      // Record very slow transitions (above critical threshold)
      collector.recordTransition(600) // Above 500ms critical threshold

      const status = monitor.getPerformanceStatus()
      expect(status.status).toBe(HealthStatus.CRITICAL)
      expect(status.issues.length).toBeGreaterThan(0)
    })

    it('should detect high error rate', () => {
      // Create high error rate scenario
      collector.recordTransition(50)
      collector.recordError()
      collector.recordError() // 200% error rate

      const status = monitor.getPerformanceStatus()
      expect(status.status).toBe(HealthStatus.CRITICAL)
      expect(status.issues.some((issue) => issue.includes('error rate'))).toBe(
        true,
      )
    })

    it('should not start when disabled', () => {
      const disabledMonitor = new PerformanceMonitor(collector, {
        enabled: false,
      })
      disabledMonitor.start()

      // Should not throw and should not actually start
      expect(() => disabledMonitor.stop()).not.toThrow()
    })
  })

  describe('HealthChecker', () => {
    let collector: MetricsCollector
    let performanceMonitor: PerformanceMonitor
    let healthChecker: HealthChecker

    beforeEach(() => {
      collector = new MetricsCollector()
      performanceMonitor = new PerformanceMonitor(collector)
      healthChecker = new HealthChecker(performanceMonitor, {
        healthCheckInterval: 100,
      })
    })

    afterEach(() => {
      healthChecker.stop()
    })

    it('should start and stop health checking', () => {
      expect(() => healthChecker.start()).not.toThrow()
      expect(() => healthChecker.stop()).not.toThrow()
    })

    it('should perform health check and return result', () => {
      collector.recordTransition(50)

      const result = healthChecker.performHealthCheck()
      expect(result).toHaveProperty('status')
      expect(result).toHaveProperty('message')
      expect(result).toHaveProperty('timestamp')
      expect(result).toHaveProperty('metrics')
    })

    it('should generate healthy message', () => {
      collector.recordTransition(50)

      const result = healthChecker.performHealthCheck()
      expect(result.status).toBe(HealthStatus.HEALTHY)
      expect(result.message).toContain('healthy')
    })

    it('should generate warning message', () => {
      collector.recordTransition(150) // Above warning threshold

      const result = healthChecker.performHealthCheck()
      expect(result.status).toBe(HealthStatus.WARNING)
      expect(result.message).toContain('warnings')
    })

    it('should generate critical message', () => {
      collector.recordTransition(600) // Above critical threshold

      const result = healthChecker.performHealthCheck()
      expect(result.status).toBe(HealthStatus.CRITICAL)
      expect(result.message).toContain('critical')
    })

    it('should store last health check result', () => {
      const result = healthChecker.performHealthCheck()
      const lastResult = healthChecker.getLastHealthCheck()

      expect(lastResult).toEqual(result)
    })
  })

  describe('StateMachineMonitor', () => {
    let monitor: StateMachineMonitor

    beforeEach(() => {
      monitor = new StateMachineMonitor({
        metricsInterval: 100,
        healthCheckInterval: 200,
      })
    })

    afterEach(() => {
      monitor.stop()
    })

    it('should start and stop all monitoring components', () => {
      expect(() => monitor.start()).not.toThrow()
      expect(() => monitor.stop()).not.toThrow()
    })

    it('should record transitions and errors', () => {
      monitor.recordTransition(50)
      monitor.recordError()

      const report = monitor.getMonitoringReport()
      expect(report.metrics.totalTransitions).toBe(1)
      expect(report.metrics.totalErrors).toBe(1)
    })

    it('should generate comprehensive monitoring report', () => {
      monitor.recordTransition(50)

      const report = monitor.getMonitoringReport()
      expect(report).toHaveProperty('health')
      expect(report).toHaveProperty('performance')
      expect(report).toHaveProperty('metrics')
      expect(report).toHaveProperty('config')
    })

    it('should export metrics in multiple formats', () => {
      monitor.recordTransition(50)
      monitor.recordTransition(75)

      const exported = monitor.exportMetrics()
      expect(exported).toHaveProperty('json')
      expect(exported).toHaveProperty('prometheus')
      expect(typeof exported.prometheus).toBe('string')
      expect(exported.json).toHaveProperty('metrics')
    })

    it('should generate Prometheus metrics format', () => {
      monitor.recordTransition(50)

      const exported = monitor.exportMetrics()
      const prometheus = exported.prometheus!

      expect(prometheus).toContain('statemachine_transitions_total')
      expect(prometheus).toContain('statemachine_errors_total')
      expect(prometheus).toContain('statemachine_transition_time_avg')
      expect(prometheus).toContain('statemachine_error_rate')
      expect(prometheus).toContain('statemachine_uptime')
      // Note: memory_usage removed - not relevant for state machine monitoring
    })

    it('should handle custom configuration', () => {
      const customMonitor = new StateMachineMonitor({
        enabled: true,
        metricsInterval: 1000,
        thresholds: {
          transitionTimeWarning: 200,
          transitionTimeCritical: 1000,
          errorRateWarning: 10,
          errorRateCritical: 25,
        },
      })

      customMonitor.recordTransition(150) // Should be below custom warning threshold of 200ms

      const report = customMonitor.getMonitoringReport()
      expect(report.performance.status).toBe(HealthStatus.HEALTHY)
    })
  })

  describe('MonitoringUtils', () => {
    let monitor: StateMachineMonitor

    beforeEach(() => {
      monitor = new StateMachineMonitor()
    })

    afterEach(() => {
      monitor.stop()
    })

    it('should create monitoring decorator for sync functions', () => {
      const originalFn = (x: number, y: number) => x + y
      const monitoredFn = MonitoringUtils.withMonitoring(
        originalFn,
        monitor,
        'add',
      )

      const result = monitoredFn(2, 3)
      expect(result).toBe(5)

      const metrics = monitor.getMonitoringReport().metrics
      expect(metrics.totalTransitions).toBe(1)
    })

    it('should create monitoring decorator for async functions', async () => {
      const originalFn = async (x: number, y: number) => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return x + y
      }
      const monitoredFn = MonitoringUtils.withMonitoring(
        originalFn,
        monitor,
        'asyncAdd',
      )

      const result = await monitoredFn(2, 3)
      expect(result).toBe(5)

      const metrics = monitor.getMonitoringReport().metrics
      expect(metrics.totalTransitions).toBe(1)
    })

    it('should record errors in monitoring decorator', async () => {
      const errorFn = () => {
        throw new Error('Test error')
      }
      const monitoredFn = MonitoringUtils.withMonitoring(
        errorFn,
        monitor,
        'errorFn',
      )

      expect(() => monitoredFn()).toThrow('Test error')

      const metrics = monitor.getMonitoringReport().metrics
      expect(metrics.totalErrors).toBe(1)
    })

    it('should record errors in async monitoring decorator', async () => {
      const asyncErrorFn = async () => {
        throw new Error('Async test error')
      }
      const monitoredFn = MonitoringUtils.withMonitoring(
        asyncErrorFn,
        monitor,
        'asyncErrorFn',
      )

      await expect(monitoredFn()).rejects.toThrow('Async test error')

      const metrics = monitor.getMonitoringReport().metrics
      expect(metrics.totalErrors).toBe(1)
    })

    it('should create monitoring middleware', () => {
      const middleware = MonitoringUtils.createMonitoringMiddleware(monitor)

      expect(middleware).toHaveProperty('beforeTransition')
      expect(middleware).toHaveProperty('afterTransition')
      expect(middleware).toHaveProperty('onError')
      expect(typeof middleware.beforeTransition).toBe('function')
      expect(typeof middleware.afterTransition).toBe('function')
      expect(typeof middleware.onError).toBe('function')
    })

    it('should track timing in middleware', () => {
      const middleware = MonitoringUtils.createMonitoringMiddleware(monitor)
      const context = {}

      middleware.beforeTransition(context)
      expect(context).toHaveProperty('_monitoringStartTime')

      // Directly call afterTransition instead of using setTimeout
      middleware.afterTransition(context)

      const metrics = monitor.getMonitoringReport().metrics
      expect(metrics.totalTransitions).toBe(1)
    })

    it('should record errors in middleware', () => {
      const middleware = MonitoringUtils.createMonitoringMiddleware(monitor)
      const context = {}
      const error = new Error('Middleware test error')

      middleware.onError(context, error)

      const metrics = monitor.getMonitoringReport().metrics
      expect(metrics.totalErrors).toBe(1)
    })
  })

  describe('Global Monitor', () => {
    it('should provide global monitoring instance', () => {
      expect(globalStateMachineMonitor).toBeDefined()
      expect(globalStateMachineMonitor).toBeInstanceOf(StateMachineMonitor)
    })

    it('should be usable for recording metrics', () => {
      globalStateMachineMonitor.recordTransition(25)

      const report = globalStateMachineMonitor.getMonitoringReport()
      expect(report.metrics.totalTransitions).toBeGreaterThanOrEqual(1)
    })
  })

  describe('Configuration', () => {
    it('should use default configuration', () => {
      const monitor = new StateMachineMonitor()
      const report = monitor.getMonitoringReport()

      expect(report.config.enabled).toBe(DEFAULT_MONITORING_CONFIG.enabled)
      expect(report.config.metricsInterval).toBe(
        DEFAULT_MONITORING_CONFIG.metricsInterval,
      )
      expect(report.config.healthCheckInterval).toBe(
        DEFAULT_MONITORING_CONFIG.healthCheckInterval,
      )
    })

    it('should merge custom configuration with defaults', () => {
      const customConfig = {
        enabled: false,
        metricsInterval: 10000,
      }

      const monitor = new StateMachineMonitor(customConfig)
      const report = monitor.getMonitoringReport()

      expect(report.config.enabled).toBe(false)
      expect(report.config.metricsInterval).toBe(10000)
      expect(report.config.healthCheckInterval).toBe(
        DEFAULT_MONITORING_CONFIG.healthCheckInterval,
      ) // Should use default
    })

    it('should respect disabled configuration', () => {
      const monitor = new StateMachineMonitor({ enabled: false })

      monitor.recordTransition(50)
      monitor.recordError()

      const metrics = monitor.getMonitoringReport().metrics
      expect(metrics.totalTransitions).toBe(0)
      expect(metrics.totalErrors).toBe(0)
    })
  })

  describe('Performance Thresholds', () => {
    it('should detect transition time warnings', () => {
      const monitor = new StateMachineMonitor({
        thresholds: {
          transitionTimeWarning: 50,
          transitionTimeCritical: 100,
          errorRateWarning: 5,
          errorRateCritical: 15,
        },
      })

      monitor.recordTransition(75) // Above warning, below critical

      const report = monitor.getMonitoringReport()
      expect(report.performance.status).toBe(HealthStatus.WARNING)
    })

    it('should detect transition time critical', () => {
      const monitor = new StateMachineMonitor({
        thresholds: {
          transitionTimeWarning: 50,
          transitionTimeCritical: 100,
          errorRateWarning: 5,
          errorRateCritical: 15,
        },
      })

      monitor.recordTransition(150) // Above critical

      const report = monitor.getMonitoringReport()
      expect(report.performance.status).toBe(HealthStatus.CRITICAL)
    })

    it('should prioritize critical over warning status', () => {
      const monitor = new StateMachineMonitor({
        thresholds: {
          transitionTimeWarning: 50,
          transitionTimeCritical: 100,
          errorRateWarning: 5,
          errorRateCritical: 15,
        },
      })

      monitor.recordTransition(75) // Warning level
      monitor.recordTransition(150) // Critical level

      const report = monitor.getMonitoringReport()
      expect(report.performance.status).toBe(HealthStatus.CRITICAL)
    })
  })
})
