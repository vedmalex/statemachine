import type { IContextTracker } from './types'

/**
 * Runtime resolution of the {@link IContextTracker} that backs PRECISE
 * reentrancy detection — WITHOUT any `import` statement.
 *
 * ## Why there is no import here
 * `import { AsyncLocalStorage } from 'node:async_hooks'` is emitted by
 * tsup/esbuild as the BARE specifier `async_hooks` in BOTH `dist/index.js`
 * (`import … from "async_hooks"`) and `dist/index.cjs` (`require("async_hooks")`).
 * A browser cannot resolve a bare builtin, so the module fails to evaluate and
 * NOTHING is exported — the whole core bundle is unloadable. Deno rejects it too
 * ("Relative import path \"async_hooks\" not prefixed with / or ./ or ../").
 *
 * Every acquisition below is therefore a METHOD CALL or a global lookup, which
 * is invisible to bundler static analysis, so the emitted bundle carries no
 * module specifier at all and loads in any runtime. The same single source
 * produces working ESM and CJS output.
 *
 * ## Resolution order
 * 1. `process.getBuiltinModule('node:async_hooks').AsyncLocalStorage` —
 *    synchronous, no import, present on Node >= 22.3 (this package declares
 *    `engines.node >= 24`) and on Deno's Node-compat layer.
 * 2. A global `AsyncContext.Variable` — the TC39 proposal shape some browsers
 *    may ship. `run`/`get` map onto this contract; `exit` is `run(undefined, …)`.
 * 3. A NO-OP tracker — the machine still works; true reentrancy simply is not
 *    detected. See {@link IContextTracker} for the degradation contract.
 *
 * ## Everything is PROBED, not assumed
 * A candidate is accepted only after a live round-trip probe proves all three
 * operations behave (`run` binds, nested `exit`/`run(undefined)` clears, the
 * store is empty outside). A runtime that exposes a name but a different shape
 * is therefore REJECTED into the no-op branch rather than silently mis-detecting
 * reentrancy. This matters most for branch 2, which could not be verified
 * against a shipping implementation (neither Node 24 nor Deno 2.2 exposes
 * `AsyncContext`) — the probe is what makes it safe to offer anyway.
 */

/** Which primitive backs the tracker a machine is using. */
export type ContextTrackerKind =
  /** Node/Deno `AsyncLocalStorage` — precise detection. */
  | 'async-local-storage'
  /** A global `AsyncContext.Variable` — precise detection. */
  | 'async-context'
  /** No primitive available — detection DEGRADED to no-op. */
  | 'none'
  /** Supplied via `StateMachineOptions.contextTracker` — capability is the caller's. */
  | 'injected'

/** Sentinel used by the probe; any value distinguishable from `undefined` works. */
const PROBE = 0xc0ffee

/**
 * Prove a candidate tracker honours the three operations. Returns `false` on any
 * deviation OR any throw, so a partially-implemented look-alike cannot be
 * selected.
 */
function probe(t: IContextTracker): boolean {
  try {
    if (t.getStore() !== undefined) return false
    if (t.run(PROBE, () => t.getStore()) !== PROBE) return false
    if (t.run(PROBE, () => t.exit(() => t.getStore())) !== undefined) return false
    if (t.getStore() !== undefined) return false
    return true
  } catch {
    return false
  }
}

/** Structural shape of `AsyncLocalStorage` limited to what this contract needs. */
interface AsyncLocalStorageLike {
  run<R>(store: number, fn: () => R): R
  exit<R>(fn: () => R): R
  getStore(): number | undefined
}
type AsyncLocalStorageCtor = new () => AsyncLocalStorageLike

/** Structural shape of the TC39 `AsyncContext.Variable` proposal. */
interface AsyncContextVariableLike {
  run<R>(value: number | undefined, fn: () => R): R
  get(): number | undefined
}
type AsyncContextVariableCtor = new () => AsyncContextVariableLike

/**
 * Branch 1 — `process.getBuiltinModule('node:async_hooks')`.
 *
 * Guarded rather than assumed: in a browser `process` is absent, and a bundler's
 * `process` shim is typically an object with no `getBuiltinModule`. The call
 * itself is wrapped because a host could expose the method yet refuse the
 * module (e.g. under a permission model).
 */
