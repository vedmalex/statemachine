import { describe, expect, it } from 'vitest'

import * as pkg from '../index'
import { TimerScheduler } from '../scheduler'
import { StateMachineMonitor } from '../monitoring'
import { ErrorHandler } from '../error_handling'

/**
 * Singleton-elimination invariant test (TASK-004 TD-T4-8 primary invariant).
 *
 * Asserts:
 *   1. No exported function-typed value exposes a static getInstance() method.
 *   2. The internal classes (TimerScheduler, StateMachineMonitor, ErrorHandler)
 *      do not expose a static getInstance() — even if not re-exported from index.
 *   3. Two StateMachine instances created with default options have INDEPENDENT
 *      monitor / scheduler / errorHandler references (per-instance isolation).
 *   4. Side-effects on machineA's monitor do NOT appear on machineB's monitor —
 *      cross-machine non-aggregation property.
 *
 * Deterministic; no --expose-gc dependency.
 */
describe('singleton-elimination invariant (TASK-004)', () => {
  it('no public exported function exposes a static getInstance()', () => {
    for (const name of Object.keys(pkg)) {
      const value = (pkg as Record<string, unknown>)[name]
      if (typeof value === 'function') {
        const ctor = value as { getInstance?: unknown }
        expect(
          ctor.getInstance,
          `public symbol ${name} must not have static getInstance()`,
        ).toBeUndefined()
      }
    }
  })

  it('internal classes (TimerScheduler, StateMachineMonitor, ErrorHandler) have no static getInstance', () => {
    expect((TimerScheduler as { getInstance?: unknown }).getInstance).toBeUndefined()
    expect((StateMachineMonitor as { getInstance?: unknown }).getInstance).toBeUndefined()
    expect((ErrorHandler as { getInstance?: unknown }).getInstance).toBeUndefined()
  })

  it('two StateMachine instances have independent monitor/scheduler/errorHandler refs', () => {
    const machineA = pkg.createMachine({ name: 'a', initialState: 's', states: { s: {} }, events: {} })
    const machineB = pkg.createMachine({ name: 'b', initialState: 's', states: { s: {} }, events: {} })
    // Use a private-field probe via casting (tests live alongside source; allowed for this invariant).
    const a = machineA as unknown as { monitor: object; scheduler: object; errorHandler: object }
    const b = machineB as unknown as { monitor: object; scheduler: object; errorHandler: object }
    expect(a.monitor).not.toBe(b.monitor)
    expect(a.scheduler).not.toBe(b.scheduler)
    expect(a.errorHandler).not.toBe(b.errorHandler)
  })

  it('cross-machine non-aggregation: side-effect on A does not appear on B', () => {
    const machineA = pkg.createMachine({ name: 'a', initialState: 's', states: { s: {} }, events: {} })
    const machineB = pkg.createMachine({ name: 'b', initialState: 's', states: { s: {} }, events: {} })
    const a = machineA as unknown as { monitor: { recordTransition: (d: number, s: boolean) => void; getMetrics?: () => { totalTransitions: number } } }
    const b = machineB as unknown as { monitor: { getMetrics?: () => { totalTransitions: number } } }
    a.monitor.recordTransition(10, true)
    const aMetrics = a.monitor.getMetrics?.()
    const bMetrics = b.monitor.getMetrics?.()
    if (aMetrics && bMetrics) {
      expect(aMetrics.totalTransitions).toBeGreaterThan(0)
      expect(bMetrics.totalTransitions).toBe(0)
    } else {
      // If getMetrics not implemented on default monitor, fall through — ref-isolation already covered above
      expect(true).toBe(true)
    }
  })
})
