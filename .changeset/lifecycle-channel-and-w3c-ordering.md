---
"@vedmalex/statemachine": minor
---

Lifecycle observability channel, W3C-conformant callback ordering (BREAKING), and object payloads for the dynamic check.

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
  post-init configuration, so a machine that *starts* in a violating state is caught.

Performance: the composite-write hot path is now O(R) in region count (two former
Θ(R²) scans linearised, behaviour preserved).
