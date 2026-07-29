/**
 * @module sim/define
 * @unstable
 *
 * ADR-1/3/4 Step-4 scenario derivation surface:
 *  - {@link defineScenario}: identity validator/normalizer for a {@link ScenarioSpec}.
 *  - {@link runScenario}: derive a machine config from `spec.topology`, drive the
 *    Step-3 {@link SimDriver} over `spec.ops`, and return the canonical
 *    content-only {@link CanonicalTrace}. Pure in `(spec.seed, spec, header.runtime)`.
 *  - {@link toEngineConfig}: turn a {@link TopologySpec} into the engine
 *    {@link StateMachineConfig} (re-creating each closure-free literal callback's
 *    live `fn`).
 *  - {@link generateScenario}: one-seed → full {@link ScenarioSpec} (topology +
 *    closed-loop ops + empty fault plan). The CLOSED-LOOP genOps drive runs here.
 *
 * faults are STUBBED EMPTY (`{ faults: [] }`) until Step 5. `runScenario` builds
 * the SAME `genConfig`/`genOps` derivation every time, so two runs of the same
 * spec produce a bit-identical `traceHash` (R14: stability is RUNNER-scoped, not
 * a pure-generator claim).
 */

import { MemoryAdapter } from '../index'
import type { Adapter, StateMachineConfig } from '../index'
import { makeSimClock } from './clock'
import { type DriverOp, SimDriver } from './driver'
import { makeObservableScheduler } from './env'
import { NoopLogger } from './noop-logger'
import { buildPlanJitter, makeObservableSchedulerWithJitter } from './observable-scheduler'
import { makePrng } from './prng'
import type { Bounds, EventSpec, FaultPlan, Op, ScenarioSpec, StateSpec, TopologySpec } from './scenario'
import { SimErrorHandler } from './sim-error-handler'
import { SimMonitor } from './sim-monitor'
import type { CanonicalTrace } from './trace'
import { genConfig } from './topology'
import { type GenOpsParams, genOps } from './ops'

/** Default generation bounds (validator-clean; depth well under the :253 ERROR clamp). */
export const DEFAULT_BOUNDS: Bounds = {
  maxStateDepth: 10,
  maxStatesCount: 1000,
  maxEventsCount: 1000,
  maxOps: 32,
  maxArmedDelay: 5,
}

/** Default closed-loop op params. */
export const DEFAULT_GENOPS_PARAMS: GenOpsParams = {
  maxOps: 32,
  pBlind: 0.25,
  pAdvance: 0.35,
}

/** The runtime tag pinned into every generated trace header. */
export const SCENARIO_RUNTIME = 'node-sim-v1'

/**
 * Cheap syntactic gate on a literal-callback `source` BEFORE it reaches
 * `new Function` (W7 U2 / task #26 / defect B4-учёт; W8 V6a widened the
 * accepted-shape set). NOT a sandbox and NOT an attacker mitigation — a
 * determined caller can still craft a `source` that matches this pattern and
 * does harm; it is fail-fast HYGIENE against an empty/malformed/non-function
 * `source` (e.g. an accidental `''`, `undefined` coerced to a string, or a
 * stray non-callable expression) reaching the compiler, with a message that
 * names the TRUSTED-INPUT-ONLY boundary instead of surfacing an opaque
 * `SyntaxError` from inside `new Function`.
 *
 * Matched AFTER {@link stripLeadingCommentsAndWhitespace} runs on the
 * trimmed source, so it accepts (in addition to a bare `function`/`async
 * function` literal and any arrow form):
 *  - a parenthesis-wrapped function literal: `(function(o){...})`;
 *  - a function literal preceded by a leading block comment (`/* ... *\/`)
 *    and/or line comment(s) (`// ...\n`), in any combination, before the
 *    `function`/`async function`/`(function` keyword.
 *
 * It still rejects (throws before `new Function` is ever reached): an empty
 * or whitespace-only source, a non-string source, and source that is not
 * function-shaped at all (e.g. `'42'`, `'{ evil: 1 }'`, `'alert(1)'`).
 *
 * PRECISION OF THE CHECK (do not mistake it for a filter). The `function`
 * alternative is anchored; the ARROW alternative (`=>`) is NOT — a source that
 * merely CONTAINS `=>` anywhere passes the shape check (e.g.
 * `'alert(1), (x) => x'` is a valid comma-expression and WOULD run). Likewise a
 * paren-wrapped IIFE with a trailing statement now passes the shape check and
 * fails later, inside `new Function`, as a raw SyntaxError. Neither is a
 * regression of SAFETY — this is hygiene for author typos, NOT a sandbox and NOT
 * an attacker mitigation; the whole path is trusted-input-only (see below).
 */
