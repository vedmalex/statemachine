import { describe, expect, it } from 'vitest'
import { MemoryAdapter, type StateMachineConfig } from '../../index'
import { StateMachine } from '../../index'
import { type CapturedWrite, wrapAdapterForCapture } from '../../sim/capture'
import { makeSimClock } from '../../sim/clock'
import { SimDriver } from '../../sim/driver'
import { bracketAsync, makeAsyncCounter, makeEnv, makeObservableScheduler } from '../../sim/env'
import { NoopLogger } from '../../sim/noop-logger'
import { makePrng } from '../../sim/prng'
import { settleMacrostep } from '../../sim/settle'
import { SimErrorHandler } from '../../sim/sim-error-handler'
import { SimMonitor } from '../../sim/sim-monitor'

interface Box {
  state: string
  count: number
}

/** Build a driver wired to all five Sim seams for `config`/`initial`. */
function makeDriver<T extends object>(
  config: StateMachineConfig<T>,
  initial: T,
  opts: { transitionTimeout?: number; errorState?: string; policy?: 'safety' | 'liveness' } = {},
): { driver: SimDriver<T>; clock: ReturnType<typeof makeSimClock>; monitor: SimMonitor } {
  const clock = makeSimClock(0)
  const { scheduler, view } = makeObservableScheduler(clock)
  const monitor = new SimMonitor()
  const driver = new SimDriver<T>({
    config,
    owner: new MemoryAdapter<T>(initial),
    clock,
    scheduler,
    schedulerView: view,
    monitor,
    errorHandler: new SimErrorHandler(),
    logger: NoopLogger,
    prng: makePrng(0n),
    runtime: 'node-test',
    ...(opts.policy ? { policy: opts.policy } : {}),
    ...(opts.transitionTimeout !== undefined ? { transitionTimeout: opts.transitionTimeout } : {}),
    ...(opts.errorState !== undefined ? { errorState: opts.errorState } : {}),
  })
  return { driver, clock, monitor }
}

// ── DoD 7: post-construction drain + frame 0 + degenerate all-final ──────────

describe('driver: mandatory post-construction drain + frame 0 (DoD 7)', () => {
  it('init() records frame 0 only after the drain: cause:init, from===to===initialState', async () => {
    const config: StateMachineConfig<Box> = {
      name: 'Init',
      stateAttribute: 'state',
      initialState: 'idle',
      states: { idle: {}, active: {} },
      events: { go: { transitions: [{ from: 'idle', to: 'active' }] } },
    }
    const { driver } = makeDriver(config, { state: 'idle', count: 0 })
    await driver.init()
    const frames = driver.trace().frames
    expect(frames.length).toBeGreaterThanOrEqual(1)
    const frame0 = frames[0]!
    expect(frame0.step).toBe(0)
    expect(frame0.cause).toBe('init')
    expect(frame0.from).toBe('idle')
    expect(frame0.to).toBe('idle')
    expect(frame0.t).toBe(0)
  })

  it('header pins seed/prngVersion/runtime/errorHandlerEnabled', async () => {
    const config: StateMachineConfig<Box> = {
      name: 'H',
      stateAttribute: 'state',
      initialState: 'idle',
      states: { idle: {} },
      events: {},
    }
    const { driver } = makeDriver(config, { state: 'idle', count: 0 })
    await driver.init()
    const h = driver.trace().header
    expect(h.seed).toBe('0')
    expect(h.prngVersion).toBe('splitmix64-bigint-v1')
    expect(h.runtime).toBe('node-test')
    expect(h.errorHandlerEnabled).toBe(true)
  })

  it('degenerate all-final initial config: frame 0 is the init snapshot AFTER the drain', async () => {
    // A composite whose single region is already at its final leaf at init.
    const config: StateMachineConfig<Box> = {
      name: 'AllFinal',
      stateAttribute: 'state',
      initialState: 'p',
      states: {
        p: {
          regions: {
            r: { only: { final: true } },
          },
        },
      },
      events: {},
    }
    const { driver } = makeDriver(config, { state: 'p', count: 0 })
    await driver.init()
    const frames = driver.trace().frames
    // Frame 0 is the init snapshot (cause:'init'); it is the FIRST frame and is
    // recorded after the drain.
    expect(frames[0]!.cause).toBe('init')
    expect(frames[0]!.step).toBe(0)
    // No fire happened, so no 'external'/'reject' frame exists yet.
    expect(frames.every((f) => f.cause === 'init' || f.cause === 'timer')).toBe(true)
  })
})

