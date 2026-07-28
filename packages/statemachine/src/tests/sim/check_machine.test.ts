/**
 * @module tests/sim/check_machine — the consumer-facing `checkMachine` facade
 * (W6 / #17). Each `describe` pins one row of MASTER §2.4 "how the contract makes
 * a sim-audit finding UNEXPRESSIBLE".
 */
import { describe, expect, it } from 'vitest'
import { checkMachine } from '../../sim/check-machine'
import type { CheckOptions } from '../../sim/check-machine'

type Box = { state: string; [k: string]: unknown }

// A correct, terminating machine (the happy baseline).
const okCfg = {
  name: 'ok',
  stateAttribute: 'state',
  initialState: 's1',
  states: { s1: {}, s2: {}, s3: { final: true } },
  events: { go1: { transitions: [{ from: 's1', to: 's2' }] }, go2: { transitions: [{ from: 's2', to: 's3' }] } },
}
const okOwner = (): Box => ({ state: 's1' })
const fast: CheckOptions<Box> = { seed: '1', steps: 16, runs: 4 }

describe('checkMachine §2.4: A2 fail-open is unexpressible', () => {
  it('a correct machine → ok:true with oraclesRun>0 AND transitionsFired>0 (no green over zero oracles / a motionless machine)', async () => {
    const r = await checkMachine(okCfg, okOwner, fast)
    expect(r.ok).toBe(true)
    expect(r.oraclesRun).toBeGreaterThan(0)
    expect(r.transitionsFired).toBeGreaterThan(0)
    expect(r.failedOn).toEqual([])
  })

  it('ok===true IMPLIES oraclesRun>0 ∧ transitionsFired>0 (the two contract invariants)', async () => {
    const r = await checkMachine(okCfg, okOwner, fast)
    if (r.ok) {
      expect(r.oraclesRun).toBeGreaterThan(0)
      expect(r.transitionsFired).toBeGreaterThan(0)
    }
  })

  it('a MOTIONLESS machine (every guard blocks) → transitionsFired===0 → no-progress → ok:false', async () => {
    const frozen = {
      name: 'frozen',
      stateAttribute: 'state',
      initialState: 'a',
      states: { a: {}, b: {} },
      events: { go: { transitions: [{ from: 'a', to: 'b', guard: () => false }] } },
    }
    const r = await checkMachine<Box>(frozen, () => ({ state: 'a' }), fast)
    expect(r.transitionsFired).toBe(0)
    expect(r.ok).toBe(false)
    expect(r.failedOn).toContain('no-progress')
  })
})

describe('checkMachine §2.4: A4 liveness is a headline', () => {
  it('an A<->B livelock → livelocks[] populated and ok:false', async () => {
    const pingpong = {
      name: 'pp',
      stateAttribute: 'state',
      initialState: 'A',
      states: { A: {}, B: {} },
      events: { t: { transitions: [{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }] } },
    }
    const r = await checkMachine<Box>(pingpong, () => ({ state: 'A' }), { seed: '1', steps: 12, runs: 3, mode: 'both' })
    expect(r.livelocks.length).toBeGreaterThan(0)
    expect(r.ok).toBe(false)
    expect(r.failedOn).toContain('livelock')
  })
})

describe('checkMachine §2.4: F7 — a throw in a user invariant is a violation, not swallowed', () => {
  it('a user MachineInvariant returning false → violation kind:user, ok:false', async () => {
    const r = await checkMachine<Box>(okCfg, okOwner, {
      ...fast,
      runs: 2,
      invariants: [{ name: 'never-in-s2', check: (s) => !s.state.endsWith('s2') }],
    })
    expect(r.violations.some((v) => v.invariant === 'never-in-s2' && v.kind === 'user')).toBe(true)
    expect(r.ok).toBe(false)
    expect(r.failedOn).toContain('violation')
  })

  it('a user MachineInvariant that THROWS is treated as a violation (never swallowed)', async () => {
    const r = await checkMachine<Box>(okCfg, okOwner, {
      ...fast,
      runs: 2,
      invariants: [{ name: 'throws', check: (s) => { if (s.state.endsWith('s2')) throw new Error('boom'); return true } }],
    })
    expect(r.violations.some((v) => v.invariant === 'throws' && v.kind === 'user')).toBe(true)
    expect(r.ok).toBe(false)
  })

  it('a user invariant sees the LIVE owner data (not just the state name)', async () => {
    // The machine mutates owner.count via an action; the invariant asserts on it.
    const counting = {
      name: 'count',
      stateAttribute: 'state',
      initialState: 's1',
      states: { s1: {}, s2: { final: true } },
      events: { go: { transitions: [{ from: 's1', to: 's2', action: (o: Box) => { o.count = ((o.count as number) ?? 0) + 1 } }] } },
    }
    let sawData = false
    await checkMachine<Box>(counting, () => ({ state: 's1', count: 0 }), {
      ...fast,
      runs: 1,
      invariants: [{ name: 'observe-data', check: (s) => { if ('count' in s.data) sawData = true; return true } }],
    })
    expect(sawData).toBe(true)
  })
})

