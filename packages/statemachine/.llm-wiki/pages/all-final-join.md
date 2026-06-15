---
title: Leaving a composite — parallel-exit vs all-final join
type: concept
sources: [regions-and-parallel, hierarchical.test]
sources_consulted: [raw/regions-and-parallel.md, raw/hierarchical.test.ts]
updated: 2026-06-15
---

# Leaving a composite — parallel-exit vs all-final join

There are two distinct, unambiguous ways out of a composite, disambiguated by **trigger**.

## Parallel-exit (preemption)

A plain transition whose `from` is the composite (or an ancestor of an active leaf), fired by a
**user event**, preempts and exits all active regions immediately (least-common-compound-ancestor
matching):

```ts
events: { abort: { transitions: [{ from: 'proc', to: 'cancelled' }] } }
```

`from: 'proc'` is eligible whenever *any* region under `proc` is active.

## All-final join (`done.state`)

Mark a region's terminal leaf with `final: true`. When **every** region of a composite has reached
a final state, the engine raises the UML completion event `done.state.<compositeId>`. A join is a
transition on that event:

```ts
states: {
  proc: {
    initial: 'a.run|b.run',
    regions: {
      a: { run: {}, done: { final: true } },
      b: { run: {}, done: { final: true } },
    },
  },
  complete: {},
}
events: {
  finishA: { transitions: [{ from: 'proc.a.run', to: 'proc.a.done' }] },
  finishB: { transitions: [{ from: 'proc.b.run', to: 'proc.b.done' }] },
  'done.state.proc': { transitions: [{ from: 'proc', to: 'complete' }] },  // the join
}
```

```ts
await sm.fireEvent('finishA')
sm.isDone('proc')                            // false — only region a is final
await sm.fireEvent('finishB')
sm.isDone('proc')                            // true — all regions final (config reached)
await new Promise((r) => setTimeout(r, 0))   // let the internal done.state.proc drain
sm.getCurrentState()                         // 'complete'
```

Key semantics:

- `done.state.<C>` is raised **only** when that event is declared in config — an undeclared
  completion event is never enqueued (no "Invalid event" error).
- `done.state.*` is engine-internal and **excluded** from `from: '*'` wildcard matching.
- Completion is raised on the **internal** queue (innermost composite first for nested cases), so a
  join is processed before subsequent external events. Coexistence with a `from: 'C'` parallel-exit
  on the same composite is deterministic: the user event preempts while non-final; `done.state.C`
  fires only at all-final.
- `isDone(compositeId)` is a public guard predicate, true exactly while the all-final configuration
  is active.

## Validation

`FINAL_STATE_HAS_OUTGOING` (error), `FINAL_ON_COMPOSITE` (warning), `REGION_NO_REACHABLE_FINAL`
(warning), `DONE_VS_PARALLEL_EXIT_AMBIGUITY` (warning).

## Related

- [[regions-and-parallel]] — declaring regions
- [[entry-exit-ordering]] — entry/exit firing order

Source: `raw/regions-and-parallel.md`, `raw/hierarchical.test.ts` (all-final join positive/negative,
isDone guard, coexistence tests).
