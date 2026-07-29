---
'@vedmalex/statemachine': minor
---

Engine completion fix after `errorState` recovery, owner-explicit `*For` API, real teeth for the join oracle, and delta-debugging for `checkMachine`.

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
holds the observable fingerprint for hundreds — so a machine that makes progress and *then*
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
