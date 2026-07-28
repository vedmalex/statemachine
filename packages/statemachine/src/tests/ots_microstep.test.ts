/**
 * W3-C — TARGET (RED) suite for OPTIMAL TRANSITION SET (SPEC §6, дефект П10) and
 * applyTransition PHASE ORDER (SPEC §6.3, дефект П5).
 *
 * These tests encode the CORRECT post-fix (SCXML/UML) behaviour and FAIL on HEAD.
 * This is the RED role: DO NOT edit `src/` to make them pass — that is the GREEN
 * wave's job. Each assertion below was empirically confirmed RED on HEAD
 * (branch remediation/w1-prep, commit 32571fe, probe 2026-07-28).
 *
 * ── PART 1 — OTS (SPEC §6/§6.1/§6.2/§6.3, дефект П10) ────────────────────────
 * HEAD applies at most ONE transition per event even when non-conflicting
 * transitions are enabled in DIFFERENT orthogonal regions. The fix must fire
 * ONE transition per region in a SINGLE microstep, then emit `done.state.<C>`
 * for any composite that became all-regions-final.
 *
 * Reproduced on HEAD:
 *   'shutdown' over 3 regions from `sys.a.run|sys.b.run|sys.c.run`
 *     → HEAD: `sys.a.stop|sys.b.run|sys.c.run`  (only region `a` moved)
 *     → target: `sys.a.stop|sys.b.stop|sys.c.stop` (all three), then done.state.sys
 *
 * ── PART 2 — PHASE ORDER (SPEC §6.3, дефект П5) ─────────────────────────────
 * `executeExitActions` UNCONDITIONALLY tears down activeTimers/stateEntryTimes
 * BEFORE the transition is committed, and the enter-set is armed against the
 * WRONG (default, not restored/committed) configuration. The fix: teardown /
 * re-arm AFTER the point of no return, enter-set from the ACTUALLY-written
 * configuration. Three observable consequences are pinned here (Q4, T3, EO-4).
 */
import { describe, expect, it } from 'vitest'
import { createVirtualScheduler } from '../scheduler'
import { StateMachine } from '../state_machine'
import { MemoryAdapter, type StateMachineConfig } from '../types'

/**
 * Flush the microtask queue enough times to settle chained transitions
 * (invoke → raiseEvent → processQueues → re-armed invoke). Mirrors dst.test.ts.
 */
async function flush(times = 24): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

// ── PART 1 — OPTIMAL TRANSITION SET ──────────────────────────────────────────
describe('W3-C Part 1 — OTS: one event fires one transition PER REGION (SPEC §6)', () => {
  interface Sys {
    state: string
  }

  /** 3 orthogonal regions, each `run` → `stop` (final) on the same event. */
  const parallelStates = {
    sys: {
      initial: 'a.run|b.run|c.run',
      regions: {
        a: { run: {}, stop: { final: true } },
        b: { run: {}, stop: { final: true } },
        c: { run: {}, stop: { final: true } },
      },
    },
    allDown: {},
  }

  const shutdownTransitions = [
    { from: 'sys.a.run', to: 'sys.a.stop' },
    { from: 'sys.b.run', to: 'sys.b.stop' },
    { from: 'sys.c.run', to: 'sys.c.stop' },
  ]

  it('one fireEvent("shutdown") stops ALL 3 regions in a single microstep — RED: HEAD moves only region `a`', async () => {
    const config: StateMachineConfig<Sys> = {
      name: 'OTSParallel',
      stateAttribute: 'state',
      initialState: 'sys',
      states: parallelStates,
      // No done.state.sys handler → the all-final composite STAYS put, so the
      // |-joined all-stop configuration is directly observable.
      events: { shutdown: { transitions: shutdownTransitions } },
    }
    const adapter = new MemoryAdapter<Sys>({ state: 'sys' })
    const sm = new StateMachine<Sys, typeof config>(config, adapter)
    await flush()
    expect(sm.getCurrentState()?.split('|').sort()).toEqual(
      ['sys.a.run', 'sys.b.run', 'sys.c.run'].sort(),
    )

    const fired = await sm.fireEvent('shutdown')
    await flush()

    expect(fired).toBe(true)
    // TARGET: every region advanced to its final leaf in ONE microstep.
    // HEAD gates one region per call → 'sys.a.stop|sys.b.run|sys.c.run'.
    expect(sm.getCurrentState()?.split('|').sort()).toEqual(
      ['sys.a.stop', 'sys.b.stop', 'sys.c.stop'].sort(),
    )
  })

  it('fireEventDetailed reports ALL fired transitions (contract §7) — RED: HEAD reports 1', async () => {
    const config: StateMachineConfig<Sys> = {
      name: 'OTSDetailed',
      stateAttribute: 'state',
      initialState: 'sys',
      states: parallelStates,
      events: { shutdown: { transitions: shutdownTransitions } },
    }
    const adapter = new MemoryAdapter<Sys>({ state: 'sys' })
    const sm = new StateMachine<Sys, typeof config>(config, adapter)
    await flush()

    const result = await sm.fireEventDetailed('shutdown')
    await flush()

    expect(result.fired).toBe(true)
    // fireEvent boolean = "at least one fired"; detailed.transitions = ALL fired.
    // TARGET: 3 (one per region). HEAD: 1.
    if (result.fired) {
      expect(result.transitions.length).toBe(3)
      expect(result.transitions.map((t) => t.to).sort()).toEqual(
        ['sys.a.stop', 'sys.b.stop', 'sys.c.stop'].sort(),
      )
    }
  })

  it('done.state.<C> fires AFTER the microstep once every region is final — RED: HEAD never reaches all-final', async () => {
    const config: StateMachineConfig<Sys> = {
      name: 'OTSDone',
      stateAttribute: 'state',
      initialState: 'sys',
      states: parallelStates,
      events: {
        shutdown: { transitions: shutdownTransitions },
        // Engine-generated completion event: consumed once `sys` is all-final.
        'done.state.sys': { transitions: [{ from: 'sys', to: 'allDown' }] },
      },
    }
    const adapter = new MemoryAdapter<Sys>({ state: 'sys' })
    const sm = new StateMachine<Sys, typeof config>(config, adapter)
    await flush()

    await sm.fireEvent('shutdown')
    await flush()

    // TARGET: all regions final in one microstep → done.state.sys → allDown.
    // HEAD: only region `a` moved → composite never all-final → stays in `sys`.
    expect(sm.getCurrentState()).toBe('allDown')
  })
})

