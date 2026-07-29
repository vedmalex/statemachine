// W8/V2 — the consumer-side LIFECYCLE TRACER built on `IMonitor.recordLifecycle`.
//
// The raw channel (pinned by `lifecycle_channel.test.ts`) is a time-free stream
// of begin/end edges. THIS suite pins the debugging INSTRUMENT layered on it:
// begin/end pairing, subscriber timestamps, the rendered timeline, and the four
// diagnostic questions the feature exists to answer —
//   "who is hung?"            → unfinished()
//   "who threw?"              → failures()
//   "which guard never held?" → guardOutcomes()
//   "which object was it?"    → byOwner()
//
// Every case drives a REAL machine; nothing here pokes tracer internals.
import { describe, expect, it } from 'vitest'
import { createLifecycleTracer } from '../lifecycle-tracer'
import { StateMachine } from '../state_machine'
import { type IMonitor, MemoryAdapter } from '../types'

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

// A frozen clock: durations are all 0 and therefore never rendered, which keeps
// the format assertions about STRUCTURE rather than about timing noise.
const frozen = () => 0

describe('W8/V2 — lifecycle tracer: format() renders the callback timeline', () => {
  it('shows entry order, hierarchy indentation and microstep grouping for a composite with regions', async () => {
    const tracer = createLifecycleTracer({ now: frozen })
    const owner = { state: 'idle' }
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
            onExit: () => {},
            regions: {
              r: {
                inner: { onEnter: () => {}, onExit: () => {} },
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
      { monitor: tracer },
    )
    await tick()
    tracer.reset()

    await sm.fireEvent('go')
    await sm.fireEvent('back')

    // Ancestor's hooks complete before the descendant's begin; the descendant is
    // INDENTED by its dot-depth; exit unwinds innermost-first; each microstep is
    // its own labelled block.
    expect(tracer.format()).toBe(
      [
        "microstep 1  (event: 'go')",
        '  enter  outer            onBeforeEnter',
        '  enter  outer            onEnter',
        '  enter    outer.r.inner  onEnter',
        "microstep 2  (event: 'back')",
        '  exit     outer.r.inner  onExit',
        '  exit   outer            onExit',
        '— 10 records',
      ].join('\n'),
    )
  })

  it('is byte-identical across runs when `now` is injected (deterministic for sim / snapshots)', async () => {
    const build = async () => {
      let virtual = 0
      const tracer = createLifecycleTracer({ now: () => (virtual += 7) })
      const owner = { state: 'a' }
      const sm = new StateMachine(
        {
          name: 'Deterministic',
          initialState: 'a',
          stateAttribute: 'state',
          states: { a: { onExit: () => {} }, b: { onEnter: () => {} } },
          events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
        } as any,
        owner as any,
        { monitor: tracer },
      )
      await tick()
      tracer.reset()
      await sm.fireEvent('go')
      return tracer.format()
    }

    const first = await build()
    // Real wall-clock time passes between the two runs; the rendering must not
    // notice, because the tracer stamps the INJECTED clock, not Date.now().
    await tick(15)
    const second = await build()

    expect(second).toBe(first)
    expect(first).toContain('7ms')
  })

  it('renders an empty trace without throwing', () => {
    const tracer = createLifecycleTracer({ now: frozen })
    expect(tracer.format()).toBe('(no lifecycle records)')
  })
})

describe('W8/V2 — lifecycle tracer: unfinished() answers "which callback is hung?"', () => {
  it('reports an onEnter that never settles, and clears it once the promise resolves', async () => {
    const tracer = createLifecycleTracer({ now: frozen })
    let release: (() => void) | undefined
    const owner = { state: 'a' }
    const sm = new StateMachine(
      {
        name: 'HungEnter',
        initialState: 'a',
        stateAttribute: 'state',
        states: {
          a: {},
          b: {
            onEnter: () =>
              new Promise<void>((resolve) => {
                release = resolve
              }),
          },
        },
        events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
      } as any,
      owner as any,
      { monitor: tracer },
    )
    await tick()
    tracer.reset()

    // NOT awaited: the whole point is that the drain has not returned.
    void sm.fireEvent('go')
    await tick(10)

    const hung = tracer.unfinished()
    expect(hung).toHaveLength(1)
    expect(hung[0]?.hook).toBe('onEnter')
    expect(hung[0]?.state).toBe('b')
    // The unmatched record is the BEGIN edge — that is the diagnosis.
    expect(hung[0]?.edge).toBe('begin')
    expect(tracer.format()).toContain('⧗ unfinished')

    // A hung callback is only hung until it isn't: once it settles the pairing
    // closes and the diagnosis disappears (no false positive left behind).
    release?.()
    await tick(10)
    expect(tracer.unfinished()).toEqual([])
    expect(tracer.format()).not.toContain('⧗ unfinished')
  })
})

describe('W8/V2 — lifecycle tracer: failures() answers "which callback threw?"', () => {
  it('reports a throwing onEnter as a failed end edge and marks it in format()', async () => {
    const tracer = createLifecycleTracer({ now: frozen })
    const owner = { state: 'a' }
    const sm = new StateMachine(
      {
        name: 'ThrowingEnter',
        initialState: 'a',
        stateAttribute: 'state',
        states: {
          a: {},
          b: {
            onEnter: () => {
              throw new Error('enter blew up')
            },
            onError: () => {},
          },
        },
        events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
      } as any,
      owner as any,
      { monitor: tracer },
    )
    await tick()
    tracer.reset()

    await sm.fireEvent('go')

    const failed = tracer.failures()
    expect(failed).toHaveLength(1)
    expect(failed[0]?.hook).toBe('onEnter')
    expect(failed[0]?.state).toBe('b')
    expect(failed[0]?.edge).toBe('end')
    expect(tracer.format()).toContain('✗ failed')
    // A callback that THREW settled — it is not hung.
    expect(tracer.unfinished()).toEqual([])
  })
})

describe('W8/V2 — lifecycle tracer: guardOutcomes() answers "which guard never held?"', () => {
  it('surfaces the always-false guard while the sibling transition shows both outcomes', async () => {
    const tracer = createLifecycleTracer({ now: frozen })
    const owner = { state: 'a' }
    let openable = false
    const sm = new StateMachine(
      {
        name: 'GuardCoverage',
        initialState: 'a',
        stateAttribute: 'state',
        states: { a: {}, b: {}, c: {} },
        events: {
          go: {
            transitions: [
              // The classic silent bug: a guard wired to a condition that is
              // never true, so its transition is dead code.
              { from: 'a', to: 'b', guard: () => false },
              { from: 'a', to: 'c', guard: () => openable },
            ],
          },
          back: { transitions: [{ from: 'c', to: 'a' }] },
        },
      } as any,
      owner as any,
      { monitor: tracer },
    )
    await tick()
    tracer.reset()

    await sm.fireEvent('go') // both guards reject
    openable = true
    await sm.fireEvent('go') // a -> b still rejects, a -> c now admits
    await sm.fireEvent('back')

    const coverage = tracer.guardOutcomes()
    const dead = coverage.find((g) => g.transition === 'a -> b')
    const live = coverage.find((g) => g.transition === 'a -> c')

    expect(dead).toBeDefined()
    expect(dead?.sawTrue).toBe(false) // ← the finding
    expect(dead?.sawFalse).toBe(true)
    expect(dead?.evaluations).toBe(2)
    expect(dead?.threw).toBe(0)

    expect(live?.sawTrue).toBe(true)
    expect(live?.sawFalse).toBe(true)

    // The report is what a coverage check reads: "guards that never admitted".
    expect(coverage.filter((g) => !g.sawTrue).map((g) => g.transition)).toEqual(['a -> b'])
  })

  it('counts a THROWING guard as an evaluation that never admitted', async () => {
    const tracer = createLifecycleTracer({ now: frozen })
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
      { monitor: tracer },
    )
    await tick()
    tracer.reset()

    await sm.fireEvent('go')

    const coverage = tracer.guardOutcomes()
    expect(coverage).toHaveLength(1)
    expect(coverage[0]?.threw).toBe(1)
    expect(coverage[0]?.sawTrue).toBe(false)
    expect(tracer.format()).toContain('✗ threw')
  })
})

