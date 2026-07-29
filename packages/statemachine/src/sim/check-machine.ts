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
import type { Adapter, LifecycleEvent, StateMachineConfig } from '../index'
import { isAdapter } from '../index'
import { compileModel } from '../model'
import type { CompiledModel } from '../model'
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
   * generation sees state.
   *
   * W8: object payloads ARE driven end-to-end. The returned values are forwarded
   * VERBATIM to `fireEvent` (after the explicit Adapter positional), so a guard or
   * `onTransition` declared as `(owner, verdict) => …` receives `verdict` and its
   * arg-dependent branches become reachable. An event with NO `payload` is still
   * fuzzed arg-free and listed in a `no-payload` warning; declaring a `payload`
   * removes that event from the warning.
   *
   * Determinism: the `rng` is a seed-derived child stream that is INDEPENDENT of
   * the op-selection stream (see `SimEventPayload` in public.ts), so the same seed
   * always yields the same payload sequence. A THROW here is not swallowed.
   *
   * SCOPE LIMIT (W8): payload-driven findings are SEED-REPRODUCIBLE but NOT
   * corpus-serialized — the persisted `ScenarioSpec` keeps number-only args on
   * purpose (an object would collapse in the shrinker's memo key and yield an
   * UNVERIFIED "minimal" repro; see the `## W8` note in sim/scenario.ts). So a
   * failure found via a payload generator is replayed by re-running the SAME
   * seed + the same generator, and it is not shrinkable into a standalone repro
   * artifact yet.
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

