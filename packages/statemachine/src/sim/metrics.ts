/**
 * @module sim/metrics
 * @unstable
 *
 * ADR-1/3/4/7 Step-8 perf/load metrics plane: a STRUCTURALLY-WALLED-OFF second
 * sink that runs the REAL engine under the SAME {@link settleMacrostep} (Step 3)
 * + SAME deterministic DI (Step 2), emitting {@link PerfSample}/{@link PerfReport}.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THE WALL (ADR-1, hard invariant). This module is a SECOND sink. It MUST NEVER
 * feed {@link hashTrace}. Proof obligations:
 *   - `metrics.ts` has NO import of any hashed field INTO the trace plane; it
 *     only READS the canonical trace (`traceLen` = `trace.frames.length`,
 *     never recomputed, never written back).
 *   - `trace.ts` has NO import from `metrics.ts` (the dependency points one way:
 *     metrics READS trace, trace never sees metrics).
 *   - the perf fields (`wallNs`/`heap*`/`latency`/`gcProxy`/…) appear ONLY on
 *     {@link PerfSample}/{@link PerfReport}; a {@link TraceFrame} cannot carry
 *     them (the closed schema rejects them at compile time — a negative tsc
 *     fixture in metrics.test.ts pins this).
 *
 * THROUGHPUT (PRIMARY, UNFAKED). `process.hrtime.bigint()` is NOT in
 * `vitest.config.ts` `toFake` (which fakes only the setTimeout/clear-timer/Date
 * family), so wall-clock-via-hrtime survives faked Date. `eventsPerSec = eventsProcessed /
 * (Number(wallNs)/1e9)`.
 *
 * LATENCY (ADVISORY, 'ms-coarse'). Sourced from the Step-2 {@link SimMonitor}
 * non-hashed `getDurations()` accumulator — metrics adds NO new method to
 * SimMonitor and NO new engine method. Under vitest's faked Date the engine
 * `Date.now()` transition-duration delta (state_machine.ts:2047/2059) is
 * structurally 0 for all transitions (faked Date does not advance across sync
 * code or microtasks), so latency p50..p99 are all 0 there. The COMMITTED
 * baseline p99 MUST be measured on a real-timer leg so baseline p99 > 0; the
 * p99 band arithmetic is N/A for a zero/near-zero baseline (no divide-by-zero).
 *
 * HEAP + gcProxy (UNFAKED, node-guarded). `process.memoryUsage().heapUsed` at
 * batch boundaries; `gcProxy` = net retained-heap growth per event. `global.gc?.()`
 * is called before the heap baseline IF available; absent `--expose-gc` the
 * memory band DOWNGRADES to advisory (never throws).
 *
 * DRIVE LOOP (R2). The perf run drives the SAME Step-4 generated scenarios via
 * the Step-3 {@link SimDriver}, whose sole settle path is {@link settleMacrostep}.
 * This module never calls a settle helper directly and contains no bespoke
 * micro-drain loop (the source-grep DoD over this file is negative for the
 * forbidden settle-helper tokens).
 * ──────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { hrtime, memoryUsage } from 'node:process'
import { MemoryAdapter } from '../index'
import type { Adapter } from '../index'
import { makeSimClock } from './clock'
import { type GenOwner, SCENARIO_RUNTIME, generateScenario, makeOwner, toEngineConfig } from './define'
import { type DriverOp, SimDriver } from './driver'
import { makeObservableScheduler } from './env'
import { NoopLogger } from './noop-logger'
import { makePrng } from './prng'
import type { Bounds, Op, ScenarioSpec } from './scenario'
import { SimErrorHandler } from './sim-error-handler'
import { SimMonitor } from './sim-monitor'
import type { CanonicalTrace } from './trace'

/** Latency resolution tag. Only 'ms-coarse' exists (engine duration is `Date.now()` ms). */
export type LatencyResolution = 'ms-coarse'

/** Advisory latency distribution off the {@link SimMonitor} duration accumulator. */
export interface LatencyStats {
  readonly p50: number
  readonly p90: number
  readonly p99: number
  readonly max: number
  readonly mean: number
  readonly resolution: LatencyResolution
}