describe('W8/V2 — lifecycle tracer: byOwner() answers "which object was it?"', () => {
  it('separates the traces of TWO owners driven by ONE machine', async () => {
    const tracer = createLifecycleTracer({ now: frozen })
    const alice = new MemoryAdapter({ state: 'idle', name: 'alice' })
    const bob = new MemoryAdapter({ state: 'idle', name: 'bob' })

    const sm = new StateMachine(
      {
        name: 'MultiOwner',
        initialState: 'idle',
        stateAttribute: 'state',
        states: { idle: {}, active: { onBeforeEnter: () => {}, onEnter: () => {} } },
        events: { go: { transitions: [{ from: 'idle', to: 'active' }] } },
      } as any,
      alice as any,
      { monitor: tracer },
    )
    await tick()
    tracer.reset()

    await sm.fireEvent('go', alice as any)
    await sm.fireEvent('go', bob as any)

    expect(tracer.owners()).toHaveLength(2)

    const forAlice = tracer.byOwner(alice)
    const forBob = tracer.byOwner(bob)

    // Complete and disjoint partition of the trace.
    expect(forAlice.length).toBeGreaterThan(0)
    expect(forBob.length).toBeGreaterThan(0)
    expect(forAlice.length + forBob.length).toBe(tracer.getTrace().length)
    expect(forAlice.every((r) => r.owner === alice.adaptee)).toBe(true)
    expect(forBob.every((r) => r.owner === bob.adaptee)).toBe(true)

    // The ADAPTEE is what the channel reports, but passing the ADAPTER is the
    // obvious consumer mistake — both must resolve to the same projection.
    expect(tracer.byOwner(alice.adaptee as object)).toEqual(forAlice)

    // A filtered rendering shows only that owner's rows.
    const aliceView = tracer.format({ owner: alice })
    expect(aliceView).toContain('onEnter')
    expect(aliceView).not.toContain('owners')
    expect(tracer.format()).toContain('2 owners')
  })

  it('groups by microstep and exposes the ids in order', async () => {
    const tracer = createLifecycleTracer({ now: frozen })
    const owner = { state: 'a' }
    const sm = new StateMachine(
      {
        name: 'Microsteps',
        initialState: 'a',
        stateAttribute: 'state',
        states: { a: { onEnter: () => {} }, b: { onEnter: () => {} } },
        events: {
          go: { transitions: [{ from: 'a', to: 'b' }] },
          back: { transitions: [{ from: 'b', to: 'a' }] },
        },
      } as any,
      owner as any,
      { monitor: tracer },
    )
    await tick()
    tracer.reset()

    await sm.fireEvent('go')
    await sm.fireEvent('back')

    const ids = tracer.microsteps()
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBeLessThan(ids[1] as number)
    expect(tracer.byMicrostep(ids[0] as number).every((r) => r.microstep === ids[0])).toBe(true)

    // Rendering ONE microstep drops the other's block entirely.
    const one = tracer.format({ microstep: ids[0] as number })
    expect(one).toContain(`microstep ${ids[0]}`)
    expect(one).not.toContain(`microstep ${ids[1]}`)
  })
})

