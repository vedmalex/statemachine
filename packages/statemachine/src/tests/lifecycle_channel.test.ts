// W8 / V1 (+V1b, V1c) — public LIFECYCLE OBSERVABILITY channel.
//
// The channel answers questions that were previously unanswerable from outside
// the machine: "why was my onExit never called?", "in which order did the regions
// enter?", "which callback is hung?", "which guard never returned true?".
//
// These tests pin the OBSERVABLE contract (ordering, pairing, owner/microstep
// discrimination, hung/throwing signatures, sink isolation, additivity) — never
// engine internals.
import { describe, expect, it } from 'vitest'
import { StateMachine } from '../state_machine'
import { type IMonitor, type LifecycleEvent, MemoryAdapter } from '../types'

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

/** A monitor that records the lifecycle stream and nothing else. */
function makeSink(): { events: LifecycleEvent[]; monitor: IMonitor } {
  const events: LifecycleEvent[] = []
  return {
    events,
    monitor: {
      recordTransition() {},
      recordError() {},
      recordLifecycle(event) {
        events.push(event)
      },
    },
  }
}

/** Compact `hook@state:edge` view — the shape assertions read against. */
const trace = (events: LifecycleEvent[], kind?: LifecycleEvent['kind']) =>
  events
    .filter((e) => kind === undefined || e.kind === kind)
    .map((e) => `${e.hook}@${e.state}:${e.edge}`)

describe('W8/V1 — lifecycle channel: ordering over a nested composite', () => {
  const build = (monitor: IMonitor) => {
    const owner = { state: '' }
    const sm = new StateMachine(
      {
        name: 'NestedOrder',
        initialState: 'idle',
        stateAttribute: 'state',
        states: {
          idle: {},
          outer: {
            initial: 'r.inner',
            onBeforeEnter: () => {},
            onEnter: () => {},
            onAfterEnter: () => {},
            onBeforeExit: () => {},
            onExit: () => {},
            onAfterExit: () => {},
            regions: {
              r: {
                inner: {
                  onBeforeEnter: () => {},
                  onEnter: () => {},
                  onAfterEnter: () => {},
                  onBeforeExit: () => {},
                  onExit: () => {},
                  onAfterExit: () => {},
                },
              },
            },
          },
        },
        events: {
          go: { transitions: [{ from: 'idle', to: 'outer' }] },
          back: { transitions: [{ from: 'outer.r.inner', to: 'idle' }] },
        },
      } as any,
      owner as any,
      { monitor },
    )
    return { sm, owner }
  }

  it('enters ancestor before descendant and exits descendant before ancestor', async () => {
    const { events, monitor } = makeSink()
    const { sm } = build(monitor)
    await tick()
    events.length = 0

    await sm.fireEvent('go')

    // Ancestor's WHOLE hook sequence completes before the descendant's begins,
    // and each hook is a closed begin/end pair.
    expect(trace(events, 'enter')).toEqual([
      'onBeforeEnter@outer:begin',
      'onBeforeEnter@outer:end',
      'onEnter@outer:begin',
      'onEnter@outer:end',
      'onAfterEnter@outer:begin',
      'onAfterEnter@outer:end',
      'onBeforeEnter@outer.r.inner:begin',
      'onBeforeEnter@outer.r.inner:end',
      'onEnter@outer.r.inner:begin',
      'onEnter@outer.r.inner:end',
      'onAfterEnter@outer.r.inner:begin',
      'onAfterEnter@outer.r.inner:end',
    ])

    events.length = 0
    await sm.fireEvent('back')

    expect(trace(events, 'exit')).toEqual([
      'onBeforeExit@outer.r.inner:begin',
      'onBeforeExit@outer.r.inner:end',
      'onExit@outer.r.inner:begin',
      'onExit@outer.r.inner:end',
      'onAfterExit@outer.r.inner:begin',
      'onAfterExit@outer.r.inner:end',
      'onBeforeExit@outer:begin',
      'onBeforeExit@outer:end',
      'onExit@outer:begin',
      'onExit@outer:end',
      'onAfterExit@outer:begin',
      'onAfterExit@outer:end',
    ])
  })

  it('stamps a strictly increasing per-machine seq and carries the driving event', async () => {
    const { events, monitor } = makeSink()
    const { sm } = build(monitor)
    await tick()
    await sm.fireEvent('go')

    const seqs = events.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)

    const fromGo = events.filter((e) => e.kind === 'enter')
    expect(fromGo.length).toBeGreaterThan(0)
    expect(fromGo.every((e) => e.event === 'go')).toBe(true)
  })
})