/**
 * One perf measurement. `wallNs` is a bigint at runtime; it is serialized as a
 * DECIMAL STRING in the baseline JSON (bigint is not JSON-able — same rule as the
 * ADR-2 seed). NO field of this type is ever hashed (the wall, ADR-1).
 */
export interface PerfSample {
  /** process.hrtime.bigint() ns over the batch. */
  readonly wallNs: bigint
  readonly eventsProcessed: number
  readonly transitionsObserved: number
  /** PRIMARY throughput: eventsProcessed / (Number(wallNs)/1e9). */
  readonly eventsPerSec: number
  readonly transitionsPerSec: number
  /** advisory; all-zero under any vi.useFakeTimers()-active leg. */
  readonly latency: LatencyStats
  readonly heapPeakBytes: number
  readonly heapAvgBytes: number
  readonly heapEndBytes: number
  readonly gcProxy: number
  /** READ from the Step-1 trace object; never recomputed; never hashed. */
  readonly traceLen: number
  /** sampled AFTER each settleMacrostep barrier; never reads private engine queues. */
  readonly queueDepthPeak: number
}

/** A perf report: a field-wise median-of-N over `raw` plus provenance. */
export interface PerfReport {
  readonly schemaVersion: 1
  readonly packageVersion: string
  readonly runtime: 'node' | 'bun'
  readonly node: string
  /** field-wise median-of-N=5. */
  readonly sample: PerfSample
  /** length === medianN (RUNTIME invariant — a DoD test asserts raw.length===5). */
  readonly raw: PerfSample[]
}

/**
 * FROZEN regression config (tech-spec §7). Bands are RELATIVE tolerances; the
 * gate fails when an observed metric drifts beyond its band against the committed
 * baseline. `traceLenTolerance: 0` is the determinism teeth — ANY frame-count
 * delta for the fixed seed is a regression.
 */
export const PERF_REGRESSION_CONFIG = {
  medianN: 5,
  bands: {
    /** PRIMARY; hrtime-sourced; gates ALWAYS. */
    throughputPct: 0.2,
    /** gates ONLY when global.gc present (--expose-gc); else advisory-downgrade. */
    memoryPct: 0.25,
    /** advisory; gates only when latencyGated && baseline.p99 > epsilon. */
    latencyP99Pct: 0.3,
    /** ZERO tolerance — any delta for the fixed seed is a determinism regression. */
    traceLenTolerance: 0,
  },
  /** ms; below this a baseline p99 is treated as zero/near-zero. */
  p99Epsilon: 1e-9,
} as const

/** The committed `etc/sim-perf.baseline.json` shape. */
export interface PerfBaselineFile {
  readonly schemaVersion: 1
  readonly packageVersion: string
  readonly runtime: 'node' | 'bun'
  readonly node: string
  readonly baseline: {
    /** decimal-string bigint. */
    readonly wallNs: string
    /** MUST be > 0 (loadPerfBaseline throws otherwise). */
    readonly eventsPerSec: number
    readonly transitionsPerSec: number
    readonly latency: {
      readonly p50: number
      readonly p90: number
      readonly p99: number
      readonly max: number
      readonly mean: number
      readonly resolution: 'ms-coarse'
    }
    readonly heapPeakBytes: number
    readonly heapAvgBytes: number
    readonly heapEndBytes: number
    readonly gcProxy: number
    readonly traceLen: number
    readonly queueDepthPeak: number
  }
  readonly gates: {
    /** true ONLY when measured on a real-timer leg (cannot be author-free). */
    readonly latencyGated: boolean
    /** true ONLY when global.gc was present at measurement. */
    readonly memoryGated: boolean
  }
}

/** Thrown by {@link loadPerfBaseline} on a committed-baseline VALIDATION failure. */
export class PerfBaselineValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PerfBaselineValidationError'
  }
}

