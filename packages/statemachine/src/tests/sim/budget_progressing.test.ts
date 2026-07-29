/**
 * @module tests/sim/budget_progressing — W9/Г2.
 *
 * A machine walking a LONG but perfectly legal chain of `delay:0` invoke hops
 * exhausts the settle pump budget (each hop costs QUIET_FLUSH stabilisation
 * turns, so ~40 hops burn the default 1024 turns). Before this fix that surfaced
 * as `settleReason:'microtask-budget'`, which I-3 treats as a run-to-completion
 * break — so a CORRECT machine failed the verdict, and I-3 sits in the DEFAULT
 * builtin set, meaning every consumer would have hit it.
 *
 * The discriminator is RECENCY, not the sticky "EVER moved" flag this comment
 * used to describe. A sticky flag marked the whole settle "progressing" as soon
 * as anything moved anywhere — and since `prev` is sampled with the fired event
 * already queued, the first pump turn always moved it, so every fire-initiated
 * settle was `progressing` forever. The live rule is: exhaustion counts as
 * `budget-progressing` only if the fingerprint moved WITHIN the recency window of
 * the cutoff (`progressRecencyWindow(maxTurns)`, nominally 64 and capped at half
 * the budget); otherwise `microtask-budget`. A machine that hops once and THEN
 * freezes is therefore `microtask-budget`, which `budget_wedge.test.ts` pins.
 *
 * NEITHER value is a verdict any more. Both are advisory warnings: a budget
 * exhaustion is a truncated observation and cannot convict. I-3 excludes both,
 * and this file's assertions are about CLASSIFICATION and about the run staying
 * `ok:true` — the latter now holds for the wedged flavour too, which is
 * `budget_wedge.test.ts`'s business rather than this file's.
 */
import { describe, expect, it } from 'vitest'
import { runSimulation } from '../../sim/public'

/** `s0 -E-> h1 -(delay:0 invoke)-> h2 -> … -> hN(final)`. Every hop is legal. */
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

const run = (n: number) =>
  runSimulation(
    () => ({ config: chain(n) as never, owner: { state: 's0' } as never }),
    { seed: '1', steps: 3, mode: 'safety' },
  )

describe('W9/Г2 — a long LEGAL delay-0 chain must not be reported as an RTC break', () => {
  it('a 40-hop chain reaches its final state and the verdict stays ok:true', async () => {
    const r = await run(40)
    expect(r.trace.at(-1)?.to).toBe('h40') // it really did complete
    expect((r as { violation?: { invariantId?: string } }).violation?.invariantId).toBeUndefined()
    expect(r.ok).toBe(true)
  })

  it('the exhaustion is classified `budget-progressing`, not `microtask-budget`', async () => {
    const r = await run(40)
    const reasons = new Set(
      r.trace
        .filter((f) => f.quiescent === false)
        .map((f) => (f as { settleReason?: string }).settleReason)
        .filter(Boolean),
    )
    expect(reasons.has('budget-progressing')).toBe(true)
    // The wedged-drain classification must NOT be used for a progressing machine.
    expect(reasons.has('microtask-budget')).toBe(false)
  })

  it('shorter chains that fit the budget are unaffected (control)', async () => {
    for (const n of [5, 20]) {
      const r = await run(n)
      expect(r.ok).toBe(true)
      expect(r.trace.at(-1)?.to).toBe(`h${n}`)
    }
  })
})
