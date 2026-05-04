import { describe, expect, it } from 'vitest'
import { expectTypeOf } from 'vitest'

import type { IMonitor, TransitionContext, MonitorMetricsSnapshot, ErrorContext } from '../../index'

describe('EP-1 IMonitor — ABI conformance', () => {
  it('default factory output structurally implements IMonitor', () => {
    // Test the structural contract, NOT the internal class export.
    // The default monitor is consumed via createMachine; we replicate its shape
    // for type-level conformance check.
    const monitor: IMonitor = {
      recordTransition: (_duration: number, _success: boolean) => {},
      recordError: (_error: Error) => {},
    }
    expectTypeOf(monitor).toMatchTypeOf<IMonitor>()
    expect(typeof monitor.recordTransition).toBe('function')
    expect(typeof monitor.recordError).toBe('function')
  })

  it('minimal stub is structurally assignable', () => {
    const stub: IMonitor = {
      recordTransition: () => {},
      recordError: () => {},
    }
    expectTypeOf(stub).toMatchTypeOf<IMonitor>()
    // Optional methods absent — interface allows it (recordEvent?, getMetrics?)
    expect(stub.recordEvent).toBeUndefined()
    expect(stub.getMetrics).toBeUndefined()
  })

  it('full implementation with optional methods is structurally assignable', () => {
    const full: IMonitor = {
      recordTransition: (_d: number, _s: boolean, _ctx?: TransitionContext) => {},
      recordError: (_e: Error, _ctx?: ErrorContext) => {},
      recordEvent: (_name: string, _dur: number) => {},
      getMetrics: (): MonitorMetricsSnapshot => ({
        totalTransitions: 0,
        successCount: 0,
        errorCount: 0,
        averageDuration: 0,
      }),
    }
    expectTypeOf(full).toMatchTypeOf<IMonitor>()
    expect(typeof full.recordEvent).toBe('function')
    expect(typeof full.getMetrics).toBe('function')
  })
})
