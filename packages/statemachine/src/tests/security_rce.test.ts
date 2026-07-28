import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StateMachine } from '../state_machine'
import { MemoryAdapter } from '../types'

/**
 * W0 — RCE regression guard (defect П1 of the MASTER §6 registry).
 *
 * Invariant under test (target contract §0.5/§0.6): NO deserialization path
 * turns an attacker-controlled STRING into executable code. A forged config
 * whose guard/action is a string function body must NEVER be compiled and run.
 *
 * The forged guard assembles the identifier "process" from char codes and
 * reaches the real object via `globalThis[name]`, sidestepping any naive
 * `/process\./` blocklist pattern and the `var process = undefined` shadow a
 * legacy `createSafeFunction` sandbox would use. If a legacy `new Function`
 * compile path were live, the payload would run when the guard is evaluated
 * during fireEvent and stamp a marker onto globalThis.
 *
 * The invariant holds by CONSTRUCTION post-W0: there is no compile path at all
 * — deserialization resolves functions by name/slot from a consumer registry
 * and never compiles a body, so the forged guard is never turned into code and
 * the "marker is undefined" assertion holds.
 */

const MARKER = '__w0_rce_marker__'

// Attacker payload as a raw arrow-function STRING. Reads process.platform/pid
// WITHOUT ever writing the literal "process." token or a bare "global." token.
const FORGED_GUARD_BODY =
  '(a) => {' +
  ' var n = String.fromCharCode(112,114,111,99,101,115,115);' + // "process"
  ' var p = globalThis[n];' +
  " globalThis['" +
  MARKER +
  "'] = (p && (p.platform + ':' + p.pid)) || 'ran';" +
  ' return true;' +
  ' }'

type Owner = { state: string; event: () => void }

function forgedPlainConfig() {
  return {
    config: {
      name: 'ForgedSM',
      initialState: 'a',
      stateAttribute: 'state',
      states: {
        a: {},
        b: {},
      },
      events: {
        go: {
          transitions: [{ from: 'a', to: 'b', guard: FORGED_GUARD_BODY }],
        },
      },
    },
    currentState: 'a',
    historyMap: [],
    stateEntryTimes: [],
  }
}

