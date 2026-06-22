/**
 * @module sim/coverage
 * @unstable
 *
 * ADR-8 mandatory two-layer coverage gate over the canonical content-only trace.
 *
 * {@link computeCoverage} runs each registered {@link ScenarioSpec} through the
 * Step-3/4 driver (mode='safety' — explicit `advance` ops bring the clock to each
 * armed-timer epoch, so the gate never relies on a liveness clock-jump), ASSERTS
 * I-1 determinism (run twice, equal `hashTrace`) BEFORE counting, samples the
 * captured `isDone(C)` projection per declared composite at each settle boundary
 * (the harness reads the PUBLIC isDone — state_machine.ts:1433 — and stores the
 * boolean on the frame's `doneDelta`; probes read THAT, never a live engine call),
 * projects to a {@link SimTrace}, ORs every {@link CapabilityProbe} across all
 * traces, and FAILS (`exitCode!==0`) on `uncovered>0 || drift>0` — EXCLUDING the
 * explicit committed {@link DOCUMENTED_GAP_IDS}.
 *
 * A scenario MAY declare `expects: readonly CapabilityId[]`; the gate FAILS (drift)
 * if a claimed probe never fired. Tags document INTENT, never the pass signal.
 *
 * ISS-029 honesty: a string-method-only machine reports `error.guard-throw` /
 * `error.action-throw` / `error.recovery.abortOnExitError` as explicit
 * `n/a-string-method`, NEVER silently covered. A registry entry hand-marked
 * `coverageStatus:'covered'` whose probe never fires STILL reports uncovered —
 * `coverageStatus` is computed here at run time, never trusted from the literal.
 *
 * This module is an EXPLICIT knip `entry` (the gate CLI is not reached by the
 * public `./sim` surface chain). `sim:coverage` is NOT folded into `npm run check`
 * here — that lands in Step 10/11 once knip is green (ADR-8 F).
 */

import { MemoryAdapter } from '../index'
import type { Adapter, StateMachineConfig } from '../index'
import {
  CAPABILITIES,
  type CapabilityId,
  DOCUMENTED_GAP_IDS,
  capabilityKeys,
} from './capabilities'
import { makeSimClock } from './clock'
import { type GenOwner, makeOwner, toEngineConfig } from './define'
import { SimDriver } from './driver'
import { makeObservableScheduler } from './env'
import { isStringMethodCallback } from './harness'
import { NoopLogger } from './noop-logger'
import { makePrng } from './prng'
import type { ScenarioSpec, TopologySpec } from './scenario'
import { SimErrorHandler } from './sim-error-handler'
import { SimMonitor } from './sim-monitor'
import { type CanonicalTrace, type ErrorClass, type SimTrace, type TraceFrame, hashTrace, normalizeParts } from './trace'

/** The runtime tag pinned into every coverage-run trace header. */
export const COVERAGE_RUNTIME = 'node-sim-coverage-v1'

/**
 * A scenario registered with the coverage gate. The `spec` drives the run; the
 * optional `expects` declares which capabilities the author INTENDS this scenario
 * to cover (drift-checked — never the pass signal).
 */
