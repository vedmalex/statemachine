# @vedmalex/statemachine

[![CI](https://github.com/vedmalex/statemachine/actions/workflows/ci.yml/badge.svg)](https://github.com/vedmalex/statemachine/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@vedmalex/statemachine?label=npm)](https://www.npmjs.com/package/@vedmalex/statemachine)

Hierarchical state machine for TypeScript with monitoring, validation, and persistence.

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

See [`docs/regions-and-parallel.md`](./docs/regions-and-parallel.md) for the full model, ordering rules, and validation.

## Documentation

Full API documentation: [https://vedmalex.github.io/statemachine/](https://vedmalex.github.io/statemachine/)

## Extension Points

This package exposes 7 extension points (`IMonitor`, `ITimerScheduler`, `IErrorHandler`, `Adapter<T>`, `ILogger`, `StatePersistenceAdapter`, `validateConfig`) for host integration. Callbacks resolved from config or `setContext()` receive the underlying owner object directly, so host code does not need to unwrap `Adapter<T>` inside each callback. See [`docs/extension-points.md`](./docs/extension-points.md) for the full catalog.

## Stability policy

5 firm `@stable` symbols: `createMachine`, `StateMachine`, `StateMachineConfig`, `Transition`, `State`. Other exports are `@unstable` and may evolve between minor versions. See [`STABILITY.md`](./STABILITY.md) for the full policy.

## Status & module format

`1.0.0-beta.x`. Stability: experimental. The full API surface is currently `@unstable` per the package's STABILITY policy; per-symbol stability tagging arrives before `1.0.0` stable.

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