// Weak keyless FNV-1a hash used by the sync legacy path (security.ts).
function fnv1a(str: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

// Keyless SHA-256 used by the async "secure" path (security.ts createSecurityHash).
async function sha256Hex(str: string): Promise<string> {
  const data = new TextEncoder().encode(str)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function forgedSecureConfig() {
  const body = FORGED_GUARD_BODY
  // Omit functionName to slip past the allowlist entirely (security.ts ~339).
  const metadata = { length: body.length, createdAt: 0 }
  const payload = body + JSON.stringify(metadata)
  // Provide the correctly-computed keyless hash so verification passes trivially.
  const hash = await sha256Hex(payload)
  void fnv1a // FNV-1a fallback is equally forgeable; SHA-256 is enough here.
  return {
    config: {
      name: 'ForgedSecureSM',
      initialState: 'a',
      stateAttribute: 'state',
      states: {
        a: {},
        b: {},
      },
      events: {
        go: {
          transitions: [
            {
              from: 'a',
              to: 'b',
              guard: { type: 'function', body, hash, metadata },
            },
          ],
        },
      },
    },
    currentState: 'a',
    historyMap: [],
    stateEntryTimes: [],
  }
}

describe('W0 RCE — string function bodies must not be executed on deserialization', () => {
  beforeEach(() => {
    delete (globalThis as any)[MARKER]
  })
  afterEach(() => {
    delete (globalThis as any)[MARKER]
  })

  it('fromJSON does not execute a forged char-code guard string', async () => {
    const owner = new MemoryAdapter<Owner>({ state: '', event: () => null })
    const json = JSON.stringify(forgedPlainConfig())

    const sm = StateMachine.fromJSON<Owner, any>(json, owner)
    await sm.fireEvent('go').catch(() => {})

    // The attacker-controlled string must never have executed.
    expect((globalThis as any)[MARKER]).toBeUndefined()
  })

  it('fromSecureJSON does not execute a forged (keyless-hashed) guard string', async () => {
    const owner = new MemoryAdapter<Owner>({ state: '', event: () => null })
    const json = JSON.stringify(await forgedSecureConfig())

    const sm = await StateMachine.fromSecureJSON<Owner, any>(json, owner)
    await sm.fireEvent('go').catch(() => {})

    expect((globalThis as any)[MARKER]).toBeUndefined()
  })

  it('B1: a bare-string guard named after a prototype builtin must NOT resolve (no authz bypass)', async () => {
    // Forged config: guard is the RAW STRING 'constructor'. deserializeAction
    // passes bare strings through untouched, so at fireEvent time the guard is
    // resolved by NAME against context/adaptee. `context['constructor']` /
    // `adaptee['constructor']` walk the prototype chain to Object.prototype's
    // `constructor` (itself typeof 'function'), the guard is invoked, returns a
    // truthy value, and the transition a->b is ALLOWED — an authorization bypass
    // straight out of untrusted JSON, with no registry involved.
    //
    // Invariant: a guard name that is NOT an OWN property of context/owner must
    // fail to resolve (guard not satisfied) and the machine must NOT transition.
    const cfg = {
      config: {
        name: 'ForgedProtoGuardSM',
        initialState: 'a',
        stateAttribute: 'state',
        states: { a: {}, b: {} },
        events: {
          go: {
            transitions: [{ from: 'a', to: 'b', guard: 'constructor' }],
          },
        },
      },
      currentState: 'a',
      historyMap: [],
      stateEntryTimes: [],
    }
    const owner = new MemoryAdapter<Owner>({ state: '', event: () => null })
    const sm = StateMachine.fromJSON<Owner, any>(JSON.stringify(cfg), owner)
    await sm.fireEvent('go').catch(() => {})

    // On the vulnerable HEAD the machine has moved to 'b'. It must stay in 'a'.
    expect(sm.currentState).toBe('a')
  })

  it('B1: a {type:"string",name:"toString"} guard must NOT resolve to a prototype builtin', async () => {
    // deserializeAction unwraps { type: 'string', name } to the bare string
    // 'toString'. At fireEvent time `context['toString']` / `adaptee['toString']`
    // resolve via the prototype chain to Object.prototype.toString (typeof
    // 'function'), which returns a truthy string when invoked -> guard satisfied
    // -> transition ALLOWED. Same authorization bypass, string-object branch.
    const cfg = {
      config: {
        name: 'ForgedProtoStringGuardSM',
        initialState: 'a',
        stateAttribute: 'state',
        states: { a: {}, b: {} },
        events: {
          go: {
            transitions: [
              { from: 'a', to: 'b', guard: { type: 'string', name: 'toString' } },
            ],
          },
        },
      },
      currentState: 'a',
      historyMap: [],
      stateEntryTimes: [],
    }
    const owner = new MemoryAdapter<Owner>({ state: '', event: () => null })
    const sm = StateMachine.fromJSON<Owner, any>(JSON.stringify(cfg), owner)
    await sm.fireEvent('go').catch(() => {})

    expect(sm.currentState).toBe('a')
  })

  it('registry lookup is OWN-key only: a prototype name resolves to no function (V6b)', async () => {
    // A serialized function reference named after an Object.prototype member
    // ('constructor'/'toString'/…) must NOT resolve to a builtin via the
    // prototype chain — the unknown-name contract must throw, not silently
    // hand back the Object constructor.
    const cfg = {
      config: {
        name: 'proto',
        stateAttribute: 'state',
        initialState: 'A',
        states: { A: {}, B: {} },
        events: {
          go: {
            transitions: [
              { from: 'A', to: 'B', guard: { type: 'function', name: 'constructor' } },
            ],
          },
        },
      },
      currentState: 'A',
    }
    const owner = new MemoryAdapter<Owner>({ state: '', event: () => null })
    // Empty own-registry: 'constructor' is inherited, not own → must throw.
    expect(() =>
      StateMachine.fromJSON<Owner, any>(JSON.stringify(cfg), owner, { actions: {} }),
    ).toThrow(/not present in the provided function registry/)
  })
})
