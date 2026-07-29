# Lifecycle Tracing

A debugging instrument for the questions a state machine is worst at answering
from the outside:

- **"Why was my `onExit` never called?"** — the order and the *fact* of every
  engine-invoked callback, in one timeline.
- **"Which callback is hung?"** — a callback that started and never settled is a
  `begin` edge with no `end`, and the tracer names it.
- **"Which guard never returned true?"** — per-transition guard coverage, which
  is how a silently-dead transition gets found.
- **"Which object was that?"** — one machine can drive many owner objects; their
  traces are separated rather than interleaved.

The engine side of this is `IMonitor.recordLifecycle` (see `LifecycleEvent` in
`src/types.ts`), a synchronous stream of `begin`/`end` edges. That stream is
deliberately raw: no timestamps, no pairing, no grouping. The **tracer** is the
consumer side that turns it into something you can read.

## The machine has already gone quiet and you wired nothing

Everything below this section requires you to have installed a tracer *before*
the machine misbehaved — that is, to have already suspected the problem. For the
case you are usually in instead, the machine can answer on its own:

```ts
console.error(sm.describeProgress())
```

```
onEnter at 'b' for nils (owner #1) is open, and the engine has not advanced a
phase since it was entered.

Engine at tick 6, last advanced at micro.exit.
Source: the engine's live entry/settle counters, not the lifecycle buffer.
```

No monitor, no options, no setup. `describeProgress()` reads the same live
bookkeeping `getProgress()` returns — the dispatch funnel maintains it whether or
not anything is subscribed — and renders it as prose: *which* slot, in *which*
state, for *which* owner, open for *how long*.

The age is in **engine ticks**, not milliseconds and not microtask turns. A tick
is one engine phase advance, so the gap between two ticks is a property of the
engine's code rather than of your machine's shape: the same wedge reports the
same age on a one-region machine and a sixteen-region one. `openTicks: 0` means
the engine has not advanced *at all* since that callable was entered.

With more than one callable open, the oldest leads and the rest are listed
beneath it:

```
2 consumer callables are open. The oldest is invoke.operation at 'working' for
alice (owner #1), open for 10 engine ticks since tick 10.

  10 ticks  invoke.operation  working  alice (owner #1)
   0 ticks  invoke.operation  working  bob (owner #2)

Engine at tick 20, last advanced at drain.external.
Source: the engine's live entry/settle counters, not the lifecycle buffer.
```

Over a single snapshot, "most ticks open" and "entered earliest" are the same
ordering, so there is no tie-break to argue about.

### What it will not tell you

**It never says stuck.** A callable is entitled to take as long as it likes, and
nothing in one snapshot separates a wedge from a slow `await` — a 60ms `onEnter`
and a permanently hung one produce the identical report. So the report states the
two facts it has (this slot is open; the engine has / has not advanced since) and
leaves the verdict to you, who knows what that callback was supposed to do.

**It is not a liveness oracle and there is no plan for it to become one.** If you
want "is this machine wedged?", the honest answer is: sample `getProgress()`
twice and compare, with knowledge of what the callbacks do.

### On a `transitionTimeout`

When a `transitionTimeout` wins its race the consumer body is, by construction,
still running — the deadline aborts the *wait*, not the callback. That is the one
moment the engine can volunteer the answer, and it does, on the existing warn
channel:

```
Transition timeout after 20ms, but the callable is still running — onEnter at 'b'
for deadline (owner #1) is open, and the engine has not advanced a phase since it
was entered.
```

The rejected promise still carries exactly `Transition timeout`; the slot
identity is additive and goes to the logger, so nothing matching on that message
is affected. Silence the line with `options.logger`, like any other engine log.

### Cross-checking against a trace

