# PLAN v2 — SCXML/UML-correct regions: ancestor-first entry/exit + all-final join

> Supersedes the v1 minimal-surgical plan. Scope expanded by product owner (R1 ancestor-first entry/descendant-first exit; R2 true UML all-final join) under a **standards-first** directive: **no external consumers yet → backward-compat is NOT a constraint; optimize purely for SCXML/UML correctness; non-standard tests are rewritten to spec; no opt-out flags.**

**Package:** `@vedmalex/statemachine@1.0.0-beta.1` (changesets pre-mode) · **Runner:** vitest · **Lint:** biome · **Branch:** `fix/regions-ancestor-entry-and-final-join`

**Bump:** MINOR (feature+fix). **Public API grows:** `State.final?`, `isDone()`, `done.state.<C>` event → `etc/statemachine.api.md` + `public_surface.test.ts` ratchet.


**Summary.** Revised plan superseding the minimal-surgical baseline, integrating R1 (SCXML ancestor-first entry / descendant-first exit, uniform across all 5 entry paths) and R2 (UML all-regions-final join via final flag + done.state.id event + isDone guard), keeping the still-valid region-expansion mechanics (D1 updateState guard, D3 isTransitionPossible ancestor-scan, D5 isInState). Verified: region containers are never registered states (sm.ts:1312-1336), so one ancestorChain helper filtered by this.states.has(p) yields exactly [parent..leaf]; R1 and R2 share it. Every reviewer mustFix applied: gate done.state on events.has (avoid the FATAL Invalid-event crash 372-377); exclude done.state from wildcard '*' (359-370); detect all-final by atomic-leaf scan not composite-name recursion; pin checkCompletion to R1 early newState; add validator rules; defer constructor emission. 19 tasks, vitest/npm/skill checkpoints; final docs + llm-wiki tasks flagged main-session.


## Locked config surface (R2)

LOCKED: per-state optional boolean final?: true on State<T> (types.ts:210-226, beside initial?/history?). A leaf with final:true is the UML/SCXML final pseudo-substate of its region; it survives processStates flattening so this.states.get(leaf)?.final is readable with zero new plumbing. Composite C is done when every direct region's active atomic leaf is final (recursively via the static regions tree, NOT a composite-name map lookup). The join is authored EITHER as a Transition on the engine event 'done.state.<C>' (recommended, only enqueued at all-final) OR guarded by () => sm.isDone('C'). Disambiguation by TRIGGER not from: plain from:'C' on a user event is ANY-leaf parallel-exit (eligible via the R1 ancestor-scan whenever any region is active); done.state.<C> fires only at all-final. REJECTED: type:'final' discriminated union (forces a tagged-union refactor, churns StatePaths<S>, no gain); reserved substate name / per-region final pointer (invisible to types, collides with user names). StateMachine and State are @stable (index.ts:24,44), so isDone() AND State.final touch etc/statemachine.api.md — api:check diff + minor changeset required.


## Locked design decisions


**[D1] Does a transition into a BARE-ROOT composite expand its regions like initialState/dotted entry?**
- **Decision:** Yes, unconditionally. Guard the updateState simple-root early-return at sm.ts:1929 to fire ONLY for region-LESS roots: condition becomes toStateParts.length===1 && !toState.includes('.') && !this.states.get(toState)?.regions. A region-bearing root then falls through to the addRegionStates loop (1935-1949). No opt-out flag.
- **Why:** Removes the path-3 defect; the bare-vs-expanded inconsistency has no legitimate consumer. A genuine non-region leaf root still short-circuits byte-for-byte.

**[D2] REPLACES old D2. onEnter/onExit firing SET and ORDER across all 5 paths?**
- **Decision:** Ancestor-first entry, descendant-first exit. For each entered leaf fire its ancestor chain root-to-leaf; for each exited leaf leaf-to-root. enterStates = newAncestry MINUS oldAncestry sorted ascending depth then doc order; exitStates = oldAncestry MINUS newAncestry sorted descending depth. A shared active ancestor is in BOTH ancestries so in NEITHER diff (no re-fire, no timer re-arm/leak). Parent onEnter now precedes region children; region children onExit precede parent. Empty-diff fallback to [transition.to]/[transition.from] ONLY when both diffs empty.
- **Why:** SCXML enters ancestors before descendants and exits the reverse, never exiting a state remaining in the active config. Region containers are unregistered so the only firable ancestors are composite parents plus the leaf.

**[D3] How is a join from a composite-parent matched once the parent expands (parallel-exit / LCCA)?**
- **Decision:** Additive ancestor-scan in isTransitionPossible (sm.ts:1549-1561). Keep the exact regionKey fast path; on miss or failed equality/isParentState, fall back to Array.from(currentStates.values()).some(leaf => leaf===fromState || this.isParentState(fromState, leaf)). Preserve outer fromStates.every() so multi-part from still needs every part. Unconditional.
- **Why:** isParentState(fromState, leaf) reproduces SCXML source-in-active-configuration eligibility; the scan only adds matches at the old line-1555 miss, provably non-regressing.