/** Per-metric band evaluation result. */
export interface BandResult {
  readonly metric: 'throughput' | 'memory' | 'latencyP99' | 'traceLen'
  readonly status: 'pass' | 'fail' | 'advisory' | 'na'
  readonly baseline: number
  readonly observed: number
  /** the relative band (or absolute tolerance for traceLen) used for the verdict. */
  readonly band: number
}

// ── median + percentile helpers (pure; no clock, no random) ─────────────────

/** Median of a numeric list (lower-mid for even lengths — deterministic, no avg). */
function median(xs: readonly number[]): number {
  if (xs.length === 0) {
    return 0
  }
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor((sorted.length - 1) / 2)
  return sorted[mid] as number
}

/** Median of bigints, lower-mid for even lengths (deterministic). */
function medianBigint(xs: readonly bigint[]): bigint {
  if (xs.length === 0) {
    return 0n
  }
  const sorted = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const mid = Math.floor((sorted.length - 1) / 2)
  return sorted[mid] as bigint
}

/**
 * Nearest-rank percentile over a numeric sample (deterministic; no interpolation,
 * so a coarse-ms duration sample never invents a fractional value). `q` in [0,1].
 */
function percentile(xs: readonly number[], q: number): number {
  if (xs.length === 0) {
    return 0
  }
  const sorted = [...xs].sort((a, b) => a - b)
  const rank = Math.ceil(q * sorted.length)
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  return sorted[idx] as number
}

/** Build {@link LatencyStats} from the raw engine-supplied durations (ms). */
export function latencyStatsOf(durations: readonly number[]): LatencyStats {
  const mean = durations.length === 0 ? 0 : durations.reduce((a, b) => a + b, 0) / durations.length
  const max = durations.length === 0 ? 0 : durations.reduce((a, b) => Math.max(a, b), 0)
  return {
    p50: percentile(durations, 0.5),
    p90: percentile(durations, 0.9),
    p99: percentile(durations, 0.99),
    max,
    mean,
    resolution: 'ms-coarse',
  }
}

/**
 * Field-wise median-of-N over a list of {@link PerfSample}. Every numeric field is
 * reduced by {@link median}; `wallNs` by {@link medianBigint}; `latency` is taken
 * from the sample whose `wallNs` is the median (representative, not re-aggregated,
 * so the advisory distribution stays internally consistent).
 */
export function medianSample(samples: readonly PerfSample[]): PerfSample {
  if (samples.length === 0) {
    throw new Error('medianSample: empty sample list')
  }
  const wallNs = medianBigint(samples.map((s) => s.wallNs))
  // Representative latency = the latency of the sample carrying the median wallNs.
  const rep = samples.find((s) => s.wallNs === wallNs) ?? (samples[0] as PerfSample)
  return {
    wallNs,
    eventsProcessed: median(samples.map((s) => s.eventsProcessed)),
    transitionsObserved: median(samples.map((s) => s.transitionsObserved)),
    eventsPerSec: median(samples.map((s) => s.eventsPerSec)),
    transitionsPerSec: median(samples.map((s) => s.transitionsPerSec)),
    latency: rep.latency,
    heapPeakBytes: median(samples.map((s) => s.heapPeakBytes)),
    heapAvgBytes: median(samples.map((s) => s.heapAvgBytes)),
    heapEndBytes: median(samples.map((s) => s.heapEndBytes)),
    gcProxy: median(samples.map((s) => s.gcProxy)),
    traceLen: median(samples.map((s) => s.traceLen)),
    queueDepthPeak: median(samples.map((s) => s.queueDepthPeak)),
  }
}

// ── the perf harness ────────────────────────────────────────────────────────

/** Options for {@link runPerf}. */
export interface RunPerfOptions {
  /** Seeds whose Step-4 generated scenarios make up one batch. */
  readonly seeds: readonly bigint[]
  /** Generation bounds forwarded to {@link generateScenario}. */
  readonly bounds?: Bounds
  /** How many independent batches to measure (defaults to {@link PERF_REGRESSION_CONFIG.medianN}). */
  readonly medianN?: number
}

