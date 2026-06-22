import { describe, expect, it } from 'vitest'
import { runCoverageGate } from '../../sim/cli/sim-coverage'

/**
 * AC-8 — the `sim:coverage` RUNNER. The package has no `tsx`/`ts-node`, so the
 * ADR-8 capability-coverage gate runs THROUGH vitest (matching
 * `sim:pr`/`sim:sweep`/`sim:perf`). The `sim:coverage` script
 * (`SM_SIM=1 vitest run src/tests/sim/sim-coverage.run.test.ts`) invokes this
 * file; a non-zero gate exit code FAILS the test, which fails the script.
 *
 * This is the CAPABILITY-coverage gate (errorClass-keyed registry coverage), NOT a
 * vitest line/branch threshold — the prior `vitest run --coverage` wiring measured
 * the v8 global 90% line threshold against the core engine files and always exited
 * 1. The pure-logic registry-coverage assertions (drift, string-method honesty,
 * probe purity, gap-set partition) live UNGATED in `coverage.test.ts`; this runner
 * is the script-level gate exit-code mirror, gated behind SM_SIM like the other
 * sim CLIs so the default `npm test` leg does not double-run it.
 */
const GATED = !!process.env.SM_SIM

describe.skipIf(!GATED)('AC-8 — sim:coverage ADR-8 capability gate (SM_SIM=1)', () => {
  it('the capability-coverage gate exits 0 (full non-gap registry covered, zero drift)', async () => {
    const result = await runCoverageGate()
    expect(result.exitCode, result.report).toBe(0)
    // Fold the underlying gate signals in explicitly so an uncovered/drift
    // regression fails legibly, not just via the exit code.
    expect(result.coverage.uncovered.size, result.report).toBe(0)
    expect(result.coverage.drift.size, result.report).toBe(0)
    expect(result.coverage.exitCode).toBe(0)
  }, 120_000)
})
