---
'@vedmalex/statemachine': minor
---

The library now loads outside Node; failing `invoke` actions stop being silent; and the dynamic check no longer fails a run over its own turn budget.

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
an armed timer was convicted for a *synchronous* `onEnter`. `WAITING_ON_INTERNAL` is
therefore now the advisory `rtc-unobserved` warning, which leaves `I-3` with no witness a
real run can reach — so it is opt-in rather than an inert default. **A run that reported
`ok: false` for it now reports `ok: true` with a warning.** The measured cost is zero:
the zero-false-positive corpus that was cited as the guard for putting `I-3` in the
default set never produced a single frame in the guarded branch. A genuinely hung machine
is still surfaced by `transitionTimeout` and by the liveness plane's virtual-time budget.
`WarningKind` also gained `lifecycle-truncated`, which previously reached consumers
mislabelled as `residual-rejection`.

Alongside it: `maxTurns` is now a public option on both `SimOptions` and
`CheckOptions` (default 1024), so the advice those warnings give is actionable;
`LivenessParams.microtaskBudgetExhausted` is removed, because it cannot be fed from a
truncated observation without recreating the false positive; and the DST trace header
version moves to `'6'` (the construction-time and pre-fire drains now record why they
did not settle, so a machine that wedges during construction is no longer invisible).
Pinned `traceHash` values change accordingly.