export interface CoverageScenario {
  readonly name: string
  readonly spec: ScenarioSpec
  readonly expects?: readonly CapabilityId[]
  /**
   * Optional `StateMachineOptions.errorState` (types.ts:137) wired into the
   * coverage driver for this scenario. The `errorState` fallback is a wire-time
   * OPTION (not part of the frozen {@link ScenarioSpec}), so it is carried on the
   * coverage-scenario envelope and threaded into the driver by {@link runForCoverage}.
   */
  readonly errorState?: string
  /**
   * Drive a snapshot/restore round-trip AFTER the op stream: the runner calls the
   * engine's PUBLIC `saveState(mem)` then `restoreState(mem)` (which re-validates
   * the composite, re-applies history, and re-arms invoke timers via
   * `resumeTimers()` — state_machine.ts:740), then appends ONE
   * `synthetic:'post-restore'` frame. This is the wire-time persistence surface
   * (not part of the frozen {@link ScenarioSpec} Op union driven by the gate), so
   * it is carried on the envelope — the persistence.serialize/deserialize and
   * timer.resume probes read the resulting `synthetic:'post-restore'` frame.
   */
  readonly snapshotRestore?: boolean
  /**
   * Drive a queue-overflow flood AFTER the op stream: the runner floods the engine
   * with `floodCount` rapid `event` fires under a `maxQueueDepth` bound, so the
   * `(maxQueueDepth+1)`-th enqueue rejects SYNCHRONOUSLY (state_machine.ts:234) and
   * the runner appends a frame carrying `errorClass:'queue-overflow'`. The bound is
   * a wire-time OPTION; carried on the envelope. The
   * `queue.backpressure.overflow` probe reads the resulting errorClass frame.
   */
  readonly overflow?: {
    readonly event: string
    readonly maxQueueDepth: number
    readonly floodCount: number
  }
  /**
   * Drive a transitionTimeout AFTER the op stream: the runner fires `event`
   * (whose transition runs a hanging awaited callback) WITHOUT awaiting it, then
   * deterministically pumps microtasks + advances the virtual clock past
   * `timeoutMs` while processing the scheduler, until the timeout
   * `Promise.race` leg rejects (state_machine.ts:1789/1798). The reject is
   * classified `errorClass:'transition-timeout'` (cause===undefined; the action's
   * own body never resolved) and the runner appends a frame carrying it. The
   * `timer.transitionTimeout` probe reads that errorClass.
   */
  readonly transitionTimeout?: {
    readonly event: string
    readonly timeoutMs: number
  }
}

/** A scenario whose every invoke/guard/action callback is a STRING method name. */
function scenarioIsStringMethodOnly(spec: ScenarioSpec): boolean {
  let sawCallback = false
  let allStrings = true
  const visitState = (state: unknown): void => {
    const s = state as Record<string, unknown>
    const invoke = s['invoke']
    if (Array.isArray(invoke)) {
      for (const inv of invoke) {
        const i = inv as Record<string, unknown>
        if (i['action'] !== undefined) {
          sawCallback = true
          if (!isStringMethodCallback(i['action'])) {
            allStrings = false
          }
        }
      }
    }
    const regions = s['regions']
    if (regions && typeof regions === 'object') {
      for (const region of Object.values(regions as Record<string, unknown>)) {
        for (const sv of Object.values(region as Record<string, unknown>)) {
          visitState(sv)
        }
      }
    }
    const states = s['states']
    if (states && typeof states === 'object') {
      for (const sv of Object.values(states as Record<string, unknown>)) {
        visitState(sv)
      }
    }
  }
  for (const sv of Object.values(spec.topology.states)) {
    visitState(sv)
  }
  return sawCallback && allStrings
}

/** The harness scheduler control surface the runner drives directly (overflow / timeout pumps). */
type CoverageScheduler = {
  process(now?: number): void
  isActive(): boolean
  schedule(d: number, cb: () => void): object
  cancel(t: object): void
}

/** A driver plus the concrete clock/scheduler the runner needs for the wire-time drive paths. */
interface CoverageDriverBundle {
  readonly driver: SimDriver<GenOwner>
  readonly clock: ReturnType<typeof makeSimClock>
  readonly scheduler: CoverageScheduler
}

/**
 * Build a fresh driver for one coverage run. Mode='safety': the gate uses
 * explicit `advance` ops to fire timers, never a liveness clock-jump. The concrete
 * clock/scheduler are returned alongside the driver so the wire-time drive paths
 * (snapshot/restore, overflow flood, transitionTimeout pump) can advance/process
 * them directly without reaching into the engine's private state.
 */
