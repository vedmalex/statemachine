import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SWEEP_SEEDS,
  DEFAULT_SWEEP_SHARDS,
  shardSeeds,
} from '../../sim/cli/sim-sweep'

/**
 * Step-11 (D) — the shard partition check (DoD 8). The nightly fans out over a
 * CONCRETELY-ENUMERATED candidate seed window `[0, total)` (NOT the unbounded
 * 64-bit space), so the partition property is falsifiable: every seed lands in
 * exactly ONE shard (no overlap, no gap, union === the whole window).
 *
 * UNGATED + cheap (pure arithmetic over the seed window — no engine run).
 */

describe('Step 11 — sweep shard partition (DoD 8)', () => {
  const total = DEFAULT_SWEEP_SEEDS
  const shards = DEFAULT_SWEEP_SHARDS

  it(`partitions [0, ${total}) across ${shards} shards with no overlap and no gap`, () => {
    const union = new Set<string>()
    let count = 0
    for (let k = 0; k < shards; k++) {
      const slice = shardSeeds(total, k, shards)
      for (const seed of slice) {
        const key = seed.toString()
        expect(union.has(key), `seed ${key} appears in more than one shard (overlap)`).toBe(false)
        union.add(key)
        count += 1
        // Every seed in shard k satisfies the deterministic mask.
        expect(Number(seed) % shards, `seed ${key} not in shard ${k}`).toBe(k)
      }
    }
    // No gap: the union is exactly the candidate window.
    expect(count).toBe(total)
    expect(union.size).toBe(total)
    for (let s = 0; s < total; s++) {
      expect(union.has(String(s)), `seed ${s} missing from the partition (gap)`).toBe(true)
    }
  })

  it('the per-shard slice for shard 0 is exactly the multiples of the shard count', () => {
    const slice = shardSeeds(total, 0, shards)
    expect(slice).toEqual(
      Array.from({ length: Math.ceil(total / shards) }, (_, i) => BigInt(i * shards)).filter(
        (s) => Number(s) < total,
      ),
    )
  })

  it('rejects an out-of-range shard or a non-positive shard count', () => {
    expect(() => shardSeeds(total, shards, shards)).toThrow(/SIM_SHARD must be in/)
    expect(() => shardSeeds(total, -1, shards)).toThrow(/SIM_SHARD must be in/)
    expect(() => shardSeeds(total, 0, 0)).toThrow(/SIM_SHARDS must be a positive integer/)
  })

  it('a smaller concrete window (e.g. [0,16) over 4 shards) also partitions cleanly', () => {
    const seen = new Set<string>()
    for (let k = 0; k < 4; k++) {
      for (const seed of shardSeeds(16, k, 4)) {
        expect(seen.has(seed.toString())).toBe(false)
        seen.add(seed.toString())
      }
    }
    expect(seen.size).toBe(16)
  })
})