/**
 * What flips `ok` to false. The strict default (CI) is EVERY cause.
 *
 * `'non-converging'` fires from {@link CheckReport.nonConvergingRegions} — a
 * parallel region that can never (or, at a saturated coverage plateau, never
 * did) reach a final sub-state, so the composite's `done.state.<C>` join can
 * never complete. It is `failOn`-gated (NOT a hard floor): the dynamic half of
 * the finding is fuzzer-relative, and a hard floor must be provable.
 */
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
  /** A guard that never returned `true` across a SATURATED sweep (advisory). */
  | 'dead-guard-at-plateau'
  /** Detail carrier for {@link CheckReport.nonConvergingRegions}. */
  | 'non-converging-region'
  /** The initial-configuration invariant pass could not run — see the detail. */
  | 'init-check-skipped'

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
  /**
   * A repro snippet RELATIVE to the consumer's owner factory (the sim cannot know
   * the live owner's constructor).
   *
   * ## NOT MINIMIZED — and why (W8/V7, honest no-op)
   * This is the FULL failing run pinned to its seed, NOT a shrunk 1-minimal
   * repro. The package DOES ship a structured ddmin minimizer
   * (`sim/shrinker.ts`), and it is deliberately NOT wired in here — three
   * structural mismatches, not a scheduling decision:
   *
   *  1. **Different input type.** `shrink()` reduces a {@link ScenarioSpec} —
   *     a JSON-serializable `TopologySpec` whose callbacks are closure-free
   *     inlined SOURCE STRINGS (`sim/scenario.ts` R13). `checkMachine` runs the
   *     consumer's LIVE `StateMachineConfig`, whose guards/actions are real
   *     closures over consumer scope. There is no total function from the
   *     latter to the former, so the shrinker cannot even be handed the input.
   *  2. **Different predicate.** The shrink predicate is strict FULL-TUPLE
   *     equality on a builtin-oracle {@link Violation.fingerprint} (R15). A
   *     `kind:'user'` violation here is produced OUTSIDE the oracle registry
   *     (a consumer predicate evaluated on the settle-boundary frame) and has
   *     no fingerprint to match, so ddmin has no acceptance test.
   *  3. **Payloads are not corpus-serializable.** Per the `## W8` note in
   *     `sim/scenario.ts`, the persisted op stream keeps NUMBER-ONLY args on
   *     purpose — an object payload collapses in the shrinker's memo key and
   *     would yield an UNVERIFIED "minimal" repro. A finding reached through a
   *     {@link CheckEventSpec.payload} generator is therefore unshrinkable by
   *     construction.
   *
   * Emitting a `minimalTrace` we cannot verify would be worse than emitting
   * none — a false "minimal" repro sends the consumer to bisect the wrong
   * thing. To narrow a finding TODAY: re-run the printed snippet (it is
   * `runs:1` and seed-pinned, so it is bit-reproducible), then bisect `steps`
   * downward by hand — the run is deterministic, so the smallest `steps` that
   * still fails is a valid minimal witness.
   */
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
  /**
   * SPEC §13.1 GUARD COVERAGE — per DECLARED guarded transition, did its
   * predicate ever return `true` / ever return `false`?
   *
   * `sawTrue:false` is the classic silent state-machine bug: a DEAD BRANCH the
   * machine can never take. `sawFalse:false` is the mirror — a guard that is
   * pure overhead (it never blocked anything) and may be hiding a typo.
   *
   * Sourced from the W8/V1 `IMonitor.recordLifecycle` channel (`kind:'guard'`,
   * `edge:'end'`), which reports guard EXECUTIONS: the engine caches a guard
   * result per microstep, so a candidate governing several active leaves still
   * contributes exactly one record. A guard that THREW counts as `sawFalse`
   * (the engine leaves the transition disabled and reports `outcome:false`).
   *
   * SEEDED FROM THE CONFIG, not from the trace: every declared guarded
   * transition appears here, so a guard that was NEVER EVALUATED (its source
   * state was never reached) is visible as `{sawTrue:false, sawFalse:false}`
   * rather than silently absent.
   *
   * `transition` is the engine's own `"<from> -> <to>"` label, rendered as
   * DECLARED (a wildcard source appears as `'* -> c'`). Two events declaring the
   * SAME `from`/`to` pair share ONE row whose flags are the UNION over them —
   * see {@link guardKey} for why finer keying is not available from the channel
   * and why the resulting imprecision cannot manufacture a false dead guard.
   *
   * ADVISORY, NOT A FAIL CAUSE: a guard's `true` branch routinely depends on a
   * payload the fuzzer cannot synthesize (see the `no-payload` warning) or on
   * data reached only through a longer prefix. Failing on it by default would
   * be the same false-degradation trap that demoted `uncovered-at-plateau`. A
   * plateau-proven dead guard IS surfaced as a `dead-guard-at-plateau` warning;
   * assert on THIS field when you want it to break your build.
   */
  readonly guardOutcomes: ReadonlyArray<{ transition: string; sawTrue: boolean; sawFalse: boolean }>
  /** Coverage saturation across runs — did it plateau, or is it still growing? */
  readonly saturation: { readonly plateauedAtRun: number | null; readonly newCoveragePerRun: readonly number[] }

  // ── structural findings ──
  readonly deadlocks: ReadonlyArray<{ state: string }>
  readonly livelocks: ReadonlyArray<{ reason: string }>
  /**
   * Parallel regions that cannot converge — the region never reaches a final
   * sub-state, so its composite's `done.state.<C>` join can never fire.
   *
   * ONLY JUSTIFIED ENTRIES ARE LISTED (a machine the fuzzer merely did not
   * drive to completion is NOT the same as a structurally non-convergent one,
   * and a false finding here is worse than a missing one). Two admissible
   * origins:
   *
   *  - **STRUCTURAL (unconditional).** The config declares `done.state.<C>` as
   *    an event, but region `R` of `C` contains NO direct final sub-state and
   *    NO nested composite that could complete. Per the engine's
   *    `isCompositeDone`, `R` can then never be complete, so the join is
   *    provably unreachable. Reported regardless of the run budget.
   *  - **DYNAMIC (plateau-gated).** `R` DOES declare final sub-states, `R` was
   *    ENTERED during the sweep, none of its final sub-states was ever reached,
   *    AND coverage PLATEAUED (`saturation.plateauedAtRun !== null`) — the same
   *    saturation proof `deadEvents` uses before it is allowed to fail a
   *    verdict. Without a plateau the entry is OMITTED, not reported as a maybe.
   *
   * Fires the `'non-converging'` {@link FailCause} when non-empty and `failOn`
   * opted in (the strict default does).
   */
  readonly nonConvergingRegions: ReadonlyArray<{ composite: string; region: string }>

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

