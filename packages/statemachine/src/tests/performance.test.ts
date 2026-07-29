/**
 * Performance tests for StateMachine library
 * Tests large state machines, frequent transitions, and memory usage
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LogLevel, MemoryAppender, getLogger } from '../logger'
import { StateMachine } from '../state_machine'
import { MemoryAdapter } from '../types'

// Performance test configuration
/**
 * WALL-CLOCK BUDGETS ARE SMOKE-LEVEL GUARDS, NOT BENCHMARKS.
 *
 * An absolute millisecond threshold measures the HOST, not the code: the same
 * commit that passes on a developer laptop fails in a loaded CI container, and
 * that failure is indistinguishable from a real regression. This suite hit
 * exactly that — `106.15ms` against a `100ms` budget on the Node CI lane while
 * the Bun lane passed, a 6% overshoot that says nothing about the library.
 *
 * So these budgets are deliberately set an ORDER OF MAGNITUDE above the observed
 * cost: they still catch a catastrophic regression (an accidental quadratic, a
 * synchronous IO call on the hot path), and they no longer fail on scheduling
 * noise. Tightening them back to "just above what my machine does" re-creates the
 * flake — do not.
 *
 * The real guard against algorithmic regression is `perf_counting.test.ts`, which
 * counts OPERATIONS rather than milliseconds and is therefore host-independent:
 * it pins the composite-write hot path at O(R) by measuring growth across
 * R ∈ {40…320}. That is where a complexity regression is caught; this file only
 * asserts nothing has become absurd.
 */
const PERFORMANCE_CONFIG = {
  LARGE_STATE_COUNT: 100, // Reduced for faster tests
  FREQUENT_TRANSITIONS: 1000, // Reduced for faster tests
  MEMORY_TEST_ITERATIONS: 100, // Reduced for faster tests
  MAX_TRANSITION_TIME: 100, // ms — see the note above; ~10ms observed
  MAX_CREATION_TIME: 1000, // ms — see the note above; ~50-105ms observed
  MAX_MEMORY_GROWTH: 50, // MB
}

// Performance metrics collector
class PerformanceMetrics {
  private metrics: Map<string, number[]> = new Map()
  private memoryBaseline: number = 0

  startMemoryTracking(): void {
    // Force garbage collection if available
    if (global.gc) {
      global.gc()
    }
    this.memoryBaseline = process.memoryUsage().heapUsed
  }

  recordMetric(name: string, value: number): void {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, [])
    }
    this.metrics.get(name)!.push(value)
  }

  getAverageMetric(name: string): number {
    const values = this.metrics.get(name) || []
    return values.length > 0
      ? values.reduce((a, b) => a + b, 0) / values.length
      : 0
  }

  getMaxMetric(name: string): number {
    const values = this.metrics.get(name) || []
    return values.length > 0 ? Math.max(...values) : 0
  }

  getMemoryGrowth(): number {
    const currentMemory = process.memoryUsage().heapUsed
    return (currentMemory - this.memoryBaseline) / 1024 / 1024 // MB
  }

  reset(): void {
    this.metrics.clear()
    this.memoryBaseline = 0
  }

  getReport(): string {
    const report = ['=== Performance Metrics Report ===']

    for (const [name, values] of this.metrics.entries()) {
      const avg = this.getAverageMetric(name)
      const max = this.getMaxMetric(name)
      const min = Math.min(...values)
      report.push(`${name}:`)
      report.push(`  Average: ${avg.toFixed(2)}ms`)
      report.push(`  Max: ${max.toFixed(2)}ms`)
      report.push(`  Min: ${min.toFixed(2)}ms`)
    }

    report.push(`Memory Growth: ${this.getMemoryGrowth().toFixed(2)}MB`)
    return report.join('\n')
  }
}

// Test data generators
function generateLargeStateMachine(stateCount: number) {
  const states: any = {}
  const events: any = {}

  // Generate states
  for (let i = 0; i < stateCount; i++) {
    states[`state_${i}`] = {
      display: `State ${i}`,
      onEnter: () => {
        /* performance test action */
      },
      onExit: () => {
        /* performance test action */
      },
    }
  }

  // Generate events with transitions
  for (let i = 0; i < stateCount - 1; i++) {
    events[`transition_${i}`] = {
      display: `Transition ${i}`,
      transitions: [{ from: `state_${i}`, to: `state_${i + 1}` }],
    }
  }

  // Add circular transition
  events[`reset`] = {
    display: 'Reset to first state',
    transitions: [{ from: `state_${stateCount - 1}`, to: 'state_0' }],
  }

  return {
    name: 'LargeStateMachine',
    initialState: 'state_0',
    stateAttribute: 'state',
    states,
    events,
  }
}