// ── DoD 8/9: fixed macrostep ordering, three fire outcomes, explicit-Adapter,
//             frame-count relation (writes + 1 boundary) ─────────────────────

describe('driver: macrostep ordering + fire outcomes + frame count (DoD 8/9)', () => {
  it('classifies resolve-true / resolve-false / reject and passes explicit Adapter', async () => {
    const config: StateMachineConfig<Box> = {
      name: 'Outcomes',
      stateAttribute: 'state',
      initialState: 'idle',
      states: { idle: {}, active: {} },
      events: {
        go: { transitions: [{ from: 'idle', to: 'active' }] },
        // guard always false from 'active' -> resolve-false
        blocked: { transitions: [{ from: 'active', to: 'idle', guard: () => false }] },
      },
    }
    const { driver } = makeDriver(config, { state: 'idle', count: 0 })
    await driver.init()

    const r1 = await driver.step({ kind: 'fire', event: 'go' })
    expect(r1.frames.some((f) => f.fireOutcome === 'resolve-true')).toBe(true)
    expect(driver.machine.getCurrentState()).toBe('active')

    const r2 = await driver.step({ kind: 'fire', event: 'blocked' })
    expect(r2.frames.some((f) => f.fireOutcome === 'resolve-false')).toBe(true)

    const r3 = await driver.step({ kind: 'fire', event: 'undeclared' })
    expect(r3.frames.some((f) => f.fireOutcome === 'reject')).toBe(true)
  })

  it('per-step frame count == captured writes + exactly ONE settle-boundary frame', async () => {
    // Independently count the engine writes for the same transition, then assert
    // the driver emitted exactly that many write-frames PLUS one boundary frame.
    const config: StateMachineConfig<Box> = {
      name: 'Count',
      stateAttribute: 'state',
      initialState: 'idle',
      states: { idle: {}, active: {} },
      events: { go: { transitions: [{ from: 'idle', to: 'active' }] } },
    }

    // Reference write count via a bare wrapped machine.
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableScheduler(clock)
    const env = makeEnv(makeAsyncCounter(), view)
    const writes: CapturedWrite[] = []
    const owner = new MemoryAdapter<Box>({ state: 'idle', count: 0 })
    const wrapped = wrapAdapterForCapture(owner, 'state', { onStateWrite: (w) => writes.push(w) })
    const sm = new StateMachine<Box, typeof config>(config, wrapped as never, { clock: clock.now, scheduler })
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    writes.length = 0
    await sm.fireEvent('go', wrapped as never)
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    const refWriteCount = writes.length
    expect(refWriteCount).toBeGreaterThan(0)

    // Driver path.
    const { driver } = makeDriver(config, { state: 'idle', count: 0 })
    await driver.init()
    const r = await driver.step({ kind: 'fire', event: 'go' })
    expect(r.frames.length).toBe(refWriteCount + 1)
  })

  it("'advance' op moves the clock forward and uses cause:'timer'", async () => {
    const config: StateMachineConfig<Box> = {
      name: 'Adv',
      stateAttribute: 'state',
      initialState: 'start',
      states: { start: { invoke: [{ delay: 1000, event: 'go' }] }, next: {} },
      events: { go: { transitions: [{ from: 'start', to: 'next' }] } },
    }
    const { driver, clock } = makeDriver(config, { state: 'start', count: 0 }, { policy: 'liveness' })
    await driver.init()
    const r = await driver.step({ kind: 'advance', dtMs: 1000 })
    expect(clock.now()).toBe(1000)
    expect(r.frames.every((f) => f.cause === 'timer')).toBe(true)
    expect(driver.machine.getCurrentState()).toBe('next')
  })
})

// ── DoD 7 backstop / ADR-1 c10: errorState fallback settle-diff backstop ─────