/**
 * W8: build the `SimOptions.eventPayload` bridge from the consumer's per-event
 * `CheckEventSpec.payload` generators, or `undefined` when NOT ONE spec declares
 * a payload.
 *
 * Returning `undefined` in the no-payload case is load-bearing, not a micro-
 * optimization: `Simulator.pickOp` skips the payload draw entirely when the hook
 * is absent, which is what keeps a payload-free run's PRNG stream — and therefore
 * its `traceHash` — identical to the pre-W8 behavior.
 *
 * `data` is read through a THUNK rather than captured by value because the run's
 * owner is mutated in place by the machine; the generator must see the LIVE data
 * at the moment of the draw, not a construction-time copy. The sim also offers a
 * `snapshot.data`, but we override it with the checkMachine-resolved owner data,
 * which is correct even for a consumer-supplied Adapter with no `adaptee`.
 */
function buildEventPayload<T extends object>(
  specs: readonly CheckEventSpec<T>[],
  liveData: () => T,
): ((event: string, rng: Rng, snapshot: { config: string; state: string; queueDepth: number }) => readonly unknown[]) | undefined {
  const byName = new Map<string, CheckEventSpec<T>>()
  for (const s of specs) {
    if (s.payload !== undefined) {
      byName.set(s.name, s)
    }
  }
  if (byName.size === 0) {
    return undefined
  }
  return (event, rng, snapshot) => {
    const gen = byName.get(event)?.payload
    if (gen === undefined) {
      return []
    }
    const view: MachineSnapshot<T> = {
      config: snapshot.config,
      state: snapshot.state,
      data: liveData() as Readonly<T>,
      queueDepth: snapshot.queueDepth,
    }
    return gen(rng, view)
  }
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
  /**
   * Declared GUARDED transitions, in declaration order and de-duplicated, keyed
   * by {@link guardKey}. Seeds {@link CheckReport.guardOutcomes} so a
   * never-EVALUATED guard is still reported.
   */
  readonly guardedTransitions: readonly string[]
  /** The normalized model — reused for final leaves and region enumeration. */
  readonly compiled: CompiledModel
}

/**
 * The identity of ONE guard row in {@link CheckReport.guardOutcomes}: the
 * engine's own transition label, `` `${transition.from} -> ${transition.to}` ``.
 *
 * ## Why this label and not a finer one (a documented aggregation limit)
 * The label is NOT UNIQUE — two DIFFERENT events may declare the same `from`/`to`
 * pair with different guards, and they collapse into ONE row whose flags are the
 * UNION over all of them. Finer keying is not available: the engine's
 * `kind:'guard'` lifecycle record carries `transition` but NO `event` (only the
 * state-hook records carry the driving event name), so the channel cannot tell
 * two same-label guards apart.
 *
 * The imprecision runs in the SAFE direction, which is why the union is
 * acceptable: `sawTrue:false` stays SOUND (no guard under that label EVER passed
 * ⇒ every one of them is a dead branch), and only `sawTrue:true` becomes
 * under-specific ("at least one of them passed"). A finer key that guessed would
 * risk the opposite — calling a live guard dead.
 *
 * Built with the SAME template literal the engine uses, so a multi-source array
 * `from` renders identically on both sides (`${['a','b']}` -> `'a,b'`) and a
 * config-seeded key matches an emitted one.
 */
function guardKey(from: unknown, to: unknown): string {
  return `${String(from)} -> ${String(to)}`
}

/** Enumerate declared leaf states, events, and transitions from the config. */
function declaredModel<T extends object>(config: StateMachineConfig<T>): DeclaredModel {
  const compiled = compileModel((config as { states: unknown }).states as Parameters<typeof compileModel>[0])
  const leaves = [...compiled.nodes.values()].filter((n) => n.kind === 'leaf').map((n) => n.id)
  const eventsObj = ((config as { events?: Record<string, unknown> }).events ?? {}) as Record<
    string,
    { transitions?: ReadonlyArray<{ from?: unknown; to?: unknown; guard?: unknown }> }
  >
  const events = Object.keys(eventsObj)
  const transitions: Array<{ event: string; from: string; to: string }> = []
  const guarded: string[] = []
  const guardedSeen = new Set<string>()
  for (const event of events) {
    for (const t of eventsObj[event]?.transitions ?? []) {
      if (typeof t.from === 'string' && typeof t.to === 'string') {
        transitions.push({ event, from: t.from, to: t.to })
      }
      if (t.guard !== undefined && t.from !== undefined && t.to !== undefined) {
        const label = guardKey(t.from, t.to)
        if (!guardedSeen.has(label)) {
          guardedSeen.add(label)
          guarded.push(label)
        }
      }
    }
  }
  return { leaves, events, transitions, guardedTransitions: guarded, compiled }
}