function buildCoverageDriver(
  topology: TopologySpec,
  seed: bigint,
  spec: ScenarioSpec,
  sc?: CoverageScenario,
): CoverageDriverBundle {
  const config = toEngineConfig<GenOwner>(topology) as StateMachineConfig<GenOwner>
  const clock = makeSimClock(0)
  const { scheduler, view } = makeObservableScheduler(clock)
  const concrete = scheduler as CoverageScheduler
  // transitionTimeout is wire-time: prefer the envelope intent, else the frozen
  // FaultPlan.transitionTimeoutMs (both map 1:1 to StateMachineOptions:133).
  const transitionTimeout = sc?.transitionTimeout?.timeoutMs ?? spec.faults.transitionTimeoutMs
  const driver = new SimDriver<GenOwner>({
    config,
    owner: new MemoryAdapter<GenOwner>(makeOwner(topology)) as unknown as Adapter<GenOwner>,
    clock,
    scheduler: concrete,
    schedulerView: view,
    monitor: new SimMonitor(),
    errorHandler: new SimErrorHandler(),
    logger: NoopLogger,
    prng: makePrng(seed),
    runtime: COVERAGE_RUNTIME,
    policy: 'safety',
    ...(transitionTimeout !== undefined ? { transitionTimeout } : {}),
    ...(sc?.overflow !== undefined ? { maxQueueDepth: sc.overflow.maxQueueDepth } : {}),
    ...(sc?.errorState !== undefined ? { errorState: sc.errorState } : {}),
  })
  return { driver, clock, scheduler: concrete }
}

/**
 * Every composite (regions-bearing) state id of a topology, as the engine renders
 * its dotted path. Used to sample isDone(C) per composite at each settle boundary.
 * We sample ALL composites (not only declared-`done.state.<C>` ones) so a parallel
 * composite that STAYS all-final — and therefore has no `done.state.<C>` transition
 * to leave it — is still observed done (the doneDelta projection the
 * `inspection.isDone` / `composite.join.done-state` probes read).
 */
function declaredComposites(topology: TopologySpec): string[] {
  const out: string[] = []
  const visit = (name: string, node: unknown, prefix: string): void => {
    const path = prefix === '' ? name : `${prefix}.${name}`
    const n = (node ?? {}) as Record<string, unknown>
    const regions = n['regions']
    if (regions && typeof regions === 'object') {
      out.push(path)
      for (const [rn, rstates] of Object.entries(regions as Record<string, unknown>)) {
        if (rstates && typeof rstates === 'object') {
          for (const [sn, sv] of Object.entries(rstates as Record<string, unknown>)) {
            visit(sn, sv, `${path}.${rn}`)
          }
        }
      }
    }
    const states = n['states']
    if (states && typeof states === 'object') {
      for (const [sn, sv] of Object.entries(states as Record<string, unknown>)) {
        visit(sn, sv, path)
      }
    }
  }
  for (const [name, node] of Object.entries(topology.states)) {
    visit(name, node, '')
  }
  return out
}

/**
 * Drive one scenario to a content-only {@link SimTrace}, sampling the captured
 * `doneDelta` projection (live isDone(C) per declared composite) at the settle
 * boundary of EACH step. The sampling is done by the RUNNER (which legitimately
 * drives the engine) and stored on the boundary frame; the probes read the stored
 * projection, never a live engine call.
 */
