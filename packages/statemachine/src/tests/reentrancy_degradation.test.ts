import { describe, expect, it } from 'vitest'
import {
  createDefaultContextTracker,
  createNoopContextTracker,
  resetContextTrackerDetectionForTests,
} from '../context_tracker'
import { StateMachine } from '../state_machine'
import {
  type ILogger,
  MemoryAdapter,
  type StateMachineConfig,
  StateMachineError,
} from '../types'

/**
 * Runtime-portability degradation contract.
 *
 * The engine no longer hard-imports `node:async_hooks` (the bundler emitted it as
 * the BARE specifier `async_hooks`, which a browser cannot resolve and Deno
 * rejects — the whole core bundle was unloadable outside Node). Where no
 * async-context primitive exists the tracker degrades to a NO-OP, and this file
 * pins BOTH HALVES of that degradation HONESTLY:
 *
 *  - the SAFE half: `getStore()` is permanently `undefined`, which can never
 *    equal the numeric active epoch, so the reject condition is unreachable —
 *    all four classes of LEGITIMATE concurrency from
 *    `reentrancy_precision.test.ts` still queue and resolve. No false accusation
 *    is possible, by construction.
 *  - the LOST half: a TRUE reentrant `fireEvent` from inside an action is NOT
 *    detected. It does not reject with a clear error; it PARKS the drain. That
 *    is a real regression in capability and is asserted as such rather than
 *    papered over — together with the documented mitigation
 *    (`transitionTimeout`), which is measured here, not assumed.
 *
 * `reentrancy_precision.test.ts` stays the PRECISE-mode contract and is
 * deliberately untouched; this file is its degraded-mode twin.
 */

/** Hang marker: resolves LATER, so a parked promise is observed as an outcome. */
function hangMarker(ms: number, label = 'PARKED'): Promise<string> {
  return new Promise((res) => setTimeout(() => res(label), ms))
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

function classify(p: Promise<boolean>): Promise<string> {
  return p.then(
    (r) => (r ? 'RESOLVED_TRUE' : 'RESOLVED_FALSE'),
    (e) =>
      e instanceof StateMachineError && /reentrant/i.test(e.message)
        ? 'REENTRANT_REJECT'
        : `OTHER_REJECT:${e instanceof Error ? e.message : String(e)}`,
  )
}

/** A composite leaf that is immediately "done" on entry → raises done.state. */
const doneComposite = () => ({
  initial: 'r.f',
  regions: { r: { f: { final: true } } },
})

/** Options that force the DEGRADED (tracker-less) mode. */
const degraded = () => ({ contextTracker: createNoopContextTracker() })

// ---------------------------------------------------------------------------
// SAFE HALF — no legitimate fireEvent is ever falsely rejected
// ---------------------------------------------------------------------------
describe('degraded (no-op) tracker: the four LEGITIMATE concurrency classes still resolve', () => {
  it('(a) external fireEvent from an INDEPENDENT setTimeout inside an async-onEnter window → queues and resolves', async () => {
    interface Box {
      state: string
    }
    let sm!: StateMachine<Box, any>
    const config: StateMachineConfig<Box> = {
      name: 'DegradedFalseExternal',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        A: { onEnter: async () => { await sleep(100) } },
        B: {},
      },
      events: {
        go: { transitions: [{ from: 'idle', to: 'A' }] },
        finish: { transitions: [{ from: 'A', to: 'B' }] },
      },
    }
    sm = new StateMachine<Box, typeof config>(
      config,
      new MemoryAdapter<Box>({ state: 'idle' }),
      degraded(),
    )

    const goP = sm.fireEvent('go').catch(() => {})
    const extOutcome = await new Promise<string>((resolve) => {
      setTimeout(() => {
        classify(sm.fireEvent('finish')).then(resolve)
      }, 30)
    })
    await goP

    expect(
      extOutcome,
      `an independent timer's fireEvent must queue and resolve even with detection ` +
        `disabled — getStore() is undefined, so the reject condition is unreachable ` +
        `(got: ${extOutcome})`,
    ).toBe('RESOLVED_TRUE')
    expect(sm.getCurrentState()).toBe('B')
  })

  it('(b) chained `await fireEvent(A); await fireEvent(B)` over a non-empty queue → B resolves', async () => {
    interface Box {
      state: string
    }
    const config: StateMachineConfig<Box> = {
      name: 'DegradedFalseChained',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        root: { initial: 'main.P', regions: { main: { P: doneComposite() } } } as any,
        s1: {},
        s2: {},
      },
      events: {
        A: { transitions: [{ from: 'idle', to: 'root' }] },
        'done.state.root.main.P': {
          transitions: [{ from: 'root.main.P', to: 's1' }],
        },
        B: { transitions: [{ from: 's1', to: 's2' }] },
      },
    }
    const sm = new StateMachine<Box, typeof config>(
      config,
      new MemoryAdapter<Box>({ state: 'idle' }),
      degraded(),
    )

    await sm.fireEvent('A')
    const bOutcome = await Promise.race([classify(sm.fireEvent('B')), hangMarker(1500)])
    expect(bOutcome, `chained legitimate external B must resolve (got: ${bOutcome})`).toBe(
      'RESOLVED_TRUE',
    )
  })

  it('(c) fireEvent from a config-level onError recovery → queues and resolves', async () => {
    interface Box {
      state: string
    }
    let recover = 'pending'
    let smRef!: StateMachine<Box, any>
    const config: StateMachineConfig<Box> = {
      name: 'DegradedRecoverViaOnError',
      stateAttribute: 'state',
      initialState: 'running',
      onError: () => {
        smRef.fireEvent('recover').then(
          () => { recover = 'RESOLVED' },
          (e: Error) => { recover = `REJECTED:${e.message.slice(0, 30)}` },
        )
      },
      states: {
        running: { invoke: [{ delay: 5, event: 'tick' }] },
        boom: { onEnter: () => { throw new Error('BOOM in onEnter') } },
        safe: {},
      },
      events: {
        tick: { transitions: [{ from: 'running', to: 'boom' }] },
        recover: { transitions: [{ from: 'boom', to: 'safe' }] },
      },
    }
    smRef = new StateMachine<Box, typeof config>(
      config,
      new MemoryAdapter<Box>({ state: 'running' }),
      degraded(),
    )

    await sleep(150)
    expect(recover, 'onError recovery fireEvent must not be rejected').toBe('RESOLVED')
    expect(smRef.getCurrentState()).toBe('safe')
  })

  it('(d) fireEvent for a SECOND adaptee during the first drain → queues and resolves', async () => {
    interface Box {
      state: string
    }
    const config: StateMachineConfig<Box> = {
      name: 'DegradedTwoAdaptee',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        working: { onEnter: async () => { await sleep(60) } },
        done: {},
      },
      events: { start: { transitions: [{ from: 'idle', to: 'working' }] } },
    }
    const sm = new StateMachine<Box, typeof config>(
      config,
      new MemoryAdapter<Box>({ state: 'idle' }),
      degraded(),
    )
    const a = new MemoryAdapter<Box>({ state: 'idle' })
    const b = new MemoryAdapter<Box>({ state: 'idle' })

    const pA = sm.fireEvent('start', a)
    let rb = 'pending'
    setTimeout(() => {
      sm.fireEvent('start', b).then(
        () => { rb = 'RESOLVED' },
        (e: Error) => { rb = `REJECTED:${e.message.slice(0, 30)}` },
      )
    }, 20)
    await pA
    await sleep(120)

    expect(rb, "the second adaptee's event must not be rejected").toBe('RESOLVED')
    expect(b.get('state')).toBe('working')
  })
})

