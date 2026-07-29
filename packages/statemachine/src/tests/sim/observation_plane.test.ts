/**
 * @module tests/sim/observation_plane — W8 V5a / V5b / V3a / V8.
 *
 * These pin the three OBSERVATION-PLANE enrichments the W8 sim-oracle block rests
 * on. Each one is a claim about what the harness can SEE, and each is asserted
 * against a REAL engine run — never a synthetic frame — because the whole point is
 * that the engine actually emits it:
 *
 *   V5a  `recordTransition` carries a {@link TransitionContext} on the SUCCESS
 *        path, so an INTERNALLY raised cause (`done.state.<C>`) is attributable.
 *   V5b  `doneDelta` is sampled on the Simulator/VERDICT path, not only in
 *        coverage.ts.
 *   V8   a STRING-METHOD invoke action is visible to the harness settledness
 *        signal (ISS-030), which is what let I-3 join the DEFAULT builtin set.
 *   V3a  the lifecycle stream reaches the checker context and a REAL engine run
 *        satisfies the I-4 hierarchy-order predicate.
 *   W9/Г1 the ENGINE-side `kind:'raise'` records exist at ALL FIVE internal raise
 *        sites, reach the checker context, and give the I-5 parallel-join oracle
 *        REAL teeth — proven by a PLANTED DEFECT in the observation path (a monitor
 *        decorator that drops raise records) rather than by mutating the engine.
 */
import { describe, expect, it } from 'vitest'
import { MemoryAdapter, StateMachine, type LifecycleEvent, type StateMachineConfig } from '../../index'
import { makeSimClock } from '../../sim/clock'
import { SimDriver } from '../../sim/driver'
import { makeObservableScheduler } from '../../sim/env'
import { INVARIANTS, buildConfigGraph } from '../../sim/invariants'
import type { CheckerContext, LifecycleObservation } from '../../sim/invariants'
import { runSafety } from '../../sim/invariants.runner'
import { NoopLogger } from '../../sim/noop-logger'
import { makePrng } from '../../sim/prng'
import { runSimulation } from '../../sim/public'
import { SimErrorHandler } from '../../sim/sim-error-handler'
import { SimMonitor } from '../../sim/sim-monitor'

type Box = { state: string; [k: string]: unknown }

/** A parallel composite with a DECLARED `done.state.C` join leaving the composite. */
function joinConfig(): { config: unknown; owner: Box } {
  return {
    config: {
      name: 'join',
      stateAttribute: 'state',
      initialState: 'C',
      states: {
        C: {
          regions: {
            r1: { w1: {}, d1: { final: true } },
            r2: { w2: {}, d2: { final: true } },
          },
        },
        after: { final: true },
      },
      events: {
        f1: { transitions: [{ from: 'C.r1.w1', to: 'C.r1.d1' }] },
        f2: { transitions: [{ from: 'C.r2.w2', to: 'C.r2.d2' }] },
        'done.state.C': { transitions: [{ from: 'C', to: 'after' }] },
      },
    },
    owner: { state: 'C' },
  }
}

