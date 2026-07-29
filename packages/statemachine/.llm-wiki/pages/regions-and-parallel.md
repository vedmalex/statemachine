---
title: Regions & parallel states
type: concept
sources: [regions-and-parallel, README, hierarchical.test]
sources_consulted: [raw/regions-and-parallel.md, raw/README.md, raw/hierarchical.test.ts]
updated: 2026-06-15
---

# Regions & parallel states

A state in `@vedmalex/statemachine` becomes **composite** when it declares a `regions` map.
Each region is an independent sub-machine; all regions are active simultaneously while the
composite is active. Region leaves are addressed by dotted path `parent.<region>.<state>`.

```ts
parent: {
  initial: 'r1.c1|r2.c1',          // initial active leaf of each region, '|'-joined
  regions: {
    r1: { c1: {} },
    r2: { c1: {} },
  },
}
```

## Expansion is uniform across every entry path

Entering a composite expands to the parallel configuration of its region initials, whether the
composite is reached as the machine's `initialState`, via a dotted-path transition, or via a
**bare-root** transition (`to: 'parent'`). All three produce the same active state, e.g.
`parent.r1.c1|parent.r2.c1`.

- The `|`-joined parts are rendered in **document order** (the normalized model's `documentIndex`),
  not insertion order — but prefer asserting via `isInState(...)` or by sorting parts rather than
  against a hard-coded composite string, so a config edit does not break the assertion.
- `isInState(id)` is ancestor-aware: `isInState('parent')` and `isInState('parent.r1')` are both
  true while expanded.
- When a region omits `initial`, its first declared sub-state (document order) is the initial state;
  the validator emits a non-fatal `REGION_MISSING_INITIAL` advisory.

## Related

- [[entry-exit-ordering]] — SCXML §3.13: entry = document order, exit = reverse document order
  (layering and reverse sibling order on exit are consequences of that single rule)
- [[all-final-join]] — leaving a composite: parallel-exit vs `done.state` join

Source: `raw/regions-and-parallel.md`, `raw/README.md`, `raw/hierarchical.test.ts`.
