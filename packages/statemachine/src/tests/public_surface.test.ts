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
  // TASK-004 singletons (eliminated in TASK-004 per ISS-007/ISS-008)
  'globalStateMachineMonitor',
  'globalErrorHandler',
  'TimerScheduler',
  // Internal observability helpers (TASK-004 owner; not consumer-facing)
  'MonitoringUtils',
  'HealthChecker',
  'MetricsCollector',
  'PerformanceMonitor',
  'StateMachineMonitor',
  // TASK-004 internal factories (@internal; not for public consumption)
  'createDefaultScheduler',
  'createDefaultMonitor',
  'createDefaultErrorHandler',
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

// === @unstable type re-export inventory (per TD-T4-7 TASK-004) ===
// The following types are intentionally part of the @unstable surface
// (not in STABLE_SYMBOLS, not in BANNED_SYMBOLS — type-only, runtime-invisible):
//   - IMonitor (existing TASK-002 surface; expanded additively in TASK-004 per TD-T4-2)
//   - ITimerScheduler (NEW in TASK-004 per TD-T4-2a)
//   - IErrorHandler (NEW in TASK-004 per TD-T4-2b)
// Per package-level @unstable JSDoc default in src/index.ts; verified by tsc reachability.

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
