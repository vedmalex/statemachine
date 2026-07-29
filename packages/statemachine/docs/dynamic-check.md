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
  `budget-progressing`, `budget-frozen`, `rtc-unobserved`, `lifecycle-truncated`)
  so you can triage or relax by kind. The last four are OBSERVABILITY findings —
  they say how much of the run got checked, not that anything was rejected — and
  each keeps its own kind rather than collapsing into `residual-rejection`, which
  names a completely different and much more alarming condition.

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
flight, no timer pending. The drain's microtask **pump** is bounded — at most
`maxTurns` turns, **default 1024** — so no amount of internal microtask churn can
spin the run forever. A boundary that did not reach quiescence records *why*, as
`settleReason` on its trace frame.

That bound covers the pump, and **not** the `fireEvent` call the step makes before
it. The driver awaits `sm.fireEvent(...)` with no deadline of its own, so a
transition whose `onEnter` never resolves parks that await and the step never
returns. Nothing rescues it: the virtual clock only advances inside a settle, and
the settle is downstream of the await that is parked, so a configured
`transitionTimeout` never gets its timer processed and `mode: 'liveness'` never
reaches its clock jump. Measured — a machine with
`stuck: { onEnter: () => new Promise(() => {}) }` never returned from `step()` in
any of the four combinations (`safety`/`liveness` × with/without
`transitionTimeout: 50`). **The real property is: the pump cannot spin forever;
a callback that never settles can still hang the run.** The defence is on your
side of the boundary — every `onEnter` / `onExit` / guard / invoke action must
eventually settle, and `transitionTimeout` bounds them under the *engine's* own
drain (where it does work, converting a hung callback into an observable reject),
not under a simulator step already parked on the fire.

Three of the settle reasons say the harness stopped watching. **None is a
verdict.** All three are advisory warnings, and `ok` is unaffected by any of them:

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

- **`rtc-unobserved`** (`settleReason: 'WAITING_ON_INTERNAL'`) — the pump stopped at
  its *early* break: work still pending, a future timer armed somewhere, and nothing
  the harness can see in flight. Read it as a pointer to one macrostep, never as a
  verdict; the section below says why.

`WAITING_ON_TIMER` (nothing pending, only a future timer) and
`WAITING_ON_TRANSITION_TIMEOUT` (a genuine in-flight async action racing a future
deadline) describe a settle waiting on *time*. Both are legitimate, both are
excluded from every oracle, and neither raises a warning.

### Why `WAITING_ON_INTERNAL` cannot convict either

It was the last reason that could, through `I-3`, and it was justified on the
grounds that the pump reaches it at its own *early* break — `pending && stuck >= 16
&& a timer is armed` — rather than by exhausting the budget: something the harness
observed, not something it ran out of time to disprove. That argument does not
survive contact with the engine.

The break's entire observational content is *the fingerprint has not moved for 16
turns and some timer is armed*. That is the same frozen-prefix object a budget
exhaustion produces, over a window 64× smaller, and the armed timer can belong to a
completely unrelated parallel region. And `stuck` counts turns over the frozen
`queueDepth | isProcessingEvents | inFlightAsyncCount` fingerprint — which stays
frozen across an **entire ordinary microstep**, because the engine awaits once per
hook slot per state even where you defined no hook. One *legitimate* microstep's
frozen-turn count is therefore a function of your machine's own width, unbounded and
config-dependent, measured at roughly one turn per hook-free region and about eight
per synchronous hook. A fixed 16-turn window against an unbounded legitimate chain
is refuted by any correct machine whose legitimate chain runs 17 turns.

Measured, through `runSimulation` (seed `'1'`, `steps: 2`, `mode: 'safety'`). Take a
parallel composite where one region steps `h1 -(invoke delay:0)-> slow` and one
*other* region merely holds `invoke: [{ event: 'never', delay: 100000 }]` — an armed
timer that never fires under `'safety'` and that nothing else touches:

```
slow.onEnter SYNCHRONOUS            ok=false  I-3  WAITING_ON_INTERNAL
slow.onEnter async, 1 microtask     ok=false  I-3  WAITING_ON_INTERNAL
slow.onEnter async, 3 / 5 / 20      ok=false  I-3  WAITING_ON_INTERNAL
the same machine, no sibling timer  ok=true        (clean)
```

Every one of those reaches `slow` in the same trace. Note the first row: the hook is
*synchronous*, so there is no async span of any kind to observe — no in-flight
counter of any design could have separated it. The deciding variable was an
unrelated region's deadline plus an internal constant.

The general shape: `stuck` is a proxy for *the engine has no scheduled
continuation*, and that is not observable from outside. Every fixed-window proxy for
it is a truncation, and every truncation is refuted by a correct machine whose
legitimate frozen chain is one turn longer than the window.

**What would make it decidable** — so this reads as a scoped gap rather than a
shrug. Two things, together: live spans covering *every* engine `await` of user code
(the lifecycle channel already brackets enter/exit hooks, guards and invoke actions,
but not the transition-level `onTransition` nor the event-level `onBefore` /
`onAfter`), and an engine progress heartbeat with a **code-constant** gap bound —
so "no progress for N turns" could be compared against a number the engine
guarantees rather than one the machine's width determines. Neither exists today.

`I-3` (run-to-completion) is consequently **opt-in**, not part of the default oracle
set. With every documented settle reason excluded it has no witness a real machine
can produce, and an inert oracle carrying a default badge inflates both `oraclesRun`
and the assurance a green run implies. Removing it costs nothing measurable: the
zero-false-positive corpus that was cited as the standing guard for its promotion
records 438 frames of which 6 are non-quiescent, and every one of those is
`WAITING_ON_TIMER` — the corpus never entered the region the teeth lived in. The
real hang class stays covered by the engine's own `transitionTimeout` and by the
liveness plane's virtual-time budget. If you still want those frames flagged, pass
it explicitly through `runSimulation`'s `invariants` option — the registry is
exported as `INVARIANTS`, so `invariants: INVARIANTS.filter((i) => i.id === 'I-3')`
selects it.

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

"No timer is armed" is true of *that* fixture and false of the class, and the
difference is the more important fact. **Arm one unrelated timer anywhere and the
same machine moves from a warning to a conviction** — because the pump then leaves
by its early, 16-turn break instead of by budget exhaustion, and that break used to
convict. Put the same `slow` in one region of a parallel composite whose *other*
region merely holds `invoke: [{ event: 'never', delay: 100000 }]`, and the run
reported `ok:false` with an `I-3` violation for a **synchronous** `onEnter`, and for
an async one awaiting 1, 3, 5 or 20 microtasks — while the identical machine without
that sibling region was clean. The deciding variable was never the hook. The
"Why `WAITING_ON_INTERNAL` cannot convict either" section above closed that path,
and it is the reason `I-3` is opt-in.

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
`checkMachine` bounds the drain so such a machine cannot spin the pump forever, but
it does not promise to classify one — and, per the note at the top of this section,
a callback that never settles is a different thing that the bound does not reach.

---

## A throwing `invoke` action now fails the run

An `invoke` action that throws is routed to `monitor.recordError`, and the simulator
turns any `errorCount > 0` on a fault-free run into a synthetic `engine-error`
violation that forces `ok: false`. That routing reaches call sites it did not reach
before, so a machine that was **silently green** here can now be red without you
having changed it.

The tightening is deliberate — an action that throws is a defect the run should not
swallow — but it is a behaviour change worth stating plainly. Measured: a
timer-form `invoke: [{ delay: 0, event: 'n1', action: () => { throw … } }]` reports
`ok:false` with `engine runtime error during simulation: engine recorded 1 runtime
error(s) via monitor.recordError`, even though the machine still reaches the target
state (the invoke's event is raised regardless of the action's outcome). If you see
this on a machine you believe is correct, the throw is real — look at the action,
not at the harness.

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
