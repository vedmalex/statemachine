# @vedmalex/statemachine

[![CI](https://github.com/vedmalex/statemachine/actions/workflows/ci.yml/badge.svg)](https://github.com/vedmalex/statemachine/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@vedmalex/statemachine?label=npm)](https://www.npmjs.com/package/@vedmalex/statemachine)

Hierarchical state machine for TypeScript with orthogonal (parallel) regions, SCXML/UML entry-exit semantics, monitoring, validation, and persistence.

**Features:**

- Hierarchical (nested) states addressed by dotted paths
- Orthogonal **parallel regions** with W3C SCXML §3.13 callback ordering — entry in document order, exit in reverse document order
- **UML all-regions-final join** via `final` states, the engine-raised `done.state.<id>` event, and the `isDone()` guard
- Parallel-exit (LCCA) — a transition from a composite parent preempts and exits all active regions
- Guards, before/enter/after + exit/transition actions, and timed `invoke` transitions
- Pluggable monitoring, validation, persistence, and timer scheduling (7 extension points)
- ESM + CJS dual bundle; DI-free lite surface

The package ships only the DI-free lite surface. The legacy DI-aware factory from `@grainjs/statemachine` is intentionally not carried over.

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

## Driving several objects with one machine

One machine can drive many owner objects, but `fireEvent` cannot express that
unambiguously: a non-`Adapter` second positional is an event **argument** — that is
what makes `fireEvent('submit', payload)` work — so a raw object passed as an owner
is read as a payload and the event resolves against the machine's primary owner
instead. (When that object carries the machine's `stateAttribute`, the engine emits
an advisory warning through the injected `logger`; the argument is still forwarded
verbatim, so a payload that happens to have the field keeps working.)

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

`fireEvent` itself is unchanged.

## Action timeouts (`transitionTimeout`)

`StateMachineOptions.transitionTimeout` is a **per-action** budget, not a per-transition or per-microstep one. Every individual action call races its own deadline: guards, `onBefore` / `onAfter`, the `onExit` / `onEnter` state hooks, `onTransition`, and `invoke` actions.

**The consequence to budget for.** One event fires one transition **per region** in a single microstep (see [Hierarchical regions, parallel states & join](#hierarchical-regions-parallel-states--join)), and each of those transitions runs its own hook chain. A microstep of N transitions × K hooks therefore gets N×K *separate* deadlines, and `transitionTimeout` does **not** bound the microstep's total duration — three regions running three 40 ms hooks each complete in ~370 ms under a 100 ms `transitionTimeout`. Read the option as "no single callback may hang longer than this", never as "an event settles within this".

On expiry the call rejects with `StateMachineError('Transition timeout')` (`context.phase === 'action'`). The timed-out action is **not** cancelled — it runs to completion and its side effects still land, after the machine has already unwound. What you observe depends on which hook expired:

| expired hook | observable outcome |
| --- | --- |
| `guard` | transition disabled; `fireEvent` resolves `false`, nothing thrown |
| `onEnter`, with `errorState` set | machine commits `errorState`; `fireEvent` resolves `false` |
| `onExit`, with `abortOnExitError` set | microstep aborts back to the source state; `fireEvent` resolves `false` |
| `invoke` action | the invoke's `event` is **not** raised and the machine stays put, but the expiry is reported: `monitor.recordError` and the config-level `onError` both receive the `StateMachineError` (`context.phase === 'action'`). Nothing is thrown — the invoke timer callback has no caller to catch it |
| anything else (`onBefore`, `onTransition`, `onEnter` / `onExit` without the options above) | the error propagates out of `fireEvent`; the machine stays in the source state |

An `invoke` action that **throws** is reported through those same two channels, so an expiry and a throw of the same action are indistinguishable to an error sink — an expiry is just one more way the action failed. (Long-running `invoke` operations — the `src` / `onError` form — keep their own routing: a declared `onError` event wins, and only without one does the rejection fall through to `recordError`.)

The deadline timer is cancelled as soon as the race settles, on the default scheduler as well as an injected one (see [Deterministic testing](#deterministic-testing-dst)), so a fast action leaves nothing pending behind it.

## Documentation

Full API documentation: [https://vedmalex.github.io/statemachine/](https://vedmalex.github.io/statemachine/)

## Extension Points

This package exposes 7 extension points (`IMonitor`, `ITimerScheduler`, `IErrorHandler`, `Adapter<T>`, `ILogger`, `StatePersistenceAdapter`, `validateConfig`) for host integration. Callbacks resolved from config or `setContext()` receive the underlying owner object directly, so host code does not need to unwrap `Adapter<T>` inside each callback. See [`docs/extension-points.md`](./docs/extension-points.md) for the full catalog.

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
    mode: 'safety',            // 'safety' | 'liveness'
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
- `await sim.run()` — drive `opts.steps` macrosteps; returns the aggregate `SimResult` (`ok`, `seed`, `steps`, `traceHash`, `trace`, optional `violation`, `metrics`).
- `sim.snapshot()` — a serializable mid-run checkpoint (`SimSnapshot`: `seed`, `machine`, `prngState`, `t`, `step`); never hashed.

`wire(env, config, owner)` constructs `new StateMachine(config, owner, { clock, scheduler, monitor, errorHandler, logger })` with all five deterministic seams pre-forwarded from `env`, so the scheduler-omission footgun is structurally impossible.

### SimOptions

| Field | Type | Purpose |
| --- | --- | --- |
| `seed` | `bigint \| string` | Required. Drives the PRNG; the only source of nondeterminism. |
| `steps?` | `number` | Macrostep budget (default 16). |
| `faults?` | `FaultPlan` | Seed-keyed fault injection plan (see the 7 kinds below). |
| `invariants?` | `readonly Invariant[]` | Safety-oracle registry evaluated at each step boundary. |
| `mode?` | `'safety' \| 'liveness'` | Oracle policy (default `'safety'`). |
| `onTrace?` | `(frame: TraceFrame) => void` | Per-frame streaming callback. |

### Fault injection (7 kinds)

A `FaultPlan` may inject any of the seven fault kinds (`FaultKind`), keyed deterministically off the seed:

1. **reorder** — permute queued events
2. **drop** — discard a queued event
3. **dup** — duplicate a queued event
4. **overflow** — flood the queue past its bound
5. **clock-skew** — perturb the logical clock
6. **timer-jitter** — perturb armed-timer deadlines
7. **callback-throw** — make an action/guard/invoke callback throw

Fault-free runs behave exactly as a simulation with no plan.

### Seed → bit-exact replay & minimal repro

The same `seed` always produces the same trace and the same `result.traceHash`, so any failing run is replayable verbatim. On a violation, the delta-debugging shrinker reduces the failing run to a `MinimalRepro` — the smallest seed/step/fault subset that still reproduces the violation — and `buildMinimalRepro` / `emitRepro` emit a self-contained runnable repro test against this same public `./sim` surface.

### Back-compatibility

> Omitting **both** `clock` and `scheduler` keeps runtime behavior byte-identical to prior releases: `createDefaultScheduler()` uses `Date.now`, the `isActive()`-gated `setTimer` fallback to native `setTimeout` is unchanged, and `process()`'s default argument resolves to the same value it did before. The DST machinery only engages when you opt in by injecting a scheduler.

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
a structured `CheckReport` of unreachable states, deadlocks, livelocks, invariant
violations, and coverage gaps. The report's `ok` cannot lie — `ok === true` implies
`oraclesRun > 0 ∧ transitionsFired > 0`. **It is fuzzing, not model-checking:** the
absence of a finding is not a proof of correctness. Full guide, contract, and the
list of what it does NOT check: [`docs/dynamic-check.md`](./docs/dynamic-check.md).

```ts
import { checkMachine } from '@vedmalex/statemachine/sim'
const report = await checkMachine(myConfig, () => ({ state: 'idle' }), { seed: 'ci-1', runs: 32 })
if (!report.ok) throw new Error(`checkMachine failed: ${report.failedOn.join(', ')}`)
```

## Stability policy

5 firm `@stable` symbols: `createMachine`, `StateMachine`, `StateMachineConfig`, `Transition`, `State`. The all-regions-final join API lives on these stable symbols — `State.final?: boolean`, `StateMachine.isDone(compositeId)`, and the engine-raised `done.state.<id>` event (all reflected in `etc/statemachine.api.md`). Other exports are `@unstable` and may evolve between minor versions. See [`STABILITY.md`](./STABILITY.md) for the full policy.

## Status & module format

`1.0.0-beta.x` (current published version: see the npm badge above; both the `latest` and `beta` dist-tags track the newest release). Stability: experimental. SCXML/UML parallel regions, ancestor-first / descendant-first ordering, and the all-regions-final join landed in **`1.0.0-beta.2`**. The full API surface is `@unstable` per the package's STABILITY policy except the 5 firm `@stable` symbols; per-symbol stability tagging completes before `1.0.0` stable.

### BREAKING (callback ordering) — `1.0.0-beta.x`

Enter/exit callback order was brought to the W3C SCXML §3.13 norm: **entry = document order (DFS pre-order), exit = reverse document order**. Two observable changes:

1. `onExit` of **sibling states in parallel regions** now fires in the **reverse** of the declaration order (regions `r1, r2, r3` exit `r3 → r2 → r1`; previously `r1 → r2 → r3`).
2. **Nested regions are no longer interleaved.** The previous walk ordered the whole set by depth, so a shallow region's leaf could be visited *between* two states of another region's chain. Each region is now walked to completion, on both entry and exit.

The **set** of callbacks invoked and the **reached configuration** are unchanged — only the sequence. The layering guarantees (parent enters before its region children, exits after them) and the entry sibling order are unchanged. Order-independent `onExit` handlers — the common case — need no migration. Full detail and migration guidance: [docs/regions-and-parallel.md](./docs/regions-and-parallel.md#3-entryexit-ordering-scxml-313).

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

Detection is by feature probe, not a runtime name: the engine tries `process.getBuiltinModule('node:async_hooks').AsyncLocalStorage`, then a global `AsyncContext.Variable`, and verifies each with a live round-trip before accepting it. Deno lands in the precise tier because its Node-compat layer provides the first. A browser that ships `AsyncContext.Variable` will report `'async-context'` and get the precise tier automatically.

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

- **Multi-runtime CI (Tier B)**: Deno + Browser smokes run with `continue-on-error: true` and are tracked for full enablement at stable 1.0.0.
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
- **knip ignore-list cap = 5 entries** — TASK-003 PLAN F-PL-5 governance. Adding a 6th ignore requires either removing an existing one OR opening a new DA review against the Sustainability lens. Currently 2/5 used (`ValidationConfig`, `MonitoringConfig`).
- **`@stable` public surface** — 5 firm symbols (`createMachine`, `StateMachine`, `StateMachineConfig`, `Transition`, `State`). Changing their signatures is a 1.0.0-stable breaking change. The `src/tests/public_surface.test.ts` ratchet test enforces non-regression at CI time.

A full review trail for Phase 1 lives in the MB3 work tree (see root README): `memory-bank/tasks/2026-05-03_TASK-002_.../code-review.md` (bootstrap) and `memory-bank/tasks/2026-05-03_TASK-003_.../code-review.md` (quality baseline).

## License

MIT — see LICENSE.
