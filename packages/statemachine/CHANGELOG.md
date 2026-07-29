# @vedmalex/statemachine

## 1.0.0-beta.5

### Minor Changes

- 849c2b6: The library now loads outside Node; failing `invoke` actions stop being silent; and the dynamic check no longer fails a run over its own turn budget.

  **The bundle loads in a browser (and in Deno).** `dist/index.js` opened with a static
  `import { AsyncLocalStorage } from "async_hooks"` — a bare Node builtin. A browser
  cannot resolve it, so the module never loaded and nothing was exported; Deno rejected
  it for the same reason. That primitive backs the precise reentrancy detector, so it
  could not simply be dropped. It becomes an injection contract: `IContextTracker`, a
  new optional `StateMachineOptions.contextTracker`, and an import-free default that
  resolves `process.getBuiltinModule('node:async_hooks')`, then a global
  `AsyncContext.Variable`, then a no-op — each accepted only after a live round-trip
  probe, so a name-alike with the wrong shape cannot silently take over reentrancy
  detection.

  Measured per runtime: **Node 24 and Deno 2.2 both get the precise detector**
  (Deno resolves `AsyncLocalStorage` through its Node-compat layer). **A browser gets
  neither primitive today** and runs degraded: a genuinely reentrant `fireEvent` issued
  from inside an action is NOT detected — instead of the explicit error you get on Node,
  that machine's drain parks until `transitionTimeout` settles it. A legitimate
  concurrent `fireEvent` is never falsely rejected, in any runtime. The machine logs one
  `WARN` per process, at the first construction that falls back, and `machine.contextTrackerKind` reports
  which primitive is in use. The `./sim` entry remains Node-only by design.

  **FIX — a failing `invoke` action is no longer silent.** A timer-form `invoke` whose
  action threw, or whose `transitionTimeout` expired, reported nothing anywhere: no
  `monitor.recordError`, no config-level `onError`, no rejection — the machine simply
  stopped advancing. Both failure modes now route through the same channels every other
  invoke failure uses. The invoke's `event` stays unraised, since raising it would
  fabricate a completion the action never reached. **If you have a config-level
  `onError`, it will now be called for failures it previously never saw.**

  **FIX — the deadline timer is cleared on both scheduler paths.** With the default
  scheduler, every action call made under a `transitionTimeout` left a real `setTimeout`
  pending for the whole budget, holding the Node event loop open. The cleanup was
  attached only when a scheduler was injected.

  **`transitionTimeout` is documented for the first time, and the old description was
  wrong.** The budget is per individual action call — per hook, per guard, per invoke
  action — not per transition. So after the optimal-transition-set work, one microstep
  running N transitions × K hooks gets N×K independent deadlines and its total duration
  is not bounded at all (372 ms measured under a 100 ms budget). The previous JSDoc
  claimed a per-transition budget that "aborts the transition with an error", which was
  false for guards (silently disabled), for `errorState` (commits the error state) and
  for invoke actions.

  **BREAKING (`strictActions` only) — an unrecognized serialized action shape is no
  longer accepted in silence.** `deserializeAction` installed any object it did not
  recognize verbatim; a forged `{ source, name }` guard therefore became the guard, and
  `fireEvent` returned `false` forever with nothing thrown anywhere. Such a shape now
  warns, and under `strictActions` throws — matching what the adjacent unresolvable-
  identity branches already did. No shape `serializeActionRef` emits reaches that
  branch, so a normal `toJSON`/`fromJSON` round-trip is unaffected.

  **BREAKING for `checkMachine` / `./sim` consumers — running out of the harness's turn
  budget no longer fails a run.** A correct machine whose `onEnter` awaited a long but
  finite chain of microtasks was being reported as an RTC violation and a livelock: enter
  and exit hooks are deliberately not counted as in-flight async, so while one runs the
  settle fingerprint is frozen — indistinguishable from a wedged machine. The verdict was
  decided by exceeding an internal constant no option could raise. Budget exhaustion is
  now reported as one of two advisory warnings (`budget-progressing` when the machine was
  still moving, `budget-frozen` when it had already stopped) and never as a verdict. **A run that previously reported `ok: false` for this reason now reports
  `ok: true` with a warning.**

  **BREAKING for `checkMachine` / `./sim` consumers — `I-3` (run-to-completion) left the
  default oracle set.** The teeth were first left on the one non-budget witness,
  `WAITING_ON_INTERNAL`, on the grounds that the pump reaches it at its own early break
  rather than by running out of budget. That was wrong in the same way: the early break is
  a 16-turn frozen-fingerprint window instead of a 1024-turn one, and the fingerprint stays
  frozen across an entire ordinary microstep — a length that grows with the machine's own
  width, against a fixed constant. A parallel composite whose sibling region merely holds
  an armed timer was convicted for a _synchronous_ `onEnter`. `WAITING_ON_INTERNAL` is
  therefore now the advisory `rtc-unobserved` warning, which leaves `I-3` with no witness a
  real run can reach — so it is opt-in rather than an inert default. **A run that reported
  `ok: false` for it now reports `ok: true` with a warning.** The measured cost is zero:
  the zero-false-positive corpus that was cited as the guard for putting `I-3` in the
  default set never produced a single frame in the guarded branch. A genuinely hung machine
  is still surfaced by `transitionTimeout` and by the liveness plane's virtual-time budget.
  `WarningKind` also gained `lifecycle-truncated`, which previously reached consumers
  mislabelled as `residual-rejection`.

  **A restored machine keeps its behavioural options.** `transitionTimeout`, `errorState`,
  `abortOnExitError`, `maxQueueDepth` and `maxTransitionDepth` live on
  `StateMachineOptions`, not in the config, and were never serialized — so
  `fromJSON(json, owner)` returned a machine with no action deadline, no error state and
  no run-away bounds, silently. That bit hardest right after a restore, because
  `resumeTimers` re-arms persisted invoke timers whose actions then run unattended. Those
  five scalars are now carried in the payload under an `options` key and restored;
  explicit options passed at restore still win. Only values you supplied explicitly are
  recorded, so a machine constructed without them serializes byte-identically to before.

  The injection contracts — `logger`, `monitor`, `scheduler`, `errorHandler`,
  `contextTracker`, `clock` and the action registry — are still NOT serialized and must be
  re-supplied on every restore; they hold functions and host objects. `strictActions` is
  deliberately not persisted either: it governs how the payload's own function names are
  resolved, so honouring it from the document would let a document relax the rules it is
  read under.

  **BREAKING — `toJSON` / `toSecureJSON` throw while an `invoke` operation is in flight.**
  Previously they emitted a snapshot with the `src` dropped, and the restored machine sat in
  that state with nothing running: its `onDone` never arrived. A pending promise has no
  serializable continuation — that is a property of the JavaScript runtime, not a gap in this
  library, and no amount of waiting inside the library turns it into one. The refusal names
  the state and the invocation and states the two things you can actually do: wait for the
  operation to settle and serialize after, or leave the state (which aborts it) and serialize
  from there. It is scoped to the MOMENT, not the machine — a machine that merely declares an
  operation, or whose operation has already settled, serializes exactly as before. Reading is
  unchanged: an existing payload carrying an operation marker still loads.

  **Known issue — scoped to the per-action deadline.** `transitionTimeout` races a pending
  promise, and a pending promise cannot be resumed, so the elapsed portion is not
  persisted: a 5 s budget that had burned 4 s at save time restores as a full 5 s, and a
  machine saved and restored repeatedly can let one action exceed `transitionTimeout` in
  total wall-clock. The bound is per action _per run_. Invoke **delays** are unaffected and
  do resume correctly — they are recomputed from the persisted `stateEntryTimes`, so a
  1000 ms timer snapshotted 400 ms in fires 600 ms after the restore. A long-running
  `invoke.src` operation is not resumed either (its promise and `AbortSignal` do not
  survive); a fresh entry relaunches it.

  Alongside it: `maxTurns` is now a public option on both `SimOptions` and
  `CheckOptions` (default 1024), so the advice those warnings give is actionable;
  `LivenessParams.microtaskBudgetExhausted` is removed, because it cannot be fed from a
  truncated observation without recreating the false positive; and the DST trace header
  version moves to `'6'` (the construction-time and pre-fire drains now record why they
  did not settle, so a machine that wedges during construction is no longer invisible).
  Pinned `traceHash` values change accordingly.

