/**
 * @module tests/sim/budget_truncation
 *
 * A budget-truncated observation can never soundly convict, and this file holds
 * the CORRECT machine that proved it.
 *
 * ## The defect
 * Topology: `s0 -E-> h1 -(invoke delay:0)-> slow`, where `slow.onEnter` is
 * `async () => { for (let i=0;i<N;i++) await Promise.resolve() }` — a hook that
 * does a long but strictly FINITE amount of internal microtask work and then
 * returns. The machine reaches `slow` for every N.
 *
 * The settle fingerprint is `queueTotal|isProcessingEvents|inFlightAsyncCount`
 * (settle.ts). Enter/exit hooks are deliberately NOT counted in
 * `inFlightAsyncCount` (driver.ts), so while such a hook runs all three
 * components are frozen and no timer is armed — indistinguishable from a wedge
 * over any FIXED window. Measured at HEAD before the fix, `mode:'both'`,
 * `steps:2`:
 *
 * ```
 * N=10    ok=true   -> slow   reasons=[]
 * N=100   ok=true   -> slow   reasons=[]
 * N=1000  ok=false  -> slow   reasons=["microtask-budget"]  violation=I-3
 *                                       livelock=TIMEOUT_BUDGET_EXCEEDED
 * N=3000  ok=false  -> slow   reasons=["microtask-budget"]  violation=I-3
 *                                       livelock=TIMEOUT_BUDGET_EXCEEDED
 * ```
 *
 * The deciding variable was `DEFAULT_MAX_TURNS = 1024` — an internal harness
 * constant that was documented nowhere and that no public option could raise.
 * Nothing about the machine changed across those four rows.
 *
 * ## What this file pins
 *  1. the machine stays `ok:true` at every N, with no violation and no livelock;
 *  2. it is still REPORTED — silence is the other failure mode;
 *  3. `maxTurns` exists, reaches the settle, and separates the two readings;
 *  4. the recency window respects a small budget instead of collapsing;
 *  5. the trace-version constants stay in lockstep.
 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_TURNS,
  PROGRESS_RECENCY_WINDOW,
  progressRecencyWindow,
} from '../../sim/settle'
import { checkMachine } from '../../sim/check-machine'
import { runSimulation } from '../../sim/public'

/** `s0 -E-> h1 -(delay:0 invoke)-> slow`, whose onEnter awaits N microtasks. */
function slowHook(n: number): unknown {
  return {
    name: `slowHook${n}`,
    stateAttribute: 'state',
    initialState: 's0',
    states: {
      s0: {},
      h1: { invoke: [{ event: 'n1', delay: 0 }] },
      slow: {
        onEnter: async (): Promise<void> => {
          for (let i = 0; i < n; i++) {
            await Promise.resolve()
          }
        },
      },
    },
    events: {
      E: { transitions: [{ from: 's0', to: 'h1' }] },
      n1: { transitions: [{ from: 'h1', to: 'slow' }] },
    },
  }
}

const runSlow = (n: number, maxTurns?: number) =>
  runSimulation(() => ({ config: slowHook(n) as never, owner: { state: 's0' } as never }), {
    seed: '1',
    steps: 2,
    mode: 'both',
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  })

const settleReasons = (r: Awaited<ReturnType<typeof runSlow>>): Set<string> =>
  new Set(
    r.trace
      .filter((f) => f.quiescent === false)
      .map((f) => (f as { settleReason?: string }).settleReason)
      .filter((x): x is string => Boolean(x)),
  )

// ── (1) the regression: a correct machine is never convicted ─────────────────

