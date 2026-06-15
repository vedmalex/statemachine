---
title: Entry/exit ordering (SCXML)
type: concept
sources: [regions-and-parallel, hierarchical.test]
sources_consulted: [raw/regions-and-parallel.md, raw/hierarchical.test.ts]
updated: 2026-06-15
---

# Entry/exit ordering (SCXML)

Entering and leaving a composite follow SCXML/UML ordering, uniformly across `setInitialState`,
`reset`, and every transition.

- **Entry is ancestor-first** (outer → inner): the composite parent's `onEnter` fires *before* its
  region children's `onEnter`. For nested composites every ancestor fires top-down.
- **Exit is descendant-first** (inner → outer): region children's `onExit` fire *before* the
  parent's `onExit`.
- A state that remains in the active configuration is **not** re-entered or exited. Re-entering an
  overlapping composite does not re-fire a still-active ancestor's `onEnter` nor re-arm its
  `invoke` timers, and a surviving sibling region keeps its timers.

```ts
// ancestor-first entry (parent before each region child)
expect(log.indexOf('parent')).toBeLessThan(log.indexOf('parent.r1.c1'))
// descendant-first exit (mirror): region children exit before parent
```

## Implementation note

The active set is computed once (immutable `newState` + enter/exit leaf-diff sets) before exit
actions run, so a `validateCompositeState` rejection aborts the transition cleanly with no partially
entered/exited configuration.

## Related

- [[regions-and-parallel]] — declaring regions and expansion
- [[all-final-join]] — completion semantics

Source: `raw/regions-and-parallel.md`, `raw/hierarchical.test.ts` (ancestor-first entry /
descendant-first exit tests).
