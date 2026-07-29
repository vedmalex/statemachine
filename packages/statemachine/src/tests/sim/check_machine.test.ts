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

  it('reproCode is the FULL seed-pinned run, NOT a shrunk repro (the documented honest no-op)', async () => {
    // W8/V7: `sim/shrinker.ts` reduces a ScenarioSpec against a builtin-oracle
    // fingerprint; a checkMachine finding is a LIVE config + a consumer predicate
    // with no fingerprint. Rather than fabricate an UNVERIFIED "minimal" repro,
    // the snippet stays the full run — pinned so it is bit-reproducible. This
    // test pins that contract so a future "minimization" cannot land silently.
    const r = await checkMachine<Box>(okCfg, okOwner, {
      seed: '7',
      steps: 23,
      runs: 1,
      invariants: [{ name: 'always-false', check: () => false }],
    })
    const v = r.violations.find((x) => x.invariant === 'always-false' && !x.witness.includes('initial'))
    expect(v?.reproCode).toContain('steps: 23') // the ORIGINAL budget, unshrunk
    expect(v?.reproCode).toContain('runs: 1') // replayable in isolation
  })
})

// ── W8/V7: the four reserved report fields ──────────────────────────────────

describe('checkMachine §13.1: guardOutcomes (guard coverage)', () => {
  const guarded = {
    name: 'guarded',
    stateAttribute: 'state',
    initialState: 'a',
    states: { a: {}, b: {}, c: { final: true }, island: {} },
    events: {
      live: { transitions: [{ from: 'a', to: 'b', guard: () => true }] },
      dead: { transitions: [{ from: 'b', to: 'c', guard: () => false }] },
      // 'island' is never reached, so this guard is never EVALUATED at all.
      unreached: { transitions: [{ from: 'island', to: 'a', guard: () => true }] },
    },
  }

  it('a guard that NEVER returns true is reported with sawTrue:false (the dead-branch bug)', async () => {
    const r = await checkMachine<Box>(guarded, () => ({ state: 'a' }), { seed: '1', steps: 16, runs: 6 })
    const dead = r.guardOutcomes.find((g) => g.transition === 'b -> c')
    expect(dead).toEqual({ transition: 'b -> c', sawTrue: false, sawFalse: true })
  })

  it('a guard that DOES admit its transition is reported with sawTrue:true', async () => {
    const r = await checkMachine<Box>(guarded, () => ({ state: 'a' }), { seed: '1', steps: 16, runs: 6 })
    expect(r.guardOutcomes.find((g) => g.transition === 'a -> b')?.sawTrue).toBe(true)
  })

  it('a guard that was NEVER EVALUATED is still listed (seeded from the config, not the trace)', async () => {
    const r = await checkMachine<Box>(guarded, () => ({ state: 'a' }), { seed: '1', steps: 16, runs: 6 })
    // Absence would be indistinguishable from "there is no such guard" — the one
    // thing a coverage report must never do.
    expect(r.guardOutcomes.find((g) => g.transition === 'island -> a')).toEqual({
      transition: 'island -> a',
      sawTrue: false,
      sawFalse: false,
    })
  })

  it('a STRING-METHOD invoke machine still converges once the lifecycle channel is subscribed', async () => {
    // guardOutcomes subscribes to `IMonitor.recordLifecycle`, a slot `SimMonitor`
    // ALREADY owns (it feeds the I-4 hierarchy-order oracle and the ISS-030
    // `invoke.action` in-flight counter the settle predicate reads), so
    // check-machine.ts DECORATES rather than replaces it.
    //
    // HONEST SCOPE: this is a SMOKE test for the string-method invoke path under
    // `checkMachine`, NOT a guard on the decoration — the harness sink's effects
    // are not observable through `CheckReport`, and a clobbering implementation
    // passes this test too (verified). The real guard on the decoration is the
    // `decorateLifecycle` unit test below, which observes BOTH receivers directly.
    // (`oracle_self_test` does NOT cover it: it drives `runSimulation` and never
    // executes checkMachine's subscription site.)
    const strInvoke = {
      name: 'strInvoke',
      stateAttribute: 'state',
      initialState: 'working',
      states: {
        working: { invoke: [{ delay: 0, event: 'ping', action: 'doWork' }] },
        done: { final: true },
      },
      events: { ping: { transitions: [{ from: 'working', to: 'done' }] } },
    }
    const r = await checkMachine<Box>(
      strInvoke,
      () => ({
        state: 'working',
        // Genuinely async: suspends across several microtasks.
        doWork: async () => {
          await Promise.resolve()
          await Promise.resolve()
        },
      }),
      // 'ping' is raised INTERNALLY by the invoke, so it reads as a dead event —
      // relaxed here so the assertion is about the invoke path, not coverage.
      { seed: '1', steps: 12, runs: 3, mode: 'both', degradationExcept: ['dead-events-at-plateau'] },
    )
    expect(r.reachableStates).toContain('done')
    expect(r.livelocks).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('a machine with NO guards reports an empty guardOutcomes (no phantom rows)', async () => {
    const r = await checkMachine(okCfg, okOwner, fast)
    expect(r.guardOutcomes).toEqual([])
  })

  it('a plateau-proven dead guard warns but is ADVISORY — it does not fail a correct machine', async () => {
    // The dead guard is the ONLY plateau finding here: every declared event
    // fires (the guarded branch loses to a sibling transition on the same
    // event), so no 'dead-events-at-plateau' degradation can contaminate the
    // assertion.
    const onlyDeadGuard = {
      name: 'onlyDeadGuard',
      stateAttribute: 'state',
      initialState: 'a',
      states: { a: {}, b: {}, c: { final: true } },
      events: {
        go: { transitions: [{ from: 'a', to: 'c', guard: () => false }, { from: 'a', to: 'b' }] },
        next: { transitions: [{ from: 'b', to: 'c' }] },
      },
    }
    const r = await checkMachine<Box>(onlyDeadGuard, () => ({ state: 'a' }), { seed: '1', steps: 16, runs: 6 })
    expect(r.deadEvents).toEqual([])
    expect(r.guardOutcomes.find((g) => g.transition === 'a -> c')?.sawTrue).toBe(false)
    expect(r.warnings.some((w) => w.kind === 'dead-guard-at-plateau')).toBe(true)
    // The `true` branch of a guard routinely needs a payload the fuzzer cannot
    // synthesize, so this must NOT be a degradation cause (same reasoning that
    // demoted 'uncovered-at-plateau'). Assert on `guardOutcomes` to break a build.
    expect(r.failedOn).not.toContain('degradation')
  })
})

describe("checkMachine: nonConvergingRegions revives the dead 'non-converging' cause", () => {
  // r2 declares NO final sub-state at all, yet the composite is joined via
  // done.state.p — the join can NEVER fire. Provable from the config alone.
  const structural = {
    name: 'structural',
    stateAttribute: 'state',
    initialState: 'p',
    states: {
      p: { regions: { r1: { x: {}, xf: { final: true } }, r2: { y: {} } } },
      after: { final: true },
    },
    events: {
      go1: { transitions: [{ from: 'p.r1.x', to: 'p.r1.xf' }] },
      'done.state.p': { transitions: [{ from: 'p', to: 'after' }] },
    },
  }

  it('a region with no final sub-state under a done.state join is STRUCTURALLY non-converging', async () => {
    const r = await checkMachine<Box>(structural, () => ({ state: 'p' }), { seed: '1', steps: 16, runs: 4 })
    expect(r.nonConvergingRegions).toContainEqual({ composite: 'p', region: 'p.r2' })
    expect(r.failedOn).toContain('non-converging')
    expect(r.ok).toBe(false)
    expect(r.warnings.some((w) => w.kind === 'non-converging-region')).toBe(true)
  })

  it("'non-converging' is failOn-GATED, not a hard floor (the dynamic half is fuzzer-relative)", async () => {
    const r = await checkMachine<Box>(structural, () => ({ state: 'p' }), {
      seed: '1',
      steps: 16,
      runs: 4,
      failOn: [],
    })
    // The FINDING is still reported — only the verdict is relaxed.
    expect(r.nonConvergingRegions).toContainEqual({ composite: 'p', region: 'p.r2' })
    expect(r.failedOn).not.toContain('non-converging')
  })

  it('a region whose final sub-state is never reached at a PLATEAU is non-converging', async () => {
    const dynamic = {
      name: 'dynamic',
      stateAttribute: 'state',
      initialState: 'p',
      states: {
        p: { regions: { r1: { x: {}, xf: { final: true } }, r2: { y: {}, yf: { final: true } } } },
      },
      events: {
        go1: { transitions: [{ from: 'p.r1.x', to: 'p.r1.xf' }] },
        go2: { transitions: [{ from: 'p.r2.y', to: 'p.r2.yf', guard: () => false }] }, // never admitted
      },
    }
    const r = await checkMachine<Box>(dynamic, () => ({ state: 'p' }), { seed: '1', steps: 16, runs: 6 })
    expect(r.saturation.plateauedAtRun).not.toBeNull()
    expect(r.nonConvergingRegions).toContainEqual({ composite: 'p', region: 'p.r2' })
    // r1 DID converge — it must not be swept in with its sibling.
    expect(r.nonConvergingRegions.some((n) => n.region === 'p.r1')).toBe(false)
  })

  it('a CONVERGING parallel machine reports NOTHING (a false finding is worse than a missing one)', async () => {
    const converging = {
      name: 'converging',
      stateAttribute: 'state',
      initialState: 'p',
      states: {
        p: { regions: { r1: { x: {}, xf: { final: true } }, r2: { y: {}, yf: { final: true } } } },
        after: { final: true },
      },
      events: {
        go1: { transitions: [{ from: 'p.r1.x', to: 'p.r1.xf' }] },
        go2: { transitions: [{ from: 'p.r2.y', to: 'p.r2.yf' }] },
        'done.state.p': { transitions: [{ from: 'p', to: 'after' }] },
      },
    }
    const r = await checkMachine<Box>(converging, () => ({ state: 'p' }), { seed: '1', steps: 24, runs: 6 })
    expect(r.nonConvergingRegions).toEqual([])
    expect(r.failedOn).not.toContain('non-converging')
  })

  it('a FLAT machine has no regions and therefore no non-converging findings', async () => {
    const r = await checkMachine(okCfg, okOwner, fast)
    expect(r.nonConvergingRegions).toEqual([])
  })
})

describe('checkMachine: user invariants are evaluated on the INITIAL configuration', () => {
  // The consumer's machine STARTS in a state their invariant forbids. Before
  // W8/V7 this was invisible: the driver never routes its `cause:'init'` frames
  // through onTrace, so the post-construction configuration was never checked.
  const startsBad = { state: 's1', retries: 5 }
  const retriesInvariant = {
    name: 'retries<=3',
    check: (s: { data: Record<string, unknown> }) => ((s.data['retries'] as number) ?? 0) <= 3,
  }

  it('an invariant violated ON ARRIVAL is a violation, tagged as the initial configuration', async () => {
    const r = await checkMachine<Box>(okCfg, () => ({ ...startsBad }), {
      ...fast,
      invariants: [retriesInvariant],
    })
    const init = r.violations.find((v) => v.witness.includes('(initial configuration)'))
    expect(init).toBeDefined()
    expect(init?.invariant).toBe('retries<=3')
    expect(init?.kind).toBe('user')
    expect(r.ok).toBe(false)
    expect(r.failedOn).toContain('violation')
  })

  it('the initial-configuration pass runs EXACTLY ONCE, not once per run (no double-count)', async () => {
    const r = await checkMachine<Box>(okCfg, () => ({ ...startsBad }), {
      seed: '1',
      steps: 16,
      runs: 5,
      invariants: [retriesInvariant],
    })
    // init is seed-independent, so N runs would be N copies of ONE defect.
    expect(r.violations.filter((v) => v.witness.includes('(initial configuration)'))).toHaveLength(1)
  })

  it('an enter action that FIXES the data produces NO init violation (checked AFTER the drain, not before)', async () => {
    // The naive "check the owner before handing it over" implementation would
    // false-fire here — the machine is perfectly correct.
    const fixup = {
      name: 'fixup',
      stateAttribute: 'state',
      initialState: 's1',
      states: { s1: { onEnter: (o: Box) => { o['retries'] = 0 } }, s2: { final: true } },
      events: { go: { transitions: [{ from: 's1', to: 's2' }] } },
    }
    const r = await checkMachine<Box>(fixup, () => ({ ...startsBad }), {
      ...fast,
      runs: 3,
      invariants: [retriesInvariant],
    })
    expect(r.violations).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('a LIVE ADAPTER owner ABSTAINS with a warning instead of guessing', async () => {
    // Probing a live adapter would either re-run enter actions on the consumer's
    // object or lose its get/set semantics — both worse than a stated gap.
    const raw: Box = { state: 's1', retries: 5 }
    const adapter = {
      adaptee: raw,
      get: (k: string) => raw[k],
      set: (k: string, v: unknown) => {
        raw[k] = v
      },
    }
    const r = await checkMachine<Box>(okCfg, adapter as never, {
      seed: '1',
      steps: 8,
      runs: 1,
      invariants: [retriesInvariant],
    })
    const skipped = r.warnings.find((w) => w.kind === 'init-check-skipped')
    expect(skipped).toBeDefined()
    expect(skipped?.detail).toMatch(/factory/i)
    expect(r.violations.some((v) => v.witness.includes('(initial configuration)'))).toBe(false)
  })

  it('with NO user invariants the extra probe run is skipped entirely', async () => {
    const r = await checkMachine(okCfg, okOwner, fast)
    expect(r.warnings.some((w) => w.kind === 'init-check-skipped')).toBe(false)
    expect(r.ok).toBe(true)
  })
})

describe('W8/V7 — decorateLifecycle keeps BOTH receivers (critic finding B-3)', () => {
  it('folds into the new subscriber AND still calls the pre-existing one', async () => {
    const { decorateLifecycle } = await import('../../sim/check-machine')
    const seenByInner: string[] = []
    const seenByFold: string[] = []
    // A monitor that ALREADY has a load-bearing sink (this is the sim's real
    // situation: SimMonitor feeds the I-4 oracle and the ISS-030 in-flight count).
    const monitor = { recordLifecycle: (r: { hook: string }) => { seenByInner.push(r.hook) } }
    decorateLifecycle(monitor as never, (r) => { seenByFold.push(r.hook) })
    monitor.recordLifecycle({ hook: 'guard' } as never)
    // A clobbering implementation (plain assignment) would leave seenByInner empty.
    expect(seenByFold).toEqual(['guard'])
    expect(seenByInner).toEqual(['guard'])
  })

  it('works when the monitor has NO pre-existing lifecycle sink', async () => {
    const { decorateLifecycle } = await import('../../sim/check-machine')
    const seen: string[] = []
    const monitor: { recordLifecycle?: (r: { hook: string }) => void } = {}
    decorateLifecycle(monitor as never, (r) => { seen.push(r.hook) })
    monitor.recordLifecycle?.({ hook: 'onEnter' })
    expect(seen).toEqual(['onEnter'])
  })
})
