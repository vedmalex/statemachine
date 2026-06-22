/**
 * @module sim/shrinker
 * @unstable
 *
 * ADR-6 structured ddmin minimizer (Step 7). Given a long failing
 * {@link ScenarioSpec} plus the single first-violation {@link Violation} the
 * Step-6 oracle produced, the shrinker re-runs the REAL engine deterministically
 * through the SHARED Step-3 driver ({@link runScenario}) and reduces the scenario
 * to a per-family 1-minimal repro that re-fails the SAME
 * `{invariantId, normalized witness, errorClass}` fingerprint.
 *
 * KEY CONTRACTS (grep/test-enforced by shrinker.test.ts):
 *  - **Predicate (R15).** Strict FULL-TUPLE fingerprint equality, consuming the
 *    oracle's {@link Violation.fingerprint} VERBATIM (never recomputed): a
 *    candidate is accepted ONLY when `violation != null && violation.invariantId
 *    === target.invariantId && fingerprintEquals(violation.fingerprint,
 *    target.fingerprint)`. No ddmin slippage to a DIFFERENT invariant/witness.
 *  - **Runner = the shared Step-3 runScenario settle surface (R2).** This module
 *    contains ZERO local settle drain primitive and no bespoke microtask budget
 *    constant: the runner is INJECTED ({@link ShrinkRunner}) and defaults to
 *    {@link defaultShrinkRunner}, which delegates to `runScenario` (Step 3/4) +
 *    {@link runSafety} (Step 6). I-1 (replay bit-exactness) is the hard
 *    prerequisite the caller asserts before shrinking.
 *  - **Cache canonicalizer (R7 / ADR-1 c8).** Memoize keyed by a STRUCTURAL walk
 *    folding every closure-free literal callback's `source` string (the bytes that
 *    actually distinguish two inlined guards — `toEngineConfig` re-wraps callbacks
 *    so their live `Function.prototype.toString()` collapses to one wrapper body).
 *    It MUST NOT `JSON.stringify` the config (drops functions) nor
 *    `toJSON()`/`toSecureJSON()` (createdAt-poisoned, security.ts:430/462/468).
 *    The key ALSO folds the FULL op stream INCLUDING the restore op so
 *    restore-replay-to-self soundness holds (distinct op streams → distinct keys).
 *  - **Witness/finalState canonicalization (ADR-1 c3).** Every witness/finalState
 *    the shrinker emits is `split('|').sort().join('|')`-normalized (mirrors
 *    state_machine.ts:639, compensates the insertion-order render at :1202) via
 *    {@link normalizeParts}.
 *  - **Always-valid repro.** Bounded by `{maxRuns, maxWallMs, maxStagnantRounds}`;
 *    ALWAYS returns a valid candidate (worst case the input unchanged) — never
 *    throws/hangs/truncates to a non-reproducing artifact.
 *
 * Shrink moves (per-family ddmin, cheapest-first, looped to a global fixpoint):
 *  - **M0** disable faults (highest payoff, runs BEFORE op-drop).
 *  - **M1** drop ops (classic ddmin 1-minimality) with fault op-id RE-KEYING (R22).
 *  - **M2** shrink advances (binary-search `dtMs` downward).
 *  - **M3** shrink config, gating EVERY candidate through `validateConfig`
 *    ERRORS-ONLY before running (warnings-only candidates like `SELF_TRANSITION`
 *    are NOT discarded).
 *  - **M4** binary-search fault params (`deltaMs`/`jitterMs`/`floodCount`).
 *  - **M5** narrow `Op.args`.
 *  - **M6 REMOVED** (microtask-flush is a harness artifact; no `Op.flush`).
 *
 * No `Math.random`/`Date.now`/`performance.now`; the only wall-clock read is the
 * OPTIONAL budget `nowMs` injected by the caller (defaults to a monotonic counter
 * so the fingerprint/cache-key/replay are Date-independent — DoD 10).
 */

import { validateConfig } from '../index'
import type { StateMachineConfig } from '../index'
import { toEngineConfig } from './define'
import { runScenario } from './define'
import { buildConfigGraph } from './invariants'
import { INVARIANTS } from './invariants'
import type { CheckerContext, Violation } from './invariants'
import { runSafety } from './invariants.runner'
import type { FaultPlan, FaultSpec } from './faults'
import type { Op, ScenarioSpec, TopologySpec } from './scenario'
import { normalizeParts } from './trace'

