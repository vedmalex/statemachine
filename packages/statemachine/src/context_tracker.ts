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
 * A candidate is accepted only after a live round-trip probe proves the
 * operations behave: `run` binds, a nested `exit`/`run(undefined)` clears, the
 * store is empty outside — AND `run` restores on its own SYNCHRONOUS RETURN even
 * when the body returned a still-pending promise. A runtime that exposes a name
 * but a different shape is therefore REJECTED into the no-op branch rather than
 * silently mis-detecting reentrancy. This matters most for branch 2, which could
 * not be verified against a shipping implementation (neither Node 24 nor Deno 2.2
 * exposes `AsyncContext`) — the probe is what makes it safe to offer anyway.
 *
 * The probe's guarantee is deliberately ASYMMETRIC and {@link probe} states it in
 * full: it establishes that no legitimate call can be falsely rejected, not that
 * every true reentrant call is detected. Propagation across an `await` is the one
 * property it cannot reach — {@link detect} runs synchronously inside the engine
 * constructor — and a tracker that fails to propagate degrades to the SAME
 * behaviour as the no-op branch, which is a documented contract rather than a
 * correctness hazard.
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
 * Prove a candidate tracker honours the operations this engine depends on.
 * Returns `false` on any deviation OR any throw, so a partially-implemented
 * look-alike cannot be selected.
 *
 * ## What is verified, and why the last check is not redundant
 * The first four checks are synchronous round-trips: the store starts empty,
 * `run` binds, a nested `exit` clears, and nothing survives the call.
 *
 * The fifth is the one that matters for the ENGINE's actual usage. The drain does
 * `await this.drainContext.run(epoch, () => this.executeQueuedTransition(evt))`
 * (state_machine.ts:~1181/:1216) — `run` is handed a function returning a PROMISE,
 * and the reentrancy test compares `getStore()` against the active epoch several
 * awaits deep. A look-alike whose `run` restores the previous value when the
 * returned value SETTLES (rather than on synchronous return) passes all four
 * synchronous checks and then keeps the epoch bound for the WHOLE async drain, so
 * a `fireEvent` issued from an INDEPENDENT timer/IO continuation during that drain
 * observes the active epoch and is FALSELY REJECTED as reentrant. That is exactly
 * the coarse `isProcessing` defect the epoch design exists to eliminate,
 * reintroduced through the one branch that could never be checked against a
 * shipping implementation. Verified reachable: a `Variable` look-alike restoring
 * in `.finally` was accepted by the four-check probe and left `getStore() === 42`
 * immediately after `run` returned.
 *
 * ## What is NOT verified — a deliberate, bounded gap
 * That the bound value PROPAGATES INTO async continuations started inside `run`
 * cannot be checked here: {@link detect} is called synchronously from the engine
 * constructor and has nowhere to await. The asymmetry is what makes that
 * acceptable — a tracker that fails to propagate reports `getStore() === undefined`
 * deep in the drain, so a TRUE reentrant call goes UNDETECTED (the documented
 * no-op degradation, which parks the drain instead of rejecting) and NO legitimate
 * call is ever rejected. Failure to propagate costs detection; failure to restore
 * synchronously costs correctness, and only the latter is checkable from here, so
 * only the latter is what this probe promises.
 */
function probe(t: IContextTracker): boolean {
  try {
    if (t.getStore() !== undefined) return false
    if (t.run(PROBE, () => t.getStore()) !== PROBE) return false
    if (t.run(PROBE, () => t.exit(() => t.getStore())) !== undefined) return false
    if (t.getStore() !== undefined) return false
    // The async-shape check. `run` MUST restore on its own synchronous return even
    // when the body returned a still-pending promise; anything else leaves the
    // binding visible to unrelated continuations. The promise is already resolved
    // and is never rejected, so this leaves nothing pending and no unhandled
    // rejection behind.
    const pending: unknown = t.run(PROBE, () => Promise.resolve())
    const leaked = t.getStore() !== undefined
    void pending
    if (leaked) return false
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

/**
 * Has the `kind:'none'` degradation already been disclosed in this PROCESS?
 * See {@link claimContextTrackerDisclosure}.
 */
let degradationDisclosed = false

/**
 * Claim the right to emit the ONE degradation disclosure for this process.
 * Returns `true` exactly once (until {@link resetContextTrackerDetectionForTests}),
 * and `false` on every later call.
 *
 * The disclosure describes a PROCESS-level environment capability — "this runtime
 * has no async-context primitive" — and the detection behind it is already
 * memoised per process, so it is the same fact every time. It was nevertheless
 * emitted per MACHINE CONSTRUCTION, which made an application that builds one
 * machine per request repeat an unchanging environment warning on every request
 * while the comment and the docs both described it as happening once. Latching it
 * here rather than in the engine keeps it tied to the memoised detection it
 * describes, so the test seam that clears the detection clears this too.
 */
export function claimContextTrackerDisclosure(): boolean {
  if (degradationDisclosed) {
    return false
  }
  degradationDisclosed = true
  return true
}

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
  degradationDisclosed = false
}