describe('W8/V2 — lifecycle tracer: bounded retention', () => {
  it('drops the OLDEST records at `limit` and counts the drops', async () => {
    // The bounded tracer decorates an unbounded one, so the same live stream
    // feeds both — the retained tail can be checked against the full truth.
    const full = createLifecycleTracer({ now: frozen, limit: Number.POSITIVE_INFINITY })
    const bounded = createLifecycleTracer({ now: frozen, limit: 4 })
    const owner = { state: 'a' }
    const sm = new StateMachine(
      {
        name: 'Bounded',
        initialState: 'a',
        stateAttribute: 'state',
        states: { a: { onEnter: () => {}, onExit: () => {} }, b: { onEnter: () => {}, onExit: () => {} } },
        events: {
          go: { transitions: [{ from: 'a', to: 'b' }] },
          back: { transitions: [{ from: 'b', to: 'a' }] },
        },
      } as any,
      owner as any,
      { monitor: bounded.wrap(full) },
    )
    await tick()
    await sm.fireEvent('go')
    await sm.fireEvent('back')
    await sm.fireEvent('go')

    const all = full.getTrace()
    expect(all.length).toBeGreaterThan(4)

    // Exactly `limit` retained, and they are the NEWEST ones, in order.
    const kept = bounded.getTrace()
    expect(kept).toHaveLength(4)
    expect(kept.map((r) => r.seq)).toEqual(all.slice(-4).map((r) => r.seq))

    const stats = bounded.stats()
    expect(stats.limit).toBe(4)
    expect(stats.recorded).toBe(4)
    expect(stats.seen).toBe(all.length)
    expect(stats.dropped).toBe(all.length - 4)
    expect(full.stats().dropped).toBe(0)

    // The loss is DISCLOSED in the rendering rather than silently pretended away.
    expect(bounded.format()).toContain(`${stats.dropped} dropped (limit 4)`)
  })

  it('reset() clears both the trace and the counters', async () => {
    const tracer = createLifecycleTracer({ now: frozen, limit: 2 })
    const owner = { state: 'a' }
    const sm = new StateMachine(
      {
        name: 'Resettable',
        initialState: 'a',
        stateAttribute: 'state',
        states: { a: { onExit: () => {} }, b: { onEnter: () => {} } },
        events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
      } as any,
      owner as any,
      { monitor: tracer },
    )
    await tick()
    await sm.fireEvent('go')
    expect(tracer.stats().dropped).toBeGreaterThan(0)

    tracer.reset()
    expect(tracer.getTrace()).toEqual([])
    expect(tracer.stats()).toEqual({
      recorded: 0,
      seen: 0,
      dropped: 0,
      malformed: 0,
      limit: 2,
    })
  })

  it('falls back to the default limit for a nonsense value instead of throwing', () => {
    expect(createLifecycleTracer({ limit: 0 }).stats().limit).toBe(10_000)
    expect(createLifecycleTracer({ limit: -5 }).stats().limit).toBe(10_000)
    expect(createLifecycleTracer({ limit: 2.5 }).stats().limit).toBe(10_000)
    expect(createLifecycleTracer({ limit: Number.NaN }).stats().limit).toBe(10_000)
  })
})