/** Map a frozen {@link Op} onto the Step-3 {@link DriverOp} the driver runs. */
function toDriverOp(op: Op): DriverOp | null {
  switch (op.kind) {
    case 'fire':
      return { kind: 'fire', event: op.event, args: op.args }
    case 'advance':
      return { kind: 'advance', dtMs: op.dtMs }
    case 'noop':
      return { kind: 'noop' }
    default:
      // snapshot/restore are not driven until the Simulator lands them (Step 10).
      return null
  }
}

/**
 * Drive ONE scenario through a perf-owned Step-3 {@link SimDriver} (so this
 * harness can read the {@link SimMonitor} `getDurations()` latency channel
 * WITHOUT a new engine method) and return its canonical trace + the engine-
 * supplied durations. The driver's ONLY settle path is {@link settleMacrostep};
 * this module never calls a settle helper directly and runs no bespoke drain.
 */
async function driveOneScenario(spec: ScenarioSpec): Promise<{ trace: CanonicalTrace; durations: readonly number[] }> {
  const seed = BigInt(spec.seed)
  const config = toEngineConfig<GenOwner>(spec.topology)
  const clock = makeSimClock(0)
  const { scheduler, view } = makeObservableScheduler(clock)
  const monitor = new SimMonitor()
  const driver = new SimDriver<GenOwner>({
    config,
    owner: new MemoryAdapter<GenOwner>(makeOwner(spec.topology)) as unknown as Adapter<GenOwner>,
    clock,
    scheduler: scheduler as { process(now?: number): void; isActive(): boolean; schedule(d: number, cb: () => void): object; cancel(t: object): void },
    schedulerView: view,
    monitor,
    errorHandler: new SimErrorHandler(),
    logger: NoopLogger,
    prng: makePrng(seed),
    runtime: SCENARIO_RUNTIME,
    // MANDATORY post-construction drain happens inside init(); 'liveness' lets the
    // driver jump the logical clock so armed timers / done.state joins actually run.
    policy: 'liveness',
  })
  await driver.init()
  for (const op of spec.ops) {
    const dop = toDriverOp(op)
    if (dop !== null) {
      await driver.step(dop)
    }
  }
  // getDurations() is the Step-2 NON-HASHED latency accumulator — the engine's
  // recordTransition(duration, success) values for SUCCESSES only (post-W4
  // refusals record success===false with duration 0 and are excluded, W4.1 LOW),
  // never reaching the hash plane.
  return { trace: driver.trace(), durations: monitor.getDurations() }
}

/**
 * Drive ONE batch (every seed's Step-4 generated scenario) and collect a single
 * {@link PerfSample}. Throughput is taken from `process.hrtime.bigint()` around
 * the whole batch (UNFAKED); latency is read from each run's {@link SimMonitor}
 * `getDurations()` (advisory). `traceLen` is READ from the canonical trace
 * (`frames.length`), never recomputed, never hashed.
 */
