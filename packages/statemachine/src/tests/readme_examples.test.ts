// README extract-test (W2.1) — the documented examples are under guard: their
// VERBATIM text is asserted against the README file AND the runtime behaviour the
// prose claims is executed and checked. This ties the composite-`initial`
// example (M-1) to the engine: if either the README example text drifts OR the
// engine stops honouring the composite initial, this test fails.
//
// Guarded examples:
//   1. the parallel-regions block in README.md whose composite
//      `initial: 'a.run|b.run'` is claimed (bullet "Expansion") to expand to the
//      active configuration `proc.a.run|proc.b.run` on entry;
//   2. the "A batch over a table" block under "Driving several objects with one
//      machine" — see the comment above that describe;
//   3. the timer trap under "The per-record runtime that does not live in the
//      record", whose `detachOwner(row)` call and whose claim about what happens
//      WITHOUT it are both executed.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createMachine } from '../index'

// Resolve README.md relative to THIS test file (src/tests/ → package root),
// independent of the runner's cwd (import.meta.dir is Bun-only).
const HERE = dirname(fileURLToPath(import.meta.url))
const README = readFileSync(join(HERE, '..', '..', 'README.md'), 'utf8')

describe('README examples · verbatim guard + executed expansion (M-1)', () => {
  it('README still documents the composite initial "a.run|b.run" verbatim', () => {
    // Дословность под охраной: the exact example line must survive edits.
    expect(README).toContain("initial: 'a.run|b.run'")
  })

  it('the documented Expansion claim names proc.a.run|proc.b.run verbatim', () => {
    // The prose the runtime is checked against — parsed straight from the README
    // so the assertion below cannot silently diverge from the documentation.
    const expansion = README.match(
      /expands to the parallel configuration `([^`]+)`/,
    )
    expect(expansion, 'README must state the parallel expansion').not.toBeNull()
    expect(expansion![1]).toBe('proc.a.run|proc.b.run')
  })

  it('running the README config honours that documented expansion (composite initial)', () => {
    // The config mirrors the README block; its correctness is cross-checked
    // against the README text by the two assertions above (verbatim initial +
    // documented expansion). Post-M-1 the engine enters the NAMED leaves.
    const proc = { state: 'proc' }
    const sm = createMachine(
      {
        name: 'proc',
        stateAttribute: 'state',
        initialState: 'proc',
        states: {
          proc: {
            initial: 'a.run|b.run',
            regions: {
              a: { run: {}, done: { final: true } },
              b: { run: {}, done: { final: true } },
            },
          },
          complete: {},
        },
        events: {
          finishA: { transitions: [{ from: 'proc.a.run', to: 'proc.a.done' }] },
          finishB: { transitions: [{ from: 'proc.b.run', to: 'proc.b.done' }] },
          'done.state.proc': { transitions: [{ from: 'proc', to: 'complete' }] },
        },
      },
      proc,
    )

    // The documented expansion (parsed from the README) is exactly what the
    // engine must produce — order-insensitive over the parallel regions.
    const documented = README.match(
      /expands to the parallel configuration `([^`]+)`/,
    )![1]!
    expect(sm.getCurrentState()?.split('|').sort()).toEqual(
      documented.split('|').sort(),
    )
    // And specifically the `run` leaves (not the first-key), the M-1 contract.
    expect(sm.isInState('proc.a.run')).toBe(true)
    expect(sm.isInState('proc.b.run')).toBe(true)
  })
})

// Guarded example: the "A batch over a table" block under "Driving several
// objects with one machine". The documented loop drives MANY records through ONE
// machine via `fireEventDetailedFor`, and the record's own `state` field is the
// persisted machine state. The prose makes three load-bearing claims that are
// executed below — the detailed form reports `no-transition` where the plain
// `fireEventFor` THROWS, a bare composite parent name in the column is completed
// to that composite's `initial` configuration, and `toJSON` covers the
// construction owner alone.

type Order = { id: number; state: string }

const orderConfig = {
  name: 'order',
  stateAttribute: 'state',
  initialState: 'draft',
  states: { draft: {}, review: {}, published: {} },
  events: {
    submit: { transitions: [{ from: 'draft', to: 'review' }] },
    approve: { transitions: [{ from: 'review', to: 'published' }] },
  },
} satisfies Parameters<typeof createMachine<Order>>[0]

