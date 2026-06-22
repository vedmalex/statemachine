import { describe, expect, it } from 'vitest'
import {
  type FaultSchedule,
  PERTURB_ONLY_FAULTS,
  PROGRESS_BLOCKING_FAULTS,
  isProgressBlocking,
  makeFaultSchedule,
  suppressesStuck,
} from '../../sim/fairness'
import {
  type LivenessParams,
  type LivenessSample,
  analyzeLiveness,
  classifyQuiescence,
  fingerprintOf,
  fingerprintsEqual,
} from '../../sim/liveness'

/** Build a liveness sample with sensible defaults. */
function sample(over: Partial<LivenessSample> = {}): LivenessSample {
  return {
    config: 'a',
    queueDepth: 0,
    pendingTimers: 0,
    earliestTimerAt: null,
    configChanged: true,
    healthy: true,
    inFlight: false,
    terminal: false,
    t: 0,
    ...over,
  }
}

const PARAMS: LivenessParams = { stateCount: 3, budgetVirtualMs: 1000 }

// ── DoD 6: fire-boolean demotion + cycle detector (K = states.length + 1) ─────

describe('liveness fire-boolean demotion (DoD 6)', () => {
  it('resolve-false + unchanged + healthy ⇒ QUIESCENT_NO_WORK (guard-block, PROGRESSED)', () => {
    const r = analyzeLiveness(
      [sample({ fireOutcome: 'resolve-false', configChanged: false, healthy: true })],
      PARAMS,
    )
    expect(r.verdict).toBe('PROGRESSED')
    expect(r.quiescence).toBe('QUIESCENT_NO_WORK')
  })

  it('resolve-true + unchanged config ⇒ STUCK (self-loop with no progress)', () => {
    const r = analyzeLiveness(
      [sample({ fireOutcome: 'resolve-true', configChanged: false, healthy: true })],
      PARAMS,
    )
    expect(r.verdict).toBe('STUCK')
    expect(r.reason).toMatch(/self-loop/)
  })

  it('A→B→A within the healthy window ⇒ STUCK "configuration cycle" via K = states.length + 1', () => {
    // states.length 3 → K = 4. The fingerprint for config 'A' recurs at idx 2
    // (within K of idx 0) with resolve-true still firing and no terminal → cycle.
    const samples = [
      sample({ config: 'A', fireOutcome: 'resolve-true', configChanged: true }),
      sample({ config: 'B', fireOutcome: 'resolve-true', configChanged: true }),
      sample({ config: 'A', fireOutcome: 'resolve-true', configChanged: true }),
    ]
    const r = analyzeLiveness(samples, PARAMS)
    expect(r.verdict).toBe('STUCK')
    expect(r.reason).toBe('configuration cycle')
    expect(r.witness).toBe('A')
  })

  it('a reject is routed distinctly and never counts as progress (no crash)', () => {
    const r = analyzeLiveness([sample({ fireOutcome: 'reject', configChanged: false })], PARAMS)
    // A reject neither progresses nor is a self-loop STUCK (only resolve-true is).
    expect(r.verdict).toBe('PROGRESSED')
  })
})

// ── DoD 7: fairness suppression — drop-heavy seed not falsely STUCK while unhealthy ─

describe('fairness suppression + healing (DoD 7)', () => {
  it('a drop-heavy run is NOT a false STUCK while isHealthyAt===false', () => {
    // Unhealthy samples with resolve-true + unchanged config would be STUCK if
    // evaluated, but the fairness gate (healthy:false) suppresses it.
    const samples = [
      sample({ config: 'A', fireOutcome: 'resolve-true', configChanged: false, healthy: false, t: 0 }),
      sample({ config: 'A', fireOutcome: 'resolve-true', configChanged: false, healthy: false, t: 1 }),
    ]
    const r = analyzeLiveness(samples, PARAMS)
    expect(r.verdict).not.toBe('STUCK')
  })

  it('after healAtVirtualMs the machine reaches PROGRESSED / TERMINAL_FINAL', () => {
    const samples = [
      sample({ config: 'A', fireOutcome: 'resolve-true', configChanged: false, healthy: false, t: 0 }),
      sample({ config: 'B', fireOutcome: 'resolve-true', configChanged: true, healthy: true, terminal: true, t: 10 }),
    ]
    const r = analyzeLiveness(samples, PARAMS)
    expect(r.verdict).toBe('PROGRESSED')
    expect(r.quiescence).toBe('TERMINAL_FINAL')
  })

  it('FaultSchedule.isHealthyAt + suppressesStuck gate STUCK by virtual time', () => {
    const sched: FaultSchedule = makeFaultSchedule({
      healAtVirtualMs: 50,
      budgetVirtualMs: 200,
      longestArmedChainMs: 100,
    })
    expect(sched.isHealthyAt(0)).toBe(false)
    expect(sched.isHealthyAt(50)).toBe(true)
    expect(suppressesStuck(sched, 0)).toBe(true)
    expect(suppressesStuck(sched, 60)).toBe(false)
  })

  it('progress-blocking vs perturb-only fault classification', () => {
    expect(isProgressBlocking('drop')).toBe(true)
    expect(isProgressBlocking('throw')).toBe(true)
    expect(isProgressBlocking('overflow')).toBe(true)
    expect(isProgressBlocking('corrupt-state')).toBe(true)
    expect(isProgressBlocking('reorder')).toBe(false)
    expect(isProgressBlocking('dup')).toBe(false)
    expect(isProgressBlocking('timer-jitter')).toBe(false)
    expect(PROGRESS_BLOCKING_FAULTS.has('drop')).toBe(true)
    expect(PERTURB_ONLY_FAULTS.has('reorder')).toBe(true)
  })

  it('makeFaultSchedule validates heal < budget and budget dominates the armed chain', () => {
    expect(() =>
      makeFaultSchedule({ healAtVirtualMs: 200, budgetVirtualMs: 100, longestArmedChainMs: 10 }),
    ).toThrow(/must be </)
    expect(() =>
      makeFaultSchedule({ healAtVirtualMs: 10, budgetVirtualMs: 50, longestArmedChainMs: 100 }),
    ).toThrow(/must dominate/)
  })
})