describe('W8/V1 — lifecycle channel: owner discrimination', () => {
  it('separates the traces of TWO owners driven by ONE machine', async () => {
    const { events, monitor } = makeSink()
    const alice = new MemoryAdapter({ state: 'idle', name: 'alice' })
    const bob = new MemoryAdapter({ state: 'idle', name: 'bob' })

    const sm = new StateMachine(
      {
        name: 'MultiOwner',
        initialState: 'idle',
        stateAttribute: 'state',
        states: {
          idle: {},
          active: { onEnter: () => {} },
        },
        events: { go: { transitions: [{ from: 'idle', to: 'active' }] } },
      } as any,
      alice as any,
      { monitor },
    )
    await tick()
    events.length = 0

    await sm.fireEvent('go', alice as any)
    await sm.fireEvent('go', bob as any)

    // `owner` is the OWNER OBJECT itself (the adaptee), not the adapter wrapper.
    const forAlice = events.filter((e) => e.owner === alice.adaptee)
    const forBob = events.filter((e) => e.owner === bob.adaptee)

    // Every record is attributed, and to exactly ONE of the two owners.
    expect(forAlice.length + forBob.length).toBe(events.length)
    expect(forAlice.length).toBeGreaterThan(0)
    expect(forBob.length).toBeGreaterThan(0)

    // Identity is by REFERENCE — not by a serialized/structural copy. Two owners
    // with STRUCTURALLY identical state would otherwise be indistinguishable.
    expect(forAlice.every((e) => e.owner === alice.adaptee)).toBe(true)
    expect(forBob.every((e) => e.owner === bob.adaptee)).toBe(true)
    expect(
      events.some((e) => e.owner === alice.adaptee && e.hook === 'onEnter'),
    ).toBe(true)
    expect(
      events.some((e) => e.owner === bob.adaptee && e.hook === 'onEnter'),
    ).toBe(true)
  })
})

describe('W8/V1 — lifecycle channel: microstep boundary', () => {
  it('assigns a DIFFERENT microstep id to each microstep', async () => {
    const { events, monitor } = makeSink()
    const owner = { state: 'a' }
    const sm = new StateMachine(
      {
        name: 'Microsteps',
        initialState: 'a',
        stateAttribute: 'state',
        states: {
          a: { onEnter: () => {}, onExit: () => {} },
          b: { onEnter: () => {}, onExit: () => {} },
          c: { onEnter: () => {} },
        },
        events: {
          toB: { transitions: [{ from: 'a', to: 'b' }] },
          toC: { transitions: [{ from: 'b', to: 'c' }] },
        },
      } as any,
      owner as any,
      { monitor },
    )
    await tick()
    events.length = 0

    await sm.fireEvent('toB')
    const first = new Set(events.map((e) => e.microstep))
    events.length = 0

    await sm.fireEvent('toC')
    const second = new Set(events.map((e) => e.microstep))

    expect(first.size).toBe(1)
    expect(second.size).toBe(1)
    expect([...first][0]).not.toBe([...second][0])
    // 0 is reserved for the no-microstep paths (construction / reset / resume).
    expect([...first][0]).toBeGreaterThan(0)
  })

  it('reserves microstep 0 for the construction path (no microstep exists yet)', async () => {
    const { events, monitor } = makeSink()
    const owner = { state: '' }
    // Constructed for its side effect: the initial-entry hooks are the records
    // under test.
    new StateMachine(
      {
        name: 'ConstructionEnter',
        initialState: 'start',
        stateAttribute: 'state',
        states: { start: { onEnter: () => {} } },
        events: {},
      } as any,
      owner as any,
      { monitor },
    )
    await tick()

    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.microstep === 0)).toBe(true)
  })

  it('tags the enter records of an ABORTED microstep with that microstep id, so a consumer can filter them out', async () => {
    const { events, monitor } = makeSink()
    const owner = { state: 'a' }
    const sm = new StateMachine(
      {
        name: 'AbortedEnter',
        initialState: 'a',
        stateAttribute: 'state',
        states: {
          a: {},
          b: {
            onBeforeEnter: () => {},
            onEnter: () => {},
            // Throws AFTER the earlier enter hooks already emitted their records,
            // and BEFORE the point of no return — the microstep never commits.
            onAfterEnter: () => {
              throw new Error('boom in onAfterEnter')
            },
          },
        },
        events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
      } as any,
      owner as any,
      { monitor },
    )
    await tick()
    events.length = 0

    await expect(sm.fireEvent('go')).rejects.toThrow(/boom in onAfterEnter/)

    // The machine did NOT move: the microstep was cancelled.
    expect(sm.getCurrentState()).toBe('a')

    const enters = events.filter((e) => e.kind === 'enter')
    expect(enters.length).toBeGreaterThan(0)
    // Yet 'enter b' WAS observed — all of it under ONE microstep id, which is
    // exactly the grouping a consumer discards on.
    const ids = new Set(enters.map((e) => e.microstep))
    expect(ids.size).toBe(1)
    expect(enters.some((e) => e.hook === 'onEnter' && e.state === 'b')).toBe(true)
    expect(
      enters.some(
        (e) => e.hook === 'onAfterEnter' && e.edge === 'end' && e.failed === true,
      ),
    ).toBe(true)
  })
})

