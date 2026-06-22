import { describe, expect, it } from 'vitest'
import { runSweep } from '../../sim/cli/sim-sweep'

/**
 * Step-11 (D) — the `sim:sweep` RUNNER for the NIGHTLY workflow. The package has
 * no `tsx`/`ts-node`, so the shard sweep runs THROUGH vitest. The nightly step
 * `SM_SIM=1 SIM_SHARD=k SIM_SHARDS=8 npm run sim:sweep` invokes this file; a
 * violated seed makes the sweep return non-zero, failing the test (and the shard),
 * and leaves `.sim-out/<seed>.repro.{json,test.ts}` for `upload-artifact`.
 *
 * GATED behind SM_SIM: it never runs on the default `npm test` leg. By default
 * (no `SIM_SHARD`) it would sweep shard 0 of the full window — that is the nightly
 * contract; the unit-level partition/repro behavior is asserted by
 * `sweep-shard.test.ts` and `repro-artifact.test.ts` (which run quickly).
 */
const GATED = !!process.env.SM_SIM

describe.skipIf(!GATED)('Step 11 — sim:sweep nightly shard runner (SM_SIM=1)', () => {
  it('the sharded seed sweep returns 0 when no seed violates an invariant', async () => {
    const code = await runSweep()
    expect(code, 'a sweep violation leaves a repro under .sim-out/').toBe(0)
  }, 300_000)
})