const FUNCTION_LITERAL_PATTERN = /^\(?\s*(async\s+)?function\b|=>/

/**
 * Strip leading whitespace and leading comments (block `/* *\/` and line
 * `// ...`) from `source` so {@link FUNCTION_LITERAL_PATTERN} can anchor on
 * the actual `function`/`(function` keyword instead of false-rejecting a
 * well-formed literal that merely has a leading comment (W8 V6a). Hygiene
 * pre-processing ONLY — the ORIGINAL untouched `source` string is still what
 * gets embedded into the `new Function` body below; this stripped `probe` is
 * used solely for the guard's pattern test, never for compilation.
 */
function stripLeadingCommentsAndWhitespace(source: string): string {
  let probe = source
  for (;;) {
    const before = probe
    probe = probe.replace(/^\s+/, '')
    probe = probe.replace(/^\/\*[\s\S]*?\*\//, '')
    probe = probe.replace(/^\/\/[^\r\n]*(\r\n|\r|\n)?/, '')
    if (probe === before) break
  }
  return probe
}

/**
 * Re-create the live function for a closure-free literal callback. The source is
 * a function-EXPRESSION reading only its parameter; we re-create it through the
 * same restricted-scope contract the engine uses (`security.ts:640`) so a
 * re-created callback is behaviorally identical to the generator's own `fn`.
 *
 * NOTE: this is the harness-side re-eval used when a {@link ScenarioSpec} arrives
 * as pure JSON (no live `fn`); the generator's own `fn` is used directly when
 * present. The created function ignores extra args and reads only the owner.
 *
 * ⚠️ SECURITY — TRUSTED INPUT ONLY (W0 B4 / task #26). `source` is COMPILED via
 * `new Function` below; the {@link FUNCTION_LITERAL_PATTERN} guard (run against
 * a {@link stripLeadingCommentsAndWhitespace}-cleaned probe) is fail-fast
 * HYGIENE on an empty/malformed source — it accepts a bare `function`/`async
 * function` literal, the SAME wrapped in parentheses (`(function(){})`), any
 * of those with a leading block/line comment, and any arrow-function form —
 * it is NOT a sandbox and does not defend against a crafted,
 * syntactically-valid-looking malicious literal. Callers MUST treat `source`
 * as author-side trusted input (see `./index` barrel doc and
 * `toEngineConfig`/`runScenario` for the full contract). The engine's own
 * untrusted-JSON path (`StateMachine.fromJSON`/`fromSecureJSON`) never reaches
 * this function — it resolves callbacks by NAME from a caller-supplied
 * `FunctionRegistry` (`state_machine.ts` `deserializeAction`), never compiling
 * a source string.
 */
function recreateLiteral(source: string): (...args: unknown[]) => unknown {
  const trimmed = typeof source === 'string' ? source.trim() : ''
  const probe = stripLeadingCommentsAndWhitespace(trimmed)
  if (trimmed.length === 0 || !FUNCTION_LITERAL_PATTERN.test(probe)) {
    const shown = typeof source === 'string' ? source : String(source)
    const truncated = shown.length > 120 ? `${shown.slice(0, 120)}…` : shown
    throw new Error(
      `recreateLiteral: refusing to compile a non-function / empty source '${truncated}' — trusted author-side function literals only`,
    )
  }
  // Mirror security.ts:640: shadow dangerous globals, evaluate the source as an
  // expression, call it with (adaptee, ...args). Closure-free source survives.
  const executor = new Function(
    'adaptee',
    'args',
    `
    var eval = undefined;
    var Function = undefined;
    var setTimeout = undefined;
    var setInterval = undefined;
    var document = undefined;
    var window = undefined;
    var global = undefined;
    var process = undefined;
    var require = undefined;
    const __fn = (${source});
    if (typeof __fn !== 'function') { throw new Error('literal source is not a function'); }
    return __fn(adaptee, ...(Array.isArray(args) ? args : []));
  `,
  ) as (adaptee: unknown, args: unknown[]) => unknown
  return (adaptee: unknown, ...args: unknown[]) => executor(adaptee, args)
}

/**
 * `InvokeSpec.cond`/`InvokeSpec.action` are typed as {@link LiteralCallback},
 * but an off-label / hand-rolled `TopologySpec` (e.g. a coverage-harness
 * fixture proving the string-method-invoke residual, ISS-029) may pass a bare
 * STRING method-name instead. A bare string has no `.source`, so calling
 * {@link recreateLiteral} on it would now hit the new guard and throw at
 * config-BUILD time — a behavior change from the pre-guard code (which
 * compiled `(${undefined})` without erroring until the wrapper was actually
 * invoked). Preserve pass-through for anything that is not LiteralCallback
 * SHAPED (an object with a string `.source`): only a genuine literal-callback
 * value is compiled; anything else (e.g. a string method-name reference)
 * flows to the engine unchanged, exactly as a `string | Action` field would.
 */
function recreateLiteralIfShaped(value: unknown): unknown {
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { source?: unknown }).source === 'string'
  ) {
    return recreateLiteral((value as { source: string }).source)
  }
  return value
}

