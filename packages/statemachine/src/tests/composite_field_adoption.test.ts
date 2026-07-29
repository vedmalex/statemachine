/**
 * @module tests/composite_field_adoption — B2.
 *
 * A state field that a CONSUMER hydrated out-of-band (a row loaded from a table,
 * a hand-seeded object) can hold a bare COMPOSITE parent name. Every path that
 * writes the field THROUGH the machine already expands such a name into the
 * composite's `initial` configuration — a transition `to: 'work'`, the
 * constructor's `setInitialState`, `reset`, and `restoreState` all do it, and
 * `computeInternalWrite` carries an explicit D1 comment saying a bare regioned
 * composite must never short-circuit as a simple root.
 *
 * Adopting a field the consumer wrote was the one path that did NOT apply that
 * rule: `getCurrentState` validated `work` as a legal state path and then handed
 * it on verbatim, so the record was offered only `work`'s own transitions and a
 * transition declared from `work.r.stepA` never matched. Accepted as valid, then
 * silently inert.
 *
 * Completion here is PURE, matching `restoreState` (which expands a bare
 * composite and fires no entry actions): it decides which transitions match, it
 * does not re-enter the composite.
 */
import { describe, expect, it } from 'vitest'
import {
  MemoryAdapter,
  StateMachine,
  StateMachineError,
  type IMonitor,
  type StateMachineConfig,
} from '../index'

interface Row {
  state: string
}

const cfg = {
  name: 'compositeFieldAdoption',
  initialState: 'idle',
  stateAttribute: 'state',
  states: {
    idle: {},
    work: {
      initial: 'r.stepA',
      regions: { r: { stepA: {}, stepB: {} } },
    },
  },
  events: {
    start: { transitions: [{ from: 'idle', to: 'work' }] },
    next: { transitions: [{ from: 'work.r.stepA', to: 'work.r.stepB' }] },
  },
} as unknown as StateMachineConfig<Row>

const parallel = {
  name: 'compositeFieldAdoptionParallel',
  initialState: 'idle',
  stateAttribute: 'state',
  states: {
    idle: {},
    proc: {
      initial: 'a.run|b.run',
      regions: { a: { run: {}, done: {} }, b: { run: {}, stop: {} } },
    },
  },
  events: {
    finishA: { transitions: [{ from: 'proc.a.run', to: 'proc.a.done' }] },
  },
} as unknown as StateMachineConfig<Row>

