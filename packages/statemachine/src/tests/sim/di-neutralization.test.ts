/**
 * Step 2 — DI neutralization tests (TASK-014).
 *
 * Proves the five deterministic seams (SimMonitor / SimErrorHandler / NoopLogger
 * + clock + scheduler from Step 1/engine) neutralize every §5.1 wall-clock /
 * real-timer leak at the DI boundary, and that a real StateMachine constructs and
 * transitions with all five Sim seams under BOTH a fake-timers arm and a default
 * real-Date arm (mirroring the Step-3 AC-1 structure — NOT "default vitest = Date
 * faked", which is false).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
// DoD#1 SECONDARY signal: importing StateMachineMonitor from the NON-public
// ../../monitoring is permitted in tests — only the four src/sim PRODUCTION
// files are bound by the ../index-only import discipline.
import { StateMachineMonitor } from '../../monitoring'
import { NoopLogger } from '../../sim/noop-logger'
import { SimErrorHandler } from '../../sim/sim-error-handler'
import { SimMonitor } from '../../sim/sim-monitor'
import { StateMachine } from '../../state_machine'
import { createVirtualScheduler } from '../../scheduler'
import type { IErrorHandler, ILogger, IMonitor, StateMachineConfig } from '../../types'
import { MemoryAdapter } from '../../types'

const SIM_DIR = fileURLToPath(new URL('../../sim/', import.meta.url))
function simSource(file: string): string {
  return readFileSync(`${SIM_DIR}${file}`, 'utf8')
}

describe('Step 2 — SimMonitor (ADR-3 c2, R1)', () => {
  // DoD#1 PRIMARY gate = source-grep.
  it('source has ZERO wall-clock / default-monitor references (grep gate)', () => {
    const src = simSource('sim-monitor.ts')
    // strip block + line comments so the prose explaining what is forbidden does
    // not trip the grep (the gate is about CODE, not the doc-comment).
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/Date\.now/)
    expect(code).not.toMatch(/performance\.now/)
    expect(code).not.toMatch(/MetricsCollector/)
    expect(code).not.toMatch(/StateMachineMonitor/)
    expect(code).not.toMatch(/createDefaultMonitor/)
    expect(code).not.toMatch(/\.start\(/)
  })

  // DoD#1 SECONDARY signal.
  it('is NOT a StateMachineMonitor instance', () => {
    const m = new SimMonitor()
    expect(m instanceof StateMachineMonitor).toBe(false)
  })

  // DoD#2: implements recordTransition + recordError; duration stored on a
  // NON-hashed field; 1000 calls advance no wall clock.
  it('stores engine-passed durations verbatim on a non-hashed field; reads no clock', () => {
    const m = new SimMonitor()
    const h: IMonitor = m // conforms to IMonitor
    expect(typeof h.recordTransition).toBe('function')
    expect(typeof h.recordError).toBe('function')
    for (let i = 0; i < 1000; i++) {
      m.recordTransition(i, true)
    }
    // held duration array contains ONLY engine-passed values (0..999), never a
    // wall-clock reading — i.e. no Date.now leaked into the accumulator.
    const durations = m.getDurations()
    expect(durations).toHaveLength(1000)
    expect(durations[0]).toBe(0)
    expect(durations[999]).toBe(999)
    expect(m.getTransitionCount()).toBe(1000)
    expect(m.getFailureCount()).toBe(0)
  })

  it('counts failures and errors separately', () => {
    const m = new SimMonitor()
    m.recordTransition(1, false)
    m.recordError(new Error('x'))
    expect(m.getTransitionCount()).toBe(0)
    expect(m.getFailureCount()).toBe(1)
    expect(m.getErrorCount()).toBe(1)
  })
})

describe('Step 2 — SimErrorHandler (ADR-3 c4)', () => {
  // DoD#4: six-method conformance.
  it('conforms to IErrorHandler (six methods)', () => {
    const h: IErrorHandler = new SimErrorHandler()
    expect(typeof h.isEnabled).toBe('function')
    expect(typeof h.enable).toBe('function')
    expect(typeof h.disable).toBe('function')
    expect(typeof h.addRecoveryStrategy).toBe('function')
    expect(typeof h.removeRecoveryStrategy).toBe('function')
    expect(typeof h.getAnalytics).toBe('function')
  })

  // DoD#3: isEnabled() pinned true through disable() then enable().
  it('isEnabled() stays pinned true through disable() then enable()', () => {
    const h = new SimErrorHandler()
    expect(h.isEnabled()).toBe(true)
    h.disable()
    expect(h.isEnabled()).toBe(true)
    h.enable()
    expect(h.isEnabled()).toBe(true)
  })

  // DoD#4: grep ZERO RetryRecoveryStrategy / setTimeout.
  it('source registers no RetryRecoveryStrategy / setTimeout (grep gate)', () => {
    const src = simSource('sim-error-handler.ts')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/RetryRecoveryStrategy/)
    expect(code).not.toMatch(/setTimeout/)
  })

  // DoD#4: getAnalytics() returns a frozen ErrorAnalytics whose getErrorStats()
  // deep-equals across two calls BECAUSE no error was ever fed; AND the harness
  // never calls recordError on it.
  it('getAnalytics() is frozen, never-fed, and deep-equal across calls', () => {
    const h = new SimErrorHandler()
    const a = h.getAnalytics()
    expect(Object.isFrozen(a)).toBe(true)
    // never-fed: getErrorStats returns the constant zero-state, deep-equal twice
    // (despite getErrorStats reading Date.now internally — empty set => constant).
    const s1 = a.getErrorStats()
    const s2 = a.getErrorStats()
    expect(s1).toEqual(s2)
    expect(s1.total).toBe(0)
    expect(s1.recentErrors).toBe(0)
    // DoD assertion: the harness never invokes recordError on this instance.
    // The seam exposes NO path to feed it (SimErrorHandler stores no error and
    // never calls analytics.recordError); we assert the count stays zero across
    // the handler's own lifecycle methods.
    h.disable()
    h.enable()
    h.addRecoveryStrategy({ name: 'x', canRecover: () => false, recover: async () => undefined } as never)
    h.removeRecoveryStrategy('x')
    expect(h.getAnalytics().getErrorStats().total).toBe(0)
  })
})

describe('Step 2 — NoopLogger (ADR-3 E)', () => {
  // DoD#5: conforms to ILogger; all four methods return undefined, no side
  // effect; grep ZERO Date.now / console.
  it('conforms to ILogger and every method is a side-effect-free undefined-returner', () => {
    const l: ILogger = NoopLogger
    expect(l.debug('m')).toBeUndefined()
    expect(l.info('m', {})).toBeUndefined()
    expect(l.warn('m', {}, new Error('e'))).toBeUndefined()
    expect(l.error('m', {}, new Error('e'))).toBeUndefined()
  })

  it('is a frozen singleton', () => {
    expect(Object.isFrozen(NoopLogger)).toBe(true)
  })

  it('source has ZERO Date.now / console (grep gate)', () => {
    const src = simSource('noop-logger.ts')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/Date\.now/)
    expect(code).not.toMatch(/console/)
  })
})

// DoD#10: all four production files import engine symbols ONLY from ../index.
describe('Step 2 — ../index-only import discipline (grep gate)', () => {
  const files = ['sim-monitor.ts', 'sim-error-handler.ts', 'noop-logger.ts', 'capture.ts']
  for (const f of files) {
    it(`${f} imports engine symbols only via ../index`, () => {
      const src = simSource(f)
      // any `from '../<core-module>'` other than ../index is forbidden.
      const forbidden = [
        "from '../state_machine'",
        "from '../monitoring'",
        "from '../error_handling'",
        "from '../types'",
        "from '../logger'",
        "from '../scheduler'",
        "from '../config_validator'",
      ]
      for (const pat of forbidden) {
        expect(src.includes(pat), `${f} must not contain: ${pat}`).toBe(false)
      }
      // and it DOES import from ../index
      expect(src).toMatch(/from '\.\.\/index'/)
    })
  }
})

// DoD: a real StateMachine constructs + transitions with the five Sim seams
// under TWO arms — one with vi.useFakeTimers()+vi.setSystemTime() active and one
// default (real Date). Mirrors Step-3 AC-1 structure.
interface Box {
  state: string
  count: number
}
function twoStateConfig(): StateMachineConfig<Box> {
  return {
    name: 'TwoState',
    stateAttribute: 'state',
    initialState: 'a',
    states: {
      a: {},
      b: { onEnter: (o: Box) => { o.count += 1 } },
    },
    events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
  }
}

async function runFiveSeamArm(): Promise<{ finalState: string; count: number; transitions: number }> {
  const owner = new MemoryAdapter<Box>({ state: '', count: 0 })
  const monitor = new SimMonitor()
  const errorHandler = new SimErrorHandler()
  let t = 0
  const clock = () => t
  const scheduler = createVirtualScheduler(clock)
  const sm = new StateMachine(twoStateConfig(), owner, {
    clock,
    scheduler,
    monitor,
    errorHandler,
    logger: NoopLogger,
  })
  await Promise.resolve()
  await sm.fireEvent('go')
  await Promise.resolve()
  void t
  return {
    finalState: sm.getCurrentState() ?? '',
    count: owner.get('count') as number,
    transitions: monitor.getTransitionCount(),
  }
}

describe('Step 2 — real StateMachine with the five Sim seams (two arms)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('constructs + transitions under default real-Date timers', async () => {
    const r = await runFiveSeamArm()
    expect(r.finalState).toBe('b')
    expect(r.count).toBe(1)
    expect(r.transitions).toBeGreaterThanOrEqual(1)
  })

  it('constructs + transitions under vi.useFakeTimers()+setSystemTime', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2020-01-01T00:00:00Z'))
    const r = await runFiveSeamArm()
    expect(r.finalState).toBe('b')
    expect(r.count).toBe(1)
    expect(r.transitions).toBeGreaterThanOrEqual(1)
  })
})