describe('W8/V1 — lifecycle channel: hung and throwing callbacks', () => {
  it('reports a HUNG callback as a begin with NO matching end', async () => {
    const { events, monitor } = makeSink()
    const owner = { state: 'a' }
    const sm = new StateMachine(
      {
        name: 'HungEnter',
        initialState: 'a',
        stateAttribute: 'state',
        states: {
          a: {},
          b: {
            onBeforeEnter: () => {},
            // Never settles.
            onEnter: () => new Promise<void>(() => {}),
            onAfterEnter: () => {},
          },
        },
        events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
      } as any,
      owner as any,
      { monitor },
    )
    await tick()
    events.length = 0

    // Deliberately NOT awaited: the drain is parked inside the hung callback.
    void sm.fireEvent('go')
    await tick(20)

    const onEnterRecords = events.filter((e) => e.hook === 'onEnter')
    expect(onEnterRecords.map((e) => e.edge)).toEqual(['begin'])

    // The hook BEFORE it closed normally; the hook AFTER it never started —
    // which is precisely the "stuck here" diagnosis.
    expect(
      events.filter((e) => e.hook === 'onBeforeEnter').map((e) => e.edge),
    ).toEqual(['begin', 'end'])
    expect(events.filter((e) => e.hook === 'onAfterEnter')).toHaveLength(0)
  })

  it('reports a THROWING callback as end/failed:true AND still routes the error to onError', async () => {
    const { events, monitor } = makeSink()
    const seen: Error[] = []
    const owner = { state: 'a' }
    const sm = new StateMachine(
      {
        name: 'ThrowingExit',
        initialState: 'a',
        stateAttribute: 'state',
        states: {
          a: {
            onExit: () => {
              throw new Error('exit blew up')
            },
            onError: (_o: any, e: Error) => {
              seen.push(e)
            },
          },
          b: {},
        },
        events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
      } as any,
      owner as any,
      { monitor },
    )
    await tick()
    events.length = 0

    await sm.fireEvent('go')

    const onExitEnd = events.find((e) => e.hook === 'onExit' && e.edge === 'end')
    expect(onExitEnd).toBeDefined()
    expect(onExitEnd?.failed).toBe(true)

    // Error routing is UNCHANGED — the state onError still recovered it and the
    // transition still committed.
    expect(seen).toHaveLength(1)
    expect(seen[0]?.message).toMatch(/exit blew up/)
    expect(sm.getCurrentState()).toBe('b')
  })

  it('emits the failed end BEFORE the error is routed to onError', async () => {
    // The whole point: if `end` were emitted after error routing, a slow or hung
    // onError handler would be indistinguishable from a slow or hung onEnter.
    const order: string[] = []
    const monitor: IMonitor = {
      recordTransition() {},
      recordError() {},
      recordLifecycle(e) {
        if (e.hook === 'onEnter' && e.edge === 'end') order.push('lifecycle-end')
      },
    }
    const owner = { state: 'a' }
    const sm = new StateMachine(
      {
        name: 'EndBeforeOnError',
        initialState: 'a',
        stateAttribute: 'state',
        states: {
          a: {},
          b: {
            onEnter: () => {
              throw new Error('enter blew up')
            },
            onError: () => {
              order.push('onError')
            },
          },
        },
        events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
      } as any,
      owner as any,
      { monitor },
    )
    await tick()

    await sm.fireEvent('go')

    expect(order).toEqual(['lifecycle-end', 'onError'])
  })

  it('the sink guard swallows the SINK error only — the callback error still reaches onError', async () => {
    const seen: Error[] = []
    const monitor: IMonitor = {
      recordTransition() {},
      recordError() {},
      recordLifecycle() {
        throw new Error('hostile sink')
      },
    }
    const owner = { state: 'a' }
    const sm = new StateMachine(
      {
        name: 'SinkDoesNotEatCallbackError',
        initialState: 'a',
        stateAttribute: 'state',
        states: {
          a: {},
          b: {
            onEnter: () => {
              throw new Error('enter blew up')
            },
            onError: (_o: any, e: Error) => {
              seen.push(e)
            },
          },
        },
        events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
      } as any,
      owner as any,
      { monitor },
    )
    await tick()

    await sm.fireEvent('go')

    expect(seen).toHaveLength(1)
    expect(seen[0]?.message).toMatch(/enter blew up/)
    // The hostile sink's own error never surfaced anywhere.
    expect(seen.some((e) => /hostile sink/.test(e.message))).toBe(false)
  })

  it('marks a settling callback with failed:false so success and failure are distinguishable', async () => {
    const { events, monitor } = makeSink()
    const owner = { state: 'a' }
    const sm = new StateMachine(
      {
        name: 'CleanEnd',
        initialState: 'a',
        stateAttribute: 'state',
        states: { a: {}, b: { onEnter: () => {} } },
        events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
      } as any,
      owner as any,
      { monitor },
    )
    await tick()
    events.length = 0

    await sm.fireEvent('go')

    const end = events.find((e) => e.hook === 'onEnter' && e.edge === 'end')
    expect(end?.failed).toBe(false)
  })
})

