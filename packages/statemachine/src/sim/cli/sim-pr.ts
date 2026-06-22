/**
 * @module sim/cli/sim-pr
 * @unstable
 *
 * Step-11 (B) — the PR-FAST gate (`sim:pr`), appended to the ci.yml `tier-a-node`
 * job as a node-20-ONLY step:
 * `SM_SIM=1 SIM_SEEDS=64 SIM_STEPS=200 npm run sim:pr`.
 *
 * It runs a BOUNDED determinism-floor budget that must stay fast enough for the
 * PR leg (no nightly-scale sweep, no perf-regression thresholds):
 *  1. SAFETY+LIVENESS budget over `SIM_SEEDS` fixed seeds — each scenario asserts
 *     I-1 (replay bit-exactness) FIRST, then the Step-6 safety oracle. An I-1 or
 *     safety violation fails the gate.
 *  2. An ISS-030 async-action WITNESS seed: a scenario carrying an opaque/async
 *     invoke action is run so an `inFlightAsyncCount` settledness regression (a
 *     premature-quiescence bug) fails the node-20 gate (build-plan Step 11 B
 *     [FOLD conform-11 LOW]).
 *  3. COVERAGE gate (`computeCoverage`) — non-zero with a legible report when a
 *     `CAPABILITIES` id has zero covering scenarios OR an `expects` drifts. The
 *     report POSITIVELY emits the string-method `error.*-throw`/`abortOnExitError`
 *     residual (ISS-029 CI-enforcement half).
 *  4. PERF SMOKE — runs ONE scenario and asserts ONLY (a) it completes without
 *     error and (b) `traceLen` matches across two runs (zero-tolerance determinism
 *     check). NEVER a throughput/heap/p99 threshold (the regression band lives in
 *     the nightly, avoiding slow-runner flake — build-plan Step 11 B/E).
 *
 * Determinism: no `Math.random`/`Date.now`/`performance.now`/real `setTimeout`.
 * Lives under `src/sim/cli/` (node-invoked, NOT public-barrel surface; re-exported
 * from `src/sim/index.ts` only for knip value-reachability).
 */

import { buildConfigGraph } from '../invariants'
import { runSafety } from '../invariants.runner'
import { INVARIANTS } from '../invariants'
import type { CheckerContext } from '../invariants'
import type { Violation } from '../invariants'
import { computeCoverage, formatCoverageReport } from '../coverage'
import type { CoverageResult } from '../coverage'
import { COVERAGE_SCENARIOS } from '../scenarios/index'
import { generateScenario, runScenario, toEngineConfig } from '../define'
import type { ScenarioSpec, StateSpec } from '../scenario'
import { hashTrace } from '../trace'

/** Default fixed-seed count for the PR safety+liveness budget (override `SIM_SEEDS`). */
export const DEFAULT_PR_SEEDS = 64

/** One PR-budget seed outcome. */
export interface PrSeedResult {
  readonly seed: bigint
  readonly violation: Violation | null
  /** false when the two replay hashes diverged (I-1). */
  readonly deterministic: boolean
}

/**
 * Run the bounded SAFETY budget over `[0, seeds)`. Each seed asserts I-1
 * (two-run replay equality) before the safety oracle. Returns the per-seed
 * outcomes; the caller fails the gate if ANY is non-deterministic or violated.
 */
export async function runSafetyBudget(seeds: number): Promise<PrSeedResult[]> {
  const out: PrSeedResult[] = []
  for (let s = 0; s < seeds; s++) {
    const seed = BigInt(s)
    const spec = await generateScenario(seed)
    const traceA = await runScenario(spec)
    const traceB = await runScenario(spec)
    const deterministic = hashTrace(traceA) === hashTrace(traceB)
    let violation: Violation | null = null
    if (deterministic) {
      const ctx: CheckerContext = {
        graph: buildConfigGraph(toEngineConfig(spec.topology)),
        header: traceA.header,
      }
      violation = runSafety(INVARIANTS, traceA, ctx)
    }
    out.push({ seed, violation, deterministic })
  }
  return out
}

/**
 * True iff a scenario carries at least one async (opaque) invoke action. The
 * Step-4 generator emits async actions on `invoke.action` (the `inFlightAsyncCount`
 * settledness producing input); they live on states which may nest via
 * `regions`/`states`, so the walk is recursive.
 */
export function hasAsyncAction(spec: ScenarioSpec): boolean {
  const visit = (state: StateSpec): boolean => {
    for (const inv of state.invoke ?? []) {
      if (inv.action?.source.trimStart().startsWith('async')) {
        return true
      }
    }
    for (const region of Object.values(state.regions ?? {})) {
      for (const leaf of Object.values(region)) {
        if (visit(leaf)) {
          return true
        }
      }
    }
    for (const child of Object.values(state.states ?? {})) {
      if (visit(child)) {
        return true
      }
    }
    return false
  }
  for (const state of Object.values(spec.topology.states)) {
    if (visit(state)) {
      return true
    }
  }
  return false
}

/**
 * ISS-030 witness: find the FIRST seed in `[0, scan)` whose generated scenario
 * carries an async action and run it through the deterministic settle path. A
 * premature-quiescence (`inFlightAsyncCount`) regression makes the two replay
 * hashes diverge OR drops the async-action frame, failing the determinism check.
 * Returns true iff such a seed was found AND replayed deterministically.
 */
