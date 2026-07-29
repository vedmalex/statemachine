import { describe, expect, it } from 'vitest'
import { StateMachine } from '../state_machine'
import { MemoryAdapter } from '../types'

/**
 * RED tests for W0.2 C1 — function registry keyed by `fn.name`.
 *
 * The serializer emits a function callback as `{ type: 'function', name }`
 * using ONLY the function's own `.name`. When several callbacks share a name
 * (e.g. three arrow functions each assigned to an `onEnter` property in a
 * states literal all report `.name === 'onEnter'`), they collapse to the same
 * `{ type:'function', name:'onEnter' }` reference. On restore, the consumer
 * registry `{ onEnter: fn }` substitutes ONE function into EVERY slot — a
 * silent behaviour swap with no throw / no warn. The claimed contract
 * "known name → the SAME function" is therefore wrong: the name is a slot
 * LABEL, not a stable identity.
 *
 * Additionally, `serializeState` / `deserializeStates` do NOT recurse into
 * `regions`: nested hierarchical callbacks are spread verbatim (...state) and
 * silently dropped by `JSON.stringify` — never re-resolved from the registry.
 *
 * These tests are written against the CORRECT (fixed) contract:
 *   (a) a round-trip that carries a per-slot key preserves DISTINCT behaviour;
 *   (b) a nested-region callback is restored from the registry OR the restore
 *       throws — but it is NEVER silently lost.
 *
 * On HEAD (73feaa6) both reddens on the marked assertion. The consumer
 * registries below intentionally carry BOTH a bare-name fallback (so HEAD
 * resolves rather than throws — exposing the SILENT collision) AND the
 * composite slot-path keys the fix is expected to prefer.
 */