async function measureBatch(seeds: readonly bigint[], bounds: Bounds | undefined): Promise<PerfSample> {
  const specs = await Promise.all(seeds.map((s) => (bounds ? generateScenario(s, bounds) : generateScenario(s))))

  // Optional GC before the heap baseline so retained-heap deltas are meaningful.
  maybeGc()
  const heapStart = memoryUsage().heapUsed
  let heapPeak = heapStart
  let heapSamples = 0
  let heapSum = 0

  let eventsProcessed = 0
  let transitionsObserved = 0
  let traceLen = 0
  let queueDepthPeak = 0
  const durations: number[] = []

  const wallStart = hrtime.bigint()
  for (const spec of specs) {
    const { trace, durations: runDurations } = await driveOneScenario(spec)
    // traceLen is READ from the Step-1 trace object — never recomputed, never hashed.
    traceLen += trace.frames.length
    // eventsProcessed = the fire ops issued; transitionsObserved = frames carrying a (from!==to) write.
    eventsProcessed += spec.ops.filter((o) => o.kind === 'fire').length
    durations.push(...runDurations)
    for (const f of trace.frames) {
      if (f.from !== f.to) {
        transitionsObserved += 1
      }
      // queueDepthPeak: sampled from the per-frame settle-boundary queue snapshot
      // (recorded AFTER each settleMacrostep barrier by the Step-3 driver) — this
      // never reads the engine's private queues (zero core-ABI).
      const depth = f.queue.internal + f.queue.external
      if (depth > queueDepthPeak) {
        queueDepthPeak = depth
      }
    }
    // Heap sample at the batch's per-scenario boundary.
    const hu = memoryUsage().heapUsed
    heapSamples += 1
    heapSum += hu
    if (hu > heapPeak) {
      heapPeak = hu
    }
  }
  const wallNs = hrtime.bigint() - wallStart
  const heapEnd = memoryUsage().heapUsed

  // Latency = advisory 'ms-coarse' over the engine-supplied durations. Under
  // vitest's faked Date these are all 0 (the engine Date.now() delta does not
  // advance across sync/microtask code while Date is faked); on a real-timer leg
  // the distribution is non-zero. The harness NEVER gates on latency directly.
  const latency = latencyStatsOf(durations)

  const heapAvg = heapSamples === 0 ? heapStart : Math.round(heapSum / heapSamples)
  const gcProxy = eventsProcessed === 0 ? 0 : Math.round((heapEnd - heapStart) / eventsProcessed)
  const secs = Number(wallNs) / 1e9

  return {
    wallNs,
    eventsProcessed,
    transitionsObserved,
    eventsPerSec: secs > 0 ? eventsProcessed / secs : 0,
    transitionsPerSec: secs > 0 ? transitionsObserved / secs : 0,
    latency,
    heapPeakBytes: heapPeak,
    heapAvgBytes: heapAvg,
    heapEndBytes: heapEnd,
    gcProxy,
    traceLen,
    queueDepthPeak,
  }
}

/** Call `global.gc()` if it is exposed (`--expose-gc`); otherwise a no-op. */
function maybeGc(): void {
  const g = (globalThis as { gc?: () => void }).gc
  if (typeof g === 'function') {
    g()
  }
}

/** True iff `global.gc` is exposed (so the memory band can actually gate). */
export function isGcExposed(): boolean {
  return typeof (globalThis as { gc?: () => void }).gc === 'function'
}

/**
 * Run the perf harness: `medianN` independent batches, each batch driving every
 * seed's Step-4 generated scenario via {@link runScenario}, collecting a field-
 * wise median-of-N {@link PerfReport}.
 *
 * Pure side-effect set: reads `process.hrtime.bigint()` / `process.memoryUsage()`
 * / optional `global.gc` ONLY (no Math.random / Date.now / real timers anywhere).
 */
export async function runPerf(opts: RunPerfOptions): Promise<PerfReport> {
  const medianN = opts.medianN ?? PERF_REGRESSION_CONFIG.medianN
  const raw: PerfSample[] = []
  for (let i = 0; i < medianN; i++) {
    raw.push(await measureBatch(opts.seeds, opts.bounds))
  }
  return {
    schemaVersion: 1,
    packageVersion: PACKAGE_VERSION,
    runtime: 'node',
    node: process.version,
    sample: medianSample(raw),
    raw,
  }
}

/** Package version pinned into a {@link PerfReport}; read from the engine package. */
const PACKAGE_VERSION = '1.0.0-beta.3'

// ── baseline load + band evaluation ─────────────────────────────────────────

/**
 * Load + VALIDATE a committed perf baseline file. Throws
 * {@link PerfBaselineValidationError} (a committed-baseline VALIDATION failure,
 * never a silent N/A) under the TWO-SIDED non-zero-p99 rule (tech-spec §7):
 *  (a) latencyGated===true AND baseline.latency.p99 <= p99Epsilon — an all-zero
 *      gating p99 is invalid; AND
 *  (b) latencyGated===false AND baseline.latency.p99 > p99Epsilon — a real
 *      non-zero p99 with the band disabled is ALSO invalid (a measurement
 *      silently ignored); AND
 *  (c) baseline.eventsPerSec <= 0 — placeholder-zeros throughput is invalid.
 */
