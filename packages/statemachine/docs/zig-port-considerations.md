# Zig/WASM Port Considerations

This document captures TASK-004 architectural commitments that downstream
RM-001-P02 (zig-wasm-port) builds on.

## §1 Architectural prerequisites

The package commits to:
- No module-level mutable state (post-TASK-004 enforcement).
- Dependency injection via `StateMachineOptions` (`monitor`, `scheduler`, `errorHandler`).
- Pure factory functions for defaults (`createDefaultMonitor`, `createDefaultScheduler`, `createDefaultErrorHandler`).
- Three injection-contract interfaces: `IMonitor`, `ITimerScheduler`, `IErrorHandler` — these are the WASM-host extension points.
- All defaults construct fresh instances; no caching at module scope.

## §2 TS-vs-WASM access modifier divergence

`TimerScheduler` formerly carried `private constructor()`. TypeScript enforces access
modifiers at compile time within the module's scope; the same-module factory
`createDefaultScheduler()` invokes the constructor (TS allows same-lexical-scope
invocation of private constructors). As of TASK-004 the constructor is `public`
(the singleton was the only reason it was private).

WASM/Zig has no analogue to TypeScript access modifiers: the Zig port should rely
on module-internal-only exports for visibility control rather than language-level
access modifiers.

## §3 Mutable-state audit (best-effort baseline)

Patterns surveyed in `src/` that the Zig port may need to re-evaluate:
- Class-instance fields with mutation (e.g., `StateMachine.currentState`, `TimerScheduler.tasks`)
  — these are per-instance, WASM-friendly given dependency injection.
- Closure-captured `let` in event handlers — limited usage; spot-check during port.
- `private static` fields are absent post-TASK-004 (verified by Step 6 invariant test
  in `src/tests/singleton_elimination.test.ts`).

The audit is not exhaustive; Phase 2 (RM-001-P02) is responsible for the full sweep.

## §4 Per-instance observability trade-off

Lazy default-construction means each `StateMachine` gets its OWN
`monitor`/`scheduler`/`errorHandler` instance. Cross-machine aggregate
observability (which the legacy `globalStateMachineMonitor` provided) is no
longer the default. Recommended pattern for hosts needing aggregation:

```ts
import { createDefaultMonitor, createMachine } from '@vedmalex/statemachine'

const sharedMonitor = createDefaultMonitor()
const machineA = createMachine({ ..., monitor: sharedMonitor })
const machineB = createMachine({ ..., monitor: sharedMonitor })
// sharedMonitor.getMetrics?.() now reflects events from both machines
```

## §5 Open questions for the actual Zig port (deferred to RM-001-P02)

- Timer host integration: how does Zig express `setTimeout` semantics?
  `ITimerScheduler.schedule(delay, callback)` is the abstraction; concrete
  implementation is host-specific.
- GC vs manual memory: WASM's linear memory + Zig's manual allocator vs JS GC roots.
- FFI type-erasure: how do `IMonitor` / `ITimerScheduler` / `IErrorHandler` translate
  across the WASM-JS boundary?
- These questions are explicitly OUT of TASK-004 scope.