describe('W0.2 C1 — registry slot collision + nested-region callback loss', () => {
  it('(a) round-trip preserves DISTINCT per-slot onEnter behaviour (HEAD: name collision swaps one fn into every slot)', async () => {
    const calls: string[] = []

    const states = {
      idle: {},
      green: { onEnter: () => { calls.push('G') } },
      red: { onEnter: () => { calls.push('R') } },
    } as any

    // Both distinct callbacks report the SAME inferred name — this is the
    // slot-label collision the registry keys on.
    expect(states.green.onEnter.name).toBe('onEnter')
    expect(states.red.onEnter.name).toBe('onEnter')

    const events = {
      toGreen: { transitions: [{ from: 'idle', to: 'green' }] },
      toRed: { transitions: [{ from: 'green', to: 'red' }] },
    } as any

    const config = {
      name: 'TrafficLight',
      initialState: 'idle',
      stateAttribute: 'state',
      states,
      events,
    } as any

    const source = new StateMachine(
      config,
      new MemoryAdapter<any>({ state: '', event: () => null }),
    )

    // Serialize from the initial (idle) state.
    const serialized = source.toJSON()

    // Baseline: the SOURCE machine produces DISTINCT markers per state.
    calls.length = 0
    await source.fireEvent('toGreen')
    await source.fireEvent('toRed')
    expect(calls).toEqual(['G', 'R'])

    // Consumer registry: a bare-name fallback (what HEAD resolves) PLUS the
    // composite slot-path keys the fix is expected to prefer.
    const registry: Record<string, any> = {
      onEnter: states.green.onEnter, // name fallback → HEAD binds this to BOTH slots
      'states.green.onEnter': states.green.onEnter,
      'states.red.onEnter': states.red.onEnter,
      'green.onEnter': states.green.onEnter,
      'red.onEnter': states.red.onEnter,
    }

    const restored = StateMachine.fromJSON<any, any>(
      serialized,
      new MemoryAdapter<any>({ state: '', event: () => null }),
      { actions: registry },
    )

    calls.length = 0
    await restored.fireEvent('toGreen')
    await restored.fireEvent('toRed')

    // EXPECTED (fixed contract): the round-trip preserves per-slot behaviour.
    // HEAD: both slots resolve to the single 'onEnter' registry entry, so the
    // restored machine records ['G','G'] — the red slot's behaviour is lost.
    expect(calls).toEqual(['G', 'R'])
  })

  it('(b) nested-region onEnter keeps its OWN behaviour across round-trip and is not swapped for a same-named sibling (HEAD: name collision serves the sibling fn into the nested slot)', async () => {
    // The engine pre-flattens region leaves into dotted top-level states
    // ('parent.r1.child'), so the nested onEnter DOES round-trip — but only as a
    // `{ type:'function', name:'onEnter' }` NAME reference, exactly like every
    // other 'onEnter' slot. A hierarchical machine that also owns a same-named
    // top-level 'onEnter' therefore collides in the registry: the nested slot
    // cannot be told apart from its sibling, and the name-keyed registry serves
    // ONE function into both. The nested callback is not "lost" so much as
    // silently OVERWRITTEN by whichever function the bare name resolves to.
    const calls: string[] = []

    const states = {
      idle: {},
      sibling: { onEnter: () => { calls.push('S') } }, // top-level, name 'onEnter'
      parent: {
        display: 'Parent',
        initial: 'r1.child',
        regions: {
          r1: {
            child: { onEnter: () => { calls.push('N') } }, // nested, name 'onEnter'
            other: { display: 'Other' },
          },
        },
      },
    } as any

    // Both the sibling and the nested leaf report the SAME inferred name.
    expect(states.sibling.onEnter.name).toBe('onEnter')
    expect(states.parent.regions.r1.child.onEnter.name).toBe('onEnter')
    const siblingFn = states.sibling.onEnter
    const nestedFn = states.parent.regions.r1.child.onEnter

    const events = {
      toSibling: { transitions: [{ from: 'idle', to: 'sibling' }] },
      toParent: { transitions: [{ from: 'idle', to: 'parent' }] },
    } as any

    const config = {
      name: 'HierNested',
      initialState: 'idle',
      stateAttribute: 'state',
      states,
      events,
    } as any

    // Baseline: the SOURCE machine fires DISTINCT markers — 'S' for the sibling,
    // 'N' for the nested region leaf.
    const baselineSibling = new StateMachine(
      config,
      new MemoryAdapter<any>({ state: '', event: () => null }),
    )
    calls.length = 0
    await baselineSibling.fireEvent('toSibling')
    expect(calls).toEqual(['S'])

    const baselineParent = new StateMachine(
      config,
      new MemoryAdapter<any>({ state: '', event: () => null }),
    )
    calls.length = 0
    await baselineParent.fireEvent('toParent')
    expect(calls).toEqual(['N']) // nested onEnter genuinely fires pre-serialization

    // Serialize a fresh source at the initial (idle) state.
    const source = new StateMachine(
      config,
      new MemoryAdapter<any>({ state: '', event: () => null }),
    )
    const serialized = source.toJSON()

    // Consumer registry: a bare-name fallback (necessarily ONE of the two
    // colliding callbacks — here the sibling) PLUS the composite slot-path keys
    // the fix is expected to prefer. The flattened leaf key is 'parent.r1.child'.
    const registry: Record<string, any> = {
      onEnter: siblingFn, // name fallback → HEAD serves the SIBLING into the nested slot
      'states.sibling.onEnter': siblingFn,
      'sibling.onEnter': siblingFn,
      'states.parent.r1.child.onEnter': nestedFn,
      'parent.r1.child.onEnter': nestedFn,
      'parent.regions.r1.child.onEnter': nestedFn,
      'r1.child.onEnter': nestedFn,
      'child.onEnter': nestedFn,
    }

    const restored = StateMachine.fromJSON<any, any>(
      serialized,
      new MemoryAdapter<any>({ state: '', event: () => null }),
      { actions: registry },
    )

    calls.length = 0
    await restored.fireEvent('toParent')

    // EXPECTED (fixed contract): the nested region leaf keeps ITS OWN behaviour.
    // HEAD: the nested slot's 'onEnter' reference resolves by bare name to the
    // sibling function, so the restored machine records ['S'] — the nested
    // callback is silently swapped for its same-named sibling.
    expect(calls).toEqual(['N'])
  })
})