describe('W8/V2 — lifecycle tracer: wrap() decorates an existing monitor', () => {
  it('keeps forwarding recordTransition / recordError to the wrapped monitor', async () => {
    const transitions: Array<[number, boolean]> = []
    const errors: Error[] = []
    const events: string[] = []
    const inner: IMonitor = {
      recordTransition(duration, success) {
        transitions.push([duration, success])
      },
      recordError(error) {
        errors.push(error)
      },
      recordEvent(name) {
        events.push(name)
      },
    }

    const tracer = createLifecycleTracer({ now: frozen })
    const owner = { state: 'a' }
    const sm = new StateMachine(
      {
        name: 'Decorated',
        initialState: 'a',
        stateAttribute: 'state',
        states: {
          a: {},
          ok: { onEnter: () => {} },
          boom: {
            onEnter: () => {
              throw new Error('enter blew up')
            },
          },
        },
        events: {
          go: { transitions: [{ from: 'a', to: 'ok' }] },
          bang: { transitions: [{ from: 'ok', to: 'boom' }] },
        },
      } as any,
      owner as any,
      { monitor: tracer.wrap(inner) },
    )
    await tick()

    await sm.fireEvent('go')
    // No `onError` on `boom`, so the failure propagates out of the drain — the
    // point here is only that the WRAPPED monitor still saw it.
    await sm.fireEvent('bang').catch(() => {})

    // The decorated monitor keeps its own channels — wrapping is not a swap.
    expect(transitions.length).toBeGreaterThan(0)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some((e) => /enter blew up/.test(e.message))).toBe(true)

    // ...and the tracer sees the lifecycle stream at the same time.
    expect(tracer.failures().map((r) => r.hook)).toContain('onEnter')

    // The optional `recordEvent` is exposed (this engine build never calls it,
    // so drive the wrapper directly) and reaches `inner` with `this` intact.
    tracer.wrap(inner).recordEvent?.('go', 3)
    expect(events).toEqual(['go'])
  })

  it('exposes optional IMonitor members only when the wrapped monitor has them', () => {
    const bare: IMonitor = { recordTransition() {}, recordError() {} }
    const wrapped = createLifecycleTracer().wrap(bare)

    expect(wrapped.recordEvent).toBeUndefined()
    expect(wrapped.getMetrics).toBeUndefined()
    // `recordLifecycle` is ALWAYS present: it is what switches the channel on,
    // even for an inner monitor that never implemented it.
    expect(typeof wrapped.recordLifecycle).toBe('function')
  })

  it('survives a hostile wrapped monitor without losing the record', () => {
    const hostile: IMonitor = {
      recordTransition() {},
      recordError() {},
      recordLifecycle() {
        throw new Error('hostile inner sink')
      },
    }
    const tracer = createLifecycleTracer({ now: frozen })
    const wrapped = tracer.wrap(hostile)

    expect(() =>
      wrapped.recordLifecycle?.({
        kind: 'enter',
        hook: 'onEnter',
        state: 'b',
        owner: {},
        microstep: 1,
        seq: 0,
        edge: 'begin',
      }),
    ).not.toThrow()
    expect(tracer.getTrace()).toHaveLength(1)
  })
})

