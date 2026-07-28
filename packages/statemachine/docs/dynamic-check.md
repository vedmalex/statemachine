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
| `livelock` | the liveness plane found a no-progress cycle / budget overrun |
| `no-progress` | `transitionsFired === 0` — the machine never moved |
| `escape` | a real (non-virtual) timer escaped the scheduler (see below) |
| `degradation` | a dead event / uncovered transition survived a **saturated** coverage sweep |
| `non-converging` | a parallel region never reaches its join (reserved) |

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

> **MVP note.** Object-valued payloads are not yet driven end-to-end; today the
> generator is the documented extension point and the `no-payload` warning is the
> honest signal that arg-branches are uncovered. See task **W5c** for the payload
> substrate.

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
  saturation: { plateauedAtRun: number | null; newCoveragePerRun: number[] }

  // structural findings
  deadlocks: { state }[]
  livelocks: { reason }[]

  // violations & warnings
  violations: { invariant; kind: 'engine'|'builtin'|'user'; witness; reproCode }[]
  warnings: { kind: WarningKind; detail: string }[]
  failedOn: FailCause[]        // empty ⇒ ok
}
```

- **`unreachableStates`** is *reported, not failed* — a state can be dead by design.
- **`saturation`** answers "did I fuzz enough?": once `plateauedAtRun` is non-null,
  more runs stopped finding new coverage, so a remaining `deadEvents` /
  `uncoveredTransitions` is a genuine gap (that is what turns them into a
  `degradation` fail) rather than "not reached yet".
- **`warnings`** are typed (`no-payload`, `timer-escape`, `dead-events-at-plateau`,
  `uncovered-at-plateau`, `residual-rejection`) so you can triage or relax by kind.

### Reproducing a finding

Every violation carries a `reproCode` snippet pinned to the seed. Re-run it with
`runs: 1` and the reported `seed` to replay the exact failing run against **your**
owner factory:

```ts
await checkMachine(myConfig, myOwnerFactory, { seed: '<the reported seed>', runs: 1 })
```

The sim cannot know your live owner's constructor, so `reproCode` references *your*
factory by name — wire it to the real one.

---

## Real timers

`checkMachine` runs on a **virtual** scheduler; time only advances deterministically.
If your `onEnter`/`invoke` arms a **real** `setTimeout`, it escapes the virtual
clock — quiescence can't see it, and the run is no longer deterministic. This
surfaces as a `timer-escape` warning and (by default) the `escape` fail cause. Use
the injected scheduler (the library's timer seam) instead of a bare `setTimeout`.
Override with `onRealTimerEscape: 'ignore' | 'warn' | 'fail'`.

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

Treat a clean `checkMachine` as *"no defect found within the fuzzed envelope"*, not
*"proven correct"* — and grow the envelope (alphabet, payloads, `runs`, `steps`,
`invariants`) as your confidence bar rises.