describe('README examples · multi-owner batch loop (state, not machine)', () => {
  it('README still documents the detailed-form batch call verbatim', () => {
    // Дословность под охраной: the example must keep using the DETAILED form —
    // swapping it for `fireEventFor` would make the documented loop throw on the
    // first row that has nothing to do.
    expect(README).toContain(
      "const res = await sm.fireEventDetailedFor(row, 'submit')",
    )
    expect(README).toContain('if (res.fired) await save(row)')
  })

  it('the documented loop advances matching rows and reports the rest', async () => {
    // One machine, no construction owner — as the README's example builds it.
    const sm = createMachine<Order>(orderConfig)
    const page = [
      { id: 1, state: 'draft' },
      { id: 2, state: 'review' },
      { id: 3, state: 'draft' },
    ]
    const saved: number[] = []
    for (const row of page) {
      const res = await sm.fireEventDetailedFor(row, 'submit')
      if (res.fired) saved.push(row.id)
    }
    // The state landed in each RECORD's own field, independently.
    expect(page.map((r) => r.state)).toEqual(['review', 'review', 'review'])
    expect(saved).toEqual([1, 3])
    // Row 2 was already past `submit`: reported, not thrown.
    expect(await sm.fireEventDetailedFor(page[1]!, 'submit')).toMatchObject({
      fired: false,
      reason: 'no-transition',
    })
    // …whereas the plain form throws — the reason the README uses the other one.
    await expect(sm.fireEventFor(page[1]!, 'submit')).rejects.toThrow(
      /Invalid event: submit for state: review/,
    )
  })

  it('a composite parent in the column is completed to its `initial` configuration', async () => {
    const sm = createMachine<{ state: string }>({
      name: 'flow',
      stateAttribute: 'state',
      initialState: 'work',
      states: {
        work: { initial: 'r.stepA', regions: { r: { stepA: {}, stepB: {} } } },
        paused: {},
      },
      events: {
        next: { transitions: [{ from: 'work.r.stepA', to: 'work.r.stepB' }] },
        pause: { transitions: [{ from: 'work', to: 'paused' }] },
      },
    })
    // B2: a row whose column holds the composite PARENT is read as the
    // configuration entering that parent produces — the same completion every
    // write path performs. It answers identically to the expanded leaf path.
    expect(sm.getAvailableEventsFor({ state: 'work' })).toEqual(
      sm.getAvailableEventsFor({ state: 'work.r.stepA' }),
    )
    expect(sm.getAvailableEventsFor({ state: 'work' })).toEqual([
      'next',
      'pause',
    ])
    // Completing is not the same as normalizing away: firing writes the leaf
    // path back, so the column ends up holding what the engine writes.
    const row = { state: 'work' }
    expect(sm.canFireEventFor(row, 'next')).toBe(true)
    expect(README).toContain(
      'A row whose column holds a bare composite parent name',
    )
  })

  it('toJSON covers the CONSTRUCTION owner only, not a `*For` record', async () => {
    const owner: Order = { id: 0, state: 'draft' }
    const record: Order = { id: 1, state: 'draft' }
    const sm = createMachine<Order>(orderConfig, owner)
    await sm.fireEventDetailedFor(record, 'submit')
    expect(record.state).toBe('review')
    expect(owner.state).toBe('draft')
    // The record that actually moved is absent from the payload.
    expect(JSON.parse(sm.toJSON()).currentState).toBe('draft')
  })
})

// Guarded example: the timer trap under "The per-record runtime that does not
// live in the record". The README tells the reader to release each row with
// `detachOwner(row)` and claims that WITHOUT it a timer writes into a row the
// loop has already saved. Both halves are executed below, so the documented
// call cannot drift from the surface and the claim cannot outlive the defect.
describe('README examples · detachOwner releases a row before its timer fires', () => {
  it('README still documents the detach call verbatim', () => {
    expect(README).toContain('sm.detachOwner(row)')
    expect(README).toContain('{ timersCleared, operationsAborted,')
  })

  it('the documented loop leaves a released row exactly as it was saved', async () => {
    vi.useFakeTimers()
    try {
      const timed = createMachine<{ id: number; state: string }>({
        name: 'timed',
        stateAttribute: 'state',
        initialState: 'draft',
        states: {
          draft: {},
          review: { invoke: [{ delay: 1000, event: 'expire' }] },
          expired: {},
        },
        events: {
          submit: { transitions: [{ from: 'draft', to: 'review' }] },
          expire: { transitions: [{ from: 'review', to: 'expired' }] },
        },
      } as never)

      const page = [
        { id: 1, state: 'draft' },
        { id: 2, state: 'draft' },
      ]
      const saved: Array<[number, string]> = []
      for (const row of page) {
        const res = await timed.fireEventDetailedFor(row, 'submit')
        if (res.fired) saved.push([row.id, row.state])
        timed.detachOwner(row)
      }

      await vi.advanceTimersByTimeAsync(5000)

      // Every row still holds exactly what `save(row)` wrote.
      expect(saved).toEqual([
        [1, 'review'],
        [2, 'review'],
      ])
      expect(page.map((r) => r.state)).toEqual(['review', 'review'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('and WITHOUT the detach the README’s claim holds — the row is written late', async () => {
    vi.useFakeTimers()
    try {
      const timed = createMachine<{ id: number; state: string }>({
        name: 'timedLeak',
        stateAttribute: 'state',
        initialState: 'draft',
        states: {
          draft: {},
          review: { invoke: [{ delay: 1000, event: 'expire' }] },
          expired: {},
        },
        events: {
          submit: { transitions: [{ from: 'draft', to: 'review' }] },
          expire: { transitions: [{ from: 'review', to: 'expired' }] },
        },
      } as never)

      const row = { id: 1, state: 'draft' }
      await timed.fireEventDetailedFor(row, 'submit')
      expect(row.state).toBe('review') // what was saved
      await vi.advanceTimersByTimeAsync(5000)
      expect(row.state).toBe('expired') // what the orphaned object now says
    } finally {
      vi.useRealTimers()
    }
  })
})