/**
 * Convert a {@link StateSpec} to the engine state node, materializing each
 * closure-free literal callback by ALWAYS re-creating it from `source` through
 * {@link recreateLiteral}.
 *
 * Why re-create from `source` rather than reuse the generator's live `fn`: the
 * driver computes `header.configHash = configHash(config)` which folds every
 * callback's `Function.prototype.toString()` (trace.ts:structuralWalk). A live
 * arrow `fn` and a JSON-round-tripped spec (where `fn` is dropped and only
 * `source` survives) would stringify DIFFERENTLY, yielding a different
 * configHash and breaking DoD#10 (same spec → same traceHash after JSON
 * round-trip). Re-creating EVERY callback the SAME way (via `recreateLiteral`)
 * makes the configHash path identical whether the spec is live or JSON. The
 * `source` strings still vary per topology (inlined constants, delays), so
 * distinct topologies still hash distinctly via their structure.
 */
function toEngineState(spec: StateSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (spec.final) {
    out['final'] = true
  }
  if (spec.history) {
    out['history'] = spec.history
  }
  if (spec.initial) {
    out['initial'] = spec.initial
  }
  if (spec.onEnter) {
    out['onEnter'] = recreateLiteral(spec.onEnter.source)
  }
  if (spec.onExit) {
    out['onExit'] = recreateLiteral(spec.onExit.source)
  }
  // ADDITIVE Step-9 hook-triad authoring surface (the Step-4 generator never sets
  // these); each maps 1:1 onto the engine state node (types.ts:228-233).
  if (spec.onBeforeEnter) {
    out['onBeforeEnter'] = recreateLiteral(spec.onBeforeEnter.source)
  }
  if (spec.onAfterEnter) {
    out['onAfterEnter'] = recreateLiteral(spec.onAfterEnter.source)
  }
  if (spec.onBeforeExit) {
    out['onBeforeExit'] = recreateLiteral(spec.onBeforeExit.source)
  }
  if (spec.onAfterExit) {
    out['onAfterExit'] = recreateLiteral(spec.onAfterExit.source)
  }
  if (spec.invoke) {
    out['invoke'] = spec.invoke.map((inv) => {
      const e: Record<string, unknown> = { delay: inv.delay, event: inv.event }
      if (inv.cond) {
        e['cond'] = recreateLiteralIfShaped(inv.cond)
      }
      if (inv.action) {
        e['action'] = recreateLiteralIfShaped(inv.action)
      }
      return e
    })
  }
  if (spec.regions) {
    const regions: Record<string, Record<string, unknown>> = {}
    for (const [rn, region] of Object.entries(spec.regions)) {
      const rstates: Record<string, unknown> = {}
      for (const [sn, ss] of Object.entries(region)) {
        rstates[sn] = toEngineState(ss)
      }
      regions[rn] = rstates
    }
    out['regions'] = regions
  }
  // ADDITIVE Step-9: hierarchical single-region sub-states (the engine accepts a
  // `states` field on a composite node).
  if (spec.states) {
    const nested: Record<string, unknown> = {}
    for (const [sn, ss] of Object.entries(spec.states)) {
      nested[sn] = toEngineState(ss)
    }
    out['states'] = nested
  }
  return out
}