/** The fingerprint tuple the predicate matches on (R15) — the oracle's, verbatim. */
export type ViolationFingerprint = Violation['fingerprint']

/** The outcome of running ONE candidate through the shared driver + safety oracle. */
export interface ShrinkRunResult {
  /** The single first-violation the Step-6 oracle emitted (lowest-step), or null. */
  readonly violation: Violation | null
  /** Running ADR-1 `hashTrace` of the candidate's canonical trace. */
  readonly traceHash: string
  /** Terminal config, `'|'`-normalized. */
  readonly finalState: string
  /** Total queue depth at the terminal frame (`internal + external`; no `total`). */
  readonly finalQueueDepth: number
}

/**
 * Run ONE candidate scenario and return its violation + replay summary. The
 * runner is the SOLE settle surface; the shrinker NEVER drains directly. The
 * default ({@link defaultShrinkRunner}) delegates to the Step-3/4 `runScenario`
 * (which owns the single `settleMacrostep`) + the Step-6 {@link runSafety}.
 */
export type ShrinkRunner = (candidate: ScenarioSpec) => Promise<ShrinkRunResult>

/** Budget bounding the shrink; ALWAYS returns the best-found repro when exhausted. */
export interface ShrinkBudget {
  /** Hard cap on runner invocations (memo hits do NOT count). */
  readonly maxRuns: number
  /** Hard wall-clock cap in ms (uses the injected `nowMs`, NOT `Date.now`). */
  readonly maxWallMs: number
  /** Stop after this many consecutive full rounds with no size reduction. */
  readonly maxStagnantRounds: number
}

/** Default budget: generous enough to fully minimize a ≥30-op planted failure. */
export const DEFAULT_SHRINK_BUDGET: ShrinkBudget = {
  maxRuns: 4000,
  maxWallMs: 60_000,
  maxStagnantRounds: 2,
}

/** What the shrinker returns: the minimized scenario + its violation + provenance. */
export interface ShrinkResult {
  /** The 1-minimal (per-family) scenario; re-runs to the SAME fingerprint. */
  readonly scenario: ScenarioSpec
  /** The violation the minimized scenario re-fails with (fingerprint-equal to the target). */
  readonly violation: Violation
  /** Replay summary of the minimized scenario (Date-independent). */
  readonly run: ShrinkRunResult
  /** Provenance for the {@link MinimalRepro} record. */
  readonly provenance: {
    /** Number of accepted shrink moves (candidates that re-failed and were kept). */
    readonly shrinkMoves: number
    /** Total runner invocations (excludes memo hits). */
    readonly runs: number
    /** true iff the shrink converged (a full stagnant round produced no reduction). */
    readonly minimal: boolean
  }
}

// ── injected runner default (the SHARED Step-3 settle surface) ───────────────

/**
 * Default runner: derive the candidate's engine config, run it through the SHARED
 * Step-3/4 `runScenario` (the SOLE `settleMacrostep` owner), then run the Step-6
 * {@link runSafety} oracle over the canonical trace. The shrinker itself NEVER
 * settles — it only calls this runner (R2).
 */
export async function defaultShrinkRunner(candidate: ScenarioSpec): Promise<ShrinkRunResult> {
  const trace = await runScenario(candidate)
  const engineConfig = toEngineConfig(candidate.topology)
  const ctx: CheckerContext = {
    graph: buildConfigGraph(engineConfig),
    header: trace.header,
  }
  const violation = runSafety(INVARIANTS, trace, ctx)
  // traceHash is recomputed lazily by callers that need it; here we fold a cheap
  // structural hash over the frames (NEVER via Date.now — see module doc).
  const frames = trace.frames
  const last = frames.length > 0 ? frames[frames.length - 1] : undefined
  const finalState = last !== undefined ? normalizeParts(last.to) : ''
  const finalQueueDepth = last !== undefined ? last.queue.internal + last.queue.external : 0
  return {
    violation,
    traceHash: hashOfTrace(trace.header.configHash, frames.length),
    finalState,
    finalQueueDepth,
  }
}