- fdf6156: Lifecycle observability channel, W3C-conformant callback ordering (BREAKING), and object payloads for the dynamic check.

  **BREAKING — callback ordering now follows W3C SCXML §3.13.** Entry is ordered by
  document order (a DFS pre-order walk of the config); exit is the exact reverse.
  Two observable consequences:

  - sibling regions now run their `onExit` in **reverse** declaration order (`r3, r2, r1`);
    previously it was forward. This restores the LIFO property — the region that
    acquired a paired resource first releases it last.
  - a nested region is now traversed **contiguously** (its leaf, then that leaf's
    descendants, then the next region); previously a depth-major walk interleaved a
    sibling's leaf between an ancestor and its own descendant. This was invisible on
    flat parallel regions, where level-order and pre-order coincide.

  `exited.reverse()` is now exactly `entered`. The layer invariant (ancestors before
  descendants on entry, the mirror on exit) and the SET of invoked callbacks are
  unchanged — only their order. Migration: if any code depended on the previous
  sibling-exit order, invert that expectation.

  **New: `IMonitor.recordLifecycle?(event)` — a lifecycle observability channel.**
  An optional, additive monitor method. The engine emits a `begin`/`end` pair around
  every state hook (`onBeforeEnter`/`onEnter`/`onAfterEnter` and the exit trio), plus
  `invoke` and `guard` records. Each event carries `state`, `owner` (multi-owner
  machines stay separable), `microstep`, `seq`, and `failed`/`outcome`. A `begin`
  without its `end` is a **hung callback** — previously undiagnosable from outside.
  The channel is near-zero-cost when unsubscribed, its dispatch is wrapped in a sink
  guard (a throwing monitor cannot break the drain), and it changes no behaviour.

  **New: `createLifecycleTracer()` — a debugging instrument** over that channel.
  Pass it as `StateMachineOptions.monitor` (or `tracer.wrap(existingMonitor)`) and
  `format()` renders the callback timeline — order, nesting, per-microstep grouping,
  failures, hung callbacks, guard coverage. Helpers: `unfinished()`, `failures()`,
  `guardOutcomes()`, `byOwner()`, `byMicrostep()`. See `docs/lifecycle-tracing.md`.

  **`checkMachine` (dynamic check) gains:**

  - **object event payloads** — `EventSpec.payload(rng, snapshot)` values now reach
    guard/action callbacks verbatim, so argument-dependent transition branches become
    reachable. The generator draws from a forked stream, so runs without payloads
    reproduce byte-identically.
  - **`guardOutcomes`** — per transition, whether the guard was ever seen returning
    true / false (a guard that never returned true is the classic dead branch).
  - **`nonConvergingRegions`** — a parallel region that can never complete its join,
    either structurally (no final sub-state while the composite declares
    `done.state.<C>`) or empirically at a saturated coverage plateau.
  - **initial-configuration checking** — user invariants are now evaluated against the
    post-init configuration, so a machine that _starts_ in a violating state is caught.

  Performance: the composite-write hot path is now O(R) in region count (two former
  Θ(R²) scans linearised, behaviour preserved).

