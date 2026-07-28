/**
 * @module sim/check-machine
 * @unstable
 *
 * `checkMachine` — the consumer-facing DYNAMIC config check (MASTER §2 / task #17
 * / W6). A consumer hands over their machine config + an event alphabet and gets a
 * TRUSTED {@link CheckReport}. The contract is engineered so the sim-audit findings
 * are UNEXPRESSIBLE:
 *   - A2 fail-open: `ok:true ⇒ oraclesRun>0 ∧ transitionsFired>0` (a green verdict
 *     over ZERO oracles or a MOTIONLESS machine is impossible).
 *   - A4 liveness: livelocks are a HEADLINE field and force `ok:false`; `mode`
 *     defaults to `'both'`.
 *   - A5 escape: a real-timer escape becomes a typed warning and (under the strict
 *     default `failOn`) fails the verdict.
 *   - degradation-in-warnings: a coverage gap PROVEN at a saturated plateau (a
 *     dead event that never fired) fails the verdict by default — it is not left to
 *     the social contract "please read the warnings" that A2 was.
 *   - F7 swallowed error: a throw inside a {@link MachineInvariant} is a violation,
 *     never swallowed.
 *
 * THIS IS FUZZING, NOT MODEL-CHECKING. The absence of a finding does not prove
 * correctness — completeness depends on the event alphabet and the payload
 * generators. See the README section for what the sim does NOT check.
 *
 * It runs over the SHARED, tested substrate ({@link runSimulation} → the invariant
 * runner + the liveness plane), so it inherits every oracle fix from W5a/W5b and
 * cannot drift from them.
 */
import type { Adapter, StateMachineConfig } from '../index'
import { compileModel } from '../model'
import { runSimulation } from './public'
import type { SimResult, SimWarning } from './public'
import type { LivenessResult } from './liveness'
import type { TraceFrame } from './trace'

// ── public option / report surface ──────────────────────────────────────────

/**
 * A deterministic RNG handed to a payload generator. Minimal by design — a
 * generator that needs more should derive it from these primitives so the draw
 * stream stays reproducible.
 */
export interface Rng {
  /** A float in [0,1). */
  float(): number
  /** An int in [0,max). */
  int(max: number): number
  /** Pick one element (throws on an empty array). */
  pick<A>(xs: readonly A[]): A
}

/**
 * The snapshot a payload generator and a {@link MachineInvariant} see AFTER a step.
 * It INCLUDES the owner/adaptee `data` (not just the state name) — a stateful MB3
 * event is a verdict object meaningful only relative to the current gate, and an
 * invariant that cannot read the data cannot check it.
 */
export interface MachineSnapshot<T extends object> {
  /** normalized '|'-sorted active configuration. */
  readonly config: string
  /** the active leaf/state string as the engine reports it. */
  readonly state: string
  /** the live owner data (read-only view). */
  readonly data: Readonly<T>
  readonly queueDepth: number
}

export interface CheckEventSpec<T extends object> {
  readonly name: string
  /**
   * Deterministic arg generator that SEES the current configuration snapshot.
   * Without a snapshot the fuzzer is blind to state — the single point where
   * generation sees state. (MVP: object payloads are not yet driven end-to-end;
   * an event with no `payload` is fuzzed arg-free and listed in a `no-payload`
   * warning — see the module contract.)
   */
  readonly payload?: (rng: Rng, snapshot: MachineSnapshot<T>) => readonly unknown[]
  /** Relative fuzzing weight (default 1). */
  readonly weight?: number
}

export interface MachineInvariant<T extends object> {
  readonly name: string
  /**
   * Predicate over the post-step snapshot. `false` OR a throw is a violation — a
   * throw inside the check is NEVER swallowed (anti-F7).
   */
  readonly check: (snapshot: MachineSnapshot<T>) => boolean
}

/** What flips `ok` to false. The strict default (CI) is EVERY cause. */
export type FailCause =
  | 'violation'
  | 'deadlock'
  | 'non-converging'
  | 'no-progress'
  | 'livelock'
  | 'escape'
  | 'degradation'

export type WarningKind =
  | 'no-payload'
  | 'timer-escape'
  | 'dead-events-at-plateau'
  | 'uncovered-at-plateau'
  | 'residual-rejection'

