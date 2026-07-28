// W2.1 RED suite — composite-`initial` engine resolution (M-1) and validator
// soundness gaps (M-2 reachability, M-3 watcher-region DEAD_END, M-4 mutual-
// exclusion breadth). Every `it` here encodes the CORRECT post-fix behavior and
// FAILS on HEAD (the RED role). Do NOT touch src to make these pass — that is
// the GREEN wave's job.
//
// Reproduced on HEAD (probe, 2026-07-28):
//   M-1 single  {P:{initial:'a.work',regions:{a:{idle,work,done*}}}}
//               → getCurrentState() === 'P.a.idle'   (should be 'P.a.work')
//   M-1 multi   initial:'a.work|b.run'
//               → 'P.a.idle|P.b.stop'                (should be 'P.a.work|P.b.run')
//   M-2         REGION_NO_PATH_TO_FINAL absent for a final reachable only from an
//               unreachable island (every `to` is seeded reachable unconditionally)
//   M-3         DEAD_END_STATE falsely raised on 'P.a.x' (composite left via sibling
//               region b); strict promotes it to ERROR → rejects a valid parallel SM
//   M-4         'idle|running' (root mutually-exclusive) NOT flagged UNSATISFIABLE_FROM;
//               'P.a.x|P.a.y' `to` (same region) has NO UNSATISFIABLE_TO code at all

import { describe, expect, it } from 'vitest'
import {
  validateConfig,
  validateConfigStrict,
} from '../config_validator'
import { StateMachine } from '../state_machine'
import type { StateMachineConfig } from '../types'

interface Ctx {
  state: string
}
const owner = (): Ctx => ({ state: '' })

const codesOf = (list: Array<{ code: string; path?: string }>) =>
  list.map((e) => e.code)

// ── M-1 — the engine must HONESTLY resolve the composite `State.initial` ──────
describe('M-1 · engine reads the composite State.initial (not the first region key)', () => {
  it('single-region composite initial "a.work" enters P.a.work — RED: HEAD enters P.a.idle', () => {
    const config = {
      name: 'M1-single',
      initialState: 'P',
      stateAttribute: 'state',
      states: {
        P: {
          // the author pins the region-a entry to `work` via the composite initial
          initial: 'a.work',
          regions: {
            a: { idle: {}, work: {}, done: { final: true } },
          },
        },
      },
      events: {
        startWork: { transitions: [{ from: 'P.a.idle', to: 'P.a.work' }] },
        finish: { transitions: [{ from: 'P.a.work', to: 'P.a.done' }] },
      },
    } as unknown as StateMachineConfig<Ctx>

    const sm = new StateMachine(config, owner())

    // Engine must enter the leaf the composite initial NAMES, not the first key.
    expect(sm.isInState('P.a.work')).toBe(true)
    expect(sm.isInState('P.a.idle')).toBe(false)
    expect(sm.getCurrentState()).toBe('P.a.work')
  })

  it('multi-region composite initial "a.work|b.run" enters both named leaves — RED on HEAD', () => {
    const config = {
      name: 'M1-multi',
      initialState: 'P',
      stateAttribute: 'state',
      states: {
        P: {
          initial: 'a.work|b.run',
          regions: {
            a: { idle: {}, work: {}, done: { final: true } },
            b: { stop: {}, run: {}, fin: { final: true } },
          },
        },
      },
      events: {
        aStart: { transitions: [{ from: 'P.a.idle', to: 'P.a.work' }] },
        aFinish: { transitions: [{ from: 'P.a.work', to: 'P.a.done' }] },
        bStart: { transitions: [{ from: 'P.b.stop', to: 'P.b.run' }] },
        bFinish: { transitions: [{ from: 'P.b.run', to: 'P.b.fin' }] },
      },
    } as unknown as StateMachineConfig<Ctx>

    const sm = new StateMachine(config, owner())

    expect(sm.isInState('P.a.work')).toBe(true)
    expect(sm.isInState('P.b.run')).toBe(true)
    expect(sm.isInState('P.a.idle')).toBe(false)
    expect(sm.isInState('P.b.stop')).toBe(false)
    // order-insensitive: both named entry leaves are active, nothing else
    expect(sm.getCurrentState()?.split('|').sort()).toEqual(
      ['P.a.work', 'P.b.run'].sort(),
    )
  })

  it('validator agrees with the engine: a composite initial naming a region leaf pins it (no REGION_MISSING_INITIAL)', () => {
    const config = {
      name: 'M1-pinned',
      initialState: 'P',
      stateAttribute: 'state',
      states: {
        P: {
          initial: 'a.work',
          regions: {
            a: { idle: {}, work: {}, done: { final: true } },
          },
        },
      },
      events: {
        startWork: { transitions: [{ from: 'P.a.idle', to: 'P.a.work' }] },
        finish: { transitions: [{ from: 'P.a.work', to: 'P.a.done' }] },
      },
    } as unknown as StateMachineConfig<Ctx>

    // The validator already treats 'a.work' as pinning region a (gates
    // REGION_MISSING_INITIAL). After the M-1 fix the engine ACTUALLY enters
    // 'work', so "validator says pinned" and "engine enters work" agree — a
    // single source of truth for region entry. This pin-test guards that the
    // validator does not regress to warning about the very leaf the engine now
    // honours.
    const result = validateConfig(config)
    expect(codesOf(result.warnings)).not.toContain('REGION_MISSING_INITIAL')
  })
})