describe('a finite-work onEnter hook is never convicted for outrunning the turn budget', () => {
  // N=10/100 fit the default budget; N=1000/3000 do not. Before the fix the
  // verdict flipped between those two groups on the budget alone.
  it.each([10, 100, 1000, 3000])('N=%i stays ok:true and reaches `slow`', async (n) => {
    const r = await runSlow(n)
    expect(r.trace.at(-1)?.to).toBe('slow') // it really did complete
    expect((r as { violation?: { invariantId?: string } }).violation).toBeUndefined()
    expect(r.livelocks).toBeUndefined()
    expect(r.liveness?.verdict).not.toBe('TIMEOUT_BUDGET_EXCEEDED')
    expect(r.ok).toBe(true)
  })

  it('the budget-busting N really does exhaust the pump (the test above has teeth)', async () => {
    // Without this, `ok:true` at N=3000 would also pass if the hook were never
    // reached or the budget never hit — i.e. for the wrong reason.
    expect(settleReasons(await runSlow(3000)).has('microtask-budget')).toBe(true)
    expect(settleReasons(await runSlow(10)).size).toBe(0)
  })

  it('checkMachine agrees: the `livelock` FailCause does not fire', async () => {
    const report = await checkMachine(slowHook(3000) as never, () => ({ state: 's0' }) as never, {
      seed: '1',
      steps: 2,
      runs: 1,
      mode: 'both',
      events: [{ event: 'E' }],
    })
    // `livelock` is the HARD cause `failOn` cannot relax, and it is what the
    // removed liveness wiring produced. (`deadlock` DOES fire and is correct:
    // `slow` is a genuine dead end in this deliberately minimal fixture — that
    // is a property of the topology, not of the turn budget.)
    expect(report.failedOn).not.toContain('livelock')
    expect(report.failedOn).not.toContain('degradation')
  })
})

// ── (2) it is reported, though ───────────────────────────────────────────────

describe('both budget outcomes are surfaced as advisory warnings', () => {
  it('the frozen flavour warns, names its own ambiguity, and points at the knob', async () => {
    const w = ((await runSlow(3000)).warnings ?? []).filter((x) => x.kind === 'budget-frozen')
    expect(w.length).toBe(1) // deduped once per run
    expect(w[0]?.count).toBeGreaterThan(0) // …with the multiplicity kept
    expect(w[0]?.message).toMatch(/CANNOT tell/)
    expect(w[0]?.message).toMatch(/maxTurns/)
  })

  it('the two flavours are DISTINGUISHABLE kinds, not one merged bucket', async () => {
    const frozen = (await runSlow(3000)).warnings ?? []
    expect(frozen.some((x) => x.kind === 'budget-frozen')).toBe(true)
    expect(frozen.some((x) => x.kind === 'budget-progressing')).toBe(false)
  })

  it('checkMachine surfaces the frozen flavour under its OWN kind', async () => {
    const report = await checkMachine(slowHook(3000) as never, () => ({ state: 's0' }) as never, {
      seed: '1',
      steps: 2,
      runs: 1,
      mode: 'both',
      events: [{ event: 'E' }],
    })
    expect(report.warnings.some((x) => x.kind === 'budget-frozen')).toBe(true)
    // NOT laundered into the residual-rejection catch-all, which names a
    // completely different and much more alarming condition.
    expect(report.warnings.some((x) => x.kind === 'residual-rejection')).toBe(false)
  })
})

// ── (3) the knob the advice presupposes ──────────────────────────────────────

describe('`maxTurns` is a real public knob that reaches the settle', () => {
  it('raising it lets the finite hook finish, which is what separates it from a wedge', async () => {
    // The same N that exhausts the default budget settles cleanly at a larger one
    // — the empirical difference between "finite work" and "wedged".
    const raised = await runSlow(3000, 8192)
    expect(settleReasons(raised).size).toBe(0)
    expect(raised.trace.at(-1)?.to).toBe('slow')
    expect(raised.ok).toBe(true)
    expect((raised.warnings ?? []).some((x) => x.kind.startsWith('budget-'))).toBe(false)
  })

  it('lowering it makes a machine that fits the default budget stop fitting', async () => {
    // The converse direction, so the assertion above cannot pass by the option
    // being ignored: N=100 is clean by default and exhausts a tiny budget.
    expect(settleReasons(await runSlow(100)).size).toBe(0)
    expect(settleReasons(await runSlow(100, 32)).size).toBeGreaterThan(0)
  })

  it('checkMachine forwards it too', async () => {
    const opts = { seed: '1', steps: 2, runs: 1, mode: 'both' as const, events: [{ event: 'E' }] }
    const owner = () => ({ state: 's0' }) as never
    const dflt = await checkMachine(slowHook(3000) as never, owner, opts)
    const raised = await checkMachine(slowHook(3000) as never, owner, { ...opts, maxTurns: 8192 })
    // The budget warning is present by default and GONE once the budget is
    // raised — so the option is demonstrably reaching the settle, not ignored.
    expect(dflt.warnings.some((x) => x.kind === 'budget-frozen')).toBe(true)
    expect(raised.warnings.some((x) => x.kind.startsWith('budget-'))).toBe(false)
  })
})