**[D5] isInState ancestor-aware matching (mandatory).**
- **Decision:** Before the exact sorted per-part compare (sm.ts:630-635) short-circuit true when every expected '|'-part equals OR is an ancestor (isParentState) of some active leaf parsed from currentState. Keeps isInState('C') and isInState('C.region') true post-expansion (JSDoc at 617).
- **Why:** Region-roots are now stored expanded; without this a documented @stable method silently flips true->false.

**[D7] Where do newState/enterStates/exitStates live vs phase ordering, and the validation-throw hazard?**
- **Decision:** Compute immutable const newState=updateState(...) and computeEnterExitSets(currentState,newState) right after targetState is set (~sm.ts:1585), BEFORE Phase 3. Phase 8 REUSES newState (remove duplicate updateState at 1676). Phase 4 history stays at 1631. CRITICAL: updateState calls validateCompositeState (1955) which can throw; wrap the early compute so a validation throw aborts cleanly (return undefined) with NO half-run exit/enter.
- **Why:** Phase 6 enter precedes the old Phase 8 updateState, so expanded leaves were unknown at enter time. updateState is side-effect-free; only setCurrentState write stays late.

**[D8] setInitialState and reset uniformity (R1 across initial paths).**
- **Decision:** Replace setInitialState per-leaf enter loop (sm.ts:1228-1247) with enterStates=computeEnterExitSets('', initialStates).enterStates looped fire-and-forget with .catch. reset (554-573) inherits via delegation. Construction/reset now fire parent onEnter before region leaves, identical to a transition.
- **Why:** R1 demands uniformity across ALL entry paths; the same ancestor-union makes initial entry fire parent-then-leaf like a transition.

**[D9] final-state config marker.**
- **Decision:** Add optional final?: boolean on State<T> (types.ts:210-226) with a doc comment. isStateFinal(leaf)=Boolean(this.states.get(leaf)?.final) near getInitialStatesForRegions (~1272).
- **Why:** SCXML/UML final is a marker on an atomic state; the additive flag is the smallest spec-correct surface needing no flatten/parse changes.

**[D10] All-regions-final detection (mustFix: atomic-leaf scan, not composite-name recursion).**
- **Decision:** checkCompletion(obj,newState) at end of Phase 8 after setCurrentState, consuming R1 newState. isCompositeDone(C, atomicLeaves): for each region in this.states.get(C)?.regions find the active leaf via leaf.startsWith(C+'.'+region+'.'); region final iff that leaf isStateFinal OR under a nested composite that isCompositeDone; C done iff every region final. Scan atomic '|' leaves + static regions tree, NEVER configMap.get(C+'.'+region). Only inspect composites that gained a leaf; short-circuit when no substate under C has final:true.
- **Why:** SCXML raises done.state.id on entering a configuration; post-write is the side-effect-free hook. Atomic-leaf scan fixes the nested-detection break (parseCompositeState keys by deepest getRegionKey).

**[D11] Completion signal emission (mustFix: events.has gate + wildcard exclusion).**
- **Decision:** checkCompletion emits done.state.<C> innermost-first, per-config emitted-id Set, ONLY when this.events.has('done.state.'+C) (events is a Map, sm.ts:84) - never unconditionally, else Invalid-event crash (372-377). EXCLUDE engine done.state.* from the '*' wildcard fallback (359-370). Use raiseEvent (internal queue)+scheduleProcessing so done.state precedes external events. Expose public isDone(compositeId):boolean.
- **Why:** Closes the FATAL queue crash and wildcard-collision mustFix; internal priority makes coexistence deterministic, not emission-order-dependent.

**[D12] checkCompletion on initial/reset and the constructor hazard.**
- **Decision:** Run checkCompletion after setInitialState/reset writes so a degenerate all-final initial raises done.state consistently. setInitialState runs in the constructor (sm.ts:197) - emit via raiseEvent only; scheduleProcessing defers via queueMicrotask (285) so the join fires after construction returns.
- **Why:** Mirrors SCXML completion on entering a configuration while avoiding a join on a half-constructed instance.

**[D6] Do history, persistence, serialization need code changes?**
- **Decision:** No. manageStateHistory snapshots verbatim at 1631 (before write); setCurrentState short-circuit replays the stored expanded string; restore/deserialize verbatim; resumeTimers re-arms per '|'-leaf. The fix only changes WHICH string is stored and WHICH onEnter/onExit fire.
- **Why:** All are verbatim pass-throughs; the robot machine already round-trips an expanded dotted initial. Verify restore emits no done.state for non-final configs.

---

## Task DAG (19 tasks)

**Executor (detached dynamic-workflow) runs T0–T16** in this topological order, one commit per task:
`T0 → T1 → T2 → T5 → T6 → T7 → T3 → T4 → T9 → T8 → T10 → T11 → T13 → T12 → T14 → T15 → T16`

**T17 (docs) and T18 (llm-wiki) are MAIN-SESSION** terminal tasks (Skill tools need the main session) — run after all gates are green.


### T0 — Baseline capture and failing repros (red)  ·  risk: **low**  ·  deps: none

Record pre-fix suite baseline (pass/fail counts) and add failing tests: ancestor-first entry order (parent onEnter before region children) bare-root/dotted/nested; descendant-first exit; join from composite-parent matches after expansion; all-final done.state positive/negative. All start RED. Order-insensitive asserts only.

