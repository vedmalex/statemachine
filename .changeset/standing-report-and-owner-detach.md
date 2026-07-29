---
'@vedmalex/statemachine': minor
---

A standing report for a machine that has gone quiet, an explicit way to release a row, and a state field holding a bare composite now works.

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
