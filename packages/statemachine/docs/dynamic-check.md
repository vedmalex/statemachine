# Dynamic config check — `checkMachine`

`checkMachine` runs your state machine through the deterministic simulator's oracle
suite and returns a trusted, structured report of what it found: unreachable
states, deadlocks, livelocks, invariant violations, coverage gaps, and more. It is
the **dynamic** complement to the **static** `validateConfig` — the static check
proves structural well-formedness; the dynamic check *exercises* the machine under
a fuzzed event stream and watches the oracles.

```ts
import { checkMachine } from '@vedmalex/statemachine/sim'

const report = await checkMachine(myConfig, () => ({ state: 'idle' }), {
  seed: 'ci-1',
  runs: 32,
  steps: 1000,
})

if (!report.ok) {
  console.error('checkMachine failed:', report.failedOn)
  console.error(report.violations, report.deadlocks, report.livelocks)
  process.exit(1)
}
```

> ## ⚠️ This is FUZZING, not model-checking
>
> The **absence** of a finding does **not** prove correctness. `checkMachine`
> drives your machine with a pseudo-random event stream over `runs` independent
> seeds; it explores *some* of the reachable behaviour, not all of it. Completeness
> depends entirely on **your event alphabet** and **your payload generators** — an
> event never fired, or fired only with trivial arguments, has its branches
> **uncovered**. Read the `saturation` field and the `warnings`: they tell you how
> much of the machine the run actually touched.

---

## The `ok` contract — why a green verdict cannot lie

The report is engineered so a "verified" result is never vacuous. `ok === true`
**implies both**:

- `oraclesRun > 0` — at least one oracle actually ran (no green over zero checks);
- `transitionsFired > 0` — the machine actually moved (no green over a machine
  frozen in its initial state because every guard blocked or the alphabet was dead).

By default `failOn` is **strict** (every `FailCause`), so in CI you read exactly one
field — `ok`. The causes:

| cause | when |
|---|---|
| `violation` | a builtin oracle or one of *your* `invariants` was violated |
| `deadlock` | a reached non-final state has no outgoing transition |
| `livelock` | the liveness plane found a no-progress cycle / a **virtual-time** budget overrun (never the settle *turn* budget — see "Run-to-completion and the settle budget") |
| `no-progress` | `transitionsFired === 0` — the machine never moved |
| `escape` | a real (non-virtual) timer escaped the scheduler (see below) |
| `degradation` | a dead event / uncovered transition survived a **saturated** coverage sweep |
| `non-converging` | a parallel region can never complete, so its composite's join can never fire |

An **engine-synthetic** violation (`kind: 'engine'`) — an internal engine crash or
unhandled rejection — always fails the verdict and is routed to the *engine*
developer, not you: it is a bug in the library, not in your machine.

### Relaxing the verdict

`failOn` and `degradationExcept` let you relax **consciously** — the default is
strict, you opt out explicitly:

```ts
await checkMachine(cfg, factory, {
  // accept coverage gaps but still fail on real defects:
  failOn: ['violation', 'deadlock', 'livelock', 'no-progress', 'escape'],
  // or keep 'degradation' but excuse ONE noisy warning kind:
  degradationExcept: ['no-payload'],
})
```

---

## Owner source & run independence

The second argument is an **`OwnerSource`** — the object your machine drives:

```ts
type OwnerSource<T> = T | Adapter<T> | (() => T | Adapter<T>)
```

A single live owner reused across N runs would let run *N* mutate the owner for run
*N+1*, breaking run independence and seed determinism. So **a factory `() => owner`
is mandatory when `runs > 1`** — passing a live object throws. Pass a factory that
returns a *fresh* owner each call:

```ts
await checkMachine(cfg, () => ({ state: 'idle', retries: 0 }), { runs: 32 })
```

`runs === 1` accepts a live object (there is nothing to isolate).

---

## Custom invariants — `MachineInvariant`

Assert properties of your machine's **data**, not just its state name. The snapshot
includes the live owner data:

```ts
type MachineSnapshot<T> = {
  config: string        // '|'-normalized active configuration
  state: string         // active leaf/state
  data: Readonly<T>     // your live owner data
  queueDepth: number
}

await checkMachine(cfg, factory, {
  invariants: [
    { name: 'retries-bounded', check: (s) => (s.data.retries ?? 0) <= 3 },
  ],
})
```

The predicate is evaluated after each step. **`false` OR a throw is a violation** —
a throw inside your check is treated as a failure, never swallowed. Violations you
raise carry `kind: 'user'`.

---

## Event alphabet & payloads

By default `checkMachine` fuzzes **all** events in `config.events` with **no
arguments**, and emits an advisory `no-payload` warning listing them. If your
events take arguments, their argument-dependent branches are **not covered** until
you supply a payload generator that sees the current snapshot:

```ts
await checkMachine(cfg, factory, {
  events: [
    { name: 'submit', payload: (rng, snap) => [pickVerdict(rng, snap.data)] },
    { name: 'cancel' }, // no args — fuzzed bare
  ],
})
```

The values you return are forwarded **verbatim** to `fireEvent`, object payloads
included, so a guard or `onTransition` declared as `(owner, verdict) => …` receives
`verdict` and its argument-dependent branches become reachable. `rng` is a
seed-derived child stream, independent of the op-selection stream: the same seed
always yields the same payload sequence, and an event without a generator costs no
draw at all. A throw inside a generator is not swallowed.

The `payload(rng, snapshot)` generator is the single place where fuzzing *sees the
state* — essential for stateful events (e.g. an MB3 verdict object meaningful only
relative to the current gate).

---

## Reading the report

```ts
interface CheckReport {
  ok: boolean
  oraclesRun: number          // ok ⇒ > 0
  transitionsFired: number    // ok ⇒ > 0
  seed: string; runs: number; steps: number

  // coverage
  reachableStates: string[]
  unreachableStates: string[]         // declared but never visited — REPORTED, not a fail
  uncoveredTransitions: { event; from; to }[]
  deadEvents: string[]                // never fired
  guardOutcomes: { transition; sawTrue; sawFalse }[]   // per declared guarded transition
  saturation: { plateauedAtRun: number | null; newCoveragePerRun: number[] }

  // structural findings
  deadlocks: { state }[]
  livelocks: { reason }[]
  nonConvergingRegions: { composite; region }[]

  // violations & warnings
  violations: { invariant; kind: 'engine'|'builtin'|'user'; witness; reproCode; minimal? }[]
  warnings: { kind: WarningKind; detail: string }[]
  failedOn: FailCause[]        // empty ⇒ ok
}
```

- **`unreachableStates`** is *reported, not failed* — a state can be dead by design.
- **`saturation`** answers "did I fuzz enough?": once `plateauedAtRun` is non-null,
  more runs stopped finding new coverage, so a remaining `deadEvents` /
  `uncoveredTransitions` is a genuine gap (that is what turns them into a
  `degradation` fail) rather than "not reached yet".
- **`guardOutcomes`** is seeded from the config, so a guard that was never *evaluated*
  shows as `{ sawTrue: false, sawFalse: false }` rather than vanishing. `sawTrue:
  false` is the classic silent bug — a branch the machine can never take. It is
  **advisory**, not a fail cause: a guard's `true` branch routinely needs a payload
  the fuzzer cannot synthesize. Rows are keyed by the engine's `"<from> -> <to>"`
  label, so two events declaring the same pair share one row whose flags are the
  union; that only ever makes `sawTrue: true` less specific, never `sawTrue: false`
  wrong. Assert on this field yourself when you want a dead guard to break the build.
- **`nonConvergingRegions`** lists only *justified* entries: either the region declares
  no final sub-state and no nested composite at all (structural — the engine can never
  raise that join), or the region was entered, never reached a final sub-state, and
  coverage plateaued. Without a plateau the entry is omitted rather than reported as a
  maybe.
- **`warnings`** are typed (`no-payload`, `timer-escape`, `dead-events-at-plateau`,
  `uncovered-at-plateau`, `dead-guard-at-plateau`, `non-converging-region`,
  `residual-rejection`, `init-check-skipped`, `shrink-skipped`,
  `budget-progressing`, `budget-frozen`) so you can triage or relax by kind.

### Reproducing a finding

Every violation carries a `reproCode` snippet pinned to the seed. Re-run it with
`runs: 1` and the reported `seed` to replay the exact failing run against **your**
owner factory:

```ts
await checkMachine(myConfig, myOwnerFactory, { seed: '<the reported seed>', runs: 1 })
```

The sim cannot know your live owner's constructor, so `reproCode` references *your*
factory by name — wire it to the real one.

### Minimizing a finding — `shrink`

A seed-pinned repro replays the whole failing run: `steps` ops, of which perhaps
three matter. `shrink` (**on by default**) reduces that stream by delta-debugging —
dropping op chunks and binary-searching each `advance` toward `0` — and re-driving
each candidate against *your live config on a fresh owner*. Only the first reported
violation is minimized, and only a run that already failed pays for it; a green
sweep spends zero extra runs.

```ts
// defaults shown; both fields are optional
await checkMachine(cfg, factory, { shrink: { budget: { maxRuns: 200, maxStagnantRounds: 2 } } })
await checkMachine(cfg, factory, { shrink: false })   // opt out
```

The result lands on `violations[i].minimal`:

```ts
{
  ops: ({ kind: 'fire'; event; args?; argsNote? } | { kind: 'advance'; dtMs } | { kind: 'noop' })[]
  trace: TraceFrame[]                                    // the trace of the final verification replay
  provenance: { runs: number; moves: number; minimal: boolean }
}
```

`provenance.minimal: false` means "verified, but the budget ran out before
1-minimality was proven" — it never means unverified. When every argument has a
literal form, `reproCode` becomes an executable `script: [...]` call you can paste
back; when a payload is a live object with no literal form (a class instance, a
`Date`, a cycle) the op is flagged `argsNote: 'non-serializable'`, the snippet falls
back to its seed-pinned form and lists the minimal ops in order, and the real values
stay available on `minimal.ops`. That degrades the printed snippet only — never the
reduction, because payloads ride along in memory.

**Verify-first is the contract.** Before any reduction is attempted, the *recorded*
stream is replayed on a fresh owner. If the original finding does not come back, the
run is not reproducible from its op stream alone — a payload the machine mutates in
place, or a config reading state outside the owner (an external counter, a real
clock, module-level state) — and minimization abstains: no `minimal` is published,
and a `shrink-skipped` warning says why. The same abstention covers a live-`Adapter`
owner (a copy would lose its get/set semantics), an initial-configuration finding
(there is no op stream to reduce), and a reduced stream that fails its final
re-verification. A missing minimal repro is honest; a fabricated one would send you
to bisect the wrong thing.

The same op stream is a first-class input: `script` drives every run from a fixed
sequence instead of the fuzzer, which is exactly what a printed minimal repro pastes
back. Under a `script` the per-event `payload` generators are not consulted — the
script's `fire` ops already carry materialized args.

---

## Real timers

