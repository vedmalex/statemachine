/**
 * @module sim/run-guard
 * @unstable
 *
 * W5a A1/A5 verdict-plumbing net: a process-scoped guard installed for the
 * duration of a single {@link Simulator.run} window that makes two otherwise
 * INVISIBLE real-runtime escapes surface on the {@link SimResult}:
 *
 *  - A5 REAL-TIMER ESCAPE: a consumer `onEnter`/action that arms a REAL global
 *    `setTimeout`/`setInterval`/`setImmediate` (bypassing the injected virtual
 *    `env.scheduler`) is completely invisible to `settleMacrostep`/quiescence —
 *    the report would lie "quiescent" while a real macrotask hangs. We spy on the
 *    global timer constructors over the run window and count every arming; a
 *    non-zero count becomes a `timer-escape` warning.
 *
 *  - A1 RESIDUAL UNHANDLED-REJECTION: after W1 the engine routes internal-event
 *    throws to `monitor.recordError` (no process-level rejection remains), but a
 *    RESIDUAL genuine `unhandledRejection` (an escape W1 did not contain) must not
 *    vanish into the process default handler. We attach a listener over the run
 *    window and record every rejection so the verdict can fail loud.
 *
 * This module DELIBERATELY lives outside `public.ts`: the Step-10 grep
 * (`wire_settle.test.ts`) asserts `public.ts` CODE contains no `setTimeout(` /
 * `setInterval(` / `setImmediate(` token, because no SETTLE path may use a real
 * timer. The escape-DETECTION spy legitimately references those globals, so it is
 * isolated here where it cannot be mistaken for a settle-path real timer.
 *
 * CONCURRENCY: two `runSimulation` calls can be in flight at once (the sim test
 * suite runs determinism pairs via `Promise.all`). The global timer patch is
 * therefore INSTALLED ONCE (reference-counted): every active guard's counter is
 * incremented on each global-timer arming, and the originals are restored only
 * when the LAST active guard stops. Each guard keeps its OWN counter + rejection
 * list, so concurrent runs never clobber each other's restore or miscount.
 */

/** The escape tallies a {@link RunGuardHandle.stop} returns. */
export interface RunGuardReport {
  /** Count of REAL global-timer arms (setTimeout/setInterval/setImmediate) during the window. */
  readonly timerEscapes: number
  /** Every `unhandledRejection` reason observed during the window. */
  readonly unhandledRejections: readonly unknown[]
}

/** A handle over one installed run-window guard. {@link stop} is idempotent. */
export interface RunGuardHandle {
  /** Tear down this guard (restore globals when last) and return its tallies. */
  stop(): RunGuardReport
}

/** Per-guard mutable escape counter (shared-patch increments every active one). */
interface GuardCounter {
  timerEscapes: number
}

// ── shared, reference-counted global-timer patch ────────────────────────────
const active = new Set<GuardCounter>()
let patched = false
let realSetTimeout: typeof globalThis.setTimeout | undefined
let realSetInterval: typeof globalThis.setInterval | undefined
let realSetImmediate: typeof globalThis.setImmediate | undefined

function bumpAll(): void {
  for (const c of active) {
    c.timerEscapes += 1
  }
}

function patchGlobals(): void {
  if (patched) {
    return
  }
  const g = globalThis as typeof globalThis & {
    setImmediate?: typeof globalThis.setImmediate
  }
  realSetTimeout = g.setTimeout
  g.setTimeout = ((...args: Parameters<typeof globalThis.setTimeout>) => {
    bumpAll()
    return (realSetTimeout as (...a: unknown[]) => unknown).apply(g, args)
  }) as typeof globalThis.setTimeout
  realSetInterval = g.setInterval
  g.setInterval = ((...args: Parameters<typeof globalThis.setInterval>) => {
    bumpAll()
    return (realSetInterval as (...a: unknown[]) => unknown).apply(g, args)
  }) as typeof globalThis.setInterval
  if (typeof g.setImmediate === 'function') {
    realSetImmediate = g.setImmediate
    g.setImmediate = ((...args: Parameters<typeof globalThis.setImmediate>) => {
      bumpAll()
      return (realSetImmediate as (...a: unknown[]) => unknown).apply(g, args)
    }) as typeof globalThis.setImmediate
  }
  patched = true
}

function unpatchGlobals(): void {
  if (!patched) {
    return
  }
  const g = globalThis as typeof globalThis & { setImmediate?: typeof globalThis.setImmediate }
  if (realSetTimeout !== undefined) {
    g.setTimeout = realSetTimeout
  }
  if (realSetInterval !== undefined) {
    g.setInterval = realSetInterval
  }
  if (realSetImmediate !== undefined) {
    g.setImmediate = realSetImmediate
  }
  realSetTimeout = undefined
  realSetInterval = undefined
  realSetImmediate = undefined
  patched = false
}

/**
 * Install a run-window guard: begin counting real global-timer arms and begin
 * capturing `unhandledRejection`s. The returned handle's {@link RunGuardHandle.stop}
 * restores the globals (when it is the last active guard) and returns the tallies.
 */
export function installRunGuard(): RunGuardHandle {
  const counter: GuardCounter = { timerEscapes: 0 }
  const rejections: unknown[] = []
  const onRejection = (reason: unknown): void => {
    rejections.push(reason)
  }

  active.add(counter)
  patchGlobals()
  process.on('unhandledRejection', onRejection)

  let stopped = false
  return {
    stop(): RunGuardReport {
      if (stopped) {
        return { timerEscapes: counter.timerEscapes, unhandledRejections: rejections.slice() }
      }
      stopped = true
      process.removeListener('unhandledRejection', onRejection)
      active.delete(counter)
      if (active.size === 0) {
        unpatchGlobals()
      }
      return { timerEscapes: counter.timerEscapes, unhandledRejections: rejections.slice() }
    },
  }
}
