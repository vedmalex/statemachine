import { describe, expect, it } from 'vitest'

import * as pkg from '../index'

/**
 * Public-surface guard: ratchet test prescribed by TASK-003 CODE_REVIEW
 * (F-CR3-2 + F-CR3-6). Prevents re-introduction of singletons or internal
 * helpers into the public surface by future tasks (TASK-004 singleton
 * elimination, TASK-005 CI/CD, etc.). Fails on drift, not on growth.
 *
 * If a TASK-004+ refactor needs to genuinely add a new public symbol,
 * update both `STABLE_SYMBOLS` and the banned-symbols list below with
 * a CODE_REVIEW DA gate justifying the change.
 */

const BANNED_SYMBOLS = [
  // TASK-004 singletons (must NOT leak to public surface; TASK-004 will eliminate them entirely)
  'globalStateMachineMonitor',
  'globalErrorHandler',
  'TimerScheduler',
  // Internal observability helpers (TASK-004 owner; not consumer-facing)
  'MonitoringUtils',
  'HealthChecker',
  'MetricsCollector',
  'PerformanceMonitor',
  'StateMachineMonitor',
  // Internal logger plumbing
  'Logger',
  'LoggerFactory',
  'ConsoleAppender',
  'MemoryAppender',
  'serializationLogger',
  // Pruned modules
  'applySecurityPolicy',
  // Removed type-utilities (TASK-003 CODE_REVIEW F-CR3-3)
  'Adaptee',
  'Configuree',
  // Note: `Config` is intentionally allowed to remain absent — was removed in TASK-003 CODE_REVIEW.
] as const

const STABLE_SYMBOLS = [
  'createMachine',
  'StateMachine',
  // type-only: presence is checked by the dist .d.ts surface; runtime keys can't see them
] as const

describe('public surface guard (TASK-003 CODE_REVIEW ratchet)', () => {
  it('exports the 2 firm @stable runtime symbols', () => {
    for (const name of STABLE_SYMBOLS) {
      expect(pkg, `expected ${name} on public surface`).toHaveProperty(name)
    }
  })

  it('does NOT export any banned symbol (singletons, internal helpers)', () => {
    for (const name of BANNED_SYMBOLS) {
      expect(pkg, `${name} must not be on public surface`).not.toHaveProperty(name)
    }
  })

  it('exports createMachine as a callable function', () => {
    expect(typeof pkg.createMachine).toBe('function')
  })

  it('exports StateMachine as a constructable class', () => {
    expect(typeof pkg.StateMachine).toBe('function')
    expect(pkg.StateMachine.prototype).toBeDefined()
  })
})
