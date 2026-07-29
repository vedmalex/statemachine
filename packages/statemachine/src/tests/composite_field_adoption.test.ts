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
import { MemoryAdapter, StateMachine, type StateMachineConfig } from '../index'

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