/**
 * One parallel REGION of a composite, with the sub-states that decide whether it
 * can COMPLETE.
 *
 * `directFinals` / `nestedComposites` are DIRECT children only, mirroring the
 * engine's `isCompositeDone`: a region is complete iff its ACTIVE direct child
 * is a `final` leaf, or is a nested composite that is itself all-regions-final.
 * A final leaf buried deeper (inside a nested composite's own region) does NOT
 * complete THIS region, so folding descendants in would silence real findings.
 */
interface RegionInfo {
  readonly composite: string
  readonly region: string
  readonly directFinals: readonly string[]
  readonly nestedComposites: readonly string[]
  /** EVERY descendant leaf — used only to tell "was this region ever entered?". */
  readonly leaves: readonly string[]
}

/** Enumerate the parallel regions of every composite, in document order. */
function enumerateRegions(compiled: CompiledModel): RegionInfo[] {
  const out: RegionInfo[] = []
  for (const id of compiled.order) {
    const node = compiled.nodes.get(id)
    if (node === undefined || node.kind !== 'region' || node.parent === null) {
      continue
    }
    const directFinals: string[] = []
    const nestedComposites: string[] = []
    for (const childId of node.children) {
      const child = compiled.nodes.get(childId)
      if (child === undefined) {
        continue
      }
      if (child.kind === 'composite') {
        nestedComposites.push(child.id)
      } else if (child.isFinal) {
        directFinals.push(child.id)
      }
    }
    // All descendant leaves (breadth-first over the region subtree).
    const leaves: string[] = []
    const queue: string[] = node.children.slice()
    while (queue.length > 0) {
      const next = queue.shift()
      if (next === undefined) {
        continue
      }
      const child = compiled.nodes.get(next)
      if (child === undefined) {
        continue
      }
      if (child.kind === 'leaf') {
        leaves.push(child.id)
      } else {
        queue.push(...child.children)
      }
    }
    out.push({ composite: node.parent, region: node.id, directFinals, nestedComposites, leaves })
  }
  return out
}

/**
 * Run a consumer's machine through the sim oracles over N independent runs and
 * return a trusted {@link CheckReport}. See the module contract for how the report
 * shape makes each sim-audit finding unexpressible.
 */
/**
 * Attach `fold` to a monitor's lifecycle slot WITHOUT clobbering an existing
 * subscriber. The sim's own `SimMonitor` installs a LOAD-BEARING sink there (it
 * feeds the I-4 ordering oracle and the ISS-030 in-flight counter that the settle
 * predicate reads), so assigning the slot outright would silently disable both.
 *
 * Exported for the sake of being TESTABLE: a clobber is invisible through
 * `CheckReport` alone, so the guard for this has to observe both receivers
 * directly.
 *
 * Must run BEFORE the machine is constructed — presence on
 * `IMonitor.recordLifecycle` is sampled ONCE at construction (see types.ts), so a
 * later attach is a silent no-op.
 */