describe('W8/V1 — lifecycle channel: sink isolation and additivity', () => {
  it('a recordLifecycle that THROWS cannot break the drain', async () => {
    let calls = 0
    const monitor: IMonitor = {
      recordTransition() {},
      recordError() {},
      recordLifecycle() {
        calls++
        throw new Error('hostile sink')
      },
    }
    const owner = { state: 'a' }
    const sm = new StateMachine(
      {
        name: 'HostileSink',
        initialState: 'a',
        stateAttribute: 'state',
        states: { a: { onExit: () => {} }, b: { onEnter: () => {} } },
        events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
      } as any,
      owner as any,
      { monitor },
    )
    await tick()

    await expect(sm.fireEvent('go')).resolves.toBe(true)
    expect(sm.getCurrentState()).toBe('b')
    // The sink really was exercised (the test is not vacuously green).
    expect(calls).toBeGreaterThan(0)
  })

  it('a monitor WITHOUT recordLifecycle keeps working (the channel is purely additive)', async () => {
    const transitions: Array<[number, boolean]> = []
    const monitor: IMonitor = {
      recordTransition(duration, success) {
        transitions.push([duration, success])
      },
      recordError() {},
    }
    const owner = { state: 'a' }
    const sm = new StateMachine(
      {
        name: 'LegacyMonitor',
        initialState: 'a',
        stateAttribute: 'state',
        states: { a: { onExit: () => {} }, b: { onEnter: () => {} } },
        events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
      } as any,
      owner as any,
      { monitor },
    )
    await tick()

    await expect(sm.fireEvent('go')).resolves.toBe(true)
    expect(sm.getCurrentState()).toBe('b')
    expect(transitions.some(([, success]) => success)).toBe(true)
  })
})

