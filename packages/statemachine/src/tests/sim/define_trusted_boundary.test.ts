import { describe, expect, it } from 'vitest'
import { MemoryAdapter } from '../../index'
import { StateMachine } from '../../state_machine'
import { toEngineConfig } from '../../sim/define'
import type { TopologySpec } from '../../sim/scenario'

/**
 * W7 U2 (#26 RCE B4 — учёт/закалка) — the trusted/untrusted boundary contract
 * for `sim/define.ts` `recreateLiteral`.
 *
 * This is NOT a sandbox test: `recreateLiteral` still compiles a trusted
 * `source` string via `new Function` (see `define.ts` module doc). What this
 * file fixes as a regression contract:
 *
 *  (a) the TRUSTED `define`/`toEngineConfig` path still compiles and runs a
 *      well-formed closure-free literal callback (no false-positive from the
 *      new guard);
 *  (b) the new fail-fast RUNTIME GUARD in `recreateLiteral` throws BEFORE
 *      `new Function` on an empty/non-string/non-function-shaped `source`
 *      (hygiene, not a sandbox — see define.ts);
 *  (c) the UNTRUSTED `StateMachine.fromJSON` path does NOT compile any
 *      `source`-carrying payload at all — `deserializeAction`
 *      (`state_machine.ts`) resolves callbacks by NAME/slot from a
 *      caller-supplied `FunctionRegistry` and never even reads a `source`
 *      field, so a forged `source` smuggled into JSON is inert.
 */

type Owner = { state: string; k: number }

function minimalTopology(onEnterSource: string): TopologySpec {
  return {
    name: 'GuardBoundaryTest',
    stateAttribute: 'state',
    initialState: 'a',
    states: {
      a: {
        onEnter: { source: onEnterSource, fn: () => undefined },
      },
      b: {},
    },
    events: {
      go: { transitions: [{ from: 'a', to: 'b' }] },
    },
    ownerSeed: { k: 0 },
  }
}

describe('sim/define recreateLiteral — trusted-compile / untrusted-boundary contract', () => {
  it('(a) trusted define/toEngineConfig compiles a valid closure-free literal and it runs (round-trip)', () => {
    const topology = minimalTopology('(o)=>{ o.k = (o.k ?? 0) + 1; return o.k; }')
    const config = toEngineConfig<Owner>(topology)
    const onEnter = (config.states as any).a.onEnter as (o: Owner) => unknown

    expect(typeof onEnter).toBe('function')
    const owner: Owner = { state: 'a', k: 0 }
    const result = onEnter(owner)
    expect(owner.k).toBe(1)
    expect(result).toBe(1)
  })

  it('(b) recreateLiteral guard throws on an empty source BEFORE reaching new Function', () => {
    const topology = minimalTopology('')
    expect(() => toEngineConfig<Owner>(topology)).toThrow(
      /recreateLiteral: refusing to compile a non-function \/ empty source/,
    )
  })

  it('(b) recreateLiteral guard throws on a non-function-shaped source', () => {
    const topology = minimalTopology('this is definitely not a function literal')
    expect(() => toEngineConfig<Owner>(topology)).toThrow(
      /recreateLiteral: refusing to compile a non-function \/ empty source/,
    )
  })

  it('(b) recreateLiteral guard throws on a whitespace-only source', () => {
    const topology = minimalTopology('   \n\t  ')
    expect(() => toEngineConfig<Owner>(topology)).toThrow(
      /recreateLiteral: refusing to compile a non-function \/ empty source/,
    )
  })

  it('(b) recreateLiteral guard throws on a non-string source (runtime-shape violation)', () => {
    // A TopologySpec that arrives from an untyped boundary (e.g. hand-rolled
    // JSON) could carry a non-string `source` despite the TS type; the guard
    // must fail closed instead of handing a non-string to `new Function`.
    const topology = minimalTopology(undefined as unknown as string)
    expect(() => toEngineConfig<Owner>(topology)).toThrow(
      /recreateLiteral: refusing to compile a non-function \/ empty source/,
    )
  })

  it('(c) the UNTRUSTED fromJSON path does not compile a source-carrying payload at all', async () => {
    const MARKER = '__w7_u2_boundary_marker__'
    delete (globalThis as any)[MARKER]

    // A forged action reference that smuggles a `source` field (mimicking the
    // sim LiteralCallback shape) alongside a `type:'function'` reference the
    // untrusted fromJSON contract actually understands. If `source` were ever
    // compiled, invoking the resolved guard would stamp the marker.
    const FORGED_SOURCE = `(a) => { globalThis['${MARKER}'] = 'compiled'; return true; }`

    const forgedConfig = {
      config: {
        name: 'ForgedBoundarySM',
        initialState: 'a',
        stateAttribute: 'state',
        states: { a: {}, b: {} },
        events: {
          go: {
            transitions: [
              {
                from: 'a',
                to: 'b',
                // type/name is the ONLY shape deserializeAction understands;
                // `source` is a foreign field it never reads.
                guard: { type: 'function', name: 'evil', source: FORGED_SOURCE },
              },
            ],
          },
        },
      },
      currentState: 'a',
      historyMap: [],
      stateEntryTimes: [],
    }

    // A harmless, genuinely-trusted registry entry under the SAME name so the
    // name-resolution half of the contract still runs (proving resolution is
    // by-name-from-registry, never by-compiling-a-source-field).
    const registry = { evil: (_owner: unknown) => true }

    const owner = new MemoryAdapter<Owner>({ state: '', k: 0 } as unknown as Owner)
    const sm = StateMachine.fromJSON<Owner, any>(JSON.stringify(forgedConfig), owner, {
      actions: registry,
    })
    await sm.fireEvent('go').catch(() => {
      // no-op: this test only cares whether the forged source ever compiled
    })

    // The forged `source` string must NEVER have been compiled/executed.
    expect((globalThis as any)[MARKER]).toBeUndefined()
    delete (globalThis as any)[MARKER]
  })

  it('(c) an unresolvable-by-name untrusted guard throws instead of falling back to compiling its source', () => {
    const MARKER = '__w7_u2_boundary_marker_2__'
    delete (globalThis as any)[MARKER]
    const FORGED_SOURCE = `(a) => { globalThis['${MARKER}'] = 'compiled'; return true; }`

    const forgedConfig = {
      config: {
        name: 'ForgedBoundarySM2',
        stateAttribute: 'state',
        initialState: 'a',
        states: { a: {}, b: {} },
        events: {
          go: {
            transitions: [
              { from: 'a', to: 'b', guard: { type: 'function', name: 'evil', source: FORGED_SOURCE } },
            ],
          },
        },
      },
      currentState: 'a',
    }
    const owner = new MemoryAdapter<Owner>({ state: '', k: 0 } as unknown as Owner)

    // Empty registry: 'evil' has no own entry -> must throw, never fall back
    // to compiling the smuggled `source`.
    expect(() =>
      StateMachine.fromJSON<Owner, any>(JSON.stringify(forgedConfig), owner, { actions: {} }),
    ).toThrow(/not present in the provided function registry/)

    expect((globalThis as any)[MARKER]).toBeUndefined()
    delete (globalThis as any)[MARKER]
  })
})
