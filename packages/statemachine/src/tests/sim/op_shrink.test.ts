/**
 * @module tests/sim/op_shrink — W9/Г3 ddmin core.
 *
 * PURE unit tests: the predicate is a stub, so these pin the ALGORITHM
 * (minimality, determinism, budget honesty, anti-fabrication) independently of
 * the engine. The engine-level wiring is tested where checkMachine integrates it.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_OP_SHRINK_BUDGET, shrinkOps, type ShrinkableOp } from '../../sim/op-shrink'

const fire = (event: string, args?: readonly unknown[]): ShrinkableOp => ({ kind: 'fire', event, ...(args ? { args } : {}) })
const advance = (dtMs: number): ShrinkableOp => ({ kind: 'advance', dtMs })
const noop = (): ShrinkableOp => ({ kind: 'noop' })

describe('shrinkOps: reduces to the ops that actually matter', () => {
  it('drops everything except the two ops the predicate depends on', async () => {
    const stream: ShrinkableOp[] = [
      noop(), fire('a'), noop(), fire('KEY1'), fire('b'), noop(), fire('c'), fire('KEY2'), fire('d'), noop(),
    ]
    // Reproduces iff BOTH keys survive, in order.
    const r = await shrinkOps(stream, async (c) => {
      const names = c.filter((o) => o.kind === 'fire').map((o) => (o as { event: string }).event)
      return names.indexOf('KEY1') >= 0 && names.indexOf('KEY2') > names.indexOf('KEY1')
    })
    expect(r.ops.map((o) => (o.kind === 'fire' ? o.event : o.kind))).toEqual(['KEY1', 'KEY2'])
    expect(r.minimal).toBe(true)
    expect(r.moves).toBeGreaterThan(0)
  })

  it('binary-searches an advance down to the smallest reproducing value', async () => {
    const r = await shrinkOps([fire('x'), advance(1000)], async (c) => {
      const adv = c.find((o) => o.kind === 'advance') as { dtMs: number } | undefined
      return adv !== undefined && adv.dtMs >= 250 // the threshold to discover
    })
    const adv = r.ops.find((o) => o.kind === 'advance') as { dtMs: number }
    expect(adv.dtMs).toBe(250)
  })

  it('is DETERMINISTIC: the same input and predicate give the same stream', async () => {
    const stream = [fire('a'), noop(), advance(64), fire('KEY'), fire('b'), noop()]
    const pred = async (c: readonly ShrinkableOp[]) => c.some((o) => o.kind === 'fire' && o.event === 'KEY')
    const a = await shrinkOps(stream, pred)
    const b = await shrinkOps(stream, pred)
    expect(JSON.stringify(a.ops)).toBe(JSON.stringify(b.ops))
  })
})

describe('shrinkOps: anti-fabrication — never returns an unverified reduction', () => {
  it('a predicate that ALWAYS fails leaves the input untouched (never a smaller "minimal")', async () => {
    const stream = [fire('a'), fire('b'), fire('c')]
    const r = await shrinkOps(stream, async () => false)
    expect(r.ops).toEqual(stream) // valid repro, just not reduced
    expect(r.moves).toBe(0)
  })

  it('a THROWING predicate is treated as "does not reproduce", not as success', async () => {
    const stream = [fire('a'), fire('b')]
    const r = await shrinkOps(stream, async () => { throw new Error('cannot run') })
    expect(r.ops).toEqual(stream)
    expect(r.moves).toBe(0)
  })

  it('every op in the result was ACCEPTED by the predicate (the last accepted candidate)', async () => {
    const seen: string[][] = []
    const stream = [fire('a'), fire('KEY'), fire('b')]
    const r = await shrinkOps(stream, async (c) => {
      const names = c.map((o) => (o.kind === 'fire' ? o.event : o.kind))
      const ok = names.includes('KEY')
      if (ok) seen.push(names)
      return ok
    })
    const final = r.ops.map((o) => (o.kind === 'fire' ? o.event : o.kind))
    expect(seen).toContainEqual(final) // the returned stream was really run and accepted
  })
})

describe('shrinkOps: budget honesty', () => {
  it('respects maxRuns and reports minimal:false when it stopped on the budget', async () => {
    let calls = 0
    const stream = Array.from({ length: 40 }, (_, i) => fire(`e${i}`))
    const r = await shrinkOps(
      stream,
      async () => { calls++; return false }, // nothing ever reduces → keeps trying
      { maxRuns: 5, maxStagnantRounds: 99 },
    )
    expect(calls).toBeLessThanOrEqual(5)
    expect(r.runs).toBeLessThanOrEqual(5)
    expect(r.minimal).toBe(false)
    expect(r.ops).toEqual(stream)
  })

  it('memoizes: an identical candidate is not re-run', async () => {
    let calls = 0
    const stream = [fire('a'), fire('a'), fire('KEY')]
    await shrinkOps(stream, async (c) => { calls++; return c.some((o) => o.kind === 'fire' && o.event === 'KEY') })
    // Without memoization the two identical `fire('a')` drops would re-run the
    // same candidate shape repeatedly; the cap here is deliberately generous.
    expect(calls).toBeLessThan(12)
  })

  it('exposes the default budget as a named constant', () => {
    expect(DEFAULT_OP_SHRINK_BUDGET.maxRuns).toBeGreaterThan(0)
    expect(DEFAULT_OP_SHRINK_BUDGET.maxStagnantRounds).toBeGreaterThan(0)
  })
})

describe('shrinkOps: memo identity is INDEX-based (the payload-collision class)', () => {
  it('two candidates that differ ONLY in payload are NOT conflated', async () => {
    // `[fire('E',{v:1}), fire('E',{v:2})]` → dropping the first vs the second gives
    // two DIFFERENT candidates that a content-based key ("fE") cannot tell apart.
    // With such a key the second inherits the first's verdict and the valid
    // reduction is lost — the same defect class that made `shrinkCacheKey` unusable
    // here ([object Object] collapse). Index identity keeps them distinct.
    const stream: ShrinkableOp[] = [fire('E', [{ v: 1 }]), fire('E', [{ v: 2 }])]
    let calls = 0
    const r = await shrinkOps(stream, async (c) => {
      calls++
      if (c.length === 2) return true
      const v = c[0]?.kind === 'fire' ? (c[0].args?.[0] as { v: number } | undefined)?.v : undefined
      return v === 1 // ONLY the first payload reproduces
    })
    expect(r.ops).toHaveLength(1)
    expect((r.ops[0] as { args: readonly unknown[] }).args[0]).toEqual({ v: 1 })
    // Both single-op candidates had to be evaluated for real; a content key would
    // have short-circuited the second one from the memo.
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  it('an advance keeps its identity while its magnitude is searched', async () => {
    const stream: ShrinkableOp[] = [advance(100), advance(100)]
    // Reproduces iff the SECOND advance is >= 50 (the two are otherwise identical).
    const r = await shrinkOps(stream, async (c) => {
      if (c.length !== 2) return false
      const second = c[1] as { dtMs: number }
      return second.dtMs >= 50
    })
    expect(r.ops).toHaveLength(2)
    expect((r.ops[1] as { dtMs: number }).dtMs).toBe(50)
  })
})