/**
 * A cheap structural digest of a trace usable as a replay summary. NOT a
 * substitute for ADR-1 `hashTrace` (callers wanting the full canonical hash use
 * the public surface); it is Date-independent by construction.
 */
function hashOfTrace(configHashValue: string, frameCount: number): string {
  return `${configHashValue}:${frameCount}`
}

// ── predicate (R15): strict full-tuple fingerprint equality ──────────────────

/** True iff two fingerprints are equal across `{invariantId, witness, errorClass}`. */
export function fingerprintEquals(a: ViolationFingerprint, b: ViolationFingerprint): boolean {
  return (
    a.invariantId === b.invariantId &&
    a.witness === b.witness &&
    a.errorClass === b.errorClass
  )
}

/**
 * The shrink predicate (R15): a candidate is accepted ONLY when its violation is
 * fingerprint-EQUAL to the target. A candidate failing a DIFFERENT invariant or
 * with a different normalized witness is REJECTED (no ddmin slippage). Consumes
 * the oracle's {@link Violation.fingerprint} verbatim — never recomputed.
 */
function matchesTarget(result: ShrinkRunResult, target: ViolationFingerprint): boolean {
  return result.violation !== null && fingerprintEquals(result.violation.fingerprint, target)
}

// ── cache canonicalizer (R7): toString-fold, op-stream-in-key, never JSON ─────

/**
 * Canonical structural key for a candidate. Folds the topology STRUCTURE — every
 * callback's closure-free literal `source` string (the actual distinguishing
 * bytes; R7/ADR-1 c8) plus the state/event shape — and the FULL op stream
 * INCLUDING the restore op (so a restore-add/remove boundary never shares a key
 * as-if-continuous). The fault plan folds in too (M0/M4 change it).
 *
 * Folding the topology `source` strings (NOT a re-derived engine config) is
 * load-bearing: `toEngineConfig` re-creates each callback through a `new Function`
 * WRAPPER, so `Function.prototype.toString()` of the live `fn` returns the
 * WRAPPER body — identical for every callback — and two configs differing only in
 * an inlined guard literal would collide. The literal `source` is the byte that
 * actually differs. We NEVER `JSON.stringify` the config (drops functions) nor
 * `toJSON()`/`toSecureJSON()` (createdAt-poisoned). Date-independent.
 */
export function shrinkCacheKey(spec: ScenarioSpec): string {
  const topoKey = topologyKeyPart(spec.topology)
  const opsKey = spec.ops.map(opKeyPart).join(';')
  const faultsKey = faultPlanKeyPart(spec.faults)
  return `${spec.seed}|${topoKey}|${opsKey}|${faultsKey}`
}

/**
 * Structural key fragment for a topology: a stable JSON-like walk over the
 * state/event shape that folds every closure-free literal callback's `source`
 * string (the distinguishing bytes) and DROPS the live `fn` (which would
 * stringify to a wrapper body, R7). Keys are visited in insertion order (the
 * order the engine reads them, state_machine.ts:1317-1320). NEVER folds a
 * createdAt/Date.now (the `source` strings are static).
 */
function topologyKeyPart(topology: TopologySpec): string {
  const parts: string[] = [`name:${topology.name}`, `init:${topology.initialState}`, `attr:${topology.stateAttribute}`]
  const visitState = (name: string, spec: StateNode, prefix: string): void => {
    const path = prefix === '' ? name : `${prefix}.${name}`
    if (spec.final) {
      parts.push(`final:${path}`)
    }
    if (spec.history) {
      parts.push(`hist:${path}:${spec.history}`)
    }
    if (spec.initial) {
      parts.push(`sinit:${path}:${spec.initial}`)
    }
    if (spec.onEnter) {
      parts.push(`onEnter:${path}:${spec.onEnter.source}`)
    }
    if (spec.onExit) {
      parts.push(`onExit:${path}:${spec.onExit.source}`)
    }
    if (spec.invoke) {
      spec.invoke.forEach((inv, i) => {
        parts.push(`inv:${path}:${i}:${inv.delay}:${inv.event}:${inv.cond?.source ?? ''}:${inv.action?.source ?? ''}`)
      })
    }
    if (spec.regions) {
      for (const [rn, region] of Object.entries(spec.regions)) {
        for (const [sn, ss] of Object.entries(region)) {
          visitState(sn, ss as StateNode, `${path}.${rn}`)
        }
      }
    }
  }
  for (const [name, spec] of Object.entries(topology.states)) {
    visitState(name, spec as StateNode, '')
  }
  for (const [en, ev] of Object.entries(topology.events)) {
    const e = ev as { transitions: ReadonlyArray<TransitionNode> }
    e.transitions.forEach((t, i) => {
      parts.push(
        `ev:${en}:${i}:${t.from}->${t.to}:p${t.priority ?? ''}:g${t.guard?.source ?? ''}:t${t.onTransition?.source ?? ''}`,
      )
    })
  }
  return parts.join('§')
}