describe('driver: errorState settle-diff backstop (DoD 7 / Step-2 #8)', () => {
  it('a throwing onEnter with an errorState produces a boundary frame whose to contains the errorState', async () => {
    const config: StateMachineConfig<Box> = {
      name: 'ErrState',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        boom: {
          onEnter: () => {
            throw new Error('boom')
          },
        },
        safe: {},
      },
      events: { go: { transitions: [{ from: 'idle', to: 'boom' }] } },
    }
    const { driver } = makeDriver(config, { state: 'idle', count: 0 }, { errorState: 'safe' })
    await driver.init()
    const r = await driver.step({ kind: 'fire', event: 'go' })
    // The errorState fallback (:2020) wrote 'safe'; the backstop boundary frame
    // (and/or a captured write) reflects the errorState in its `to`.
    const sawErrorState = r.frames.some((f) => f.to.split('|').includes('safe'))
    expect(sawErrorState).toBe(true)
  })
})

// ── DoD 13 / ISS-030: opaque async consumer (deferred-controlled) ────────────

describe('driver: opaque async consumer in-flight across a settle sample (DoD 13)', () => {
  it('an async invoke action observably in-flight blocks premature quiescence then settles', async () => {
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableScheduler(clock)
    const counter = makeAsyncCounter()
    const env = makeEnv(counter, view)

    let release: () => void = () => {}
    const gate = new Promise<void>((res) => {
      release = res
    })
    const config: StateMachineConfig<Box> = {
      name: 'Opaque',
      stateAttribute: 'state',
      initialState: 'start',
      states: {
        start: {
          invoke: [
            {
              delay: 0,
              event: 'go',
              // Opaque, manually-controlled deferred — NOT async()=>await
              // Promise.resolve() which settles in one microtask and could not
              // exercise the premature-quiescence hazard.
              action: bracketAsync(env, async () => {
                await gate
              }),
            },
          ],
        },
        next: {},
      },
      events: { go: { transitions: [{ from: 'start', to: 'next' }] } },
    }
    const adapter = new MemoryAdapter<Box>({ state: 'start', count: 0 })
    const sm = new StateMachine<Box, typeof config>(config, adapter, { clock: clock.now, scheduler })

    // Fire the invoke timer; let the action START (enterAsync ran) but not finish.
    scheduler.process?.(0)
    await Promise.resolve()
    await Promise.resolve()
    expect(env.inFlightAsyncCount()).toBeGreaterThan(0)

    // Release and settle: settleMacrostep must wait for the in-flight action AND
    // the follow-on 'go' transition before reporting quiescence.
    release()
    const result = await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    expect(result.quiescent).toBe(true)
    expect(env.inFlightAsyncCount()).toBe(0)
    expect(sm.getCurrentState()).toBe('next')
  })

  it('env.ts documents the two verified await sites and the string-method gap (ISS-030 ledger)', async () => {
    // The env module doc enumerates :2170 (invoke) and :2504 (resume) and the
    // string-method gap. This asserts the documented scope is present in source
    // (a CODE_REVIEW-grade ledger check, kept executable so it cannot silently
    // drift).
    const fs = await import('node:fs')
    const url = await import('node:url')
    const path = url.fileURLToPath(new URL('../../sim/env.ts', import.meta.url))
    const src = fs.readFileSync(path, 'utf8')
    expect(src).toContain(':2170')
    expect(src).toContain(':2504')
    expect(src.toLowerCase()).toContain('string-method')
  })
})

// ── DoD 11: all 12 dst.test.ts behaviors reproduced via settleMacrostep ──────
// (No flush(N); every settle-point matches the original currentState/count.)

