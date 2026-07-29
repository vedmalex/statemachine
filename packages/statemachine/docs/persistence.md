# Persistence — three mechanisms, and how to choose

A machine is defined in code. What varies at runtime is *which state a particular
thing is in*. That distinction is the whole of this page: most of the time you are
carrying around the **state of a machine**, not the machine **object**, and only one
of the three mechanisms below carries the object.

Pick by asking one question: **what has to survive?**

| what has to survive | mechanism | what it carries |
| --- | --- | --- |
| one entity's current state, alongside the entity itself | the `stateAttribute` field + the `*For` family | nothing extra — the state IS a field on your record |
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

**The boundary.** Not everything about a record's position lives in the record. Per
owner, the machine also keeps history for history states, state entry times, armed
timers and in-flight `invoke` operations — held in memory, keyed by the record
object. Release the record object and those are gone; they are not in the state
field, and a `toJSON` snapshot will not contain them either unless that record
happens to be the machine's primary owner.

So: a machine built from plain states, guards and transitions is fully described by
its state field, and this pattern is clean. A machine that uses **`history` states or
`invoke`** — either form, the delay/`event` timer or the long-running `src` operation —
keeps per-record runtime that this pattern does not carry, and the loss is silent,
visible only as wrong behaviour later. Keeping the *same* record object for the whole
batch, rather than reloading it, preserves the history; it does not help with timers,
which fire after the loop has already saved the row. See "Driving several objects with
one machine" in the README for the full treatment.

## 2. `StatePersistenceAdapter` — the machine's runtime, without its definition

`saveState` / `restoreState` move exactly `{ currentState, history, stateEntryTimes }`
for the primary owner. No config, no actions, no options.

This is the right tool when the machine is defined in code and you want its runtime
to survive a restart. The definition comes back from your source, the position comes
back from storage. It is the smallest thing that works, and nothing in it can go
stale against a code change except the state names themselves.

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
through the `*For` family does not capture those records.

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
  survive; a fresh entry into the state relaunches it.

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

**Reading is unaffected.** A payload that already carries an operation marker still
loads: without an action registry it loads with a warn, with one the `src` is re-linked
silently. Either way the operation is not resumed — only a fresh entry into the state
launches it. Existing stored data keeps working; the change is on the write side only.

## Injection contracts are never persisted

`logger`, `monitor`, `scheduler`, `errorHandler`, `contextTracker`, `clock` and the
action registry hold functions and host objects. They are not in any payload and must
be supplied again on every restore. Behavioural scalars — `transitionTimeout`,
`errorState`, `abortOnExitError`, `maxQueueDepth`, `maxTransitionDepth` — *are* carried
in a `toJSON` payload, so a restored machine behaves like the one that was saved;
options passed explicitly at restore still win.