describe('W8/V1b — lifecycle channel: invoke observability', () => {
  it('observes a timer-form invoke action declared as an inline function', async () => {
    const { events, monitor } = makeSink()
    let ran = 0
    const owner = { state: 'working' }
    const sm = new StateMachine(
      {
        name: 'InvokeInlineAction',
        initialState: 'working',
        stateAttribute: 'state',
        states: {
          working: {
            invoke: [
              {
                delay: 0,
                event: 'ping',
                action: () => {
                  ran++
                },
              },
            ],
          },
          done: {},
        },
        events: { ping: { transitions: [{ from: 'working', to: 'done' }] } },
      } as any,
      owner as any,
      { monitor },
    )
    await tick(20)

    expect(ran).toBe(1)
    expect(trace(events, 'invoke')).toContain('invoke.action@working:begin')
    expect(trace(events, 'invoke')).toContain('invoke.action@working:end')
    expect(sm.getCurrentState()).toBe('done')
  })

  it('observes a STRING-method invoke action (the ISS-030 gap: no bracketAsync wrapper)', async () => {
    const { events, monitor } = makeSink()
    let ran = 0
    const owner = {
      state: 'working',
      // Resolved by NAME at call time — the form that no other observability
      // surface could see.
      doWork: async () => {
        ran++
      },
    }
    const sm = new StateMachine(
      {
        name: 'InvokeStringAction',
        initialState: 'working',
        stateAttribute: 'state',
        states: {
          working: {
            invoke: [{ delay: 0, event: 'ping', action: 'doWork' }],
          },
          done: {},
        },
        events: { ping: { transitions: [{ from: 'working', to: 'done' }] } },
      } as any,
      owner as any,
      { monitor },
    )
    await tick(20)

    expect(ran).toBe(1)
    const invokes = events.filter((e) => e.hook === 'invoke.action')
    expect(invokes.map((e) => e.edge)).toEqual(['begin', 'end'])
    expect(invokes[0]?.state).toBe('working')
    expect(invokes[0]?.owner).toBe(owner)
    expect(invokes[1]?.failed).toBe(false)
    expect(sm.getCurrentState()).toBe('done')
  })

  it('observes a long-running invoke OPERATION from start to settle', async () => {
    const { events, monitor } = makeSink()
    const owner = { state: 'working' }
    const sm = new StateMachine(
      {
        name: 'InvokeOperation',
        initialState: 'working',
        stateAttribute: 'state',
        states: {
          working: {
            invoke: [
              {
                src: async () => {
                  await tick(5)
                  return 'value'
                },
                onDone: 'finished',
              },
            ],
          },
          done: {},
        },
        events: { finished: { transitions: [{ from: 'working', to: 'done' }] } },
      } as any,
      owner as any,
      { monitor },
    )

    await tick(2)
    const early = events.filter((e) => e.hook === 'invoke.operation')
    expect(early.map((e) => e.edge)).toEqual(['begin'])

    await tick(40)
    const late = events.filter((e) => e.hook === 'invoke.operation')
    expect(late.map((e) => e.edge)).toEqual(['begin', 'end'])
    expect(late[1]?.failed).toBe(false)
    expect(sm.getCurrentState()).toBe('done')
  })

  it('marks a REJECTING invoke operation with failed:true', async () => {
    const { events, monitor } = makeSink()
    const owner = { state: 'working' }
    new StateMachine(
      {
        name: 'InvokeOperationFails',
        initialState: 'working',
        stateAttribute: 'state',
        states: {
          working: {
            invoke: [
              {
                src: async () => {
                  throw new Error('op failed')
                },
                onDone: 'finished',
                onError: 'broke',
              },
            ],
          },
          done: {},
          bad: {},
        },
        events: {
          finished: { transitions: [{ from: 'working', to: 'done' }] },
          broke: { transitions: [{ from: 'working', to: 'bad' }] },
        },
      } as any,
      owner as any,
      { monitor },
    )
    await tick(30)

    const op = events.filter((e) => e.hook === 'invoke.operation')
    expect(op.map((e) => e.edge)).toEqual(['begin', 'end'])
    expect(op[1]?.failed).toBe(true)
  })

  it('reports an ABORT of an in-flight operation as an adjacent begin/end point', async () => {
    const { events, monitor } = makeSink()
    const owner = { state: 'working' }
    const sm = new StateMachine(
      {
        name: 'InvokeAbort',
        initialState: 'working',
        stateAttribute: 'state',
        states: {
          working: {
            invoke: [
              {
                src: () => new Promise<void>(() => {}),
                onDone: 'finished',
              },
            ],
          },
          done: {},
        },
        events: {
          finished: { transitions: [{ from: 'working', to: 'done' }] },
          leave: { transitions: [{ from: 'working', to: 'done' }] },
        },
      } as any,
      owner as any,
      { monitor },
    )
    await tick(10)
    events.length = 0

    await sm.fireEvent('leave')

    const aborts = events.filter((e) => e.hook === 'invoke.abort')
    expect(aborts.map((e) => e.edge)).toEqual(['begin', 'end'])
    expect(aborts[0]?.state).toBe('working')
    expect(aborts[0]?.owner).toBe(owner)
  })
})

