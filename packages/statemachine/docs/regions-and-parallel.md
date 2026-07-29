# Hierarchical regions, parallel states & join

`@vedmalex/statemachine` supports orthogonal (parallel) regions with SCXML/UML-conformant
entry/exit semantics and UML completion (`done.state`) joins. This page documents the model,
the firing order, the two ways to leave a composite, and the validation rules.

The behaviour described here is exercised by `src/tests/hierarchical.test.ts`,
`src/tests/coverage_boost.test.ts`, and `src/tests/config_validator.test.ts`; every example
below mirrors a passing test.

## 1. Declaring regions

A state with a `regions` map is **composite**: each region is an independent sub-machine, and
all regions are active simultaneously while the composite is active. Region leaves are addressed
by their dotted path `parent.<region>.<state>`.

```ts
const states = {
  idle: {},
  parent: {
    initial: 'r1.c1|r2.c1',          // initial active leaf of each region, '|'-joined
    onEnter: () => log.push('parent'),
    regions: {
      r1: { c1: { onEnter: () => log.push('parent.r1.c1') } },
      r2: { c1: { onEnter: () => log.push('parent.r2.c1') } },
    },
  },
} satisfies States<any>
```

When `initial` is omitted for a region, the **first declared sub-state** (document order) is its
initial state — matching SCXML's default-initial rule. The validator emits an advisory
`REGION_MISSING_INITIAL` warning (non-fatal) when a region relies on this fallback, because the
choice then becomes load-bearing.

## 2. Expansion: every entry path behaves the same

Entering a composite always expands to the parallel configuration of its region initials, whether
the composite is reached as the machine's `initialState`, via a dotted-path transition, or via a
**bare-root** transition (`to: 'parent'`). All three produce the same active state:

```ts
await sm.fireEvent('go')                 // go: { from: 'idle', to: 'parent' }
sm.isInState('parent')                   // true
sm.getCurrentState()                     // 'parent.r1.c1|parent.r2.c1' (order not guaranteed)
```

> The `|`-joined parts are serialized in **document order** (the position of each active leaf in
> the config), so the same set of active leaves always serializes identically regardless of how it
> was reached. That order is nonetheless an implementation detail of the string form: prefer
> `isInState(...)` over asserting against a hard-coded composite string.

`isInState(id)` is ancestor-aware: `isInState('parent')` and `isInState('parent.r1')` are both
true while the expanded configuration is active.

## 3. Entry/exit ordering (SCXML §3.13)

The rule is the W3C SCXML §3.13 rule, stated once:

- **Entry runs in document order** — a depth-first **pre-order** walk of the config tree.
- **Exit runs in the exact reverse of document order.**

"Document order" is the order states and regions are declared in the `states` / `regions` objects,
read outside-in and top-to-bottom. Two consequences follow, and they are not separate rules:

- **Layering.** A composite parent's `onEnter` fires *before* its region children's; on exit the
  children's `onExit` fire *before* the parent's. For nested composites every ancestor enters
  top-down and exits bottom-up.
- **Sibling regions.** Regions declared `r1, r2, r3` are **entered** `r1 → r2 → r3` and **exited**
  `r3 → r2 → r1`. Each region is walked to completion before the next one is touched: a region
  containing a nested composite enters that whole subtree before its sibling region is entered at
  all (and unwinds the same way in reverse).

A state that remains in the active configuration is **not** re-entered or exited: re-entering an
overlapping composite does not re-fire a still-active ancestor's `onEnter` nor re-arm its
`invoke` timers, and a surviving sibling region keeps its timers.

```ts
// regions: { r1: { a: … }, r2: { x: … } }, with r1.a a nested composite r1.a ▸ s ▸ deep
// entry  = document order (r1's subtree finishes before r2 begins):
//   'parent', 'parent.r1.a', 'parent.r1.a.s.deep', 'parent.r2.x'
// exit   = the exact mirror:
//   'parent.r2.x', 'parent.r1.a.s.deep', 'parent.r1.a', 'parent'
expect([...exitLog].reverse()).toEqual(entryLog)
```

This ordering is uniform across `setInitialState`, `reset`, and every transition, and it is
deterministic: it is derived from the compiled config model's document index, a pure function of
the config's shape — not of the activation path or of `Map` insertion order.

> **Caveat — integer-like region keys.** Document order is the JS own-property order of the
> `regions` object, and ECMAScript sorts integer-like keys numerically *ahead* of string keys.
> A config written `{ '2': …, '1': … }` therefore has document order `(1, 2)`. Still fully
> deterministic, but source order is not readable as document order when region keys are numeric.

### BREAKING change in `1.0.0-beta.x` (W8/V11)

Before this change the engine ordered the enter/exit sets by **depth** (tie-broken by declaration
order) rather than by document index. Two observable differences:

1. **Sibling `onExit` order reversed.** Regions declared `r1, r2, r3` used to exit `r1 → r2 → r3`;
   they now exit `r3 → r2 → r1`, as §3.13 requires.