describe('driver/settle: all 12 dst.test.ts behaviors via settleMacrostep (DoD 11)', () => {
  function singleInvoke(delay = 1000): StateMachineConfig<Box> {
    return {
      name: 'SingleInvoke',
      stateAttribute: 'state',
      initialState: 'start',
      states: {
        start: { invoke: [{ delay, event: 'go' }] },
        next: {
          onEnter: (o: Box) => {
            o.count++
          },
        },
      },
      events: { go: { transitions: [{ from: 'start', to: 'next' }] } },
    }
  }

  it('#1 invoke fires at exact virtual tick', async () => {
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableScheduler(clock)
    const env = makeEnv(makeAsyncCounter(), view)
    const adapter = new MemoryAdapter<Box>({ state: 'start', count: 0 })
    const sm = new StateMachine<Box, ReturnType<typeof singleInvoke>>(singleInvoke(1000), adapter, { clock: clock.now, scheduler })
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    expect(sm.getCurrentState()).toBe('start')
    clock.set(1000)
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    expect(sm.getCurrentState()).toBe('next')
  })

  it('#2 invoke does NOT fire before deadline', async () => {
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableScheduler(clock)
    const env = makeEnv(makeAsyncCounter(), view)
    const adapter = new MemoryAdapter<Box>({ state: 'start', count: 0 })
    const sm = new StateMachine<Box, ReturnType<typeof singleInvoke>>(singleInvoke(1000), adapter, { clock: clock.now, scheduler })
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    clock.set(999)
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    expect(sm.getCurrentState()).toBe('start')
  })

  it('#3 invoke fires exactly at boundary, idempotent settle', async () => {
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableScheduler(clock)
    const env = makeEnv(makeAsyncCounter(), view)
    const adapter = new MemoryAdapter<Box>({ state: 'start', count: 0 })
    const sm = new StateMachine<Box, ReturnType<typeof singleInvoke>>(singleInvoke(1000), adapter, { clock: clock.now, scheduler })
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    clock.set(1000)
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' }) // idempotent
    expect(sm.getCurrentState()).toBe('next')
    expect(adapter.adaptee.count).toBe(1)
  })

  it('#4 resumeTimers restores remaining delay across serialize/deserialize', async () => {
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableScheduler(clock)
    const env = makeEnv(makeAsyncCounter(), view)
    const config = singleInvoke(1000)
    const adapter = new MemoryAdapter<Box>({ state: 'start', count: 0 })
    const sm = new StateMachine<Box, typeof config>(config, adapter, { clock: clock.now, scheduler })
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    clock.set(400)
    const json = sm.toJSON()

    const { scheduler: scheduler2, view: view2 } = makeObservableScheduler(clock)
    const env2 = makeEnv(makeAsyncCounter(), view2)
    const adapter2 = new MemoryAdapter<Box>({ state: '', count: 0 })
    const sm2 = StateMachine.fromJSON<Box, typeof config>(json, adapter2, { clock: clock.now, scheduler: scheduler2, actions: { onEnter: (o: Box) => { o.count++ } } })
    await settleMacrostep({ sm: sm2, scheduler: scheduler2, clock, env: env2, policy: 'safety' })
    expect(sm2.getCurrentState()).toBe('start')
    clock.set(999)
    await settleMacrostep({ sm: sm2, scheduler: scheduler2, clock, env: env2, policy: 'safety' })
    expect(sm2.getCurrentState()).toBe('start')
    clock.set(1000)
    await settleMacrostep({ sm: sm2, scheduler: scheduler2, clock, env: env2, policy: 'safety' })
    expect(sm2.getCurrentState()).toBe('next')
  })

  it('#5 transitionTimeout aborts via virtual clock', async () => {
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableScheduler(clock)
    const env = makeEnv(makeAsyncCounter(), view)
    const config: StateMachineConfig<Box> = {
      name: 'TimeoutSM',
      stateAttribute: 'state',
      initialState: 'idle',
      states: { idle: {}, busy: { onEnter: () => new Promise<void>(() => {}) } },
      events: { go: { transitions: [{ from: 'idle', to: 'busy' }] } },
    }
    const adapter = new MemoryAdapter<Box>({ state: 'idle', count: 0 })
    const sm = new StateMachine<Box, typeof config>(config, adapter, { clock: clock.now, scheduler, transitionTimeout: 500 })
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })

    const settled: { rejected: boolean; err?: unknown } = { rejected: false }
    sm.fireEvent('go').catch((err) => {
      settled.rejected = true
      settled.err = err
    })
    clock.set(500)
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'liveness' })
    expect(settled.rejected).toBe(true)
  })

  it('#6 transitionTimeout does NOT abort a fast action', async () => {
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableScheduler(clock)
    const env = makeEnv(makeAsyncCounter(), view)
    const config: StateMachineConfig<Box> = {
      name: 'FastSM',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        done: {
          onEnter: (o: Box) => {
            o.count++
          },
        },
      },
      events: { go: { transitions: [{ from: 'idle', to: 'done' }] } },
    }
    const adapter = new MemoryAdapter<Box>({ state: 'idle', count: 0 })
    const sm = new StateMachine<Box, typeof config>(config, adapter, { clock: clock.now, scheduler, transitionTimeout: 500 })
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    await sm.fireEvent('go')
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    expect(sm.getCurrentState()).toBe('done')
    expect(adapter.adaptee.count).toBe(1)
  })

  it('#7 stateEntryTimes recorded with virtual clock', async () => {
    const clock = makeSimClock(123)
    const { scheduler, view } = makeObservableScheduler(clock)
    const env = makeEnv(makeAsyncCounter(), view)
    const config = singleInvoke(1000)
    const adapter = new MemoryAdapter<Box>({ state: 'start', count: 0 })
    const sm = new StateMachine<Box, typeof config>(config, adapter, { clock: clock.now, scheduler })
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    const json = sm.toJSON()

    const { scheduler: scheduler2, view: view2 } = makeObservableScheduler(clock)
    const env2 = makeEnv(makeAsyncCounter(), view2)
    const sm2 = StateMachine.fromJSON<Box, typeof config>(json, new MemoryAdapter<Box>({ state: '', count: 0 }), { clock: clock.now, scheduler: scheduler2, actions: { onEnter: (o: Box) => { o.count++ } } })
    await settleMacrostep({ sm: sm2, scheduler: scheduler2, clock, env: env2, policy: 'safety' })
    clock.set(1122)
    await settleMacrostep({ sm: sm2, scheduler: scheduler2, clock, env: env2, policy: 'safety' })
    expect(sm2.getCurrentState()).toBe('start')
    clock.set(1123)
    await settleMacrostep({ sm: sm2, scheduler: scheduler2, clock, env: env2, policy: 'safety' })
    expect(sm2.getCurrentState()).toBe('next')
  })

  it('#8 parallel regions: independent virtual timers', async () => {
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableScheduler(clock)
    const env = makeEnv(makeAsyncCounter(), view)
    const config: StateMachineConfig<Box> = {
      name: 'ParallelSM',
      stateAttribute: 'state',
      initialState: 'p',
      states: {
        p: {
          regions: {
            a: { a1: { invoke: [{ delay: 300, event: 'aDone' }] }, a2: {} },
            b: { b1: { invoke: [{ delay: 700, event: 'bDone' }] }, b2: {} },
          },
        },
      },
      events: {
        aDone: { transitions: [{ from: 'p.a.a1', to: 'p.a.a2' }] },
        bDone: { transitions: [{ from: 'p.b.b1', to: 'p.b.b2' }] },
      },
    }
    const adapter = new MemoryAdapter<Box>({ state: 'p', count: 0 })
    const sm = new StateMachine<Box, typeof config>(config, adapter, { clock: clock.now, scheduler })
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    clock.set(300)
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    expect(sm.getCurrentState()).toContain('p.a.a2')
    expect(sm.getCurrentState()).toContain('p.b.b1')
    clock.set(700)
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    expect(sm.getCurrentState()).toContain('p.a.a2')
    expect(sm.getCurrentState()).toContain('p.b.b2')
  })

  it('#9 deterministic region initial selection', async () => {
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableScheduler(clock)
    const env = makeEnv(makeAsyncCounter(), view)
    const config: StateMachineConfig<Box> = {
      name: 'RegionInitialSM',
      stateAttribute: 'state',
      initialState: 'p',
      states: { p: { regions: { r: { zeta: {}, alpha: {} } } } },
      events: {},
    }
    const adapter = new MemoryAdapter<Box>({ state: 'p', count: 0 })
    const sm = new StateMachine<Box, typeof config>(config, adapter, { clock: clock.now, scheduler })
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    expect(sm.getCurrentState()).toBe('p.r.zeta')
  })

  it('#10 getQueuedEvents age uses virtual clock', async () => {
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableScheduler(clock)
    const env = makeEnv(makeAsyncCounter(), view)
    const config: StateMachineConfig<Box> = {
      name: 'QueueAgeSM',
      stateAttribute: 'state',
      initialState: 'idle',
      states: { idle: {}, active: {} },
      events: { activate: { transitions: [{ from: 'idle', to: 'active' }] } },
    }
    const adapter = new MemoryAdapter<Box>({ state: 'idle', count: 0 })
    const sm = new StateMachine<Box, typeof config>(config, adapter, { clock: clock.now, scheduler })
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    const p = sm.fireEvent('activate')
    expect(sm.getQueuedEvents()[0]?.age).toBe(0)
    clock.set(250)
    expect(sm.getQueuedEvents()[0]?.age).toBe(250)
    await p
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    expect(sm.getCurrentState()).toBe('active')
  })

  it('#11 default options remain real-time (back-compat): a detached virtual scheduler cannot drive it', async () => {
    const clock = makeSimClock(0)
    const { scheduler: detached, view } = makeObservableScheduler(clock)
    const env = makeEnv(makeAsyncCounter(), view)
    const adapter = new MemoryAdapter<Box>({ state: 'start', count: 0 })
    // NO scheduler option: schedulerProvided === false; invoke uses native setTimeout.
    const sm = new StateMachine<Box, ReturnType<typeof singleInvoke>>(singleInvoke(1000), adapter)
    // We can still settle microtasks via our primitive against a detached view;
    // advancing the detached scheduler does nothing to the real-time machine.
    await settleMacrostep({
      sm,
      scheduler: detached,
      clock,
      env,
      policy: 'safety',
    }).catch(() => {})
    expect(sm.getCurrentState()).toBe('start')
    clock.set(5000)
    detached.process?.(5000)
    await Promise.resolve()
    expect(sm.getCurrentState()).toBe('start')
  })

  it('#12 explicit unstarted real scheduler is routed through (not setTimeout)', async () => {
    const clock = makeSimClock(0)
    // Use the observable virtual scheduler as the explicit (drainable) scheduler;
    // it is never started via setPollingInterval, mirroring the dst #12 contract
    // that an explicitly-provided scheduler is routed through regardless.
    const { scheduler, view } = makeObservableScheduler(clock)
    const env = makeEnv(makeAsyncCounter(), view)
    const adapter = new MemoryAdapter<Box>({ state: 'start', count: 0 })
    const sm = new StateMachine<Box, ReturnType<typeof singleInvoke>>(singleInvoke(1000), adapter, { clock: clock.now, scheduler })
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    expect(sm.getCurrentState()).toBe('start')
    clock.set(999)
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    expect(sm.getCurrentState()).toBe('start')
    clock.set(1000)
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    expect(sm.getCurrentState()).toBe('next')
  })
})

