import { describe, expect, it } from 'vitest'
import {
  FNV64_OFFSET,
  FNV64_PRIME,
  MASK64,
  makePrng,
  type Prng,
  SimError,
  SPLITMIX64_INCREMENT,
  SPLITMIX64_MUL_1,
  SPLITMIX64_MUL_2,
} from '../../sim/prng'

// A 64-bit draw helper: nextU32 only exposes 32 bits, but we want the full
// 64-bit mixer output for golden-vector pinning. We reconstruct it by reading
// state() before/after is NOT possible (mix is one-way); instead we expose the
// canonical draws by replicating the FROZEN mixer here and asserting the PRNG's
// nextFloat/int are CONSISTENT with it. The 64-bit golden is pinned via a local
// re-implementation guarded against constant drift.
function mix(x: bigint): bigint {
  let z = x & MASK64
  z = ((z ^ (z >> 30n)) * SPLITMIX64_MUL_1) & MASK64
  z = ((z ^ (z >> 27n)) * SPLITMIX64_MUL_2) & MASK64
  z = z ^ (z >> 31n)
  return z & MASK64
}
function fnv64(s: string): bigint {
  let h = FNV64_OFFSET
  for (let i = 0; i < s.length; i++) {
    h = (h ^ BigInt(s.charCodeAt(i))) & MASK64
    h = (h * FNV64_PRIME) & MASK64
  }
  return h & MASK64
}
function rotl64(x: bigint, r: bigint): bigint {
  const v = x & MASK64
  return ((v << r) | (v >> (64n - r))) & MASK64
}
/** Replicate next(): advance counter by INCREMENT, mix. */
function rawNext(stateRef: { s: bigint }): bigint {
  stateRef.s = (stateRef.s + SPLITMIX64_INCREMENT) & MASK64
  return mix(stateRef.s)
}

const SEED0_GOLDEN = [
  0xe220a8397b1dcdafn,
  0x6e789e6aa1b965f4n,
  0x06c45d188009454fn,
  0xf88bb8a8724c81ecn,
  0x1b39896a51a8749bn,
]

describe('prng: seed=0 golden vector (FROZEN mixer)', () => {
  it('reproduces the PLAN-verified seed=0 draw stream', () => {
    const ref = { s: 0n }
    const got = SEED0_GOLDEN.map(() => rawNext(ref))
    expect(got).toEqual(SEED0_GOLDEN)
  })

  it('fails on any mixer-constant change (constants are exactly the FROZEN values)', () => {
    expect(SPLITMIX64_INCREMENT).toBe(0x9e3779b97f4a7c15n)
    expect(SPLITMIX64_MUL_1).toBe(0xbf58476d1ce4e5b9n)
    expect(SPLITMIX64_MUL_2).toBe(0x94d049bb133111ebn)
    expect(MASK64).toBe((1n << 64n) - 1n)
    expect(FNV64_OFFSET).toBe(0xcbf29ce484222325n)
    expect(FNV64_PRIME).toBe(0x100000001b3n)
  })

  it('nextFloat is consistent with the top-53-bits of the golden 64-bit draw', () => {
    const p = makePrng(0n)
    const expectedFloat = Number(SEED0_GOLDEN[0]! >> 11n) / Number(1n << 53n)
    expect(p.nextFloat()).toBe(expectedFloat)
  })
})

describe('prng: fork golden vector + non-advance', () => {
  it("fnv64('topology') matches the pinned value", () => {
    expect(fnv64('topology')).toBe(0x516188458c0dece4n)
  })

  it("fork('topology') state() + first 3 draws are pinned and parent does NOT advance", () => {
    const root = makePrng(0n)
    const before = root.state()
    const topo = root.fork('topology')
    const after = root.state()
    expect(after).toBe(before) // fork does NOT advance the parent

    expect(topo.state()).toBe(0xdefc2656017b648en)
    // first 3 draws of fork('topology') — replicated via the FROZEN raw mixer
    const ref = { s: topo.state() }
    const draws = [rawNext(ref), rawNext(ref), rawNext(ref)]
    expect(draws).toEqual([0x4116163fef81d241n, 0xb2bbf54b75a012d6n, 0x7b783d9380967068n])
  })

  it("fork('ops') first draw is pinned", () => {
    const root = makePrng(0n)
    const ops = root.fork('ops')
    const ref = { s: ops.state() }
    expect(rawNext(ref)).toBe(0xa48e18994dbee6ean)
  })

  it('fork does not advance siblings either (two forks from same parent state are independent of order)', () => {
    const r1 = makePrng(42n)
    const f1a = r1.fork('a').state()
    const f1b = r1.fork('b').state()
    const r2 = makePrng(42n)
    const f2b = r2.fork('b').state()
    const f2a = r2.fork('a').state()
    expect(f1a).toBe(f2a)
    expect(f1b).toBe(f2b)
  })
})