// ── PART 2 — PHASE ORDER (дефект П5) ─────────────────────────────────────────
describe('W3-C Part 2 — phase order: teardown/re-arm AFTER commit (SPEC §6.3)', () => {
  // Q4 — transitionTimeout race: a watchdog invoke on the SOURCE leaf must
  // survive a transition that times out and never commits.
  it('Q4: an aborted (timed-out) transition must NOT drop the source watchdog invoke — RED: HEAD loses it', async () => {
    interface O {
      state: string
    }
    let t = 0
    const clock = () => t
    const scheduler = createVirtualScheduler(clock)
    const config: StateMachineConfig<O> = {
      name: 'Q4Watchdog',
      stateAttribute: 'state',
      initialState: 'active',
      states: {
        // `active` arms a watchdog: if nothing commits within 100 ticks, escalate.
        active: { invoke: [{ delay: 100, event: 'watchdog' }] },
        // Entering `processing` hangs forever → the transition times out.
        processing: { onEnter: () => new Promise<void>(() => {}) },
        safe: {},
      },
      events: {
        go: { transitions: [{ from: 'active', to: 'processing' }] },
        watchdog: { transitions: [{ from: 'active', to: 'safe' }] },
      },
    }
    const adapter = new MemoryAdapter<O>({ state: 'active' })
    const sm = new StateMachine<O, typeof config>(config, adapter, {
      clock,
      scheduler,
      transitionTimeout: 50,
    })
    await flush()

    // Fire `go`; its onEnter hangs and the 50-tick timeout aborts it.
    const firePromise = sm.fireEvent('go')
    firePromise.catch(() => {})
    await flush()
    t = 50
    scheduler.process()
    await flush()

    // The transition never committed → the machine is still in `active`.
    expect(sm.getCurrentState()).toBe('active')

    // Advance past the watchdog deadline. TARGET: the source watchdog invoke was
    // NOT torn down (teardown happens only after the point of no return), so it
    // fires → active → safe. HEAD tore it down in Phase 3 exit → watchdog LOST,
    // machine stuck in `active` forever.
    t = 200
    scheduler.process()
    await flush()

    expect(sm.getCurrentState()).toBe('safe')
  })

  // T3 — deep-history restore: onEnter (and invoke arming) must run for the
  // RESTORED leaves, not the regional defaults.
  it('T3: deep-history restore runs onEnter + arms invoke for the RESTORED leaf — RED: HEAD uses regional default', async () => {
    interface O {
      state: string
      qEnter: number
    }
    let t = 0
    const clock = () => t
    const scheduler = createVirtualScheduler(clock)
    const config: StateMachineConfig<O> = {
      name: 'T3DeepHistory',
      stateAttribute: 'state',
      initialState: 'W',
      states: {
        W: {
          initial: 'r.p',
          history: 'deep',
          regions: {
            r: {
              p: {},
              // The interesting (non-default) leaf: it counts its own onEnter and
              // arms a timer-driven invoke. A timer-driven machine is DEAD after a
              // restore if this invoke is not re-armed.
              q: {
                onEnter: (o: O) => {
                  o.qEnter++
                },
                invoke: [{ delay: 10, event: 'qtick' }],
              },
              done: {},
            },
          },
        },
        OUT: {},
      },
      events: {
        toQ: { transitions: [{ from: 'W.r.p', to: 'W.r.q' }] },
        leave: { transitions: [{ from: 'W', to: 'OUT' }] },
        back: { transitions: [{ from: 'OUT', to: 'W' }] },
        qtick: { transitions: [{ from: 'W.r.q', to: 'W.r.done' }] },
      },
    }
    const adapter = new MemoryAdapter<O>({ state: 'W', qEnter: 0 })
    const sm = new StateMachine<O, typeof config>(config, adapter, {
      clock,
      scheduler,
    })
    await flush()

    // Walk into the non-default leaf `q` (deep history now remembers W.r.q).
    await sm.fireEvent('toQ')
    await flush()
    expect(sm.getCurrentState()).toBe('W.r.q')
    expect(adapter.adaptee.qEnter).toBe(1) // baseline: first, direct entry
    // Leave `W` (records the deep-history configuration = W.r.q).
    await sm.fireEvent('leave')
    await flush()
    expect(sm.getCurrentState()).toBe('OUT')

    // Re-enter `W` → deep history restores W.r.q.
    await sm.fireEvent('back')
    await flush()

    // The configuration is restored on HEAD too, so pin the OBSERVABLE defect:
    // onEnter (and invoke arming) ran for the restored leaf, not the default `p`.
    expect(sm.getCurrentState()).toBe('W.r.q')
    // TARGET: onEnter of the RESTORED leaf fired → qEnter === 2.
    // HEAD arms/enters the regional default `p` → qEnter stays 1.
    expect(adapter.adaptee.qEnter).toBe(2)

    // Advance past the restored leaf's invoke delay. TARGET: q's invoke was armed
    // on restore → fires → W.r.done. HEAD never armed it → machine is dead in q.
    t = 100
    scheduler.process()
    await flush()
    expect(sm.getCurrentState()).toBe('W.r.done')
  })

  // EO-4 — a throw in event.onAfter must NOT leave an orphan target timer that
  // fires prematurely on a LATER entry.
  it('EO-4: a throw in onAfter must not orphan the target invoke (no premature fire on re-entry) — RED: HEAD fires early', async () => {
    interface O {
      state: string
    }
    let t = 0
    const clock = () => t
    const scheduler = createVirtualScheduler(clock)
    const config: StateMachineConfig<O> = {
      name: 'EO4Orphan',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        // Arms a 10-tick invoke on entry.
        target: { invoke: [{ delay: 10, event: 'ttick' }] },
        beyond: {},
      },
      events: {
        // First attempt: enters `target` (arms timer @ deadline 10), then throws
        // in onAfter → the transition aborts and the machine stays in `idle`,
        // but on HEAD the just-armed target timer is left ORPHANED.
        go: {
          onAfter: () => {
            throw new Error('boom in onAfter')
          },
          transitions: [{ from: 'idle', to: 'target' }],
        },
        // Second attempt (no throw): legitimately enters `target`, arming a FRESH
        // timer @ deadline t+10.
        retry: { transitions: [{ from: 'idle', to: 'target' }] },
        ttick: { transitions: [{ from: 'target', to: 'beyond' }] },
      },
    }
    const adapter = new MemoryAdapter<O>({ state: 'idle' })
    const sm = new StateMachine<O, typeof config>(config, adapter, {
      clock,
      scheduler,
    })
    await flush()

    // Attempt 1 at t=0: arms orphan timer @ deadline 10, then aborts.
    await sm.fireEvent('go').catch(() => {})
    await flush()
    expect(sm.getCurrentState()).toBe('idle')

    // Attempt 2 at t=5: legitimately enter `target`; the fresh timer's deadline
    // is t+10 = 15.
    t = 5
    scheduler.process()
    await flush()
    await sm.fireEvent('retry')
    await flush()
    expect(sm.getCurrentState()).toBe('target')

    // At t=10 (the ORPHAN's deadline, BEFORE the fresh timer's 15): TARGET keeps
    // the machine in `target` — the orphan was cleared. HEAD fires the orphan
    // prematurely → `beyond`.
    t = 10
    scheduler.process()
    await flush()
    expect(sm.getCurrentState()).toBe('target')

    // At t=15 the fresh, legitimate timer fires → `beyond`.
    t = 15
    scheduler.process()
    await flush()
    expect(sm.getCurrentState()).toBe('beyond')
  })
})