// ── Determinism: same seed/spec -> identical trace hash (forward-ref AC-1) ────

describe('driver: replay determinism canary (ADR-3 contract 9)', () => {
  it('two runs of the same scenario produce an identical traceHash', async () => {
    const config: StateMachineConfig<Box> = {
      name: 'Replay',
      stateAttribute: 'state',
      initialState: 'idle',
      states: { idle: {}, active: { onEnter: (o: Box) => { o.count++ } } },
      events: { go: { transitions: [{ from: 'idle', to: 'active' }] } },
    }
    async function run(): Promise<string> {
      const { driver } = makeDriver(config, { state: 'idle', count: 0 })
      await driver.init()
      await driver.step({ kind: 'fire', event: 'go' })
      await driver.step({ kind: 'noop' })
      const { hashTrace } = await import('../../sim/trace')
      return hashTrace(driver.trace())
    }
    const a = await run()
    const b = await run()
    expect(a).toBe(b)
  })
})

// ── DoD 12: engine constructed with all five seams (no omission) ─────────────

describe('driver: all five DI seams forwarded (DoD 12)', () => {
  it('the monitor seam receives recordTransition calls (proves monitor was wired)', async () => {
    const config: StateMachineConfig<Box> = {
      name: 'Seams',
      stateAttribute: 'state',
      initialState: 'idle',
      states: { idle: {}, active: {} },
      events: { go: { transitions: [{ from: 'idle', to: 'active' }] } },
    }
    const { driver, monitor } = makeDriver(config, { state: 'idle', count: 0 })
    await driver.init()
    await driver.step({ kind: 'fire', event: 'go' })
    // recordTransition is the engine's SOLE monitor call site (:2060); a nonzero
    // count proves the SimMonitor seam was forwarded (not the default monitor).
    expect(monitor.getTransitionCount()).toBeGreaterThan(0)
  })
})