async function runForCoverage(sc: CoverageScenario): Promise<CanonicalTrace> {
  const spec = sc.spec
  const seed = BigInt(spec.seed)
  const { driver, clock, scheduler } = buildCoverageDriver(spec.topology, seed, spec, sc)
  const composites = declaredComposites(spec.topology)

  await driver.init()
  // Sample isDone at the init boundary too (a degenerate all-final config is done
  // immediately).
  const initSamples = sampleDone(driver, composites)

  const stepSamples: Array<{ step: number; samples: ReadonlyArray<{ composite: string; done: boolean }> }> = []
  for (const op of spec.ops) {
    if (op.kind === 'fire') {
      await driver.step({ kind: 'fire', event: op.event, args: op.args })
    } else if (op.kind === 'advance') {
      await driver.step({ kind: 'advance', dtMs: op.dtMs })
    } else if (op.kind === 'noop') {
      await driver.step({ kind: 'noop' })
    } else {
      continue
    }
    stepSamples.push({ step: op === spec.ops[0] ? 1 : stepSamples.length + 1, samples: sampleDone(driver, composites) })
  }

  const base = driver.trace()
  // Inject the sampled doneDelta onto the LAST (settle-boundary) frame of each
  // step — and onto frame 0 for the init sample. Frames are readonly; rebuild.
  const frames = injectDoneDeltas(base.frames, initSamples, stepSamples)

  // ── Wire-time capability drive paths (each appends its own frame) ───────────
  // These exercise capabilities the frozen Op union does not drive: the
  // persistence surface (snapshot/restore), the queue-overflow backpressure
  // reject, and the transitionTimeout race. All are deterministic (virtual
  // clock/scheduler, fixed pump bound; no Math.random / Date.now / real timer).
  const lastStep = frames.length > 0 ? Math.max(...frames.map((f) => f.step)) : 0
  let extraStep = lastStep

  if (sc.snapshotRestore === true) {
    extraStep += 1
    frames.push(await drivePostRestoreFrame(driver, extraStep, clock.now()))
  }
  if (sc.overflow !== undefined) {
    extraStep += 1
    frames.push(await driveOverflowFrame(driver, sc.overflow, extraStep, clock.now()))
  }
  if (sc.transitionTimeout !== undefined) {
    extraStep += 1
    frames.push(await driveTransitionTimeoutFrame(driver, scheduler, clock, sc.transitionTimeout, extraStep))
  }

  return { header: base.header, frames }
}

/**
 * Drive a PUBLIC snapshot/restore round-trip and return ONE
 * `synthetic:'post-restore'` frame. Uses the engine's public
 * `saveState(mem)`/`restoreState(mem)` (state_machine.ts:710/727) — `restoreState`
 * re-validates the composite, re-applies history, and re-arms invoke timers via
 * `resumeTimers()` (:740). The frame's `to` is the (normalized) restored config;
 * the `synthetic:'post-restore'` tag is what the persistence.serialize/
 * deserialize + timer.resume probes read.
 */
async function drivePostRestoreFrame(driver: SimDriver<GenOwner>, step: number, t: number): Promise<TraceFrame> {
  const sm = driver.machine
  const before = safeState(sm)
  // A fresh MemoryAdapter is the StatePersistenceAdapter sink: save the engine
  // state into it (serialize), then restore from it (deserialize + resumeTimers).
  const mem = new MemoryAdapter<GenOwner>({ state: before, log: [], k: 0 })
  await sm.saveState(mem)
  await sm.restoreState(mem)
  const after = safeState(sm)
  return {
    step,
    t,
    cause: 'timer',
    synthetic: 'post-restore',
    from: normalizeParts(before),
    to: normalizeParts(after),
    queue: queueOf(sm),
    quiescent: true,
  }
}

/**
 * Drive a queue-overflow flood and return ONE frame carrying
 * `errorClass:'queue-overflow'`. Fires `floodCount` rapid `event`s concurrently
 * under the wired `maxQueueDepth` bound; the `(max+1)`-th enqueue rejects
 * SYNCHRONOUSLY at enqueue (state_machine.ts:234). We field-select the
 * `queue-overflow` class from the reject's structured context (the synchronous
 * enqueue reject), NEVER from `e.message`.
 */
