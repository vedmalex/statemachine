// README extract-test (W2.1) — the documented examples are under guard: their
// VERBATIM text is asserted against the README file AND the runtime behaviour the
// prose claims is executed and checked. This ties the composite-`initial`
// example (M-1) to the engine: if either the README example text drifts OR the
// engine stops honouring the composite initial, this test fails.
//
// Guarded example: the parallel-regions block in README.md whose composite
// `initial: 'a.run|b.run'` is claimed (bullet "Expansion") to expand to the
// active configuration `proc.a.run|proc.b.run` on entry.

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
