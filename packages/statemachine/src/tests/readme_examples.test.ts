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
//      machine" — see the comment above that describe.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
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
// `fireEventFor` THROWS, a composite parent name is not expanded for a `*For`
// owner, and `toJSON` covers the construction owner alone.

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

  it('a `*For` owner is read as it stands — a composite parent is not expanded', async () => {
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
    // A row whose column holds the composite PARENT offers only `work`'s own
    // transitions — the documented "seed the leaf path, not the parent name".
    expect(sm.getAvailableEventsFor({ state: 'work' })).toEqual(['pause'])
    // The leaf path is what the engine writes and what it reads back.
    expect(sm.getAvailableEventsFor({ state: 'work.r.stepA' })).toEqual([
      'next',
      'pause',
    ])
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