/**
 * The owner source. A SINGLE live owner reused across N runs breaks run
 * independence and seed determinism (run N mutates the owner for run N+1), so a
 * FACTORY is MANDATORY when `runs>1` — otherwise `checkMachine` throws.
 */
export type OwnerSource<T extends object> = T | Adapter<T> | (() => T | Adapter<T>)

export interface CheckOptions<T extends object> {
  readonly events?: readonly CheckEventSpec<T>[]
  readonly seed?: string | bigint
  readonly steps?: number
  readonly runs?: number
  readonly invariants?: readonly MachineInvariant<T>[]
  readonly mode?: 'safety' | 'liveness' | 'both'
  /** Default: STRICT — every {@link FailCause}. */
  readonly failOn?: readonly FailCause[]
  /** Point-relax `degradation` by warning KIND instead of surrendering the class. */
  readonly degradationExcept?: readonly WarningKind[]
  readonly onRealTimerEscape?: 'warn' | 'fail' | 'ignore'
}

export interface CheckWarning {
  readonly kind: WarningKind
  readonly detail: string
}

export interface CheckViolation {
  readonly invariant: string
  /** 'engine' — an engine-synthetic finding (A1): a bug for the ENGINE developer,
   *  NOT the machine author. 'builtin'/'user' — about the consumer's machine. */
  readonly kind: 'engine' | 'builtin' | 'user'
  readonly witness: string
  /** A repro snippet RELATIVE to the consumer's owner factory (the sim cannot know
   *  the live owner's constructor). */
  readonly reproCode: string
}

export interface CheckReport {
  readonly ok: boolean
  /** ok===true ⇒ oraclesRun>0 (no green without a single oracle). */
  readonly oraclesRun: number
  /** ok===true ⇒ transitionsFired>0 (no green over a MOTIONLESS machine). */
  readonly transitionsFired: number
  readonly seed: string
  readonly runs: number
  readonly steps: number

  // ── coverage (a by-product of the normalized model) ──
  readonly reachableStates: readonly string[]
  readonly unreachableStates: readonly string[]
  readonly uncoveredTransitions: ReadonlyArray<{ event: string; from: string; to: string }>
  readonly deadEvents: readonly string[]
  /** Coverage saturation across runs — did it plateau, or is it still growing? */
  readonly saturation: { readonly plateauedAtRun: number | null; readonly newCoveragePerRun: readonly number[] }

  // ── structural findings ──
  readonly deadlocks: ReadonlyArray<{ state: string }>
  readonly livelocks: ReadonlyArray<{ reason: string }>

  // ── violations & warnings ──
  readonly violations: readonly CheckViolation[]
  readonly warnings: readonly CheckWarning[]
  /** The relaxable/contract causes that fired `ok:false`. NOTE: an engine-synthetic
   *  violation and a zero-oracle run also force `ok:false` but are NOT listed here
   *  (they are hard floors) — branch on `ok`, not on `failedOn.length`. */
  readonly failedOn: readonly FailCause[]
}

const STRICT_FAIL_ON: readonly FailCause[] = [
  'violation',
  'deadlock',
  'non-converging',
  'no-progress',
  'livelock',
  'escape',
  'degradation',
]

// ── implementation ──────────────────────────────────────────────────────────

/** Split a seed string/bigint into a bigint base for per-run derivation. */
function seedBase(seed: string | bigint | undefined): bigint {
  if (seed === undefined) {
    return 0x9e3779b97f4a7c15n
  }
  if (typeof seed === 'bigint') {
    return seed
  }
  // numeric string or arbitrary label → a stable bigint.
  if (/^\d+$/.test(seed)) {
    return BigInt(seed)
  }
  let h = 1469598103934665603n
  for (let i = 0; i < seed.length; i++) {
    h = (h ^ BigInt(seed.charCodeAt(i))) * 1099511628211n
    h &= 0xffffffffffffffffn
  }
  return h
}