**Files:** `src/tests/hierarchical.test.ts`

**Acceptance:**
- [ ] New tests exist and FAIL on current code
- [ ] Baseline pass/fail count recorded
- [ ] All repro asserts order-insensitive

**Tests:** entry fires parent onEnter before region children; join from composite-parent matches expanded; done.state positive/negative

**Checkpoint:**
```bash
cd packages/statemachine && npx vitest run src/tests/hierarchical.test.ts
```

### T1 — Core: expand regions on bare-root composite transition (D1)  ·  risk: **medium**  ·  deps: ['T0']

Guard updateState simple-root early-return at sm.ts:1929 with && !this.states.get(toState)?.regions so region-bearing roots fall through to addRegionStates (1935-1949). Region-less roots short-circuit unchanged.

**Files:** `src/state_machine.ts`

**Acceptance:**
- [ ] updateState('state1','parentState') returns expanded composite not bare
- [ ] Non-region leaf root still returns bare name
- [ ] Complex-branch path unchanged

**Tests:** transition into bare-root composite expands

**Checkpoint:**
```bash
cd packages/statemachine && npx vitest run src/tests/hierarchical.test.ts -t 'bare-root composite'
```

### T2 — Shared helpers: ancestorChain + computeEnterExitSets  ·  risk: **medium**  ·  deps: ['T1']

Add private ancestorChain(leaf):string[] = dot-prefixes root-to-leaf filtered by this.states.has(p) (yields exactly [parent..leaf]; containers excluded, verified). Add computeEnterExitSets(oldComposite,newComposite) building ordered Sets (union of ancestorChain over each '|' leaf), returning enterStates (new MINUS old, ascending depth then doc order) and exitStates (old MINUS new, descending depth). Consumed by BOTH R1 and R2 (mustFix: no separate getRegionKey walk).

**Files:** `src/state_machine.ts`

**Acceptance:**
- [ ] ancestorChain('a.r1.c1')===['a','a.r1.c1']; container excluded
- [ ] nested ancestorChain===['a','a.r1.c1','a.r1.c1.r3.x']
- [ ] enterStates root-to-leaf, exitStates leaf-to-root
- [ ] shared ancestor in neither diff

**Tests:** ancestorChain unit; computeEnterExitSets diff ordering

**Checkpoint:**
```bash
cd packages/statemachine && npx vitest run src/tests/hierarchical.test.ts -t 'ancestor'
```

### T3 — Ancestor-first entry / descendant-first exit in applyTransition (D2,D7) - HIGH risk  ·  risk: **high**  ·  deps: ['T2']

After targetState set (~1585) compute immutable const newState=updateState(...) and {enterStates,exitStates}=computeEnterExitSets(currentState,newState); wrap so a validateCompositeState throw aborts cleanly (return undefined). Phase 3: loop executeExitActions over exitStates (fallback [transition.from]) leaf-to-root, keep abortOnExitError. Phase 6: loop executeEnterActions over enterStates (fallback [transition.to]) root-to-leaf, keep zombie try/catch. Phase 8: reuse newState, remove duplicate updateState at 1676. History stays at 1631.

**Files:** `src/state_machine.ts`

**Acceptance:**
- [ ] parent onEnter before each region-child onEnter
- [ ] region-child onExit before parent onExit
- [ ] overlapping re-entry no re-fire/re-arm of shared ancestor
- [ ] exitedLeaves clear per-leaf activeTimers (no leak)
- [ ] flat transition fires one enter/exit via fallback
- [ ] validation throw leaves no half-entered set

**Tests:** ancestor-first entry order; descendant-first exit order; idempotent re-entry no double-arm; sibling timer cleared on parallel-exit

**Checkpoint:**
```bash
cd packages/statemachine && npx vitest run src/tests/hierarchical.test.ts
```

### T4 — setInitialState + reset ancestor-first uniformity (D8)  ·  risk: **medium**  ·  deps: ['T3']

Replace setInitialState per-leaf enter loop (sm.ts:1228-1247) with enterStates=computeEnterExitSets('', initialStates).enterStates looped fire-and-forget with .catch. reset inherits via delegation. Construction/reset fire parent onEnter before region leaves, identical to a transition.

**Files:** `src/state_machine.ts`

**Acceptance:**
- [ ] initial entry fires parent onEnter before children
- [ ] reset() same ancestor-first order
- [ ] initial order === transition-into-same-composite order

**Tests:** setInitialState ancestor-first; reset uniformity oracle

**Checkpoint:**
```bash
cd packages/statemachine && npx vitest run src/tests/hierarchical.test.ts -t 'initial'
```

### T5 — isTransitionPossible parallel-exit ancestor-scan (D3)  ·  risk: **medium**  ·  deps: ['T1']

In isTransitionPossible (sm.ts:1549-1561) keep the exact regionKey fast path; on miss or failed equality/isParentState fall back to Array.from(currentStates.values()).some(leaf => leaf===fromState || this.isParentState(fromState, leaf)). Preserve outer .every(). Unconditional.

**Files:** `src/state_machine.ts`

