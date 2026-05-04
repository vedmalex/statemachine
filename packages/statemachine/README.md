# @vedmalex/statemachine

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

## Status & module format

`1.0.0-beta.x`. Stability: experimental. The full API surface is currently `@unstable` per the package's STABILITY policy; per-symbol stability tagging arrives before `1.0.0` stable.

**Module format**: ESM-only in beta. CJS consumers calling `require('@vedmalex/statemachine')` will receive `ERR_REQUIRE_ESM` from Node. Use dynamic import (`await import('@vedmalex/statemachine')`) or migrate to ESM. CJS bundle arrives in a follow-up release alongside multi-runtime CI.

## Known gaps in 1.0.0-beta

- **CJS bundle**: ESM-only in this beta. CJS arrives via bundler in a follow-up task.
- **Multi-runtime CI**: Bun + Node 20 LTS verified now; Browser + Deno tracked for stable 1.0.0.

## Known internal debt (Phase 1)

The Phase 1 bootstrap copied several modules as-is from the legacy `@grainjs/statemachine` source. They are functionally correct for `1.0.0-beta.x` consumers but carried singleton patterns that blocked WASM/Zig portability and cross-runtime hosting. Each item has been resolved in TASK-004:

- **`TimerScheduler.getInstance()`** — removed in TASK-004 (singleton elimination); use `createDefaultScheduler()` or inject via `StateMachineOptions.scheduler`.
- **`globalStateMachineMonitor`** — removed in TASK-004 (ISS-007 + ISS-008); use `createDefaultMonitor()` or inject via `StateMachineOptions.monitor`.
- **`globalErrorHandler`** — removed in TASK-004; use `createDefaultErrorHandler()` or inject via `StateMachineOptions.errorHandler`.

- **WASM/Zig port architectural commitments** — see `docs/zig-port-considerations.md` for the patterns this package commits to (no module-level mutable state, injection contracts, factory defaults).

## Build-time constraints

- **`tsconfig.moduleResolution = "bundler"`** — TASK-003 TD-T3-5 / F-CR-4 conditional closure. Downstream tasks (TASK-005 CI/CD + CJS) MUST keep an import-rewriting bundler (`tsup`, `esbuild`, `rollup` with `node-resolve`, `vite build` library mode). Flipping to a non-rewriting toolchain (raw `tsc --module commonjs`) requires upgrading `moduleResolution` to `"node16"`/`"nodenext"` first and migrating all internal imports to use `.js` extensions explicitly.
- **knip ignore-list cap = 5 entries** — TASK-003 PLAN F-PL-5 governance. Adding a 6th ignore requires either removing an existing one OR opening a new DA review against the Sustainability lens. Currently 2/5 used (`ValidationConfig`, `MonitoringConfig`).
- **`@stable` public surface** — 5 firm symbols (`createMachine`, `StateMachine`, `StateMachineConfig`, `Transition`, `State`). Changing their signatures is a 1.0.0-stable breaking change. The `src/tests/public_surface.test.ts` ratchet test enforces non-regression at CI time.

A full review trail for Phase 1 lives in the MB3 work tree (see root README): `memory-bank/tasks/2026-05-03_TASK-002_.../code-review.md` (bootstrap) and `memory-bank/tasks/2026-05-03_TASK-003_.../code-review.md` (quality baseline).

## License

MIT — see LICENSE.