export function loadPerfBaseline(path: string): PerfBaselineFile {
  let parsed: PerfBaselineFile
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as PerfBaselineFile
  } catch (e) {
    throw new PerfBaselineValidationError(`perf baseline at ${path} is not readable/parseable: ${String(e)}`)
  }
  return validatePerfBaseline(parsed, path)
}

/** Validate an already-parsed baseline object (split out so tests can drive it). */
export function validatePerfBaseline(parsed: PerfBaselineFile, source = '<inline>'): PerfBaselineFile {
  const { p99Epsilon } = PERF_REGRESSION_CONFIG
  const p99 = parsed.baseline.latency.p99
  const latencyGated = parsed.gates.latencyGated
  // (c) placeholder-zeros throughput.
  if (parsed.baseline.eventsPerSec <= 0) {
    throw new PerfBaselineValidationError(
      `perf baseline ${source}: eventsPerSec must be > 0 (got ${parsed.baseline.eventsPerSec}); placeholder-zeros throughput is invalid`,
    )
  }
  // (a) gating but all-zero p99.
  if (latencyGated && p99 <= p99Epsilon) {
    throw new PerfBaselineValidationError(
      `perf baseline ${source}: latencyGated===true but baseline.latency.p99 (${p99}) <= p99Epsilon (${p99Epsilon}); an all-zero gating p99 is invalid`,
    )
  }
  // (b) real non-zero p99 but band disabled.
  if (!latencyGated && p99 > p99Epsilon) {
    throw new PerfBaselineValidationError(
      `perf baseline ${source}: latencyGated===false but baseline.latency.p99 (${p99}) > p99Epsilon (${p99Epsilon}); a real measurement is being silently ignored`,
    )
  }
  return parsed
}

/**
 * Evaluate the regression bands of a {@link PerfReport} against a committed
 * baseline. Returns one {@link BandResult} per metric:
 *  - throughput: PRIMARY; gates ALWAYS; fails when eventsPerSec drops > 20%.
 *  - memory:     gates ONLY when both baseline.gates.memoryGated AND the current
 *                run has `global.gc` (else advisory).
 *  - latencyP99: gates ONLY when baseline.gates.latencyGated AND baseline.p99 >
 *                epsilon (else N/A — no divide-by-zero).
 *  - traceLen:   ZERO tolerance; ANY delta fails (determinism teeth).
 */
export function evaluatePerfBands(report: PerfReport, baseline: PerfBaselineFile): BandResult[] {
  const { bands, p99Epsilon } = PERF_REGRESSION_CONFIG
  const obs = report.sample
  const base = baseline.baseline
  const results: BandResult[] = []

  // throughput — PRIMARY, gates always. A DROP beyond the band fails (higher is
  // fine; we only fail on regression below baseline*(1-band)).
  {
    const floor = base.eventsPerSec * (1 - bands.throughputPct)
    results.push({
      metric: 'throughput',
      status: obs.eventsPerSec >= floor ? 'pass' : 'fail',
      baseline: base.eventsPerSec,
      observed: obs.eventsPerSec,
      band: bands.throughputPct,
    })
  }

  // memory — gates only when armed at BOTH baseline and current run.
  {
    const memGatesNow = baseline.gates.memoryGated && isGcExposed()
    const ceiling = base.heapPeakBytes * (1 + bands.memoryPct)
    if (!memGatesNow) {
      results.push({ metric: 'memory', status: 'advisory', baseline: base.heapPeakBytes, observed: obs.heapPeakBytes, band: bands.memoryPct })
    } else {
      results.push({
        metric: 'memory',
        status: obs.heapPeakBytes <= ceiling ? 'pass' : 'fail',
        baseline: base.heapPeakBytes,
        observed: obs.heapPeakBytes,
        band: bands.memoryPct,
      })
    }
  }

  // latencyP99 — advisory; gates only when gated AND baseline p99 > epsilon.
  {
    const p99Gates = baseline.gates.latencyGated && base.latency.p99 > p99Epsilon
    if (!p99Gates) {
      // N/A for a zero/near-zero baseline — NO divide-by-zero, never a spurious pass/fail.
      results.push({ metric: 'latencyP99', status: 'na', baseline: base.latency.p99, observed: obs.latency.p99, band: bands.latencyP99Pct })
    } else {
      const ceiling = base.latency.p99 * (1 + bands.latencyP99Pct)
      results.push({
        metric: 'latencyP99',
        status: obs.latency.p99 <= ceiling ? 'pass' : 'fail',
        baseline: base.latency.p99,
        observed: obs.latency.p99,
        band: bands.latencyP99Pct,
      })
    }
  }

  // traceLen — ZERO tolerance; any delta is a determinism regression.
  {
    const delta = Math.abs(obs.traceLen - base.traceLen)
    results.push({
      metric: 'traceLen',
      status: delta <= bands.traceLenTolerance ? 'pass' : 'fail',
      baseline: base.traceLen,
      observed: obs.traceLen,
      band: bands.traceLenTolerance,
    })
  }

  return results
}

