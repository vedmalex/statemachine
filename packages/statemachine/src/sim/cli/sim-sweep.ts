/**
 * @module sim/cli/sim-sweep
 * @unstable
 *
 * Step-11 (D) — the seed-sweep entry (`sim:sweep`), invoked by
 * `.github/workflows/sim-nightly.yml` (event-driven since TASK-016: push to
 * main + workflow_dispatch, no cron — the file name is kept for run-history
 * continuity) as `SM_SIM=1 SIM_SHARD=k SIM_SHARDS=8 npm run sim:sweep`.
 *
 * Mechanism (build-plan Step 11 D):
 *  - Enumerate a CONCRETE candidate seed window `[0, SIM_SWEEP_SEEDS)` (NOT the
 *    unbounded 64-bit space — the shard partition must be exactly enumerable so the
 *    `sweep-shard.test.ts` partition check is falsifiable).
 *  - Keep only `seed % SIM_SHARDS === SIM_SHARD` (the deterministic shard mask).
 *  - For each sharded seed: generate the Step-4 scenario, run it through the SHARED
 *    Step-3/4 `runScenario` (the SOLE `settleMacrostep` owner) and the Step-6
 *    `runSafety` oracle — first asserting I-1 (replay bit-exactness) so a
 *    non-deterministic scenario is itself a finding.
 *  - On a violation: invoke the Step-7 `shrink` and write
 *    `.sim-out/<seed>.repro.json` + `.sim-out/<seed>.repro.test.ts` (the re-failing
 *    minimized repro) — these are the artifacts the nightly `upload-artifact@v4
 *    if: failure()` step ships.
 *
 * Determinism: no `Math.random`/`Date.now`/`performance.now`/real `setTimeout` on
 * any path; the shrink budget's `nowMs` defaults to a monotonic counter. The only
 * I/O is writing the repro artifacts under `.sim-out/` (git-ignored).
 *
 * This module is sim-only and lives under `src/sim/cli/` — it is NOT part of the
 * public `./sim` barrel (it is a node-invoked script, re-exported from
 * `src/sim/index.ts` only for knip value-reachability).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildConfigGraph, makeViolation } from '../invariants'
import { runSafety } from '../invariants.runner'
import { INVARIANTS } from '../invariants'
import type { CheckerContext } from '../invariants'
import type { Violation } from '../invariants'
import { generateScenario, runScenario, toEngineConfig } from '../define'
import type { ScenarioSpec } from '../scenario'
import { hashTrace } from '../trace'
import { emitRepro } from '../repro-codegen'
import { shrink } from '../shrinker'
import type { ShrinkRunner } from '../shrinker'

/** Default size of the concrete candidate seed window the nightly partitions. */
export const DEFAULT_SWEEP_SEEDS = 256

/** Number of shards the nightly fans out (matches `strategy.matrix.shard:[0..7]`). */
export const DEFAULT_SWEEP_SHARDS = 8

/** Directory (package-root-relative) the repro artifacts are written under. */
export const SIM_OUT_DIR = '.sim-out'

/** One sweep run's outcome for a single seed. */
export interface SweepSeedResult {
  readonly seed: bigint
  /** The first-violation the oracle found (null = clean). */
  readonly violation: Violation | null
  /** Absolute paths of the repro artifacts written (empty when clean). */
  readonly reproFiles: readonly string[]
}

/**
 * The set of seeds in `[0, total)` belonging to `shard` of `shards`. Pure and
 * exactly enumerable — the partition property (no overlap, no gap, union ===
 * `[0,total)`) is the falsifiable `sweep-shard.test.ts` check.
 */
export function shardSeeds(total: number, shard: number, shards: number): bigint[] {
  if (!Number.isInteger(shards) || shards <= 0) {
    throw new Error(`SIM_SHARDS must be a positive integer, got ${shards}`)
  }
  if (!Number.isInteger(shard) || shard < 0 || shard >= shards) {
    throw new Error(`SIM_SHARD must be in [0, ${shards}), got ${shard}`)
  }
  const out: bigint[] = []
  for (let s = 0; s < total; s++) {
    if (s % shards === shard) {
      out.push(BigInt(s))
    }
  }
  return out
}

/**
 * Run ONE seed: generate, assert I-1 (two runs same hash), run the safety oracle.
 * Returns the first violation or null. Pure aside from the two `runScenario`
 * settle passes (which own the sole `settleMacrostep`).
 */
