# @vedmalex/statemachine

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