describe('prng: snapshot/restore-fork byte equivalence', () => {
  it('makePrng(p.state()) continues the parent draw byte-identically', () => {
    const p = makePrng(0n)
    p.nextU32() // draw 0
    p.nextU32() // draw 1
    const mid = p.state()
    const restored = makePrng(mid)
    // draw[2] of seed=0 is 0x06c45d188009454f; the restored PRNG must produce it
    const ref = { s: restored.state() }
    expect(rawNext(ref)).toBe(0x06c45d188009454fn)
  })

  it('restored PRNG forks byte-identically (mid-fork snapshot)', () => {
    const p = makePrng(0n)
    p.nextU32()
    const mid = p.state()
    const directFork = p.fork('x').state()
    const restored = makePrng(mid)
    const restoredFork = restored.fork('x').state()
    expect(restoredFork).toBe(directFork)
  })
})

describe('prng: corpus stability', () => {
  it("fork('a')/fork('b') streams are byte-stable when fork('c') is introduced between them", () => {
    const r1 = makePrng(123n)
    const a1 = r1.fork('a').nextU32()
    const b1 = r1.fork('b').nextU32()

    const r2 = makePrng(123n)
    const a2 = r2.fork('a').nextU32()
    r2.fork('c').nextU32() // introduce a new corpus member between a and b
    const b2 = r2.fork('b').nextU32()

    expect(a2).toBe(a1)
    expect(b2).toBe(b1)
  })
})

describe('prng: int() rejection-free Lemire — golden sequence + single draw + degenerate throws', () => {
  it('pins a SPECIFIC int(100) golden sequence for seed=0 (corpus-freezes the rejection-free choice)', () => {
    const p = makePrng(0n)
    const seq = Array.from({ length: 8 }, () => p.int(100))
    expect(seq).toEqual([88, 43, 2, 97, 10, 32, 17, 77])
  })

  it('int() consumes exactly ONE next() draw (state-delta == one increment)', () => {
    const p = makePrng(0n)
    const before = p.state()
    p.int(10)
    const after = p.state()
    expect((after - before) & MASK64).toBe(SPLITMIX64_INCREMENT)
  })

  it('int(0), int(-1), int(non-integer) throw SimError; pick([]) and weighted([]) throw', () => {
    const p = makePrng(0n)
    expect(() => p.int(0)).toThrow(SimError)
    expect(() => p.int(-1)).toThrow(SimError)
    expect(() => p.int(1.5)).toThrow(SimError)
    expect(() => p.pick([])).toThrow(SimError)
    expect(() => p.weighted([])).toThrow(SimError)
    expect(() => p.weighted([['a', 0]])).toThrow(SimError)
    expect(() => p.weighted([['a', -1]])).toThrow(SimError)
  })

  it('int(n) is always in [0,n); pick returns a member; weighted favors heavier weights', () => {
    const p = makePrng(7n)
    for (let i = 0; i < 100; i++) {
      const v = p.int(5)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(5)
    }
    const picks = new Set<string>()
    const q = makePrng(7n)
    for (let i = 0; i < 50; i++) {
      picks.add(q.pick(['x', 'y', 'z']))
    }
    expect(picks.size).toBeGreaterThan(1)

    // heavy weight dominates
    const w = makePrng(7n)
    let heavy = 0
    for (let i = 0; i < 1000; i++) {
      if (
        w.weighted([
          ['heavy', 99],
          ['light', 1],
        ] as const) === 'heavy'
      ) {
        heavy++
      }
    }
    expect(heavy).toBeGreaterThan(900)
  })

  it('bool(p) respects the probability (p=0 never true, p=1 always true)', () => {
    const p = makePrng(3n)
    for (let i = 0; i < 50; i++) {
      expect(p.bool(0)).toBe(false)
    }
    const q = makePrng(3n)
    for (let i = 0; i < 50; i++) {
      expect(q.bool(1)).toBe(true)
    }
  })
})

describe('prng: seed domain typed throws + string round-trip', () => {
  it('makePrng(NaN / Infinity / 2**53 / negative / non-integer) throws SimError', () => {
    expect(() => makePrng(Number.NaN)).toThrow(SimError)
    expect(() => makePrng(Number.POSITIVE_INFINITY)).toThrow(SimError)
    expect(() => makePrng(2 ** 53)).toThrow(SimError)
    expect(() => makePrng(-1)).toThrow(SimError)
    expect(() => makePrng(1.5)).toThrow(SimError)
  })

  it('header.seed serialized as a string round-trips through makePrng', () => {
    const p1: Prng = makePrng(0xdeadbeefn)
    const wire = p1.seed.toString() // serialize bigint as string for JSON
    const p2 = makePrng(wire) // string overload
    expect(p2.seed).toBe(p1.seed)
    expect(p2.nextU32()).toBe(p1.nextU32())
  })

  it('makePrng(string) rejects a non-bigint-parseable seed', () => {
    expect(() => makePrng('not-a-number')).toThrow(SimError)
  })

  it('makePrng accepts a valid number seed and matches the bigint overload', () => {
    const a = makePrng(12345)
    const b = makePrng(12345n)
    expect(a.nextU32()).toBe(b.nextU32())
  })
})
