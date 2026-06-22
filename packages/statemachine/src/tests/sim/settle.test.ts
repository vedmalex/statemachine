import { describe, expect, it, vi } from 'vitest'
import { MemoryAdapter, type StateMachineConfig } from '../../index'
import { StateMachine } from '../../index'
import { makeSimClock } from '../../sim/clock'
import {
  type Env,
  type SchedulerView,
  bracketAsync,
  makeAsyncCounter,
  makeEnv,
  makeObservableScheduler,
} from '../../sim/env'
import {
  DEFAULT_MAX_TURNS,
  type SettleTarget,
  settleMacrostep,
} from '../../sim/settle'

/**
 * Step-3 tests for the SOLE settle primitive (ADR-4 / R2). No flush(N); the only
 * async pump is `await Promise.resolve()` inside settleMacrostep.
 */

interface Box {
  state: string
  count: number
}

// ── DoD 1/2: grep-enforceable invariants (asserted structurally here) ─────────

describe('settle.ts: single-primitive + microtask-only pump (DoD 1/2)', () => {
  it('settleMacrostep is the only exported settle surface (no flush/drain alias)', async () => {
    const mod = await import('../../sim/settle')
    const settleLikeExports = Object.keys(mod).filter((k) =>
      /flush|drainToQuiescence|untilIdle/i.test(k),
    )
    expect(settleLikeExports).toEqual([])
    expect(typeof mod.settleMacrostep).toBe('function')
  })

  it('DEFAULT_MAX_TURNS is neither 16 nor 100 (DoD 5)', () => {
    expect(DEFAULT_MAX_TURNS).not.toBe(16)
    expect(DEFAULT_MAX_TURNS).not.toBe(100)
    expect(DEFAULT_MAX_TURNS).toBe(1024)
  })
})

// ── DoD 3: CRIT-1 — inFlightAsyncCount conjunct diverges from structural-only ──

