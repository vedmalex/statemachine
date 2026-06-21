# @vedmalex/statemachine

[![CI](https://github.com/vedmalex/statemachine/actions/workflows/ci.yml/badge.svg)](https://github.com/vedmalex/statemachine/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@vedmalex/statemachine?label=npm)](https://www.npmjs.com/package/@vedmalex/statemachine)

Hierarchical state machine for TypeScript with orthogonal (parallel) regions, SCXML/UML entry-exit semantics, monitoring, validation, and persistence.

**Features:**

- Hierarchical (nested) states addressed by dotted paths
- Orthogonal **parallel regions** with SCXML ancestor-first entry / descendant-first exit
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

const sm = createMachine({
  name: 'door',
  initialState: 'closed',
  states: { closed: {}, open: {} },
  events: { open: { transitions: [{ from: 'closed', to: 'open' }] } },
})
```

## Hierarchical regions, parallel states & join

A state may declare `regions` to run several orthogonal sub-machines at once. Entry/exit follow SCXML/UML ordering, and a region may complete via a `final` state that raises a `done.state.<id>` join event.

```ts
const sm = createMachine({
  name: 'proc',
  initialState: 'proc',
  states: {
    proc: {
      initial: 'a.run|b.run',          // both regions active in parallel
      onEnter: () => {/* parent runs BEFORE region children (ancestor-first) */},
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
})
```

- **Expansion** — entering `proc` (as initial state *or* via a transition) expands to the parallel configuration `proc.a.run|proc.b.run`.
- **Ordering** — entry is ancestor-first (`proc` then region children); exit is descendant-first (region children then `proc`).
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

## Documentation

Full API documentation: [https://vedmalex.github.io/statemachine/](https://vedmalex.github.io/statemachine/)

## Extension Points

This package exposes 7 extension points (`IMonitor`, `ITimerScheduler`, `IErrorHandler`, `Adapter<T>`, `ILogger`, `StatePersistenceAdapter`, `validateConfig`) for host integration. Callbacks resolved from config or `setContext()` receive the underlying owner object directly, so host code does not need to unwrap `Adapter<T>` inside each callback. See [`docs/extension-points.md`](./docs/extension-points.md) for the full catalog.

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

The `transitionTimeout` deadline is also routed through the injected scheduler, so it triggers on a virtual-time advance rather than a real timer:

```ts
const sm = new StateMachine(config, adapter, { clock, scheduler, transitionTimeout: 500 })
const fired = sm.fireEvent('go')   // enters a state whose action never resolves
await Promise.resolve()
t = 500
scheduler.process()                // the race rejects deterministically
await expect(fired).rejects.toThrow(/timeout/i)
```

When the action wins the race instead, the pending timeout token is auto-cancelled so no ghost rejection fires on a later `process()`.

### Back-compatibility

> Omitting **both** `clock` and `scheduler` keeps runtime behavior byte-identical to prior releases: `createDefaultScheduler()` uses `Date.now`, the `isActive()`-gated `setTimer` fallback to native `setTimeout` is unchanged, and `process()`'s default argument resolves to the same value it did before. The DST machinery only engages when you opt in by injecting a scheduler.

### API reference

| Symbol | Kind | Purpose |
| --- | --- | --- |
| `createVirtualScheduler(clock)` | function | Build a deterministic, non-real-time `ITimerScheduler`. |
| `Clock` | type | `() => number`; matches the `clock` option signature. |
| `StateMachineOptions.clock?` | option | Inject a virtual clock (default `Date.now`). |
| `ITimerScheduler.process?(now?)` | method | Optional manual drain; implemented by `createVirtualScheduler`. |

## Stability policy

5 firm `@stable` symbols: `createMachine`, `StateMachine`, `StateMachineConfig`, `Transition`, `State`. The all-regions-final join API lives on these stable symbols — `State.final?: boolean`, `StateMachine.isDone(compositeId)`, and the engine-raised `done.state.<id>` event (all reflected in `etc/statemachine.api.md`). Other exports are `@unstable` and may evolve between minor versions. See [`STABILITY.md`](./STABILITY.md) for the full policy.

## Status & module format

`1.0.0-beta.x` (current published version: see the npm badge above; both the `latest` and `beta` dist-tags track the newest release). Stability: experimental. SCXML/UML parallel regions, ancestor-first / descendant-first ordering, and the all-regions-final join landed in **`1.0.0-beta.2`**. The full API surface is `@unstable` per the package's STABILITY policy except the 5 firm `@stable` symbols; per-symbol stability tagging completes before `1.0.0` stable.

**Module format**: ESM + CJS dual bundle (TASK-005). `require('@vedmalex/statemachine')` works in CommonJS runtimes via `dist/index.cjs`. `import` works via `dist/index.js`. The `exports` map resolves automatically.

## Known gaps in 1.0.0-beta

- **Multi-runtime CI (Tier B)**: Deno + Browser smokes run with `continue-on-error: true` and are tracked for full enablement at stable 1.0.0.

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