/** Per-run seed derivation — distinct, deterministic, order-independent. */
function runSeed(base: bigint, run: number): string {
  const s = (base + BigInt(run) * 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn
  return s.toString()
}

/** Read the plain data object behind an owner (adaptee if it is an Adapter). */
function ownerData<T extends object>(owner: T | Adapter<T>): T {
  const maybe = owner as { adaptee?: T }
  return (maybe.adaptee ?? owner) as T
}

/** Resolve the OwnerSource into a factory, enforcing the runs>1 factory rule. */
function resolveOwnerFactory<T extends object>(source: OwnerSource<T>, runs: number): () => T | Adapter<T> {
  if (typeof source === 'function') {
    return source as () => T | Adapter<T>
  }
  if (runs > 1) {
    throw new Error(
      'checkMachine: runs>1 requires an owner FACTORY `() => owner` — a single live owner reused across runs breaks run independence and seed determinism (run N mutates the owner for run N+1). Pass `() => ({...})` instead of a live object.',
    )
  }
  return () => source
}

/**
 * Count steps whose settle-boundary CHANGED the configuration — the machine
 * actually moved. Keys on the boundary frame (the LAST frame of each step, whose
 * `from`=before / `to`=after span the whole step) so it counts BOTH event-fired
 * transitions AND timer/invoke-driven progress (a delayed transition changes the
 * config with NO `fireOutcome`, so a resolve-true-only count would falsely report
 * `no-progress` on a timer-driven machine). A cascading macrostep still counts as
 * one moved step.
 */
function countTransitions(frames: readonly TraceFrame[]): number {
  // boundary frame per step = the last frame carrying that step number.
  let n = 0
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    if (f === undefined) {
      continue
    }
    const next = frames[i + 1]
    const isBoundary = next === undefined || next.step !== f.step
    if (isBoundary && f.from !== f.to) {
      n++
    }
  }
  return n
}

/** Extract the '|'-split active leaf parts of a config string. */
function parts(config: string): string[] {
  return config.split('|').filter((p) => p.length > 0)
}

interface DeclaredModel {
  readonly leaves: readonly string[]
  readonly events: readonly string[]
  readonly transitions: ReadonlyArray<{ event: string; from: string; to: string }>
}

/** Enumerate declared leaf states, events, and transitions from the config. */
function declaredModel<T extends object>(config: StateMachineConfig<T>): DeclaredModel {
  const compiled = compileModel((config as { states: unknown }).states as Parameters<typeof compileModel>[0])
  const leaves = [...compiled.nodes.values()].filter((n) => n.kind === 'leaf').map((n) => n.id)
  const eventsObj = ((config as { events?: Record<string, unknown> }).events ?? {}) as Record<
    string,
    { transitions?: ReadonlyArray<{ from?: string; to?: string }> }
  >
  const events = Object.keys(eventsObj)
  const transitions: Array<{ event: string; from: string; to: string }> = []
  for (const event of events) {
    for (const t of eventsObj[event]?.transitions ?? []) {
      if (t.from !== undefined && t.to !== undefined) {
        transitions.push({ event, from: t.from, to: t.to })
      }
    }
  }
  return { leaves, events, transitions }
}

/**
 * Run a consumer's machine through the sim oracles over N independent runs and
 * return a trusted {@link CheckReport}. See the module contract for how the report
 * shape makes each sim-audit finding unexpressible.
 */