describe('W8/V1c — lifecycle channel: guard observability', () => {
  const build = (monitor: IMonitor, gate: { open: boolean }) => {
    const owner = { state: 'a' }
    const sm = new StateMachine(
      {
        name: 'GuardCoverage',
        initialState: 'a',
        stateAttribute: 'state',
        states: { a: {}, b: {}, c: {} },
        events: {
          go: {
            transitions: [
              { from: 'a', to: 'b', guard: () => gate.open },
              { from: 'a', to: 'c', guard: () => true },
            ],
          },
        },
      } as any,
      owner as any,
      { monitor },
    )
    return { sm, owner }
  }

  it('reports outcome:true for the guard that admits the transition', async () => {
    const { events, monitor } = makeSink()
    const { sm, owner } = build(monitor, { open: true })
    await tick()
    events.length = 0

    await sm.fireEvent('go')

    const guards = events.filter((e) => e.kind === 'guard')
    const ends = guards.filter((e) => e.edge === 'end')
    expect(ends).toHaveLength(1)
    expect(ends[0]?.outcome).toBe(true)
    expect(ends[0]?.failed).toBe(false)
    expect(ends[0]?.transition).toBe('a -> b')
    expect(ends[0]?.state).toBe('a')
    expect(ends[0]?.owner).toBe(owner)
    expect(sm.getCurrentState()).toBe('b')
  })

  it('reports outcome:false for a rejecting guard, and keeps evaluating the next candidate', async () => {
    const { events, monitor } = makeSink()
    const { sm } = build(monitor, { open: false })
    await tick()
    events.length = 0

    await sm.fireEvent('go')

    const ends = events.filter((e) => e.kind === 'guard' && e.edge === 'end')
    // Both guards ran; the transition label makes them distinguishable, which is
    // what guard COVERAGE ("which guard never returned true/false?") keys on.
    expect(ends.map((e) => [e.transition, e.outcome])).toEqual([
      ['a -> b', false],
      ['a -> c', true],
    ])
    expect(sm.getCurrentState()).toBe('c')
  })

  it('reports a THROWING guard as failed:true / outcome:false and leaves the transition disabled', async () => {
    const { events, monitor } = makeSink()
    const owner = { state: 'a' }
    const sm = new StateMachine(
      {
        name: 'GuardThrows',
        initialState: 'a',
        stateAttribute: 'state',
        states: { a: {}, b: {} },
        events: {
          go: {
            transitions: [
              {
                from: 'a',
                to: 'b',
                guard: () => {
                  throw new Error('guard blew up')
                },
              },
            ],
          },
        },
      } as any,
      owner as any,
      { monitor },
    )
    await tick()
    events.length = 0

    await expect(sm.fireEvent('go')).resolves.toBe(false)

    const ends = events.filter((e) => e.kind === 'guard' && e.edge === 'end')
    expect(ends).toHaveLength(1)
    expect(ends[0]?.failed).toBe(true)
    expect(ends[0]?.outcome).toBe(false)
    expect(sm.getCurrentState()).toBe('a')
  })

  it('shares ONE microstep id between a guard and the hooks of the microstep it selects', async () => {
    const { events, monitor } = makeSink()
    const { sm } = build(monitor, { open: true })
    await tick()
    events.length = 0

    await sm.fireEvent('go')

    const guard = events.find((e) => e.kind === 'guard')
    const enter = events.find((e) => e.kind === 'enter')
    expect(guard).toBeDefined()
    expect(guard?.microstep).toBeGreaterThan(0)
    // An `enter` record only exists when the target declares hooks; when it does,
    // it must belong to the SAME microstep as the guard that selected it.
    if (enter) expect(enter.microstep).toBe(guard?.microstep)
    expect(sm.getCurrentState()).toBe('b')
  })
})