If a tracer *is* installed as the machine's monitor, `describeProgress()` finds it
and uses it as a **second opinion** — it can add a caveat, never a claim. See
[Truncation](#truncation-and-the-false-all-clear) for the caveat that matters.

## Quick start

```ts
import { StateMachine, createLifecycleTracer } from '@vedmalex/statemachine'

const tracer = createLifecycleTracer()
const sm = new StateMachine(config, owner, { monitor: tracer })

await sm.fireEvent('go')
console.log(tracer.format())
```

Real output from a machine with a composite state, two guarded transitions and a
throwing `invoke`:

```
microstep 1  (event: 'start')
  enter  proc         onEnter        3ms
microstep 2  (event: 'go')
  guard    proc.r1.a -> proc.r1.b    ✗ false
  guard    proc.r1.a -> proc.r1.b    ✓ true
  exit     proc.r1.a  onExit         12ms
  enter    proc.r1.b  onBeforeEnter
  enter    proc.r1.b  onEnter
  enter    proc.r1.b  onAfterEnter   1ms
  invoke   proc.r1.b  invoke.action  ✗ failed
— 16 records · 1 failed
```

Reading it:

| Element | Meaning |
| --- | --- |
| `microstep N  (event: '…')` | One selection attempt. Everything under it belongs to the same microstep. |
| indentation of the state column | Nesting depth of the state (`proc` → `proc.r1.b`). |
| `guard  <from> -> <to>` | A guard row is keyed by its **transition**, not its state — two transitions leaving the same source are otherwise indistinguishable. |
| `✓ true` / `✗ false` | Guard result. |
| `✗ threw` | The guard raised; the transition stays disabled. |
| `✗ failed` | The callback threw or rejected. |
| `⧗ unfinished` | The callback **started and never settled** — it is hung. |
| `⚠ end only` | The `end` edge survived but its `begin` was evicted by the ring buffer. |
| `12ms` | Wall time between the two edges, stamped by the tracer (omitted when 0). |
| `— …` summary | Record count plus any unfinished / failed / owner / dropped counts. |

One row is one **callback invocation**, not one edge: the `begin` and `end`
records are collapsed into a single line carrying the outcome.

## Decorating a monitor you already have

The tracer *is* an `IMonitor`, so it can be passed directly — but then it is the
*only* monitor, and its `recordTransition` / `recordError` are no-ops. If you
already collect metrics, decorate instead of replacing:

```ts
const tracer = createLifecycleTracer()
const sm = new StateMachine(config, owner, { monitor: tracer.wrap(myMonitor) })
```

`wrap(inner)` forwards `recordTransition`, `recordError`, and — when `inner`
defines them — `recordEvent` and `getMetrics`, so feature-detection on the
wrapper keeps telling the truth about `inner`. `recordLifecycle` is *always*
present on the wrapper (that is what switches the channel on in the engine) and
is forwarded to `inner.recordLifecycle` when it has one. A wrapped monitor that
throws cannot cost the tracer a record.

## Recipes

### Who is hung?

```ts
for (const record of tracer.unfinished()) {
  console.error(`hung: ${record.hook} on ${record.state} (microstep ${record.microstep})`)
}
```

`unfinished()` returns the unmatched `begin` records. It is a *live* answer, not
a verdict: once the callback settles, the pairing closes and the record leaves
the list.

```
  enter    proc.r1.b  onAfterEnter   ⧗ unfinished
— 13 records · 1 unfinished
```

**Check `tracer.truncated` before you believe an empty result** — see
[Truncation](#truncation-and-the-false-all-clear). On a truncated buffer,
`unfinished()` returning `[]` does not mean nothing is hung.

### Who threw?

```ts
tracer.failures() // the `edge: 'end'` records carrying `failed: true`
```

Note this is the *same* failure the error channel reports — a throwing callback
produces both a `failed:true` lifecycle record and a `monitor.recordError`. Do
not add them together.

### Which guard is dead code?

```ts
const dead = tracer.guardOutcomes().filter((g) => !g.sawTrue)
// → [{ transition: 'a -> b', state: 'a', evaluations: 2, sawTrue: false, sawFalse: true, threw: 0 }]
```

A guard that was evaluated repeatedly and never once admitted its transition is
the classic silent bug: the transition exists, looks wired up, and can never
fire. `threw` separates "the guard is broken" from "the guard says no".

Guards are keyed by the `"<from> -> <to>"` label. Two distinct transitions that
produce the *same* label are reported as one entry.

### Which object was it?

```ts
tracer.byOwner(alice)          // an adapter…
tracer.byOwner(alice.adaptee)  // …or the owner object itself — both work
console.log(tracer.format({ owner: alice }))
```

`event.owner` is the **adaptee**, but passing the adapter is the obvious
mistake, so both resolve. `tracer.owners()` lists the distinct owners in
first-seen order — the same order as the `#1` / `#2` markers in `format()`:

```
microstep 1  (event: 'go', owner #1)
  enter  active  onBeforeEnter  1ms
  enter  active  onEnter        1ms
microstep 2  (event: 'go', owner #2)
  enter  active  onBeforeEnter  1ms
  enter  active  onEnter        1ms
— 8 records · 2 owners
```

### Zooming into one microstep

```ts
tracer.microsteps()                  // [1, 2, 3] — ascending
tracer.byMicrostep(2)                // raw records of that microstep
tracer.format({ microstep: [2, 3] }) // render only those blocks
```

### Deterministic output

`format()` stamps subscriber time, so by default it varies run to run. Inject a
clock and it becomes byte-stable — usable in snapshots and in a simulation plane
where `Date.now` is forbidden:

```ts
const tracer = createLifecycleTracer({ now: () => virtualClock })
```

Pass the *same* function you gave to `StateMachineOptions.clock` and the trace
lines up with the machine's own virtual time.

## Internal event raises (`kind: 'raise'`)

Besides state hooks, `invoke` work and guards, the channel records every point at
which the **engine itself** pushes an event onto the internal queue. There are five
such origins, distinguished by `hook`:

| `hook` | Raised when |
| --- | --- |
| `raise.done` | a composite became all-final and the engine raises `done.state.<C>` |
| `raise.invoke.timer` | an `invoke` delay elapsed and its `event` is raised |
| `raise.invoke.onDone` | an `invoke` operation fulfilled |
| `raise.invoke.onError` | an `invoke` operation rejected |
| `raise.invoke.resume` | a timer resumed from a deserialized snapshot fired |

A raise is instantaneous, so — like `invoke.abort` — it is emitted as an adjacent
`begin`+`end` pair with no work in between and never shows a duration. On a raise
record `event` is always present and holds the **raised** event name; `state` is the
raise *origin*: the composite for `raise.done`, the `invoke`-owning leaf otherwise.

`microstep` needs care, for the same reason as on `invoke` records. `raise.done`
carries the current microstep (the completion scan runs inside the microstep whose
state write produced the done configuration); the three `raise.invoke.timer` /
`onDone` / `onError` hooks carry the microstep that **armed** the invoke, not the one
in which the timer or promise settled; `raise.invoke.resume` carries the reserved `0`,
because a resumed timer fires outside any microstep. In no case is it the microstep in
which the raised event is later *processed* — that happens in its own step, and the
transition it drives is already visible as a normal enter/exit sequence.

Only engine-internal raises appear here. A caller's own `fireEvent` is not recorded —
it is already visible to the caller.

## Limits — what this channel does **not** see

These are properties of the underlying observability channel, not of the tracer.
Reading a gap here as a bug will send you chasing the wrong thing.

- **Transition-level callbacks are invisible.** `onTransition` and the
  event-level `onBefore` / `onAfter` are *not* instrumented. Only state hooks
  (`onBeforeEnter` / `onEnter` / `onAfterEnter` / `onBeforeExit` / `onExit` /
  `onAfterExit`), `invoke` work, guards, and internal event raises appear.
- **The `onError` handler is invisible**, by construction: the `end` edge is
  emitted at the settle of the *callback*, strictly before the error is routed.
  Otherwise a hung `onError` would masquerade as a hung `onEnter`.
- **`invoke.cond` predicates are invisible** — they are evaluated at arm time,
  outside the callback lane.
- **The `errorState` fallback path emits no `enter` records.** That recovery
  commits the error configuration directly, bypassing the enter-hook executor.
  A missing `enter` there does **not** mean the error state was never entered.
- **An aborted microstep still shows its `enter` records.** Enter hooks run
  *before* the point of no return, so a microstep that was later aborted (a
  throw under `abortOnExitError`, a contradictory target, a `transitionTimeout`)
  has already emitted records for a state that was never committed. Group by
  `microstep` and discard the ones you do not want — that is exactly what the
  `microstep` field is for.
- **`microstep: 0` is reserved** for work outside any microstep: initial
  construction, `reset`, `resumeTimers`. The real counter starts at 1.
- **`invoke.abort` is a point, not an interval** — it is emitted as an adjacent
  `begin`+`end` pair with no work in between, so it never shows a duration.
- **`kind` and `hook` are extensible unions.** New members will be added without
  a major bump; never write an exhaustive `switch` over them.

## Memory

**The tracer retains at most 10 000 records by default.** Past that it keeps the
most recent 10 000 and throws the rest away. That is the whole limit, stated
plainly, because everything in the next section follows from it.

It is a **ring buffer**, so it cannot leak in a long-lived process.

- `options.limit` — maximum retained records. Default `10_000`. Pass
  `Number.POSITIVE_INFINITY` for unbounded retention. A non-integer or
  non-positive value falls back to the default rather than throwing: a debugging
  aid must not be the thing that breaks your build.
- On overflow the **oldest** record is dropped and counted. The loss is
  disclosed, never hidden — `truncated` flips to `true`, `stats().dropped`
  reports it, and `format()` appends `… · 37 dropped (limit 100)` to its summary
  line.
- A dropped `begin` whose `end` survives is rendered as `⚠ end only` instead of
  being silently discarded.
- `reset()` clears the trace *and* all counters — including `dropped`, so
  `truncated` goes back to `false` over a buffer that is nonetheless missing
  everything that came before.

```ts
tracer.stats()
// { recorded: 4, seen: 41, dropped: 37, malformed: 0, limit: 4 }
```

`malformed` counts payloads the tracer could not use at all. The tracer is a
pure subscriber: it never calls back into the machine, never mutates a record,
and never throws out of a sink method — a partial or nonsense payload is
absorbed and counted, not propagated.

### Truncation and the false all-clear

The failure mode this creates is worth naming, because it is the *opposite* of
the one people expect.

Eviction is by **age**. A `begin` can therefore scroll out from under a callable
that is still running — but its `end`, which is younger, never outlives it. So a
truncated trace cannot *invent* a hung callback. It can only **miss** one, and it
misses silently:

```ts
tracer.unfinished()   // []        ← nothing is hung?
sm.getProgress().openDispatches.length   // 1  ← something very much is
tracer.truncated      // true      ← this is why
```

A tool whose job is to be believed must not answer "all clear" from a buffer that
can no longer see the run. So:

- **`tracer.truncated`** is `true` once *any* record has been dropped. Read it at
  the moment you draw a conclusion, never earlier — it is a **getter**, and a
  `false` you captured at wiring time is a `false` that expires. (`SimMonitor`
  froze the same rule for `raisesTruncated`, for the same reason.)
- **`describeProgress()` consults it for you.** With a truncated trace installed,
  the report keeps the live reading and explicitly disqualifies the buffer:

  ```
  invoke.operation at 'working' for held (owner #1) has been open for 144 engine
  ticks, since tick 12.

  Engine at tick 156, last advanced at drain.external.
  Source: the engine's live entry/settle counters, not the lifecycle buffer. The
  lifecycle trace has dropped 23 of 27 records (limit 4), so what it retains is a
  suffix of the run and an unfinished callback that started earlier no longer
  appears in it at all — nothing above rests on it.
  ```

- **The live counters are authoritative where the buffer is not.**
  `getProgress().openDispatches` is maintained on entry and settle, never derived
  by scanning a buffer, so it is bounded by real concurrency rather than by run
  length and is unaffected by any of this.

The reconciliation runs in both directions. An unmatched `begin` in the trace that
the engine is *not* inside — one tracer shared across two machines, or a
`reset()` mid-flight — is named and disowned rather than reported as this
machine's:

```
Source: … The trace additionally shows onEnter at 'b' for alpha (owner #2) as
unfinished, but this engine is not inside it — either that end edge never reached
the trace, or the trace is shared with another machine. It is not evidence about
this one.
```

## API

```ts
// ── the standing report ─────────────────────────────────────────────────────
class StateMachine {
  getProgress(): EngineProgress      // the raw snapshot
  describeProgress(): string         // that snapshot, as prose
}

function describeProgress(
  progress: EngineProgress,
  options?: DescribeProgressOptions,
): string

interface DescribeProgressOptions {
  trace?: LifecycleTracer   // a SECOND OPINION; may add a caveat, never a claim
  limit?: number            // open slots listed before the tail is summarised; default 6
  oneLine?: boolean         // just the lead sentence, for a log line; default false
}

// ── the tracer ──────────────────────────────────────────────────────────────
function createLifecycleTracer(options?: LifecycleTracerOptions): LifecycleTracer

interface LifecycleTracerOptions {
  now?: () => number   // default Date.now
  limit?: number       // default 10_000; Infinity for unbounded
}

interface LifecycleTracer extends IMonitor {
  recordLifecycle(event: LifecycleEvent): void
  wrap(inner: IMonitor): IMonitor

  getTrace(): LifecycleRecord[]
  format(opts?: LifecycleFormatOptions): string

  unfinished(): LifecycleRecord[]
  failures(): LifecycleRecord[]
  guardOutcomes(): GuardCoverage[]
  byOwner(owner: object): LifecycleRecord[]
  byMicrostep(microstep: number): LifecycleRecord[]
  microsteps(): number[]
  owners(): object[]

  stats(): LifecycleTracerStats
  readonly truncated: boolean   // a GETTER — read it when you conclude, not when you wire
  reset(): void
}

interface LifecycleRecord extends LifecycleEvent {
  readonly ts: number   // stamped by `options.now`
}

interface LifecycleFormatOptions {
  owner?: object                        // owner object or its adapter
  microstep?: number | readonly number[]
  timings?: boolean                     // default true
  summary?: boolean                     // default true
}

interface GuardCoverage {
  readonly transition: string   // "<from> -> <to>"
  readonly state: string
  readonly evaluations: number
  readonly sawTrue: boolean
  readonly sawFalse: boolean
  readonly threw: number
}

interface LifecycleTracerStats {
  readonly recorded: number   // currently retained
  readonly seen: number       // accepted since construction / reset
  readonly dropped: number
  readonly malformed: number
  readonly limit: number
}
```

`getTrace()` returns a **copy**, oldest first — sort or splice it freely.

## Stability

`@unstable`, like the `IMonitor.recordLifecycle` channel it consumes. The
rendered `format()` and `describeProgress()` output is a debugging aid, not a
parsing target: treat it as prose, and read structured data from the helpers —
`unfinished()`, `stats()`, `getProgress()` — instead.