2. **Nested regions are no longer interleaved.** The old depth-major walk emitted callbacks
   level-by-level across regions, so a shallow sibling's leaf could land *between* two states of
   another region's chain. Regions are now traversed one subtree at a time on both edges.

The difference is invisible for flat regions whose leaves all sit at the same depth, and only
point 1 applies there.

**What did *not* change:** the SET of callbacks invoked, the reached configuration, the layering
guarantees above, and entry sibling order (already document order). If your `onExit` handlers are
order-independent — the common case — no migration is needed. If one region's `onExit` relied on a
sibling region having already torn down, invert that expectation or move the dependency into the
composite parent's `onExit`, which still runs last.

## 4. Leaving a composite: parallel-exit vs. all-final join

There are two distinct, unambiguous ways out, disambiguated by **trigger**:

### 4a. Parallel-exit (preemption)

A plain transition whose `from` is the composite (or an ancestor of an active leaf), fired by a
**user event**, preempts and exits all active regions immediately:

```ts
events: {
  abort: { transitions: [{ from: 'proc', to: 'cancelled' }] },  // fires while any region active
}
```

`from: 'proc'` is eligible whenever *any* region under `proc` is active (least-common-compound-ancestor
matching).

### 4b. All-final join (`done.state`)

Mark a region's terminal leaf with `final: true`. When **every** region of a composite has reached
a final state, the engine raises the UML completion event `done.state.<compositeId>`. A join is just
a transition on that event:

```ts
const states = {
  proc: {
    initial: 'a.run|b.run',
    regions: {
      a: { run: {}, done: { final: true } },
      b: { run: {}, done: { final: true } },
    },
  },
  complete: {},
} satisfies States<any>

const events = {
  finishA: { transitions: [{ from: 'proc.a.run', to: 'proc.a.done' }] },
  finishB: { transitions: [{ from: 'proc.b.run', to: 'proc.b.done' }] },
  'done.state.proc': { transitions: [{ from: 'proc', to: 'complete' }] },  // the join
}
```

```ts
await sm.fireEvent('finishA')
sm.isDone('proc')                                  // false — only region a is final
await sm.fireEvent('finishB')
sm.isDone('proc')                                  // true — all regions final (config reached)
await new Promise((r) => setTimeout(r, 0))         // let the internal done.state.proc drain
sm.getCurrentState()                               // 'complete'
sm.isDone('proc')                                  // false — machine has left proc
```

Semantics worth knowing:

- `done.state.<C>` is **only** raised when the event is declared in the config; an undeclared
  completion event is never enqueued (no "Invalid event" error).
- `done.state.*` events are engine-internal and are **excluded** from `from: '*'` wildcard matching,
  so a wildcard transition never fires spuriously on completion.
- The completion event is raised on the **internal** queue (innermost composite first for nested
  configurations), so a join is processed before subsequent external events — coexistence with a
  parallel-exit `from: 'C'` on the same composite is deterministic: the user event preempts while
  non-final; `done.state.C` fires only at all-final.
- `isDone(compositeId)` is a public predicate usable as a guard; it returns true exactly while the
  all-final configuration is active.

> Scope note: this is UML *all-regions-final* completion. There is no per-region `In()` join across
> partial configurations beyond `isDone`/`done.state`.

## 5. Validation

`validateConfig` (and `createMachine`) enforce:

| Code | Severity | Meaning |
| --- | --- | --- |
| `FINAL_STATE_HAS_OUTGOING` | error | a `final: true` leaf is the `from` of a transition (final states are terminal) |
| `FINAL_ON_COMPOSITE` | warning | `final: true` set on a state that itself has `regions` |
| `REGION_NO_REACHABLE_FINAL` | warning | a `done.state.<C>` join exists but no region under `C` can reach a final state |
| `DONE_VS_PARALLEL_EXIT_AMBIGUITY` | warning | the same composite has both a `from: 'C'` user-event transition and a `done.state.C` join |
| `REGION_MISSING_INITIAL` | advisory | a region declares no explicit `initial` and relies on first-declared fallback |

Final leaves are treated as reachable terminals (no `UNREACHABLE_STATE` false positive), and
`done.state.<C>` is recognised as a used event.

## 6. History & persistence

History (deep/shallow), `toJSON`/`fromJSON`, and the persistence adapter all round-trip the
expanded composite string verbatim and re-arm per-leaf `invoke` timers on restore. Restoring a
non-final configuration does not raise `done.state`.

## 7. Public API summary

| Symbol | Description |
| --- | --- |
| `State.final?: boolean` | marks a region's terminal (final) leaf |
| `done.state.<compositeId>` | engine-raised completion event; author a transition on it to join |
| `StateMachine.isDone(compositeId, adaptee?)` | true while every region of the composite is final |
| `StateMachine.isInState(id)` | ancestor-aware membership (true for a composite while expanded) |