async function driveOverflowFrame(
  driver: SimDriver<GenOwner>,
  ov: { event: string; maxQueueDepth: number; floodCount: number },
  step: number,
  t: number,
): Promise<TraceFrame> {
  const sm = driver.machine
  const before = safeState(sm)
  let sawOverflow = false
  const fires: Promise<unknown>[] = []
  for (let i = 0; i < ov.floodCount; i++) {
    fires.push(
      sm.fireEvent(ov.event as never).then(
        () => {},
        (e: unknown) => {
          if (isQueueOverflowReject(e)) {
            sawOverflow = true
          }
        },
      ),
    )
  }
  await Promise.allSettled(fires)
  return {
    step,
    t,
    cause: 'external',
    event: ov.event,
    from: normalizeParts(before),
    to: normalizeParts(safeState(sm)),
    queue: queueOf(sm),
    quiescent: true,
    fireOutcome: 'reject',
    ...(sawOverflow ? { errorClass: 'queue-overflow' as ErrorClass } : {}),
  }
}

/**
 * Drive a transitionTimeout and return ONE frame carrying
 * `errorClass:'transition-timeout'`. Fires `event` (whose transition runs a
 * hanging awaited callback) WITHOUT awaiting it, then deterministically pumps
 * microtasks + advances the virtual clock past `timeoutMs` while processing the
 * scheduler — the timeout `Promise.race` leg (state_machine.ts:1789/1798) rejects
 * with `phase:'action'` + `cause===undefined` (the action body never resolved),
 * which we classify by field-selection (never `e.message`). Bounded pump (no real
 * timer) so it cannot hang.
 */
async function driveTransitionTimeoutFrame(
  driver: SimDriver<GenOwner>,
  scheduler: CoverageScheduler,
  clock: ReturnType<typeof makeSimClock>,
  tt: { event: string; timeoutMs: number },
  step: number,
): Promise<TraceFrame> {
  const sm = driver.machine
  const before = safeState(sm)
  let timedOut = false
  let settled = false
  const p = sm.fireEvent(tt.event as never).then(
    () => {
      settled = true
    },
    (e: unknown) => {
      settled = true
      if (isTransitionTimeoutReject(e)) {
        timedOut = true
      }
    },
  )
  // Deterministic pump: one microtask + one logical-ms advance + scheduler process
  // per turn, bounded well past the timeout so the race can resolve.
  const maxTurns = Math.max(64, tt.timeoutMs + 16)
  for (let i = 0; i < maxTurns && !settled; i++) {
    await Promise.resolve()
    clock.set(clock.now() + 1)
    scheduler.process(clock.now())
  }
  await p.catch(() => {})
  return {
    step,
    t: clock.now(),
    cause: 'external',
    event: tt.event,
    from: normalizeParts(before),
    to: normalizeParts(safeState(sm)),
    queue: queueOf(sm),
    quiescent: true,
    fireOutcome: 'reject',
    ...(timedOut ? { errorClass: 'transition-timeout' as ErrorClass } : {}),
  }
}

/** Read getCurrentState defensively (a corrupt/error-state read can throw). */
function safeState(sm: SimDriver<GenOwner>['machine']): string {
  try {
    return sm.getCurrentState() ?? ''
  } catch {
    return ''
  }
}

/** Queue snapshot via the PUBLIC getQueueDepth (never the private queues). */
function queueOf(sm: SimDriver<GenOwner>['machine']): { internal: number; external: number } {
  const q = sm.getQueueDepth()
  return { internal: q.internal, external: q.external }
}

/**
 * True iff `e` is the engine's synchronous queue-overflow reject (state_machine
 * .ts:234): a StateMachineError whose structured context carries `event` and no
 * `phase` (the enqueue reject), distinguished from the depth reject only by being
 * a SYNCHRONOUS flood enqueue here. Field-selection only — NEVER `e.message`.
 */
function isQueueOverflowReject(e: unknown): boolean {
  const ctx = (e as { context?: { event?: unknown; phase?: unknown } } | undefined)?.context
  return ctx !== undefined && ctx.event !== undefined && ctx.phase === undefined
}

/**
 * True iff `e` is the engine's transitionTimeout reject (state_machine.ts:1789):
 * `phase:'action'` + a concrete `action` + `cause===undefined` (the hanging body
 * never threw a `cause`). A normal action-throw carries a `cause`; an injected
 * fault carries an InjectedFault cause. Field-selection only — NEVER `e.message`.
 */