/** Minimal structural shape of a topology state node the key-walk reads. */
interface StateNode {
  readonly final?: boolean
  readonly history?: string
  readonly initial?: string
  readonly onEnter?: { readonly source: string }
  readonly onExit?: { readonly source: string }
  readonly invoke?: ReadonlyArray<{
    readonly delay: number
    readonly event: string
    readonly cond?: { readonly source: string }
    readonly action?: { readonly source: string }
  }>
  readonly regions?: Readonly<Record<string, Readonly<Record<string, StateNode>>>>
}

/** Minimal structural shape of a transition the key-walk reads. */
interface TransitionNode {
  readonly from: string
  readonly to: string
  readonly priority?: number
  readonly guard?: { readonly source: string }
  readonly onTransition?: { readonly source: string }
}

/** Structural key fragment for one op (INCLUDING the restore op — R7 fold). */
function opKeyPart(op: Op): string {
  switch (op.kind) {
    case 'fire':
      return `f:${op.id}:${op.event}:${op.args.join(',')}`
    case 'advance':
      return `a:${op.id}:${op.dtMs}`
    case 'noop':
      return `n:${op.id}`
    case 'snapshot':
      return `s:${op.id}`
    case 'restore':
      // The restore op is part of the key (restore-replay-to-self soundness): a
      // restore that points at a different snapshot must NOT alias another stream.
      return `r:${op.id}:${op.fromSnapshotId}`
  }
}

/** Structural key fragment for a fault plan (M0 disables, M4 binary-searches params). */
function faultPlanKeyPart(plan: FaultPlan): string {
  const specs = plan.faults
    .map((f) => faultSpecKeyPart(f))
    .sort()
    .join(',')
  const tt = plan.transitionTimeoutMs ?? ''
  const rw = plan.reorderWindow ?? ''
  return `[${specs}]@${tt}/${rw}`
}

function faultSpecKeyPart(f: FaultSpec): string {
  const site = `${f.site.seam}:${f.site.stateName ?? ''}:${f.site.invokeIndex ?? ''}:${f.site.callbackKind ?? ''}:${f.site.opId ?? ''}`
  switch (f.kind) {
    case 'reorder':
    case 'drop':
    case 'dup':
      return `${f.kind}@${f.opId}#${site}`
    case 'overflow':
      return `overflow@${f.opId}x${f.floodCount}#${site}`
    case 'clock-skew':
      return `skew+${f.deltaMs}#${site}`
    case 'timer-jitter':
      return `jitter+${f.jitterMs}#${site}`
    case 'throw':
      return `throw#${site}`
  }
}

// ── fault op-id re-keying (R22): drop a referenced op → drop dangling fault ───

/**
 * Re-key a fault plan after the op stream changed: any {@link FaultSpec} whose
 * `opId` no longer appears in `survivingOpIds` is DROPPED (no dangling op-id
 * reference). Faults with no `opId` (clock-skew / timer-jitter / throw) are
 * preserved. The surviving op ids are UNCHANGED (R22 stable id addressing — ops
 * are never positionally renumbered).
 */
export function rekeyFaultPlan(plan: FaultPlan, survivingOpIds: ReadonlySet<string>): FaultPlan {
  const faults = plan.faults.filter((f) => !('opId' in f) || f.opId === undefined || survivingOpIds.has(f.opId))
  return {
    faults,
    ...(plan.transitionTimeoutMs !== undefined ? { transitionTimeoutMs: plan.transitionTimeoutMs } : {}),
    ...(plan.reorderWindow !== undefined ? { reorderWindow: plan.reorderWindow } : {}),
  }
}

