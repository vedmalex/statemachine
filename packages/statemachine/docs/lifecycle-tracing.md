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

## Limits — what this channel does **not** see

These are properties of the underlying observability channel, not of the tracer.
Reading a gap here as a bug will send you chasing the wrong thing.

- **Transition-level callbacks are invisible.** `onTransition` and the
  event-level `onBefore` / `onAfter` are *not* instrumented. Only state hooks
  (`onBeforeEnter` / `onEnter` / `onAfterEnter` / `onBeforeExit` / `onExit` /
  `onAfterExit`), `invoke` work, and guards appear.
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

The tracer keeps a **ring buffer**, so it cannot leak in a long-lived process.

- `options.limit` — maximum retained records. Default `10_000`. Pass
  `Number.POSITIVE_INFINITY` for unbounded retention. A non-integer or
  non-positive value falls back to the default rather than throwing: a debugging
  aid must not be the thing that breaks your build.
- On overflow the **oldest** record is dropped and counted. The loss is
  disclosed, never hidden — `stats().dropped` reports it and `format()` appends
  `… · 37 dropped (limit 100)` to its summary line.
- A dropped `begin` whose `end` survives is rendered as `⚠ end only` instead of
  being silently discarded.
- `reset()` clears the trace *and* all counters.

```ts
tracer.stats()
// { recorded: 4, seen: 41, dropped: 37, malformed: 0, limit: 4 }
```

`malformed` counts payloads the tracer could not use at all. The tracer is a
pure subscriber: it never calls back into the machine, never mutates a record,
and never throws out of a sink method — a partial or nonsense payload is
absorbed and counted, not propagated.

## API

```ts
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
rendered `format()` output is a debugging aid, not a parsing target: treat it as
prose and read structured data from the helpers instead.
