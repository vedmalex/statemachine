/**
 * @module sim/perf-run
 * @unstable
 *
 * Step-8 runnable perf entry (CLI). Wired into `package.json` as `sim:perf`
 * (READ + gate) and `sim:perf:baseline` (refresh, requires `SM_PERF_UPDATE_BASELINE=1`).
 * The node-20 perf leg invokes node with `--expose-gc` so the memory band can
 * actually gate (ISS-032's heap medians become enforceable).
 *
 * This is a thin orchestrator over {@link runPerf} / {@link loadPerfBaseline} /
 * {@link evaluatePerfBands} / {@link maybeWriteBaseline} — all the perf logic
 * lives in `metrics.ts`. The harness drives the SAME Step-4 generated scenarios
 * through the Step-3 driver's sole `settleMacrostep`; nothing here touches the
 * hash plane.
 */

import { resolve } from 'node:path'
import { DEFAULT_BOUNDS } from './define'
import {
  type BandResult,
  type PerfReport,
  evaluatePerfBands,
  isGcExposed,
  loadPerfBaseline,
  maybeWriteBaseline,
  runPerf,
} from './metrics'

/** The fixed perf seed set whose Step-4 generated scenarios make up one batch. */
export const PERF_SEEDS: readonly bigint[] = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]

/** Default path of the committed baseline relative to the package root. */
export const PERF_BASELINE_PATH = resolve(process.cwd(), 'etc/sim-perf.baseline.json')

/** Render one band result as a single human line. */
function formatBand(b: BandResult): string {
  return `${b.metric.padEnd(11)} ${b.status.padEnd(8)} baseline=${b.baseline} observed=${b.observed} band=${b.band}`
}

/**
 * Run the perf harness and either refresh the baseline (`update`) or gate against
 * it (`gate`). Returns the process exit code (0 = pass/updated, non-zero = a
 * GATING band failed).
 */
export async function perfMain(mode: 'gate' | 'update', baselinePath = PERF_BASELINE_PATH): Promise<number> {
  const report: PerfReport = await runPerf({ seeds: PERF_SEEDS, bounds: DEFAULT_BOUNDS })

  if (mode === 'update') {
    const wrote = maybeWriteBaseline(baselinePath, report)
    if (!wrote) {
      console.error('sim:perf:baseline requires SM_PERF_UPDATE_BASELINE=1 to write the baseline')
      return 2
    }
    console.log(`refreshed perf baseline at ${baselinePath} (gc exposed: ${isGcExposed()})`)
    return 0
  }

  const baseline = loadPerfBaseline(baselinePath)
  const bands = evaluatePerfBands(report, baseline)
  console.log(`perf gate (gc exposed: ${isGcExposed()}):`)
  for (const b of bands) {
    console.log(`  ${formatBand(b)}`)
  }
  const failed = bands.filter((b) => b.status === 'fail')
  return failed.length === 0 ? 0 : 1
}