**Acceptance:**
- [ ] from:'parentState' matches expanded composite
- [ ] exact-leaf from (robot.mode.manual) still matches
- [ ] from:'p.region' ancestor-of-leaf still matches
- [ ] multi-part from requires both parts
- [ ] canFireEvent/getAvailableEvents see same matching

**Tests:** join from composite-parent matches expanded; turnOffHome leaf from still matches; robot dotted-leaf join still matches

**Checkpoint:**
```bash
cd packages/statemachine && npx vitest run src/tests/hierarchical.test.ts -t 'join'
```

### T6 — isInState ancestor-aware matching (D5, mandatory)  ·  risk: **medium**  ·  deps: ['T1']

Before the exact sorted per-part compare (sm.ts:630-635) short-circuit true when every expected '|'-part equals OR is an ancestor (isParentState) of some active leaf parsed from currentState.

**Files:** `src/state_machine.ts`

**Acceptance:**
- [ ] isInState('parentState') true when expanded
- [ ] isInState('parentState.region1') true
- [ ] exact full-composite still true
- [ ] non-matching still false
- [ ] existing 'a|b' vs 'a' mismatch still passes

**Tests:** isInState region-root true after expansion; isInState exact/mismatch guards

**Checkpoint:**
```bash
cd packages/statemachine && npx vitest run src/tests/coverage_boost.test.ts -t 'isInState'
```

### T7 — final-state config marker + types (D9)  ·  risk: **low**  ·  deps: ['T1']

Add optional final?: boolean on State<T> (types.ts:210-226) with doc comment. Add isStateFinal(leaf) in state_machine.ts near getInitialStatesForRegions (~1272). No runtime behavior yet beyond the readable flag.

**Files:** `src/types.ts`, `src/state_machine.ts`

**Acceptance:**
- [ ] State<T>.final compiles as optional boolean
- [ ] isStateFinal reads the flag from the flattened map
- [ ] typecheck passes

**Tests:** isStateFinal reads final flag

**Checkpoint:**
```bash
cd packages/statemachine && npm run typecheck 2>&1 | tail -4
```

### T8 — All-final join runtime: checkCompletion + done.state + isDone (D10,D11,D12)  ·  risk: **high**  ·  deps: ['T3', 'T5', 'T7']

Add isCompositeDone(C, atomicLeaves) scanning leaf.startsWith(C+'.'+region+'.') over the static regions tree (recursive nested; NEVER configMap.get). Add public isDone(compositeId). Add checkCompletion(obj,newState) at end of Phase 8 after setCurrentState consuming R1 newState: for each composite that gained a leaf, if isCompositeDone AND this.events.has('done.state.'+C) then raiseEvent + scheduleProcessing, innermost-first, per-config emitted-id Set. EXCLUDE done.state.* from '*' (359-370). Call checkCompletion after setInitialState/reset (constructor-deferred via microtask).

**Files:** `src/state_machine.ts`

**Acceptance:**
- [ ] one region final: done.state.C NOT raised, join no-fire
- [ ] all final: done.state.C raised once, join fires, source exited descendant-first
- [ ] no events.has: nothing emitted, NO Invalid-event crash
- [ ] from:'*' machine all-final fires no spurious transition
- [ ] nested: inner done before outer; parent done only after inner
- [ ] re-entering final region no double-emit

**Tests:** all-final positive/negative; done.state not emitted without declared event; wildcard collision excluded; nested recursive done ordering; idempotent done emission

**Checkpoint:**
```bash
cd packages/statemachine && npx vitest run src/tests/hierarchical.test.ts -t 'done.state|all-final|isDone'
```

### T9 — Validator: final + done.state + REGION_MISSING_INITIAL rules  ·  risk: **medium**  ·  deps: ['T7']

In config_validator.ts: FINAL_STATE_HAS_OUTGOING error (final:true is from of a transition); FINAL_ON_COMPOSITE warning (final:true on a state with regions); REGION_NO_REACHABLE_FINAL warning (done.state.<C> transition but no final substate under C); DONE_VS_PARALLEL_EXIT_AMBIGUITY warning (from:'C' user event + done.state.C join coexist); REGION_MISSING_INITIAL advisory (owner-approved). Teach UNREACHABLE_STATE (604-612) and unused-event heuristics about final leaves + done.state. Use addWarning (40,162).

**Files:** `src/config_validator.ts`, `src/tests/config_validator.test.ts`

**Acceptance:**
- [ ] final:true with outgoing yields FINAL_STATE_HAS_OUTGOING
- [ ] done.state.C with no final substate yields REGION_NO_REACHABLE_FINAL
- [ ] region missing initial yields REGION_MISSING_INITIAL, valid:true
- [ ] proper final config validates clean
- [ ] no existing fixture flips pass->fail
- [ ] final leaf no longer triggers UNREACHABLE_STATE

**Tests:** FINAL_STATE_HAS_OUTGOING; REGION_NO_REACHABLE_FINAL; REGION_MISSING_INITIAL advisory; clean final config

**Checkpoint:**
```bash
cd packages/statemachine && npx vitest run src/tests/config_validator.test.ts
```

### T10 — Update ENCODES-BUG assertion + comment in hierarchical.test.ts  ·  risk: **low**  ·  deps: ['T3', 'T5', 'T6']