export function decorateLifecycle(
  monitor: { recordLifecycle?: (record: LifecycleEvent) => void },
  fold: (record: LifecycleEvent) => void,
): void {
  const inner = monitor.recordLifecycle?.bind(monitor)
  monitor.recordLifecycle = (record: LifecycleEvent): void => {
    fold(record)
    inner?.(record)
  }
}

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

  // SPEC §13.1 guard coverage, aggregated across ALL runs. SEEDED from the
  // declared guarded transitions so a guard that was never evaluated is reported
  // as `{false,false}` instead of vanishing; the insertion order (declaration
  // order first, then first-seen for anything the engine labels differently)
  // keeps the report deterministic.
  const guardSeen = new Map<string, { sawTrue: boolean; sawFalse: boolean }>()
  for (const label of decl.guardedTransitions) {
    guardSeen.set(label, { sawTrue: false, sawFalse: false })
  }
  /**
   * The W8/V1 lifecycle sink. Deliberately NOT `createLifecycleTracer()`: the
   * tracer RETAINS every enter/exit/invoke record (a ring buffer that would drop
   * the oldest across a 32x1000-step sweep — and a dropped `end` edge silently
   * un-proves a `sawTrue`). Guard coverage is a pure fold over `edge:'end'`
   * records with no pairing at all, so folding it directly is both sound under
   * unbounded runs and O(1) in memory. The tracer stays the right tool for
   * INTERACTIVE debugging; this is an aggregate over a fuzzing sweep.
   */
  const foldGuardRecord = (record: {
    kind?: unknown
    edge?: unknown
    outcome?: unknown
    transition?: unknown
    state?: unknown
  }): void => {
    if (record.kind !== 'guard' || record.edge !== 'end') {
      return
    }
    // `transition` IS the engine label {@link guardKey} reproduces. For
    // `kind:'guard'` the record's `state` is the transition's `from` SELECTOR
    // (possibly a wildcard) — a last-resort label only.
    const key = typeof record.transition === 'string' ? record.transition : String(record.state ?? '?')
    const cur = guardSeen.get(key) ?? { sawTrue: false, sawFalse: false }
    // A THROWING guard reports `failed:true, outcome:false` — the transition
    // stays disabled, so `false` is the outcome coverage must count.
    if (record.outcome === true) {
      cur.sawTrue = true
    } else {
      cur.sawFalse = true
    }
    guardSeen.set(key, cur)
  }

  const canonicalSeed = runSeed(base, 0)

  // ── the INITIAL-configuration invariant pass (W8/V7) ────────────────────────
  // The per-step pass below evaluates user invariants on each step's SETTLE
  // BOUNDARY, and the driver never routes its `cause:'init'` frames through
  // `onFrame` — so the post-construction configuration was never checked at all.
  // A consumer asserting `retries <= 3` was NOT told that the machine STARTED at
  // `retries === 5`. This closes that hole. See {@link checkInitialConfiguration}
  // for why it is a separate zero-step run and when it must abstain.
  const initFindings = await checkInitialConfiguration(config, owner, userInvariants, canonicalSeed)
  for (const w of initFindings.warnings) {
    warnings.push(w)
  }
  for (const f of initFindings.violations) {
    violations.push({
      invariant: f.name,
      kind: 'user',
      // The witness is TAGGED so a consumer can tell "broken on arrival" from
      // "broken after N steps" — the remedy is a different one.
      witness: `${f.witness} (initial configuration)`,
      reproCode: reproCode(config, canonicalSeed, 0, 'safety'),
    })
  }

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

    // W8: bridge the consumer's per-event `payload` generators into the sim's
    // `eventPayload` hook. The hook is passed ONLY when at least one spec declares
    // a payload — otherwise the run must stay byte-identical to the arg-free path
    // (an always-installed hook returning `[]` would still be a behavior change we
    // do not want to smuggle in).
    const eventPayload = buildEventPayload<T>(eventSpecs, () => data)

    const result: SimResult = await runSimulation<T>(
      (env) => {
        // W8/V7 — subscribe to the lifecycle observability channel for THIS run.
        //
        // DECORATION, NEVER REPLACEMENT. `SimMonitor.recordLifecycle` is
        // LOAD-BEARING: it feeds the I-4 hierarchy-order oracle AND maintains the
        // `invoke.action` in-flight counter the settle predicate reads (the
        // ISS-030 string-method gap). Overwriting the slot would wedge that
        // counter and silently break quiescence for every checkMachine run, so we
        // chain instead — our fold first (it is a pure Map write and cannot
        // throw), then the harness's own sink.
        //
        // The setup callback is the last thing that runs BEFORE the driver
        // constructs the machine, which is the only legal window: presence on
        // `IMonitor.recordLifecycle` is SAMPLED ONCE at construction (types.ts),
        // so attaching later would be a silent no-op. The monitor is constructed
        // per-Simulator, so the wrapper cannot accumulate across runs.
        decorateLifecycle(env.monitor, foldGuardRecord)
        return { config, owner: runOwner }
      },
      { seed, steps, mode, onTrace, ...(eventPayload !== undefined ? { eventPayload } : {}) },
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

  // ── SPEC §13.1 guard coverage ──
  const guardOutcomes = [...guardSeen.entries()].map(([transition, o]) => ({
    transition,
    sawTrue: o.sawTrue,
    sawFalse: o.sawFalse,
  }))
  const deadGuards = guardOutcomes.filter((g) => !g.sawTrue)
  if (plateauedAtRun !== null && deadGuards.length > 0) {
    warnings.push({
      kind: 'dead-guard-at-plateau',
      // ADVISORY (see CheckReport.guardOutcomes): the `true` branch of a guard
      // routinely needs a payload the fuzzer cannot synthesize, so this must not
      // fail a correct machine by default.
      detail: `coverage plateaued at run ${plateauedAtRun} with ${deadGuards.length} guard(s) that NEVER returned true (a dead branch): ${deadGuards.slice(0, 8).map((g) => g.transition).join('; ')}${deadGuards.length > 8 ? '; …' : ''}`,
    })
  }

  // ── non-converging parallel regions (see CheckReport.nonConvergingRegions) ──
  const joinedComposites = new Set(
    decl.events.filter((e) => e.startsWith('done.state.')).map((e) => e.slice('done.state.'.length)),
  )
  const nonConvergingRegions: Array<{ composite: string; region: string }> = []
  for (const r of enumerateRegions(decl.compiled)) {
    // STRUCTURAL: the composite declares a join, but this region has nothing that
    // could ever make it complete. Provable from the config alone.
    if (joinedComposites.has(r.composite) && r.directFinals.length === 0 && r.nestedComposites.length === 0) {
      // OBSERVED CONTRADICTION beats the structural argument. `done.state.<C>` is a
      // NORMAL event name: `canFireEvent` has no done-exception, so a consumer (or
      // this very fuzzer, since `getAvailableEvents` lists it) can fire it
      // EXTERNALLY and drive the join. If the run actually saw it fire, the region
      // is not "non-converging" in any sense the consumer would accept — reporting
      // it would be a false finding on a machine they legitimately operate.
      if (firedEvents.has(`done.state.${r.composite}`)) {
        continue
      }
      nonConvergingRegions.push({ composite: r.composite, region: r.region })
      warnings.push({
        kind: 'non-converging-region',
        // Wording is scoped to what is actually provable: the ENGINE will never
        // raise this join internally (no region can complete). An external fire of
        // `done.state.<C>` remains possible — that is the case suppressed above.
        detail: `region '${r.region}' declares NO final sub-state and no nested composite, so the engine can never raise 'done.state.${r.composite}' internally (structural); the join would only ever fire if something fires that event externally`,
      })
      continue
    }
    // DYNAMIC: only at a SATURATED plateau, only for a region that was actually
    // ENTERED, and only when completion is decided by DIRECT final sub-states (a
    // nested composite's completion is not soundly decidable from leaf coverage).
    if (plateauedAtRun === null || r.directFinals.length === 0 || r.nestedComposites.length > 0) {
      continue
    }
    const entered = r.leaves.some((leaf) => reached.has(leaf))
    if (!entered || r.directFinals.some((leaf) => reached.has(leaf))) {
      continue
    }
    nonConvergingRegions.push({ composite: r.composite, region: r.region })
    warnings.push({
      kind: 'non-converging-region',
      detail: `coverage plateaued at run ${plateauedAtRun}: region '${r.region}' was entered but NEVER reached any of its final sub-state(s) (${r.directFinals.join(', ')}), so '${r.composite}' never completed`,
    })
  }

  // ── structural deadlocks: a REACHED non-final leaf that CANNOT exit ──
  const finalLeaves = new Set([...decl.compiled.nodes.values()].filter((n) => n.isFinal).map((n) => n.id))
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
  // 'non-converging' is failOn-GATED, never a hard floor: the structural half is
  // provable, but the dynamic half is fuzzer-relative (plateau-proven, exactly
  // like the dead-event degradation), and a hard floor must hold for BOTH.
  if (nonConvergingRegions.length > 0) {
    fired.add('non-converging')
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
    guardOutcomes,
    saturation: { plateauedAtRun, newCoveragePerRun },
    deadlocks,
    livelocks,
    nonConvergingRegions,
    violations,
    warnings,
    failedOn,
  }
}

