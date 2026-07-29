# Persistence — three mechanisms, and how to choose

A machine is defined in code. What varies at runtime is *which state a particular
thing is in*. That distinction is the whole of this page: most of the time you are
carrying around the **state of a machine**, not the machine **object**, and only one
of the three mechanisms below carries the object.

Pick by asking one question: **what has to survive?**

| what has to survive | mechanism | what it carries |
| --- | --- | --- |
| one entity's current state, alongside the entity itself | the `stateAttribute` field + the `*For` family | the state IS a field on your record — nothing extra, but see [the boundary](#the-boundary-what-the-record-does-not-carry) |
| one machine's runtime across a process restart | `StatePersistenceAdapter` (`saveState` / `restoreState`) | `currentState`, `history`, `stateEntryTimes` |
| the machine **definition** itself | `toJSON` / `fromJSON` | the full config, plus the primary owner's runtime |

## 1. State on the record — the default, and usually the answer

The machine reads and writes state through an `Adapter`, in the field named by
`stateAttribute`. So an entity carries its own state, and persisting it is whatever
you already do with that entity — a column, a document field, nothing special.

For many entities, use one machine and the owner-explicit calls:

```ts
const sm = createMachine<Order>(orderConfig)   // no construction owner needed

for (const order of await db.orders.findDue()) {
  // Over records in mixed states, "nothing to do here" is the normal case — and
  // `fireEventFor` THROWS when no transition matches. Use the detailed form.
  const res = await sm.fireEventDetailedFor(order, 'approve')
  if (res.fired) await db.orders.save(order)   // `order.state` IS the persisted state
}
```

One machine instance, N records. There is no serialization in this loop, and
nothing per-record to store beyond the state field.

### The boundary: what the record does not carry

Not everything about a record's position lives in the record. Five kinds of per-owner
runtime are held on the machine in `WeakMap`s keyed by the record **object** — the
history recorded for `history` states, state entry times, armed `invoke` timers,
in-flight `invoke` operations, and invoke restart counts. None of it is in the state
field, and a `toJSON` snapshot does not contain it either unless that record happens to
be the machine's primary owner.

A machine built from plain states, guards and transitions has none of this runtime: it
is fully described by its state field and the loop above is exact. A machine that uses
**`history` states or `invoke`** — either form, the delay/`event` timer or the
long-running `src` operation — keeps runtime the loop does not carry, and the loss is
silent: you observe wrong behaviour, never an error. There are two distinct traps, and
they pull in opposite directions.

#### Trap 1 — timers write into rows you already released

An `invoke` timer armed on entry fires on its own schedule, finds its leaf still active
in the object it closed over, and writes a new state into a row the loop saved and moved
past. The database says `working`, the orphaned object says `timedOut`, nothing is
raised. A long-running `invoke.src` operation does the same when its completion event
arrives.

The timer firing late is not the defect — that is what a timer is. The defect is that
nothing told the machine the row had been released. `detachOwner` is how you say it:

```ts
for (const row of page) {
  const res = await sm.fireEventDetailedFor(row, 'submit')
  if (res.fired) await save(row)
  sm.detachOwner(row)   // released — no timer of this row's may fire now
}
```

`detachOwner(owner)` cancels that owner's armed timers, aborts its in-flight operations,
drops any event already queued for it, and drops its per-owner maps. The queue matters
because a timer that fires raises its event and schedules the drain as a *microtask*:
cancelling the timer cannot help an event that already left it. A dropped event is never
left pending — `fireEventDetailedFor` resolves `{ fired: false, reason: 'aborted' }` and
`fireEventFor` resolves `false`, rather than either hanging or throwing.

It accepts a raw object or an `Adapter`, exactly as the `*For` family does; it is
idempotent; and it returns an `OwnerDetachResult` — `{ timersCleared,
operationsAborted, queuedEventsDropped }` — so a log line can say what was actually
released.

