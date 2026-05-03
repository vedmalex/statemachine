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

The Phase 1 bootstrap copied several modules as-is from the legacy `@grainjs/statemachine` source. They are functionally correct for `1.0.0-beta.x` consumers but carry singleton patterns that block WASM/Zig portability and cross-runtime hosting. Each item is bound to its planned owner task in the standalone-evolution roadmap (RM-001):

- **`TimerScheduler.getInstance()`** in `src/scheduler.ts` — module-level singleton — owner: TASK-004 (singleton elimination).
- **`globalStateMachineMonitor`** in `src/monitoring.ts` and the `IMonitor` interface signature mismatch — tracked as `ISS-007` (signature alignment) and `ISS-008` (singleton removal) — owner: TASK-004.
- **`globalErrorHandler`** re-exported from `src/index.ts` via `error_handling.ts` — owner: TASK-004.

A full review trail (Sustainability lens) for the Phase 1 bootstrap lives at `memory-bank/tasks/2026-05-03_TASK-002_core-extraction-and-monorepo-bootstrap/code-review.md` in the MB3 work tree (see root README).

## License

MIT — see LICENSE.
