/**
 * @module tests/sim/budget_wedge — W9 remediation (the `progressed` recency fix).
 *
 * The first cut of the `budget-progressing` split used a STICKY boolean: any
 * fingerprint move anywhere in the settle marked the whole settle "progressing".
 * Since `prev` is sampled with the fired event already queued, the very first
 * pump turn always moved it — so EVERY fire-initiated settle was `progressing`
 * forever, and a machine that made one legal hop and then WEDGED was excluded
 * from the I-3 RTC oracle. That traded a false positive for SILENCE.
 *
 * These are REAL-MACHINE tests (no synthetic Env mock): the wedge is a genuine
 * `onEnter` that returns a never-resolving promise, which holds
 * `isProcessingEvents() === true` with a frozen fingerprint for the rest of the
 * budget.
 *
 * ## SUPERSEDED IN PART — the classification survived, the CONVICTION did not
 * The recency discriminator this file pins is still live and still correct: a
 * machine that hops once and then freezes is classified `microtask-budget`, not
 * `budget-progressing`. What changed is what the harness is allowed to DO with
 * that classification. Nothing — it is advisory.
 *
 * The reason is that this file's own `wedgeAfterProgress` fixture is not
 * distinguishable, by the harness, from a CORRECT machine. Its observable
 * signature is "the settle fingerprint stopped moving and the budget ran out",
 * and `budget_truncation.test.ts` holds a machine that produces exactly that
 * signature and reaches its target state every time. Convicting one convicts the
 * other. The two cases below that asserted a VERDICT (I-3, and the liveness
 * TIMEOUT_BUDGET_EXCEEDED) are therefore changed by design; each carries its own
 * justification at the case.
 */
import { describe, expect, it } from 'vitest'
import { MemoryAdapter, type StateMachineConfig, StateMachine } from '../../index'
import { makeSimClock } from '../../sim/clock'
import { type Env, makeAsyncCounter, makeEnv, makeObservableScheduler } from '../../sim/env'
import { runSimulation } from '../../sim/public'
import { settleMacrostep } from '../../sim/settle'

interface Box {
  state: string
}

/**
 * `s0 -E-> h1 -(delay:0 invoke)-> wedge`. The E hop is LEGAL and observable; the
 * `wedge` state's `onEnter` never resolves, so from that point the fingerprint
 * is frozen for the whole remaining budget.
 */
const wedgeAfterProgress = {
  name: 'wedgeAfterProgress',
  stateAttribute: 'state',
  initialState: 's0',
  states: {
    s0: {},
    h1: { invoke: [{ event: 'n1', delay: 0 }] },
    wedge: { onEnter: () => new Promise<void>(() => {}) },
  },
  events: {
    E: { transitions: [{ from: 's0', to: 'h1' }] },
    n1: { transitions: [{ from: 'h1', to: 'wedge' }] },
  },
} as const

const runWedge = (mode: 'safety' | 'liveness') =>
  runSimulation(
    () => ({ config: wedgeAfterProgress as never, owner: { state: 's0' } as never }),
    { seed: '1', steps: 1, mode },
  )

/** `s0 -E-> h1 -> … -> hN(final)`, every hop a legal `delay:0` invoke. */
function chain(n: number): unknown {
  const states: Record<string, unknown> = { s0: {} }
  const events: Record<string, unknown> = { E: { transitions: [{ from: 's0', to: 'h1' }] } }
  for (let i = 1; i <= n; i++) {
    const next = i === n ? undefined : `h${i + 1}`
    states[`h${i}`] = next ? { invoke: [{ event: `n${i}`, delay: 0 }] } : { final: true }
    if (next) events[`n${i}`] = { transitions: [{ from: `h${i}`, to: next }] }
  }
  return { name: `chain${n}`, stateAttribute: 'state', initialState: 's0', states, events }
}

const runChain = (n: number, mode: 'safety' | 'liveness' = 'safety') =>
  runSimulation(() => ({ config: chain(n) as never, owner: { state: 's0' } as never }), {
    seed: '1',
    steps: 3,
    mode,
  })