function isTransitionTimeoutReject(e: unknown): boolean {
  const ctx = (e as { context?: { phase?: unknown; action?: unknown } } | undefined)?.context
  const cause = (e as { cause?: unknown } | undefined)?.cause
  return ctx !== undefined && ctx.phase === 'action' && ctx.action !== undefined && cause === undefined
}

/** Sample isDone(C) per declared composite against the live machine (runner-side). */
function sampleDone(
  driver: SimDriver<GenOwner>,
  composites: readonly string[],
): ReadonlyArray<{ composite: string; done: boolean }> {
  if (composites.length === 0) {
    return []
  }
  const sm = driver.machine
  return composites.map((c) => {
    let done = false
    try {
      done = sm.isDone(c)
    } catch {
      done = false
    }
    return { composite: c, done }
  })
}

/**
 * Attach the sampled doneDelta to the relevant boundary frames. The init sample
 * goes on the first `cause:'init'` frame; each step's sample goes on the LAST
 * frame whose `step` equals that step index (the settle-boundary frame).
 */
function injectDoneDeltas(
  frames: readonly TraceFrame[],
  initSamples: ReadonlyArray<{ composite: string; done: boolean }>,
  stepSamples: ReadonlyArray<{ step: number; samples: ReadonlyArray<{ composite: string; done: boolean }> }>,
): TraceFrame[] {
  const out = frames.map((f) => ({ ...f }))
  // init: first frame with cause 'init'.
  if (initSamples.length > 0) {
    const idx = out.findIndex((f) => f.cause === 'init')
    if (idx >= 0) {
      out[idx] = { ...out[idx], doneDelta: initSamples } as TraceFrame
    }
  }
  // each step: the LAST frame with that step index.
  for (const { samples } of stepSamples) {
    if (samples.length === 0) {
      continue
    }
  }
  // Group step samples by step index and attach to the last matching frame.
  const byStep = new Map<number, ReadonlyArray<{ composite: string; done: boolean }>>()
  let logical = 1
  for (const s of stepSamples) {
    byStep.set(logical, s.samples)
    logical += 1
  }
  for (const [stepIdx, samples] of byStep) {
    if (samples.length === 0) {
      continue
    }
    let lastIdx = -1
    for (let i = 0; i < out.length; i++) {
      if (out[i]!.step === stepIdx) {
        lastIdx = i
      }
    }
    if (lastIdx >= 0) {
      out[lastIdx] = { ...out[lastIdx], doneDelta: samples } as TraceFrame
    }
  }
  return out
}

/** Run a scenario twice and assert byte-identical hashTrace (I-1). Throws on divergence. */
async function runWithDeterminismGate(sc: CoverageScenario): Promise<SimTrace> {
  const a = await runForCoverage(sc)
  const b = await runForCoverage(sc)
  const ha = hashTrace(a)
  const hb = hashTrace(b)
  if (ha !== hb) {
    throw new CoverageDeterminismError(sc.spec.seed, ha, hb)
  }
  return a
}

/** Thrown when a coverage scenario is NON-deterministic (I-1 fails before counting). */
export class CoverageDeterminismError extends Error {
  readonly seed: string
  readonly hashA: string
  readonly hashB: string
  constructor(seed: string, hashA: string, hashB: string) {
    super(`coverage scenario seed=${seed} is non-deterministic: ${hashA} != ${hashB}`)
    this.name = 'CoverageDeterminismError'
    this.seed = seed
    this.hashA = hashA
    this.hashB = hashB
  }
}

/** The computed coverage result. */
export interface CoverageResult {
  readonly covered: ReadonlySet<CapabilityId>
  readonly uncovered: ReadonlySet<CapabilityId>
  readonly drift: ReadonlySet<CapabilityId>
  /** non-zero on uncovered>0 || drift>0 (EXCLUDING DOCUMENTED_GAP_IDS). */
  readonly exitCode: number
  /** Per-id run-time status (computed; never trusted from the registry literal). */
  readonly status: ReadonlyMap<CapabilityId, 'covered' | 'dormant' | 'n/a-string-method'>
}