function resolveAsyncLocalStorageCtor(): AsyncLocalStorageCtor | undefined {
  const proc = (
    globalThis as {
      process?: { getBuiltinModule?: (id: string) => unknown }
    }
  ).process
  if (typeof proc?.getBuiltinModule !== 'function') return undefined
  try {
    const mod = proc.getBuiltinModule('node:async_hooks') as
      | { AsyncLocalStorage?: unknown }
      | undefined
    const ctor = mod?.AsyncLocalStorage
    return typeof ctor === 'function' ? (ctor as AsyncLocalStorageCtor) : undefined
  } catch {
    return undefined
  }
}

/** Branch 2 — a global `AsyncContext.Variable`. */
function resolveAsyncContextVariableCtor(): AsyncContextVariableCtor | undefined {
  const ac = (globalThis as { AsyncContext?: { Variable?: unknown } }).AsyncContext
  const ctor = ac?.Variable
  return typeof ctor === 'function' ? (ctor as AsyncContextVariableCtor) : undefined
}

/**
 * Adapt an `AsyncContext.Variable` to this contract. `exit` has no direct
 * counterpart: `run(undefined, fn)` shadows the outer binding, so `get()`
 * observes `undefined` for the duration — which is precisely what `exit` means
 * here. Verified by {@link probe} before the adapter is ever handed out.
 */
function adaptAsyncContextVariable(v: AsyncContextVariableLike): IContextTracker {
  return {
    run: (store, fn) => v.run(store, fn),
    exit: (fn) => v.run(undefined, fn),
    getStore: () => v.get(),
  }
}

/**
 * The degraded tracker. `getStore()` is permanently `undefined`, which can never
 * equal the numeric active epoch, so the reject condition is unreachable and NO
 * legitimate `fireEvent` is ever falsely rejected. `run`/`exit` are transparent
 * pass-throughs and must not catch — a throwing action keeps propagating exactly
 * as it does under a real tracker.
 */
export function createNoopContextTracker(): IContextTracker {
  return {
    run: (_store, fn) => fn(),
    exit: (fn) => fn(),
    getStore: () => undefined,
  }
}

/**
 * Detection is memoised per PROCESS (probing costs an allocation and a few
 * calls), but the tracker INSTANCE is fresh per call: the store is a per-machine
 * drain epoch, so two machines sharing one instance could see each other's epoch
 * and false-reject.
 */
let cachedCtor: (() => IContextTracker) | undefined
let cachedKind: ContextTrackerKind | undefined

function detect(): { kind: ContextTrackerKind; make: () => IContextTracker } {
  if (cachedCtor !== undefined && cachedKind !== undefined) {
    return { kind: cachedKind, make: cachedCtor }
  }

  const ALS = resolveAsyncLocalStorageCtor()
  if (ALS !== undefined) {
    const make = () => new ALS() as IContextTracker
    if (probe(make())) {
      cachedKind = 'async-local-storage'
      cachedCtor = make
      return { kind: cachedKind, make }
    }
  }

  const Variable = resolveAsyncContextVariableCtor()
  if (Variable !== undefined) {
    const make = () => adaptAsyncContextVariable(new Variable())
    if (probe(make())) {
      cachedKind = 'async-context'
      cachedCtor = make
      return { kind: cachedKind, make }
    }
  }

  cachedKind = 'none'
  cachedCtor = createNoopContextTracker
  return { kind: cachedKind, make: cachedCtor }
}

/**
 * Resolve the default async-context tracker for one machine, together with the
 * primitive it came from. Never throws: an unsupported runtime yields the no-op
 * tracker and `kind: 'none'`, which the caller is expected to disclose (the
 * engine logs one WARN at construction).
 *
 * The return shape is inlined deliberately — a named exported interface here
 * would be an export nothing imports.
 */
export function createDefaultContextTracker(): {
  readonly kind: ContextTrackerKind
  readonly tracker: IContextTracker
} {
  const { kind, make } = detect()
  return { kind, tracker: make() }
}

/**
 * TEST SEAM — drop the memoised detection so a test can exercise a different
 * branch after stubbing/removing a global. Not part of the public entry point.
 */
export function resetContextTrackerDetectionForTests(): void {
  cachedCtor = undefined
  cachedKind = undefined
}
