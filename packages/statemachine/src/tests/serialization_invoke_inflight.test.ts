import { describe, expect, it } from 'vitest'
import { createVirtualScheduler } from '../scheduler'
import { StateMachine } from '../state_machine'
import { MemoryAdapter, StateMachineError } from '../types'

// ─────────────────────────────────────────────────────────────────────────────
// W3b.2 — a snapshot taken while an `invoke` OPERATION is in flight is not a
// lossy snapshot, it is a BROKEN one.
//
// The payload has no slot for a running operation and the restore path knows it:
// `toJSON` writes the operation as a body-free `type:'operation'` marker and
// `resumeTimers` skips the operation form outright, because a pending promise and
// the AbortSignal it runs against are process-local values with no serializable
// form. The result used to be a snapshot that restored into a machine SITTING in
// the invoking state with NOTHING RUNNING — the `onDone` never arrives and
// everything waiting on it waits forever. A successful-looking call producing a
// silent hang.
//
// The write side now refuses. The read side is UNCHANGED and stays tolerant: an
// already-persisted payload carrying an operation marker still loads with a warn,
// because refusing to read would break installations that already have such data.
//
// The precision of the refusal is the load-bearing part and is pinned below: it
// gates on what is ACTUALLY in flight, never on the config merely DECLARING an
// operation, and never on the armed-controller map (`activeInvokesByOwner`) whose
// entries survive settle and are dropped only on exit.
// ─────────────────────────────────────────────────────────────────────────────

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

/** A machine that runs `src` on entry into `fetching` and moves to `loaded`. */
function makeFetchMachine(
  src: (adaptee: any, signal: AbortSignal) => Promise<unknown>,
  invokeExtra: Record<string, unknown> = {},
) {
  const config = {
    name: 'Fetcher',
    initialState: 'fetching',
    stateAttribute: 'state',
    states: {
      fetching: { invoke: [{ src, onDone: 'loaded', ...invokeExtra }] },
      loaded: {},
      cancelled: {},
    },
    events: {
      loaded: { transitions: [{ from: 'fetching', to: 'loaded' }] },
      cancel: { transitions: [{ from: 'fetching', to: 'cancelled' }] },
    },
  }
  return new StateMachine(
    config as any,
    new MemoryAdapter({ state: 'fetching' }),
    {},
  )
}