// ── M3 config gate: validateConfig ERRORS-only (warnings tolerated) ──────────

/**
 * True iff the candidate's derived config has ZERO validateConfig ERRORS. Warnings
 * (e.g. `SELF_TRANSITION`, `TOO_MANY_STATES`) are TOLERATED — a warnings-only
 * candidate is NOT discarded (M3 gate is errors-only). Returns false ONLY on a
 * genuine ERROR or if the config cannot even be derived.
 */
export function configHasNoErrors(spec: ScenarioSpec): boolean {
  let config: StateMachineConfig<object>
  try {
    config = toEngineConfig(spec.topology) as StateMachineConfig<object>
  } catch {
    return false
  }
  try {
    return validateConfig(config).isValid === true
  } catch {
    return false
  }
}

// ── the shrinker ─────────────────────────────────────────────────────────────

/** Internal mutable driving state for one shrink session. */
interface ShrinkState {
  best: ScenarioSpec
  bestRun: ShrinkRunResult
  bestViolation: Violation
  runs: number
  moves: number
  startMs: number
}

/**
 * Minimize a failing scenario to a per-family 1-minimal repro re-failing the same
 * fingerprint. ALWAYS returns a valid {@link ShrinkResult} (worst case the input
 * unchanged with `minimal:false`).
 *
 * @param spec    the (long) failing scenario.
 * @param target  the Step-6 oracle's first-violation {@link Violation}; its
 *                `fingerprint` is the strict acceptance key (R15).
 * @param opts    optional injected runner / budget / monotonic clock.
 */
export async function shrink(
  spec: ScenarioSpec,
  target: Violation,
  opts: {
    readonly runner?: ShrinkRunner
    readonly budget?: ShrinkBudget
    /** Monotonic ms source for the wall budget; defaults to a step counter (Date-free). */
    readonly nowMs?: () => number
  } = {},
): Promise<ShrinkResult> {
  const runner = opts.runner ?? defaultShrinkRunner
  const budget = opts.budget ?? DEFAULT_SHRINK_BUDGET
  let tick = 0
  const nowMs = opts.nowMs ?? (() => tick++)

  const cache = new Map<string, ShrinkRunResult>()

  // Run a candidate through the cache + runner; null when budget is exhausted.
  const evaluate = async (candidate: ScenarioSpec): Promise<ShrinkRunResult | null> => {
    const key = shrinkCacheKey(candidate)
    const memo = cache.get(key)
    if (memo !== undefined) {
      return memo
    }
    if (state.runs >= budget.maxRuns || nowMs() - state.startMs >= budget.maxWallMs) {
      return null
    }
    const result = await runner(candidate)
    state.runs += 1
    cache.set(key, result)
    return result
  }

  // Accept a candidate iff it re-fails the SAME fingerprint (predicate R15).
  const accepts = async (candidate: ScenarioSpec): Promise<ShrinkRunResult | null> => {
    const result = await evaluate(candidate)
    if (result === null) {
      return null
    }
    return matchesTarget(result, target.fingerprint) ? result : null
  }

  const state: ShrinkState = {
    best: spec,
    // bestRun/bestViolation are filled by the initial verification below.
    bestRun: undefined as unknown as ShrinkRunResult,
    bestViolation: target,
    runs: 0,
    moves: 0,
    startMs: 0,
  }
  state.startMs = nowMs()

  // Verify the input itself re-fails the target fingerprint. If it does NOT (or
  // the budget is already 0), return the input unchanged with minimal:false — an
  // always-valid repro, never a throw.
  const initial = await accepts(spec)
  if (initial === null) {
    const fallback = await evaluate(spec)
    return {
      scenario: spec,
      violation: target,
      run: fallback ?? {
        violation: target,
        traceHash: '',
        finalState: normalizeParts(target.witness),
        finalQueueDepth: 0,
      },
      provenance: { shrinkMoves: 0, runs: state.runs, minimal: false },
    }
  }
  state.bestRun = initial
  state.bestViolation = initial.violation ?? target

  // Try replacing `best` with `candidate` iff it re-fails; record the move.
  const tryReplace = async (candidate: ScenarioSpec): Promise<boolean> => {
    const result = await accepts(candidate)
    if (result === null) {
      return false
    }
    state.best = candidate
    state.bestRun = result
    state.bestViolation = result.violation ?? state.bestViolation
    state.moves += 1
    return true
  }

  let converged = true
  let stagnantRounds = 0

  // Global fixpoint loop over the per-family ddmin moves, cheapest-first.
  for (;;) {
    if (state.runs >= budget.maxRuns || nowMs() - state.startMs >= budget.maxWallMs) {
      converged = false
      break
    }
    const before = sizeOf(state.best)

    await moveM0DisableFaults(state, tryReplace)
    await moveM1DropOps(state, tryReplace)
    await moveM2ShrinkAdvances(state, tryReplace)
    await moveM3ShrinkConfig(state, tryReplace)
    await moveM4ShrinkFaultParams(state, tryReplace)
    await moveM5NarrowArgs(state, tryReplace)

    const after = sizeOf(state.best)
    if (after >= before) {
      stagnantRounds += 1
      if (stagnantRounds >= budget.maxStagnantRounds) {
        break
      }
    } else {
      stagnantRounds = 0
    }
  }

  return {
    scenario: state.best,
    violation: state.bestViolation,
    run: state.bestRun,
    provenance: { shrinkMoves: state.moves, runs: state.runs, minimal: converged },
  }
}