export async function runSeedSafety(seed: bigint): Promise<{ spec: ScenarioSpec; violation: Violation | null }> {
  const spec = await generateScenario(seed)
  const traceA = await runScenario(spec)
  const traceB = await runScenario(spec)
  const hashA = hashTrace(traceA)
  const hashB = hashTrace(traceB)
  if (hashA !== hashB) {
    // I-1 (replay bit-exactness) failed — synthesize a determinism violation so the
    // sweep treats non-determinism as a first-class finding (never a silent pass).
    const determinism = makeViolation({
      invariantId: 'I-1',
      step: 0,
      witness: `${hashA}!=${hashB}`,
      message: 'seed is non-deterministic across two runs',
      observed: `${hashA} vs ${hashB}`,
      expected: 'identical traceHash',
    })
    return { spec, violation: determinism }
  }
  const engineConfig = toEngineConfig(spec.topology)
  const ctx: CheckerContext = { graph: buildConfigGraph(engineConfig), header: traceA.header }
  const violation = runSafety(INVARIANTS, traceA, ctx)
  return { spec, violation }
}

/**
 * Write the Step-7 minimized repro (`<seed>.repro.json` + `<seed>.repro.test.ts`)
 * for a violated seed under `outDir`. Returns the absolute paths written.
 *
 * `runner` is the SOLE settle surface the shrinker calls; it defaults to the
 * Step-7 `defaultShrinkRunner` (runScenario + runSafety). Tests inject a synthetic
 * runner so a planted violation is deterministic and fast.
 */
export async function writeRepro(
  spec: ScenarioSpec,
  target: Violation,
  packageVersion: string,
  outDir: string,
  runner?: ShrinkRunner,
): Promise<string[]> {
  const shrunk = runner !== undefined ? await shrink(spec, target, { runner }) : await shrink(spec, target)
  const { record, testSource } = emitRepro(shrunk, packageVersion)
  mkdirSync(outDir, { recursive: true })
  const jsonPath = resolve(outDir, `${spec.seed}.repro.json`)
  const testPath = resolve(outDir, `${spec.seed}.repro.test.ts`)
  writeFileSync(jsonPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  writeFileSync(testPath, testSource, 'utf8')
  return [jsonPath, testPath]
}

/** Options for {@link sweepMain} (env-derived in the CLI epilogue). */
export interface SweepOptions {
  readonly shard: number
  readonly shards: number
  readonly totalSeeds: number
  readonly packageVersion: string
  readonly outDir: string
}

/**
 * Nightly sweep entry. Runs every sharded seed through the safety oracle; on a
 * violation, writes the minimized repro artifacts. Returns the process exit code
 * (0 = the whole shard was clean, 1 = at least one seed violated). On a violation
 * the repro files are left under `outDir` for `upload-artifact`.
 */
export async function sweepMain(opts: SweepOptions): Promise<number> {
  const seeds = shardSeeds(opts.totalSeeds, opts.shard, opts.shards)
  let violations = 0
  const results: SweepSeedResult[] = []
  for (const seed of seeds) {
    const { spec, violation } = await runSeedSafety(seed)
    if (violation === null) {
      results.push({ seed, violation: null, reproFiles: [] })
      continue
    }
    violations += 1
    const reproFiles = await writeRepro(spec, violation, opts.packageVersion, opts.outDir)
    results.push({ seed, violation, reproFiles })
    console.error(
      `✗ seed ${seed} violated ${violation.invariantId} (witness=${violation.witness}) — repro at ${reproFiles[0]}`,
    )
  }
  console.log(
    `sim:sweep shard ${opts.shard}/${opts.shards}: ${seeds.length} seeds, ${violations} violation(s)`,
  )
  return violations > 0 ? 1 : 0
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
 * Env-driven entry (invoked by the `sim:sweep` vitest runner — the package has no
 * `tsx`/`ts-node`, so every sim CLI runs THROUGH vitest). Reads
 * `SIM_SHARD`/`SIM_SHARDS`/`SIM_SWEEP_SEEDS`, runs {@link sweepMain}, and RETURNS
 * the exit code (never calls `process.exit`). The nightly shard fails iff the
 * runner test fails; the repro artifacts are left under `.sim-out/` for upload.
 */
export async function runSweep(): Promise<number> {
  return sweepMain({
    shard: envInt('SIM_SHARD', 0),
    shards: envInt('SIM_SHARDS', DEFAULT_SWEEP_SHARDS),
    totalSeeds: envInt('SIM_SWEEP_SEEDS', DEFAULT_SWEEP_SEEDS),
    packageVersion: process.env.npm_package_version ?? '0.0.0-dev',
    outDir: resolve(process.cwd(), SIM_OUT_DIR),
  })
}