describe('W3b.2 — toJSON refuses while an invoke operation is in flight', () => {
  it('throws instead of producing a snapshot, naming the state and the invocation', async () => {
    const sm = makeFetchMachine(async function fetchUser() {
      await tick(60)
      return 'payload'
    })

    // The operation is launched and running.
    await tick(10)
    expect(sm.getCurrentState()).toBe('fetching')

    // PRE-CHANGE this returned a JSON string. That string restored into a machine
    // that sat in "fetching" forever — verified by the round-trip test below.
    expect(() => sm.toJSON()).toThrow(StateMachineError)

    let message = ''
    try {
      sm.toJSON()
    } catch (e) {
      message = (e as Error).message
    }

    // The SPECIFIC state and the SPECIFIC invocation, not a generic complaint.
    expect(message).toContain('"fetching"')
    expect(message).toContain('src "fetchUser"')
    // The reason is stated as a property of the platform, not of the library.
    expect(message).toMatch(/pending promise has no serializable continuation/i)
    // And both remedies the caller actually has.
    expect(message).toMatch(/wait for the operation to settle/i)
    expect(message).toMatch(/abort it by leaving the state/i)

    // The refusal must not have disturbed the machine: it still completes.
    await tick(120)
    expect(sm.getCurrentState()).toBe('loaded')
  })

  it('the refusal is NOT a lost snapshot — the same machine serializes once settled, and that snapshot restores live', async () => {
    const src = async function fetchUser() {
      await tick(40)
      return 'payload'
    }
    const sm = makeFetchMachine(src)

    await tick(10)
    expect(() => sm.toJSON()).toThrow(StateMachineError)

    // Wait for the operation, exactly as the error tells the caller to.
    await tick(120)
    expect(sm.getCurrentState()).toBe('loaded')

    const json = sm.toJSON()
    const restored = StateMachine.fromJSON(json, new MemoryAdapter({ state: 'loaded' }), {
      actions: { 'fetching.invoke.src': src } as any,
    })
    expect(restored.getCurrentState()).toBe('loaded')
  })

  it('names the invocation by `id` when the config gives one', async () => {
    const sm = makeFetchMachine(
      async () => {
        await tick(60)
      },
      { id: 'user-fetch' },
    )
    await tick(10)

    let message = ''
    try {
      sm.toJSON()
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('id "user-fetch"')
    await tick(120)
  })

  it('reports EVERY operation in flight, not just the first', async () => {
    const opA = async function opA() {
      await tick(60)
    }
    const opB = async function opB() {
      await tick(60)
    }
    const config = {
      name: 'TwoOps',
      initialState: 'busy',
      stateAttribute: 'state',
      states: { busy: { invoke: [{ src: opA }, { src: opB }] } },
      events: {},
    }
    const sm = new StateMachine(
      config as any,
      new MemoryAdapter({ state: 'busy' }),
      {},
    )
    await tick(10)

    let message = ''
    try {
      sm.toJSON()
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('src "opA"')
    expect(message).toContain('src "opB"')
    expect(message).toMatch(/2 invoke operations are in flight/)
    await tick(120)
  })
})

describe('W3b.2 — toSecureJSON refuses on the same terms', () => {
  it('rejects while an operation is in flight; being async buys nothing', async () => {
    const sm = makeFetchMachine(async function fetchUser() {
      await tick(60)
      return 'payload'
    })
    await tick(10)

    // PRE-CHANGE this RESOLVED with a snapshot.
    await expect(sm.toSecureJSON()).rejects.toThrow(StateMachineError)
    await expect(sm.toSecureJSON()).rejects.toThrow(
      /Cannot serialize with toSecureJSON\(\)[\s\S]*state "fetching" — src "fetchUser"/,
    )

    await tick(120)
    expect(sm.getCurrentState()).toBe('loaded')
    // Settled → the async path serializes normally too.
    expect(typeof (await sm.toSecureJSON())).toBe('string')
  })
})

describe('W3b.2 — the refusal gates on IN-FLIGHT, never on DECLARED or ARMED', () => {
  // This is the anti-over-strictness test. It is what stops someone from later
  // "simplifying" the check to `state.invoke.some(isInvokeOperation)` (a config
  // predicate) or to `invokesFor(owner).size > 0` (the ARMED-controller map).
  // Both would reject the machine below, which is entirely sound to serialize.
  it('a SETTLED operation whose state is still active serializes normally', async () => {
    let settled = false
    const config = {
      name: 'SettledButResident',
      initialState: 'working',
      stateAttribute: 'state',
      states: { working: { invoke: [{ src: async function slowThing() {
        await tick(20)
        settled = true
        return 'x'
      }, onDone: 'noop' }] } },
      // 'noop' is declared but has no transition out of 'working': the operation
      // really completes and raises it, and the machine STAYS in 'working'.
      events: { noop: { transitions: [{ from: 'parked', to: 'parked' }] } },
    }
    ;(config.states as Record<string, unknown>).parked = {}
    const sm = new StateMachine(
      config as any,
      new MemoryAdapter({ state: 'working' }),
      {},
    ) as any

    await tick(120)
    expect(settled).toBe(true)
    expect(sm.getCurrentState()).toBe('working')

    // The ARMED map still holds a live, un-aborted controller for the leaf —
    // controllers are dropped on EXIT, not on settle. Gating on it would reject
    // this machine. Pinned here so the distinction cannot be refactored away.
    const armed = sm.invokesFor(sm.adaptee).get('working')
    expect(armed).toHaveLength(1)
    expect(armed[0].signal.aborted).toBe(false)

    // Nothing is actually running, so the snapshot is faithful and is produced.
    const json = sm.toJSON()
    expect(JSON.parse(json).currentState).toBe('working')
    // And the config-level declaration is still carried, as a body-free marker.
    expect(JSON.parse(json).config.states.working.invoke[0].type).toBe('operation')
  })

  it('a machine that merely DECLARES an operation it never ran serializes normally', () => {
    const config = {
      name: 'DeclaredNotRun',
      initialState: 'idle',
      stateAttribute: 'state',
      states: {
        idle: {},
        working: { invoke: [{ src: async () => 'x', onDone: 'noop' }] },
      },
      events: { noop: { transitions: [{ from: 'working', to: 'idle' }] } },
    }
    const sm = new StateMachine(
      config as any,
      new MemoryAdapter({ state: 'idle' }),
      {},
    )
    expect(JSON.parse(sm.toJSON()).currentState).toBe('idle')
  })

  it('aborting by leaving the state — the second remedy the error names — makes it serializable', async () => {
    const sm = makeFetchMachine(async function longOp(_a, signal) {
      await tick(500)
      return signal.aborted ? 'aborted' : 'ok'
    })
    await tick(10)
    expect(() => sm.toJSON()).toThrow(StateMachineError)

    await sm.fireEvent('cancel')
    expect(sm.getCurrentState()).toBe('cancelled')

    // Exiting the leaf aborted the operation; its completion event is dropped, so
    // the machine no longer waits on it and the snapshot is faithful again —
    // without waiting out the remaining ~490 ms.
    expect(JSON.parse(sm.toJSON()).currentState).toBe('cancelled')
  })

  it('the refusal starts at LAUNCH, before `src` is first called', async () => {
    // The launch goes through the scheduler (setTimer 0), so there is a window in
    // which the operation is committed but `src` has not run. A snapshot taken in
    // that window is exactly as unfaithful as one taken mid-`src`: neither carries
    // anything that would start the operation on the other side.
    let started = false
    const sm = makeFetchMachine(async function notYet() {
      started = true
      await tick(500)
    })
    expect(started).toBe(false)
    expect(() => sm.toJSON()).toThrow(/invoke operation is in flight/)

    await sm.fireEvent('cancel')
  })

  it('one owner in flight does not block another owner — the snapshot is primary-owner-only', async () => {
    // `toJSON` carries the PRIMARY construction owner's currentState/history/
    // entry times and nothing about co-resident owners, so the refusal is scoped
    // to that owner too. A second object running an operation cannot make the
    // primary owner's snapshot unfaithful, and must not block it.
    const config = {
      name: 'TwoOwners',
      initialState: 'idle',
      stateAttribute: 'state',
      states: {
        idle: {},
        fetching: { invoke: [{ src: async function otherOp() {
          await tick(200)
        } }] },
      },
      events: { go: { transitions: [{ from: 'idle', to: 'fetching' }] } },
    }
    const primary = { state: 'idle' }
    const secondary = { state: 'idle' }
    const sm = new StateMachine(config as any, new MemoryAdapter(primary), {})

    await sm.fireEventFor(secondary as any, 'go')
    await tick(10)
    expect(secondary.state).toBe('fetching')
    expect(primary.state).toBe('idle')

    // The secondary owner's operation is running; the primary's snapshot is
    // unaffected and is produced.
    expect(JSON.parse(sm.toJSON()).currentState).toBe('idle')

    // ...and the primary owner running one DOES refuse.
    await sm.fireEvent('go')
    await tick(10)
    expect(() => sm.toJSON()).toThrow(/invoke operation is in flight/)
    await tick(250)
  })
})

describe('W3b.2 — the read side is unchanged', () => {
  it('an already-persisted payload carrying an operation marker still loads, with the warn', async () => {
    const warns: Array<[string, unknown]> = []
    const logger = {
      debug() {},
      info() {},
      warn(msg: string, ctx?: unknown) {
        warns.push([String(msg), ctx])
      },
      error() {},
    }
    // A payload written before this change — the shape `toJSON` has always
    // emitted for the operation form. Refusing to READ it would break working
    // installations, so it must still load.
    const payload = JSON.stringify({
      config: {
        initialState: 'working',
        stateAttribute: 'state',
        states: {
          working: {
            invoke: [
              { type: 'operation', slot: 'working.invoke.src', onDone: 'opDone' },
            ],
          },
          done: {},
        },
        events: { opDone: { transitions: [{ from: 'working', to: 'done' }] } },
      },
      currentState: 'working',
      historyMap: [],
      stateEntryTimes: [['working', Date.now()]],
    })

    // No registry: the marker's `src` cannot be re-linked, and the resume path
    // says so out loud. This is the CURRENT behaviour and is left exactly as is.
    const sm = StateMachine.fromJSON(payload, new MemoryAdapter({ state: 'working' }), {
      logger,
    } as any)

    expect(sm.getCurrentState()).toBe('working')
    expect(
      warns.some(([m]) =>
        /invoke operation not serializable; skipping non-resumable invoke on resume/.test(m),
      ),
    ).toBe(true)

    // And this is precisely WHY the write side now refuses. The payload loads,
    // but the operation it names is NOT running and never will be on this entry:
    // the machine sits in 'working' and 'opDone' never arrives. Reading such a
    // payload has to keep working — it is already on disk somewhere — but writing
    // a fresh one is a defect we can decline at the source.
    await tick(60)
    expect(sm.getCurrentState()).toBe('working')
  })

  it('...and loads the same way WITH a registry that can re-link the src — silently, and still not running', async () => {
    // The two read paths differ in noise, not in outcome, and both are left
    // untouched. With a resolvable registry the marker becomes a real operation
    // entry again, so `resumeTimers` skips it on the `isInvokeOperation` branch
    // (no warn) instead of the non-resumable-timer branch (warn). Either way the
    // operation does not run: a promise is not what was persisted, a reference to
    // its `src` is, and a reference does not resume anything. Only a FRESH ENTRY
    // into the state launches it.
    const warns: string[] = []
    const logger = {
      debug() {},
      info() {},
      warn(msg: string) {
        warns.push(String(msg))
      },
      error() {},
    }
    let launches = 0
    const src = async function reLinked() {
      launches++
      return 'payload'
    }
    const payload = JSON.stringify({
      config: {
        initialState: 'idle',
        stateAttribute: 'state',
        states: {
          idle: {},
          working: {
            invoke: [
              { type: 'operation', slot: 'working.invoke.src', onDone: 'opDone' },
            ],
          },
          done: {},
        },
        events: {
          opDone: { transitions: [{ from: 'working', to: 'done' }] },
          go: { transitions: [{ from: 'idle', to: 'working' }] },
        },
      },
      currentState: 'working',
      historyMap: [],
      stateEntryTimes: [['working', Date.now()]],
    })

    const sm = StateMachine.fromJSON(payload, new MemoryAdapter({ state: 'working' }), {
      logger,
      actions: { 'working.invoke.src': src },
    } as any)

    // Restored INTO 'working' — and the operation was not resumed.
    expect(sm.getCurrentState()).toBe('working')
    await tick(60)
    expect(launches).toBe(0)
    expect(sm.getCurrentState()).toBe('working')
    expect(warns.some((m) => /not serializable/.test(m))).toBe(false)

    // A fresh entry DOES launch it — the re-link was not wasted.
    ;(sm as any).setCurrentState('idle')
    await sm.fireEvent('go')
    await tick(60)
    expect(launches).toBe(1)
    expect(sm.getCurrentState()).toBe('done')
  })

  it('a timer-form invoke still round-trips on its REMAINDER (regression guard)', async () => {
    // Untouched by this change and must stay that way: the timer form persists as
    // a real delay/event pair and `resumeTimers` recomputes the remainder from
    // `stateEntryTimes`, so a 1000 ms timer snapshotted 400 ms in fires 600 ms
    // after the restore.
    let now = 0
    const clock = () => now
    const config = {
      name: 'TimerForm',
      initialState: 'waiting',
      stateAttribute: 'state',
      states: { waiting: { invoke: [{ delay: 1000, event: 'timeUp' }] }, fired: {} },
      events: { timeUp: { transitions: [{ from: 'waiting', to: 'fired' }] } },
    }
    const sm = new StateMachine(config as any, new MemoryAdapter({ state: 'waiting' }), {
      clock,
    } as any)

    now = 400
    const json = sm.toJSON()
    const parsed = JSON.parse(json)
    expect(parsed.config.states.waiting.invoke[0]).toMatchObject({
      delay: 1000,
      event: 'timeUp',
    })
    expect(parsed.stateEntryTimes).toEqual([['waiting', 0]])

    // Restore against the same virtual clock, still at t=400, driving a virtual
    // scheduler so the remainder is measured rather than raced.
    const scheduler = createVirtualScheduler(clock)
    const restored = StateMachine.fromJSON(
      json,
      new MemoryAdapter({ state: 'waiting' }),
      { clock, scheduler } as any,
    )
    await tick(0)

    // 1000 declared − 400 elapsed = 600 remaining. At t=999 (599 ms after the
    // restore) it must NOT have fired; a fresh full budget would also not have
    // fired here, so the negative alone proves nothing — the positive below does.
    now = 999
    scheduler.process?.()
    await tick(0)
    expect(restored.getCurrentState()).toBe('waiting')

    // t=1000 — 600 ms after the restore. A fresh 1000 ms budget would fire only
    // at t=1400, so reaching 'fired' here can ONLY come from the remainder.
    now = 1000
    scheduler.process?.()
    await tick(0)
    expect(restored.getCurrentState()).toBe('fired')
  })
})