/** A scalar "size" used to detect a stagnant round (ops + faults + arg/advance magnitude). */
function sizeOf(spec: ScenarioSpec): number {
  let size = spec.ops.length * 100 + spec.faults.faults.length * 10
  for (const op of spec.ops) {
    if (op.kind === 'fire') {
      size += op.args.length
    } else if (op.kind === 'advance') {
      size += Math.min(op.dtMs, 1000)
    }
  }
  for (const f of spec.faults.faults) {
    if (f.kind === 'clock-skew') {
      size += Math.min(f.deltaMs, 1000)
    } else if (f.kind === 'timer-jitter') {
      size += Math.min(f.jitterMs, 1000)
    } else if (f.kind === 'overflow') {
      size += f.floodCount
    }
  }
  return size
}

// ── M0: disable faults (highest payoff, BEFORE op-drop) ──────────────────────

async function moveM0DisableFaults(
  state: ShrinkState,
  tryReplace: (c: ScenarioSpec) => Promise<boolean>,
): Promise<void> {
  if (state.best.faults.faults.length === 0) {
    return
  }
  // First try dropping the WHOLE fault plan (the highest-payoff move).
  const noFaults: ScenarioSpec = { ...state.best, faults: { faults: [] } }
  if (await tryReplace(noFaults)) {
    return
  }
  // Else drop faults one at a time (ddmin over the fault list).
  let i = 0
  while (i < state.best.faults.faults.length) {
    const reduced = state.best.faults.faults.filter((_, idx) => idx !== i)
    const candidate: ScenarioSpec = {
      ...state.best,
      faults: {
        faults: reduced,
        ...(state.best.faults.transitionTimeoutMs !== undefined
          ? { transitionTimeoutMs: state.best.faults.transitionTimeoutMs }
          : {}),
        ...(state.best.faults.reorderWindow !== undefined ? { reorderWindow: state.best.faults.reorderWindow } : {}),
      },
    }
    if (!(await tryReplace(candidate))) {
      i += 1
    }
    // if accepted, state.best changed; re-scan from the same index.
  }
}

// ── M1: drop ops (ddmin 1-minimality) with fault op-id re-keying (R22) ───────

async function moveM1DropOps(
  state: ShrinkState,
  tryReplace: (c: ScenarioSpec) => Promise<boolean>,
): Promise<void> {
  // Classic ddmin: try removing decreasing-size contiguous chunks, then single ops.
  let granularity = Math.max(1, Math.floor(state.best.ops.length / 2))
  while (granularity >= 1) {
    let progressed = true
    while (progressed) {
      progressed = false
      const n = state.best.ops.length
      for (let start = 0; start < n; start += granularity) {
        const ops = state.best.ops
        const kept = [...ops.slice(0, start), ...ops.slice(start + granularity)]
        if (kept.length === ops.length) {
          continue
        }
        const survivingIds = new Set(kept.map((o) => o.id))
        const candidate: ScenarioSpec = {
          ...state.best,
          ops: kept,
          faults: rekeyFaultPlan(state.best.faults, survivingIds),
        }
        if (await tryReplace(candidate)) {
          progressed = true
          break // op list shrank; restart the scan at this granularity.
        }
      }
    }
    if (granularity === 1) {
      break
    }
    granularity = Math.max(1, Math.floor(granularity / 2))
  }
}