// ── DoD 8: WAITING_ON_TRANSITION_TIMEOUT unwedged by liveness, never false STUCK ─

describe('five-kind quiescence classifier (DoD 8)', () => {
  it('classifies TERMINAL_FINAL / QUIESCENT_NO_WORK / WAITING_ON_TIMER / WAITING_ON_TRANSITION_TIMEOUT / ACTIVE', () => {
    expect(classifyQuiescence(sample({ terminal: true }))).toBe('TERMINAL_FINAL')
    expect(classifyQuiescence(sample({ queueDepth: 0, pendingTimers: 0, inFlight: false }))).toBe('QUIESCENT_NO_WORK')
    expect(classifyQuiescence(sample({ queueDepth: 0, pendingTimers: 1, inFlight: false }))).toBe('WAITING_ON_TIMER')
    expect(classifyQuiescence(sample({ queueDepth: 1, inFlight: true, waitingOnTransitionTimeout: true }))).toBe(
      'WAITING_ON_TRANSITION_TIMEOUT',
    )
    expect(classifyQuiescence(sample({ queueDepth: 2 }))).toBe('ACTIVE')
  })

  it('a WAITING_ON_TRANSITION_TIMEOUT in-flight sample is NOT a false STUCK (liveness jumps the clock)', () => {
    // The in-flight transition awaiting a not-yet-due transitionTimeout is unwedged
    // by policy='liveness' (the settle jumps the clock). A subsequent settled sample
    // shows PROGRESSED — never STUCK.
    const samples = [
      sample({ config: 'A', queueDepth: 1, inFlight: true, waitingOnTransitionTimeout: true, configChanged: false, t: 0 }),
      sample({ config: 'B', queueDepth: 0, inFlight: false, configChanged: true, terminal: true, t: 5 }),
    ]
    const r = analyzeLiveness(samples, PARAMS)
    expect(r.verdict).toBe('PROGRESSED')
  })
})

// ── budget overruns surface as TIMEOUT_BUDGET_EXCEEDED (never throw) ───────────

describe('liveness budget findings', () => {
  it('settleMacrostep microtask-budget exhaustion surfaces as TIMEOUT_BUDGET_EXCEEDED', () => {
    const r = analyzeLiveness([sample({})], { ...PARAMS, microtaskBudgetExhausted: true })
    expect(r.verdict).toBe('TIMEOUT_BUDGET_EXCEEDED')
    expect(r.reason).toMatch(/microtask-budget/)
  })

  it('a virtual-time budget overrun surfaces as TIMEOUT_BUDGET_EXCEEDED', () => {
    const r = analyzeLiveness([sample({ t: 5000 })], PARAMS)
    expect(r.verdict).toBe('TIMEOUT_BUDGET_EXCEEDED')
    expect(r.reason).toMatch(/exceeded budget/)
  })
})

// ── DoD 9: liveness.ts/fairness.ts purity + opaque-async-in-flight ────────────

describe('liveness opaque-async-in-flight + fingerprint (DoD 9)', () => {
  it('an opaque async in-flight sample yields no false STUCK / PROGRESSED until inFlight clears', () => {
    // While inFlight is true the quiescence is ACTIVE (not terminal/idle); once it
    // clears AND config progressed the verdict is PROGRESSED.
    const inFlight = sample({ config: 'A', inFlight: true, queueDepth: 0, configChanged: false, fireOutcome: undefined })
    expect(classifyQuiescence(inFlight)).toBe('ACTIVE')
    const settled = sample({ config: 'B', inFlight: false, configChanged: true, terminal: true, t: 3 })
    const r = analyzeLiveness([inFlight, settled], PARAMS)
    expect(r.verdict).toBe('PROGRESSED')
  })

  it('fingerprintOf normalizes config; fingerprintsEqual compares all four fields', () => {
    const a = fingerprintOf(sample({ config: 'b|a', queueDepth: 1, pendingTimers: 2, earliestTimerAt: 5 }))
    expect(a.config).toBe('a|b')
    const b = fingerprintOf(sample({ config: 'a|b', queueDepth: 1, pendingTimers: 2, earliestTimerAt: 5 }))
    expect(fingerprintsEqual(a, b)).toBe(true)
    const c = fingerprintOf(sample({ config: 'a|b', queueDepth: 1, pendingTimers: 2, earliestTimerAt: 6 }))
    expect(fingerprintsEqual(a, c)).toBe(false)
  })
})