/** Convert an {@link EventSpec} to the engine event node (materializing callbacks). */
function toEngineEvent(spec: EventSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {
    transitions: spec.transitions.map((t) => {
      const e: Record<string, unknown> = { from: t.from, to: t.to }
      if (t.priority !== undefined) {
        e['priority'] = t.priority
      }
      if (t.guard) {
        e['guard'] = recreateLiteral(t.guard.source)
      }
      if (t.onTransition) {
        e['onTransition'] = recreateLiteral(t.onTransition.source)
      }
      return e
    }),
  }
  // ADDITIVE Step-9 event-level hook authoring surface (types.ts:280-283).
  if (spec.onBefore) {
    out['onBefore'] = recreateLiteral(spec.onBefore.source)
  }
  if (spec.onAfter) {
    out['onAfter'] = recreateLiteral(spec.onAfter.source)
  }
  if (spec.onSuccess) {
    out['onSuccess'] = recreateLiteral(spec.onSuccess.source)
  }
  return out
}

/**
 * Build the engine {@link StateMachineConfig} from a {@link TopologySpec}. All
 * callbacks are live functions (closure-free literal bodies).
 *
 * ⚠️ SECURITY — TRUSTED INPUT ONLY (W0 B4 / task #26 open debt). Every callback
 * `source` string in `topology` is COMPILED via `new Function` in
 * {@link recreateLiteral} (define.ts). The restricted-scope shadowing there is
 * a hardening measure, NOT a sandbox: a crafted `source` is RCE-class. Treat
 * `topology` (and any {@link ScenarioSpec} / {@link TopologySpec} you pass here
 * or to {@link runScenario}) as a TRUSTED author-side input. NEVER feed
 * untrusted JSON — a JSON payload carrying `source` strings would be compiled
 * and executed. This is a harness/author surface exposed through the public
 * `./sim` entry; the engine's own JSON deserialization (`StateMachine.fromJSON`)
 * never compiles bodies and is the path for untrusted input.
 */
export function toEngineConfig<T extends object = { state: string; log: number[]; k: number }>(
  topology: TopologySpec,
): StateMachineConfig<T> {
  const states: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(topology.states)) {
    states[name] = toEngineState(spec)
  }
  const events: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(topology.events)) {
    events[name] = toEngineEvent(spec)
  }
  return {
    name: topology.name,
    stateAttribute: topology.stateAttribute,
    initialState: topology.initialState,
    states,
    events,
  } as unknown as StateMachineConfig<T>
}

/** The owner shape the generated machine drives. */
export interface GenOwner {
  state: string
  log: number[]
  k: number
}

/**
 * Build a fresh owner object seeded from `topology.ownerSeed`. `log` is always a
 * fresh array so two runs of the same spec do not share mutable state.
 */
