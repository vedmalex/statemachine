# TASK-014 — VOPR-style Deterministic Simulation Testing (DST) Environment for `@vedmalex/statemachine`

> Tier **T4:standard** · Profile **creative-first** · QA **MAX** · Continuation of TASK-013 (clock seam) + TASK-012 (composite-region semantics).
> Package: `packages/statemachine` (`@vedmalex/statemachine`, currently `1.0.0-beta.3`).

## 1. Goal, scope, non-goals

**Goal.** Build a VOPR-style (TigerBeetle-inspired) Deterministic Simulation Testing environment that runs the **real** state-machine engine inside a fully controlled, seed-driven, bit-exact-replayable harness, mocking every source of nondeterminism. The harness adapts TigerBeetle's distributed-fault model to a single-process state machine by injecting faults at the three adapted seams — **event queue**, **scheduler**, **callback** — instead of network/disk/process. It is simultaneously (a) a bug-hunter (seed-sweep + shrinker + safety/liveness oracles), (b) a permanent load/stress + perf-regression tool, and (c) a deterministic debugging fixture for new features. It ships **both** as the project's internal harness and as an exportable public sub-entrypoint `@vedmalex/statemachine/sim` so consumers can simulate their own machines.

This directly serves:
- **UR-002**: real engine, deterministic seed→bit-exact replay, fault injection at event-queue/scheduler/callback levels, Safety + Liveness modes, shrinker, long-running CI.
- **UR-003**: dual role — bug-hunter AND permanent dev/debug + load-testing tool; constructible for arbitrary consumer machines.
- **UR-004**: cover ALL engine functionality via a declarative, extensible scenario/invariant model, enforced by a programmatic capability-coverage CI gate (mandatory gate / defense-in-depth).
- **UR-005**: separate `./sim` entrypoint respecting bundle budget + ABI stability; perf metrics with CI regression thresholds; programmatic coverage gate; full v1 fault set (reorder/drop/dup, guard/action/callback throws, clock skew, timer jitter, queue overflow).

**Scope (in).** New `src/sim/**` subtree + `src/tests/sim/**` tests; a second tsup entry + `./sim` exports subpath + a second api-extractor report; new CI steps (PR-fast + nightly sweep); a changeset + docs.

**Scope (out / non-goals).**
- **No core public API change.** `createMachine`, `StateMachine`, and the 5 `@stable` symbols are byte-for-byte unchanged; `etc/statemachine.api.md` must show a zero diff. The sim is purely additive.
- **No engine virtualization of the intentional `Date.now()` telemetry** (state_machine.ts:2044–2060). It stays wall-clock; the sim excludes it from the canonical trace (see §5).
- No internal-queue fault injection in v1 (external-submission-stream only; see §7).
- No string-method (`ActionOrString` name-resolved) throw-injection in v1 (function-valued callbacks only; documented gap).
- No global-minimality shrinking (1-minimality per ddmin family is the contract).
- Cross-JS-runtime replay equivalence is out of scope: the seed→hash contract is scoped to one pinned runtime, recorded in the trace header.

---

## 2. Foundation reused (verified file references)

| Foundation | What it gives the sim | Verified refs |
|---|---|---|
| **TASK-013 clock seam** | `export type Clock = () => number` injectable via `StateMachineOptions.clock`; default `Date.now` only when omitted. | `scheduler.ts:7`; `types.ts:128`; default `this.clock = options?.clock ?? Date.now` at `state_machine.ts:156` |
| **Virtual scheduler** | `createVirtualScheduler(clock)` wraps a min-heap `TimerScheduler`; `isActive()` hardcoded `true` so the engine routes **all** timers through it and never calls real `setTimeout`; `process(now?)` drains every heap task with `executeAt <= (now ?? clock())` synchronously. `executeAt = clock()+delay`. | `scheduler.ts:259–278` (wrapper), `scheduler.ts:108–132` (drain loop), `scheduler.ts:85` (executeAt) |
| **Scheduler routing** | `schedulerProvided = options?.scheduler !== undefined`; `setTimer` routes through `scheduler.schedule(delay, cb)` whenever provided; `transitionTimeout` is armed via `setTimer` (so it fires on virtual time). | `state_machine.ts:154`, `:2194–2208`, `:1795` |
| **RTC queue draining** | `scheduleProcessing()` → `queueMicrotask(() => processQueues())`; `processQueues()` drains internal-before-external, FIFO via `shift()`, guarded by `isProcessing` (no re-entrancy); `MAX_TRANSITION_DEPTH=100`; `maxQueueDepth` default 1000. | `state_machine.ts:286–340`, `:106`, `:112`, `types.ts:146` |
| **TASK-012 region semantics** | `done.state.<C>` raised by `checkCompletion` (edge-triggered, innermost-first, gated on `events.has`); `isDone(compositeId)` join oracle; `isEngineDoneEvent` prevents done events matching `'*'`. SCXML enter/exit collation via explicit `.sort((a,b)=>a.depth-b.depth||a.index-b.index)`. | `state_machine.ts:1459–1508`, `:1433`, `:367`, `:1598–1602` |
| **Inspection API (pure reads)** | `getQueueDepth() → {internal,external,total}`; `isProcessingEvents()`; `currentState` getter; `getCurrentStateInfo()`; `getQueuedEvents()` with `age = clock() - timestamp`; `getAvailableEvents()/canFireEvent()` (do NOT execute guards). Event timestamps stamped with `this.clock()` at enqueue. | `:483–493`, `:509–511`, `:132–140`, `:588`, `:495–507`, `:553/:520`, `:251/:264/:281` |
| **Persistence** | `toJSON()` / `fromJSON()` round-trip `currentState + stateEntryTimes + historyMap`; `resumeTimers()` recomputes remaining invoke delays from `stateEntryTimes` vs `this.clock()`. | `:2527`, `:762`, `:2443–2492` |
| **DST test idiom** | Proven harness shape: `let t=0; const clock=()=>t; const scheduler=createVirtualScheduler(clock); new StateMachine(cfg, adapter, {clock, scheduler}); await flush(N)`; advance via `t=…; scheduler.process()`. 12 tests in `dst.test.ts`. | `dst.test.ts:32–36, 62–79, 294–341` |

---

## 3. Architecture overview

### 3.1 Component diagram (text)

```
                          ┌───────────────────────────────────────────────────────────┐
   seed (bigint) ───────► │                     SimDriver (driver.ts)                   │
                          │  owns virtual time `t`, the single PRNG, the step loop      │
                          └───────────────────────────────────────────────────────────┘
        │                       │                 │                 │             │
        ▼                       ▼                 ▼                 ▼             ▼
  ┌───────────┐         ┌──────────────┐   ┌─────────────┐   ┌────────────┐  ┌──────────┐
  │ Prng      │ fork()  │ Scenario gen │   │ FaultPlan   │   │ SimClock   │  │ Recorder │
  │ splitmix64│────────►│ (topology +  │   │ (event-queue│   │ now()/set()│  │ (monitor │
  │ +label    │         │  op stream)  │   │  + sched +  │   │ monotonic  │  │ +probes  │
  └───────────┘         └──────────────┘   │  callback)  │   └────────────┘  │ +snapshot│
        │                       │          └─────────────┘         │         └──────────┘
        │ fork('faults')        │ genConfig/genOps                 │ clock seam     │ canonical
        │                       │                                  │                │ TraceFrame[]
        ▼                       ▼                                  ▼                ▼
  ┌─────────────────────────────────────────────────────────────────────────────────────┐
  │                          REAL StateMachine (unchanged engine)                          │
  │   new StateMachine(cfg, adapter, { clock, scheduler, monitor: SimMonitor,              │
  │                                    errorHandler: SimErrorHandler, logger: NoopLogger })│
  │   ─ ALL timers → injected virtual scheduler (never setTimeout)                          │
  │   ─ ALL randomness/wall-clock neutralized by injected DI components                     │
  └─────────────────────────────────────────────────────────────────────────────────────┘
        │ recordTransition (sync, mid-drain)   │ getCurrentState / getQueueDepth (settle reads)
        ▼                                       ▼
  ┌─────────────────────────────┐      ┌──────────────────────────────────────────────┐
  │ CanonicalTrace (trace.ts)   │      │ Oracles                                        │
  │  TraceFrame[] + header      │─────►│  SafetyRunner (invariants.ts)                  │
  │  hashTrace() excludes perf  │      │  LivenessOracle (liveness.ts)                  │
  └─────────────────────────────┘      └──────────────────────────────────────────────┘
        │                                       │ first Violation (lowest step)
        ▼                                       ▼
  ┌─────────────────────────────┐      ┌──────────────────────────────────────────────┐
  │ PerfReport (metrics.ts)     │      │ Shrinker (shrinker.ts) — ddmin over Scenario   │
  │  events/sec, heap, traceLen │      │  re-runs SimDriver, fingerprint match          │
  │  (NON-hashed perf channel)  │      │  → MinimalRepro (JSON + *.repro.test.ts)       │
  └─────────────────────────────┘      └──────────────────────────────────────────────┘
        ▲                                       │
        │ Capability probes over the trace      ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │ CoverageGate (coverage.ts) + CapabilityRegistry (capabilities.ts) │  → CI fails on uncovered capability
  └─────────────────────────────────────────────────────────────────┘
```

### 3.2 The single driver loop (one loop, owned by `SimDriver.step()`)

There is **one** driver loop, **one** PRNG (forked by label), **one** Scenario model, **one** Fault model, **one** canonical Trace format, and **one** quiescence strategy — shared by Safety, Liveness, perf, coverage, and the shrinker. Each macrostep:

1. **Pick** next op from the seeded op stream (`fire(event, args)`, `advance(dt)`, `snapshot`, `restore`, `reset`, `fault`, `noop`).
2. **Apply faults** for this step (reorder/drop/dup on the external submission buffer; arm guard/action/callback throws; queue-overflow flood schedule).
3. **Advance virtual time**: `clock.set(nextT)` (monotonic; never backward), then `scheduler.process(nextT)` (synchronous heap drain → timer callbacks `raiseEvent` + `scheduleProcessing`).
4. **Deliver** any external event(s) for this tick via `sm.fireEvent(...)`, each `await`ed with a `.catch` that records the outcome (resolve-true / resolve-false / reject) — see §7(e).
5. **Drain to quiescence** (§5.2): bounded microtask pump until `getQueueDepth().total === 0 && !isProcessingEvents()` and no scheduler task is due at `clock.t`. Budget exhaustion → liveness finding, never a silent stop.
6. **Record** one `TraceFrame` **per transition** (captured inside `SimMonitor.recordTransition`, which runs synchronously between `setCurrentState` writes — §5.3), plus settle-boundary queue/error frames.
7. **Check** Safety invariants on each new frame; collect Liveness signal.

### 3.3 Data flow (determinism plane vs perf plane — two disjoint sinks, one run)

- **Deterministic plane** (feeds `hashTrace`): virtual `clock` + virtual `scheduler` + content-only `TraceFrame` (step, virtualTime, cause, event, from, to, queue, quiescent, errorClass). Never any duration / timestamp / heap / error-id.
- **Perf plane** (feeds `PerfReport`, never hashed): real `process.hrtime.bigint()` over batches, `process.memoryUsage()` samples, and the engine's wall-clock transition duration captured by `SimMonitor` for advisory latency only.

---

## 4. Per-dimension design

### 4.1 Core substrate & replay

**Mechanism.** Three pure pieces on top of the existing seams: a seeded PRNG, a `SimClock` cell, and a `SimDriver` step loop producing a canonical hashable `Trace`. No engine change.

**Key interfaces.**
```ts
// src/sim/prng.ts  (sim-only; never imported by core)
export interface Prng {
  readonly seed: bigint
  nextU32(): number               // [0, 2^32)
  nextFloat(): number             // [0,1), 53-bit
  int(maxExclusive: number): number
  pick<T>(xs: readonly T[]): T
  weighted<T>(xs: readonly (readonly [T, number])[]): T
  bool(p?: number): boolean
  fork(label: string): Prng       // child stream seeded from (state, fnv1a(label))
  state(): bigint
}
export function makePrng(seed: bigint | number): Prng
```
- **splitmix64 over `bigint` state**, `number`-returning facade. Pure, engine-agnostic (no float drift), seeds well from any value incl. 0. `MASK64 = (1n<<64n)-1n`; the three splitmix multiply-shift constants.
- **Label-addressed `fork()`** is the spine: scenario-gen, fault-injection, and any action randomness draw from INDEPENDENT label-derived sub-streams (`fork('topology')`, `fork('ops')`, `fork('faults')`, then `fork('step:'+i)`). Adding a new knob mixes a *new* label and does **not** renumber existing draws → the regression corpus stays stable as the harness grows.

```ts
// src/sim/clock.ts
export interface SimClock { now(): number; set(t: number): void; readonly t: number }
export function makeSimClock(start?: number): SimClock // monotonic; throws on backward set
```
Wiring (verbatim proven pattern): `const clock = makeSimClock(0); const scheduler = createVirtualScheduler(clock.now); const sm = new StateMachine(cfg, adapter, { clock: clock.now, scheduler, monitor, errorHandler, logger })`.

**Real seams hooked.** `StateMachineOptions.clock` (types.ts:128), `.scheduler` (types.ts:120), `.monitor` (types.ts:119), `.errorHandler` (types.ts:121), `.logger` (types.ts:118); `scheduler.process(now)` (scheduler.ts:108–132); inspection API (§2).

**Decisions + rationale.**
- splitmix64/bigint + label-fork (above).
- Drive virtual time only via `clock.set` inside `step()`, then `scheduler.process(t)`, then deliver events, then drain. **First action after construction MUST be a drain** because the constructor's `setInitialState` runs `executeEnterActions` as async fire-and-forget and `checkCompletion` defers via `queueMicrotask` (`state_machine.ts:1263–1287`) — frame 0 is recorded only after a post-construction drain.

**Alternatives.** (a) `Math.random` — rejected (nondeterministic). (b) Number-based xorshift128+ — kept as an OPTIONAL fast path for the high-throughput perf channel only, versioned in the trace header; splitmix64 stays the canonical seeder. (c) Global call-counter PRNG — rejected (any generator edit renumbers all draws, invalidating the corpus).

**Risks.** bigint splitmix is ~5–10× slower than Number ops (mitigated by the optional perf-only fast path); the microtask budget is a tunable default that must be validated against the deepest scenario (parallel regions + `checkCompletion` re-raise, `dst.test.ts:294`).

---

### 4.2 Scenario generator

**Mechanism.** A scenario is a JSON-serializable `ScenarioSpec = { seed, version, topology, ops, faults, bounds }`. `runScenario(spec)` deterministically derives BOTH a `validateConfig`-clean machine config AND an operation stream. Same spec → bit-exact trace hash. Each piece independently pin-able for authoring (UR-004).

**Key interfaces.**
```ts
// src/sim/scenario.ts
export interface ScenarioSpec {
  seed: bigint; version: 1
  topology: TopologyParams         // { kind:'generated', recipe } | { kind:'pinned', config }
  ops: OpStreamParams
  faults: FaultPlanParams
  bounds: Bounds                   // maxSteps, maxVirtualTimeMs, maxStates<=1000, maxEvents<=1000, maxDepth<=10
}
export type Op =
  | { id: string; t: 'fire'; event: string; args: number[] }   // STABLE op-id, NOT positional index
  | { id: string; t: 'advance'; dtMs: number }
  | { id: string; t: 'snapshot' } | { id: string; t: 'restore' } | { id: string; t: 'reset' }
  | { id: string; t: 'fault'; spec: FaultOp }
  | { id: string; t: 'noop' }
```
- **`Op` carries a stable `id`**; faults reference ops by op-id, never by positional index (so op-removal in the shrinker re-keys correctly — §4.6 must_fix).
- **Bounds clamped to the engine validator defaults** (`DEFAULT_VALIDATION_CONFIG`: `maxStateDepth:10, maxStatesCount:1000, maxEventsCount:1000`, `config_validator.ts:67`).

**Topology generation.** Grows a depth-bounded state tree (`s0,s1,…` — non-numeric prefix REQUIRED so ECMAScript does not reorder integer-index keys), emits composites/parallel `regions`, `history`, `final` leaves, `invoke` timers (delays drawn; events chosen from the already-generated set so they are dispatchable), guards/actions from a **closure-free** family (see below), explicit `priority` on competing transitions of the same event sharing an overlapping `from`. **Validates with `validateConfig` (errors only, NOT warnings — `SELF_TRANSITION` is a warning) and treats any `isValid === false` as a generator BUG (assert+throw)** — correct-by-construction, no discard-retry (which would itself be a draw-dependent determinism hazard). `from`/`to` paths are produced by the same walk `isValidStatePath`/`validateStatePath` (`config_validator.ts:485`) performs (split on `'|'` and `'.'`, region adds a `.region.` segment) so every emitted path resolves — not "mostly legal".

**Owner shape & closure-free guards (must_fix).** Fixed minimal owner:
```ts
interface SimOwner { state: string; k: number; log: number[] }
```
`stateAttribute = 'state'` (string-typed, satisfies `MISSING_STATE_ATTRIBUTE`). **Generated guards/actions must read ONLY their parameter and contain NO free identifiers.** `serializeAction` captures only `action.toString()` (`security.ts:457`) and re-evals via `new Function()` in a restricted scope with **no captured variables** — a closure over a drawn constant (`(o)=>(o.k % m)===r`) is LOST on snapshot/restore. Therefore the generator **inlines drawn constants as literals into the emitted source** (e.g. emit the literal `(o) => (o.k % 7) === 3`). A generator self-test serializes+deserializes every generated config and asserts guard outputs are identical before/after.

**Operation-stream (closed-loop, available-event-aware).** `genOps` runs against the LIVE engine and asks `sm.getAvailableEvents()` (structural, guards NOT executed) so it mostly drives REAL transitions; with prob `pBlind` it fires a random declared event to exercise the reject path. **Because `getAvailableEvents()` reads `currentState`, which reflects a prior `fireEvent` only after its microtasks flush, the runner MUST drain-to-quiescence before each probe**, and that drain policy is part of the deterministic replay (flush-until-quiescent, §5.2). The "genOps is byte-stable via two-generation JSON.stringify" claim is dropped/qualified: genOps is stable only when run against an identically-driven engine — a runner concern, not a pure-generator property.

**Three fire outcomes (must_fix).** Every `fire` is `await`ed with `.catch`:
- **resolve(true)** — a transition was applied.
- **resolve(false)** — guard-gated no-op or no allowed transition (`executeQueuedTransition` returns false, `state_machine.ts:402–404`).
- **reject** — a declared-but-unavailable event THROWS `StateMachineError('Invalid event…')` (`:381–386`) → `fireEvent` rejects (`:330`); a guard/action throw also rejects. An un-`.catch`ed blind-fire is an unhandled-rejection hazard that can nondeterministically crash the sim. All three are first-class trace events. `pBlind` is documented as "forces the reject path".

**Decisions/rationale.** Generate topology + ops, each pin-able (UR-004); route every choice through one weighted-choose primitive so the shrinker reduces numeric fields, not code; correct-by-construction validation; closed-loop+blind firing keeps the queue actually filling for load/stress (UR-003) while covering rejection paths.