- A standing report for a machine that has gone quiet, an explicit way to release a row, and a state field holding a bare composite now works.

  **`machine.describeProgress()` — what is this machine standing on, right now.** When a
  machine goes quiet the useful question is not "is its run-to-completion contract broken"
  but "which callback is still open, for whom, and for how long". This answers it from a
  REPL against a machine nobody instrumented, because it reads counters the engine
  maintains whether or not anything is subscribed:

  ```
  onEnter at 'b' for owner #1 is open, and the engine has not advanced a phase since
  it was entered.

  Engine at tick 6, last advanced at micro.exit.
  Source: the engine's live entry/settle counters, not the lifecycle buffer.
  ```

  It deliberately never says stuck, hung or wedged: a slow `await` and a wedge produce the
  same snapshot, and a tool that guesses between them is a tool you argue with. Where a
  lifecycle tracer is also wired, the report reconciles the two sources and says which one
  a claim rests on. `getProgress()` returns the same data structurally.

  Underneath it, every user-supplied callable now goes through one instrumented dispatch
  point whose origin parameter is required, so a new call site cannot forget to report
  itself, and the engine emits a monotonic progress tick whose gap is constant in machine
  width — where the previous signal grew as `6N+5` in the number of parallel regions.

  **`machine.detachOwner(owner)` — tell the machine a row is released.** Driving many
  records through one machine, the loop is load → fire → save. Nothing told the machine
  when a row was released, so a timer armed for that row fired later and wrote into the
  released object: the database said `working`, the orphaned object said `timedOut`.
  Garbage collection does not help — it never cancels a scheduled timer, and the armed
  callback holds the row reachable anyway.

  `detachOwner` cancels that owner's timers, aborts its in-flight operations, drops its
  queued events (settling any awaiting caller rather than leaving it hanging) and cuts
  callbacks already suspended mid-action. It reports what it actually cut. Its history and
  entry times are dropped, and that is deliberate: every per-owner map keys on object
  identity, so a released row comes back as a new object and retained history would be
  unreachable by the only party who wants it.

  **FIX — a state field holding a bare composite name now works.** A row read from storage
  with `state: 'work'`, where `work` is a composite, was accepted as a valid state path and
  then behaved as though it had no regions: only transitions declared from `work` itself
  matched, and one declared from `work.r.stepA` never fired. Every write the machine
  performs — construction, a transition into the composite, `reset`, `restoreState` —
  already expanded such a value; only adopting a field written from outside did not, which
  is exactly how a row arrives from a database.

  Reads now complete it through the same code path the writes use. If your field carries a
  composite and one of its own descendants (`work|work.r.stepB`), the descendant wins — it
  is more specific, not in conflict — and the result no longer depends on the order the
  parts were serialised. A field naming two states that cannot be active together is now
  refused with a message naming the offending part, rather than silently keeping one of
  them.

  **New, opt-in: the `I-13` DST oracle** catches a queue left with nothing scheduled to
  drain it. It is a regression witness — no such state exists today — and it is opt-in
  rather than default, like every other run-to-completion check in this library, because
  the harness cannot in general distinguish a wedged machine from one doing legitimate work
  it cannot see. `docs/dynamic-check.md` states that boundary.

  Also: `IContextTracker` is exported from the `./sim` entry, which previously left a
  consumer unable to name the type of a seam they were expected to supply; `wire()` derives
  its forwarded seam set from the type rather than a hand-written list, so a new seam is
  forwarded by default instead of silently dropped.