const settleReasons = (r: Awaited<ReturnType<typeof runChain>>): Set<string> =>
  new Set(
    r.trace
      .filter((f) => f.quiescent === false)
      .map((f) => (f as { settleReason?: string }).settleReason)
      .filter((x): x is string => Boolean(x)),
  )

// ── (1) wedge AFTER progress — the defect the sticky flag silenced ───────────

describe('W9 remediation — a machine that progresses then WEDGES is still an RTC witness', () => {
  it('classifies the wedged tail `microtask-budget`, not `budget-progressing`', async () => {
    const r = await runWedge('safety')
    const reasons = settleReasons(r)
    expect(reasons.has('microtask-budget')).toBe(true)
    expect(reasons.has('budget-progressing')).toBe(false)
  })

  /**
   * CHANGED BY DESIGN — this used to assert `ok:false` with `violation:'I-3'`.
   *
   * The `wedgeAfterProgress` fixture above really is wedged: its `onEnter`
   * returns a promise that never resolves. But the HARNESS cannot know that. It
   * observes a frozen fingerprint for the remainder of a FIXED turn budget, and
   * that observation is byte-identical to the one produced by a hook that does a
   * large but FINITE amount of internal microtask work and then returns —
   * enter/exit hooks are deliberately excluded from `inFlightAsyncCount`
   * (driver.ts), so all three fingerprint components freeze either way and no
   * timer is armed to break the tie.
   *
   * That is not hypothetical. `budget_truncation.test.ts` holds the CORRECT
   * machine this rule convicted: identical topology, `slow.onEnter = async () =>
   * { for (let i=0;i<N;i++) await Promise.resolve() }`. It reaches `slow` for
   * every N, yet the old rule passed it at N<=100 and failed it at N>=1000. The
   * deciding variable was `DEFAULT_MAX_TURNS`, an internal harness constant no
   * public option could raise — never anything about the machine.
   *
   * So the old expectation pinned a rule that could not distinguish this fixture
   * from a correct machine, and a false positive on a correct machine is worse
   * than a missed finding. `microtask-budget` is now an advisory WARNING; the
   * classification below still names the wedged reading, and the RTC oracle's
   * teeth moved to `WAITING_ON_INTERNAL`, which is reached at the pump's EARLY
   * break (inside budget) and is therefore a positive observation rather than a
   * truncation. This case now pins that the wedge is REPORTED but not CONVICTED.
   */
  it('does NOT convict: the wedged tail is reported as a warning, not a verdict', async () => {
    const r = await runWedge('safety')
    expect(r.ok).toBe(true)
    expect((r as { violation?: { invariantId?: string } }).violation).toBeUndefined()
    // Reported, though — silence would be the other failure mode.
    const w = (r.warnings ?? []).filter((x) => x.kind === 'budget-frozen')
    expect(w.length).toBe(1)
    expect(w[0]?.count).toBeGreaterThan(0)
    // The message must say the harness cannot tell the two readings apart, and
    // must name the knob that separates them.
    expect(w[0]?.message).toMatch(/CANNOT tell/)
    expect(w[0]?.message).toMatch(/maxTurns/)
  })
})

// ── (2) immediate wedge — NO progress at all (control) ───────────────────────

describe('W9 remediation — a settle over an already-wedged machine has no progress at all', () => {
  it('reports `microtask-budget` on a real machine wedged before the settle began', async () => {
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableScheduler(clock)
    const env: Env = makeEnv(makeAsyncCounter(), view)
    const config: StateMachineConfig<Box> = {
      name: 'ImmediateWedge',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        // never resolves and NO transitionTimeout is configured, so no future
        // timer exists that could ever clear it — the pump can only exhaust.
        busy: { onEnter: () => new Promise<void>(() => {}) },
      },
      events: { go: { transitions: [{ from: 'idle', to: 'busy' }] } },
    }
    const adapter = new MemoryAdapter<Box>({ state: 'idle' })
    const sm = new StateMachine<Box, typeof config>(config, adapter, { clock: clock.now, scheduler })
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })

    const firePromise = sm.fireEvent('go')
    firePromise.catch(() => {})
    // First settle: wedges the machine (it moved once dequeuing `go`).
    const first = await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety', maxTurns: 256 })
    expect(first.quiescent).toBe(false)
    expect(first.reason).toBe('microtask-budget')

    // Second settle: the machine is ALREADY wedged, so nothing moves even once.
    const second = await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety', maxTurns: 256 })
    expect(second.quiescent).toBe(false)
    expect(second.reason).toBe('microtask-budget')
  })
})