describe('checkMachine: run independence + determinism', () => {
  it('runs>1 with a LIVE owner (not a factory) throws — run independence is enforced', async () => {
    await expect(checkMachine<Box>(okCfg, { state: 's1' }, { runs: 2 })).rejects.toThrow(/factory/i)
  })

  it('runs===1 accepts a live owner', async () => {
    const r = await checkMachine<Box>(okCfg, { state: 's1' }, { seed: '1', steps: 16, runs: 1 })
    expect(r.runs).toBe(1)
  })

  it('the same seed produces a byte-identical report (deterministic)', async () => {
    const a = await checkMachine(okCfg, okOwner, { seed: '42', steps: 16, runs: 3 })
    const b = await checkMachine(okCfg, okOwner, { seed: '42', steps: 16, runs: 3 })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('checkMachine: coverage findings', () => {
  it('an unreachable island state is REPORTED (not a fail — may be dead-by-design)', async () => {
    const island = {
      name: 'island',
      stateAttribute: 'state',
      initialState: 'a',
      states: { a: {}, b: { final: true }, lonely: {} },
      events: { go: { transitions: [{ from: 'a', to: 'b' }] }, back: { transitions: [{ from: 'lonely', to: 'a' }] } },
    }
    const r = await checkMachine<Box>(island, () => ({ state: 'a' }), fast)
    expect(r.unreachableStates).toContain('lonely')
    // unreachable alone does NOT fail the verdict.
    expect(r.failedOn).not.toContain('deadlock') // (b is final, lonely unreached)
  })

  it('a non-final dead-end state is a DEADLOCK and fails the verdict', async () => {
    const deadend = {
      name: 'deadend',
      stateAttribute: 'state',
      initialState: 'a',
      states: { a: {}, stuck: {} }, // stuck is NOT final and has no outgoing
      events: { go: { transitions: [{ from: 'a', to: 'stuck' }] } },
    }
    const r = await checkMachine<Box>(deadend, () => ({ state: 'a' }), fast)
    expect(r.deadlocks.some((d) => d.state === 'stuck')).toBe(true)
    expect(r.ok).toBe(false)
    expect(r.failedOn).toContain('deadlock')
  })

  it('a dead event that never fires at a coverage PLATEAU is a degradation fail', async () => {
    const withDead = {
      name: 'withDead',
      stateAttribute: 'state',
      initialState: 'a',
      states: { a: {}, b: { final: true }, orphan: {} },
      events: { go: { transitions: [{ from: 'a', to: 'b' }] }, unreachableEvt: { transitions: [{ from: 'orphan', to: 'a' }] } },
    }
    const r = await checkMachine<Box>(withDead, () => ({ state: 'a' }), { seed: '1', steps: 16, runs: 6 })
    expect(r.deadEvents).toContain('unreachableEvt')
    // at plateau the dead event becomes a degradation cause.
    if (r.saturation.plateauedAtRun !== null) {
      expect(r.failedOn).toContain('degradation')
    }
  })

  it("the advisory 'no-payload' warning is present but does NOT by itself fail a correct machine", async () => {
    const r = await checkMachine(okCfg, okOwner, fast)
    expect(r.warnings.some((w) => w.kind === 'no-payload')).toBe(true)
    expect(r.ok).toBe(true)
    expect(r.failedOn).not.toContain('degradation')
  })
})

describe('checkMachine: critic-hardening (the A2 contract is UNCONDITIONAL)', () => {
  it('F1: failOn:[] does NOT bypass the A2/A4 hard floors — a motionless machine still fails', async () => {
    const frozen = {
      name: 'frozen',
      stateAttribute: 'state',
      initialState: 'a',
      states: { a: {}, b: {} },
      events: { go: { transitions: [{ from: 'a', to: 'b', guard: () => false }] } },
    }
    const r = await checkMachine<Box>(frozen, () => ({ state: 'a' }), { ...fast, failOn: [] })
    expect(r.transitionsFired).toBe(0)
    expect(r.ok).toBe(false) // no-progress is a HARD floor, not gated by failOn
    expect(r.failedOn).toContain('no-progress')
  })

  it('F1: failOn:[] does NOT bypass a user-invariant violation (hard floor)', async () => {
    const r = await checkMachine<Box>(okCfg, okOwner, {
      ...fast,
      runs: 2,
      failOn: [],
      invariants: [{ name: 'always-false', check: () => false }],
    })
    expect(r.ok).toBe(false)
    expect(r.failedOn).toContain('violation')
  })

  it('F3: a state that exits only via a WILDCARD transition is NOT a false deadlock', async () => {
    const wild = {
      name: 'wild',
      stateAttribute: 'state',
      initialState: 'a',
      states: { a: {}, b: {}, c: { final: true } },
      events: {
        go: { transitions: [{ from: 'a', to: 'b' }] },
        anywhere: { transitions: [{ from: '*', to: 'c' }] }, // b exits via wildcard
      },
    }
    const r = await checkMachine<Box>(wild, () => ({ state: 'a' }), fast)
    expect(r.deadlocks.map((d) => d.state)).not.toContain('b')
  })

  it('F3: a declared self-loop does not produce a false uncovered-transition degradation', async () => {
    const selfloop = {
      name: 'sl',
      stateAttribute: 'state',
      initialState: 's1',
      states: { s1: {}, s2: { final: true } },
      events: { ping: { transitions: [{ from: 's1', to: 's1' }] }, done: { transitions: [{ from: 's1', to: 's2' }] } },
    }
    const r = await checkMachine<Box>(selfloop, () => ({ state: 's1' }), { seed: '1', steps: 16, runs: 6 })
    // 'ping' is a self-loop that DOES fire; it must not linger as an uncovered
    // transition that turns into a degradation fail.
    expect(r.uncoveredTransitions.some((t) => t.event === 'ping')).toBe(false)
  })
})

describe('checkMachine: violations carry engine/user routing + reproCode', () => {
  it('a violation carries a reproCode snippet referencing the seed', async () => {
    const r = await checkMachine<Box>(okCfg, okOwner, {
      ...fast,
      runs: 1,
      invariants: [{ name: 'always-false', check: () => false }],
    })
    const v = r.violations.find((x) => x.invariant === 'always-false')
    expect(v).toBeDefined()
    expect(v?.reproCode).toContain('checkMachine')
    expect(v?.reproCode).toContain(r.seed)
  })
})