/**
 * Project a {@link PerfReport} into the committed {@link PerfBaselineFile} shape
 * (serializing `wallNs` to a DECIMAL STRING). `latencyGated`/`memoryGated` are
 * DERIVED from the measurement leg, never author-free: `latencyGated` is true iff
 * the report carries a non-zero p99 (only a real-timer leg can produce one);
 * `memoryGated` is true iff `global.gc` is exposed in this process.
 */
export function toBaselineFile(report: PerfReport): PerfBaselineFile {
  const s = report.sample
  const latencyGated = s.latency.p99 > PERF_REGRESSION_CONFIG.p99Epsilon
  return {
    schemaVersion: 1,
    packageVersion: report.packageVersion,
    runtime: report.runtime,
    node: report.node,
    baseline: {
      wallNs: s.wallNs.toString(),
      eventsPerSec: s.eventsPerSec,
      transitionsPerSec: s.transitionsPerSec,
      latency: { p50: s.latency.p50, p90: s.latency.p90, p99: s.latency.p99, max: s.latency.max, mean: s.latency.mean, resolution: 'ms-coarse' },
      heapPeakBytes: s.heapPeakBytes,
      heapAvgBytes: s.heapAvgBytes,
      heapEndBytes: s.heapEndBytes,
      gcProxy: s.gcProxy,
      traceLen: s.traceLen,
      queueDepthPeak: s.queueDepthPeak,
    },
    gates: { latencyGated, memoryGated: isGcExposed() },
  }
}

/**
 * Write the committed baseline file. ONLY runs when `SM_PERF_UPDATE_BASELINE=1`
 * (otherwise the baseline is READ-only — mirrors the `etc/statemachine.api.md`
 * drift-gate UX). Returns true when it wrote.
 */
export function maybeWriteBaseline(path: string, report: PerfReport): boolean {
  if (process.env['SM_PERF_UPDATE_BASELINE'] !== '1') {
    return false
  }
  writeFileSync(path, `${JSON.stringify(toBaselineFile(report), null, 2)}\n`, 'utf8')
  return true
}

/**
 * Object-oriented entry over {@link runPerf} (build-plan Step-8 surface). Holds
 * the run options and exposes `run()` + `evaluate(baseline)`; `evaluate` runs the
 * harness once and compares the resulting {@link PerfReport} against a committed
 * baseline via {@link evaluatePerfBands}.
 */
export class PerfHarness {
  constructor(private readonly opts: RunPerfOptions) {}

  /** Run the median-of-N harness and return the report. */
  run(): Promise<PerfReport> {
    return runPerf(this.opts)
  }

  /** Run once, then evaluate the regression bands against `baseline`. */
  async evaluate(baseline: PerfBaselineFile): Promise<{ report: PerfReport; bands: BandResult[] }> {
    const report = await this.run()
    return { report, bands: evaluatePerfBands(report, baseline) }
  }
}
