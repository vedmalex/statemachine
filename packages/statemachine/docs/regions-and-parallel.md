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

> The order of the `|`-joined parts is insertion-dependent. Compare with `isInState(...)` or by
> sorting the parts — never assert against a hard-coded composite string.

`isInState(id)` is ancestor-aware: `isInState('parent')` and `isInState('parent.r1')` are both
true while the expanded configuration is active.

## 3. Entry/exit ordering (SCXML)

- **Entry is ancestor-first** (outer → inner): the composite parent's `onEnter` fires *before* its
  region children's `onEnter`. For nested composites every ancestor fires top-down.
- **Exit is descendant-first** (inner → outer): region children's `onExit` fire *before* the
  parent's `onExit`.
- A state that remains in the active configuration is **not** re-entered or exited: re-entering an
  overlapping composite does not re-fire a still-active ancestor's `onEnter` nor re-arm its
  `invoke` timers, and a surviving sibling region keeps its timers.

```ts
// ancestor-first entry
expect(log.indexOf('parent')).toBeLessThan(log.indexOf('parent.r1.c1'))
// descendant-first exit (mirror): 'parent.r1.c1' and 'parent.r2.c1' exit before 'parent'
```

This ordering is uniform across `setInitialState`, `reset`, and every transition.

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
