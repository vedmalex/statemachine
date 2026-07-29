# Extension Points

The package exposes 8 extension points for host integration. Each EP is a
TypeScript interface from `@vedmalex/statemachine` that hosts may implement
to customize behavior.

## EP-1 — IMonitor (observability)

**Contract** (from `src/types.ts`):

```ts
export interface IMonitor {
  recordTransition(duration: number, success: boolean, context?: TransitionContext): void
  recordError(error: Error, context?: ErrorContext): void
  recordEvent?(eventName: string, duration: number): void
  getMetrics?(): MonitorMetricsSnapshot
}
```

**When to implement**: collect per-machine metrics, send observability data to
a host monitoring stack, or replace the default monitor with a no-op for testing.

**Default factory**: `createDefaultMonitor()` returns `StateMachineMonitor`
(internal class). Inject custom via `createMachine({...config}, undefined, { monitor: myMonitor })`.

**Example**: see `examples/integration/observability-injection/`.

## EP-2 — ITimerScheduler (timer host)

**Contract** (from `src/types.ts`):

```ts
export interface ITimerScheduler {
  isActive(): boolean
  schedule(delay: number, callback: () => void): object
  cancel(token: object): void
}
```

**Token contract**: `schedule()` returns an opaque `object` which MUST be the
same value passed back to `cancel()`. The runtime uses WeakSet membership for
safety. A future task may promote `object` to a nominal `TimerToken` branded type.

**When to implement**: route timer scheduling through a host-provided scheduler
(e.g., for WASM/Zig portability where setTimeout semantics differ).

**Default factory**: `createDefaultScheduler()` returns `TimerScheduler` (internal class).

## EP-3 — IErrorHandler (error recovery)

**Contract** (from `src/types.ts`):

```ts
export interface IErrorHandler {
  isEnabled(): boolean
  enable(): void
  disable(): void
  addRecoveryStrategy(strategy: ErrorRecoveryStrategy): void
  removeRecoveryStrategy(strategyName: string): void
  getAnalytics(): ErrorAnalytics
}
```

**Default factory**: `createDefaultErrorHandler()` returns `ErrorHandler` instance.
Inject via `createMachine({...config}, undefined, { errorHandler: myHandler })`.

## EP-4 — Adapter\<T\> (host data binding)

**Contract** (from `src/types.ts`):

```ts
export interface Adapter<T extends object> {
  get adaptee(): T
  get(property: keyof T): T[keyof T]
  set(property: keyof T, value: T[keyof T]): void
}
```

**Wiring**: pass as 2nd arg to `createMachine(config, adapter)`.
See `examples/integration/custom-adapter/`.

The `adaptee` getter exposes the underlying host object the adapter binds to
(used internally by the StateMachine for spreads and transitive access).

State-machine callbacks resolved from config or `setContext()` (`onEnter`,
`onExit`, `guard`, `onTransition`, `onError`, `invoke.action`, `invoke.cond`)
receive the underlying owner object directly. The adapter wrapper stays
internal to the machine boundary so host code does not need to unwrap it in
each callback.

## EP-5 — ILogger (logging)

**Contract** (from `src/types.ts`):

```ts
export interface ILogger {
  debug(message: string, context?: any): void
  info(message: string, context?: any): void
  warn(message: string, context?: any, error?: Error): void
  error(message: string, context?: any, error?: Error): void
}
```

**No default factory**: consumer provides via `createMachine(..., ..., { logger })`.
The package's internal `Logger` class is NOT exported.

## EP-6 — StatePersistenceAdapter (persistence)

**Contract** (from `src/types.ts`):

```ts
export interface StatePersistenceAdapter {
  save(state?: { currentState: string; history: unknown; stateEntryTimes: unknown }): Promise<void>
  restore(): Promise<{ currentState: string; history: unknown; stateEntryTimes: unknown }>
}
```

**Note**: `history` and `stateEntryTimes` are REQUIRED fields on the saved/restored
shape (NOT optional). The `state` argument to `save` IS optional (`state?: ...`) but
if provided, the inner shape must include all 3 fields. async; method named `restore`
(NOT `load`). See `examples/integration/persistence-adapter/`.

## EP-7 — validateConfig (config validation)

**Contract** (from `src/config_validator.ts`):

```ts
export function validateConfig<T extends object>(config: StateMachineConfig<T>): ValidationResult
export function validateConfigStrict<T extends object>(config: StateMachineConfig<T>): ValidationResult
export function isValidConfig<T extends object>(config: StateMachineConfig<T>): boolean
```

**When to use**: validate machine configurations at runtime before invoking
`createMachine`. All three functions accept a typed `StateMachineConfig<T>`.

- `validateConfig` returns a `ValidationResult` with collected issues.
- `validateConfigStrict` returns the same shape but throws synchronously on first error.
- `isValidConfig` returns boolean (no type-narrowing — input is already typed at compile time).

**Note**: this EP exposes function-level validation entry points only. The internal
`ConfigValidator` class is NOT exported; the public surface is the three functions above.

## EP-8 — IContextTracker (async-context host)

**Contract** (from `src/types.ts`):

```ts
export interface IContextTracker {
  run<R>(store: number, fn: () => R): R
  exit<R>(fn: () => R): R
  getStore(): number | undefined
}
```

**Propagation contract**: `run` binds `store` for the duration of `fn` **including
across every `await` inside it** — that is the whole point, and a synchronous-only
implementation silently breaks the property it exists to provide. `exit` must
observe `undefined` for its duration and must NOT catch: a throw from `fn`
propagates unchanged.

**What depends on it**: the precise reentrancy detector. The engine stamps each
drain pass with an epoch and rejects a `fireEvent` only when the caller's async
context carries the ACTIVE epoch — which is what separates a genuinely reentrant
call (issued from inside an action, and therefore undrainable) from a legitimate
concurrent one issued by an independent timer or IO callback.

**When to implement**: to restore precise detection on a runtime that offers no
async-context primitive of its own. `AsyncContext.Variable` maps directly onto
this contract once browsers ship it (`exit` is `run(undefined, fn)`).

**Default factory**: resolved per machine, without any import statement, from
`process.getBuiltinModule('node:async_hooks').AsyncLocalStorage`, then a global
`AsyncContext.Variable`, then a no-op. `machine.contextTrackerKind` reports which
was taken. On the no-op the machine logs one `WARN` at construction and true
reentrancy goes UNDETECTED — the call parks the drain instead of being rejected.
A legitimate concurrent `fireEvent` is never falsely rejected in any mode.