/**
 * W8/V7 — evaluate the consumer's {@link MachineInvariant}s on the INITIAL
 * configuration: the state the machine settles into after the mandatory
 * post-construction drain, BEFORE a single fuzzed step.
 *
 * ## Why this needs its own run
 * The main loop evaluates invariants on each step's SETTLE-BOUNDARY frame, fed
 * by `SimOptions.onTrace`. The driver emits its `cause:'init'` frames from
 * `init()`, which does NOT route them through `onFrame` — so the initial
 * configuration was in a blind spot. Nor can the main run be patched to cover it:
 * a step's frames arrive in ONE batch AFTER that step settled, so by the time the
 * first frame is observable the owner data has ALREADY been mutated by step 1.
 * The only way to read the post-init data is to STOP there — hence a throwaway
 * `steps: 0` run, which does construction + the mandatory drain and nothing else.
 *
 * ## NO DOUBLE-COUNTING with step 1
 * This checks a configuration point the per-step pass never sees (post-init,
 * pre-step-1) and it runs EXACTLY ONCE per `checkMachine` call, not once per run
 * — init is seed-independent (no ops are drawn), so repeating it per run would
 * add N identical violations for one defect. Its violations are witness-tagged
 * `(initial configuration)` so they stay distinguishable from a step-boundary
 * finding at the same config.
 *
 * ## When it ABSTAINS (and says so)
 * The probe needs a FRESH owner — running init twice over the consumer's live
 * object would apply its enter-actions twice and corrupt the real run.
 *   - `owner` is a FACTORY → a fresh owner, full fidelity.
 *   - `owner` is a PLAIN object (only legal at `runs===1`) → a SHALLOW COPY. The
 *     sim wraps a plain object in `MemoryAdapter` either way, so init behaves
 *     identically. Nested mutable fields are shared (the same caveat the
 *     per-step `boundaryData` snapshot carries).
 *   - `owner` is a LIVE ADAPTER → ABSTAIN. A copy would lose the adapter's own
 *     get/set semantics and could report a violation the real machine never has;
 *     a false finding is worse than a missing one. Emits `init-check-skipped`.
 *   - the probe run THROWS (a config the engine rejects at construction) →
 *     ABSTAIN with the reason. The main loop surfaces that failure on its own.
 */