- d649c48: Engine completion fix after `errorState` recovery, owner-explicit `*For` API, real teeth for the join oracle, and delta-debugging for `checkMachine`.

  **FIX (engine) — a composite could be `isDone()` without ever raising `done.state.<C>`.**
  When a transition failed and the machine recovered into an `errorState`, the recovery
  configuration was committed WITHOUT a completion check. If that configuration happened to
  be all-final, `isDone(C)` reported `true` while the `done.state.<C>` join event was never
  raised — so a completion handler waiting on the join silently never ran. Completion is a
  property of the COMMITTED configuration, not of the path taken into it, so
  `checkCompletion` now runs on the recovery path too. Recovery still stays recovery: the
  attempted transition is not recorded as successful (`fired:false` is unchanged), and the
  join stays edge-triggered (a recovery into a partially-final configuration raises nothing).

  **New: owner-explicit `fireEventFor` / `fireEventDetailedFor` / `canFireEventFor` /
  `getAvailableEventsFor`.** On a machine driving several objects, `fireEvent(event, obj)`
  is genuinely ambiguous — a second positional argument is indistinguishable from an event
  payload, so the call could silently resolve against the primary owner. The `*For` family
  takes the owner as the FIRST positional argument, which removes the ambiguity
  structurally rather than by guessing at the value's shape. A raw (non-adapted) object is
  accepted and normalized through a cache keyed by the object itself, so it keeps its own
  timers, invokes and history. `fireEvent` is deliberately unchanged — treating its second
  argument as an owner would break legitimate payloads. `canFireEvent` now normalizes a raw
  object too, instead of reading it as an adapter and returning nonsense.

  **New: `checkMachine({ shrink: true })` — delta-debugging of a found violation.** A
  violation is reported as a MINIMAL reproduction (a `script` you can paste back into
  `checkMachine`) rather than a full run. Reduction runs over the driven op stream against
  your live config, so closures, guards and object payloads survive intact. Every candidate
  is decided by an actual re-run: if the finding does not reproduce, the result is reported
  as `shrink-skipped` and the original run is kept — a minimal repro is never printed
  without having been verified.

  **Fix — false RTC alarm on a long chain of zero-delay invokes.** The simulation harness
  gives each macrostep a bounded pumping budget. A correct machine that chains ~40 or more
  `delay:0` invoke hops exhausted that budget and was reported as an RTC violation even
  though it reached its final state. The harness now distinguishes "the drain was still
  moving when the budget ran out" (`settleReason: 'budget-progressing'`, not a violation)
  from "the drain was stuck" (`'microtask-budget'`, still a violation). The discriminator is
  RECENCY, not "did it ever move": a legitimate hop's quiet gap is bounded by the pump's own
  stabilisation window (measured at 16 turns on the reference fixtures), while a wedged tail
  holds the observable fingerprint for hundreds — so a machine that makes progress and _then_
  wedges is still reported as wedged. This adds a member to `SettleReason` and bumps the DST
  trace header version to `'5'`.

  Two consequences on the report surface: a run that exhausts the budget while progressing now
  carries one advisory `budget-progressing` warning (never a verdict — raise `steps` to give
  the machine more total budget), and a genuinely wedged drain now also reaches the liveness
  verdict as `TIMEOUT_BUDGET_EXCEEDED` — that plumbing existed but had no producer. A
  zero-delay livelock that cycles forever is reported by the warning only, and deliberately
  so: it is provably indistinguishable from a correct machine whose loop is bounded past the
  budget horizon, because the deciding state (context fields, closure variables) appears in no
  observation channel. `docs/dynamic-check.md` documents the boundary.

  **The join oracle now has real teeth.** Previously it could not distinguish "no join was
  raised" from "a join was raised and matched nothing", so it was documented as a no-op. The
  engine's single internal raise point now reports each raise on the lifecycle channel, and
  the oracle counts join raises against observed completion edges. The set of oracles
  documented as no-ops is now empty.

