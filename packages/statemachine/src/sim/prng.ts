/**
 * @module sim/prng
 * @unstable
 *
 * ADR-2 FROZEN seeded PRNG — splitmix64 mixer over a 64-bit bigint counter.
 *
 * The entire DST value proposition rests on bit-exact reproducibility: one seed
 * MUST deterministically reproduce the exact same draw stream on any runtime.
 * This module has NO Math.random / Date.now / performance.now (ADR-1/§5.1) and
 * is never imported by the core engine (sim-only).
 *
 * FROZEN constants (a change here is a corpus-breaking change — see golden
 * vectors in prng.test.ts):
 *   - splitmix64 increment 0x9E3779B97F4A7C15n
 *   - multipliers 0xBF58476D1CE4E5B9n / 0x94D049BB133111EBn
 *   - shifts 30 / 27 / 31
 *   - MASK64 = (1n<<64n)-1n
 *   - 64-bit FNV-1a (offset 0xcbf29ce484222325n, prime 0x100000001b3n) — DISTINCT
 *     from the engine's 32-bit FNV at security.ts:382 (no constant collision).
 *   - fork combine: childSeed = splitmix64_mix((parent.state() ^ rotl64(fnv64(label),17n)) & MASK64)
 *
 * Number facade (nextU32/nextFloat/int/pick/weighted/bool) never exposes bigint;
 * only `seed` and `state()` are bigint, so snapshot/restore round-trips via
 * makePrng(state()).
 */

/** splitmix64 increment constant (golden ratio · 2^64). FROZEN. */
export const SPLITMIX64_INCREMENT = 0x9e3779b97f4a7c15n
/** splitmix64 first multiplier. FROZEN. */
export const SPLITMIX64_MUL_1 = 0xbf58476d1ce4e5b9n
/** splitmix64 second multiplier. FROZEN. */
export const SPLITMIX64_MUL_2 = 0x94d049bb133111ebn
/** 64-bit mask (2^64 - 1). FROZEN. */
export const MASK64 = (1n << 64n) - 1n
/** 64-bit FNV-1a offset basis. FROZEN. DISTINCT from security.ts:382 (32-bit). */
export const FNV64_OFFSET = 0xcbf29ce484222325n
/** 64-bit FNV-1a prime. FROZEN. */
export const FNV64_PRIME = 0x100000001b3n

const TWO_POW_53 = 0x20000000000000n // 2^53
const U32_MASK = 0xffffffffn

/**
 * Typed error surface for the sim PRNG. A PLAIN Error subclass — never
 * StateMachineError / EnhancedStateMachineError (those bake Date.now()).
 */
export class SimError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SimError'
  }
}

/** splitmix64 finalizing mixer. FROZEN — shifts 30/27/31, multipliers as above. */
function splitmix64Mix(x: bigint): bigint {
  let z = x & MASK64
  z = ((z ^ (z >> 30n)) * SPLITMIX64_MUL_1) & MASK64
  z = ((z ^ (z >> 27n)) * SPLITMIX64_MUL_2) & MASK64
  z = z ^ (z >> 31n)
  return z & MASK64
}

/** 64-bit FNV-1a over the UTF-16 code units of `s`. FROZEN. */
function fnv64(s: string): bigint {
  let h = FNV64_OFFSET
  for (let i = 0; i < s.length; i++) {
    h = (h ^ BigInt(s.charCodeAt(i))) & MASK64
    h = (h * FNV64_PRIME) & MASK64
  }
  return h & MASK64
}

/** 64-bit left-rotate. FROZEN. */
function rotl64(x: bigint, r: bigint): bigint {
  const v = x & MASK64
  return ((v << r) | (v >> (64n - r))) & MASK64
}

/** Seeded splitmix64 PRNG. See module doc for the FROZEN contract. */
export interface Prng {
  /** Original seed (bigint). */
  readonly seed: bigint
  /** Next unsigned 32-bit integer in [0, 2^32). */
  nextU32(): number
  /** Next float in [0,1). */
  nextFloat(): number
  /**
   * Uniform-ish integer in [0, maxExclusive). REJECTION-FREE 64-bit Lemire
   * multiply-high: int(n) = Number((next() * BigInt(n)) >> 64n). Exactly ONE
   * next() draw per call (accepts the negligible modulo bias).
   *
   * FREEZE NOTE: adding a rejection loop would change the draw count per call
   * and is a corpus-breaking change. Do NOT add one.
   *
   * @throws {SimError} when maxExclusive <= 0.
   */
  int(maxExclusive: number): number
  /** Uniform pick from a non-empty array. @throws {SimError} on empty. */
  pick<T>(xs: readonly T[]): T
  /**
   * Weighted pick. @throws {SimError} on empty or non-positive total weight.
   */
  weighted<T>(xs: readonly (readonly [T, number])[]): T
  /** Bernoulli draw; p defaults to 0.5. */
  bool(p?: number): boolean
  /**
   * Derive a child PRNG addressed by `label`. FROZEN combine:
   *   childSeed = splitmix64_mix((parent.state() ^ rotl64(fnv64(label),17n)) & MASK64)
   * Does NOT advance the parent (or siblings): reads parent.state() without
   * mutating it.
   */
  fork(label: string): Prng
  /** Post-increment 64-bit counter; round-trips via makePrng(state()). */
  state(): bigint
}