Change hierarchical.test.ts:105 from expect(getCurrentState()).toBe('parentState') to an order-insensitive expanded assertion (sm.isInState('parentState') true plus sorted '|'-parts vs the 92-94 value). Align the comment at line 70.

**Files:** `src/tests/hierarchical.test.ts`

**Acceptance:**
- [ ] line 105 asserts expanded composite order-insensitively and passes
- [ ] comment at line 70 no longer contradicts
- [ ] full hierarchical suite passes

**Tests:** should correctly transition between hierarchical states using regions

**Checkpoint:**
```bash
cd packages/statemachine && npx vitest run src/tests/hierarchical.test.ts
```

### T11 — Update existing tests for new parent/sibling onExit + getCurrentStateInfo shape  ·  risk: **medium**  ·  deps: ['T3', 'T5', 'T6']

Add/verify descendant-first sibling+parent onExit where R1 newly fires it: smart-home turnOffHome (hierarchical.test.ts:127-190), wildcard-parallel to:done (coverage_boost.test.ts:2434), robot stop to:stopped (345-349). Tighten coverage_boost getCurrentStateInfo region-root cases (1094-1119,1882-1958,2164-2222) to the deterministic expanded shape (regions=dotted keys, children=active leaves). Correct misleading comment near serialization.test.ts:193.

**Files:** `src/tests/hierarchical.test.ts`, `src/tests/coverage_boost.test.ts`, `src/tests/serialization.test.ts`

**Acceptance:**
- [ ] parallel-exit tests assert descendant-first sibling+parent onExit where hooks present
- [ ] getCurrentStateInfo region-root asserts dotted keys + active-leaf children
- [ ] no defensive guard masks a regression
- [ ] serialization comment corrected

**Tests:** turnOffHome exit ordering; getCurrentStateInfo expanded shape

**Checkpoint:**
```bash
cd packages/statemachine && npx vitest run src/tests/hierarchical.test.ts src/tests/coverage_boost.test.ts
```

### T12 — New coverage: R1 ordering + invoke timers + R2 coexistence  ·  risk: **medium**  ·  deps: ['T3', 'T5', 'T6', 'T8']

Add: nested entry strictly outer-to-inner (a,a.r1.c1,a.r1.c1.r3.x; containers never logged) and nested exit inner-to-outer; partial re-entry keeps surviving sibling timer (one activeTimers entry per surviving leaf); invoke arms once per leaf on transition, parent invoke not double-armed across two regions; isDone false with one region final, true at all-final; coexistence where the same composite has BOTH from:'C' user-event parallel-exit AND a done.state.C join (user event preempts while non-final; done.state fires only at all-final).

**Files:** `src/tests/hierarchical.test.ts`, `src/tests/coverage_boost.test.ts`

**Acceptance:**
- [ ] nested entry/exit ordering pass, containers never logged
- [ ] partial re-entry preserves surviving sibling timer
- [ ] invoke arms once per leaf on transition
- [ ] isDone guard ineligible until all-final
- [ ] coexistence parallel-exit vs all-final unambiguous

**Tests:** nested entry/exit ordering; invoke arm-once on transition; isDone guard path; parallel-exit vs all-final coexistence

**Checkpoint:**
```bash
cd packages/statemachine && npx vitest run src/tests/hierarchical.test.ts src/tests/coverage_boost.test.ts
```

### T13 — History + persistence + serialization regression verification  ·  risk: **low**  ·  deps: ['T3', 'T5', 'T8']

Run deep/shallow history, serialization, persistence suites to confirm the now-consistently-expanded stored string round-trips and checkCompletion on restore emits no done.state for non-final configs. Add a round-trip test for a state reached via transition-into-bare-root composite (preserves expanded string, re-arms region timers).

**Files:** `src/tests/serialization.test.ts`, `src/tests/persistence.test.ts`

**Acceptance:**
- [ ] robot deep/shallow history round-trips stay green
- [ ] new round-trip test for transition-reached bare-root composite passes
- [ ] restore emits no done.state for non-final configs

**Tests:** robot deep-history serialization round-trip; robot deep-history persistence round-trip; transition-reached bare-root composite round-trip

**Checkpoint:**
```bash
cd packages/statemachine && npx vitest run src/tests/serialization.test.ts src/tests/persistence.test.ts
```

### T14 — Full gate: test + typecheck + lint  ·  risk: **medium**  ·  deps: ['T9', 'T10', 'T11', 'T12', 'T13']

Run the entire statemachine suite, then typecheck and lint. Confirm only the documented pre-existing unrelated ServerAdapter failure remains (baseline preserved, region-affected count risen). Update public_surface ratchet for State.final + isDone.

**Files:** `src/state_machine.ts`, `src/config_validator.ts`, `src/types.ts`

**Acceptance:**
- [ ] full suite passes except documented pre-existing ServerAdapter failure
- [ ] no new failures vs baseline
- [ ] typecheck passes
- [ ] lint passes

**Tests:** full statemachine suite; typecheck gate; lint gate

**Checkpoint:**
```bash
cd packages/statemachine && npm run test 2>&1 | tail -8 && npm run check 2>&1 | tail -8
```

### T15 — API report regen + knip gate  ·  risk: **medium**  ·  deps: ['T14']

