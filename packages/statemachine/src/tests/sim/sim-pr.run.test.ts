import { describe, expect, it } from 'vitest'
import { runPrGate } from '../../sim/cli/sim-pr'

/**
 * Step-11 (B) — the `sim:pr` RUNNER. The package has no `tsx`/`ts-node`, so the
 * PR-fast gate runs THROUGH vitest (matching `sim:coverage`/`sim:perf`). The
 * node-20 ci.yml step `SM_SIM=1 SIM_SEEDS=64 SIM_STEPS=200 npm run sim:pr` invokes
 * this file; a non-zero gate exit code FAILS the test, which fails the node-20 leg.
 *
 * GATED behind SM_SIM (build-plan §11A): the default `npm test` SKIPS it (it is a
 * heavy bounded sweep, not a determinism-floor test). The light determinism-floor
 * tests (prng golden, AC-1 canary, public surface, capability totality, ISS-033
 * pins) stay UNGATED in their own files.
 */
const GATED = !!process.env.SM_SIM

describe.skipIf(!GATED)('Step 11 — sim:pr PR-fast gate (SM_SIM=1)', () => {
  it('the bounded safety+liveness+coverage+perf-smoke gate exits 0 on a clean tree', async () => {
    const result = await runPrGate()
    expect(result.exitCode, result.report).toBe(0)
    // The async-action witness (ISS-030) MUST be present so an inFlightAsyncCount
    // regression would fail this leg.
    expect(result.asyncWitness.found, 'ISS-030 async-action witness must exist').toBe(true)
    expect(result.asyncWitness.deterministic).toBe(true)
    // The coverage gate's own exit code folds in (uncovered/drift => non-zero).
    expect(result.coverage.exitCode).toBe(0)
    // Perf SMOKE is a determinism check only (no threshold).
    expect(result.perfSmoke.ok).toBe(true)
  }, 120_000)
})