describe('W8/V2 — lifecycle tracer: it is a pure, defensive subscriber', () => {
  it('never throws on an unusable payload and counts it instead', () => {
    const tracer = createLifecycleTracer({ now: frozen })

    expect(() => tracer.recordLifecycle(undefined as never)).not.toThrow()
    expect(() => tracer.recordLifecycle(null as never)).not.toThrow()
    expect(() => tracer.recordLifecycle('nonsense' as never)).not.toThrow()

    expect(tracer.getTrace()).toEqual([])
    expect(tracer.stats().malformed).toBe(3)
    // A malformed payload must not poison the rendering either.
    expect(() => tracer.format()).not.toThrow()
  })

  it('tolerates a partial record rather than dropping the whole trace', () => {
    const tracer = createLifecycleTracer({ now: frozen })

    tracer.recordLifecycle({ kind: 'enter' } as never)

    const [record] = tracer.getTrace()
    expect(record?.hook).toBe('unknown')
    expect(record?.state).toBe('?')
    expect(record?.microstep).toBe(0)
    expect(record?.edge).toBe('begin')
    expect(typeof record?.owner).toBe('object')
    expect(() => tracer.format()).not.toThrow()
  })

  it('does not perturb the machine it observes', async () => {
    const withTracer: string[] = []
    const withoutTracer: string[] = []
    const build = async (monitor?: IMonitor, log?: string[]) => {
      const owner = { state: 'a' }
      const sm = new StateMachine(
        {
          name: 'NonPerturbing',
          initialState: 'a',
          stateAttribute: 'state',
          states: {
            a: { onExit: () => log?.push('exit a') },
            b: { onBeforeEnter: () => log?.push('before b'), onEnter: () => log?.push('enter b') },
          },
          events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
        } as any,
        owner as any,
        monitor ? { monitor } : {},
      )
      await tick()
      await sm.fireEvent('go')
      return sm.getCurrentState()
    }

    const stateA = await build(createLifecycleTracer({ now: frozen }), withTracer)
    const stateB = await build(undefined, withoutTracer)

    expect(stateA).toBe(stateB)
    expect(withTracer).toEqual(withoutTracer)
  })

  it('returns a COPY of the trace so a caller cannot corrupt it', async () => {
    const tracer = createLifecycleTracer({ now: frozen })
    const owner = { state: 'a' }
    const sm = new StateMachine(
      {
        name: 'CopyOnRead',
        initialState: 'a',
        stateAttribute: 'state',
        states: { a: {}, b: { onEnter: () => {} } },
        events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
      } as any,
      owner as any,
      { monitor: tracer },
    )
    await tick()
    await sm.fireEvent('go')

    const before = tracer.getTrace().length
    tracer.getTrace().length = 0
    expect(tracer.getTrace()).toHaveLength(before)
  })
})