Run api:check (api-extractor) and knip. State.final AND public isDone() both touch the @stable surface (StateMachine and State @stable, index.ts:24,44), so api.md WILL change - review and commit etc/statemachine.api.md. Verify knip ignore-cap (5) not exceeded.

**Files:** `etc/statemachine.api.md`, `knip.json`

**Acceptance:**
- [ ] api:check run; api.md updated for State.final + isDone
- [ ] knip passes or only pre-existing type warnings
- [ ] knip ignore-list still <=5

**Tests:** api:check gate; knip gate

**Checkpoint:**
```bash
cd packages/statemachine && npm run api:check 2>&1 | tail -15 && npm run knip 2>&1 | tail -12
```

### T16 — Changeset (minor)  ·  risk: **low**  ·  deps: ['T14']

Add .changeset/composite-region-final-join.md, frontmatter '@vedmalex/statemachine': minor (feature+fix: new final?/isDone()/done.state plus SCXML ancestor-first entry/exit justifies minor in pre-1.0 beta pre-mode). Body documents all observable changes. pre.json auto-tracks the new id.

**Files:** `.changeset/composite-region-final-join.md`

**Acceptance:**
- [ ] frontmatter is '@vedmalex/statemachine': minor
- [ ] body documents ancestor-first entry/exit, parallel-exit scan, final/done.state/isDone, isInState/getCurrentStateInfo region-root change
- [ ] changeset status clean

**Tests:** changeset presence

**Checkpoint:**
```bash
cd /Users/vedmalex/work/statemachine && npx changeset status 2>&1 | tail -12
```

### T17 — DOCUMENTATION (MAIN-SESSION) - README + docs  ·  risk: **low**  ·  deps: ['T15', 'T16'] · **MAIN-SESSION**

FLAG: run in MAIN session (Skill docs writer or direct edit), not the detached executor. Add a README section to packages/statemachine/README.md covering region declaration, SCXML ancestor-first entry / descendant-first exit, transition-out-of-parallel preemption (LCCA) vs all-final join, final states, done.state.<id> and isDone()/isInState guards - each with a runnable example mirroring a passing test. Add docs/regions-and-parallel.md. Remove any stale 'regions unsupported/host-side only' notes (grep currently clean, re-verify). Cross-check etc/statemachine.api.md.

**Files:** `README.md`, `docs/regions-and-parallel.md`, `etc/statemachine.api.md`

**Acceptance:**
- [ ] README has Regions/Parallel/Final section with runnable examples mirroring tests
- [ ] docs/regions-and-parallel.md covers entry/exit order, LCCA parallel-exit, all-final join, done.state, isDone
- [ ] no stale 'regions unsupported/host-side only' notes
- [ ] examples reference @stable surface (final?, isDone)

**Tests:** doc presence grep; example compiles against public API

**Checkpoint:**
```bash
grep -ril 'done.state\|ancestor-first\|all-final' packages/statemachine/README.md packages/statemachine/docs/
```

### T18 — LLM-WIKI (MAIN-SESSION) - refresh via llm-wiki-router  ·  risk: **low**  ·  deps: ['T17'] · **MAIN-SESSION**

FLAG: run in MAIN session via Skill llm-wiki-router (the ONLY public entry; specialists refuse direct invocation, exit 1 without LLM_WIKI_VIA_ROUTER=1). No llm-wiki exists yet (verified), so first init/create the wiki via router, then ingest/refresh the node(s) describing region/composite/parallel/join semantics from the new docs (T17) + tests, then run the wiki lint/maintain check.

**Files:** `docs/regions-and-parallel.md`

**Acceptance:**
- [ ] llm-wiki initialized (if absent) via router
- [ ] wiki node(s) for region/composite/parallel/join ingested from docs+tests
- [ ] wiki lint/maintain check passes clean

**Tests:** llm-wiki lint/maintain check

**Checkpoint:**
```bash
echo 'MAIN-SESSION: invoke Skill(llm-wiki-router) args: lint wiki; verify maintain check clean'
```

---

## Test plan

**New tests:**
- hierarchical: transition into bare-root composite fires parent onEnter BEFORE each region-child onEnter and yields the expanded composite
- hierarchical: transition into a dotted composite-with-regions fires the dotted parent onEnter before its region leaves
- hierarchical: nested entry strictly outer-to-inner (a, a.r1.c1, a.r1.c1.r3.x); region containers never logged
- hierarchical: leaving a composite fires region-child onExit BEFORE parent onExit
- hierarchical: nested exit a.r1.c1.r3.x then a.r1.c1 then a, containers never logged
- hierarchical: partial re-entry does NOT re-fire parent/sibling onEnter nor re-arm/clear their invoke timers (one activeTimers entry per surviving leaf)
- setInitialState/reset: initial entry fires parent onEnter before region children, identical order to a transition into the same composite
- hierarchical: invoke timer arms once per region leaf reached via transition; parent invoke not double-armed across two regions
- hierarchical: join from composite-parent matches expanded config and fires (ANY-leaf parallel-exit)
- hierarchical: all-final positive - both regions final raises done.state.C once, join fires, source region set exited descendant-first
- hierarchical: all-final negative - one region final, done.state.C NOT raised, join does not fire
- hierarchical: guard path - isDone('C') false with one region final, true only at all-final
- hierarchical: coexistence - from:'C' user-event parallel-exit AND done.state.C join; user event preempts while non-final, done.state only at all-final
- hierarchical: done.state NOT emitted when no event named done.state.C declared (no Invalid-event crash)
- hierarchical: from:'*' machine reaching all-final fires no spurious wildcard transition
- hierarchical: nested - parent done.state only after inner composite done; inner before outer; no double-emit within same config
- coverage_boost: getCurrentStateInfo on a region-root reached via transition reports isComposite true, regions=dotted keys, children=active leaves
- coverage_boost: isInState('C') and isInState('C.region') true while expanded composite active
- serialization: round-trip of a state reached via transition-into-bare-root composite preserves expanded string and re-arms region timers
- config_validator: FINAL_STATE_HAS_OUTGOING, REGION_NO_REACHABLE_FINAL, REGION_MISSING_INITIAL advisory (valid:true), and a clean proper-final config