// ── M-2 — reachability must be a from-gated fixpoint ──────────────────────────
describe('M-2 · REGION_NO_PATH_TO_FINAL for a final reachable only from an unreachable island', () => {
  it('flags a region whose only path to `done` starts at an unreachable `orphan` — RED: missed on HEAD', () => {
    const config = {
      name: 'M2',
      initialState: 'P',
      stateAttribute: 'state',
      states: {
        P: {
          initial: 'a.work',
          regions: {
            // entry is `work`; `orphan` has NO inbound transition (an unreachable
            // island); `done` (final) is reachable ONLY from `orphan`.
            a: { work: {}, orphan: {}, done: { final: true } },
          },
        },
      },
      events: {
        // seeds `to: 'P.a.done'`; on HEAD this alone marks `done` reachable,
        // masking that its only `from` (`orphan`) can never be entered.
        orphanToDone: { transitions: [{ from: 'P.a.orphan', to: 'P.a.done' }] },
      },
    } as unknown as StateMachineConfig<Ctx>

    const result = validateConfig(config)
    expect(codesOf(result.errors)).toContain('REGION_NO_PATH_TO_FINAL')
  })
})

// ── M-3 — DEAD_END must credit sibling-region composite exits ─────────────────
describe('M-3 · a leaf whose composite is left via a sibling region is NOT a dead end', () => {
  const buildParallelWatcher = () =>
    ({
      name: 'M3',
      initialState: 'P',
      stateAttribute: 'state',
      states: {
        P: {
          initial: 'a.x|b.y',
          regions: {
            // region a's leaf `x` has no OWN outgoing transition …
            a: { x: {} },
            // … but the whole composite P is left by a transition FROM region b,
            // which also exits (kills) P.a.x — so P.a.x is NOT a dead end.
            b: { y: {} },
          },
        },
        out: {},
      },
      events: {
        leaveComposite: { transitions: [{ from: 'P.b.y', to: 'out' }] },
      },
    }) as unknown as StateMachineConfig<Ctx>

  it('does NOT raise DEAD_END_STATE on P.a.x — RED: HEAD falsely flags it', () => {
    const result = validateConfig(buildParallelWatcher())
    const deadEndPaths = result.warnings
      .filter((w) => w.code === 'DEAD_END_STATE')
      .map((w) => w.path)
    expect(deadEndPaths).not.toContain('states.P.a.x')
  })

  it('strict mode does not reject the valid parallel machine (no promoted DEAD_END error) — RED on HEAD', () => {
    const result = validateConfigStrict(buildParallelWatcher())
    const deadEndErrors = result.errors.filter(
      (e) => e.code === 'DEAD_END_STATE',
    )
    expect(deadEndErrors).toEqual([])
  })
})