// ---------------------------------------------------------------------------
// LOST HALF — true reentrancy is NOT detected; it parks
// ---------------------------------------------------------------------------
describe('degraded (no-op) tracker: TRUE reentrancy is NOT detected — the honest cost', () => {
  it('a truly reentrant `await sm.fireEvent` inside onEnter is NOT rejected — it PARKS the drain', async () => {
    interface Box {
      state: string
    }
    let sm!: StateMachine<Box, any>
    const config: StateMachineConfig<Box> = {
      name: 'DegradedTrueReentrant',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        A: { onEnter: async () => { await sm.fireEvent('inner') } },
        B: {},
      },
      events: {
        go: { transitions: [{ from: 'idle', to: 'A' }] },
        inner: { transitions: [{ from: 'A', to: 'B' }] },
      },
    }
    sm = new StateMachine<Box, typeof config>(
      config,
      new MemoryAdapter<Box>({ state: 'idle' }),
      degraded(),
    )

    // Under PRECISE detection this is 'REENTRANT_REJECT' (see
    // reentrancy_precision.test.ts control case). Degraded, the reentrant event
    // sits in the external queue behind the very action awaiting it, so NOTHING
    // settles — the hang marker wins. This assertion documents the LOSS; if it
    // ever flips to REENTRANT_REJECT the no-op tracker stopped being a no-op.
    const outcome = await Promise.race([classify(sm.fireEvent('go')), hangMarker(400)])
    expect(
      outcome,
      `with detection disabled the true reentrant must PARK, not reject — that is ` +
        `the documented degradation (got: ${outcome})`,
    ).toBe('PARKED')
    // The drain never completed, so the machine never left the source state.
    expect(sm.getCurrentState()).toBe('idle')
  })

  it('`transitionTimeout` bounds the parked drain — the documented mitigation', async () => {
    interface Box {
      state: string
    }
    let sm!: StateMachine<Box, any>
    const config: StateMachineConfig<Box> = {
      name: 'DegradedTrueReentrantBounded',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        A: { onEnter: async () => { await sm.fireEvent('inner') } },
        B: {},
      },
      events: {
        go: { transitions: [{ from: 'idle', to: 'A' }] },
        inner: { transitions: [{ from: 'A', to: 'B' }] },
      },
    }
    sm = new StateMachine<Box, typeof config>(
      config,
      new MemoryAdapter<Box>({ state: 'idle' }),
      { ...degraded(), transitionTimeout: 50 },
    )

    // Not a clear "reentrant" diagnosis — a generic action-timeout — but the
    // caller is SETTLED rather than parked forever. That is exactly the tradeoff
    // the README states for tracker-less runtimes.
    const outcome = await Promise.race([classify(sm.fireEvent('go')), hangMarker(1500)])
    expect(
      outcome,
      `transitionTimeout must settle the parked drain instead of hanging (got: ${outcome})`,
    ).not.toBe('PARKED')
  })
})