**Alternatives.** Discard-and-retry on invalid config (rejected — draw-dependent). Parameterized per-scenario owner (rejected for v1 — complicates guard purity & serializer-safety; fixed owner maximizes determinism).

**Risks.** Snapshot/restore of generated-guard configs (gated until closure-free form is in place); `fromJSON` hard-sets name to `'DeserializedStateMachine'` and carries no `setContext` binding → the runner must re-apply `setContext` after each restore for named-string actions; `MAX_TRANSITION_DEPTH`/`maxQueueDepth` are expected bounded outcomes under stress, recorded as trace events, NOT Safety violations.

---

### 4.3 Fault-injection layer (full v1 set)

**Mechanism.** A seed-derived `FaultPlan` consumed by a thin `SimHarness` wrapper around the REAL engine. Five of six faults attach to existing injectable seams; only external reorder/drop/dup needs an interception point (the public `fireEvent` boundary). A monotonic `faultStep` counter drives one PRNG draw per opportunity → identical `FaultRecord[]` on replay.

**Key interfaces.**
```ts
// src/sim/faults.ts
export type FaultKind = 'reorder'|'drop'|'dup'|'throw'|'clock-skew'|'timer-jitter'|'overflow'
export interface FaultPlan {
  seed: bigint
  intensity: Partial<Record<FaultKind, number>>   // prob per opportunity
  maxJitterMs: number; maxSkewMs: number; reorderWindow: number
  only?: { events?: string[]; sites?: string[] }   // targeting by harness-controlled FaultSite, NOT engine phase
}
class InjectedFault extends Error {}                 // PLAIN Error subclass — NOT a StateMachineError
```

**Per-fault mechanism (real seams).**
- **(a) Throws** — wrap **function-valued** config callbacks before construction: `guard`, `onTransition`, state `onBefore/onEnter/onAfterEnter` + exit triad, event `onBefore/onAfter/onSuccess`, `invoke[].action`. All resolved through the single chokepoint `callAction` (`state_machine.ts:1726`). The thrown `InjectedFault` is a **plain `Error`**, never a `StateMachineError`/`EnhancedStateMachineError` (those embed `Date.now()` id/timestamp — `error_handling.ts:79,88`). **`invoke[].cond` is EXCLUDED from v1**: it is `(adaptee)=>boolean` called directly at `state_machine.ts:2153/2497` (NOT via `callAction`), and a throw there is caught-logged-and-`continue`d — it never reaches `processError`/`errorState`/`monitor.recordError`. Modeling cond as an error-path fault would be a trace/behavior mismatch. String-method (`ActionOrString` name) callbacks cannot be wrapped by mutating the config and are a documented v1 gap; the coverage gate must NOT report "throw covered" for string-method machines.
- **(b) Clock skew** — driver applies a bounded delta with a `Math.max(t, target+skew)` **monotonic guard** (never backward; `TimerScheduler.process` assumes non-decreasing `now`). Forward jumps are valid faults (collapse multiple deadlines into one tick).
- **(c) Timer jitter** — decorate `createVirtualScheduler`: perturb `delay` before `inner.schedule`, `eff = Math.max(0, delay + j)` (never negative). Affects both invoke delays and `transitionTimeout` (both flow through `setTimer`). Preserve `isActive()===true`.
- **(d) Queue overflow** — flood `fireEvent` past `maxQueueDepth` without draining; the `(maxQueueDepth+1)`-th `fireEvent` **rejects** (Promise rejection, NOT synchronous throw) with `StateMachineError('Event queue overflow — possible infinite loop')` (`:228–240`). Minimal flood = `maxQueueDepth - currentDepth + 1`; harness may lower `maxQueueDepth` to make overflow cheap. The invariant must distinguish harness-induced external overflow from engine-induced internal overflow.
- **(e) Reorder/drop/dup** — a fault-aware submission buffer in front of `fireEvent` (external only). On each `drainStep`: drop a pending submit (Liveness, not Safety), dup (idempotency), or swap within `reorderWindow`. **Internal queue is NEVER scrambled** in v1 — internal-before-external RTC ordering is an engine GUARANTEE; reordering internal events would corrupt run-to-completion rather than test it. Every flushed `fireEvent` is `await`ed with `.catch(captureRejection)`.

**Equal-`executeAt` ordering (must_fix).** The min-heap has **NO insertion tiebreak**; simultaneous-deadline tasks (common under jitter `Math.max(0,delay+j)` and forward skew) fire in **heap-array order** — deterministic for a fixed insertion sequence, but NOT FIFO. The trace captures the **actual fired-callback order** as ground truth; only add a `(executeAt, insertion-seq)` tiebreak if a stable human-predictable order is later required (that would be an engine/ABI change).

**Disable retry recovery.** `RetryRecoveryStrategy` uses real `setTimeout` (`error_handling.ts:154`); the `SimErrorHandler` must disable retry recovery (or route its delay through the injected scheduler) so injected throws don't introduce a real timer.

