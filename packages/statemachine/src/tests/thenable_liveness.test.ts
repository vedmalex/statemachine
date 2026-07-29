/**
 * @module tests/thenable_liveness — C2.
 *
 * The dispatch funnel decides "is this consumer callable still running?" and the
 * whole debugging surface is downstream of that one answer: `getProgress()`, the
 * `describeProgress()` standing report, the lifecycle span's `end` edge, and (via
 * `src/sim/env.ts`) the simulator's quiescence oracle.
 *
 * It used to ask `raw instanceof Promise`. The ENGINE asks a different question:
 * it `await`s. And `await` accepts any THENABLE — a Bluebird or Q promise, a
 * mocking library's stub, a native promise from another realm (`vm`, an iframe,
 * a second bundled copy of a polyfill). On that branch the funnel took the
 * SYNCHRONOUS path: it decremented the in-flight count and emitted the span's
 * `end` while the engine was still parked inside the consumer's code.
 *
 * That is the timeout-zombie shape A1 was built to eliminate, reintroduced
 * through a different door — and one degree worse, because the trace agrees with
 * it. `describeProgress()` printed
 *
 *     No consumer callable is open — the engine is not inside consumer code.
 *     …The lifecycle trace agrees: it is intact … and carries no unmatched begin.
 *
 * over a machine that was waiting on an `invoke.src` which had not settled. Two
 * independent sources concurring on a false statement is worse than one source
 * being silent, because the second one is what you check the first against.
 *
 * These tests drive REAL machines with REAL non-native thenables and read the
 * rendered text.
 */
import { describe, expect, it } from 'vitest'
import { createLifecycleTracer } from '../lifecycle-tracer'
import { StateMachine } from '../state_machine'
import { bracketAsync, makeAsyncCounter, makeEnv, makeObservableScheduler } from '../sim/env'
import type { StateMachineConfig, StatePersistenceAdapter } from '../types'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Box {
  state: string
}

/**
 * A thenable that is NOT a native promise and NOT a subclass of one — the shape
 * every foreign promise library, realm boundary and test double presents.
 * `instanceof Promise` is false; `await` adopts it.
 */
function deferredThenable<T>(): {
  thenable: PromiseLike<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  const fulfil: Array<(v: T) => void> = []
  const fail: Array<(e: unknown) => void> = []
  let state: 'pending' | 'fulfilled' | 'rejected' = 'pending'
  let value: T
  let error: unknown
  const thenable: PromiseLike<T> = {
    then(onFul?: any, onRej?: any) {
      if (state === 'fulfilled') queueMicrotask(() => onFul?.(value))
      else if (state === 'rejected') queueMicrotask(() => onRej?.(error))
      else {
        if (onFul) fulfil.push(onFul)
        if (onRej) fail.push(onRej)
      }
      return undefined as any
    },
  }
  return {
    thenable,
    resolve(v: T) {
      if (state !== 'pending') return
      state = 'fulfilled'
      value = v
      for (const f of fulfil.splice(0)) queueMicrotask(() => f(v))
    },
    reject(e: unknown) {
      if (state !== 'pending') return
      state = 'rejected'
      error = e
      for (const f of fail.splice(0)) queueMicrotask(() => f(e))
    },
  }
}

it('the fixture really is the shape under test (not a native promise)', () => {
  const { thenable } = deferredThenable<void>()
  expect(thenable instanceof Promise).toBe(false)
  expect(typeof (thenable as { then: unknown }).then).toBe('function')
})

function srcMachine(src: () => unknown, monitor?: unknown) {
  const owner: Box = { state: 'a' }
  const flags = { onDoneFired: false }
  const config = {
    name: 'ThenableSrc',
    initialState: 'a',
    stateAttribute: 'state',
    states: {
      a: {},
      b: { invoke: [{ src, onDone: 'done' }] },
      c: {},
    },
    events: {
      go: { transitions: [{ from: 'a', to: 'b' }] },
      done: {
        transitions: [
          { from: 'b', to: 'c', action: () => { flags.onDoneFired = true } },
        ],
      },
    },
  } as unknown as StateMachineConfig<Box>
  const sm = new StateMachine(
    config as any,
    owner as any,
    (monitor ? { monitor } : undefined) as any,
  )
  return { sm, owner, flags }
}