class SplitMix64Prng implements Prng {
  readonly seed: bigint
  private s: bigint

  constructor(seed: bigint) {
    this.seed = seed & MASK64
    this.s = this.seed
  }

  /** Core draw: advance the counter, mix, return the 64-bit result. */
  private next(): bigint {
    this.s = (this.s + SPLITMIX64_INCREMENT) & MASK64
    return splitmix64Mix(this.s)
  }

  state(): bigint {
    return this.s
  }

  nextU32(): number {
    return Number(this.next() & U32_MASK) >>> 0
  }

  nextFloat(): number {
    // 53-bit mantissa float in [0,1): take the top 53 bits of a 64-bit draw.
    return Number(this.next() >> 11n) / Number(TWO_POW_53)
  }

  int(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new SimError(`int(maxExclusive) requires a positive integer, got ${maxExclusive}`)
    }
    // REJECTION-FREE Lemire multiply-high — exactly ONE next() draw.
    return Number((this.next() * BigInt(maxExclusive)) >> 64n)
  }

  pick<T>(xs: readonly T[]): T {
    if (xs.length === 0) {
      throw new SimError('pick([]) on an empty array')
    }
    return xs[this.int(xs.length)] as T
  }

  weighted<T>(xs: readonly (readonly [T, number])[]): T {
    if (xs.length === 0) {
      throw new SimError('weighted([]) on an empty array')
    }
    let total = 0
    for (const [, w] of xs) {
      if (w < 0) {
        throw new SimError(`weighted() requires non-negative weights, got ${w}`)
      }
      total += w
    }
    if (total <= 0) {
      throw new SimError('weighted() requires a positive total weight')
    }
    // Draw a uniform integer in [0, total) when weights are integers; otherwise
    // scale the float draw. We use a single nextFloat() draw scaled by total to
    // keep one draw/call and avoid integer-only assumptions.
    let r = this.nextFloat() * total
    for (const [value, w] of xs) {
      r -= w
      if (r < 0) {
        return value
      }
    }
    // Floating-point fall-through: return the last entry (total guaranteed > 0).
    return xs[xs.length - 1]![0]
  }

  bool(p = 0.5): boolean {
    return this.nextFloat() < p
  }

  fork(label: string): Prng {
    // FROZEN combine — reads state() without advancing the parent.
    const childSeed = splitmix64Mix((this.s ^ rotl64(fnv64(label), 17n)) & MASK64)
    return new SplitMix64Prng(childSeed)
  }
}

/**
 * Construct a seeded PRNG.
 *
 * Canonical overload: `bigint | string` seed (the wire form is a STRING because
 * bigint is not JSON-able; a string seed is parsed as a bigint literal).
 *
 * Convenience overload: `number` seed VALIDATED to the integer range
 * [0, 2^53); throws {@link SimError} on NaN / Infinity / non-integer /
 * |seed| >= 2^53 / negative.
 */
export function makePrng(seed: bigint | string): Prng
export function makePrng(seed: number): Prng
export function makePrng(seed: bigint | string | number): Prng {
  if (typeof seed === 'bigint') {
    return new SplitMix64Prng(seed & MASK64)
  }
  if (typeof seed === 'string') {
    let parsed: bigint
    try {
      parsed = BigInt(seed)
    } catch {
      throw new SimError(`makePrng(string) requires a bigint-parseable seed, got ${JSON.stringify(seed)}`)
    }
    return new SplitMix64Prng(parsed & MASK64)
  }
  // number convenience — VALIDATED [0, 2^53).
  if (!Number.isFinite(seed)) {
    throw new SimError(`makePrng(number) requires a finite seed, got ${seed}`)
  }
  if (!Number.isInteger(seed)) {
    throw new SimError(`makePrng(number) requires an integer seed, got ${seed}`)
  }
  if (seed < 0) {
    throw new SimError(`makePrng(number) requires a non-negative seed, got ${seed}`)
  }
  if (seed >= Number(TWO_POW_53)) {
    throw new SimError(`makePrng(number) requires seed < 2^53, got ${seed}`)
  }
  return new SplitMix64Prng(BigInt(seed) & MASK64)
}
