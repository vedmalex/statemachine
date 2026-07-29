// Type-level test for V8 (HIGH) — StatePaths reachability through the PUBLIC
// factory `createMachine`.
//
// CONTRACT (the criterion this file guards):
//   A typo in `initialState`, `from`, or `to` authored through `createMachine`
//   MUST be a COMPILE ERROR. The path-checking apparatus
//   (StatePaths/NestedStateName/DeepNestedStateName) is exported and catches a
//   typo on a LITERAL type, but for it to be reachable the factory must infer
//   the literal `states` keys. `createMachine` does that with a `const S`
//   type parameter inferred from `config.states`; `TypedMachineConfig<T, S>`
//   then checks `initialState`/`from`/`to` against `StatePaths<S>`.
//
// CALL FORM: the factory is exercised in its INFERENCE form
// `createMachine(config, owner)` — the exact form the README examples use.
// TypeScript cannot partially infer type arguments: passing a single explicit
// argument (`createMachine<Ctx>(...)`) would fix the second `const S` param to
// its widened default `States<T>` and forgo the path checking. The context `T`
// is pinned here by annotating `owner: Ctx`, which is inferred into `T`.
//
// This is a TYPE test, executed by `tsc` via `tsconfig.typecheck.json`. Each
// `@ts-expect-error` asserts the line below it is a type ERROR. When the typos
// are correctly rejected the directives are USED (GREEN); a type regression
// that lets a typo through leaves a directive UNUSED and tsc reports TS2578,
// FAILING the typegate.

import { createMachine } from '../../index'

interface Ctx {
  status: string
}

const owner: Ctx = { status: '' }

// --- initialState typo -------------------------------------------------------
// 'closd' is not a declared state key ('closed' | 'open'). MUST be an error.
createMachine(
  {
    name: 'door',
    stateAttribute: 'status',
    // @ts-expect-error typo in initialState must be rejected (not a state key)
    initialState: 'closd',
    states: { closed: {}, open: {} },
    events: { open: { transitions: [{ from: 'closed', to: 'open' }] } },
  },
  owner,
)

// --- from typo ---------------------------------------------------------------
createMachine(
  {
    name: 'door',
    stateAttribute: 'status',
    initialState: 'closed',
    states: { closed: {}, open: {} },
    events: {
      open: {
        transitions: [
          // @ts-expect-error typo in transition `from` must be rejected
          { from: 'clsed', to: 'open' },
        ],
      },
    },
  },
  owner,
)

// --- to typo -----------------------------------------------------------------
createMachine(
  {
    name: 'door',
    stateAttribute: 'status',
    initialState: 'closed',
    states: { closed: {}, open: {} },
    events: {
      open: {
        transitions: [
          // @ts-expect-error typo in transition `to` must be rejected
          { from: 'closed', to: 'opn' },
        ],
      },
    },
  },
  owner,
)

// --- control: a CORRECT path must still type-check (no directive) ------------
createMachine(
  {
    name: 'door',
    stateAttribute: 'status',
    initialState: 'closed',
    states: { closed: {}, open: {} },
    events: { open: { transitions: [{ from: 'closed', to: 'open' }] } },
  },
  owner,
)

// --- control: dotted region paths through nested states must type-check ------
createMachine(
  {
    name: 'proc',
    stateAttribute: 'status',
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
  owner,
)

// W2c residual: wildcard `from` ('*', 'prefix.*') and `to: '*'` are documented,
// validator-supported (V2) paths and must NOT be false type errors (control —
// no @ts-expect-error). Guards against re-narrowing StatePaths<S> to exclude
// wildcards after the V8 literal-key inference.
const wildOwner = { state: 'a' }
createMachine(
  {
    name: 'wildcard-control',
    stateAttribute: 'state',
    initialState: 'a',
    states: { a: {}, b: {} },
    events: {
      any: { transitions: [{ from: '*', to: 'b' }] },
      pre: { transitions: [{ from: 'a.*', to: 'b' }] },
      selfWild: { transitions: [{ from: 'a', to: '*' }] },
    },
  },
  wildOwner,
)