export function makeOwner(topology: TopologySpec): GenOwner {
  const seed = topology.ownerSeed as { log?: unknown; k?: unknown }
  return {
    state: String(topology.initialState),
    log: Array.isArray(seed.log) ? [...(seed.log as number[])] : [],
    k: typeof seed.k === 'number' ? seed.k : 0,
  }
}

/**
 * Identity validator/normalizer for a {@link ScenarioSpec}. Confirms the spec is
 * JSON-shaped (string seed, version 1) and returns it unchanged. A non-conforming
 * spec throws (a generator bug, never silently coerced).
 */
export function defineScenario(spec: ScenarioSpec): ScenarioSpec {
  if (spec.version !== 1) {
    throw new Error(`defineScenario: unsupported version ${String(spec.version)}`)
  }
  if (typeof spec.seed !== 'string') {
    throw new Error('defineScenario: seed must be a serialized-bigint string')
  }
  return spec
}

/**
 * Construct (but do not init) a {@link SimDriver} for `topology` + `seed`. Shared
 * by {@link runScenario} and {@link generateScenario}'s closed-loop op generation
 * so BOTH drive the IDENTICAL wiring.
 *
 * When `faults` carries a non-empty plan the driver routes external fires through
 * the fault-aware path and the scheduler is built with the plan's seed-derived
 * timer-jitter (via {@link buildPlanJitter} over `fork('faults')`), so faults
 * ACTUALLY fire during the run while staying deterministic (same `(seed, plan)` →
 * identical `FaultRecord[]` + bit-identical traceHash).
 */
function buildDriver(topology: TopologySpec, seed: bigint, faults: FaultPlan = { faults: [] }): SimDriver<GenOwner> {
  const config = toEngineConfig<GenOwner>(topology)
  const clock = makeSimClock(0)
  const hasFaults = faults.faults.length > 0
  // The scheduler carries the plan jitter when faults are wired; otherwise the
  // plain Step-3 shim (identity jitter). Both expose the SAME SchedulerView.
  const { scheduler, view } = hasFaults
    ? makeObservableSchedulerWithJitter(clock, buildPlanJitter(faults, makePrng(seed).fork('faults')).jitterFn)
    : makeObservableScheduler(clock)
  return new SimDriver<GenOwner>({
    config,
    owner: new MemoryAdapter<GenOwner>(makeOwner(topology)) as unknown as Adapter<GenOwner>,
    clock,
    // makeObservableScheduler always implements `process` (env.ts); the
    // ITimerScheduler.process? optionality is widened away here to match the
    // driver's non-optional process contract.
    scheduler: scheduler as { process(now?: number): void; isActive(): boolean; schedule(d: number, cb: () => void): object; cancel(t: object): void },
    schedulerView: view,
    monitor: new SimMonitor(),
    errorHandler: new SimErrorHandler(),
    logger: NoopLogger,
    prng: makePrng(seed),
    runtime: SCENARIO_RUNTIME,
    // The generator emits armed timers; 'liveness' lets the driver jump the clock
    // to fire them so done.state joins and invoke chains actually run.
    policy: 'liveness',
    ...(hasFaults ? { faults } : {}),
  })
}

/** Map a closed-union {@link Op} onto the Step-3 {@link DriverOp} the driver runs.
 * The op's STABLE `id` is carried as `opId` so the driver can resolve per-op
 * channel faults keyed by that id (R22). */
