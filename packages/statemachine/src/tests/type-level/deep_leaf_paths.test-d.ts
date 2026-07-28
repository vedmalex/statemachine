// Type-level RED test for H-1 (HIGH) — StatePaths contradicts the runtime at
// nesting depth >= 4 (composite-inside-a-region).
//
// THE DEFECT (reproduced on HEAD):
//   `DeepNestedStateName<S>` (types.ts) has exactly ONE 4-segment branch, and
//   its LAST segment is `keyof CR` — the REGION NAMES of the nested composite,
//   i.e. it mints REGION-CONTAINER paths `parent.region.child.subregion`. So:
//     (a) a genuinely valid deep LEAF `p.r.child.sub.leaf` (5 segments, last
//         segment = an atomic state) is NOT in `StatePaths<S>` → `createMachine`
//         rejects it with TS2820, even though the runtime enters it happily
//         (probe: getCurrentState() === 'p.r.child.sub.leaf').
//     (b) the region-container path `p.r.child.sub` IS in `StatePaths<S>` and
//         type-checks — yet the runtime THROWS INVALID_STATE_PATH on it
//         ("refers to a region container, not an addressable state").
//   The type surface accepts exactly the paths that throw and rejects exactly
//   the paths that run — an inverted contract.
//
// POST-FIX CONTRACT this file guards (what GREEN must mean):
//   - valid deep leaves at depth 2/3/4/5 authored through the inference form
//     `createMachine(config, owner)` type-check with NO directive (controls);
//   - a region-container path is a COMPILE ERROR (@ts-expect-error);
//   - a typo leaf is a COMPILE ERROR (@ts-expect-error);
//   - wildcard `from` is still accepted (no re-narrowing — W2c guard).
//
// Executed by `tsc -p tsconfig.typecheck.json` (this *.test-d.ts is included;
// *.test.ts is excluded). On HEAD tsc FAILS: TS2820 on the deep-leaf controls
// and TS2578 on the region-container directive (unused because the bad path is
// wrongly accepted). Both flip GREEN once StatePaths recurses to the LEAF.

import { createMachine } from '../../index'

interface Ctx {
  state: string
}
const owner: Ctx = { state: '' }

// A machine whose deepest region-nesting is a composite INSIDE a region:
//   p            (composite)
//   └ r          (region)
//     └ child    (composite)   → 'p.r.child'          NestedStateName (3 seg)
//       └ sub    (region)
//         ├ leaf (atomic)      → 'p.r.child.sub.leaf' 5-seg LEAF (must be valid)
//         └ done (final)       → 'p.r.child.sub.done' 5-seg LEAF (must be valid)
//
// depth-2 leaf 'p.r.mid'  and depth-3 leaf 'p.r.child' are also exercised below.

// --- control: 5-segment deep LEAF must type-check (NO directive) --------------
// On HEAD this is TS2820 (path absent from StatePaths) → RED. Post-fix: GREEN.
createMachine(
  {
    name: 'deep',
    stateAttribute: 'state',
    initialState: 'p',
    states: {
      p: {
        initial: 'r.child',
        regions: {
          r: {
            child: {
              initial: 'sub.leaf',
              regions: {
                sub: { leaf: {}, done: { final: true } },
              },
            },
          },
        },
      },
    },
    events: {
      finishLeaf: {
        transitions: [{ from: 'p.r.child.sub.leaf', to: 'p.r.child.sub.done' }],
      },
    },
  },
  owner,
)

// --- controls: leaves at depth 2 and 3 must type-check (NO directive) ---------
// 'q.reg.mid' (3 seg, NestedStateName) and 'q.reg.deep.inner.tip' (5 seg LEAF).
createMachine(
  {
    name: 'depth-mix',
    stateAttribute: 'state',
    initialState: 'q',
    states: {
      q: {
        initial: 'reg.mid',
        regions: {
          reg: {
            mid: {},
            deep: {
              initial: 'inner.tip',
              regions: {
                inner: { tip: {}, fin: { final: true } },
              },
            },
          },
        },
      },
    },
    events: {
      // mixes a 3-seg leaf `from` with a 5-seg leaf `to` — both must be valid.
      dive: { transitions: [{ from: 'q.reg.mid', to: 'q.reg.deep.inner.tip' }] },
    },
  },
  owner,
)