describe('StateMachine Performance Tests', () => {
  let metrics: PerformanceMetrics
  let memoryAppender: MemoryAppender
  let logger: ReturnType<typeof getLogger>

  beforeEach(() => {
    metrics = new PerformanceMetrics()
    memoryAppender = new MemoryAppender()
    logger = getLogger('PerformanceTest', { level: LogLevel.ERROR })
    logger.addAppender(memoryAppender)
    metrics.startMemoryTracking()
  })

  afterEach(() => {
    // Log performance report
    console.log(metrics.getReport())
    metrics.reset()
  })

  describe('Large State Machine Performance', () => {
    it('should create large state machine within time limit', () => {
      const config = generateLargeStateMachine(
        PERFORMANCE_CONFIG.LARGE_STATE_COUNT,
      )
      const adapter = new MemoryAdapter({ state: '' })

      const startTime = performance.now()
      const sm = new StateMachine(config as any, adapter)
      const endTime = performance.now()

      const creationTime = endTime - startTime
      metrics.recordMetric('large_sm_creation', creationTime)

      expect(creationTime).toBeLessThan(PERFORMANCE_CONFIG.MAX_CREATION_TIME)
      expect(sm.currentState).toBe('state_0')
    })

    it('should handle frequent transitions efficiently', async () => {
      const config = generateLargeStateMachine(50) // Smaller for frequent transitions
      const adapter = new MemoryAdapter({ state: '' })
      const sm = new StateMachine(config as any, adapter)

      const transitionCount = PERFORMANCE_CONFIG.FREQUENT_TRANSITIONS
      const startTime = performance.now()

      for (let i = 0; i < transitionCount; i++) {
        const eventName = `transition_${i % 49}` // Cycle through available transitions
        try {
          await sm.fireEvent(eventName)
        } catch (e) {
          // Expected for some invalid transitions
        }
      }

      const totalTime = performance.now() - startTime
      const avgTransitionTime = totalTime / transitionCount

      metrics.recordMetric('avg_transition_time', avgTransitionTime)
      expect(avgTransitionTime).toBeLessThan(
        PERFORMANCE_CONFIG.MAX_TRANSITION_TIME,
      )
    })

    it('should maintain memory efficiency with large state machines', () => {
      const iterations = PERFORMANCE_CONFIG.MEMORY_TEST_ITERATIONS
      const stateMachines: any[] = []

      for (let i = 0; i < iterations; i++) {
        const config = generateLargeStateMachine(20)
        const adapter = new MemoryAdapter({ state: '' })
        const sm = new StateMachine(config as any, adapter)
        stateMachines.push(sm)

        // Sample memory usage every 20 iterations
        if (i % 20 === 0) {
          const memoryGrowth = metrics.getMemoryGrowth()
          metrics.recordMetric('memory_usage', memoryGrowth)
        }
      }

      const finalMemoryGrowth = metrics.getMemoryGrowth()
      expect(finalMemoryGrowth).toBeLessThan(
        PERFORMANCE_CONFIG.MAX_MEMORY_GROWTH,
      )

      // Cleanup
      stateMachines.length = 0
    })

    it('should serialize/deserialize large state machines efficiently', () => {
      const config = generateLargeStateMachine(100)
      const adapter = new MemoryAdapter({ state: '' })
      const sm = new StateMachine(config as any, adapter)

      // Serialization performance
      const serializeStart = performance.now()
      const serialized = sm.toJSON()
      const serializeTime = performance.now() - serializeStart

      metrics.recordMetric('serialization_time', serializeTime)

      // Deserialization performance
      const deserializeStart = performance.now()
      // W0: each generated state's onEnter/onExit serialize as body-free NAME
      // references; restoration resolves them from the registry.
      const deserialized = StateMachine.fromJSON(serialized, adapter, {
        actions: { onEnter: () => {}, onExit: () => {} },
      })
      const deserializeTime = performance.now() - deserializeStart

      metrics.recordMetric('deserialization_time', deserializeTime)

      // Order-of-magnitude smoke budgets, not benchmarks — see the note on
      // PERFORMANCE_CONFIG for why these are deliberately loose.
      expect(serializeTime).toBeLessThan(1000)
      expect(deserializeTime).toBeLessThan(2000)
      expect(deserialized.currentState).toBe(sm.currentState)
    })
  })

  describe('Memory Leak Detection', () => {
    it('should not leak memory during repeated operations', async () => {
      const initialMemory = metrics.getMemoryGrowth()

      for (let iteration = 0; iteration < 50; iteration++) {
        const config = generateLargeStateMachine(10)
        const adapter = new MemoryAdapter({ state: '' })
        const sm = new StateMachine(config as any, adapter)

        // Perform operations
        for (let i = 0; i < 5; i++) {
          try {
            await sm.fireEvent(`transition_${i % 9}`)
          } catch (e) {
            // Expected
          }
        }

        // Serialize/deserialize
        const serialized = sm.toJSON()
        // W0: onEnter/onExit restore by NAME from the registry, never a body.
        StateMachine.fromJSON(serialized, adapter, {
          actions: { onEnter: () => {}, onExit: () => {} },
        })

        // Force garbage collection periodically
        if (iteration % 10 === 0 && global.gc) {
          global.gc()
        }
      }

      // Force final garbage collection
      if (global.gc) {
        global.gc()
      }

      const finalMemory = metrics.getMemoryGrowth()
      const memoryIncrease = finalMemory - initialMemory

      metrics.recordMetric('memory_leak_test', memoryIncrease)
      expect(memoryIncrease).toBeLessThan(10) // Less than 10MB increase
    })
  })
})