## 1.0.0-beta.4

### Minor Changes

- Add a VOPR-style Deterministic Simulation Testing (DST) environment behind a new @unstable `./sim` entrypoint: seed-driven scenario generator, full 7-kind fault injection (reorder/drop/dup/overflow/clock-skew/timer-jitter/callback-throw), Safety + Liveness oracles, a delta-debugging shrinker with runnable repro, a perf-regression plane, and a mandatory capability-coverage CI gate. Core public API and bundle bytes unchanged.

## 1.0.0-beta.3

### Minor Changes

- f5a9f37: Add deterministic-testing (DST) support: an injectable `clock` and a virtual scheduler so consumers can drive invoke/after timers and replay state machines under virtual time, with zero impact on default behavior.

  - `StateMachineOptions.clock?: () => number` (default `Date.now`) — threads an injectable clock through `stateEntryTimes`, `resumeTimers`, and queued-event age math.
  - `createVirtualScheduler(clock)` — a new exported `ITimerScheduler` whose `isActive()` is always true (routes all invoke/after/`transitionTimeout` timers, never touching real `setTimeout`) and whose `process(now?)` drains due timers under virtual time.
  - `ITimerScheduler.process?(now?: number)` — optional manual-drain member.
  - An explicitly-provided scheduler is always used; the default path (no `clock`, no `scheduler`) stays byte-identical to prior releases.

  See the new "Deterministic testing (DST)" section in the README for the virtual-clock pattern.

## 1.0.0-beta.2

### Minor Changes