/**
 * Run every scenario through the determinism-gated driver, OR the probes, and
 * compute coverage. `uncovered` lists every NON-gap id whose probe never fired;
 * `drift` lists every `expects` id a scenario claimed but whose probe never fired
 * in THAT scenario's trace.
 */
export async function computeCoverage(scenarios: readonly CoverageScenario[]): Promise<CoverageResult> {
  const allIds = capabilityKeys()
  const covered = new Set<CapabilityId>()
  const drift = new Set<CapabilityId>()
  const status = new Map<CapabilityId, 'covered' | 'dormant' | 'n/a-string-method'>()

  // Track which scenarios are string-method-only (for ISS-029 honest residual).
  let anyStringMethodOnly = false

  for (const sc of scenarios) {
    const trace = await runWithDeterminismGate(sc)
    if (scenarioIsStringMethodOnly(sc.spec)) {
      anyStringMethodOnly = true
    }

    const firedHere = new Set<CapabilityId>()
    for (const id of allIds) {
      const cap = CAPABILITIES[id]
      if (cap.probe(trace)) {
        covered.add(id)
        firedHere.add(id)
      }
    }

    // Drift: an expected id that did NOT fire in THIS scenario's trace.
    for (const id of sc.expects ?? []) {
      if (!firedHere.has(id)) {
        drift.add(id)
      }
    }
  }

  // Compute the run-time status for every id (NEVER trusting the literal flag).
  const uncovered = new Set<CapabilityId>()
  for (const id of allIds) {
    if (covered.has(id)) {
      status.set(id, 'covered')
      continue
    }
    // Not covered. Decide the honest residual reason (computed, never trusted).
    if (anyStringMethodOnly && isStringMethodResidual(id)) {
      status.set(id, 'n/a-string-method')
    } else {
      status.set(id, 'dormant')
    }
    // Only a NON-gap uncovered id fails the gate.
    if (!DOCUMENTED_GAP_IDS.has(id)) {
      uncovered.add(id)
    }
  }

  const exitCode = uncovered.size > 0 || drift.size > 0 ? 1 : 0
  return { covered, uncovered, drift, exitCode, status }
}

/** The three function-valued-callback error ids that are n/a on a string-method machine. */
function isStringMethodResidual(id: CapabilityId): boolean {
  return id === 'error.guard-throw' || id === 'error.action-throw' || id === 'error.recovery.abortOnExitError'
}

/**
 * Render a human-readable failure report (one line per uncovered/drift id with its
 * engineRefs + a remediation hint). Empty string when the gate passes.
 */
export function formatCoverageReport(result: CoverageResult): string {
  const lines: string[] = []
  for (const id of [...result.uncovered].sort()) {
    const cap = CAPABILITIES[id]
    lines.push(`UNCOVERED ${id} [${cap.engineRefs.join(', ')}] — add a scenario that exercises it`)
  }
  for (const id of [...result.drift].sort()) {
    lines.push(`DRIFT ${id} — a scenario declared expects:[…${id}…] but its probe never fired`)
  }
  return lines.join('\n')
}

/**
 * CLI entry (`sim:coverage`). Runs {@link computeCoverage} over the registered
 * scenario set and returns the process exit code (0 = pass, non-zero = a non-gap
 * id uncovered or drift). NOT folded into `npm run check` until Step 10/11.
 */
export async function coverageMain(scenarios: readonly CoverageScenario[]): Promise<number> {
  const result = await computeCoverage(scenarios)
  console.log(`sim:coverage — ${result.covered.size} covered / ${capabilityKeys().length} total`)
  if (result.exitCode !== 0) {
    console.error(formatCoverageReport(result))
  }
  return result.exitCode
}