export async function checkMachine<T extends object>(
  config: StateMachineConfig<T>,
  owner: OwnerSource<T>,
  options: CheckOptions<T> = {},
): Promise<CheckReport> {
  const runs = options.runs ?? 32
  const steps = options.steps ?? 1000
  const mode = options.mode ?? 'both'
  const failOn = options.failOn ?? STRICT_FAIL_ON
  const failSet = new Set<FailCause>(failOn)
  const degradationExcept = new Set<WarningKind>(options.degradationExcept ?? [])
  const escapePolicy = options.onRealTimerEscape ?? 'warn'
  const userInvariants = options.invariants ?? []
  const eventSpecs = options.events ?? []

  const factory = resolveOwnerFactory(owner, runs)
  const base = seedBase(options.seed)
  const decl = declaredModel(config)

  // Aggregation accumulators.
  const reached = new Set<string>()
  const firedEvents = new Set<string>()
  const firedTransitions = new Set<string>()
  const livelocks: Array<{ reason: string }> = []
  const violations: CheckViolation[] = []
  const warnings: CheckWarning[] = []
  let oraclesRun = 0
  let transitionsFired = 0
  let sawEscape = false
  let sawResidualRejection = false
  const newCoveragePerRun: number[] = []

  const canonicalSeed = runSeed(base, 0)

  for (let run = 0; run < runs; run++) {
    const seed = runSeed(base, run)
    const runOwner = factory()
    const data = ownerData(runOwner)

    // User-invariant evaluation on the SETTLE-BOUNDARY frame of each step — the
    // LAST frame carrying that step number, whose config is the SETTLED
    // configuration (the driver emits a step's frames in one batch AFTER settle, so
    // the live owner is already at that step's rest state). Evaluating the FIRST
    // frame would check a mid-cascade seam config (a violation in the settled state
    // would be missed; a transient seam state would false-fire), and mismatch the
    // settled `data`. We therefore buffer the step's last frame + a snapshot of the
    // owner data captured DURING that step (the data does not change within a
    // settled step) and evaluate when the step advances / the run ends. A throw is
    // a violation (anti-F7). NOTE: `data` is a SHALLOW copy — nested mutable fields
    // are shared; a deep invariant should snapshot what it needs.
    const userViolationThisRun: Array<{ name: string; witness: string }> = []
    let curStep = -1
    let boundaryFrame: TraceFrame | undefined
    let boundaryData: T | undefined
    const evalBoundary = (): void => {
      if (boundaryFrame === undefined || boundaryData === undefined || userInvariants.length === 0) {
        return
      }
      const snapshot: MachineSnapshot<T> = {
        config: boundaryFrame.to,
        state: boundaryFrame.to,
        data: boundaryData as Readonly<T>,
        queueDepth: boundaryFrame.queue.internal + boundaryFrame.queue.external,
      }
      for (const inv of userInvariants) {
        let held: boolean
        try {
          held = inv.check(snapshot)
        } catch {
          held = false // a throw inside the check is a violation, not swallowed.
        }
        if (!held) {
          userViolationThisRun.push({ name: inv.name, witness: boundaryFrame.to })
        }
      }
    }
    const onTrace = (frame: TraceFrame): void => {
      if (frame.step !== curStep) {
        evalBoundary() // the previous step's boundary (its data was captured during it).
        curStep = frame.step
      }
      boundaryFrame = frame // keeps updating → ends as the LAST frame of this step.
      boundaryData = { ...data } // snapshot the settled owner data for THIS step.
    }

    const result: SimResult = await runSimulation<T>(
      () => ({ config, owner: runOwner }),
      { seed, steps, mode, onTrace },
    )
    evalBoundary() // the FINAL step's boundary (no later frame triggers it).

    oraclesRun = Math.max(oraclesRun, result.oraclesRun + userInvariants.length)

    // Coverage from this run's trace.
    const before = reached.size + firedEvents.size + firedTransitions.size
    let prevConfig: string | undefined
    for (const f of result.trace) {
      for (const p of parts(f.to)) {
        reached.add(p)
      }
      if (f.event !== undefined && f.fireOutcome === 'resolve-true') {
        firedEvents.add(f.event)
        if (prevConfig !== undefined && f.to !== prevConfig) {
          for (const from of parts(prevConfig)) {
            for (const to of parts(f.to)) {
              firedTransitions.add(`${f.event} ${from} ${to}`)
            }
          }
        }
      }
      prevConfig = f.to
    }
    newCoveragePerRun.push(reached.size + firedEvents.size + firedTransitions.size - before)

    transitionsFired += countTransitions(result.trace)

    // Structural: livelocks (A4 headline).
    for (const l of result.livelocks ?? []) {
      livelocks.push({ reason: livenessReason(l) })
    }

    // Engine / builtin violation (kind carried by the sim).
    if (result.violation !== undefined) {
      const kind = result.violation.kind === 'engine' ? 'engine' : 'builtin'
      violations.push({
        invariant: result.violation.invariantId,
        kind,
        witness: result.violation.witness,
        reproCode: reproCode(config, seed, steps, mode),
      })
    }

    // User-invariant violations (kind user).
    for (const uv of userViolationThisRun) {
      violations.push({ invariant: uv.name, kind: 'user', witness: uv.witness, reproCode: reproCode(config, seed, steps, mode) })
    }

    // Warnings surfaced by the sim (A5 escape / residual rejection).
    for (const w of result.warnings ?? []) {
      if (w.kind === 'timer-escape') {
        sawEscape = true
      } else if (w.kind === 'unhandled-rejection') {
        sawResidualRejection = true
      }
      warnings.push(mapSimWarning(w))
    }
  }

  // ── coverage deltas vs the declared model ──
  const reachableStates = decl.leaves.filter((s) => reached.has(s))
  const unreachableStates = decl.leaves.filter((s) => !reached.has(s))
  const leafSet = new Set(decl.leaves)
  // `done.state.<C>` join events are raised INTERNALLY by the engine (never fired
  // externally by the fuzzer), so their absence is not a real dead event — exclude.
  const deadEvents = decl.events.filter((e) => !firedEvents.has(e) && !e.startsWith('done.state.'))
  const isLiteralLeaf = (t: { from: string; to: string }): boolean =>
    !t.from.includes('*') && !t.to.includes('*') && leafSet.has(t.from) && leafSet.has(t.to)
  // Only LITERAL leaf-to-leaf transitions are soundly trackable; wildcard /
  // composite-source transitions are excluded (counting them uncovered would
  // false-positive). A self-loop (from===to) changes no config -> covered iff its
  // event fired from a reached source.
  const uncoveredTransitions = decl.transitions.filter((t) => {
    if (!isLiteralLeaf(t)) {
      return false
    }
    if (t.from === t.to) {
      return !(firedEvents.has(t.event) && reached.has(t.from))
    }
    return !firedTransitions.has(`${t.event} ${t.from} ${t.to}`)
  })

  // saturation: plateaued once new coverage was 0 for the tail of the runs.
  const plateauedAtRun = computePlateau(newCoveragePerRun)

  // ── typed warnings that are checkMachine's own (not from the sim) ──
  const eventsWithPayload = new Set(eventSpecs.filter((e) => e.payload !== undefined).map((e) => e.name))
  const noPayload = decl.events.filter((e) => !eventsWithPayload.has(e))
  if (noPayload.length > 0) {
    warnings.push({
      kind: 'no-payload',
      detail: `${noPayload.length} event(s) fuzzed without a payload generator (${noPayload.slice(0, 8).join(', ')}${noPayload.length > 8 ? ', …' : ''}) — if they take arguments, those branches are NOT covered.`,
    })
  }
  if (plateauedAtRun !== null && deadEvents.length > 0) {
    warnings.push({ kind: 'dead-events-at-plateau', detail: `coverage plateaued at run ${plateauedAtRun} with ${deadEvents.length} event(s) that never fired: ${deadEvents.join(', ')}` })
  }
  if (plateauedAtRun !== null && uncoveredTransitions.length > 0) {
    warnings.push({ kind: 'uncovered-at-plateau', detail: `coverage plateaued at run ${plateauedAtRun} with ${uncoveredTransitions.length} declared transition(s) never taken` })
  }

  // ── structural deadlocks: a REACHED non-final leaf that CANNOT exit ──
  const finalLeaves = new Set(
    [...compileModel((config as { states: unknown }).states as Parameters<typeof compileModel>[0]).nodes.values()].filter((n) => n.isFinal).map((n) => n.id),
  )
  // CONSERVATIVE exit test — a state is only a deadlock if NO declared transition
  // could possibly fire from it. Besides a literal `from === state`, an outgoing
  // path exists via a full wildcard `from:'*'`, a prefix wildcard `from:'p.*'`
  // (matching descendants of `p`), or an ANCESTOR-composite `from:'p'` (a
  // transition declared on a composite the leaf is nested in). Missing any of these
  // would FALSE-flag a correct machine that exits via a wildcard/ancestor rule.
  const froms = decl.transitions.map((t) => t.from)
  const couldExitFrom = (state: string): boolean =>
    froms.some((from) => {
      if (from === state || from === '*') {
        return true
      }
      if (from.endsWith('.*')) {
        const prefix = from.slice(0, -2)
        return state === prefix || state.startsWith(`${prefix}.`)
      }
      // ancestor composite: `from` is a strict path-prefix of the leaf.
      return state.startsWith(`${from}.`)
    })
  const deadlocks = reachableStates
    .filter((s) => !finalLeaves.has(s) && !couldExitFrom(s))
    .map((s) => ({ state: s }))

  // ── the ok predicate (§CAR-1) ──
  // The A2/A4 CONTRACT causes are HARD floors — they fail `ok` UNCONDITIONALLY,
  // NOT gated by `failOn`. Otherwise `failOn: []` (or any subset omitting them)
  // would make `ok:true` over a MOTIONLESS machine / an unhandled violation / a
  // livelock — exactly the fail-open the facade exists to make unexpressible. Only
  // the softer, genuinely-relaxable causes honor `failOn`.
  const HARD_CAUSES: ReadonlySet<FailCause> = new Set<FailCause>(['no-progress', 'livelock', 'violation'])
  const engineViolation = violations.some((v) => v.kind === 'engine')

  const fired = new Set<FailCause>()
  if (violations.some((v) => v.kind !== 'engine')) {
    fired.add('violation')
  }
  if (deadlocks.length > 0) {
    fired.add('deadlock')
  }
  if (livelocks.length > 0) {
    fired.add('livelock')
  }
  if (transitionsFired === 0) {
    fired.add('no-progress')
  }
  // escape: 'ignore' never fires it; 'fail' is a HARD floor (the option promised a
  // fail); 'warn' is failOn-gated.
  if (sawEscape && escapePolicy !== 'ignore') {
    fired.add('escape')
  }
  const escapeHard = escapePolicy === 'fail' && sawEscape
  // degradation: only the PLATEAU-PROVEN DEAD-EVENT gap is a degradation fail — an
  // event that never fired across a SATURATED coverage sweep. 'uncovered-at-plateau'
  // is DEMOTED to advisory: literal-transition coverage over a content trace is
  // fragile for wildcard / composite-source / self-loop / parallel configs, so it
  // must not fail a correct machine. 'no-payload' / 'residual-rejection' are also
  // advisory (arg-arity is not statically knowable — a blanket fail would be false
  // degradation + alert fatigue).
  const DEGRADATION_KINDS = new Set<WarningKind>(['dead-events-at-plateau'])
  const degradationWarnings = warnings.filter((w) => DEGRADATION_KINDS.has(w.kind) && !degradationExcept.has(w.kind))
  if (degradationWarnings.length > 0) {
    fired.add('degradation')
  }

  // A cause fails `ok` iff it is HARD, or it is an escape-'fail' floor, or `failOn`
  // opted into it. Report `failedOn` in a stable order for determinism.
  const failedOn: FailCause[] = STRICT_FAIL_ON.filter(
    (c) => fired.has(c) && (HARD_CAUSES.has(c) || failSet.has(c) || (c === 'escape' && escapeHard)),
  )

  // oraclesRun===0 is a HARD fail regardless of failOn (nothing was checked).
  const oracleFloorBroken = oraclesRun === 0
  const ok = failedOn.length === 0 && !engineViolation && !oracleFloorBroken
  void sawResidualRejection // surfaced as a warning; not its own fail cause (advisory).

  return {
    ok,
    oraclesRun,
    transitionsFired,
    seed: canonicalSeed,
    runs,
    steps,
    reachableStates,
    unreachableStates,
    uncoveredTransitions,
    deadEvents,
    saturation: { plateauedAtRun, newCoveragePerRun },
    deadlocks,
    livelocks,
    violations,
    warnings,
    failedOn,
  }
}