describe('C2 · the funnel counts what the ENGINE waits on, not what is `instanceof Promise`', () => {
  it('invoke.src returning a non-native thenable is reported OPEN while the engine waits', async () => {
    const t = deferredThenable<string>()
    const { sm, owner, flags } = srcMachine(() => t.thenable)

    await sm.fireEvent('go')
    await sleep(20)

    // Ground truth: the engine has NOT advanced — it is inside
    // `Promise.resolve(result).then(...)` waiting on the consumer's thenable.
    expect(owner.state).toBe('b')
    expect(flags.onDoneFired).toBe(false)

    // …and the debugging surface now says so.
    const progress = sm.getProgress()
    expect(progress.inFlightUserCallables).toBe(1)
    expect(progress.openDispatches).toHaveLength(1)
    expect(progress.openDispatches[0]).toMatchObject({
      hook: 'invoke.operation',
      state: 'b',
    })

    t.resolve('ok')
    await sleep(20)

    // Settling the thenable closes the slot — no leak in the other direction.
    expect(owner.state).toBe('c')
    expect(flags.onDoneFired).toBe(true)
    expect(sm.getProgress().inFlightUserCallables).toBe(0)
    expect(sm.getProgress().openDispatches).toHaveLength(0)
  })

  it('describeProgress() no longer prints a false all-clear CORROBORATED by the trace', async () => {
    const tracer = createLifecycleTracer()
    const t = deferredThenable<string>()
    const { sm } = srcMachine(() => t.thenable, tracer)

    await sm.fireEvent('go')
    await sleep(20)

    const report = sm.describeProgress()
    // The exact sentence the pre-C2 build printed over a waiting engine.
    expect(report).not.toContain('No consumer callable is open')
    expect(report).toContain('invoke.operation')
    // The cross-check must not be able to corroborate a clean reading either:
    // an unmatched `begin` is present, which is what "still running" looks like
    // in the buffer.
    expect(tracer.unfinished()).toHaveLength(1)
    expect(tracer.unfinished()[0]).toMatchObject({ hook: 'invoke.operation', edge: 'begin' })

    t.resolve('ok')
    await sleep(20)
    expect(sm.describeProgress()).toContain('No consumer callable is open')
    expect(tracer.unfinished()).toEqual([])
  })

  it('a REJECTING thenable closes the slot too (no leak on the failure path)', async () => {
    const t = deferredThenable<string>()
    const { sm } = srcMachine(() => t.thenable)
    await sm.fireEvent('go')
    await sleep(20)
    expect(sm.getProgress().inFlightUserCallables).toBe(1)

    t.reject(new Error('nope'))
    await sleep(20)
    expect(sm.getProgress().inFlightUserCallables).toBe(0)
  })

  it('a thenable that settles TWICE cannot drive the count negative', async () => {
    // A foreign thenable is consumer code: nothing stops it calling both
    // handlers. A negative in-flight count reads as "quiescent" to every oracle
    // that compares against zero — a worse lie than the one C2 removes.
    const misbehaving: PromiseLike<string> = {
      then(onFul: any, onRej: any) {
        queueMicrotask(() => {
          onFul?.('a')
          onFul?.('b')
          onRej?.(new Error('and a rejection for good measure'))
        })
        return undefined as any
      },
    }
    const { sm } = srcMachine(() => misbehaving)
    await sm.fireEvent('go')
    await sleep(20)
    expect(sm.getProgress().inFlightUserCallables).toBe(0)
    expect(sm.getProgress().openDispatches).toHaveLength(0)
  })

  it('persist.save awaiting a non-native thenable is reported OPEN', async () => {
    const t = deferredThenable<void>()
    const owner: Box = { state: 'a' }
    const config = {
      name: 'ThenablePersist',
      initialState: 'a',
      stateAttribute: 'state',
      states: { a: {}, b: {} },
      events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
    } as unknown as StateMachineConfig<Box>
    const sm = new StateMachine(config as any, owner as any)

    const adapter: StatePersistenceAdapter = {
      save: () => t.thenable as unknown as Promise<void>,
      restore: async () => ({ currentState: 'a', history: {} }),
    } as unknown as StatePersistenceAdapter

    const saving = sm.saveState(adapter)
    await sleep(10)

    // `saveState` is a bare `await` on the adapter's result: the engine is
    // demonstrably still inside it.
    expect(sm.getProgress().inFlightUserCallables).toBe(1)
    expect(sm.getProgress().openDispatches[0]).toMatchObject({ hook: 'persist.save' })

    t.resolve(undefined)
    await saving
    expect(sm.getProgress().inFlightUserCallables).toBe(0)
  })

  it('persist.restore awaiting a non-native thenable is reported OPEN', async () => {
    const t = deferredThenable<{ currentState: string; history: Record<string, string> }>()
    const owner: Box = { state: 'a' }
    const config = {
      name: 'ThenableRestore',
      initialState: 'a',
      stateAttribute: 'state',
      states: { a: {}, b: {} },
      events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
    } as unknown as StateMachineConfig<Box>
    const sm = new StateMachine(config as any, owner as any)

    const adapter = {
      save: async () => {},
      restore: () => t.thenable,
    } as unknown as StatePersistenceAdapter

    const restoring = sm.restoreState(adapter)
    await sleep(10)
    expect(sm.getProgress().inFlightUserCallables).toBe(1)
    expect(sm.getProgress().openDispatches[0]).toMatchObject({ hook: 'persist.restore' })

    t.resolve({ currentState: 'b', history: {} })
    await restoring
    expect(sm.getProgress().inFlightUserCallables).toBe(0)
    expect(owner.state).toBe('b')
  })

  it('an ACTION returning a non-native thenable is open until it settles', async () => {
    // The `callAction` arms look like they decline to wait (`result instanceof
    // Promise ? await result : result`), but `callAction` is `async`, so
    // RETURNING a thenable makes its promise adopt it — the engine waits here
    // too, and the funnel must agree.
    const t = deferredThenable<void>()
    const owner: Box = { state: 'a' }
    const config = {
      name: 'ThenableAction',
      initialState: 'a',
      stateAttribute: 'state',
      states: { a: {}, b: { onEnter: () => t.thenable } },
      events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
    } as unknown as StateMachineConfig<Box>
    const sm = new StateMachine(config as any, owner as any)

    const firing = sm.fireEvent('go')
    await sleep(20)

    expect(sm.getProgress().inFlightUserCallables).toBe(1)
    expect(sm.getProgress().openDispatches[0]).toMatchObject({ hook: 'onEnter' })

    t.resolve(undefined)
    await firing
    expect(sm.getProgress().inFlightUserCallables).toBe(0)
  })

  it('a native promise still takes the ORIGINAL path (no behaviour drift)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { sm, owner } = srcMachine(() => gate)
    await sm.fireEvent('go')
    await sleep(20)
    expect(sm.getProgress().inFlightUserCallables).toBe(1)
    release()
    await sleep(20)
    expect(sm.getProgress().inFlightUserCallables).toBe(0)
    expect(owner.state).toBe('c')
  })

  it('a SYNCHRONOUS action is never counted as open', async () => {
    const owner: Box = { state: 'a' }
    const config = {
      name: 'SyncAction',
      initialState: 'a',
      stateAttribute: 'state',
      states: { a: {}, b: { onEnter: () => 42 } },
      events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
    } as unknown as StateMachineConfig<Box>
    const sm = new StateMachine(config as any, owner as any)
    await sm.fireEvent('go')
    expect(sm.getProgress().inFlightUserCallables).toBe(0)
  })
})