// ── M2: shrink advances (binary-search dtMs downward) ────────────────────────

async function moveM2ShrinkAdvances(
  state: ShrinkState,
  tryReplace: (c: ScenarioSpec) => Promise<boolean>,
): Promise<void> {
  let i = 0
  while (i < state.best.ops.length) {
    const op = state.best.ops[i]
    if (op === undefined || op.kind !== 'advance' || op.dtMs <= 0) {
      i += 1
      continue
    }
    const reduced = await binarySearchDown(op.dtMs, 0, async (value) => {
      const next = withOpAt(state.best, i, { ...op, dtMs: value })
      return tryReplace(next)
    })
    // binarySearchDown applied accepted candidates via tryReplace as it went;
    // whether or not it reduced, advance to the next op.
    void reduced
    i += 1
  }
}

// ── M3: shrink config (gate every candidate through validateConfig errors-only) ─

async function moveM3ShrinkConfig(
  state: ShrinkState,
  tryReplace: (c: ScenarioSpec) => Promise<boolean>,
): Promise<void> {
  // Try removing each top-level state (and its referencing transitions) one at a
  // time. EVERY candidate is gated through validateConfig ERRORS-only BEFORE the
  // runner is invoked (DoD 4): a config-ERROR candidate is skipped WITHOUT a run;
  // a warnings-only candidate is NOT discarded.
  const stateNames = Object.keys(state.best.topology.states)
  if (stateNames.length <= 1) {
    return
  }
  let i = 0
  while (i < Object.keys(state.best.topology.states).length) {
    const names = Object.keys(state.best.topology.states)
    const name = names[i]
    if (name === undefined || name === state.best.topology.initialState) {
      i += 1
      continue
    }
    const candidate = removeStateFromSpec(state.best, name)
    if (candidate === null) {
      i += 1
      continue
    }
    // M3 GATE: validateConfig ERRORS-only, BEFORE the runner is touched.
    if (!configHasNoErrors(candidate)) {
      i += 1
      continue
    }
    if (!(await tryReplace(candidate))) {
      i += 1
    }
    // if accepted, the state set shrank; re-scan from the same index.
  }
}

// ── M4: binary-search fault params (deltaMs / jitterMs / floodCount) ─────────

async function moveM4ShrinkFaultParams(
  state: ShrinkState,
  tryReplace: (c: ScenarioSpec) => Promise<boolean>,
): Promise<void> {
  let i = 0
  while (i < state.best.faults.faults.length) {
    const f = state.best.faults.faults[i]
    if (f === undefined) {
      i += 1
      continue
    }
    if (f.kind === 'clock-skew' && f.deltaMs > 0) {
      await binarySearchDown(f.deltaMs, 0, async (value) =>
        tryReplace(withFaultAt(state.best, i, { ...f, deltaMs: value })),
      )
    } else if (f.kind === 'timer-jitter' && f.jitterMs > 0) {
      await binarySearchDown(f.jitterMs, 0, async (value) =>
        tryReplace(withFaultAt(state.best, i, { ...f, jitterMs: value })),
      )
    } else if (f.kind === 'overflow' && f.floodCount > 1) {
      await binarySearchDown(f.floodCount, 1, async (value) =>
        tryReplace(withFaultAt(state.best, i, { ...f, floodCount: value })),
      )
    }
    i += 1
  }
}

// ── M5: narrow Op.args ────────────────────────────────────────────────────────