**Decisions/rationale.** Wrapper-first (zero engine churn, keeps ABI stable, tests the engine's REAL error/backpressure paths); external-only reorder; monotonic skew; single seed + faultStep; `InjectedFault` as plain Error so a thrown fault never poisons replay equality.

**Alternatives.** Optional minimal engine seam `queueInterceptor?` on `StateMachineOptions` (additive `@unstable`) — DEFERRED; only if internal-queue faulting is later mandated, and it would touch the ABI baseline + api-extractor.

**Risks.** `only.phases` targeting on the engine's runtime phase is useless — `callAction` hardcodes `context.phase='action'` for every invocation (`state_machine.ts:1738`), and no call path sets phase `'transition'`. Targeting keys off the harness-controlled `FaultSite`, not the engine phase. `security.ts` crypto/`Date.now` paths are out of v1 sim scope (no token/hash scenarios).

---

### 4.4 Safety invariants catalog & checkers

**Mechanism.** A declarative `Invariant` registry; the runner iterates it and never knows any invariant by name. Fed by a recording `SimMonitor` + settle-boundary inspection reads. The first violation (lowest step) is the shrinker's target predicate. I-1 (determinism) short-circuits the report.

**Key interfaces.**
```ts
// src/sim/invariants.ts
export type InvariantScope = 'step' | 'final' | 'both'
export interface Invariant {
  readonly id: string                  // e.g. 'SAFETY-RTC-SERIALIZED'
  readonly scope: InvariantScope
  readonly capabilityTags?: readonly string[]   // wires into the coverage gate
  checkStep?(frame: TraceFrame, ctx: CheckerContext): Violation | null
  checkFinal?(state: FinalState, ctx: CheckerContext): Violation | null
}
export interface Violation { invariant: string; step: number | 'final'; message: string; observed: unknown; expected: unknown }
```
`CheckerContext.graph` is a read-only `ConfigGraph` derived once from the config (registered leaves, region-key map via `getRegionKey` logic `:2435`, ancestor chains, `final` set).

**The catalog (revised per must_fix).**

| id | scope | mechanism (corrected) |
|---|---|---|
| **I-1 DETERMINISM** | final (meta) | Same seed twice → assert `traceHash` equality. Enabling invariant; if it fails the report short-circuits to I-1 first. |
| **I-2 NO-LOST-EVENTS** | final | A `fireEvent` is "not lost" if it settles by ANY of resolve(true)/resolve(false)/reject(overflow OR invalid-event OR guard/action error). Violation = a `fireEvent` Promise that NEVER settles (queue never drained). Invalid-event and throw rejections are NORMAL, not faults — the overflow-only whitelist is WRONG. |
| **I-3 RTC-SERIALIZED** | step | No re-entrant transitions: assert `isProcessingEvents()===false` at every settle boundary; monotonic frame `step`, no interleave. |
| **I-4 HIERARCHY-ORDER** | step | TASK-012 SCXML order via config-injected pure-append probe actions on `onBeforeEnter`/`onBeforeExit`; recompute expected order from `ConfigGraph` (`computeEnterExitSets`: enter asc depth-then-index, exit desc depth / asc index on ties, `:1558/:1598–1602`) and assert observed probe order matches. |
| **I-5 PARALLEL-JOIN** | step | When every region of composite C is `final`, assert `done.state.<C>` raised this step (if declared); ground-truth oracle `isDone(C)` (`:1433`); compare to observed done events (derived from `isDone` deltas — there is no event-listener API). |
| **I-6 REGION-CONTAINMENT** | step | RE-FRAMED: assert the engine's own guard FIRED. `validateCompositeState` (`:1608`, called inside `updateState :1203` and deserialize `:734`) THROWS on duplicate region key BEFORE `setCurrentState`; verify that throw occurred for a state-corrupting fault and the machine stayed in a graph-valid prior config. The engine CANNOT emit a silently-contradictory config through `updateState`. |
| **I-7 INTERNAL-BEFORE-EXTERNAL** | step | `processQueues` drains internal fully before external (`:315–334`). No external processed while a prior internal step left `internal>0` (unless it raised it). `reorder` faults whitelisted via `frame.faultApplied==='reorder'`. |
| **I-8 RUN-AWAY-BOUND** | step | RE-SCOPED: drop `depthObserved` (`transitionDepth` is PRIVATE, no accessor; contradicts public-surface-only). Under the flat `queueMicrotask` drain the `MAX_TRANSITION_DEPTH` counter is ~0 at the check and the guard is architecturally dormant. The real observable run-away bound is `maxQueueDepth` overflow (I-9). If the engine DOES throw `'Max transition depth exceeded'`, assert it cleanly rejected all external entries (`:307–310`) and cleared the internal queue (`:311`). |
| **I-9 QUEUE-DEPTH-BOUND** | step | `queueAfter.total <= maxQueueDepth`; if a `fireEvent` rejected with the overflow message, assert depth was at the bound (observed-rejection ↔ observed-depth consistency). |
| **I-10 CONFIG-GRAPH-VALID** | both | RE-FRAMED like I-6: verify the engine's `getCurrentState` guard (`:1219`, throws on unregistered leaf) fired and contained the fault; the engine cannot place a bogus leaf into `currentState` silently. Point this at faults that bypass `updateState` (direct adaptee mutation), the only way a bogus config reaches `getCurrentState`. |
| **I-11 ERROR-CONTAINMENT** | step | A thrown guard/action/callback surfaces as a recorded rejection and/or recorded error and does NOT corrupt config (delegates to I-10) nor leave `isProcessing===true` (delegates to I-3). |
| **I-12 DONE-EVENT-GATING** | step | `done.state.<C>` only appears if declared (`events.has`, `:1505`) and NEVER matches a `from:'*'` wildcard (`isEngineDoneEvent`, `:367`). |

**Key correction: transition outcome is NOT from the monitor.** `recordTransition` is called once (`:2060`) ALWAYS with `true`; there is no `recordTransition(_, false)`. `recordError` is GATED behind `if (this.errorHandler.isEnabled())` (`:424`). Therefore: derive transition success from the **`fireEvent` Promise result** (resolve true/false vs reject) + before/after `getCurrentState` deltas; capture errors **unconditionally at the harness boundary** (await + `.catch`), not via `recordError`. `recordEvent` is NEVER called by the engine — no per-event monitor signal exists.

**Capture point (must_fix).** One frame **per transition**, captured inside `SimMonitor.recordTransition` (runs synchronously between `setCurrentState` writes mid-drain) — NOT one frame per settle (which would collapse a multi-transition RTC drain and lose intermediate configs needed for fidelity + shrinking). The monitor reads `getCurrentState` to get from/to; the engine's call site passes no `TransitionContext` so derive from/to from snapshots.

**`'|'`-normalization (must_fix).** The rendered `currentState` is `Array.from(map.values()).join('|')` in **insertion order** (`:1202`), NOT sorted — the engine only sorts inside `isInState` comparison (`:639`). The canonical trace MUST normalize `'|'`-parts itself (`split('|').sort().join('|')`) before hashing, and a regression test pins region-part order so a future Map-reorder refactor cannot silently change the hash.

---

### 4.5 Liveness mode (progress under adversity)

**Mechanism.** Proves the engine keeps making PROGRESS — it does not remain in a transient (non-final, non-quiescent) configuration forever when an enabled, non-faulted transition exists. Runs per-seed AFTER Safety on the same substrate. Fixed-point loop over macrosteps with a virtual-time deadline budget; a fairness "eventually healthy" window mirrors TigerBeetle's "quorum eventually healthy".

**Key interfaces.**
```ts
// src/sim/liveness.ts
interface ProgressFingerprint { config: string; queueDepth: number; pendingTimers: number; earliestTimerAt: number | null }
type Quiescence = 'TERMINAL_FINAL' | 'QUIESCENT_NO_WORK' | 'WAITING_ON_TIMER' | 'ACTIVE'
type LivenessVerdict =
  | { kind: 'PROGRESSED' }
  | { kind: 'STUCK'; reason: string; at: ProgressFingerprint }
  | { kind: 'TIMEOUT_BUDGET_EXCEEDED'; virtualMs: number }
interface FaultSchedule { healAtVirtualMs: number; isHealthyAt(t: number): boolean }
```

**Fairness window.** Progress-BLOCKING faults (drop, guard/action throw aborting a transition, overflow injection) MUST cease after `healAtVirtualMs`; reorder/dup/jitter (perturb-only) may continue (weak fairness). **Liveness checking is SUPPRESSED while `isHealthyAt(clock.t)` is false** — without this every drop-heavy seed is a false STUCK. `healWindow = budgetVirtualMs` must dominate the longest legal timer/transition chain.

**Quiescence classification (the hard part).** Three legitimately-idle situations are NOT stuck: TERMINAL_FINAL (`isDone(C)` for every top-level composite, OR flat machine all leaves `final`); QUIESCENT_NO_WORK (no enabled transition, empty queue, no armed timer — correctly parked); WAITING_ON_TIMER (empty queue but armed timer → jump clock to `earliestTimerAt`). A genuine STUCK is the residue: ACTIVE, faults healed, clock advances, yet fingerprint unchanged across a full macrostep.

**Guard-blocked demotion (must_fix — the load-bearing fix).** `getAvailableEvents`/`canFireEvent` do NOT execute guards (`:518` doc, `:520`), so "structurally enabled" OVER-approximates "fireable". The STUCK rule and the demotion were described in different sections but never reconciled in control flow. **Resolution: thread the fire boolean into the verdict.** After firing the scenario's enabled event: if it **resolved false** AND config+fingerprint unchanged AND faults healed → `QUIESCENT_NO_WORK` (guard-blocked, correct rest), NOT STUCK. Declare STUCK only when a fire **resolved true** (a transition applied) yet fingerprint didn't change, or when queue/timers churn (config stable) without ever reaching final/quiescent. `maybeFireEnabledEvent` must only fire structurally-enabled events and must catch/route a **reject** (Invalid-event throw, `:381–386`) distinctly from a resolve-false, or it will crash mid-liveness-check.

**Cycle detector.** A config oscillating A→B→A changes its fingerprint every step, so the no-advance test misses it. Layer a bounded recurrence detector (`K = states.length + 1`) within the healthy window with monotonically advancing virtual clock and no approach to final/quiescent → STUCK 'configuration cycle without termination'. NOTE: queue-growth livelocks (monotonic queue growth toward `maxQueueDepth`) produce DISTINCT fingerprints and evade K-recurrence — they are a **Safety** concern (the `maxQueueDepth` throw), documented so this is not a coverage-gap claim.

**Observable timers via wrapper.** `ITimerScheduler` exposes no pending-count/earliest-deadline accessor and `TimerScheduler`'s heap is private. Ship an additive `ObservableScheduler` wrapping `createVirtualScheduler`, mirroring `executeAt = clock()+delay` in a `Map<token, executeAt>`, with `pendingCount()`/`earliestExecuteAt()`. **Cancel mirrors the engine's LAZY cancel** (`scheduler.cancel` only removes from `activeTokens`; the wrapped fired-callback is skipped for a cancelled token, so the cb's `live.delete` never runs for a cancelled timer — `cancel()` already did the delete). Re-audit if the scheduler ever grows a bulk `clear()` (one exists at `scheduler.ts:137` but `createVirtualScheduler` does NOT expose it).

**Async-invoke flush rounds.** The invoke callback is `async` (`state_machine.ts:2169/2503`); when `invocation.action` is present, `raiseEvent + scheduleProcessing` run in a LATER microtask than `scheduler.process()` returns. The quiesce loop (process → flush → re-check) handles this, but the cap must allow an extra flush round per action-bearing invoke.

**Risks.** `budgetVirtualMs` must dominate the longest legal chain (cross-dep: generator exposes `maxArmedDelay`/chain-length); liveness must NOT interleave with persistence (`resumeTimers` uses the jumped clock — the oracle never deserializes mid-loop, but the shrinker does, so pin it); `classifyQuiescence` calling `getAvailableEvents` is O(events·transitions) per macrostep (perf note for the throughput channel).

---

### 4.6 Shrinker / minimizer

**Mechanism.** Delta-debugging (ddmin) over the structured `Scenario`. The predicate "still reproduces" = re-run the REAL engine deterministically and assert the SAME invariant fails with the SAME violation FINGERPRINT (not merely `failed` — prevents slippage to a different bug). Soundness rests entirely on bit-exact replay.

**Shrink predicate.**
```ts
function makePredicate(target: Violation, runner: Runner) {
  return async (c: Scenario): Promise<boolean> => {
    const r = await runner(c)
    return r.failed && r.violation!.invariantId === target.invariantId
        && r.violation!.fingerprint === target.fingerprint
  }
}
```

**Shrink moves (per-family ddmin, cheapest-first, looped to a global fixpoint).**
- **M0 disable faults** (highest payoff, first).
- **M1 drop ops** (classic 1-minimality).
- **M2 shrink time advances** (binary-search `dtMs` down; clamp lower bound to max relevant `invoke.delay`/`transitionTimeout`).
- **M3 shrink config** (remove unreferenced states/events/transitions/regions/invoke; **gate every candidate through `validateConfig` errors-only** before running, so an invalid config never "fails for the wrong reason").
- **M4 shrink fault params** (binary-search `clockSkew.deltaMs`, `timerJitter.jitterMs`, `overflow.floodCount` toward boundary; minimal flood = `maxQueueDepth - currentDepth + 1`).
- **M5 narrow event args** (canonical 0/""/null/[]).
- **~~M6 reduce flush count~~ REMOVED (must_fix).** Microtask-flush count is a HARNESS artifact, not an engine input. `Op.flush{microtasks}` is replaced by a deterministic **drain-to-quiescence** primitive (loop until `getQueueDepth().total===0 && !isProcessingEvents()` and scheduler heap empty at current `t`, hard turn cap). Minimizing flush count yields brittle repros.

**Cache canonicalizer (must_fix).** Memoize runner results keyed by a structural hash — but `JSON.stringify` SILENTLY DROPS function-valued guards/actions, collapsing structurally-distinct candidates to the same key. The canonicalizer serializes guard/action bodies via `Function.prototype.toString()` (as `serializeAction` does, `security.ts:457`) and folds them into the key; closed-over data must be lifted into `Scenario` (`initial`/`argSpec`), never captured in config closures (consistent with §4.2's closure-free guards).

**Witness canonicalization (must_fix).** `Violation` "offending state" and `replay.finalState` MUST be normalized `split('|').sort().join('|')` (mirroring `:639–640`); the raw `currentState` is insertion-ordered (`:1202`), not a canonical witness.

**Determinism prerequisites (cross-dep, must_fix).** The shrinker requires the trace hash to exclude BOTH (1) transition-duration `Date.now()` (`:2047/:2059`) AND (2) `security.ts` `serializeAction` `createdAt: Date.now()` (`:430/:462`) which makes `toJSON()` byte-nondeterministic. The codegen must NOT round-trip config through `toJSON()/fromJSON()` for the structural/cache representation; reserve `toJSON/fromJSON` strictly for replaying an explicit snapshot/restore op observed via state, not JSON byte-equality.

**Fault re-keying (must_fix).** Faults reference ops by stable **op-id** (normalized BEFORE M0/M1), not positional `at`, so op-removal re-keys correctly.

**MinimalRepro artifact (UR-003 deliverable).** Emit BOTH (a) a self-contained JSON record `{schemaVersion, packageVersion, seed, scenario, violation, replay:{traceHash, finalState(normalized), finalQueueDepth}, provenance}` and (b) a generated runnable `*.repro.test.ts` reconstructing the scenario via the DST idiom and asserting the violated invariant — a permanent regression test (UR-004) AND a paste-and-run debugging aid. Budget (`maxRuns`, `maxWallMs`, `maxStagnantRounds`) always returns a valid repro (worst case the original failing scenario); `minimal:false` flags non-convergence.

---

### 4.7 Perf / load metrics

**Mechanism.** A `PerfHarness` runs the REAL engine under a fixed seed driving deterministic event volume, samples wall-time/heap out-of-band, and emits a `PerfReport`. The perf plane is structurally walled off from the deterministic trace plane (two disjoint sinks, one run).

**Key interfaces.**
```ts
// src/sim/metrics.ts
export interface PerfSample {
  wallNs: bigint; eventsProcessed: number; transitionsObserved: number
  eventsPerSec: number; transitionsPerSec: number
  latency: { p50: number; p90: number; p99: number; max: number; mean: number; resolution: 'ms-coarse' }
  heapPeakBytes: number; heapAvgBytes: number; heapEndBytes: number; gcProxy: number
  traceLen: number; queueDepthPeak: number
}
```

**Drive loop (must_fix).** After `clock.set(t); scheduler.process()`, add an explicit **async settle barrier** (drain-to-quiescence) because the invoke callback is `async` and `process()` does NOT await it — without it, timer-fired transitions land on a later microtask, `queueDepthPeak` races the real peak, and step counts leak across iterations nondeterministically. Add the **initial `await Promise.resolve()`** after construction before the first clock advance (the constructor arms initial invoke timers via fire-and-forget enter actions).

**Latency resolution (must_fix).** PRIMARY throughput = `process.hrtime.bigint()` over batches (nanosecond, NOT faked). Per-transition latency from the engine's `Date.now()` is ~1ms-coarse AND vitest fakes `Date` (`vitest.config.ts` `toFake` includes `'Date'`), so the monitor-duration latency signal is **invalid under vitest as written**. Resolution: run the perf-regression suite under `vi.useRealTimers()` / a dedicated vitest project that drops `'Date'` from `toFake`, OR derive per-transition latency from harness-side `performance.now()`/`hrtime` (as the existing `performance.test.ts` already does). Mark `latency.resolution = 'ms-coarse'` and treat it as a secondary diagnostic.

**Determinism premise (must_fix).** Drop "engine has exactly ONE wall-clock leak". The PerfHarness injects its own `SimMonitor` (bypassing `createDefaultMonitor`, which stamps `Date.now()` at `monitoring.ts:97` on EVERY transition) and its own `SimErrorHandler`/`NoopLogger`. Determinism comes from content-only tracing, not from a single-leak assumption.

**Baseline + regression.** Commit `etc/sim-perf.baseline.json` (mirrors the `etc/statemachine.api.md` drift-gate UX); refresh via `SM_PERF_UPDATE_BASELINE=1`. Detection: **median-of-N runs (N=5)** vs baseline with **wide percentage tolerance** (throughput 20%, memory 25%, latency-p99 30%) to catch order-of-magnitude regressions without flapping. **`traceLen` checked with ZERO tolerance** — a different step count for the same seed is a determinism/semantics regression (free determinism-regression detector). GC proxy: net retained-heap growth per event (Proxy A, default) or `perf_hooks` GC entries (Proxy B, opt-in). Requires `node --expose-gc` for a stable heap baseline (advisory downgrade if absent).

**Stress scenarios (declarative).** S1 high-volume flat churn (transitions/sec); S2 deep hierarchy (entry/exit + `checkCompletion`); S3 many parallel regions (raiseEvent fan-out, internal-before-external); S4 queue near `maxQueueDepth` (exposes O(n) `Array.shift()` at `:308/:316/:324`); S5 timer-heavy (min-heap under load + lazy-cancel).

**bun caveat.** CI runs the suite via both `bun run test` and `npm test`; `--expose-gc`/`hrtime` plumbing differs under bun. The perf-regression suite must be env-gated and explicitly placed in the right CI leg (§10).

---

### 4.8 Public sim API & packaging

**Mechanism.** Ship as a SEPARATE second entrypoint `@vedmalex/statemachine/sim` (new exports key + second tsup entry + second api-extractor report). DI-first: a consumer-supplied `setup(env)` builds THEIR machine wired to the env's clock/scheduler/monitor/errorHandler.

**Key interfaces.**
```ts
// src/sim/index.ts — the public ./sim entry; NOT re-exported by src/index.ts
export interface SimEnv {
  readonly clock: Clock
  readonly scheduler: ITimerScheduler      // REQUIRED in wiring — see footgun
  readonly monitor: IMonitor               // deterministic, clock-backed
  readonly errorHandler: IErrorHandler      // deterministic, no wall-clock, retry disabled
  random(): number
  now(): number
}
export type SimSetup<T extends object = any> = (env: SimEnv) => SimTarget<T> | Promise<SimTarget<T>>
export interface SimOptions { seed: bigint | string; steps?: number; faults?: FaultPlan
  invariants?: readonly Invariant[]; mode?: 'safety' | 'liveness'; onTrace?: (f: TraceFrame) => void }
export interface SimResult { ok: boolean; seed: string; steps: number; traceHash: string
  trace: readonly TraceFrame[]; violation?: Violation; metrics: PerfSample }
export async function runSimulation<T extends object>(setup: SimSetup<T>, opts: SimOptions): Promise<SimResult>
export declare class Simulator<T extends object = any> {
  constructor(setup: SimSetup<T>, opts: SimOptions)
  init(): Promise<void>; step(): Promise<StepOutcome>; run(): Promise<SimResult>
  snapshot(): SimSnapshot; readonly env: SimEnv
}
```

**Determinism boundary (must_fix).** The SimEnv MUST provide a deterministic `monitor` AND `errorHandler` AND a no-op `logger`, and the documented `setup()` wiring MUST forward `{ clock, scheduler, monitor, errorHandler, logger }` together — because `createDefaultMonitor` (`monitoring.ts:77,97`) and `createDefaultErrorHandler` (`error_handling.ts:79,88`) read `Date.now` on the transition/error hot paths whenever omitted. The canonical `traceHash` is derived ONLY from observable state-transition data (from/to/event/queueDepth/logical clock), never any monitor/error field.

**Scheduler-omission footgun (must_fix).** Forwarding `clock` but omitting `scheduler` yields the **real-time** `createDefaultScheduler()` (`:155`) under a virtual clock — a silent determinism hole the type system cannot catch. Make `scheduler` REQUIRED in the wiring contract and document it loudly (worse than the Math.random/Date.now footgun).

**Settle model (must_fix).** `processQueues` drains the WHOLE queue in ONE async loop (`:292–340`); microtask rounds scale with async-action awaits + post-drain re-scheduling cycles, NOT with `MAX_TRANSITION_DEPTH`. Use loop-until-quiescent (`while (getQueueDepth().total>0 || isProcessingEvents()) await Promise.resolve()`, bounded for non-termination detection), not a fixed `flush(16)` justified by depth.

**fireEvent sequencing contract (must_fix).** Specify EXACTLY when `fireEvent`'s returned Promise is awaited relative to clock advance, `scheduler.process()`, microtask settle, and PRNG draws — ambiguous ordering causes replay divergence and defeats UR-002. Also: `fireEvent` is overloaded — a non-Adapter 2nd positional arg is unshifted into args (`:469–471`); pin whether `args[0]` can be an object.

**Packaging.**
- `tsup.config.ts`: `entry: ['src/index.ts', 'src/sim/index.ts']`, keep `splitting: false`. NOTE (must_fix): with `splitting:false` the engine source is **duplicated** into `dist/sim/index.{js,cjs}` (no shared chunk) — sim re-bundles the engine. This is fine (sim is opt-in) and satisfies UR-005 (core `'.'` bundle bytes unchanged). Document that consumers pick one entrypoint. Do NOT enable splitting (would change the core chunk layout).
- `package.json` exports adds `"./sim": { types, import, require }`; `"."` UNCHANGED; `sideEffects:false` stays valid.
- Declarations: `tsc -p tsconfig.build.json --emitDeclarationOnly` already includes `src/**`, so `types/sim/index.d.ts` is emitted. NOTE: a sim TYPE error blocks the core `build`/`prepublishOnly` (shared tsconfig include) — accept and document, or isolate sim under a separate include.
- api-extractor: a SECOND config `api-extractor.sim.json` (`mainEntryPointFilePath: types/sim/index.d.ts`, `reportFileName: statemachine-sim.api.md`) + `api:check:sim` script (the single-entry `api-extractor.json` cannot target two surfaces). Core `etc/statemachine.api.md` asserted zero-diff via `git diff --exit-code`.
- knip: `src/sim/index.ts` must be a recognized entry. **VERIFY first** (`knip --no-progress`): knip 6 derives entries from `package.json` exports → source; the new `./sim` exports key MAY already register it. Only add config if actually flagged; if needed, add `src/sim/**` reachable via the entry (mirror the existing `src/presets.ts`/`src/security.ts` ignore pattern). knip currently `ignore`s `src/tests/**` (NOT `src/sim/**`), so the sim PRODUCTION code is subject to the dead-code gate.
- Stability: tag every sim symbol `@unstable` (own stability island, mirrors the package default at `index.ts:6`); add a `public_sim_surface.test.ts` asserting presence (not frozen md5). Note: ABI tests in `src/tests/abi/*.test.ts` are **structural `expectTypeOf` conformance**, NOT md5 contracts — the drift gate is api-extractor.

---

### 4.9 Coverage CI gate (capability registry + runtime instrumentation)

**Mechanism.** A static `CapabilityRegistry` (closed string-literal union + `Record<CapabilityId, Capability>` so `tsc` forces every id to have an entry) plus pure `CapabilityProbe` functions over the recorded trace decide whether each capability was exercised. The gate unions exercised sets across all scenarios and FAILS CI if any registry capability has zero covering scenarios. Runtime instrumentation (probes over the real trace), NOT manual tags, is the primary signal; tags are a drift-checked optional override (can document, never fake — a scenario claiming `expects:[x]` whose probe never fired `x` fails CI).

**Key interfaces.**
```ts
// src/sim/capabilities.ts
export type CapabilityId = /* closed union, see §6 table */ string & {}
export interface Capability { id: CapabilityId; title: string; engineRefs: readonly string[]; probe: CapabilityProbe; tier?: 'core'|'advanced' }
export const CAPABILITIES: Record<CapabilityId, Capability> = { /* exhaustive */ }
export type CapabilityProbe = (trace: SimTrace) => boolean
```

**Observation seams (must_fix corrections).**
- Transition edges (from/to/event) are reconstructed in the harness by snapshotting `getCurrentState()` before+after each `fire()`/`advance()` paired with the harness-fired event name — NOT from `IMonitor.recordTransition`, which passes ONLY `(duration, true)` and never the `TransitionContext` 3rd arg. Treat `IMonitor` only as a coarse transition-count + success-count signal.
- `ok===false` is structurally unobservable via the monitor; derive failure from rejected `fire()` promises at the harness boundary.
- Errors: capture UNCONDITIONALLY at the harness boundary (`await fire().catch`), NOT via `recordError` (gated behind `errorHandler.isEnabled()`). Overflow ('Event queue overflow…') and depth ('Max transition depth exceeded…') arrive as Promise REJECTIONS, not synchronous throws — use `await … .catch`, distinguish by message.
- `isDone` requires a `compositeId` argument (`:1433`) — there is NO zero-arg global-done. Snapshot `isDone(C)` per declared composite, or detect completion via the engine-raised `done.state.<C>` transition event. Remove any unsourced global `isDone:boolean`.
- Per-hook-phase capabilities (onBeforeEnter/onEnter/onAfterEnter, exit triad): use scenario-pushed **owner-markers** (no observer on the private `callAction`; `recordEvent` never called). An additive `IMonitor.recordHook?` is a hard cross-dependency, not assumed.
- done.state vs wildcard reliably separated by `event.startsWith('done.state.')` vs `event==='*'` (`isEngineDoneEvent`, `:367`).

**Probe examples.**
```ts
'composite.join.done-state':   t => t.events.some(e => e.kind==='transition' && e.event?.startsWith('done.state.')),
'event.wildcard':              t => t.events.some(e => e.kind==='transition' && e.event==='*'),
'queue.backpressure.overflow': t => t.events.some(e => e.kind==='error' && e.message.includes('queue overflow')),
'timer.transitionTimeout':     t => t.events.some(e => e.kind==='error' && e.message.includes('Transition timeout')),
```

**Gate algorithm.** Replay all registered scenarios → union covering sets → `uncovered = keys(CAPABILITIES) \ covered`; CLI exits non-zero on `uncovered.length>0 || drift.length>0` with a legible report (capability id + engineRef + "add a scenario that …"). Also runnable as `src/tests/sim/coverage.test.ts`.

**knip conflict (must_fix).** `src/sim/**` WILL be flagged dead by `npm run check` (knip `project:['src/**/*.ts']`, ignore lacks `src/sim`). Resolve explicitly: add `'src/sim/**'` reachability via the `./sim` entry OR nest the gate under `src/tests/` — pick one before folding `sim:coverage` into `check`.

**New-feature workflow (the enforced loop).** Adding an engine capability ⇒ (1) add a `CapabilityId` + `CAPABILITIES` entry (omitting → `tsc --noEmit` fails the `Record`); (2) add/extend a `SimScenario` (omitting → `computeCoverage` reports uncovered, CI fails); (3) optional `expects` (drift-checked). The catalog-completeness gap (nothing forces a NOVEL engine branch to get a `CapabilityId` at all) is a documented process gap closed by PR-template/review, not tooling — soften "teeth" to "enforced once a capability id is declared".

---

### 4.10 Repo layout & CI wiring

**Layout.**
```
packages/statemachine/
  src/sim/
    prng.ts  clock.ts  driver.ts  trace.ts
    scenario.ts  topology.ts  ops.ts  define.ts
    faults.ts  harness.ts
    invariants.ts  liveness.ts  observable-scheduler.ts  fairness.ts
    shrinker.ts  repro-codegen.ts
    metrics.ts  coverage.ts  capabilities.ts
    sim-monitor.ts  sim-error-handler.ts  noop-logger.ts
    scenarios/*.ts                # named pinned/generated specs feeding coverage + nightly
    index.ts                      # PUBLIC ./sim entry
  src/tests/sim/
    prng.test.ts  replay.test.ts  faults.test.ts  invariants.test.ts
    liveness.test.ts  shrinker.test.ts  coverage.test.ts  metrics.test.ts
    generator.test.ts  public_sim_surface.test.ts
  etc/statemachine-sim.api.md  etc/sim-perf.baseline.json
  api-extractor.sim.json  knip.json (modified)  tsup.config.ts (modified)  package.json (modified)
.github/workflows/sim-nightly.yml (new)  .github/workflows/ci.yml (modified)
```
The sim imports the engine **only via the public `../index` surface** (never deep internals) — binds to the stable ABI the existing `src/tests/abi/*` guard, and makes the sim double as a public-surface conformance harness (UR-003).

**CI (mirrors TigerBeetle fast-PR + 24/7-sweep split).**
- **Fast PR gate** — fold a small fixed-seed budget (`SIM_SEEDS=64 SIM_STEPS=200`) of safety+liveness + the coverage gate + a perf SMOKE into the `tier-a-node` (node 20) leg only (`if: matrix.node-version == 20`, like `api:check`/`test:coverage`), plus `api:check:sim` + `git diff --exit-code etc/statemachine-sim.api.md`. Keep the heavy sim suite OUT of the default `vitest run` include (which both `bun run test` and the node-18/20 matrix execute) — env-gate via `describe.skipIf(!process.env.SM_SIM)` or a separate include — so PR-leg budgets (bun + node18) are respected.
- **Nightly sweep** — new `sim-nightly.yml`: `cron: '0 3 * * *'` + `workflow_dispatch`; matrix `shard: [0..7]` (seed % 8); time-boxed (`timeout-minutes: 60`) so it "runs to the wall"; on failure the shrinker writes `.sim-out/<seed>.repro.json` (+ `*.repro.test.ts`) and uploads it as an artifact; optionally opens/updates a tracking issue with the seed.
- **Core-bundle byte guard** — there is NO existing size gate; add a snapshot/hash check of `dist/index.{js,cjs}` (a test or CI step) to prove `'.'` bytes are unchanged after adding the second entry. `verify-dist.cjs` and `api:check` do NOT cover dist byte stability.

---

## 5. DETERMINISM section (load-bearing — resolves quiescence + every wall-clock/random leak)

### 5.1 Full wall-clock / randomness leak inventory (verified via grep over `src` excluding tests)

| Site | What it stamps | Reaches the trace? | Resolution |
|---|---|---|---|
| `state_machine.ts:2047,2059` | transition duration via `Date.now()` (intentionally NOT virtualized; comment `:2044–2046`) | only if duration enters the hash | **EXCLUDE from `hashTrace`**; capture in the non-hashed perf channel only. Never affects engine state/selection/queue/timers → zero replay-fidelity loss. |
| `monitoring.ts:77,97,122,163,170,371,550,645,653,661,677,681` | `startTime`, per-record `timestamp:Date.now()`, uptime, prometheus/health, internal `recordTransition(Date.now()-start)` | YES if the DEFAULT monitor is used (`createDefaultMonitor()` wired at `:153` when omitted) | **Inject `SimMonitor` (a clock-backed deterministic `IMonitor`); NEVER use `createDefaultMonitor`; NEVER call `monitor.start()`** (it arms real `setInterval`s at `monitoring.ts:230,337`). |
| `error_handling.ts:79,88,249` | `EnhancedStateMachineError.timestamp`, `errorCode` = `SM_<cat>_<sev>_<Date.now().slice(-6)>`, retry timestamp | YES if an error field enters the trace; the fault model injects throws | **Trace captures only a STABLE error CLASS/category, never a timestamped `errorCode` or message.** Strip `errorCode` + `extendedContext.timestamp` explicitly (NOT a generic `error.toJSON()` dump, which re-emits them). `InjectedFault` is a plain `Error` so it carries no such fields. Inject a `SimErrorHandler` with retry recovery disabled (real `setTimeout` at `:154`). |
| `security.ts:430,462` | `createdAt:Date.now()` baked into serialized-action metadata AND the security hash on every `toJSON()`/`toSecureJSON()` | YES if snapshot JSON enters the trace/cache key | **Do NOT hash raw `toJSON()` bytes.** A snapshot/restore op contributes only the reconstructed `currentState`(normalized) + `stateEntryTimes` to the trace, never the serialized action bodies/hashes. The shrinker cache key serializes guard/action via `Function.prototype.toString()` and excludes `createdAt`. |
| `logger.ts:113,116,189` | log-record timestamps | only if logs are traced | **Inject a `NoopLogger`** (`StateMachineOptions.logger`, types.ts:118); logs are never traced. |
| (engine) | NO `Math.random`, NO `performance.now`, NO other `new Date()` in core engine state paths | — | Transition selection is deterministic: priority-then-declaration order (`getAllowedTransitions`), region init `regionStatesConfig.initial \|\| Object.keys()[0]` (insertion order, `:1320`), enter/exit explicit `.sort((a,b)=>a.depth-b.depth\|\|a.index-b.index)` (`:1598–1602`). |

**Canary test (required).** A seeded scenario that throws in an action AND does a snapshot/restore must still produce a bit-exact `traceHash` across two runs. This catches any of the above leaks re-entering the hash.

### 5.2 queueMicrotask quiescence strategy (the single shared drain primitive)

The engine drains via `queueMicrotask(() => processQueues())` under an `isProcessing` guard; settledness is not synchronously observable and there is no `await sm.untilIdle()` seam. The shared primitive replaces the fixed `flush(16)` heuristic with a **structural quiescence predicate + bounded microtask pump**:

```ts
const MICRO = () => Promise.resolve()
async function drainToQuiescence(sm, scheduler, clock, maxTurns = 1024): Promise<DrainResult> {
  let turns = 0
  for (;;) {
    while ((sm.getQueueDepth().total > 0 || sm.isProcessingEvents()) && turns < maxTurns) {
      await MICRO(); turns++
    }
    // re-check after the loop: process() may have armed nothing new at this t
    if (sm.getQueueDepth().total === 0 && !sm.isProcessingEvents() && schedulerEmptyAt(clock.now())) {
      return { quiescent: true, turns }
    }
    if (turns >= maxTurns) return { quiescent: false, reason: 'microtask-budget', turns } // → liveness finding
  }
}
```
- Deterministic because V8 microtask ordering is FIFO and stable within a single isolate, and virtual mode creates NO real timers/I-O/other microtask sources.
- Budget exhaustion is a **liveness finding**, never a silent truncation; the cap exists to detect non-termination, NOT to match `MAX_TRANSITION_DEPTH` (a flat-drain artifact — the depth counter is ~0 at the check; one 100-hop chain is ONE `processQueues`, not 100 microtask turns). The cap must allow an extra flush round per action-bearing invoke (the invoke callback is async).
- **Construction quiescence**: first action after `new StateMachine(...)` is a drain (initial enter actions + `checkCompletion` defer via `queueMicrotask`).
- **Cross-runtime scope (must_fix)**: the trace header records `{ engine, version, runtime }`; the seed→bit-identical-hash contract and the regression corpus are scoped to ONE pinned runtime (microtask-FIFO determinism is single-V8-isolate only). Note: vitest fakes `'Date'` but deliberately NOT `queueMicrotask`/`process.nextTick`/`setImmediate`, so the pump is not interfered with under test; but the replay bit-exactness test must inject `SimMonitor` so it does not depend on vitest's Date fake (a public `./sim` consumer runs with real `Date.now()` and must still replay bit-exactly).

### 5.3 Canonical trace + per-transition capture

```ts
// src/sim/trace.ts
export interface TraceFrame {
  step: number; t: number
  cause: 'init' | 'external' | 'timer' | 'internal'
  event?: string                 // undefined for init; 'done.state.<C>' / '*' distinguishable
  from: string; to: string       // normalized: split('|').sort().join('|')
  queue: { internal: number; external: number }
  quiescent: boolean
  errorClass?: string            // stable error CLASS only — never errorCode/timestamp/message
  faultApplied?: string
  fireOutcome?: 'resolve-true' | 'resolve-false' | 'reject'
}
export interface CanonicalTrace { header: { seed: string; configHash: string; engine: string; version: string; runtime: string }; frames: TraceFrame[] }
export function hashTrace(tr: CanonicalTrace): string  // key-sorted stable serialization; OMITS perf/duration/timestamps
```
One frame **per transition**, captured inside `SimMonitor.recordTransition` (synchronous, between `setCurrentState` writes), so multi-transition RTC drains are not collapsed; plus settle-boundary queue/error frames. from/to derived from `getCurrentState()` reads (the engine call site passes no `TransitionContext`). The fired timer-callback order is captured as ground truth for equal-`executeAt` ties (no heap insertion tiebreak).

---

## 6. Capability registry table (the coverage gate enforces every row)

| CapabilityId | Engine ref | Probe signal |
|---|---|---|
| `event.fire.external` | `state_machine.ts:453` | a `fire` op produced a transition or settled rejection |
| `event.raise.internal` | `:271` | internal-cause frame observed (queue.internal>0 then drained) |
| `queue.internal-before-external` | `:315–334` | internal frame precedes external within a macrostep |
| `transition.guard.pass` / `transition.guard.block` | `getAllowedTransitions` | fire resolve-true vs resolve-false on a guarded transition |
| `transition.priority` | `:1808–1848` | competing same-event transitions, higher priority wins |
| `transition.onTransition` | `:1996` | onTransition probe-marker fired |
| `event.wildcard` | `:367–369` | transition with `event==='*'` |
| `hook.entry.onBeforeEnter` / `onEnter` / `onAfterEnter` | `:2127–2132` | owner-marker per phase |
| `hook.exit.onBeforeExit` / `onExit` / `onAfterExit` | `:2097–2101` | owner-marker per phase |
| `event.onBefore` / `onAfter` / `onSuccess` / `onError` | event hooks | probe-marker |
| `hierarchy.nested-enter` | `:1238` | a transition `to` enters a region leaf (path contains `.`) |
| `composite.parallel-regions` | RegionsConfig | normalized `to` has `>1` `'|'`-part |
| `composite.join.done-state` | `:1459/:1504` | `done.state.<C>` event observed |
| `history.shallow` / `history.deep` | `:1104/:1123` | re-enter a composite that restores a non-initial leaf |
| `timer.invoke.fire` | `:2142` | timer-cause frame from an invoke |
| `timer.invoke.cond-skip` | `:2151/:2497` | invoke armed but cond returned false (skip observed) |
| `timer.invoke.cancel-on-exit` | exit clears timers | armed timer cancelled by an exit before firing |
| `timer.transitionTimeout` | `:1786/:1795` | error frame with 'Transition timeout' |
| `timer.resume` | `:2443` | restore op preserves a remaining invoke delay |
| `error.action-throw` / `error.guard-throw` | `callAction` throws | InjectedFault reject frame, by site |
| `error.recovery.errorState` | `:2017` | errorState fallback config reached after a throw |
| `error.recovery.abortOnExitError` | `:1985` | abortOnExitError path observed |
| `queue.backpressure.overflow` | `:228–240` | error frame with 'queue overflow' |
| `queue.depth-bound.max-transition` | `:299` | (dormant) observed only if engine throws 'Max transition depth exceeded' |
| `persistence.serialize` / `persistence.deserialize` | `:2527/:762` | snapshot/restore op observed |
| `inspection.getQueueDepth` / `getCurrentStateInfo` / `isDone` | `:483/:588/:1433` | sampled by the runner around each step (`isDone(C)` per composite) |

The `Record<CapabilityId, Capability>` makes "register a capability" a compile-time guarantee; the gate makes "cover a capability" a CI guarantee.

---

## 7. Acceptance criteria (mapped to URs)

| AC | Statement | UR |
|---|---|---|
| **AC-1** | `replay.test.ts` proves one seed → bit-exact `hashTrace` across two runs, including a canary scenario that throws in an action AND does snapshot/restore. | UR-002 |
| **AC-2** | All three adapted fault seams are exercised and individually reproducible: event-queue (reorder/drop/dup), scheduler (clock-skew/timer-jitter), callback (guard/action/callback throws), plus queue-overflow. Each fault recorded as a `FaultRecord` and regenerated identically on replay. | UR-002, UR-005.4 |
| **AC-3** | Safety mode catches each planted invariant violation (I-1..I-12); Liveness mode reports STUCK on a planted livelock and PROGRESSED otherwise, with the eventually-healthy window suppressing false STUCK. | UR-002 |
| **AC-4** | The shrinker reduces a planted long failing trace to a 1-minimal `MinimalRepro` (JSON + runnable `*.repro.test.ts`) that re-fails the SAME fingerprint. | UR-002, UR-004 |
| **AC-5** | A nightly time-boxed seed-sweep workflow exists, shards seeds, and uploads `{seed, minimal-reproducer}` on failure. | UR-002 |
| **AC-6** | `runSimulation`/`Simulator` is constructible from `@vedmalex/statemachine/sim` for an arbitrary consumer machine AND used by the internal `src/tests/sim/*`. | UR-003, UR-005.1 |
| **AC-7** | A `PerfReport` (events/sec via hrtime, heap, trace-length distribution, queueDepthPeak) is emitted; PR-gate enforces median-of-N regression thresholds from `etc/sim-perf.baseline.json`; `traceLen` is zero-tolerance. | UR-003, UR-005.2 |
| **AC-8** | The capability registry enumerates engine capabilities; `sim:coverage` FAILS CI on any uncovered capability or any `expects` drift. | UR-004, UR-005.3 |
| **AC-9** | `./sim` is a separate export; `etc/statemachine.api.md` shows a ZERO diff; `dist/index.{js,cjs}` bytes are unchanged (byte/hash guard); the sim surface has its own api-extractor baseline `etc/statemachine-sim.api.md`. | UR-005.1 |
| **AC-10** | `npm run check` (biome + tsc + knip + sim:coverage) is green; coverage thresholds (90/90/90/90) maintained for `src/sim/**`; no `Math.random`/`Date.now`/`performance.now` reaches any hashed trace field (CODE_REVIEW grep-audit enumerated). | UR-002, UR-004, UR-005 |

---

## 8. MB3 phase plan

| Phase | Concrete deliverable |
|---|---|
| **VAN** (done) | Scope = `src/sim/**` + `src/tests/sim/**`; continuation of TASK-013 seam + TASK-012 regions; this dimension-design packet. |
| **CREATIVE** | `artifacts/creative-dst-architecture.md` ADR: chosen PRNG (splitmix64+label-fork), trace-hash canonicalization (EXCLUDE duration; ratify exclusion over virtualization given the `:2044` comment), full leak-neutralization policy (§5.1), fault taxonomy + external-only reorder decision, safety/liveness oracle shape, separate-entry + DI-monitor/errorHandler decision. Each through `mb3-critic` DA gate. |
| **PLAN** | This file (`.plan/TASK-014-dst-simulation-plan.md`) — consolidated build plan + ordered sequence (§9) + per-step DoD. |
| **TECH_SPEC** | `artifacts/tech-spec-sim-api.md`: frozen TS signatures (`Simulator`, `SimEnv`, `ScenarioSpec`, `Op` w/ stable id, `FaultPlan`, `Invariant`, `CapabilityRegistry`, `TraceFrame`) + the full wiring diff (`package.json` exports, `tsup`, `api-extractor.sim.json`, `knip`). The full Date.now/new Date/Math.random/performance.now enumeration (§5.1) is a concrete TECH_SPEC deliverable, not a one-line grep. |
| **IMPLEMENT** | `src/sim/*` + `src/tests/sim/*` passing `npm run check && npm test`; `etc/statemachine-sim.api.md` + `etc/sim-perf.baseline.json` baselines committed; leak-neutralization landed (SimMonitor/SimErrorHandler/NoopLogger injected; trace excludes duration/timestamps/errorCode). |
| **QA (MAX)** | Green `sim:pr` locally (seed budget + coverage gate + perf smoke); AC-1 replay canary green; coverage 90/90/90/90 for `src/sim/**`; knip clean. |
| **CODE_REVIEW** | `mb3-critic` verdict: determinism grep-audit (whole package: state_machine/monitoring/error_handling/security/logger), `'.'` ABI unchanged + `'./sim'` ABI gated, dist byte-stability proven, no positional fault-keying, closure-free guards verified. |
| **REFLECT** | `artifacts/reflect.md`: which URs FULLY vs PARTIALLY met (e.g. "ALL engine functionality" is registry-scoped, not literally exhaustive; string-method throws + invoke.cond faults are documented v1 gaps; coverage = "registry-scoped" honesty note). |
| **ARCHIVE** | `.changeset/*` (minor — additive `./sim` export, like TASK-013's DST changeset); README "Simulation / DST" section; CHANGELOG; capability-registry snapshot archived. |

---

## 9. Ordered implementation sequence (dependency-correct)

1. **PRNG + trace + clock substrate** (`prng.ts`, `trace.ts`, `clock.ts`): splitmix64 with golden vectors; `makeSimClock`; `hashTrace` excluding all wall-clock/perf fields with `'|'`-normalization. Proves the determinism floor first.
2. **Deterministic DI components** (`sim-monitor.ts`, `sim-error-handler.ts`, `noop-logger.ts`): clock-backed `IMonitor` (per-transition frame capture; never `start()`), retry-disabled wall-clock-free `IErrorHandler`, no-op `ILogger`. These neutralize §5.1 before any run is recorded.
3. **Driver** (`driver.ts`): wrap the proven harness; `drainToQuiescence` (§5.2); step loop (pick → fault → advance+process → deliver+await/.catch → drain → record per-transition → check). NO faults yet. Validate against all 12 `dst.test.ts` behaviors + the initial-construction drain.
4. **Scenario generator** (`scenario.ts`, `topology.ts`, `ops.ts`, `define.ts`): `genConfig` (correct-by-construction, validateConfig errors-only, closure-free literal guards, non-numeric-prefix names); `genOps` (closed-loop drain-before-probe, three fire outcomes, stable op-ids). Replay test: same spec → identical hash.
5. **Fault layer** (`faults.ts`, `harness.ts`, `observable-scheduler.ts`): full v1 set at the three seams (external-only reorder/drop/dup; jittered/skewed scheduler with monotonic guard; function-callback throws as plain `InjectedFault`, cond + string-method excluded; overflow flood); `FaultRecord` in trace; `ObservableScheduler` with lazy-cancel mirror.
6. **Invariants + liveness + fairness** (`invariants.ts`, `liveness.ts`, `fairness.ts`): I-1..I-12 (revised); fixed-point oracle with eventually-healthy window + guard-blocked demotion threaded via fire boolean + cycle detector.
7. **Shrinker + codegen** (`shrinker.ts`, `repro-codegen.ts`): ddmin M0–M5 (no M6), per-family to fixpoint; fingerprint predicate; toString-based cache canonicalizer; op-id re-keying; `MinimalRepro` JSON + `*.repro.test.ts`.
8. **Metrics** (`metrics.ts`): `PerfHarness` (settle-barrier + initial flush), hrtime throughput, heap samples, gc proxy; median-of-N regression + zero-tolerance traceLen; baseline file.
9. **Coverage + registry** (`capabilities.ts`, `coverage.ts`, `scenarios/*.ts`): `Record<CapabilityId, Capability>`; harness-snapshot transition reconstruction; probes; gate CLI + drift; resolve knip.
10. **Public API + build wiring + ABI** (`index.ts`, `package.json`, `tsup.config.ts`, `api-extractor.sim.json`, `public_sim_surface.test.ts`, dist byte guard). Surface frozen LAST after internals settle.
11. **CI** (`ci.yml` PR-fast gated to node-20 + env-gated suite, `sim-nightly.yml` cron + shard + artifact upload, core-bundle byte/hash check).

---

## 10. Consolidated risk register + open questions

| Risk | Mitigation |
|---|---|
| Wall-clock leaks beyond `:2047` re-enter the hash (monitoring/error_handling/security/logger). | Inject SimMonitor/SimErrorHandler/NoopLogger; trace records only stable content; strip `errorCode`/timestamps; never hash raw `toJSON()`. AC-1 canary + CODE_REVIEW grep-audit. |
| Microtask budget falsely flags non-quiescence on deep chains. | Configurable cap; exhaustion = liveness finding not error; default validated against parallel-regions + checkCompletion re-raise; +1 round per async invoke. |
| Cross-runtime microtask-order divergence (node/bun/browser). | Header pins `{engine, version, runtime}`; corpus + replay scoped to one runtime. |
| `splitting:false` duplicates the engine into the sim bundle. | Documented (sim is opt-in; consumers pick one entry); core `'.'` bytes proven unchanged by a hash guard; do NOT enable splitting. |
| knip flags `src/sim/**` as dead → `check` fails. | Verify `knip --no-progress` after adding `./sim` exports key; add reachability/ignore only if actually flagged. |
| Heavy sim suite runs in fast CI legs (bun + node18) and flaps. | Env-gate (`SM_SIM`/`describe.skipIf`) + node-20-only PR step; nightly sweep separate workflow. |
| Snapshot/restore breaks replay (security `createdAt`, dropped closures, lost `setContext`/name). | Closure-free literal guards; snapshot contributes only reconstructed state to the trace; runner re-applies `setContext` after each restore; toString-based cache key. |
| Liveness false STUCK on guard-blocked or drop-heavy seeds. | Eventually-healthy window suppression; fire-boolean-threaded guard-blocked demotion to QUIESCENT_NO_WORK. |
| Equal-`executeAt` timer order assumed FIFO. | No heap insertion tiebreak — capture actual fired order as ground truth; only add `(executeAt, seq)` tiebreak as an explicit engine/ABI change if needed. |
| `MAX_TRANSITION_DEPTH` invariant assumed reachable. | Dormant under flat drain (counter ~0 at check); run-away bound observed via `maxQueueDepth` overflow (I-9). |
| Perf latency from faked `Date` under vitest. | Perf suite under `vi.useRealTimers()`/separate project, or hrtime/performance.now harness sampling; wide bands + median-of-N; zero-tolerance traceLen. |
| Sim type error blocks core `build`/`prepublishOnly` (shared tsconfig). | Accept + document, or isolate sim under a separate `tsconfig` include. |

**Open questions.**
1. CREATIVE must ratify EXCLUSION of transition duration from the hash vs virtualization (recommended: exclusion — honors the `:2044` "Do not virtualize" comment, no engine churn).
2. Concrete events/sec floor + peak-heap ceiling for `etc/sim-perf.baseline.json` — needs a one-time measurement pass on the CI runner class during IMPLEMENT.
3. Is `process.memoryUsage()` acceptable given tier-b deno/browser jobs? (Likely a node-only runtime guard so the sim core stays portable.)
4. Should `recordHook?` be added to `IMonitor` (engine-instrumentation cross-dependency) or stay owner-marker-only for v1? (Default: owner-marker.)
5. Capability catalog completeness for novel engine branches is a process gap (PR-template/review), not closable purely by tooling — accept and document.
6. Should the optional Number-based xorshift fast-path PRNG be in v1 or deferred until the perf channel proves bigint is the bottleneck? (Default: defer; versioned in header if added.)