// ---------------------------------------------------------------------------
// Capability reporting + the construction-time disclosure
// ---------------------------------------------------------------------------
describe('context-tracker capability reporting', () => {
  const trivial: StateMachineConfig<{ state: string }> = {
    name: 'CapabilityProbe',
    stateAttribute: 'state',
    initialState: 'idle',
    states: { idle: {} },
    events: {},
  }

  function makeSpyLogger(): { logger: ILogger; warns: string[] } {
    const warns: string[] = []
    return {
      warns,
      logger: {
        debug() {},
        info() {},
        warn(message) { warns.push(message) },
        error() {},
      },
    }
  }

  it('on this runtime the default factory resolves AsyncLocalStorage (precise mode, no WARN)', () => {
    const { logger, warns } = makeSpyLogger()
    const sm = new StateMachine(trivial, new MemoryAdapter({ state: 'idle' }), { logger })
    // Node and Deno both expose process.getBuiltinModule('node:async_hooks').
    expect(sm.contextTrackerKind).toBe('async-local-storage')
    expect(createDefaultContextTracker().kind).toBe('async-local-storage')
    expect(warns).toEqual([])
  })

  it('an injected tracker reports `injected` and suppresses the WARN', () => {
    const { logger, warns } = makeSpyLogger()
    const sm = new StateMachine(trivial, new MemoryAdapter({ state: 'idle' }), {
      logger,
      contextTracker: createNoopContextTracker(),
    })
    expect(sm.contextTrackerKind).toBe('injected')
    // The injector owns the capability statement, so the engine does not warn.
    expect(warns).toEqual([])
  })

  it('a runtime with NO primitive falls back to `none` and discloses it with exactly one WARN', () => {
    // Simulate a browser: hide process.getBuiltinModule (there is no
    // AsyncContext.Variable on this runtime either — verified below).
    const proc = globalThis.process as unknown as {
      getBuiltinModule?: (id: string) => unknown
    }
    const saved = proc.getBuiltinModule
    expect(
      (globalThis as { AsyncContext?: unknown }).AsyncContext,
      'this runtime unexpectedly exposes AsyncContext — the simulation below is invalid',
    ).toBeUndefined()
    try {
      proc.getBuiltinModule = undefined
      resetContextTrackerDetectionForTests()
      expect(createDefaultContextTracker().kind).toBe('none')

      const { logger, warns } = makeSpyLogger()
      const sm = new StateMachine(trivial, new MemoryAdapter({ state: 'idle' }), { logger })
      expect(sm.contextTrackerKind).toBe('none')
      expect(warns).toHaveLength(1)
      expect(warns[0]).toMatch(/Precise reentrancy detection is unavailable/)
      expect(warns[0]).toMatch(/transitionTimeout/)
    } finally {
      proc.getBuiltinModule = saved
      resetContextTrackerDetectionForTests()
    }
    // Detection recovers once the primitive is back.
    expect(createDefaultContextTracker().kind).toBe('async-local-storage')
  })

  it('each machine gets its OWN tracker instance (a shared store could collide across machines)', () => {
    const a = createDefaultContextTracker().tracker
    const b = createDefaultContextTracker().tracker
    expect(a).not.toBe(b)
  })
})

// ── the probe's ASYNC-SHAPE check, and the process-scoped disclosure ─────────