describe('C2 · sim env `bracketAsync` asks the SAME question as the funnel', () => {
  const freshEnv = () => {
    const { view } = makeObservableScheduler({ now: () => 0 } as never)
    return makeEnv(makeAsyncCounter(), view)
  }

  it('a non-native thenable keeps the async count above zero until it settles', async () => {
    const env = freshEnv()
    const t = deferredThenable<number>()
    const wrapped = bracketAsync(env, (() => t.thenable) as never)

    const returned = wrapped({} as never)
    // Premature quiescence is exactly what the frozen bracket rule forbids.
    expect(env.inFlightAsyncCount()).toBe(1)
    // The caller's chain is not lengthened: the ORIGINAL thenable comes back,
    // because a bare thenable has no `.finally` to derive from.
    expect(returned).toBe(t.thenable)

    t.resolve(1)
    await sleep(10)
    expect(env.inFlightAsyncCount()).toBe(0)
  })

  it('a rejecting non-native thenable also settles the count', async () => {
    const env = freshEnv()
    const t = deferredThenable<number>()
    bracketAsync(env, (() => t.thenable) as never)({} as never)
    expect(env.inFlightAsyncCount()).toBe(1)
    t.reject(new Error('x'))
    await sleep(10)
    expect(env.inFlightAsyncCount()).toBe(0)
  })

  it('a double-settling thenable cannot drive the count negative', async () => {
    const env = freshEnv()
    const misbehaving: PromiseLike<void> = {
      then(onFul: any, onRej: any) {
        queueMicrotask(() => {
          onFul?.()
          onFul?.()
          onRej?.(new Error('x'))
        })
        return undefined as any
      },
    }
    bracketAsync(env, (() => misbehaving) as never)({} as never)
    await sleep(10)
    expect(env.inFlightAsyncCount()).toBe(0)
  })

  it('native promise and sync value behave exactly as before', async () => {
    const env = freshEnv()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const p = bracketAsync(env, (() => gate) as never)({} as never)
    expect(env.inFlightAsyncCount()).toBe(1)
    // The native branch still returns a DERIVED promise (`.finally`), unchanged.
    expect(p).not.toBe(gate)
    release()
    await p
    expect(env.inFlightAsyncCount()).toBe(0)

    expect(bracketAsync(env, (() => 7) as never)({} as never)).toBe(7)
    expect(env.inFlightAsyncCount()).toBe(0)
  })
})