async function moveM5NarrowArgs(
  state: ShrinkState,
  tryReplace: (c: ScenarioSpec) => Promise<boolean>,
): Promise<void> {
  let i = 0
  while (i < state.best.ops.length) {
    const op = state.best.ops[i]
    if (op === undefined || op.kind !== 'fire' || op.args.length === 0) {
      i += 1
      continue
    }
    // First try dropping ALL args.
    const emptied = withOpAt(state.best, i, { ...op, args: [] })
    if (await tryReplace(emptied)) {
      // op at index i now has empty args; move on.
      i += 1
      continue
    }
    // Else binary-search each arg toward 0.
    const current = state.best.ops[i]
    if (current !== undefined && current.kind === 'fire') {
      for (let a = 0; a < current.args.length; a++) {
        const cur = state.best.ops[i]
        if (cur === undefined || cur.kind !== 'fire') {
          break
        }
        const value = cur.args[a]
        if (value === undefined || value === 0) {
          continue
        }
        await binarySearchDown(Math.abs(value), 0, async (mag) => {
          const liveCur = state.best.ops[i]
          if (liveCur === undefined || liveCur.kind !== 'fire') {
            return false
          }
          const newArgs = liveCur.args.slice()
          newArgs[a] = value < 0 ? -mag : mag
          return tryReplace(withOpAt(state.best, i, { ...liveCur, args: newArgs }))
        })
      }
    }
    i += 1
  }
}

// ── shrink primitives ─────────────────────────────────────────────────────────

/**
 * Binary-search a value downward toward `floor`, applying `apply(value)` (which
 * returns true iff the candidate re-failed and was accepted). Each accepted value
 * lowers the search ceiling. Returns the lowest accepted value, or the original
 * `start` if none was accepted. Bounded by `log2(start - floor)` probes.
 */
async function binarySearchDown(
  start: number,
  floor: number,
  apply: (value: number) => Promise<boolean>,
): Promise<number> {
  let lo = floor
  let hi = start
  let bestAccepted = start
  // Try the floor first (the maximal reduction).
  if (await apply(floor)) {
    return floor
  }
  lo = floor + 1
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (mid === hi) {
      break
    }
    if (await apply(mid)) {
      bestAccepted = mid
      hi = mid
    } else {
      lo = mid + 1
    }
  }
  return bestAccepted
}

/** Return a copy of `spec` with the op at `index` replaced by `op`. */
function withOpAt(spec: ScenarioSpec, index: number, op: Op): ScenarioSpec {
  const ops = spec.ops.slice()
  ops[index] = op
  return { ...spec, ops }
}

/** Return a copy of `spec` with the fault at `index` replaced by `f`. */
function withFaultAt(spec: ScenarioSpec, index: number, f: FaultSpec): ScenarioSpec {
  const faults = spec.faults.faults.slice()
  faults[index] = f
  return {
    ...spec,
    faults: {
      faults,
      ...(spec.faults.transitionTimeoutMs !== undefined ? { transitionTimeoutMs: spec.faults.transitionTimeoutMs } : {}),
      ...(spec.faults.reorderWindow !== undefined ? { reorderWindow: spec.faults.reorderWindow } : {}),
    },
  }
}

/**
 * Return a copy of `spec` with the top-level state `name` removed plus any
 * transition referencing it (so the candidate stays structurally derivable). The
 * `configHasNoErrors` gate then rejects anything that becomes a validateConfig
 * ERROR. Returns null when the removal is structurally impossible.
 */
function removeStateFromSpec(spec: ScenarioSpec, name: string): ScenarioSpec | null {
  const states: Record<string, unknown> = {}
  for (const [sn, sv] of Object.entries(spec.topology.states)) {
    if (sn !== name) {
      states[sn] = sv
    }
  }
  if (Object.keys(states).length === 0) {
    return null
  }
  // Drop transitions whose from/to references the removed state (by leaf name).
  const events: Record<string, unknown> = {}
  for (const [en, ev] of Object.entries(spec.topology.events)) {
    const e = ev as { transitions: ReadonlyArray<{ from: string; to: string }> }
    const transitions = e.transitions.filter((t) => !referencesState(t.from, name) && !referencesState(t.to, name))
    if (transitions.length > 0) {
      events[en] = { ...e, transitions }
    }
  }
  const topology = {
    ...spec.topology,
    states: states as typeof spec.topology.states,
    events: events as typeof spec.topology.events,
  }
  return { ...spec, topology }
}

/** True iff a dotted state path `path` references the top-level state `name`. */
function referencesState(path: string, name: string): boolean {
  return path === name || path.startsWith(`${name}.`)
}