- 81b9859: SCXML/UML-correct composite & parallel regions: consistent ancestor-first entry, descendant-first exit, parallel-exit (LCCA) join matching, and a true all-regions-final join via `final` / `done.state.<id>` / `isDone()`.

  This is a feature + fix. The library has no external consumers yet, so behavior is optimized purely for SCXML/UML correctness rather than backward compatibility. Observable changes:

  - **Consistent region expansion across all entry paths.** A transition into a bare-root composite (e.g. `to: 'parent'`) now expands its regions into the parallel `|` configuration exactly like an initial-state or dotted-path entry, instead of staying bare. Region-child `onEnter` and per-leaf `invoke`/timers now fire on every entry path (initial, reset, dotted-composite transition, bare-root transition), not only on initial/reset.

  - **Ancestor-first entry, descendant-first exit (SCXML order).** Entering a configuration now fires a composite parent's `onEnter` before its region children's `onEnter`; leaving fires region children's `onExit` before the parent's `onExit`. Entry runs ancestors-before-descendants and exit runs the reverse, never exiting a state that remains in the active configuration (a shared active ancestor across a re-entry is neither re-entered nor re-exited, so its `invoke` timer is not re-armed or leaked). The same ancestor-first ordering now applies uniformly to `setInitialState` (construction) and `reset()`.

  - **Parallel-exit / join matching from a composite parent (LCCA).** `isTransitionPossible` now matches `from: '<composite-parent>'` against the expanded active configuration via an ancestor scan (a `from` part matches when it equals OR is an ancestor of any active leaf), reproducing SCXML source-in-active-configuration eligibility. Exact-leaf `from` and `from: '<parent>.<region>'` keep matching, and multi-part `from` still requires every part. `canFireEvent`/`getAvailableEvents` share this chokepoint, so introspection matches dispatch.

  - **All-regions-final join (UML join).** New optional `State.final?: boolean` marks the final pseudo-substate of a region. A composite `C` is _done_ when every region's active atomic leaf is final (recursively, via the static regions tree, not a config-map lookup). A region whose active child is itself a nested parallel composite is _done_ iff that nested composite is all-final — a single parallel branch carrying `final` does not finalize the region. The join is authored EITHER as a transition on the engine event `done.state.<C>` (recommended; only enqueued at all-final) OR guarded by `() => sm.isDone('C')`. Disambiguation is by trigger, not by `from`: a plain `from: 'C'` user event is ANY-leaf parallel-exit (eligible whenever any region is active), while `done.state.<C>` fires only at all-final. The synthetic `done.state.*` event is excluded from the `*` wildcard fallback and is emitted only when a matching `done.state.<C>` event is declared (no Invalid-event crash). `done.state.<C>` is **edge-triggered** (SCXML): raised once when the done configuration is _entered_, not re-raised while `C` merely stays all-final across an unrelated (e.g. sibling-region) transition; it is raised again if `C` leaves and later re-enters its done configuration. When several composites become done on one transition, nested composites emit innermost-first (depth-ordered).

  - **New `@stable` public surface.** `State.final?: boolean` and `StateMachine.isDone(compositeId, adaptee?): boolean` are added to the public API (reflected in `etc/statemachine.api.md`), plus the engine-generated `done.state.<id>` event.

  - **`isInState` and `getCurrentStateInfo` on region-roots.** `isInState('C')` and `isInState('C.region')` now return `true` while the composite is active in its expanded form (every expected `|`-part is equal-to-or-an-ancestor-of some active leaf). `getCurrentStateInfo` on a region-root now reports the expanded shape: `regions` as dotted region keys and `children` as the active leaves.

  - **Validator rules.** New diagnostics for `final`/`done.state` configurations: `FINAL_STATE_HAS_OUTGOING` (error), `FINAL_ON_COMPOSITE`, `REGION_NO_REACHABLE_FINAL`, `DONE_VS_PARALLEL_EXIT_AMBIGUITY`, and the advisory `REGION_MISSING_INITIAL` (`valid: true`). Final leaves no longer trigger spurious `UNREACHABLE_STATE`/`UNUSED_EVENT` warnings.

  History, persistence, and serialization are unchanged: they pass the stored (now consistently expanded) configuration string through verbatim and re-arm one `invoke` timer per active region leaf on restore; a non-final restored configuration emits no `done.state`.

## 1.0.0-beta.1

### Patch Changes

- Initial 1.0.0-beta.0 publish — Phase 1 baseline of @vedmalex/statemachine standalone monorepo.

  This release establishes the public-surface contract of the lite-only DI-free state machine library. Includes:

  - Strict TypeScript public API (5 firm @stable symbols: createMachine, StateMachine, StateMachineConfig, Transition, State)
  - 7 extension-point interfaces (@unstable): IMonitor, ITimerScheduler, IErrorHandler, ILogger, StatePersistenceAdapter, TransitionContext, MonitorMetricsSnapshot
  - ESM + CJS dual emission via tsup; api-extractor surface ratchet at etc/statemachine.api.md
  - Comprehensive vitest test suite with ≥90% coverage across all 4 metrics
  - TypeDoc HTML docs published to GitHub Pages
  - 3 integration examples (custom-adapter, observability-injection, persistence-adapter)
  - Multi-runtime CI: Bun + Node 18 + Node 20 (Tier A blocking) + Deno + Browser (Tier B allowed-fail)
  - Changesets release flow with manual workflow_dispatch trigger
  - This package is a standalone fork of an internal state-machine module, refactored to remove framework-coupling. It ships only the dependency-free public surface.

  See CHANGELOG.md and STABILITY.md for the full surface contract.