// --- @ts-expect-error: a REGION-CONTAINER path must be REJECTED ---------------
// 'p.r.child.sub' names a region container; the runtime THROWS
// INVALID_STATE_PATH on it. On HEAD it is wrongly ACCEPTED, so the directive is
// UNUSED → TS2578 → RED. Post-fix the path is rejected → directive USED → GREEN.
createMachine(
  {
    name: 'region-container-reject',
    stateAttribute: 'state',
    initialState: 'p',
    states: {
      p: {
        initial: 'r.child',
        regions: {
          r: {
            child: {
              initial: 'sub.leaf',
              regions: {
                sub: { leaf: {}, done: { final: true } },
              },
            },
          },
        },
      },
    },
    events: {
      // `from` is the shallow, always-valid root 'p' so the directive tests ONLY
      // the `to` region-container rejection (a deep-leaf `from` would itself error
      // on HEAD and wrongly consume the directive, masking the assertion).
      bad: {
        transitions: [
          // @ts-expect-error a region-container path is not an addressable state
          { from: 'p', to: 'p.r.child.sub' },
        ],
      },
    },
  },
  owner,
)

// --- @ts-expect-error: a typo deep leaf must be REJECTED ----------------------
// 'p.r.child.sub.leff' is a typo; must never be a valid path. (Green on HEAD and
// post-fix — pins that the leaf recursion does not over-accept ANY 5-seg string.)
createMachine(
  {
    name: 'deep-typo-reject',
    stateAttribute: 'state',
    initialState: 'p',
    states: {
      p: {
        initial: 'r.child',
        regions: {
          r: {
            child: {
              initial: 'sub.leaf',
              regions: {
                sub: { leaf: {}, done: { final: true } },
              },
            },
          },
        },
      },
    },
    events: {
      // shallow always-valid `from` (see region-container-reject note above).
      typo: {
        transitions: [
          // @ts-expect-error typo in a deep-leaf path must be rejected
          { from: 'p', to: 'p.r.child.sub.leff' },
        ],
      },
    },
  },
  owner,
)

// --- control: wildcard `from` must still type-check (W2c re-narrowing guard) --
createMachine(
  {
    name: 'deep-wildcard-control',
    stateAttribute: 'state',
    initialState: 'p',
    states: {
      p: {
        initial: 'r.child',
        regions: {
          r: {
            child: {
              initial: 'sub.leaf',
              regions: {
                sub: { leaf: {}, done: { final: true } },
              },
            },
          },
        },
      },
    },
    events: {
      anyWild: { transitions: [{ from: '*', to: 'p' }] },
      preWild: { transitions: [{ from: 'p.r.child.sub.*', to: 'p' }] },
    },
  },
  owner,
)

// --- control (documentation): the EXPLICIT single-type-arg form ---------------
// `createMachine<Ctx>()` fixes the second `const S` param to its widened default
// `States<T>`, so path checking is FORGONE — a typo compiles here. This is the
// documented trade-off of the explicit form (paths.test-d.ts covers the
// inference form that DOES check). No directive: it MUST compile (widened).
createMachine<Ctx>(
  {
    name: 'explicit-arg-no-pathcheck',
    stateAttribute: 'state',
    initialState: 'p',
    states: {
      p: {
        initial: 'r.child',
        regions: {
          r: {
            child: {
              initial: 'sub.leaf',
              regions: {
                sub: { leaf: {}, done: { final: true } },
              },
            },
          },
        },
      },
    },
    events: {
      // a typo that WOULD be caught in the inference form is silently widened here
      loose: { transitions: [{ from: 'p.r.child.sub.leaf', to: 'totally.bogus' }] },
    },
  },
)