function toDriverOp(op: Op): DriverOp {
  switch (op.kind) {
    case 'fire':
      return { kind: 'fire', event: op.event, args: op.args, opId: op.id }
    case 'advance':
      return { kind: 'advance', dtMs: op.dtMs, opId: op.id }
    case 'noop':
      return { kind: 'noop', opId: op.id }
    // D5 fix: `snapshot`/`restore` are part of the frozen Op union but the driver
    // has NO DriverOp for them yet (Step 10 not landed). Previously they were
    // SILENTLY SKIPPED — a hand-authored scenario with a `restore` op ran clean,
    // producing NO frame and NO error, so the author was misled into thinking the
    // restore was exercised. Fail LOUDLY instead: an undrivable op is a scenario
    // authoring error, not a no-op. (The coverage-path persistence round-trip uses
    // the SEPARATE `CoverageScenario.snapshotRestore` engine saveState/restoreState
    // flag — coverage.ts:286 — NOT this Op union, so it is unaffected.)
    default: {
      const undrivable = op as { kind: string; id?: string }
      throw new Error(
        `runScenario: op kind '${undrivable.kind}'${undrivable.id !== undefined ? ` (id '${undrivable.id}')` : ''} is not drivable — ` +
          `snapshot/restore ops are declared in the frozen Op union but the Simulator does not yet drive them (Step 10). ` +
          `Remove the op or drive persistence via the Simulator snapshot()/restore() API.`,
      )
    }
  }
}

/**
 * Derive a machine from `spec.topology`, drive the Step-3 driver over `spec.ops`,
 * and return the canonical content-only trace. Pure in `(spec.seed, spec,
 * header.runtime)`: two calls with the same spec produce a bit-identical
 * `traceHash` (proven by `replay.test.ts`).
 *
 * ⚠️ SECURITY — TRUSTED INPUT ONLY (W0 B4 / task #26 open debt). `spec` is a
 * TRUSTED author-side input. Its callback `source` strings are COMPILED via
 * `new Function` ({@link recreateLiteral} / {@link toEngineConfig}); the
 * restricted-scope shadowing is hardening, NOT a sandbox, so a crafted `source`
 * is RCE-class. NEVER pass a `ScenarioSpec` reconstructed from untrusted JSON —
 * its `source` strings would be compiled and executed. Untrusted input belongs
 * on the engine's non-compiling `StateMachine.fromJSON` path instead.
 */
export async function runScenario(spec: ScenarioSpec): Promise<CanonicalTrace> {
  defineScenario(spec)
  const seed = BigInt(spec.seed)
  // Honor a provided fault plan: a non-empty `spec.faults` is carried into the
  // driver so the faults ACTUALLY fire during the run (Step 5 integration). A
  // generated scenario whose plan is empty replays exactly as before.
  const driver = buildDriver(spec.topology, seed, spec.faults)
  await driver.init()
  for (const op of spec.ops) {
    await driver.step(toDriverOp(op))
  }
  return driver.trace()
}

/**
 * One seed → a full {@link ScenarioSpec}: generate the topology with `fork('topology')`,
 * then drive a closed-loop op stream with `fork('ops')` against a LIVE driver
 * (genOps probes `getAvailableEvents` after the shared `settleMacrostep`). The
 * fault plan is STUBBED EMPTY until Step 5 (`fork('faults')` is reserved). The
 * returned spec replays to a bit-identical `traceHash` via {@link runScenario}.
 */
export async function generateScenario(
  seed: bigint,
  bounds: Bounds = DEFAULT_BOUNDS,
  params: GenOpsParams = DEFAULT_GENOPS_PARAMS,
): Promise<ScenarioSpec> {
  const root = makePrng(seed)
  const { topology } = genConfig(root.fork('topology'), bounds)

  // Closed-loop op generation drives a LIVE throwaway driver so genOps can probe
  // getAvailableEvents after the shared settleMacrostep.
  const opDriver = buildDriver(topology, seed)
  await opDriver.init()
  const ops = await genOps(root.fork('ops'), opDriver, params)

  const faults: FaultPlan = { faults: [] } // stubbed empty until Step 5

  return {
    seed: seed.toString(),
    version: 1,
    topology,
    ops,
    faults,
    bounds,
  }
}

/** Pin a topology fragment for snapshot-style tests (identity passthrough). */
export function pinTopology(topology: TopologySpec): TopologySpec {
  return topology
}

/** Pin an op list for snapshot-style tests (identity passthrough). */
export function pinOps(ops: readonly Op[]): readonly Op[] {
  return ops
}