// ── (3) the correct long chain stays green AND carries the new warning ───────

describe('W9 remediation — the correct 40-hop chain is unaffected and is SURFACED', () => {
  it('still completes with ok:true and reaches its final state', async () => {
    const r = await runChain(40)
    expect(r.trace.at(-1)?.to).toBe('h40')
    expect(r.ok).toBe(true)
    expect(settleReasons(r).has('budget-progressing')).toBe(true)
  })

  it('carries exactly ONE `budget-progressing` warning for the whole run', async () => {
    const r = await runChain(40)
    const w = (r.warnings ?? []).filter((x) => x.kind === 'budget-progressing')
    expect(w.length).toBe(1)
    // The advice must name knobs that EXIST. `steps` (the drain resumes on the
    // next step) — see the probe in the report: a 200-hop chain reaches
    // h36/h108/h180/h200 at steps 1/2/3/6. And `maxTurns`, which used to be
    // internal to settleMacrostep and reachable from no public option, and is
    // now on both `SimOptions` and `CheckOptions`.
    expect(w[0]?.message).toMatch(/`steps`/)
    expect(w[0]?.message).toMatch(/maxTurns/)
    expect(w[0]?.count).toBeGreaterThan(0)
  })

  it('a chain that fits the budget carries NO such warning', async () => {
    const r = await runChain(5)
    expect((r.warnings ?? []).some((x) => x.kind === 'budget-progressing')).toBe(false)
  })
})

// ── (4) the liveness wiring: NEITHER budget reason may feed the verdict ──────

describe('the settle budget feeds NO liveness verdict, in either flavour', () => {
  it('`budget-progressing` does NOT produce a TIMEOUT_BUDGET_EXCEEDED verdict', async () => {
    const r = await runChain(40, 'liveness')
    expect(settleReasons(r).has('budget-progressing')).toBe(true)
    expect(r.liveness?.reason).not.toBe('macrostep microtask-budget exhausted')
    expect(r.liveness?.verdict).not.toBe('TIMEOUT_BUDGET_EXCEEDED')
  })

  /**
   * CHANGED BY DESIGN — this used to assert that `microtask-budget` DOES produce
   * TIMEOUT_BUDGET_EXCEEDED and `ok:false`.
   *
   * `LivenessParams.microtaskBudgetExhausted` and its producer in `public.ts` are
   * both gone. TIMEOUT_BUDGET_EXCEEDED is a HARD `livelock` cause that `failOn`
   * cannot relax, and it was being derived from a budget-TRUNCATED window — an
   * observation that cannot distinguish a wedge from a hook doing finite internal
   * work (see the case in section (1) and `budget_truncation.test.ts`). The
   * remaining producer of that verdict is the VIRTUAL-TIME budget, which only
   * advances when the machine actually armed the deadlines that moved it, so it
   * is a positive observation rather than a truncation.
   */
  it('`microtask-budget` produces NO verdict either — only a warning', async () => {
    const r = await runWedge('liveness')
    expect(settleReasons(r).has('microtask-budget')).toBe(true)
    expect(r.liveness?.verdict).not.toBe('TIMEOUT_BUDGET_EXCEEDED')
    expect(r.liveness?.reason).not.toBe('macrostep microtask-budget exhausted')
    expect(r.livelocks).toBeUndefined()
    expect(r.ok).toBe(true)
    expect((r.warnings ?? []).some((x) => x.kind === 'budget-frozen')).toBe(true)
  })
})