async function checkInitialConfiguration<T extends object>(
  config: StateMachineConfig<T>,
  owner: OwnerSource<T>,
  invariants: readonly MachineInvariant<T>[],
  seed: string,
): Promise<{ violations: Array<{ name: string; witness: string }>; warnings: CheckWarning[] }> {
  const violations: Array<{ name: string; witness: string }> = []
  const warnings: CheckWarning[] = []
  if (invariants.length === 0) {
    return { violations, warnings }
  }

  let probeOwner: T | Adapter<T>
  if (typeof owner === 'function') {
    probeOwner = (owner as () => T | Adapter<T>)()
  } else if (isAdapter<T>(owner)) {
    warnings.push({
      kind: 'init-check-skipped',
      detail:
        'the INITIAL-configuration invariant pass was skipped: the owner is a LIVE Adapter, and probing it would either re-run the machine\'s enter actions on your object or lose the adapter\'s get/set semantics. Pass an owner FACTORY `() => adapter` to enable the check.',
    })
    return { violations, warnings }
  } else {
    probeOwner = { ...(owner as T) }
  }

  const probeData = ownerData(probeOwner)
  let trace: readonly TraceFrame[]
  try {
    // mode 'safety' (not the caller's mode): the liveness plane may jump the
    // clock, and there is no step budget here for it to analyze anyway.
    const probe = await runSimulation<T>(() => ({ config, owner: probeOwner }), { seed, steps: 0, mode: 'safety' })
    trace = probe.trace
  } catch (error) {
    warnings.push({
      kind: 'init-check-skipped',
      detail: `the INITIAL-configuration invariant pass could not run: ${error instanceof Error ? error.message : String(error)}`,
    })
    return { violations, warnings }
  }

  // The LAST `cause:'init'` frame carries the settled post-construction config.
  let initFrame: TraceFrame | undefined
  for (const f of trace) {
    if (f.cause === 'init') {
      initFrame = f
    }
  }
  const settled = initFrame?.to ?? String((config as { initialState?: unknown }).initialState ?? '')
  const snapshot: MachineSnapshot<T> = {
    config: settled,
    state: settled,
    data: { ...probeData } as Readonly<T>,
    queueDepth: initFrame === undefined ? 0 : initFrame.queue.internal + initFrame.queue.external,
  }
  for (const inv of invariants) {
    let held: boolean
    try {
      held = inv.check(snapshot)
    } catch {
      held = false // a throw inside the check is a violation, not swallowed (F7).
    }
    if (!held) {
      violations.push({ name: inv.name, witness: settled })
    }
  }
  return { violations, warnings }
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
