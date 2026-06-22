/**
 * @module sim/cli/sim-coverage
 * @unstable
 *
 * The ADR-8 CAPABILITY-coverage gate (`sim:coverage`). This is the AC-8 gate: it
 * runs {@link computeCoverage} over the registered {@link COVERAGE_SCENARIOS} and
 * fails (non-zero) ONLY when a NON-gap `CapabilityId` has zero covering scenarios
 * OR a scenario's declared `expects` probe never fired (drift). It is the
 * errorClass-keyed, registry-coverage gate — NOT a vitest line/branch coverage
 * threshold.
 *
 * Why a CLI (not `vitest run --coverage`): `vitest run --coverage` enables the v8
 * GLOBAL 90% line/branch/function threshold over `coverage.include=['src/**\/*.ts']`,
 * which is measured against the CORE engine files (`state_machine.ts`,
 * `config_validator.ts`, …). One coverage test file can never satisfy that, so the
 * `--coverage` wiring conflated ADR-8 CAPABILITY coverage (the real gate) with
 * unrelated vitest LINE coverage and always exited 1. This CLI restores the ADR-8
 * intent: the only failure signal is uncovered-capability or drift.
 *
 * Determinism: `computeCoverage` runs each scenario twice and throws
 * {@link CoverageDeterminismError} on divergence BEFORE counting; no
 * `Math.random`/`Date.now`/`performance.now`/real `setTimeout`.
 *
 * Invocation: the package has no `tsx`/`ts-node`, so every sim CLI runs THROUGH
 * vitest (matching `sim:pr`/`sim:sweep`/`sim:perf`). The `sim:coverage` runner
 * (`src/tests/sim/sim-coverage.run.test.ts`) imports {@link runCoverageGate} and
 * fails the test — hence the script — iff `exitCode !== 0`. Lives under
 * `src/sim/cli/` (node-invoked, NOT public-barrel surface; declared as a knip
 * value-reachability entry alongside `sim-pr`/`sim-sweep`).
 */

import { type CoverageResult, computeCoverage, formatCoverageReport } from '../coverage'
import { capabilityKeys } from '../capabilities'
import { COVERAGE_SCENARIOS } from '../scenarios/index'

/** Aggregate `sim:coverage` gate outcome. */
export interface CoverageGateResult {
  readonly coverage: CoverageResult
  /** 0 = full non-gap registry covered with zero drift; non-zero otherwise. */
  readonly exitCode: number
  /** Human report (empty string on a clean gate). */
  readonly report: string
}

/**
 * Run the ADR-8 capability-coverage gate over {@link COVERAGE_SCENARIOS}. Returns
 * the aggregate (the underlying {@link CoverageResult}, the process exit code, and
 * a human report). The gate fails (non-zero) iff a NON-gap capability is uncovered
 * OR a declared `expects` drifted — never on vitest line coverage.
 *
 * Mirrors `runPrGate`/`runSweep`: returns the exit code, never calls
 * `process.exit`, so the vitest runner can assert on it.
 */
export async function runCoverageGate(): Promise<CoverageGateResult> {
  const coverage = await computeCoverage(COVERAGE_SCENARIOS)
  console.log(`sim:coverage — ${coverage.covered.size} covered / ${capabilityKeys().length} total`)
  const report = coverage.exitCode === 0 ? '' : formatCoverageReport(coverage)
  if (report !== '') {
    console.error(report)
  }
  return { coverage, exitCode: coverage.exitCode, report }
}