describe('settle.ts: CRIT-1 in-flight settledness conjunct (DoD 3)', () => {
  it('structural predicate and full predicate DIVERGE on an in-flight tick (function-valued invoke)', async () => {
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableScheduler(clock)
    const counter = makeAsyncCounter()
    const env = makeEnv(counter, view)

    // A deferred we control: the invoke action stays in-flight until we resolve.
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => {
      release = res
    })

    const config: StateMachineConfig<Box> = {
      name: 'InFlight',
      stateAttribute: 'state',
      initialState: 'start',
      states: {
        start: {
          invoke: [
            {
              delay: 0,
              event: 'go',
              // function-valued (path-2) async action — wrappable by bracketAsync.
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
    const sm = new StateMachine<Box, typeof config>(config, adapter, {
      clock: clock.now,
      scheduler,
    })

    // Settle construction so the delay:0 invoke timer is armed.
    // Use a short bounded pump that STOPS while the action is in flight so we can
    // sample both predicates on the same tick.
    scheduler.process?.(clock.now())
    // Let the invoke callback start (it awaits the gate -> enterAsync ran).
    await Promise.resolve()
    await Promise.resolve()

    const structural = sm.getQueueDepth().total === 0 && sm.isProcessingEvents() === false
    const full = structural && env.inFlightAsyncCount() === 0

    // STRUCTURAL would claim quiescent (queue empty, not processing) while the
    // action is mid-flight and 'go' is not yet enqueued; the in-flight conjunct
    // (full) is FALSE. They diverge.
    expect(env.inFlightAsyncCount()).toBeGreaterThan(0)
    expect(structural).toBe(true)
    expect(full).toBe(false)

    // Now release and settle fully: settleMacrostep must wait for the in-flight
    // action AND the follow-on 'go' transition.
    release()
    const result = await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    expect(result.quiescent).toBe(true)
    expect(env.inFlightAsyncCount()).toBe(0)
    expect(sm.getCurrentState()).toBe('next')
  })
})

// ── DoD 4: CRIT-2 — re-arm fixture + dst#3 idempotency preservation ──────────

describe('settle.ts: CRIT-2 same-instant re-arm + idempotency (DoD 4)', () => {
  it('a timer whose callback re-arms a delay:0 timer settles at the same instant', async () => {
    // Purpose-built: invoke at delay:0 raises an event whose target re-arms
    // another delay:0 invoke; the converged loop must chase the chain at t=0.
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableScheduler(clock)
    const env = makeEnv(makeAsyncCounter(), view)

    const config: StateMachineConfig<Box> = {
      name: 'ReArm',
      stateAttribute: 'state',
      initialState: 'a',
      states: {
        a: { invoke: [{ delay: 0, event: 'toB' }] },
        b: {
          invoke: [{ delay: 0, event: 'toC' }],
          onEnter: (o: Box) => {
            o.count++
          },
        },
        c: {
          onEnter: (o: Box) => {
            o.count++
          },
        },
      },
      events: {
        toB: { transitions: [{ from: 'a', to: 'b' }] },
        toC: { transitions: [{ from: 'b', to: 'c' }] },
      },
    }
    const adapter = new MemoryAdapter<Box>({ state: 'a', count: 0 })
    const sm = new StateMachine<Box, typeof config>(config, adapter, { clock: clock.now, scheduler })

    const result = await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    expect(result.quiescent).toBe(true)
    // The whole a -> b -> c chain ran at t=0 without advancing the clock.
    expect(clock.now()).toBe(0)
    expect(sm.getCurrentState()).toBe('c')
    expect(adapter.adaptee.count).toBe(2)
  })

  it('preserves dst.test.ts#3 idempotency: a second settle at the same t does not re-fire', async () => {
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableScheduler(clock)
    const env = makeEnv(makeAsyncCounter(), view)
    const config: StateMachineConfig<Box> = {
      name: 'Idempotent',
      stateAttribute: 'state',
      initialState: 'start',
      states: {
        start: { invoke: [{ delay: 1000, event: 'go' }] },
        next: {
          onEnter: (o: Box) => {
            o.count++
          },
        },
      },
      events: { go: { transitions: [{ from: 'start', to: 'next' }] } },
    }
    const adapter = new MemoryAdapter<Box>({ state: 'start', count: 0 })
    const sm = new StateMachine<Box, typeof config>(config, adapter, { clock: clock.now, scheduler })

    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    clock.set(1000)
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    expect(sm.getCurrentState()).toBe('next')
    expect(adapter.adaptee.count).toBe(1)

    // Second convergence pass at the same t MUST NOT re-fire (count stays 1).
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    expect(adapter.adaptee.count).toBe(1)
  })
})

// ── DoD 5: budget exhaustion is a first-class finding, never a throw ─────────

describe('settle.ts: budget exhaustion finding (DoD 5)', () => {
  it('returns microtask-budget non-quiescent on exhaustion without throwing', async () => {
    const clock = makeSimClock(0)
    // A SchedulerView that is always empty; an Env whose in-flight count never
    // reaches 0 simulates an unbounded in-flight situation.
    const view: SchedulerView = { schedulerEmptyAt: () => true, earliestExecuteAt: () => null }
    const stuckEnv: Env = {
      inFlightAsyncCount: () => 1, // never settles
      enterAsync: () => {},
      exitAsync: () => {},
      schedulerEmptyAt: view.schedulerEmptyAt,
      earliestExecuteAt: view.earliestExecuteAt,
    }
    const sm: SettleTarget = {
      getQueueDepth: () => ({ internal: 0, external: 0, total: 0 }),
      isProcessingEvents: () => false,
    }
    const result = await settleMacrostep({
      sm,
      scheduler: { process: () => {} },
      clock,
      env: stuckEnv,
      policy: 'safety',
      maxTurns: 8,
    })
    expect(result.quiescent).toBe(false)
    expect(result.reason).toBe('microtask-budget')
    expect(result.turns).toBeGreaterThanOrEqual(8)
  })
})

// ── DoD 6: single policy-jump (WAITING_ON_TIMER + WAITING_ON_TRANSITION_TIMEOUT) ─

describe('settle.ts: policy-parameterized clock jump (DoD 6)', () => {
  it("policy:'safety' records WAITING_ON_TIMER and does NOT jump", async () => {
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableScheduler(clock)
    const env = makeEnv(makeAsyncCounter(), view)
    const config: StateMachineConfig<Box> = {
      name: 'Timer',
      stateAttribute: 'state',
      initialState: 'start',
      states: {
        start: { invoke: [{ delay: 1000, event: 'go' }] },
        next: {},
      },
      events: { go: { transitions: [{ from: 'start', to: 'next' }] } },
    }
    const adapter = new MemoryAdapter<Box>({ state: 'start', count: 0 })
    const sm = new StateMachine<Box, typeof config>(config, adapter, { clock: clock.now, scheduler })

    const result = await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
    expect(result.quiescent).toBe(false)
    expect(result.reason).toBe('WAITING_ON_TIMER')
    expect(clock.now()).toBe(0) // no jump
    expect(sm.getCurrentState()).toBe('start')
  })

  it("policy:'liveness' jumps to earliestExecuteAt() and the timer fires", async () => {
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableScheduler(clock)
    const env = makeEnv(makeAsyncCounter(), view)
    const config: StateMachineConfig<Box> = {
      name: 'TimerLive',
      stateAttribute: 'state',
      initialState: 'start',
      states: {
        start: { invoke: [{ delay: 1000, event: 'go' }] },
        next: {},
      },
      events: { go: { transitions: [{ from: 'start', to: 'next' }] } },
    }
    const adapter = new MemoryAdapter<Box>({ state: 'start', count: 0 })
    const sm = new StateMachine<Box, typeof config>(config, adapter, { clock: clock.now, scheduler })

    const jumps: number[] = []
    const result = await settleMacrostep({
      sm,
      scheduler,
      clock,
      env,
      policy: 'liveness',
      onClockJump: (t) => jumps.push(t),
    })
    expect(result.quiescent).toBe(true)
    expect(clock.now()).toBe(1000)
    expect(jumps).toContain(1000)
    expect(sm.getCurrentState()).toBe('next')
  })

  it("policy:'safety' classifies WAITING_ON_TRANSITION_TIMEOUT for an in-flight action blocked on a future deadline", async () => {
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableScheduler(clock)
    const env = makeEnv(makeAsyncCounter(), view)
    const config: StateMachineConfig<Box> = {
      name: 'TimeoutSM',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        // onEnter never resolves; only the transitionTimeout timer (future) can
        // clear the in-flight transition. In 'safety' (no jump) the macrostep is
        // blocked on that future deadline.
        busy: { onEnter: () => new Promise<void>(() => {}) },
      },
      events: { go: { transitions: [{ from: 'idle', to: 'busy' }] } },
    }
    const adapter = new MemoryAdapter<Box>({ state: 'idle', count: 0 })
    const sm = new StateMachine<Box, typeof config>(config, adapter, {
      clock: clock.now,
      scheduler,
      transitionTimeout: 500,
    })
    await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })

    const firePromise = sm.fireEvent('go')
    firePromise.catch(() => {})

    const result = await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety', maxTurns: 32 })
    expect(result.quiescent).toBe(false)
    expect(result.reason).toBe('WAITING_ON_TRANSITION_TIMEOUT')

    // 'liveness' jumps so the timeout fires and the in-flight transition rejects.
    const live = await settleMacrostep({ sm, scheduler, clock, env, policy: 'liveness', maxTurns: 64 })
    expect(clock.now()).toBe(500)
    expect(live.quiescent).toBe(true)
  })
})

// ── DoD 10: lazy-cancel shim ─────────────────────────────────────────────────

describe('env.ts: SchedulerView honors lazy-cancel (DoD 10)', () => {
  it('a cancelled timer is invisible to schedulerEmptyAt / earliestExecuteAt', () => {
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableScheduler(clock)
    const token = scheduler.schedule(1000, () => {})
    expect(view.schedulerEmptyAt(2000)).toBe(false)
    expect(view.earliestExecuteAt()).toBe(1000)

    scheduler.cancel(token)
    expect(view.schedulerEmptyAt(2000)).toBe(true)
    expect(view.earliestExecuteAt()).toBe(null)
  })
})

// ── DoD 2: no-real-timer pump works with fake timers on AND off ──────────────

describe('settle.ts: microtask pump uses no real timer (DoD 2)', () => {
  it('settles identically with vi.useFakeTimers() active and inactive', async () => {
    async function run(): Promise<string> {
      const clock = makeSimClock(0)
      const { scheduler, view } = makeObservableScheduler(clock)
      const env = makeEnv(makeAsyncCounter(), view)
      const config: StateMachineConfig<Box> = {
        name: 'NoRealTimer',
        stateAttribute: 'state',
        initialState: 'a',
        states: { a: { invoke: [{ delay: 0, event: 'go' }] }, b: {} },
        events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
      }
      const adapter = new MemoryAdapter<Box>({ state: 'a', count: 0 })
      const sm = new StateMachine<Box, typeof config>(config, adapter, { clock: clock.now, scheduler })
      const r = await settleMacrostep({ sm, scheduler, clock, env, policy: 'safety' })
      expect(r.quiescent).toBe(true)
      return sm.getCurrentState() ?? ''
    }

    const real = await run()

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    try {
      const faked = await run()
      expect(faked).toBe(real)
      expect(faked).toBe('b')
    } finally {
      vi.useRealTimers()
    }
  })
})