// ── M-4 — mutual-exclusion detection must use LCA breadth, both from and to ───
describe('M-4 · UNSATISFIABLE_FROM breadth + UNSATISFIABLE_TO', () => {
  it('root mutually-exclusive `from: "idle|running"` is UNSATISFIABLE_FROM — RED: missed on HEAD', () => {
    const config = {
      name: 'M4-from-root',
      initialState: 'idle',
      stateAttribute: 'state',
      states: { idle: {}, running: {}, done: {} },
      events: {
        // idle and running are sibling ROOT states — never co-active. Their LCA
        // is the (non-parallel) root, so this `from` can never be enabled.
        bad: { transitions: [{ from: 'idle|running', to: 'done' }] },
      },
    } as unknown as StateMachineConfig<Ctx>

    const result = validateConfig(config)
    expect(codesOf(result.errors)).toContain('UNSATISFIABLE_FROM')
  })

  it('same-region `to: "P.a.x|P.a.y"` is UNSATISFIABLE_TO — RED: code absent on HEAD', () => {
    const config = {
      name: 'M4-to-sameregion',
      initialState: 'P',
      stateAttribute: 'state',
      states: {
        P: {
          initial: 'a.x',
          regions: {
            a: { x: {}, y: {} },
          },
        },
        src: {},
      },
      events: {
        // a region holds one active leaf; runtime collapses this `to` last-wins
        // by regionKey — the author's intent (both x and y) is unsatisfiable.
        bad: { transitions: [{ from: 'src', to: 'P.a.x|P.a.y' }] },
      },
    } as unknown as StateMachineConfig<Ctx>

    const result = validateConfig(config)
    expect(codesOf(result.errors)).toContain('UNSATISFIABLE_TO')
  })
})

// ── M-5 — throw policy is exactly MODEL_ERROR_CODES ({INVALID_STATE_PATH}) ─────
describe('M-5 · a deliberately-supported model error is diagnosed but NOT thrown', () => {
  it('final-only region (D12 all-final) → isValid:false BUT createMachine does NOT throw', () => {
    const config = {
      name: 'D12-allfinal',
      initialState: 'P',
      stateAttribute: 'state',
      states: {
        // Region a's ONLY leaf is final — the region starts final (D12 all-final):
        // a REGION_STARTS_FINAL model error that validateConfig reports, yet the
        // machine still BUILDS (the code is not in MODEL_ERROR_CODES) and raises
        // its done.state join. This pins the throw policy the ~290 comment claims:
        // ONLY INVALID_STATE_PATH is unbuildable; everything else is diagnosed.
        P: { regions: { a: { done: { final: true } } } },
        out: {},
      },
      events: {
        leave: { transitions: [{ from: 'P', to: 'out' }] },
      },
    } as unknown as StateMachineConfig<Ctx>

    const result = validateConfig(config)
    expect(result.isValid).toBe(false)
    expect(codesOf(result.errors)).toContain('REGION_STARTS_FINAL')

    // The deliberately-supported error must NOT make construction throw.
    expect(() => new StateMachine(config, owner())).not.toThrow()
  })

  it('by contrast, an INVALID_STATE_PATH model error DOES make construction throw', () => {
    const config = {
      name: 'broken-path',
      initialState: 'a',
      stateAttribute: 'state',
      states: { a: {}, b: {} },
      events: {
        // `to` names a non-existent state → INVALID_STATE_PATH ∈ MODEL_ERROR_CODES
        // → unbuildable → throw (the ONLY throwing model-error class).
        go: { transitions: [{ from: 'a', to: 'ghost' }] },
      },
    } as unknown as StateMachineConfig<Ctx>

    expect(() => new StateMachine(config, owner())).toThrow()
  })
})