function makeDriver<T extends object>(
  config: StateMachineConfig<T>,
  initial: T,
  monitor: SimMonitor,
): SimDriver<T> {
  const clock = makeSimClock(0)
  const { scheduler, view } = makeObservableScheduler(clock)
  return new SimDriver<T>({
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
    policy: 'safety',
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// V5a — TransitionContext on the SUCCESS path
// ═══════════════════════════════════════════════════════════════════════════

describe('W8/V5a: recordTransition carries a TransitionContext on the SUCCESS path', () => {
  it('attributes an INTERNALLY raised done.state.<C> to the state write it produced', async () => {
    const monitor = new SimMonitor()
    const { config, owner } = joinConfig()
    const driver = makeDriver(config as StateMachineConfig<Box>, owner, monitor)
    await driver.init()
    await driver.step({ kind: 'fire', event: 'f1' })
    await driver.step({ kind: 'fire', event: 'f2' })

    const contexts = monitor.getTransitionContexts()
    // The join event NEVER appears on any external surface: the driver fired only
    // f1/f2, and a trace frame's `event` is populated from the step's EXTERNAL op.
    // The monitor context is the ONLY place this cause is observable.
    const join = contexts.filter((c) => c.eventName === 'done.state.C')
    expect(join.length).toBeGreaterThan(0)
    // A COMMITTED transition, not a refusal: the two refusal sites both report
    // fromState === toState, so a moved configuration proves this came from the
    // success site the V5a edit added.
    const committed = join.filter((c) => c.fromState !== c.toState)
    expect(committed.length).toBe(1)
    expect(committed[0]?.toState).toContain('after')
    // and the externally-fired events are attributed too.
    expect(contexts.some((c) => c.eventName === 'f1')).toBe(true)
    expect(contexts.some((c) => c.eventName === 'f2')).toBe(true)
  })

  it('is purely ADDITIVE: a monitor that ignores the third argument is unaffected', async () => {
    // The pre-W8 two-argument contract still holds — success/failure counting is
    // byte-for-byte what it was, and no context is required to reach it.
    const monitor = new SimMonitor()
    const { config, owner } = joinConfig()
    const driver = makeDriver(config as StateMachineConfig<Box>, owner, monitor)
    await driver.init()
    await driver.step({ kind: 'fire', event: 'f1' })
    expect(monitor.getTransitionCount()).toBeGreaterThan(0)
    expect(monitor.getErrorCount()).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// V5b — doneDelta on the VERDICT path
// ═══════════════════════════════════════════════════════════════════════════

describe('W8/V5b: doneDelta is sampled on the Simulator/verdict path', () => {
  it('stamps the isDone(C) projection onto settle-boundary frames of a composite run', async () => {
    const result = await runSimulation<Box>((() => joinConfig()) as never, { seed: '5', steps: 8, mode: 'both' })
    const withDelta = result.trace.filter((f) => f.doneDelta !== undefined)
    // Previously ZERO on this path (only coverage.ts ever injected it), which made
    // every doneDelta-keyed oracle and the liveness `terminal` derivation vacuous.
    expect(withDelta.length).toBeGreaterThan(0)
    for (const f of withDelta) {
      expect(f.doneDelta?.map((d) => d.composite)).toContain('C')
    }
    // The projection is not constant: the composite is observed BOTH not-done and
    // done across the run, so it tracks the real configuration rather than a stub.
    const flags = new Set(withDelta.flatMap((f) => (f.doneDelta ?? []).map((d) => d.done)))
    expect(flags.has(false)).toBe(true)
  })

  it('a composite-FREE config keeps its pre-W8 frame shape (no doneDelta key at all)', async () => {
    const flat = () => ({
      config: {
        name: 'flat',
        stateAttribute: 'state',
        initialState: 's1',
        states: { s1: {}, s2: {} },
        events: { go: { transitions: [{ from: 's1', to: 's2' }] } },
      },
      owner: { state: 's1' } as Box,
    })
    const result = await runSimulation<Box>(flat as never, { seed: '5', steps: 4 })
    expect(result.trace.every((f) => f.doneDelta === undefined)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// V8 / ISS-030 — a string-method invoke action is visible to the settledness signal
// ═══════════════════════════════════════════════════════════════════════════

describe('W8/V8 (ISS-030): a STRING-METHOD invoke action reaches the settledness signal', () => {
  it('holds the harness in-flight count above zero while it runs, and releases it', async () => {
    const monitor = new SimMonitor()
    /** in-flight readings taken from INSIDE the string-resolved action body. */
    const insideMonitor: number[] = []
    const insideEnv: number[] = []
    let driverRef: SimDriver<Box> | undefined

    const owner: Box = {
      state: 'working',
      // Resolved by NAME inside `callAction`, PAST the config-layer wrap boundary —
      // this is exactly the action form `bracketAsync` structurally cannot wrap.
      doWork: async () => {
        await Promise.resolve()
        insideMonitor.push(monitor.invokeActionInFlightCount())
        insideEnv.push(driverRef?.environment.inFlightAsyncCount() ?? -1)
      },
    }
    const config = {
      name: 'strInvoke',
      stateAttribute: 'state',
      initialState: 'working',
      states: {
        working: { invoke: [{ delay: 0, event: 'ping', action: 'doWork' }] },
        done: { final: true },
      },
      events: { ping: { transitions: [{ from: 'working', to: 'done' }] } },
    }
    const driver = makeDriver(config as unknown as StateMachineConfig<Box>, owner, monitor)
    driverRef = driver
    await driver.init()

    expect(insideMonitor.length).toBeGreaterThan(0)
    // WHILE the string action was running the harness could see it...
    expect(insideMonitor.every((n) => n > 0)).toBe(true)
    expect(insideEnv.every((n) => n > 0)).toBe(true)
    // ...and the bracket closed cleanly afterwards. A count that never returned to
    // zero would wedge `settleMacrostep` — no macrostep could ever be quiescent.
    expect(monitor.invokeActionInFlightCount()).toBe(0)
    expect(driver.environment.inFlightAsyncCount()).toBe(0)
    expect(driver.machine.getCurrentState()).toBe('done')
  })

  it('the harness in-flight count returns to zero even when the action THROWS', async () => {
    const monitor = new SimMonitor()
    const owner: Box = {
      state: 'working',
      boom: async () => {
        await Promise.resolve()
        throw new Error('action failed')
      },
    }
    const config = {
      name: 'strInvokeThrow',
      stateAttribute: 'state',
      initialState: 'working',
      states: {
        working: { invoke: [{ delay: 0, event: 'ping', action: 'boom' }] },
        done: { final: true },
      },
      events: { ping: { transitions: [{ from: 'working', to: 'done' }] } },
    }
    const driver = makeDriver(config as unknown as StateMachineConfig<Box>, owner, monitor)
    await driver.init()
    // The `end` edge is emitted on the FAILURE path too (state_machine.ts
    // runTracedInvokeAction catch), so a throwing action cannot leak the bracket.
    expect(monitor.invokeActionInFlightCount()).toBe(0)
    expect(driver.environment.inFlightAsyncCount()).toBe(0)
  })

  it('a long-running invoke OPERATION is deliberately NOT counted (it would wedge quiescence)', async () => {
    const monitor = new SimMonitor()
    let settle: (() => void) | undefined
    const owner: Box = { state: 'working' }
    const config = {
      name: 'longOp',
      stateAttribute: 'state',
      initialState: 'working',
      states: {
        working: {
          invoke: [
            {
              // A subscription-shaped operation whose promise outlives the
              // macrostep. Folding `invoke.operation` into the in-flight count
              // would make `inFlightAsyncCount()` permanently non-zero and NO
              // macrostep could ever reach quiescence.
              src: () => new Promise<void>((res) => { settle = res }),
              onDone: 'ping',
            },
          ],
        },
        done: { final: true },
      },
      events: { ping: { transitions: [{ from: 'working', to: 'done' }] } },
    }
    const driver = makeDriver(config as unknown as StateMachineConfig<Box>, owner, monitor)
    await driver.init()
    // The operation IS observable on the channel (an unmatched `begin`)...
    const opBegins = monitor.getLifecycle().filter((e) => e.hook === 'invoke.operation' && e.edge === 'begin')
    expect(opBegins.length).toBeGreaterThan(0)
    // ...but it is NOT part of the settledness count, so the driver stays usable.
    expect(monitor.invokeActionInFlightCount()).toBe(0)
    expect(driver.environment.inFlightAsyncCount()).toBe(0)
    settle?.()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// V3a — the lifecycle plane reaches the checkers, and a REAL run is in order
// ═══════════════════════════════════════════════════════════════════════════

describe('W8/V3a: the lifecycle plane reaches the SAFETY checkers', () => {
  /** The engine config used for the e2e order check: hooks at BOTH hierarchy levels. */
  const hookedJoin = () => ({
    config: {
      name: 'hooked',
      stateAttribute: 'state',
      initialState: 'C',
      states: {
        C: {
          onEnter: (o: Box) => {
            o.log = `${String(o.log ?? '')}+C`
          },
          onExit: (o: Box) => {
            o.log = `${String(o.log ?? '')}-C`
          },
          regions: {
            r1: {
              w1: {
                onEnter: (o: Box) => {
                  o.log = `${String(o.log ?? '')}+w1`
                },
                onExit: (o: Box) => {
                  o.log = `${String(o.log ?? '')}-w1`
                },
              },
              d1: { final: true },
            },
            r2: { w2: {}, d2: { final: true } },
          },
        },
        after: { final: true },
      },
      events: {
        f1: { transitions: [{ from: 'C.r1.w1', to: 'C.r1.d1' }] },
        f2: { transitions: [{ from: 'C.r2.w2', to: 'C.r2.d2' }] },
        'done.state.C': { transitions: [{ from: 'C', to: 'after' }] },
      },
    },
    owner: { state: 'C', log: '' } as Box,
  })

  it('a REAL engine run emits enter/exit records and satisfies the I-4 predicate', async () => {
    const monitor = new SimMonitor()
    const { config, owner } = hookedJoin()
    const driver = makeDriver(config as unknown as StateMachineConfig<Box>, owner, monitor)
    await driver.init()
    await driver.step({ kind: 'fire', event: 'f1' })
    await driver.step({ kind: 'fire', event: 'f2' })

    const stream: readonly LifecycleObservation[] = monitor.getLifecycle()
    // Non-vacuity: the run really did produce hook records at both levels, so a
    // green I-4 below is a checked property and not an empty-input pass.
    expect(stream.some((e) => e.kind === 'enter' && e.edge === 'begin')).toBe(true)
    expect(stream.some((e) => e.kind === 'exit' && e.edge === 'begin')).toBe(true)
    expect(stream.some((e) => e.state === 'C')).toBe(true)
    expect(stream.some((e) => e.state === 'C.r1.w1')).toBe(true)

    const inv4 = INVARIANTS.find((i) => i.id === 'I-4')
    const ctx = {
      graph: { getRegionKey: (s: string) => s, depthOf: () => 0, isRegisteredLeaf: () => true, states: new Set<string>(), composites: new Set<string>(), declaredDoneEvents: new Set<string>() },
      header: driver.trace().header,
      lifecycle: stream,
    } as unknown as CheckerContext
    expect(
      inv4?.checkFinal?.({ config: 'after', queue: { internal: 0, external: 0 }, quiescent: true }, ctx) ?? null,
    ).toBeNull()
  })

  it('the Simulator wires ctx.lifecycle, so I-4 is live in a default runSimulation', async () => {
    // The default builtin registry now INCLUDES I-4; a clean composite run with real
    // hooks must stay ok. (If ctx.lifecycle were not wired, I-4 would be vacuous and
    // this would pass for the wrong reason — the previous test pins non-vacuity.)
    const result = await runSimulation<Box>(hookedJoin as never, { seed: '9', steps: 10, mode: 'both' })
    expect(result.violation).toBeUndefined()
    expect(result.ok).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// W9/Г1 — the `kind:'raise'` plane: engine conformance + REAL I-5 teeth
// ═══════════════════════════════════════════════════════════════════════════

/** Every retained raise record of a run, in seq order. */
function raisesOf(monitor: SimMonitor): readonly LifecycleObservation[] {
  return monitor.getRaises()
}
/** The `begin` halves only — one per raise (the pair is adjacent begin+end). */
function raiseBegins(monitor: SimMonitor): readonly LifecycleObservation[] {
  return raisesOf(monitor).filter((r) => r.edge === 'begin')
}

describe('W9/Г1 conformance: ALL FIVE internal raise sites emit a kind:raise record', () => {
  // The five sites are the complete set of `raiseEvent` callers. Each is pinned by
  // its OWN test: a regression that silences one of them must not be masked by the
  // other four. The `origin` parameter is REQUIRED at the call site, so a SIXTH
  // raise site cannot be added without declaring its hook — that is the structural
  // half of this guarantee, and these tests are the behavioural half.

  it("(1) raise.done — a composite reaching all-final raises 'done.state.<C>'", async () => {
    const monitor = new SimMonitor()
    const { config, owner } = joinConfig()
    const driver = makeDriver(config as StateMachineConfig<Box>, owner, monitor)
    await driver.init()
    await driver.step({ kind: 'fire', event: 'f1' })
    await driver.step({ kind: 'fire', event: 'f2' })

    const done = raiseBegins(monitor).filter((r) => r.hook === 'raise.done')
    expect(done.length).toBe(1)
    expect(done[0]?.kind).toBe('raise')
    expect(done[0]?.event).toBe('done.state.C')
    // `state` is the COMPOSITE whose completion produced the event.
    expect(done[0]?.state).toBe('C')
    // raise.done carries the CURRENT microstep, never the reserved 0.
    expect(done[0]?.microstep).toBeGreaterThan(0)
    // ADJACENT begin+end pair (the invoke.abort precedent), never a lone begin.
    const all = raisesOf(monitor).filter((r) => r.hook === 'raise.done')
    expect(all.map((r) => r.edge)).toEqual(['begin', 'end'])
    expect(all[1]?.seq).toBe((all[0]?.seq ?? -1) + 1)
    // The raise plane is kept OUT of the callback-timeline buffer.
    expect(monitor.getLifecycle().some((e) => e.kind === 'raise')).toBe(false)
  })

  it('(2) raise.invoke.timer — an invoke TIMER elapsing raises its event', async () => {
    const monitor = new SimMonitor()
    const config = {
      name: 'timerRaise',
      stateAttribute: 'state',
      initialState: 'waiting',
      states: { waiting: { invoke: [{ delay: 0, event: 'tick' }] }, done: { final: true } },
      events: { tick: { transitions: [{ from: 'waiting', to: 'done' }] } },
    }
    const driver = makeDriver(config as unknown as StateMachineConfig<Box>, { state: 'waiting' }, monitor)
    await driver.init()

    const timer = raiseBegins(monitor).filter((r) => r.hook === 'raise.invoke.timer')
    expect(timer.length).toBeGreaterThan(0)
    expect(timer[0]?.event).toBe('tick')
    expect(timer[0]?.state).toBe('waiting')
    expect(driver.machine.getCurrentState()).toBe('done')
  })

  it('(3) raise.invoke.onDone — a resolving invoke OPERATION raises its onDone', async () => {
    const monitor = new SimMonitor()
    const config = {
      name: 'opDone',
      stateAttribute: 'state',
      initialState: 'working',
      states: {
        working: { invoke: [{ src: async () => 'value', onDone: 'ok' }] },
        done: { final: true },
      },
      events: { ok: { transitions: [{ from: 'working', to: 'done' }] } },
    }
    const driver = makeDriver(config as unknown as StateMachineConfig<Box>, { state: 'working' }, monitor)
    await driver.init()

    const onDone = raiseBegins(monitor).filter((r) => r.hook === 'raise.invoke.onDone')
    expect(onDone.length).toBe(1)
    expect(onDone[0]?.event).toBe('ok')
    expect(onDone[0]?.state).toBe('working')
  })

  it('(4) raise.invoke.onError — a rejecting invoke OPERATION raises its onError', async () => {
    const monitor = new SimMonitor()
    const config = {
      name: 'opError',
      stateAttribute: 'state',
      initialState: 'working',
      states: {
        working: {
          invoke: [
            {
              src: async () => {
                throw new Error('boom')
              },
              onError: 'failed',
            },
          ],
        },
        broken: { final: true },
      },
      events: { failed: { transitions: [{ from: 'working', to: 'broken' }] } },
    }
    const driver = makeDriver(config as unknown as StateMachineConfig<Box>, { state: 'working' }, monitor)
    await driver.init()

    const onError = raiseBegins(monitor).filter((r) => r.hook === 'raise.invoke.onError')
    expect(onError.length).toBe(1)
    expect(onError[0]?.event).toBe('failed')
    expect(onError[0]?.state).toBe('working')
    // The error PAYLOAD is deliberately not carried on the record.
    expect(Object.keys(onError[0] ?? {})).not.toContain('args')
  })

  it('(5) raise.invoke.resume — a timer RESUMED from a snapshot raises its event at microstep 0', async () => {
    // resumeTimers runs OUTSIDE any event-driven microstep, so this origin is the
    // one that legitimately reports the reserved id 0.
    const records: LifecycleEvent[] = []
    const config = {
      name: 'resumeRaise',
      stateAttribute: 'state',
      initialState: 'waiting',
      states: { waiting: { invoke: [{ delay: 1, event: 'tick' }] }, done: {} },
      events: { tick: { transitions: [{ from: 'waiting', to: 'done' }] } },
    }
    const source = new StateMachine(config as never, new MemoryAdapter({ state: '' }))
    const json = source.toJSON()
    StateMachine.fromJSON(json, new MemoryAdapter({ state: '' }), {
      monitor: {
        recordTransition: () => {},
        recordError: () => {},
        recordLifecycle: (e: LifecycleEvent) => {
          records.push(e)
        },
      },
    })
    // Let the resumed timer elapse on the real scheduler (delay 1ms).
    await new Promise((r) => setTimeout(r, 30))

    const resumed = records.filter((r) => r.kind === 'raise' && r.hook === 'raise.invoke.resume' && r.edge === 'begin')
    expect(resumed.length).toBeGreaterThan(0)
    expect(resumed[0]?.event).toBe('tick')
    expect(resumed[0]?.state).toBe('waiting')
    expect(resumed[0]?.microstep).toBe(0)
  })

  it('an UNSUBSCRIBED machine pays nothing: no monitor.recordLifecycle ⇒ no raise work', async () => {
    // The near-zero-when-unsubscribed discipline: the emission is behind ONE
    // boolean test and allocates nothing. Observable proxy — a monitor WITHOUT
    // recordLifecycle still drives the same run to the same terminal state.
    const seen: string[] = []
    const config = {
      name: 'unsubscribed',
      stateAttribute: 'state',
      initialState: 'waiting',
      states: { waiting: { invoke: [{ delay: 0, event: 'tick' }] }, done: {} },
      events: { tick: { transitions: [{ from: 'waiting', to: 'done' }] } },
    }
    const sm = new StateMachine(config as never, new MemoryAdapter({ state: '' }), {
      monitor: {
        recordTransition: (_d: number, _s: boolean) => {
          seen.push('t')
        },
        recordError: () => {},
      },
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(sm.getCurrentState()).toBe('done')
    expect(seen.length).toBeGreaterThan(0)
  })
})

/**
 * A PLANTED DEFECT in the OBSERVATION path, not in the engine. It behaves exactly
 * like a machine that FAILED TO RAISE `done.state.<C>`: the raise records simply
 * never reach the checker. The engine itself is untouched, so a green I-5 on the
 * undecorated monitor and a red I-5 on this one — over the SAME scenario, the SAME
 * seed and the SAME real trace — isolate the oracle's teeth to the raise plane
 * alone. Fabricating a broken engine would have proven nothing about the oracle.
 */
class RaiseDroppingMonitor extends SimMonitor {
  override recordLifecycle(event: LifecycleEvent): void {
    if (event.kind === 'raise') {
      return // the planted defect: the raise is never observed
    }
    super.recordLifecycle(event)
  }
}

/**
 * The composite join whose declared `done.state.C` has NO enabled transition — the
 * EXACT case that made sound I-5 teeth impossible before W9/Г1. The engine raises
 * the event, `selectTransition` matches no candidate and therefore records NOTHING
 * (no commit, no refusal, no guard record), so "raised and unhandled" used to be
 * indistinguishable from "never raised". It is also the shape in which the done
 * configuration SURVIVES to the settle boundary: with a transition leaving C the
 * composite blinks done→left inside one macrostep and the boundary sample sees no
 * edge at all (I-5 is then correctly vacuous — the safe direction).
 */
function unhandledJoinConfig(): { config: unknown; owner: Box } {
  return {
    config: {
      name: 'unhandledJoin',
      stateAttribute: 'state',
      initialState: 'C',
      states: {
        C: { regions: { r1: { w1: {}, d1: { final: true } }, r2: { w2: {}, d2: { final: true } } } },
      },
      events: {
        f1: { transitions: [{ from: 'C.r1.w1', to: 'C.r1.d1' }] },
        f2: { transitions: [{ from: 'C.r2.w2', to: 'C.r2.d2' }] },
        'done.state.C': { transitions: [] },
      },
    },
    owner: { state: 'C' },
  }
}

/**
 * A join whose declared transition is GUARD-BLOCKED. The composite therefore STAYS
 * all-final at the settle boundary (the doneDelta edge is observable) while the
 * event is still declared with a real transition, so the simulator's random op
 * picker can fire it too. This is the shape in which I-5 is genuinely ARMED on the
 * default `runSimulation` verdict path.
 */
function guardedJoinConfig(): { config: unknown; owner: Box } {
  return {
    config: {
      name: 'guardedJoin',
      stateAttribute: 'state',
      initialState: 'C',
      states: {
        C: { regions: { r1: { w1: {}, d1: { final: true } }, r2: { w2: {}, d2: { final: true } } } },
        after: { final: true },
      },
      events: {
        f1: { transitions: [{ from: 'C.r1.w1', to: 'C.r1.d1' }] },
        f2: { transitions: [{ from: 'C.r2.w2', to: 'C.r2.d2' }] },
        'done.state.C': { transitions: [{ from: 'C', to: 'after', guard: () => false }] },
      },
    },
    owner: { state: 'C' },
  }
}

describe('W9/Г1: I-5 has REAL teeth (planted-defect e2e, no engine mutation)', () => {
  /** Run the join scenario end to end and return the pieces a checker needs. */
  async function runJoin(monitor: SimMonitor) {
    const { config, owner } = unhandledJoinConfig()
    const driver = makeDriver(config as StateMachineConfig<Box>, owner, monitor)
    await driver.init()
    await driver.step({ kind: 'fire', event: 'f1' })
    await driver.step({ kind: 'fire', event: 'f2' })
    const trace = driver.trace()
    const ctx: CheckerContext = {
      graph: buildConfigGraph(config),
      header: trace.header,
      lifecycle: monitor.getLifecycle(),
      raises: monitor.getRaises(),
      raisesTruncated: monitor.isRaisesTruncated(),
    }
    return { trace, ctx }
  }

  it('the REAL run is CLEAN: the engine raised the join and the whole registry stays silent', async () => {
    const { trace, ctx } = await runJoin(new SimMonitor())
    // Non-vacuity FIRST: a green verdict over an empty raise plane or a flat
    // doneDelta projection would pass for the wrong reason.
    expect(ctx.raises?.length).toBeGreaterThan(0)
    const deltas = trace.frames.filter((f) => f.doneDelta !== undefined)
    expect(deltas.length).toBeGreaterThan(0)
    const flags = new Set(deltas.flatMap((f) => (f.doneDelta ?? []).map((d) => d.done)))
    expect(flags.has(false)).toBe(true)
    expect(flags.has(true)).toBe(true)
    expect(runSafety(INVARIANTS, trace, ctx)).toBeNull()
  })

  it('DROPPING the raise records makes I-5 FIRE on the very same trace', async () => {
    const { trace, ctx } = await runJoin(new RaiseDroppingMonitor())
    // The planted defect really is planted: the raise plane is present-but-empty
    // (an ABSENT plane would make I-5 vacuous instead, which would prove nothing).
    expect(ctx.raises).toEqual([])
    expect(ctx.raisesTruncated).toBe(false)
    const v = runSafety(INVARIANTS, trace, ctx)
    expect(v?.invariantId).toBe('I-5')
    expect(v?.witness).toBe('C')
  })

  it('a join that LEAVES the composite is correctly VACUOUS, not a false positive', async () => {
    // With `done.state.C` transitioning out of C, the done configuration blinks
    // done→left INSIDE one macrostep: the boundary sample never observes done, so
    // there is no edge to expect a raise for. The engine raised it all the same —
    // proving the vacuity comes from the doneDelta granularity and not from a
    // missing raise plane. Dropping the records must ALSO stay clean here.
    const { trace, ctx } = await (async () => {
      const monitor = new RaiseDroppingMonitor()
      const { config, owner } = joinConfig()
      const driver = makeDriver(config as StateMachineConfig<Box>, owner, monitor)
      await driver.init()
      await driver.step({ kind: 'fire', event: 'f1' })
      await driver.step({ kind: 'fire', event: 'f2' })
      const t = driver.trace()
      return {
        trace: t,
        ctx: {
          graph: buildConfigGraph(config),
          header: t.header,
          raises: monitor.getRaises(),
        } as CheckerContext,
      }
    })()
    const deltas = trace.frames.filter((f) => f.doneDelta !== undefined)
    expect(deltas.length).toBeGreaterThan(0)
    expect(deltas.flatMap((f) => (f.doneDelta ?? []).map((d) => d.done)).some((d) => d)).toBe(false)
    expect(runSafety(INVARIANTS, trace, ctx)).toBeNull()
  })

  it('the Simulator wires ctx.raises, so I-5 is ARMED and silent in a DEFAULT runSimulation', async () => {
    // The default builtin registry now INCLUDES I-5. The guarded join is the shape
    // in which the oracle is genuinely ARMED on this path (the done configuration
    // survives to the settle boundary, so an edge IS observed) — a green verdict
    // here is a checked property, not an empty-input pass.
    for (const seed of ['3', '7', '11']) {
      const result = await runSimulation<Box>((() => guardedJoinConfig()) as never, { seed, steps: 10, mode: 'both' })
      expect(result.violation).toBeUndefined()
      expect(result.ok).toBe(true)
      const observedDone = result.trace.some((f) => (f.doneDelta ?? []).some((d) => d.done))
      expect(observedDone).toBe(true)
    }
    expect(INVARIANTS.some((i) => i.id === 'I-5')).toBe(true)
  })
})