// ── (4) the recency window vs a small budget ─────────────────────────────────

describe('the progress-recency window', () => {
  /**
   * Nothing pinned this constant before, so it could have drifted ~100x — in
   * either direction — without a single test noticing, and it is the whole
   * moving/frozen discriminator.
   */
  it('is 64 turns nominally (4 quiet-flush windows)', () => {
    expect(PROGRESS_RECENCY_WINDOW).toBe(64)
    expect(DEFAULT_MAX_TURNS).toBe(1024)
  })

  it('is inactive at the default budget', () => {
    expect(progressRecencyWindow(DEFAULT_MAX_TURNS)).toBe(PROGRESS_RECENCY_WINDOW)
  })

  /**
   * The absolute 64 vs a per-call `maxTurns` is the collapse this pins: for any
   * caller at `maxTurns <= 64` the test `turns - lastMoveTurn <= 64` is
   * unconditionally TRUE once anything has moved, because the whole settle is
   * shorter than the window — so every exhaustion reads "progressing" and the
   * distinction silently stops carrying information. The public sentinel probe
   * runs at exactly 64.
   */
  it('is capped at half the budget so a small `maxTurns` cannot make it trivial', () => {
    expect(progressRecencyWindow(64)).toBe(32)
    expect(progressRecencyWindow(32)).toBe(16)
    expect(progressRecencyWindow(8)).toBe(4)
    // strictly below the budget for every budget: the STALE region is observable
    for (const budget of [2, 4, 8, 16, 32, 64, 128, 256, 1024]) {
      expect(progressRecencyWindow(budget)).toBeLessThan(budget)
    }
  })

  it('never degenerates to zero on an absurd budget', () => {
    expect(progressRecencyWindow(1)).toBe(1)
    expect(progressRecencyWindow(0)).toBe(1)
  })
})

// ── (5) the comment-enforced lockstep, now test-enforced ─────────────────────

describe('the canonical trace-header version', () => {
  /**
   * `driver.ts` (the real header) and `public.ts` (`emptyHeader`, the degenerate
   * no-driver fallback) each hard-code the version string, and they were kept
   * equal by a COMMENT ("MUST stay in lockstep") and nothing else. A drift would
   * let one path hash under a different schema than the other.
   *
   * Pinned from SOURCE rather than through a run, because `emptyHeader` is only
   * reachable when no driver was ever built — there is no public run that
   * returns it. Same idiom as the settle-primitive source pins in
   * `shrinker.test.ts`.
   */
  const versionIn = async (file: string): Promise<string[]> => {
    const url = new URL(`../../sim/${file}`, import.meta.url)
    const code = await readFile(url, 'utf8')
    return [...code.matchAll(/^\s*version: '([^']*)',$/gm)].map((m) => m[1] as string)
  }

  it('is identical in driver.ts and public.ts', async () => {
    const inDriver = await versionIn('driver.ts')
    const inPublic = await versionIn('public.ts')
    // exactly one canonical header literal per file — if that stops holding the
    // equality below would be comparing the wrong things.
    expect(inDriver).toHaveLength(1)
    expect(inPublic).toHaveLength(1)
    expect(inDriver[0]).toBe(inPublic[0])
    expect(inDriver[0]).toBe('6')
  })
})