/**
 * A look-alike `AsyncContext.Variable` whose `run(value, fn)` restores the
 * previous binding when the RETURNED VALUE SETTLES rather than on its own
 * synchronous return.
 *
 * It honours every SYNCHRONOUS reading of the contract, which is why it used to
 * be ACCEPTED: `getStore()` starts empty, `run` binds, a nested `run(undefined,…)`
 * clears, and nothing survives a call whose body returned a plain value. The
 * deviation shows up only on the shape the ENGINE actually uses —
 * `await drainContext.run(epoch, () => executeQueuedTransition(evt))`, whose body
 * returns a PROMISE. There the binding stays live for the whole async drain, so a
 * `fireEvent` from an INDEPENDENT timer/IO continuation observes the active epoch
 * and is FALSELY REJECTED as reentrant — the coarse `isProcessing` defect the
 * epoch design exists to eliminate, reintroduced through the one branch that
 * could never be checked against a shipping implementation.
 */
class SettleRestoringVariableLookAlike {
  private value: number | undefined
  run<R>(value: number | undefined, fn: () => R): R {
    const prev = this.value
    this.value = value
    let r: R
    try {
      r = fn()
    } catch (e) {
      this.value = prev
      throw e
    }
    if (r instanceof Promise) {
      return r.finally(() => {
        this.value = prev
      }) as unknown as R
    }
    this.value = prev
    return r
  }
  get(): number | undefined {
    return this.value
  }
}

/** A CONFORMING `AsyncContext.Variable`: restores on synchronous return. */
class ConformingVariable {
  private value: number | undefined
  run<R>(value: number | undefined, fn: () => R): R {
    const prev = this.value
    this.value = value
    try {
      return fn()
    } finally {
      this.value = prev
    }
  }
  get(): number | undefined {
    return this.value
  }
}

/** Run `body` with `process.getBuiltinModule` hidden and `AsyncContext` stubbed. */
function withStubbedRuntime(Variable: unknown | undefined, body: () => void): void {
  const proc = globalThis.process as unknown as {
    getBuiltinModule?: (id: string) => unknown
  }
  const saved = proc.getBuiltinModule
  try {
    proc.getBuiltinModule = undefined
    if (Variable !== undefined) {
      ;(globalThis as { AsyncContext?: unknown }).AsyncContext = { Variable }
    }
    resetContextTrackerDetectionForTests()
    body()
  } finally {
    proc.getBuiltinModule = saved
    ;(globalThis as { AsyncContext?: unknown }).AsyncContext = undefined
    resetContextTrackerDetectionForTests()
  }
}

describe('the tracker probe rejects a look-alike that restores on SETTLE, not on return', () => {
  it('the look-alike is demoted to the no-op branch instead of being accepted', () => {
    withStubbedRuntime(SettleRestoringVariableLookAlike, () => {
      const { kind, tracker } = createDefaultContextTracker()
      // 'none', not 'async-context': the async-shape check caught it.
      expect(kind).toBe('none')
      // …and the no-op it fell back to cannot false-reject anything: getStore()
      // is permanently undefined, so it never equals a numeric drain epoch.
      expect(tracker.getStore()).toBeUndefined()
    })
  })

  it('TEETH: the look-alike really does leak past a synchronous return', async () => {
    // Without this the test above would also pass if the look-alike were simply
    // broken in some unrelated way, or if the stub never got installed.
    const v = new SettleRestoringVariableLookAlike()
    const p = v.run(42, () => Promise.resolve())
    expect(v.get()).toBe(42) // ← the leak: still bound after run() returned
    await p
    expect(v.get()).toBeUndefined() // restored only once it settled
  })

  it('a CONFORMING Variable is still accepted (the check is not a blanket rejection)', () => {
    withStubbedRuntime(ConformingVariable, () => {
      expect(createDefaultContextTracker().kind).toBe('async-context')
    })
  })
})

describe('the degradation WARN is disclosed once per PROCESS, not once per machine', () => {
  const trivial: StateMachineConfig<{ state: string }> = {
    name: 'DisclosureProbe',
    stateAttribute: 'state',
    initialState: 'idle',
    states: { idle: {} },
    events: {},
  }

  function makeSpyLogger(): { logger: ILogger; warns: string[] } {
    const warns: string[] = []
    return {
      warns,
      logger: {
        debug() {},
        info() {},
        warn(message) {
          warns.push(message)
        },
        error() {},
      },
    }
  }

  it('a second machine on the same degraded runtime does not repeat it', () => {
    withStubbedRuntime(undefined, () => {
      const first = makeSpyLogger()
      const a = new StateMachine(trivial, new MemoryAdapter({ state: 'idle' }), {
        logger: first.logger,
      })
      expect(a.contextTrackerKind).toBe('none')
      expect(first.warns).toHaveLength(1)

      // Same process, same memoised detection, same unchanging environment fact.
      // An app that builds one machine per request used to repeat this warning on
      // every request while the comment and the docs both said "exactly once".
      const second = makeSpyLogger()
      const b = new StateMachine(trivial, new MemoryAdapter({ state: 'idle' }), {
        logger: second.logger,
      })
      expect(b.contextTrackerKind).toBe('none')
      expect(second.warns).toEqual([])
    })
  })
})