**Modified tests:**
- `src/tests/hierarchical.test.ts` — Line 105: replace expect(getCurrentState()).toBe('parentState') with an order-insensitive expanded assertion (isInState('parentState') true plus sorted '|'-parts vs the 92-94 value); align comment at line 70  _(reason: Assertion cements the path-3 bare bug; post-fix entering parentState via transition expands regions and '|' order is map-insertion dependent)_
- `src/tests/hierarchical.test.ts` — smart-home turnOffHome (127-190) and robot stop (345-349): add/verify descendant-first sibling+parent onExit assertions where hooks are present; confirm green under new exit-set growth  _(reason: R1 newly fires sibling-region and parent onExit on parallel-exit; prior plan undercounted this exit-set delta)_
- `src/tests/coverage_boost.test.ts` — Tighten getCurrentStateInfo region-root cases (1094-1119,1882-1958,2164-2222) from defensive includes('|') guards to the deterministic expanded shape; verify isInState mismatch 'a|b' vs 'a' guard still holds  _(reason: Post-fix region-root output is deterministic (expanded), so guarded toBeDefined checks should assert the concrete shape)_
- `src/tests/serialization.test.ts` — Correct the misleading region-restoration comment near line 193; no assertion change (the to:'parentState' transition is not fired in this body)  _(reason: Comment contradicts engine behavior; transition is defined but not fired here)_

**Regression guards (MUST stay green):**
- basic.test.ts:289-322 getStateHistory initial-expansion ('parent.r.a') stays green - canonical bare-root-expands oracle
- hierarchical.test.ts smart-home turnOffHome join from leaf 'home.lighting.on' still matches
- hierarchical.test.ts robot shallow-history (resumeAuto to:'robot.mode.auto') and deep-history suites stay green
- serialization.test.ts:236-332 robot deep-history round-trip stays green; checkCompletion emits no done.state for the non-final robot config
- persistence.test.ts:244-346 robot deep-history persist/restore stays green
- repro_issue.test.ts:21-80 lobby bare-root composite + wildcard from:'*' stays green; done.state excluded from '*' matching
- config_validator.test.ts existing region/history/initial fixtures stay valid:true (new warnings do not fail validation)
- src/tests/public_surface.test.ts @stable ratchet updated deliberately for State.final + isDone, not silently regressed
- pre-existing unrelated ServerAdapter failure stays failing; suite total must not regress below captured baseline otherwise

---

## Risk register

- **[medium/high]** applyTransition compute-early/write-late: stale/recomputed newState/enterStates/exitStates misfires onEnter or leaks/double-arms per-leaf invoke timers on partial-region transitions
  - _mitigation:_ Compute newState + both diffs ONCE as immutable consts at ~1585; never recompute; Phase 8 reuses same newState (remove duplicate at 1676); idempotence + onExit-clears-timers tests assert one activeTimers entry per surviving leaf (T3/T12)
- **[medium/high]** FATAL queue crash: raiseEvent('done.state.C') with no declared event and no '*' throws Invalid event (372-377) as an unhandled microtask rejection
  - _mitigation:_ Emit ONLY when this.events.has('done.state.'+C); never unconditionally (D11/T8); test asserts no crash when the event is undeclared
- **[medium/high]** Wildcard collision: synthetic done.state.C matches a from:'*' event (359-370) and fires a spurious transition (repro_issue:21-80 at risk)
  - _mitigation:_ Exclude engine-generated done.state.* from the '*' wildcard fallback; test asserts a from:'*' all-final machine fires no spurious transition (T8)
- **[medium/high]** Nested all-final detection broken if keyed by parseCompositeState/getRegionKey rather than atomic-leaf scan, reporting parent done prematurely or never
  - _mitigation:_ isCompositeDone scans atomic leaves via leaf.startsWith(C+'.'+region+'.') over the static regions tree, recursive nested; never configMap.get (D10); nested test guards it (T8)
- **[low/high]** validateCompositeState (1955) throws when updateState is computed early at ~1585, relocating the throw before any onExit and leaving a half-run transition
  - _mitigation:_ Wrap the early compute so a validation throw aborts cleanly (return undefined) with no exit/enter run; explicit contradictory-target test (T3)