function livenessReason(l: LivenessResult): string {
  return l.reason ?? l.verdict
}

function mapSimWarning(w: SimWarning): CheckWarning {
  if (w.kind === 'timer-escape') {
    return { kind: 'timer-escape', detail: w.message }
  }
  return { kind: 'residual-rejection', detail: w.message }
}

function reproCode<T extends object>(config: StateMachineConfig<T>, seed: string, steps: number, mode: string): string {
  const name = (config as { name?: string }).name ?? 'machine'
  return [
    `// reproduce this finding (owner comes from YOUR factory):`,
    `await checkMachine(${name}Config, ${name}OwnerFactory, {`,
    `  seed: '${seed}', steps: ${steps}, mode: '${mode}', runs: 1,`,
    `})`,
  ].join('\n')
}

/** The first run index after which no run added new coverage (a stable plateau). */
function computePlateau(deltas: readonly number[]): number | null {
  if (deltas.length === 0) {
    return null
  }
  // find the last run with a non-zero delta; plateau is the run AFTER it, iff there
  // is at least one zero-delta run following (proof the coverage actually settled).
  let lastGrowth = -1
  for (let i = 0; i < deltas.length; i++) {
    if ((deltas[i] ?? 0) > 0) {
      lastGrowth = i
    }
  }
  if (lastGrowth === -1) {
    return 0 // never grew after run 0 — plateaued immediately.
  }
  if (lastGrowth < deltas.length - 1) {
    return lastGrowth + 1
  }
  return null // still growing on the final run — not plateaued.
}
