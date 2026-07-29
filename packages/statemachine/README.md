# @vedmalex/statemachine

[![CI](https://github.com/vedmalex/statemachine/actions/workflows/ci.yml/badge.svg)](https://github.com/vedmalex/statemachine/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@vedmalex/statemachine?label=npm)](https://www.npmjs.com/package/@vedmalex/statemachine)

Hierarchical state machine for TypeScript with orthogonal (parallel) regions, SCXML/UML entry-exit semantics, monitoring, validation, and persistence.

**Features:**

- Hierarchical (nested) states addressed by dotted paths
- Orthogonal **parallel regions** with W3C SCXML §3.13 callback ordering — entry in document order, exit in reverse document order
- **UML all-regions-final join** via `final` states, the engine-raised `done.state.<id>` event, and the `isDone()` guard
- Parallel-exit (LCCA) — a transition from a composite parent preempts and exits all active regions
- Guards, before/enter/after + exit/transition actions, and `invoke` in both forms — a delayed timer that raises an event (`InvokeTimer`), and a long-running operation with an `AbortSignal` and `onDone` / `onError` events (`InvokeOperation`)
- A lifecycle observability channel (`IMonitor.recordLifecycle`) and `createLifecycleTracer()` over it, which names hung and failed callbacks
- Pluggable monitoring, validation, persistence, timer scheduling and async-context tracking
- ESM + CJS dual bundle; DI-free lite surface

The package ships only the DI-free lite surface. The legacy DI-aware factory from `@grainjs/statemachine` is intentionally not carried over.

Upgrading from an earlier beta: [Breaking changes in 1.0.0-beta.5](#breaking-changes-in-100-beta5).

## Install

```
bun add @vedmalex/statemachine
# or
npm install @vedmalex/statemachine
```

## Quick start

```ts
import { createMachine } from '@vedmalex/statemachine'

// The owner object holds the current state under `stateAttribute` ('state').
const door = { state: 'closed' }

const sm = createMachine(
  {
    name: 'door',
    stateAttribute: 'state',
    initialState: 'closed',
    states: { closed: {}, open: {} },
    events: { open: { transitions: [{ from: 'closed', to: 'open' }] } },
  },
  door,
)

await sm.fireEvent('open')
console.log(sm.currentState) // 'open'
```

`initialState` and every transition `from` / `to` are typed against the state
keys you declare: a typo such as `initialState: 'closd'` or `to: 'opn'` is a
compile-time error. See [`types/`](./types) for the emitted declarations.

## Hierarchical regions, parallel states & join

A state may declare `regions` to run several orthogonal sub-machines at once. Entry/exit follow SCXML/UML ordering, and a region may complete via a `final` state that raises a `done.state.<id>` join event.

```ts
const proc = { state: 'proc' }

const sm = createMachine(
  {
    name: 'proc',
    stateAttribute: 'state',
    initialState: 'proc',
    states: {
      proc: {
        initial: 'a.run|b.run',          // both regions active in parallel
        onEnter: () => {/* parent runs BEFORE region children (document order) */},
        regions: {
          a: { run: {}, done: { final: true } },
          b: { run: {}, done: { final: true } },
        },
      },
      complete: {},
    },
    events: {
      finishA: { transitions: [{ from: 'proc.a.run', to: 'proc.a.done' }] },
      finishB: { transitions: [{ from: 'proc.b.run', to: 'proc.b.done' }] },
      // Join: raised automatically once EVERY region reached a `final` state.
      'done.state.proc': { transitions: [{ from: 'proc', to: 'complete' }] },
    },
  },
  proc,
)
```

- **Expansion** — entering `proc` (as initial state *or* via a transition) expands to the parallel configuration `proc.a.run|proc.b.run`.
- **Ordering** — **entry follows document order** (a DFS pre-order walk of the config: `proc`, then region `a` and everything under it, then region `b`); **exit follows the exact reverse of document order** (region `b`'s states, then region `a`'s, then `proc`). This is W3C SCXML §3.13 verbatim, and it implies both the ancestor-first/descendant-first layering and the sibling-region sequence. See [docs/regions-and-parallel.md](./docs/regions-and-parallel.md#3-entryexit-ordering-scxml-313).
- **Parallel-exit** — a plain transition `from: 'proc'` on a user event preempts and exits all active regions immediately (LCCA).
- **Join** — when all regions are `final`, the engine raises `done.state.proc`; `sm.isDone('proc')` reflects the all-final configuration. (`done.state.*` is never matched by a `from: '*'` wildcard.)

Author the join either as the `done.state.<id>` transition above, **or** as a guard on any event:

```ts
events: {
  tryFinish: {
    // fires only once every region of `proc` has reached a `final` state
    transitions: [{ from: 'proc', to: 'complete', guard: () => sm.isDone('proc') }],
  },
}
```

Composites nest: a parent's `done.state` is raised only after every region — **including any nested composite** — is final, innermost-first. `done.state.<id>` is edge-triggered (raised once on entering the done configuration, not re-raised while the composite merely stays all-final).

See [`docs/regions-and-parallel.md`](./docs/regions-and-parallel.md) for the full model, ordering rules, nesting, and validation.

## Action timeouts (`transitionTimeout`)

`StateMachineOptions.transitionTimeout` is a **per-action** budget, not a per-transition or per-microstep one. Every individual action call races its own deadline: guards, `onBefore` / `onAfter`, the `onExit` / `onEnter` state hooks, `onTransition`, and `invoke` actions.

**The consequence to budget for.** One event fires one transition **per region** in a single microstep (see [Hierarchical regions, parallel states & join](#hierarchical-regions-parallel-states--join)), and each of those transitions runs its own hook chain. A microstep of N transitions × K hooks therefore gets N×K *separate* deadlines, and `transitionTimeout` does **not** bound the microstep's total duration — three regions running three 40 ms hooks each complete in ~370 ms under a 100 ms `transitionTimeout`. Read the option as "no single callback may hang longer than this", never as "an event settles within this".

On expiry the call rejects with `StateMachineError('Transition timeout')` (`context.phase === 'action'`). The timed-out action is **not** cancelled — it runs to completion and its side effects still land, after the machine has already unwound. What you observe depends on which hook expired:

| expired hook | observable outcome |
| --- | --- |
| `guard` | transition disabled; `fireEvent` resolves `false`, nothing thrown |
| `onEnter`, with `errorState` set | machine commits `errorState`; `fireEvent` resolves `false` |
| `onExit`, with `abortOnExitError` set | microstep aborts back to the source state; `fireEvent` resolves `false` |
| `invoke` action (the timer form's `action`) | the invoke's `event` is **not** raised and the machine stays put, but the expiry is reported: `monitor.recordError` and the config-level `onError` both receive the `StateMachineError` (`context.phase === 'action'`). Nothing is thrown — the invoke timer callback has no caller to catch it |
| anything else (`onBefore`, `onTransition`, `onEnter` / `onExit` without the options above) | the error propagates out of `fireEvent`; the machine stays in the source state |

An `invoke` action that **throws** takes exactly that same route, on a freshly armed timer and on one resumed from a snapshot alike: an expiry is simply one more way the action failed, and the two are distinguishable only by the error you receive, never by where it arrives or by what the machine does next. (The `recordError` channel is gated by `IErrorHandler.isEnabled()`, which defaults to enabled. Long-running `invoke` **operations** — the `src` / `onDone` / `onError` form — keep their own routing instead: a declared `onError` event wins, and only without one does the rejection fall through to `recordError`.)

The deadline timer is cancelled as soon as the race settles, on the default scheduler as well as an injected one (see [Deterministic testing](#deterministic-testing-dst)), so a fast action leaves nothing pending behind it.

## Driving several objects with one machine

A machine is a *description*; the thing that has a state is the owner object, which
holds it in the field named by `stateAttribute`. So one machine instance can drive any
number of owners at once — a table of rows, a pool of sessions — and each owner's
position is written back into that owner, through the `Adapter`. This is the mechanism
to reach for when you have many records and one workflow; it is not what `toJSON`
is for (see [Serialization](#serialization-tojson--fromjson)).

`fireEvent` cannot express a second owner unambiguously: a non-`Adapter` second
positional is an event **argument** — that is what makes `fireEvent('submit', payload)`
work — so a raw object passed as an owner is read as a payload and the event resolves
against the machine's primary owner instead. (When it is a *different* object carrying
the machine's `stateAttribute` — the tell-tale shape of the mistake — the engine warns
through its `logger`; passing the machine's own owner back in is the correct common
pattern and stays quiet. The argument is forwarded verbatim either way, so a payload
that happens to have the field keeps working.)

The `*For` family resolves the ambiguity structurally rather than by sniffing:
**slot 1 is always the owner**, everything after the event name is always an
argument.

```ts
const a = { state: 'idle' }
const b = { state: 'idle' }
const sm = new StateMachine(config, a)

await sm.fireEventFor(b, 'go')                     // moves b; a is untouched
await sm.fireEventFor(b, 'submit', { ok: true })   // owner first, then the args
await sm.fireEventDetailedFor(b, 'go')             // → FireResult
sm.canFireEventFor(b, 'go')                        // → boolean, for b
sm.getAvailableEventsFor(b)                        // → string[], for b
```

A **raw object is accepted** — no `MemoryAdapter` ceremony — and is wrapped
internally, once per object. Because every per-owner structure keys on the adaptee,
the object keeps its own state, timers, `invoke`s and history whether you hand over
the object or an `Adapter` for it.

One caveat worth knowing before you rely on that. Which *position* holds the owner
is structural, but whether the value in it is already an `Adapter` is a duck test:
`isAdapter` asks only for `get` and `set`. A domain object that happens to expose
methods by those names is therefore taken *as* an adapter and driven through its own
`get('state')` / `set('state', …)` rather than through a `MemoryAdapter` over its
properties — the state lands somewhere you did not intend and nothing is thrown. If
your owner type has its own `get`/`set`, wrap it explicitly:
`sm.fireEventFor(new MemoryAdapter(owner), 'go')`.

`fireEvent` itself is unchanged. `canFireEvent(event, obj)` now normalizes a raw
object like the `*For` family does, instead of reading it as an adapter and
returning an answer about a state it was never in.

### A batch over a table

Build the machine once, then walk the records: load, fire, save. The `state` column
**is** the persisted machine state — there is nothing else to write back, and no
snapshot is involved. A machine driven only through the `*For` family needs no
construction owner at all.

```ts
type Order = { id: number; state: string }

const sm = createMachine<Order>({
  name: 'order',
  stateAttribute: 'state',
  initialState: 'draft',
  states: { draft: {}, review: {}, published: {} },
  events: {
    submit: { transitions: [{ from: 'draft', to: 'review' }] },
    approve: { transitions: [{ from: 'review', to: 'published' }] },
  },
})

for (let offset = 0; ; offset += 500) {
  const page = await loadPage(offset)   // → Order[]
  if (page.length === 0) break
  for (const row of page) {
    // Over a table of mixed states, "this row has nothing to do" is the normal
    // case, not an error — and `fireEventFor` THROWS when no transition matches.
    // The detailed form reports it instead: { fired: false, reason: 'no-transition' }.
    const res = await sm.fireEventDetailedFor(row, 'submit')
    if (res.fired) await save(row)      // row.state now holds the new state
  }
}
```

`canFireEventFor(row, 'submit')` answers the same question without running the
transition, and `getAvailableEventsFor(row)` lists what that row could do next.

Two things to get right about the column:

- It holds the machine's **active configuration verbatim** — a dotted leaf path, and
  for parallel regions the `|`-joined set (`proc.a.run|proc.b.run`). Store back what
  the engine wrote; do not normalize or shorten it.
- A row driven through the `*For` family is read **as it stands**. A composite parent
  name is *not* expanded to its `initial` leaf: a row reading `proc` offers only the
  transitions declared from `proc` itself, and one declared from `proc.a.run` will not
  match it. Seed a new row with the configuration a fresh machine enters, not with the
  parent name. (Only the *construction* owner is expanded — `new StateMachine(config, row)`
  descends into `initial` and writes the leaf path back into `row`.)

### The per-record runtime that does not live in the record

The `state` field is not the whole story. Five kinds of per-owner runtime are held on
the machine in `WeakMap`s keyed by the owner object itself, and so live in process
memory only: the history recorded for `history` states, state entry times, armed
`invoke` timers, in-flight `invoke` operations, and invoke restart counts. None of it
is in the record, and none of it is in a `toJSON` snapshot either — that snapshot
covers the construction owner alone.

Which side of the line you are on is decided by the config:

- A machine of plain states, guards and transitions has **no** such runtime. The record
  is fully self-describing, one machine over any number of records is exact, and a row
  can be loaded, advanced and released freely.
- A machine that uses `history` states or `invoke` (either form — the delay/`event`
  timer or the long-running `src` operation) does have it, keyed on **object identity**.

Both failure modes are silent. You observe wrong behaviour, not an error:

- **History.** Load a row, advance it, release the object, then reload the row as a
  fresh object, and the history keyed to the old object is gone. Re-entering a
  `history` composite falls back to its `initial` — and any sibling regions the
  composite remembered are gone with it, so the machine re-enters a *narrower*
  configuration than it left. The workaround is real but narrow: keep the **same**
  object for the whole batch rather than reloading it, and history is exact, per
  record and independent between records.
- **Timers.** An `invoke` timer armed on entry fires later, on its own schedule, and
  writes into the object that armed it — after your loop has already saved that row.
  Keeping the object alive does not fix this one: the write lands in memory and the row
  is never persisted unless you drain the timers and save again. `load → fire → save`
  is the wrong shape for a machine whose states arm timers; hold those owners resident
  for as long as their timers can fire.

There is no snapshot-based escape from either: `toJSON`, `saveState`, and the timer
resumption `fromJSON` performs all read and write the construction owner alone.

## Serialization (`toJSON` / `fromJSON`)

`toJSON()` writes a machine to a string; `fromJSON(json, owner, options?)` reads one back. `toSecureJSON()` / `fromSecureJSON()` are the async forms and carry exactly the same thing.

`toJSON` and `toSecureJSON` **throw while an `invoke` operation is in flight**, naming the
state and the invocation. A pending promise has no serializable continuation, so a snapshot
taken then would restore into a machine that looks busy and is running nothing: the
completion event that would have moved it on never arrives. Wait for your operation and
serialize after it, or leave the state — which aborts it — and serialize from there. A
machine that merely *declares* an operation, or whose operation has already settled,
serializes normally: the refusal is about the moment, not about the machine. See
[docs/persistence.md](./docs/persistence.md).

**This moves or restores a machine; it does not carry a record's state.** The payload is
a machine *description* plus one owner's position in it — `config` (every state and
event, functions reduced to name references), the behavioural `options`, and then
`currentState`, `historyMap` and `stateEntryTimes` **for the construction owner only**.
Two consequences make it the wrong tool for a table of records. The config dominates the
payload — already about three quarters of the bytes on a trivial three-state machine —
and it is byte-identical for every record, so a snapshot per row stores one copy of the
same machine description per row. And a row you drove through `fireEventFor` does not
appear in the payload at all: what you get back is the *construction* owner's position.
`fromJSON(json, row)` then **writes** that persisted `currentState` onto whatever row
you hand it, overwriting the state that row was actually in.

For many records use the multi-owner mode above — the record's own `state` field is the
persisted state. Reach for `toJSON` when you want to move *one* machine across a process
boundary, or bring it back after a restart. There is a third, lighter option for that
last case — `StatePersistenceAdapter` (`saveState` / `restoreState`) moves the runtime
without the config; the three are compared side by side in
[`docs/persistence.md`](./docs/persistence.md).

`StateMachineOptions` splits in two, and the split decides what the payload holds.

**Behavioural scalars are persisted and restored.** `transitionTimeout`, `errorState`, `abortOnExitError`, `maxQueueDepth` and `maxTransitionDepth` are pure data that changes how the machine behaves, so they travel in the payload: `fromJSON(json, owner)` — no third argument — gives you a machine that behaves like the machine that was saved. Pass one of them to `fromJSON` anyway and **your value wins**; the persisted one is used only where you supplied nothing (`undefined` counts as "supplied nothing"). Only values you passed explicitly are written, so a machine built with no options serializes exactly as it did before this existed.

**Injection contracts are not persisted and must be re-supplied on every restore.** `logger`, `monitor`, `scheduler`, `errorHandler`, `contextTracker`, `clock` and the `actions` registry hold functions and host objects; no document can carry them. If you restore without them the machine falls back to the defaults — the console logger, a fresh monitor, real `setTimeout`, `Date.now` — silently, because that is a legitimate configuration. Pass them every time:

```ts
const sm = StateMachine.fromJSON(json, owner, {
  // Re-supplied on every restore — never in the payload:
  actions: { 'busy.onEnter': enterBusy },  // resolves the config's function NAMES
  monitor, logger, scheduler, clock,
  // Optional: overrides whatever the payload persisted.
  transitionTimeout: 2_000,
})
```

`actions` is the one you cannot skip if your config has function-valued hooks: functions serialize as a **name** (never a body — see [Breaking changes](#breaking-changes-in-100-beta5)), and restoration resolves that name against this registry. `strictActions` is not persisted either — it governs how strictly *this* read resolves those names, and a document does not get to relax the rules it is read under.

### Known issue: the per-action deadline is not restored

**A `transitionTimeout` that was counting down when you called `toJSON` is not persisted, so after a restore every action budget starts fresh.** A 5 s budget that had already burned 4 s at save time restores as a full 5 s. This is deliberate: the deadline races a pending promise, and a pending promise cannot be resumed — there is nothing to continue counting against. Budget for it: a machine that is saved and restored repeatedly can let a single action run for longer than `transitionTimeout` in total wall-clock. The bound is per action *per run*, not across a restore.

Invoke **delays** are unaffected and do resume correctly: `fromJSON` recomputes the remainder from the persisted `stateEntryTimes`, so a 1000 ms timer snapshotted 400 ms in fires 600 ms after the restore. See [Replaying serialized state](#replaying-serialized-state).

A long-running `invoke` **operation** (the `src` / `onDone` / `onError` form) is not resumed either — its promise and `AbortSignal` cannot survive a document. It is skipped on restore, with a `logger.warn`, and a fresh entry into the state relaunches it.

## Documentation

Full API documentation: [https://vedmalex.github.io/statemachine/](https://vedmalex.github.io/statemachine/)

## Extension Points

This package exposes 7 catalogued extension points (`IMonitor`, `ITimerScheduler`, `IErrorHandler`, `Adapter<T>`, `ILogger`, `StatePersistenceAdapter`, `validateConfig`) for host integration. Callbacks resolved from config or `setContext()` receive the underlying owner object directly, so host code does not need to unwrap `Adapter<T>` inside each callback. See [`docs/extension-points.md`](./docs/extension-points.md) for the full catalog.

`IContextTracker` (`StateMachineOptions.contextTracker`) is an eighth injection contract, added in `1.0.0-beta.5` and not yet folded into that catalog. It backs reentrancy detection and is documented under [Runtime support](#runtime-support).

## Lifecycle tracing (debugging)

`createLifecycleTracer()` plugs into `StateMachineOptions.monitor` and renders the machine's callback timeline — hook order, nesting, per-microstep grouping, hung callbacks, failures and guard coverage — answering "why was my `onExit` never called?" and "which callback is hung?". See [`docs/lifecycle-tracing.md`](./docs/lifecycle-tracing.md).

## Deterministic testing (DST)

Machines that use `invoke` delays or a `transitionTimeout` normally depend on real wall-clock time (`Date.now` + `setTimeout`). That makes tests slow, flaky, and sensitive to scheduling jitter. The DST API swaps the clock and the timer scheduler for virtual counterparts so timer-driven behavior replays deterministically with **zero** real time elapsed.

```ts
import { StateMachine, createVirtualScheduler } from '@vedmalex/statemachine'

let t = 0
const clock = () => t
const scheduler = createVirtualScheduler(clock)

const sm = new StateMachine(config, adapter, { clock, scheduler })
// ... arm the initial state's invoke timers
await Promise.resolve() // flush microtasks

t = 1000
scheduler.process() // fire every timer whose deadline <= 1000
await Promise.resolve() // flush microtasks so the transition settles
// assert sm.currentState === 'next'
```

### How it works

- `clock` replaces `Date.now` for `stateEntryTimes`, `resumeTimers`, and `getQueuedEvents` age math (and for the event-queue timestamps those ages are measured against, so age stays coherent under virtual time).
- `createVirtualScheduler(clock)` returns an `ITimerScheduler` whose `isActive()` is always `true`, so the `StateMachine` routes **all** `invoke` timers and the `transitionTimeout` through it.
- An **explicitly provided** scheduler is always used — the machine never falls back to real `setTimeout` while one is injected.
- `scheduler.process(now?)` drains every timer whose deadline `<= now` (default `now` is `clock()`), advancing zero real time. It is idempotent — draining twice does not re-fire a timer.
- `invoke` callbacks are async (they raise an event and queue the transition on a microtask), so after each `process()` you must flush microtasks (`await Promise.resolve()`, a few times for chained transitions) before asserting.

### Replaying serialized state

`toJSON()` / `fromJSON()` round-trips the recorded entry times as raw numbers. Restore into a fresh machine whose clock already reads the serialize time, and the remaining invoke delay is recomputed correctly:

```ts
// Original machine, invoke delay 1000ms, entered at t=0:
let t = 0
const clock = () => t
const sm = new StateMachine(config, adapter, { clock, scheduler: createVirtualScheduler(clock) })

t = 400
const json = sm.toJSON()           // snapshot 400ms in

const scheduler2 = createVirtualScheduler(clock)
const sm2 = StateMachine.fromJSON(json, freshAdapter, { clock, scheduler: scheduler2 })
// 600ms remain:
t = 1000
scheduler2.process()               // the invoke fires here, not at t=1400
```

### transitionTimeout under virtual time

Each per-action `transitionTimeout` deadline (see [Action timeouts](#action-timeouts-transitiontimeout) for the scope of the budget) is also routed through the injected scheduler, so it triggers on a virtual-time advance rather than a real timer:

```ts
const sm = new StateMachine(config, adapter, { clock, scheduler, transitionTimeout: 500 })
const fired = sm.fireEvent('go')   // enters a state whose action never resolves
await Promise.resolve()
t = 500
scheduler.process()                // the race rejects deterministically
await expect(fired).rejects.toThrow(/timeout/i)
```

When the action wins the race instead, the pending timeout token is auto-cancelled so no ghost rejection fires on a later `process()`.

## Simulation / DST

> **`@unstable`.** Everything under the `@vedmalex/statemachine/sim` entrypoint is `@unstable` and may change between minor versions. The core public API and bundle bytes are unaffected by this island.

The `./sim` entrypoint is a VOPR-style **Deterministic Simulation Testing** environment for state machines. It drives a machine through a seed-derived sequence of events with optional fault injection, evaluates Safety and Liveness oracles against the resulting trace, and (on a violation) shrinks the failing run to a minimal, runnable reproduction. Every run is **bit-exact replayable**: the same `seed` yields the same trace and the same `traceHash`.

```ts
import { runSimulation } from '@vedmalex/statemachine/sim'
import type { SimEnv, SimTarget } from '@vedmalex/statemachine/sim'

const result = await runSimulation(
  // setup: receives the deterministic env (five seams + random/now), returns a target.
  (env: SimEnv): SimTarget<{ state: string }> => ({
    config: doorConfig,        // your StateMachineConfig
    owner: { state: 'closed' }, // plain owner or an Adapter<T>
  }),
  {
    seed: '0x1234',            // bigint | string — canonicalized to a bigint PRNG seed
    steps: 64,                 // number of macrosteps to drive
    invariants: myInvariants,  // readonly Invariant[] (Safety oracle registry)
    mode: 'safety',            // 'safety' | 'liveness' | 'both'
  },
)

if (!result.ok) {
  console.error('violation at step', result.violation?.step, 'seed', result.seed)
}
```

### Entry points

| Symbol | Kind | Purpose |
| --- | --- | --- |
| `runSimulation(setup, opts)` | function | One-shot convenience: construct, `init()`, `run()`, return a `SimResult`. |
| `Simulator` | class | The inspectable driver. `init()` / `step()` / `run()` / `snapshot()`. |
| `wire(env, config, owner)` | function | Construct a consumer machine against the sim env (the sanctioned DI-first path). |

`Simulator` gives step-level control:

- `await sim.init()` — mandatory post-construction settle plus a behavioral sentinel-scheduler probe (fails loudly if timers do not route through the injected virtual scheduler). Idempotent.
- `await sim.step()` — drive exactly one macrostep; returns a `StepOutcome` (`step`, `t`, `frames`, `traceHash`, `quiescent`, `done`, optional `violation`).
- `await sim.run()` — drive `opts.steps` macrosteps; returns the aggregate `SimResult` (`ok`, `seed`, `steps`, `traceHash`, `trace`, `oraclesRun`, `metrics`, and optionally `violation`, `liveness` and `warnings`).
- `sim.snapshot()` — a serializable mid-run checkpoint (`SimSnapshot`: `seed`, `machine`, `prngState`, `t`, `step`); never hashed.

`wire(env, config, owner)` constructs `new StateMachine(config, owner, { clock, scheduler, monitor, errorHandler, logger })` with all five deterministic seams pre-forwarded from `env`, so the scheduler-omission footgun is structurally impossible.

### SimOptions

| Field | Type | Purpose |
| --- | --- | --- |
| `seed` | `bigint \| string` | Required. Drives the PRNG; the only source of nondeterminism. |
| `steps?` | `number` | Macrostep budget (default 16). |
| `maxTurns?` | `number` | Microtask-pump budget per macrostep settle (default 1024). Running out is never a failure — see [budget truncation](#breaking-changes-in-100-beta5). |
| `faults?` | `FaultPlan` | Seed-keyed fault injection plan (see the 7 kinds below). |
| `invariants?` | `readonly Invariant[]` | Safety-oracle registry evaluated at each step boundary. |
| `mode?` | `'safety' \| 'liveness' \| 'both'` | Oracle policy. Omitted means safety only. |
| `script?` | `readonly DriverOp[]` | Drive from a fixed op stream instead of the fuzzer. |
| `onTrace?` | `(frame: TraceFrame) => void` | Per-frame streaming callback. |

The remaining fields (`eventPayload`, `maxQueueDepth`) are in [`etc/statemachine-sim.api.md`](./etc/statemachine-sim.api.md), which is the generated public surface.

### Fault injection (7 kinds)

A `FaultPlan` may inject any of the seven fault kinds (`FaultKind`), keyed deterministically off the seed:

1. **reorder** — permute queued events
2. **drop** — discard a queued event
3. **dup** — duplicate a queued event
4. **overflow** — flood the queue past its bound
5. **clock-skew** — perturb the logical clock
6. **timer-jitter** — perturb armed-timer deadlines
7. **throw** — make an action/guard/invoke callback throw

Fault-free runs behave exactly as a simulation with no plan.

### Seed → bit-exact replay & minimal repro

The same `seed` always produces the same trace and the same `result.traceHash`, so any failing run is replayable verbatim. On a violation, the delta-debugging shrinker reduces the failing run to a `MinimalRepro` — the smallest seed/step/fault subset that still reproduces the violation — and `buildMinimalRepro` / `emitRepro` emit a self-contained runnable repro test against this same public `./sim` surface.

### Back-compatibility

> The DST machinery engages only when you opt in. Omitting **both** `clock` and `scheduler` leaves the real-time path as it was: `createDefaultScheduler()` uses `Date.now`, the `isActive()`-gated `setTimer` fallback to native `setTimeout` is unchanged, and `process()`'s default argument resolves to the same value it did before.
>
> One deliberate exception in `1.0.0-beta.5`: under a `transitionTimeout`, the deadline timer is now cleared on the default scheduler too, where the cleanup used to be attached only when a scheduler was injected. A process that had finished its work could previously stay alive for up to one `transitionTimeout` per outstanding handle; it now exits promptly.

### API reference

| Symbol | Kind | Purpose |
| --- | --- | --- |
| `createVirtualScheduler(clock)` | function | Build a deterministic, non-real-time `ITimerScheduler`. |
| `Clock` | type | `() => number`; matches the `clock` option signature. |
| `StateMachineOptions.clock?` | option | Inject a virtual clock (default `Date.now`). |
| `ITimerScheduler.process?(now?)` | method | Optional manual drain; implemented by `createVirtualScheduler`. |

### Dynamic config check — `checkMachine`

`checkMachine(config, ownerFactory, options?)` (from `@vedmalex/statemachine/sim`)
is the **dynamic** complement to the static `validateConfig`: it fuzzes your
machine over N deterministic runs through the simulator's oracle suite and returns
a structured `CheckReport`. The report's `ok` cannot lie — `ok === true` implies
`oraclesRun > 0 ∧ transitionsFired > 0`. **It is fuzzing, not model-checking:** the
absence of a finding is not a proof of correctness. Full guide, contract, and the
list of what it does NOT check: [`docs/dynamic-check.md`](./docs/dynamic-check.md).

```ts
import { checkMachine } from '@vedmalex/statemachine/sim'
const report = await checkMachine(myConfig, () => ({ state: 'idle' }), { seed: 'ci-1', runs: 32 })
if (!report.ok) throw new Error(`checkMachine failed: ${report.failedOn.join(', ')}`)
```

Beside `ok` and `failedOn`, the report carries `violations`, `unreachableStates`,
`reachableStates`, `deadEvents`, `deadlocks`, `livelocks`, `uncoveredTransitions`,
`nonConvergingRegions` (a parallel region that can never complete its join),
`guardOutcomes` (per transition, whether the guard was ever seen returning true and
ever seen returning false — one that never returned true is the classic dead
branch), `saturation`, and `warnings`. **A warning is never a verdict** and never
flips `ok`; `failOn` and `degradationExcept` decide which causes do.

Three options are worth knowing about:

- `shrink` (**default `true`**) delta-debugs the first violation down to a minimal
  reproduction. Reduction runs against your live config, so closures, guards and
  object payloads survive, and every candidate is decided by an actual re-run — a
  stream that does not reproduce the finding is reported as a `shrink-skipped`
  warning and the original run is kept. A minimal repro is never printed without
  having been verified. A green sweep spends nothing extra.
- `script` replays a fixed op stream instead of fuzzing — the executable twin of a
  printed repro, so a minimal repro is something you can paste back in. With a
  script the per-event `payload` generators are not consulted; the ops carry their
  args.
- `maxTurns` (**default 1024**) is the microtask-pump budget each macrostep settle
  uses. Raise it when a report carries a `budget-progressing` or `budget-frozen`
  warning and you need to know which reading is real.

## Stability policy

5 firm `@stable` symbols: `createMachine`, `StateMachine`, `StateMachineConfig`, `Transition`, `State`. The all-regions-final join API lives on these stable symbols — `State.final?: boolean`, `StateMachine.isDone(compositeId)`, and the engine-raised `done.state.<id>` event (all reflected in `etc/statemachine.api.md`). Other exports are `@unstable` and may evolve between minor versions. See [`STABILITY.md`](./STABILITY.md) for the full policy.

## Breaking changes in 1.0.0-beta.5

Five changes in this release are observable from outside a machine you already have working.

**Enter/exit callback order now follows W3C SCXML §3.13.** Entry is document order — a DFS pre-order walk of the config — and exit is its exact reverse, so `exited.reverse()` is now precisely `entered`. Two sequences move. `onExit` of sibling states in parallel regions fires in the **reverse** of declaration order (regions `r1, r2, r3` exit `r3 → r2 → r1`, where they previously exited `r1 → r2 → r3`), which restores the LIFO property: the region that acquired a paired resource first releases it last. And nested regions are no longer interleaved — the previous walk ordered the whole set by depth, so a shallow region's leaf could be visited *between* two states of another region's chain; each region is now walked to completion, on both entry and exit. The **set** of callbacks invoked and the **reached configuration** are unchanged, as are the layering guarantees (a parent enters before its region children and exits after them) and the entry sibling order. Order-independent `onExit` handlers — the common case — need no migration; if some code depended on the old sibling-exit order, invert that expectation. Detail and migration guidance: [docs/regions-and-parallel.md](./docs/regions-and-parallel.md#3-entryexit-ordering-scxml-313).

**An unrecognized serialized action shape is no longer accepted in silence.** `deserializeAction` used to install any object it did not recognize verbatim, so a hand-written `{ source, name }` guard *became* the guard and then failed only at fire time — where the guard-error path absorbs the failure into "transition disabled". The event no-opped forever with nothing thrown anywhere. That branch now warns unconditionally, and under `strictActions` throws a `StateMachineError` naming the keys it found — matching what the adjacent unresolvable-identity branches already did. It is reachable only from a payload this library did not write: `serializeActionRef` emits `{ type: 'string', name }`, `{ type: 'function', name, slot? }` or nothing at all, and none of those reach it, so a normal `toJSON` / `fromJSON` round-trip is unaffected. If you hand-assemble machine JSON, re-serialize it with `toJSON()` or drop the offending slot.

**A failing `invoke` action now reports.** The timer form of `invoke` swallowed both of its failure modes — an action that threw, and an action whose `transitionTimeout` expired. Neither reached `monitor.recordError`, neither reached the config-level `onError`, and nothing was thrown; the machine simply stopped advancing. Both now route through those same two channels, on the fresh-entry path and on the `resumeTimers` path alike. The invoke's `event` still is **not** raised — raising it would fabricate a completion the action never reached — so the machine's *behaviour* is what it was. **If you have a config-level `onError`, expect it to be called for failures it has never seen.** They were always happening; they were invisible.

**Exhausting the harness turn budget no longer fails a `checkMachine` / `./sim` run.** A correct machine whose `onEnter` awaited a long but finite chain of microtasks was convicted of a run-to-completion violation and a livelock: an awaited enter/exit hook is deliberately not counted as in-flight async, so while one runs the settle fingerprint is frozen — indistinguishable from a wedged drain. The verdict turned on exceeding an internal constant that no option could raise. Budget exhaustion is now an advisory warning and never a verdict: `budget-progressing` when the machine was still moving as the pump stopped watching, `budget-frozen` when it had already stopped. **A run that reported `ok: false` for this reason now reports `ok: true` with a warning.** The honest cost is that a genuinely wedged drain observed only through budget exhaustion is no longer convicted either — see [Known gaps](#known-gaps-in-100-beta). Alongside it: `maxTurns` is now a public option on both `SimOptions` and `CheckOptions` (default 1024), so the advice those warnings give is actionable; `LivenessParams.microtaskBudgetExhausted` is removed, because it turned the same truncated observation into a hard verdict; `SettleReason` and the check report's `WarningKind` both gained members, which breaks an exhaustive `switch` at compile time; and the DST trace header version moved to `'6'`, so any pinned `traceHash` changes.

**`I-3` (run-to-completion) left the default oracle set.** The teeth were left on the
one non-budget witness, `WAITING_ON_INTERNAL` — and that turned out to be the same
truncated observation over a 16-turn window. It is now the advisory `rtc-unobserved`
warning, which leaves `I-3` with no witness a real run can reach, so shipping it in the
default set would ship an inert oracle wearing a default badge. **A run that reported
`ok: false` for `WAITING_ON_INTERNAL` now reports `ok: true` with a warning.** Trace
hashes are unaffected — the header stays `'6'`. `SimWarning['kind']` gained
`rtc-unobserved`; the check report's `WarningKind` gained `rtc-unobserved` and
`lifecycle-truncated`, which previously reached consumers mislabelled as
`residual-rejection`. The measured cost of the removal is zero: the zero-false-positive
corpus never produced a single frame in the guarded branch (438 frames, 6 non-quiescent,
all `WAITING_ON_TIMER`), so the oracle was catching nothing there before. A genuinely
hung machine is still surfaced by `transitionTimeout` and by the liveness plane's
virtual-time budget.

**A `done.state.<C>` join is now raised after an `errorState` recovery.** When a transition failed and the machine recovered into the configured `errorState`, the recovery configuration was committed without a completion check. If that configuration happened to be all-final, `isDone(C)` reported `true` while `done.state.<C>` was never raised — a handler waiting on the join silently never ran. Completion is a property of the committed configuration, not of the path taken into it, so the check now runs on the recovery path too. A machine that has both an `errorState` and a `done.state.<C>` transition may therefore take a transition it did not take before. Recovery is still recovery — the attempted transition is not recorded as successful, and `fired: false` is unchanged — and the join stays edge-triggered, so a recovery into a partially-final configuration raises nothing.

Not a break, but new output you will see: on a runtime with no async-context primitive — a browser, today — the machine logs one `WARN` per process, at the first such construction, disclosing that precise reentrancy detection is unavailable. [Runtime support](#runtime-support) explains what that costs and how to silence it.

## Status & module format

`1.0.0-beta.x` (current published version: see the npm badge above; both the `latest` and `beta` dist-tags track the newest release). Stability: experimental. SCXML/UML parallel regions, ancestor-first / descendant-first ordering, and the all-regions-final join landed in **`1.0.0-beta.2`**. The full API surface is `@unstable` per the package's STABILITY policy except the 5 firm `@stable` symbols; per-symbol stability tagging completes before `1.0.0` stable.

**Module format**: ESM + CJS dual bundle (TASK-005). `require('@vedmalex/statemachine')` works in CommonJS runtimes via `dist/index.cjs`. `import` works via `dist/index.js`. The `exports` map resolves automatically.

## Runtime support

The core entry point (`@vedmalex/statemachine`) contains **no Node built-in imports** and loads in any ES2022 runtime. One capability, however, is not uniformly available, and the package degrades on it rather than refusing to load.

That capability is **precise reentrancy detection**. Each drain tags the actions and guards it runs with an epoch held in an async-context primitive. A `fireEvent` whose async context carries the currently active epoch was issued from *inside* that drain — a true reentrant call that can never be drained — so it is rejected with a clear error instead of parking forever. The primitive is `AsyncLocalStorage` where the runtime has it; there is no portable equivalent everywhere.

| Runtime | `sm.contextTrackerKind` | Reentrancy detection | Measured on |
|---|---|---|---|
| Node | `'async-local-storage'` | **Precise** — unchanged | Node 24.18.0 |
| Deno | `'async-local-storage'` | **Precise** — same tier as Node | Deno 2.2.12 |
| Browser | `'none'` | **Degraded** — see below | Chromium 147 (headless) |
| Any other tracker-less runtime | `'none'` | **Degraded** — see below | — |

Detection is by feature probe, not a runtime name: the engine tries `process.getBuiltinModule('node:async_hooks').AsyncLocalStorage`, then a global `AsyncContext.Variable`, and verifies each with a live round-trip — including that `run` restores on its own
synchronous return when the body returned a pending promise, which is the shape the
engine actually uses. Propagation across an `await` is *not* checked, because detection
runs synchronously in the constructor; a tracker that fails that degrades to no
detection rather than to false rejection, which is the safe direction. Deno lands in the precise tier because its Node-compat layer provides the first. A browser that ships `AsyncContext.Variable` will report `'async-context'` and get the precise tier automatically.

### What "degraded" means, exactly

On a runtime reporting `'none'`, the machine **loads and works** — states, transitions, hierarchy, regions, timers, invoke, persistence and the queue are all unaffected. Precisely two things change:

- **A true reentrant `fireEvent` is not detected.** Calling `await sm.fireEvent(...)` from inside an `onEnter` / `onExit` / `onTransition` / guard no longer rejects with a diagnostic error. The event is queued behind the very action awaiting it, so **that drain parks and never settles**, and the awaiting caller never resolves. This is a real loss of capability, not a cosmetic one. Bound it by setting [`transitionTimeout`](#action-timeouts-transitiontimeout), which settles the caller with an action-timeout error instead of hanging — a less precise diagnosis, but not a deadlock. The structural fix is the same as on Node: do not fire events inline from an action; model the follow-up as an internal transition (an `invoke` timer or a `done.state.*` completion), or dispatch from an independent async callback.
- **One `WARN` is logged at construction**, disclosing the above. `WARN` is the default log level, so it appears with no setup; silence it with `setDefaultLogLevel` or by injecting your own `logger`.

**Legitimate concurrency is never affected.** The degraded tracker reports an empty store, which can never equal the numeric active epoch, so the reject condition is *unreachable* — a `fireEvent` from an independent timer/IO callback, a chained `await fireEvent(A); await fireEvent(B)`, an `onError` recovery, or an event for a second adaptee mid-drain all queue and resolve exactly as they do on Node. The degradation is strictly missed detection; **false rejection is impossible by construction**. Both halves are pinned by `src/tests/reentrancy_degradation.test.ts`.

### Restoring precision on a custom host

If your runtime has an equivalent primitive under some other name, implement [`IContextTracker`](./etc/statemachine.api.md) (`run` / `exit` / `getStore`) and pass it as `contextTracker`. Each machine needs its **own** instance — the store is a per-machine drain epoch, and a shared instance can collide across machines.

```ts
const sm = createMachine(config, owner, { contextTracker: myTracker })
sm.contextTrackerKind // 'injected' — you own the capability statement
```

### `./sim` is Node-only

The `@vedmalex/statemachine/sim` entry point is **deliberately** Node-bound — it uses `process`, `fs` and `path` for scenario I/O, CLI wiring and signal handling. It is not intended to load in a browser or a bare runtime and no portability is claimed for it. The core entry point above carries none of that.

## Performance

The composite-write hot path (`setCurrentState` region-conflict scan and the
all-regions-final completion check) is **O(R)** in the number of parallel regions
R. Two former Θ(R²) sites — the per-part conflict scan and the per-region
completion scan — were reduced to linear (measured with a deterministic counting
probe over R ∈ {40…320}: ~65× → ~8× growth per 8× region increase), behaviour
preserved (the full suite is the oracle). Entering a leaf is a dot-boundary-exact
region replacement, so a prefix-named sibling region (`r1` vs `r10`) is never
evicted.

## Known gaps in 1.0.0-beta

- **Multi-runtime CI (Tier B)**: the `tier-b-deno` and `tier-b-browser` jobs still
  carry `continue-on-error: true` — they report, they do not gate, and a regression
  in either runtime will not fail CI. The defect that was failing both lanes (a bare
  `async_hooks` specifier in the bundle) is fixed, and the browser smoke now drives a
  real transition instead of merely constructing a machine, so the jobs are no longer
  expected to be red — but flipping them to blocking is still tracked for stable
  1.0.0 and has not happened.
- **A wedged drain seen only through budget exhaustion is not convicted.** Since
  `1.0.0-beta.5`, running out of the harness turn budget produces a warning rather
  than a verdict, because an `onEnter`/`onExit` hook doing a large but finite amount
  of internal work leaves a frozen prefix byte-identical to a hook that never
  returns — an awaited hook is not tracked as in-flight async, so no fixed window can
  tell the two apart. Raising `maxTurns` can: a finite hook eventually completes.
  The pump's EARLY break turned out to be the same truncation over a 16-turn window
  instead of a 1024-turn one: the settle fingerprint is frozen across an entire
  ordinary microstep, whose length grows with the machine's own width. A parallel
  composite whose sibling region merely holds an armed timer was convicted for a
  *synchronous* `onEnter`. So that boundary does not convict either, and `I-3`
  (run-to-completion) is no longer in the default oracle set — request it explicitly
  if you want those frames flagged.
- **`checkMachine` (dynamic check)**: fuzzing, not model-checking (see
  [`docs/dynamic-check.md`](./docs/dynamic-check.md)) — the absence of a finding is
  never a proof of correctness. Two builtin oracles are additionally limited by what
  the observation channel can see, and both under-report rather than false-fire:
  `I-4` (enter/exit hierarchy order) compares only states that actually ran a hook,
  and skips the reserved `microstep 0` used by construction / `reset` /
  `resumeTimers`; `I-5` (parallel join) samples completion at settle boundaries, so a
  composite that becomes all-final and is *left again* inside the same macrostep is
  never observed done — a missing `done.state.<C>` there goes unreported.

## Known internal debt (Phase 1)

The Phase 1 bootstrap copied several modules as-is from the legacy `@grainjs/statemachine` source. They are functionally correct for `1.0.0-beta.x` consumers but carried singleton patterns that blocked WASM/Zig portability and cross-runtime hosting. Each item has been resolved in TASK-004:

- **`TimerScheduler.getInstance()`** — removed in TASK-004 (singleton elimination); use `createDefaultScheduler()` or inject via `StateMachineOptions.scheduler`.
- **`globalStateMachineMonitor`** — removed in TASK-004 (ISS-007 + ISS-008); use `createDefaultMonitor()` or inject via `StateMachineOptions.monitor`.
- **`globalErrorHandler`** — removed in TASK-004; use `createDefaultErrorHandler()` or inject via `StateMachineOptions.errorHandler`.

- **WASM/Zig port architectural commitments** — see `docs/zig-port-considerations.md` for the patterns this package commits to (no module-level mutable state, injection contracts, factory defaults).

## Build-time constraints

- **`tsconfig.moduleResolution = "bundler"`** — TASK-003 TD-T3-5 / F-CR-4 conditional closure. Downstream tasks (TASK-005 CI/CD + CJS) MUST keep an import-rewriting bundler (`tsup`, `esbuild`, `rollup` with `node-resolve`, `vite build` library mode). Flipping to a non-rewriting toolchain (raw `tsc --module commonjs`) requires upgrading `moduleResolution` to `"node16"`/`"nodenext"` first and migrating all internal imports to use `.js` extensions explicitly.
- **`tsup` is the runtime bundler** — TASK-005 selection. Future tasks must keep an import-rewriting bundler (`tsup`/`esbuild`/`rollup`-with-node-resolve) per TD-T3-5 conditional bundler constraint.
- **`etc/statemachine.api.md`** is the canonical `@stable` surface snapshot — generated by `api-extractor`; CI fails on uncommitted drift. Promoting a symbol from `@unstable` to `@stable` requires updating this file deliberately.
- **knip ignore-list cap = 5 entries** — TASK-003 PLAN F-PL-5 governance. Adding a 6th ignore requires either removing an existing one OR opening a new DA review against the Sustainability lens. Currently 2/5 used (`src/tests/**`, `src/presets.ts` — see `knip.json`).
- **`@stable` public surface** — 5 firm symbols (`createMachine`, `StateMachine`, `StateMachineConfig`, `Transition`, `State`). Changing their signatures is a 1.0.0-stable breaking change. The `src/tests/public_surface.test.ts` ratchet test enforces non-regression at CI time.

A full review trail for Phase 1 lives in the MB3 work tree (see root README): `memory-bank/tasks/2026-05-03_TASK-002_.../code-review.md` (bootstrap) and `memory-bank/tasks/2026-05-03_TASK-003_.../code-review.md` (quality baseline).

## License

MIT — see LICENSE.
