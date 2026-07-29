---
title: Entry/exit ordering (SCXML §3.13)
type: concept
sources: [regions-and-parallel, hierarchical.test, selection_conformance.test]
sources_consulted: [raw/regions-and-parallel.md, raw/hierarchical.test.ts]
updated: 2026-07-29
---

# Entry/exit ordering (SCXML §3.13)

Entering and leaving a composite follow W3C SCXML §3.13 ordering, uniformly across
`setInitialState`, `reset`, and every transition. **One rule generates everything else:**

- **Entry = document order** — the states to enter are ordered by their `documentIndex` in the
  normalized model (a DFS pre-order walk of the config), ascending.
- **Exit = reverse document order** — the same list, descending.

Consequences (these are *derived*, not separate rules):

- **Layering**: an ancestor enters before its descendants; on exit, descendants leave before the
  ancestor. (A parent's `documentIndex` is always lower than any of its children's.)
- **Siblings across parallel regions**: on entry, regions run in declaration order (`r1`, `r2`,
  `r3`); on **exit they run in REVERSE** (`r3`, `r2`, `r1`). This gives the LIFO property — the
  region that acquired a paired resource first releases it last.
- **Nested regions are walked CONTIGUOUSLY**: a region is entered in full (its own leaf, then that
  leaf's descendants) before the next region starts. A sibling's leaf never interleaves between an
  ancestor and its descendant.
- `exited.reverse()` is exactly `entered` — one flat document-order list, mirrored.
- A state that remains in the active configuration is **not** re-entered or exited. Re-entering an
  overlapping composite does not re-fire a still-active ancestor's `onEnter` nor re-arm its
  `invoke` timers, and a surviving sibling region keeps its timers.

```ts
// entry: document order (ancestor first, then each region in declaration order)
// wrap, wrap.r1.a, wrap.r1.a.s.deep, wrap.r2.x        ← region r1 walked in full first
// exit: the exact reverse
// wrap.r2.x, wrap.r1.a.s.deep, wrap.r1.a, wrap
```

> **BREAKING (1.0.0-beta.x, unit W8/V11).** Before this change the engine sorted by *depth*, which
> produced (a) FORWARD sibling order on exit and (b) a depth-major interleave that split a region's
> ancestor from its descendant. Both diverged from W3C §3.13 and were fixed. The layer invariant and
> the SET of invoked callbacks are unchanged — only their order.

## Observing the order

The order is observable from outside via the `IMonitor.recordLifecycle` channel (each callback emits
a `begin`/`end` pair carrying `state`, `owner`, `microstep`, `seq`), or through the ready-made
`createLifecycleTracer()` debugging instrument — see [[../../docs/lifecycle-tracing.md]].

## Implementation note

The active set is computed once (immutable `newState` + enter/exit leaf-diff sets) before exit
actions run, so a `validateCompositeState` rejection aborts the transition cleanly with no partially
entered/exited configuration.

## Related

- [[regions-and-parallel]] — declaring regions and expansion
- [[all-final-join]] — completion semantics

Source: `raw/regions-and-parallel.md`, `raw/hierarchical.test.ts` (ancestor-first entry /
descendant-first exit tests).