- **[low/medium]** checkCompletion in the constructor path (setInitialState at 197) fires a join on a not-yet-returned machine
  - _mitigation:_ Emit via raiseEvent only + scheduleProcessing which defers through queueMicrotask (285), so the join runs after construction returns (D12)
- **[medium/medium]** R1 newly fires parent and sibling onExit on parallel-exit where the engine was silent; an external flat-log consumer sees new interleaved entries
  - _mitigation:_ No current test defines composite-parent hooks; document in the minor changeset; T11 adds explicit descendant-first exit assertions
- **[medium/medium]** getCurrentStateInfo region-root output shape changes (regions bare-names -> dotted keys; children direct -> active leaves), breaking a structural consumer
  - _mitigation:_ Document in changeset; tighten coverage_boost assertions to the new shape (T11); run api:check (T15)
- **[high/low]** State.final + public isDone widen the @stable surface (etc/statemachine.api.md, public_surface ratchet)
  - _mitigation:_ Deliberate minor bump; regenerate api.md + update ratchet in T14/T15; changeset documents the additive surface
- **[low/medium]** Author writes from:'C' on the SAME user event as a done.state.C join; ancestor-scan makes from:'C' eligible on any leaf so parallel-exit can preempt before all-final
  - _mitigation:_ Validator DONE_VS_PARALLEL_EXIT_AMBIGUITY warning (T9); internal done.state processed before external events makes coexistence deterministic, documented (T17)
- **[high/low]** '|' join-string order is map-insertion dependent, making raw getCurrentState() string-equality asserts brittle
  - _mitigation:_ All new/updated asserts order-insensitive (isInState or sorted '|'-parts); never compare to a hard-coded ordered composite string
- **[high/low]** DOCUMENTATION and LLM-WIKI tasks cannot run inside the detached executor (Skill tools need main session; llm-wiki specialists refuse direct invocation)
  - _mitigation:_ T17/T18 flagged MAIN-SESSION with closest runnable checkpoints (doc-presence grep, llm-wiki lint via router); llm-wiki absent so init via router first

---

## Rollout


**changeset:** Add .changeset/composite-region-final-join.md, frontmatter '@vedmalex/statemachine': minor. Pre-1.0 beta pre-mode (tag beta); a feature+fix (new final?/isDone()/done.state PLUS SCXML ancestor-first entry/descendant-first exit and parallel-exit ancestor matching) justifies minor over patch. Body documents consistent region expansion across all entry paths, ancestor-first/descendant-first ordering, parallel-exit ancestor-scan (ANY-leaf, LCCA), all-final done.state/isDone join, and the isInState/getCurrentStateInfo region-root output change. pre.json auto-tracks the new id.

**apiReport:** Run npm run api:check in packages/statemachine. This DOES change the surface: State.final (State @stable) and public isDone() (StateMachine @stable). Regenerate and commit etc/statemachine.api.md; update src/tests/public_surface.test.ts ratchet deliberately. Confirm knip ignore-list stays <=5.

**docs:** README has no regions prose and a stale-note grep is clean. T17 adds a README Regions/Parallel/Final section + docs/regions-and-parallel.md with runnable examples mirroring passing tests. T18 refreshes the llm-wiki (absent today) via llm-wiki-router only. Both are MAIN-SESSION terminal tasks after all gates green.

**commitStrategy:** Branch off main (never commit to main directly), e.g. fix/regions-ancestor-entry-and-final-join. One commit per DAG task mirroring checkpoints so each is independently green and crash-resumable. Operate under MB3 with TASK-ID linkage; get authoritative DA clearance via Agent(subagent_type='mb3-critic') at gated exits - never emit da_reviewed via CLI. End each commit with the Co-Authored-By trailer. Commit docs+wiki last.


---

## Open questions (defaults locked; confirm if you disagree)

- Cascade ordering: when an inner composite becoming done makes its parent region final in the same configuration, confirm both done.state events enqueue in one checkpoint (inner before outer) vs re-deriving on the next event. Default: single-pass innermost-first with a per-config emitted-id Set.
- isInState ancestor matching: strict every-expected-part-is-ancestor-or-equal is assumed; confirm a multi-region partial expected string must require ALL parts matched, not ANY.
- done.state naming uses the fully-qualified dotted composite id (e.g. done.state.robot.mode.auto). Confirm the dotted form is acceptable as an event key vs a sanitized form.
- REGION_MISSING_INITIAL advisory was owner-approved; confirm it should fire for EVERY region lacking explicit initial, including configs intentionally relying on first-key fallback (noise vs signal).
- Whether a separate public isFinal(stateId) leaf predicate is wanted alongside isDone(compositeId) and the done.state event (prompt mentions In()/isFinal guards).
- Constructor-path done.state deferral relies on scheduleProcessing's queueMicrotask; confirm a degenerate all-final initial config SHOULD raise done.state at all vs treating it as a no-op.

---

## Resume protocol

`progress.jsonl` (per-task status/commit/evidence) + `state.json` (run pointers) are the source of truth. Next actionable = lowest-id `pending` whose `dependsOn` are all `done`. Executor caches via `resumeFromRunId`; each agent also self-skips `done` tasks. T17/T18 run in main session after the executor finishes T16.