`checkMachine` runs on a **virtual** scheduler; time only advances deterministically.
If your `onEnter`/`invoke` arms a **real** `setTimeout`, it escapes the virtual
clock — quiescence can't see it, and the run is no longer deterministic. This
surfaces as a `timer-escape` warning and (by default) the `escape` fail cause. Use
the injected scheduler (the library's timer seam) instead of a bare `setTimeout`.
Override with `onRealTimerEscape: 'ignore' | 'warn' | 'fail'`.

---

## Run-to-completion and the settle budget

Every step ends by draining the machine to quiescence: queues empty, nothing in
flight, no timer pending. The drain is bounded — it pumps microtasks for at most
`maxTurns` turns, **default 1024** — so a wedged machine can never hang the run. A
boundary that did not reach quiescence records *why*, as `settleReason` on its
trace frame.

Two of those reasons say the harness ran out of budget. **Neither is a verdict.**
Both are advisory warnings, and `ok` is unaffected by either:

- **`budget-progressing`** — the pump ran out while the machine was *still*
  observably moving. A long legal chain of zero-delay `invoke` hops does exactly
  this: each hop costs a stabilisation window, so on the order of forty of them
  exhaust the default budget. The machine was working when the run stopped watching
  it, and the drain continues on the following steps.
- **`budget-frozen`** (`settleReason: 'microtask-budget'`) — the pump ran out and
  the machine's observable state had already stopped changing before it did. This
  is *compatible with* a wedge, and also with a hook doing a large amount of
  internal work; see the gap below for why the harness cannot tell them apart.

The two are separated by *recency* — how many turns passed since the observable
state last changed. The threshold is four stabilisation windows (64 turns), capped
at half `maxTurns` so a small per-call budget cannot make the test trivially true.
16 turns is the largest gap **measured** on the zero-delay chain fixtures, not a
bound anything guarantees, which is precisely why the result is advisory.

The other reasons describe a settle waiting on *time* rather than on the budget,
and those the pump reaches at its own early break, **inside** budget — they are
things it observed, not things it ran out of time to disprove. `WAITING_ON_TIMER`
(nothing pending, only a future timer) and `WAITING_ON_TRANSITION_TIMEOUT` (a
genuine in-flight async action racing a future deadline) are legitimate and
excluded; `WAITING_ON_INTERNAL` — queued or in-progress work with no in-flight
async behind it, alongside an armed timer — is a real run-to-completion concern and
is where `I-3`'s teeth live.

### `maxTurns`

`maxTurns` (on both `checkMachine` and `runSimulation`) sets the per-macrostep pump
budget. **Default 1024.** Raise it when a run reports either budget warning and you
need to know which reading is the real one: work that is finite completes at a
larger budget, and a genuine wedge reports the same thing at every budget you try.
Cost is bounded by the value — one microtask turn each.

### Known gap — a budget-truncated observation cannot convict

**No finding may rest on the drain having run out of turns.** Both budget reasons
are warnings, and neither reaches an invariant, a liveness verdict or a fail cause.
The reason is general: at the cutoff the harness holds a *prefix* of the machine's
behaviour, and for any prefix a truncated run can produce, a **correct** machine
exists that produces a byte-identical one. Convicting on a prefix therefore
convicts correct machines. Two concrete witnesses:

**A slow hook.** `s0 -E-> h1 -(invoke delay:0)-> slow`, where `slow.onEnter` is
`async () => { for (let i = 0; i < N; i++) await Promise.resolve() }` — a hook that
does a long but strictly finite amount of internal work and then returns. The
machine reaches `slow` for every `N`. But the settle fingerprint is
`queueDepth | isProcessingEvents | inFlightAsyncCount`, and an awaited `onEnter` is
deliberately *not* counted as in-flight async (it is awaited where
`isProcessingEvents()` is already true, so the structural conjunct normally covers
it). While the hook runs, all three components are frozen and no timer is armed —
exactly what a wedge looks like. Under the earlier rule this machine passed at
`N = 100` and failed at `N = 1000`, with an `I-3` violation and a
`TIMEOUT_BUDGET_EXCEEDED` livelock. The only thing that changed between those two
runs was the internal turn budget.

**A zero-delay livelock.** `A -(invoke delay:0, raise e)-> B -(invoke delay:0,
raise e)-> A`, forever. Genuinely broken — and still not convictable, because the
correct machine with the same topology plus a counter that exits the loop after
more iterations than the budget can reach produces the identical prefix.

Note *why* they are indistinguishable, since one plausible objection does not hold:
it is **not** that the deciding state is unreadable. Owner data *is* readable —
`checkMachine` builds a payload snapshot from the adaptee and hands `ownerData(...)`
to your invariants, so a loop counter in the owner is visible to the harness. The
argument is different, and stronger. Reading the counter still does not tell the
harness whether the guard's threshold is ever reached: that is a question about the
machine's *future*, and answering it means running the machine to completion —
which is the thing the budget prevents. (Closure and module-scope state is
genuinely unreadable on top of that, but the gap does not depend on it.)

**You can usually resolve it and the harness cannot.** Two knobs, and they work
differently:

- `maxTurns` raises the per-macrostep budget directly. This is the one that
  separates the two readings of a *frozen* fingerprint: finite work completes at a
  larger budget, an infinite wedge does not.
- `steps` gives the machine more macrosteps, and the drain resumes on each. This is
  the one for a *progressing* chain: a 200-hop zero-delay chain reaches `h36` at
  `steps: 1`, `h108` at `steps: 2` and its final state at `steps: 6`.

Either way the shape of the answer is the same: a finite computation settles at
*some* budget, a genuine livelock reports the same warning at every value you try.
That is the signal to go looking.

Note also what the zero-false-positive corpus does **not** prove here. It never
enters the exhaustion path at all — pinning the trace-header version back and
watching the hash table pass unchanged is the direct evidence (see the note above
`CORPUS_HASHES` in `payload_substrate.test.ts`). A corpus that never reaches a code
path is not evidence about that path.

Separately: a machine that drives itself through unbounded zero-delay `invoke` hops
is outside the macrostep contract to begin with. A macrostep is meant to converge;
`checkMachine` bounds the drain so such a machine cannot hang the run, but it does
not promise to classify one.

---

## What `checkMachine` does NOT check

- **Full reachability / exhaustiveness** — it is a fuzzer, not a model checker.
- **Argument-dependent branches** without a `payload` generator.
- **Semantic correctness of the SELECTION rule itself** — the builtins verify your
  machine against the library's SCXML/UML-flavoured selection semantics; they do
  **not** re-derive the standard (see the selection spec for the intersection).
- **Real-world timing / wall-clock behaviour** — the clock is virtual.
- **Anything outside the state machine** — side effects in actions are only observed
  through the owner data your invariants inspect.
- **Callback order for states with no hooks, and outside a microstep.** The `I-4`
  oracle checks that enter hooks run ancestor-before-descendant and exit hooks the
  other way, but it can only compare callbacks that were actually *emitted*: a state
  with no hook is invisible to it, and the reserved `microstep 0` used by
  construction, `reset` and `resumeTimers` is skipped, because those are unrelated
  passes that would compare against each other.
- **A join whose composite is left again within the same macrostep.** The `I-5`
  oracle catches an all-final composite whose `done.state.<C>` was never raised, by
  comparing per-boundary completion samples against the engine's raise records. If a
  composite becomes all-final and its join transition carries the machine out of it
  before the next settle boundary, no boundary ever samples it as done and the check
  is vacuous there. Like `I-4`, it under-reports by construction — neither oracle can
  manufacture a violation on a correct machine.

Treat a clean `checkMachine` as *"no defect found within the fuzzed envelope"*, not
*"proven correct"* — and grow the envelope (alphabet, payloads, `runs`, `steps`,
`invariants`) as your confidence bar rises.