describe('B2 · a bare composite in the state field is completed to its initial configuration', () => {
  it('a *For owner reading the composite parent is offered the composite’s initial-leaf transitions', async () => {
    const sm = new StateMachine<Row, typeof cfg>(cfg, { state: 'idle' })
    await Promise.resolve()

    const row: Row = { state: 'work' }
    expect(sm.getAvailableEventsFor(row)).toEqual(['next'])
    expect(sm.canFireEventFor(row, 'next')).toBe(true)
    expect(await sm.fireEventFor(row, 'next')).toBe(true)
    expect(row.state).toBe('work.r.stepB')
  })

  it('the completion is the SAME one the write paths perform (transition into the composite)', async () => {
    const sm = new StateMachine<Row, typeof cfg>(cfg, { state: 'idle' })
    await Promise.resolve()

    const viaTransition: Row = { state: 'idle' }
    await sm.fireEventFor(viaTransition, 'start')

    const viaField: Row = { state: 'work' }
    expect(sm.getAvailableEventsFor(viaField)).toEqual(
      sm.getAvailableEventsFor(viaTransition),
    )
  })

  it('applies to the PRIMARY owner whose field was written out-of-band, not just to *For', async () => {
    const primary: Row = { state: 'idle' }
    const sm = new StateMachine<Row, typeof cfg>(cfg, primary)
    await Promise.resolve()

    primary.state = 'work' // consumer writes the parent name directly
    expect(sm.getAvailableEvents()).toEqual(['next'])
    expect(await sm.fireEvent('next')).toBe(true)
    expect(primary.state).toBe('work.r.stepB')
  })

  it('applies through an explicit Adapter as well as a raw owner', async () => {
    const sm = new StateMachine<Row, typeof cfg>(cfg, { state: 'idle' })
    await Promise.resolve()

    const adapter = new MemoryAdapter<Row>({ state: 'work' })
    expect(sm.canFireEvent('next', adapter)).toBe(true)
    expect(await sm.fireEvent('next', adapter)).toBe(true)
    expect(adapter.get('state')).toBe('work.r.stepB')
  })

  it('completes EVERY region of a parallel composite, not just the first', async () => {
    const sm = new StateMachine<Row, typeof parallel>(parallel, { state: 'idle' })
    await Promise.resolve()

    const row: Row = { state: 'proc' }
    expect(sm.canFireEventFor(row, 'finishA')).toBe(true)
    expect(await sm.fireEventFor(row, 'finishA')).toBe(true)
    // region b must survive the microstep: completion entered it too.
    expect(row.state).toBe('proc.a.done|proc.b.run')
  })

  it('leaves an already well-formed leaf configuration untouched', async () => {
    const sm = new StateMachine<Row, typeof cfg>(cfg, { state: 'idle' })
    await Promise.resolve()

    const row: Row = { state: 'work.r.stepA' }
    expect(sm.getCurrentState(new MemoryAdapter(row))).toBe('work.r.stepA')
    expect(sm.getAvailableEventsFor(row)).toEqual(['next'])
    expect(row.state).toBe('work.r.stepA')
  })

  it('does NOT fire the completed leaf’s entry actions (parity with restoreState)', async () => {
    const entered: string[] = []
    const observed = {
      ...cfg,
      states: {
        idle: {},
        work: {
          initial: 'r.stepA',
          regions: {
            r: {
              stepA: { onEnter: () => { entered.push('stepA') } },
              stepB: {},
            },
          },
        },
      },
    } as unknown as StateMachineConfig<Row>

    const sm = new StateMachine<Row, typeof observed>(observed, { state: 'idle' })
    await Promise.resolve()
    entered.length = 0

    const row: Row = { state: 'work' }
    expect(sm.getAvailableEventsFor(row)).toEqual(['next'])
    await Promise.resolve()
    expect(entered).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// B2/C4 — a MIXED field, i.e. a bare composite alongside other parts.
//
// Completion delegates to `computeInternalWrite`, and that is a WRITE primitive:
// its parts are applied IN ORDER, each overwriting whatever occupied its region,
// and a final pass drops every surviving non-dotted entry. Both behaviours are
// correct for a write (the drop-pass is what strips the `idle` root a transition
// into `work` replaces). Inherited verbatim by an ADOPTION path they produced two
// silent losses, neither of which raised anything:
//
//   'work.r.stepB|work'   →  'work.r.stepA'              a position REWOUND
//   'proc.a.done|proc'    →  'proc.a.run|proc.b.run'     a finished region reset
//   'idle|work'           →  'work.r.stepA'              a part simply GONE
//
// The first two are recoverable — the bare parent and its own descendant are not
// in conflict, the descendant is just more specific — and are now resolved in the
// descendant's favour. The third is a genuine contradiction with no completion,
// and is refused.
// ═══════════════════════════════════════════════════════════════════════════

const nested = {
  name: 'compositeFieldAdoptionNested',
  initialState: 'idle',
  stateAttribute: 'state',
  states: {
    idle: {},
    outer: {
      initial: 'o.mid',
      regions: {
        o: {
          mid: {
            initial: 'i.x',
            regions: { i: { x: {}, y: {} } },
          },
        },
      },
    },
  },
  events: {
    toY: { transitions: [{ from: 'outer.o.mid.i.x', to: 'outer.o.mid.i.y' }] },
  },
} as unknown as StateMachineConfig<Row>

describe('B2/C4 · a bare composite ALONGSIDE other parts', () => {
  const read = (sm: StateMachine<Row, any>, field: string): string =>
    sm.getCurrentState(new MemoryAdapter<Row>({ state: field }) as never) as string

  it('a recorded descendant WINS over the composite whose regions it refines', async () => {
    const sm = new StateMachine<Row, typeof cfg>(cfg, { state: 'idle' })
    await Promise.resolve()
    // Pre-C4 this returned 'work.r.stepA' — the position was silently rewound.
    expect(read(sm, 'work.r.stepB|work')).toBe('work.r.stepB')
  })

  it('…and the OTHER regions of that composite are still completed', async () => {
    const sm = new StateMachine<Row, typeof parallel>(parallel, { state: 'idle' })
    await Promise.resolve()
    // Region `a` keeps the position the field recorded; region `b`, which the
    // field said nothing about, is completed to its initial. Dropping the
    // redundant `proc` instead would have left `b` unentered.
    expect(read(sm, 'proc.a.done|proc')).toBe('proc.a.done|proc.b.run')
  })

  it('the result does not depend on the order the consumer serialised the parts', async () => {
    const sm = new StateMachine<Row, typeof parallel>(parallel, { state: 'idle' })
    await Promise.resolve()
    expect(read(sm, 'proc|proc.a.done')).toBe('proc.a.done|proc.b.run')
    expect(read(sm, 'proc.a.done|proc')).toBe('proc.a.done|proc.b.run')
  })

  it('a NESTED composite refines its parent rather than being clobbered by it', async () => {
    const sm = new StateMachine<Row, typeof nested>(nested, { state: 'idle' })
    await Promise.resolve()
    expect(read(sm, 'outer')).toBe('outer.o.mid.i.x')
    // The inner leaf survives the outer expansion, in either written order.
    expect(read(sm, 'outer|outer.o.mid.i.y')).toBe('outer.o.mid.i.y')
    expect(read(sm, 'outer.o.mid.i.y|outer')).toBe('outer.o.mid.i.y')
  })

  it('a CONTRADICTORY field is refused instead of silently losing a part', async () => {
    const sm = new StateMachine<Row, typeof cfg>(cfg, { state: 'idle' })
    await Promise.resolve()
    // Two roots active at once: no configuration can mean this.
    for (const field of ['idle|work', 'work|idle']) {
      expect(() => read(sm, field)).toThrow(/Contradictory state field: idle/)
    }
  })

  it('the refusal names the part that was lost, not merely "invalid"', async () => {
    const sm = new StateMachine<Row, typeof parallel>(parallel, { state: 'idle' })
    await Promise.resolve()
    expect(() => read(sm, 'idle|proc')).toThrow(
      /Contradictory state field: idle in idle\|proc .*\(completed to proc\.a\.run\|proc\.b\.run\)/,
    )
  })

  it('is a StateMachineError carrying the offending field, like the sibling read failure', async () => {
    const sm = new StateMachine<Row, typeof cfg>(cfg, { state: 'idle' })
    await Promise.resolve()
    try {
      read(sm, 'idle|work')
      throw new Error('expected a throw')
    } catch (e) {
      expect(e).toBeInstanceOf(StateMachineError)
      expect((e as StateMachineError).context.state).toBe('idle|work')
    }
  })

  it('a field with NO bare composite is still returned verbatim — unpoliced, as before', async () => {
    const sm = new StateMachine<Row, typeof cfg>(cfg, { state: 'idle' })
    await Promise.resolve()
    // Two leaves of ONE region is also malformed, but it never reaches
    // completion and this change does not claim to catch it. Pinned so the
    // boundary of the new refusal is explicit rather than incidental.
    expect(read(sm, 'work.r.stepA|work.r.stepB')).toBe('work.r.stepA|work.r.stepB')
  })

  it('a duplicated bare composite is not a contradiction', async () => {
    const sm = new StateMachine<Row, typeof cfg>(cfg, { state: 'idle' })
    await Promise.resolve()
    expect(read(sm, 'work|work')).toBe('work.r.stepA')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// B2/C3 — a public READ that throws must not become a floating rejection.
//
// `getCurrentState` has always thrown on a state field naming an unknown state.
// The invoke machinery calls it from SCHEDULER callbacks, where there is no
// caller to catch anything: the timer form read it OUTSIDE its own `try` (an
// unhandled rejection out of an `async` timer callback) and the operation form's
// `startOp` read it unguarded in a SYNCHRONOUS arrow (an uncaught exception).
// Both now route through the observable error channel instead.
// ═══════════════════════════════════════════════════════════════════════════

/** A complete {@link IMonitor} that only remembers the errors it was handed. */
function collectErrors(sink: Error[]): IMonitor {
  return {
    recordTransition: () => {},
    recordError: (error: Error) => {
      sink.push(error)
    },
  }
}

describe('B2/C3 · a corrupted field cannot crash the process from an invoke callback', () => {
  /** Collect real process-level unhandled rejections for the duration of `body`. */
  async function withUnhandledRejectionWatch(
    body: () => Promise<void>,
  ): Promise<unknown[]> {
    const seen: unknown[] = []
    const on = (e: unknown) => { seen.push(e) }
    process.on('unhandledRejection', on)
    try {
      await body()
    } finally {
      process.off('unhandledRejection', on)
    }
    return seen
  }

  it('the TIMER form reports the corrupted field instead of rejecting into the void', async () => {
    const timerCfg = {
      name: 'invokeTimerCorruptField',
      initialState: 'idle',
      stateAttribute: 'state',
      states: {
        idle: {},
        armed: { invoke: [{ delay: 5, event: 'ping' }] },
        done: {},
      },
      events: {
        go: { transitions: [{ from: 'idle', to: 'armed' }] },
        ping: { transitions: [{ from: 'armed', to: 'done' }] },
      },
    } as unknown as StateMachineConfig<Row>

    const errors: Error[] = []
    const row: Row = { state: 'idle' }
    const sm = new StateMachine<Row, typeof timerCfg>(timerCfg, row, {
      monitor: collectErrors(errors),
    } as never)
    await Promise.resolve()

    const rejections = await withUnhandledRejectionWatch(async () => {
      await sm.fireEvent('go')
      expect(row.state).toBe('armed')
      row.state = 'bogus' // corrupted out-of-band while the timer is armed
      await new Promise((r) => setTimeout(r, 60))
    })

    expect(rejections).toEqual([])
    // Not silent either: the failure reached the observable channel.
    expect(errors.length).toBeGreaterThan(0)
    expect(String(errors[0]?.message)).toContain('Invalid state path')
    expect(row.state).toBe('bogus') // and the timer did NOT fire
  })

  it('the OPERATION form retires its launch slot instead of throwing out of the scheduler', async () => {
    const opCfg = {
      name: 'invokeOpCorruptField',
      initialState: 'idle',
      stateAttribute: 'state',
      states: {
        idle: {},
        armed: {
          invoke: [{ src: async () => 'never reached', onDone: 'ok' }],
        },
        done: {},
      },
      events: {
        go: { transitions: [{ from: 'idle', to: 'armed' }] },
        ok: { transitions: [{ from: 'armed', to: 'done' }] },
      },
    } as unknown as StateMachineConfig<Row>

    const errors: Error[] = []
    const row: Row = { state: 'idle' }
    const sm = new StateMachine<Row, typeof opCfg>(opCfg, row, {
      monitor: collectErrors(errors),
    } as never)
    await Promise.resolve()

    const rejections = await withUnhandledRejectionWatch(async () => {
      await sm.fireEvent('go')
      row.state = 'bogus'
      await new Promise((r) => setTimeout(r, 60))
    })

    expect(rejections).toEqual([])
    expect(row.state).toBe('bogus')
    // The launch slot was RETIRED, not leaked. Repair the field and serialize:
    // `toJSON` refuses on an operation it believes is still in flight, so a
    // clean serialization is the observable proof that `startOp` bailed out
    // through `retire()` rather than dying somewhere before it.
    row.state = 'armed'
    expect(() => sm.toJSON()).not.toThrow()
  })
})
