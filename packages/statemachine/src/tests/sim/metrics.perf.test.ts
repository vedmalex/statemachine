/**
 * Step-8 HEAVY perf run — ENV-GATED out of the default include.
 *
 * The whole suite is `describe.skipIf(!process.env.SM_SIM)`, so the default
 * `npm test` / `vitest run` skips it (no heavy load on the PR-fast leg). It runs
 * only when `SM_SIM=1` (the node-20 perf leg sets `SM_SIM=1` + `--expose-gc` so
 * the memory band actually gates). The two `package.json` scripts drive it:
 *   - `sim:perf`          → gate against the committed baseline.
 *   - `sim:perf:baseline` → refresh the committed baseline (SM_PERF_UPDATE_BASELINE=1).
 *
 * This exercises the runnable {@link perfMain} entry over the SAME `runPerf`/
 * `loadPerfBaseline`/`evaluatePerfBands` plane the unit tests cover; the gating
 * verdict is asserted here under real load.
 */

import { describe, expect, it } from 'vitest'
import { PERF_BASELINE_PATH, perfMain } from '../../sim/perf-run'

const GATED = process.env['SM_SIM'] === '1'

describe.skipIf(!GATED)('Step 8 — heavy perf run (SM_SIM=1)', () => {
  it('perfMain runs and returns a numeric exit code (gate or update)', async () => {
    const mode = process.env['SM_PERF_UPDATE_BASELINE'] === '1' ? 'update' : 'gate'
    const code = await perfMain(mode, PERF_BASELINE_PATH)
    expect(typeof code).toBe('number')
    // In gate mode a green run must return 0; in update mode 0 means the baseline
    // was refreshed (SM_PERF_UPDATE_BASELINE=1 is set by the baseline script).
    expect(code).toBe(0)
  })
})