What it deliberately does not do: it never touches the `stateAttribute` field (the
position you saved is the machine's last word on that row), it does not clear the
construction owner from the machine, and it does not undo `attachToObject`'s listeners.

**Garbage collection is not a substitute.** The per-owner maps are `WeakMap`s, so it is
tempting to think dropping the object is enough. It is not, and the maps are the part
that needs no help. GC never cancels a scheduled timer and never aborts an operation —
and until both happen the owner is not even collectable, because the armed callback
holds a strong reference to it. Dropping the history / entry-time / restart-count maps
is the one thing GC would have done unaided; `detachOwner` merely does it immediately.

**Without `detachOwner`, `load → fire → save` is unsupported for a timer-arming
machine.** The alternative is to hold those owners resident for as long as their timers
can fire, and save again after they have drained.

#### Trap 2 — history does not survive a reload

History is keyed on object identity. Load a row, advance it, release the object, then
reload the row as a fresh object, and the history keyed to the old one is gone.
Re-entering a `history` composite falls back to its `initial`, and any sibling regions
the composite remembered go with it — so the machine re-enters a *narrower*
configuration than it left.

`detachOwner` does not rescue this one; it drops the history too, and on purpose. A
released row is reloaded as a *new* object, so history kept against the old one is
unreachable by the only party that would want it — retaining it would be a per-owner
leak that is by construction unusable. Detach makes the loss immediate and honest
instead of dependent on when the object happens to be collected.

The real answer for history is the opposite of trap 1: keep the **same** object resident
for the whole batch rather than reloading it, and history is exact, per record and
independent between records. A machine that needs both history and timers wants resident
owners, not a `load → fire → save` loop.

## 2. `StatePersistenceAdapter` — the machine's runtime, without its definition

`saveState` / `restoreState` move exactly `{ currentState, history, stateEntryTimes }`
for the primary owner. No config, no actions, no options.

This is the right tool when the machine is defined in code and you want its runtime
to survive a restart. The definition comes back from your source, the position comes
back from storage. It is the smallest thing that works, and nothing in it can go
stale against a code change except the state names themselves.

`restoreState` adopts a position rather than re-entering it: a stored `currentState`
naming a bare composite is completed to that composite's `initial` configuration, and no
`onEnter` runs for what it completed into. Armed invoke *delays* are then resumed from
the restored `stateEntryTimes` (see below).

## 3. `toJSON` / `fromJSON` — when the *definition* must travel

This is the only mechanism that carries the config. It is also the heaviest: every
snapshot embeds the entire machine description — all states, all events, all action
references.

Two properties decide when it is appropriate, and both surprise people:

**Actions travel as names, never as bodies.** A function is serialized as a
reference resolved on restore through a registry the caller supplies. Nothing is ever
compiled from the payload — that is a deliberate security property, not an
implementation detail. The practical consequence: a snapshot is **not
self-contained**. Whoever restores it must already have the functions.

**The snapshot is primary-owner-only.** `currentState`, `history` and
`stateEntryTimes` come from the construction owner. A machine driving many records
through the `*For` family does not capture those records — and the reverse bites too:
`fromJSON(json, row)` **writes** the payload's `currentState` onto whatever object you
hand it, overwriting the state that row was actually in. The owner argument is where the
snapshot is restored *to*, not a record whose own position is respected.

Given both, the legitimate cases are narrower than "persist a machine":

- **The config is assembled at runtime** — from a database, a tenant configuration,
  a user-built workflow — so it cannot be re-derived from source. The actions come
  from a fixed registry; only the shape is dynamic. This is the strongest case, and
  the one the mechanism is really for.
- **A self-contained reproduction** — capturing a machine exactly as it was for a bug
  report, a regression fixture, or a simulation checkpoint, to be reloaded by the same
  codebase.
- **Pinning a definition against code drift** — archiving what the machine looked like
  at a point in time, for audit, when the source will keep changing.

And the cases it does *not* serve, each of which has a better answer above:

- per-record state for many records → the state field (§1);
- surviving a restart with a config that lives in code → `StatePersistenceAdapter` (§2);
- shipping a machine to a process that does not have the code → does not work, because
  that process still needs the action registry.

## What does not survive a restore, in any mechanism

- **A per-action deadline.** `transitionTimeout` races a pending promise, and a pending
  promise cannot be resumed, so the elapsed portion is not persisted: a 5 s budget with
  4 s burned restores as a full 5 s. The bound is per action *per run*.
- **A long-running `invoke.src` operation.** Its promise and `AbortSignal` do not
  survive. What happens on the next entry into the state depends entirely on whether you
  supplied an action registry — see "Reading is unaffected" below.

**Invoke delays are different and do resume correctly.** They are recomputed from the
persisted `stateEntryTimes`: a 1000 ms timer snapshotted 400 ms in fires 600 ms after
the restore.

## A machine cannot be serialized while an `invoke` operation is running

`toJSON` and `toSecureJSON` **throw** if an `invoke` operation is in flight for the
primary owner, naming the state and the invocation:

```
Cannot serialize with toJSON(): an invoke operation is in flight.
  state "fetching" — src "fetchUser"
```

The reason is one sentence: a pending promise has no serializable continuation — this
runtime cannot capture a suspended computation, so neither the promise nor the
`AbortSignal` it runs against can be written into a payload or rebuilt from one. The
snapshot would restore into a machine sitting in `fetching` with nothing running, whose
`onDone` never arrives. Since that is indistinguishable from a hang, the write fails
instead of succeeding into one.

You decide when to save, so either of these works:

- **Wait for the operation, then serialize.** You already `await` your own work; the
  machine is serializable again the moment nothing is running.
- **Abort it by leaving the state, then serialize.** The machine aborts a leaf's
  operations on exit, so the state you land in is snapshot-clean immediately — no
  waiting out an operation you were going to discard.

The refusal is about the **moment**, not about the machine. A config that merely
declares an operation serializes fine, and so does a machine whose operation has already
settled — even while it is still sitting in the invoking state. Only the in-flight
instant is refused.

**Reading is unaffected, but the registry decides what the operation does next.** A
payload that already carries an operation marker (`{ type: 'operation', slot, name }` —
the `src` itself is dropped on write) always loads. Neither case *resumes* the operation:
resumption recomputes a remaining delay, and an operation has none.

- **With an action registry** that supplies the marker's `name`, the `src` is re-linked
  silently — no warning — and the next entry into the state launches it normally.
- **Without one**, the marker is not a runnable invocation and not a timer either: entry
  logs `invoke operation not serializable; skipping non-resumable invoke on entry` and
  launches nothing. A state whose only exit is that operation's `onDone` is then
  terminal. This is the case to watch for; it is silent apart from the warn.

Existing stored data keeps working; the write-side refusal above is the only change.

## Injection contracts are never persisted

`logger`, `monitor`, `scheduler`, `errorHandler`, `contextTracker`, `clock` and the
action registry hold functions and host objects. They are not in any payload and must
be supplied again on every restore. Behavioural scalars — `transitionTimeout`,
`errorState`, `abortOnExitError`, `maxQueueDepth`, `maxTransitionDepth` — *are* carried
in a `toJSON` payload, so a restored machine behaves like the one that was saved;
options passed explicitly at restore still win.