export async function runAsyncWitness(scan: number): Promise<{ found: boolean; deterministic: boolean; seed?: bigint }> {
  for (let s = 0; s < scan; s++) {
    const seed = BigInt(s)
    const spec = await generateScenario(seed)
    if (!hasAsyncAction(spec)) {
      continue
    }
    const a = hashTrace(await runScenario(spec))
    const b = hashTrace(await runScenario(spec))
    return { found: true, deterministic: a === b, seed }
  }
  return { found: false, deterministic: false }
}

/**
 * PERF SMOKE: run ONE fixed seed twice and assert ONLY that it completes and that
 * `traceLen` (frame count) is identical across runs. Zero-tolerance determinism;
 * never a throughput/heap/p99 threshold.
 */
export async function runPerfSmoke(seed: bigint): Promise<{ ok: boolean; traceLen: number }> {
  const spec = await generateScenario(seed)
  const lenA = (await runScenario(spec)).frames.length
  const lenB = (await runScenario(spec)).frames.length
  return { ok: lenA === lenB, traceLen: lenA }
}

/** Aggregate PR-gate outcome. */
export interface PrGateResult {
  readonly safety: readonly PrSeedResult[]
  readonly asyncWitness: { found: boolean; deterministic: boolean; seed?: bigint }
  readonly coverage: CoverageResult
  readonly perfSmoke: { ok: boolean; traceLen: number }
  readonly exitCode: number
  readonly report: string
}

/**
 * Run the whole PR gate. Returns the aggregate (including a human report and the
 * process exit code). The gate fails (non-zero) when ANY of: a non-deterministic
 * or violated safety seed; the async witness was not found or replayed
 * non-deterministically; the coverage gate's own exitCode is non-zero; or the
 * perf smoke's traceLen diverged.
 */
export async function prGateMain(opts: { seeds: number }): Promise<PrGateResult> {
  const safety = await runSafetyBudget(opts.seeds)
  const asyncWitness = await runAsyncWitness(opts.seeds)
  const coverage = await computeCoverage(COVERAGE_SCENARIOS)
  const perfSmoke = await runPerfSmoke(0n)

  const lines: string[] = []
  let exitCode = 0

  const badSeeds = safety.filter((r) => !r.deterministic || r.violation !== null)
  if (badSeeds.length > 0) {
    exitCode = 1
    for (const r of badSeeds) {
      if (!r.deterministic) {
        lines.push(`NON-DETERMINISTIC seed ${r.seed} — two runs diverged (I-1)`)
      } else if (r.violation !== null) {
        lines.push(`SAFETY seed ${r.seed} — ${r.violation.invariantId} (witness=${r.violation.witness})`)
      }
    }
  }

  if (!asyncWitness.found) {
    exitCode = 1
    lines.push('ISS-030 WITNESS MISSING — no async-action scenario in the scanned seed window')
  } else if (!asyncWitness.deterministic) {
    exitCode = 1
    lines.push(`ISS-030 WITNESS NON-DETERMINISTIC at seed ${asyncWitness.seed} — inFlightAsyncCount regression`)
  }

  if (coverage.exitCode !== 0) {
    exitCode = 1
    lines.push(formatCoverageReport(coverage))
  }

  if (!perfSmoke.ok) {
    exitCode = 1
    lines.push(`PERF SMOKE traceLen diverged across two runs (len=${perfSmoke.traceLen})`)
  }

  // POSITIVE emission of the ISS-029 string-method residual (always reported, not
  // only on failure) so the node-20 log shows the honest n/a status.
  const residual = (['error.guard-throw', 'error.action-throw', 'error.recovery.abortOnExitError'] as const)
    .map((id) => `${id}=${coverage.status.get(id) ?? 'unknown'}`)
    .join(' ')
  lines.push(`ISS-029 string-method residual: ${residual}`)

  return { safety, asyncWitness, coverage, perfSmoke, exitCode, report: lines.join('\n') }
}

/** Parse a base-10 env integer with a default. */
function envInt(name: string, dflt: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') {
    return dflt
  }
  const n = Number.parseInt(raw, 10)
  if (!Number.isInteger(n)) {
    throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`)
  }
  return n
}

/**
 * Env-driven entry (invoked by the `sim:pr` vitest runner — the package has no
 * `tsx`/`ts-node`, so every sim CLI runs THROUGH vitest, matching `sim:coverage`/
 * `sim:perf`). Reads `SIM_SEEDS`, runs {@link prGateMain}, prints the report, and
 * RETURNS the exit code (never calls `process.exit`, so the vitest runner can
 * assert on it). The node-20 CI leg fails iff the runner test fails.
 */
export async function runPrGate(): Promise<PrGateResult> {
  const result = await prGateMain({ seeds: envInt('SIM_SEEDS', DEFAULT_PR_SEEDS) })
  console.log(
    `sim:pr — ${result.safety.length} seeds, coverage ${result.coverage.covered.size} covered, perf-smoke traceLen=${result.perfSmoke.traceLen}`,
  )
  if (result.report !== '') {
    const sink = result.exitCode === 0 ? console.log : console.error
    sink(result.report)
  }
  return result
}
