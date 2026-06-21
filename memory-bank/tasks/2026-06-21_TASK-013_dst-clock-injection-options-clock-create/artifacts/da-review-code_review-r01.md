# DA Review — TASK-013 — CODE_REVIEW — Iteration 1

- Task: TASK-013
- Phase: CODE_REVIEW
- Iteration: 1
- Status: approved
- Verdict: PROCEED
- Source: claude-hook
- Review Mode: subagent
- Gate Authority: authoritative
- Timestamp: 2026-06-21T09:09:25.894Z
- Review Schema: mb3-critic.review/v2
- Lens: Sustainability
- UR Refs: UR-001, UR-002
- Follow-up Issues: ISS-005, ISS-006, ISS-007

## Follow-up Issues

- ISS-005
- ISS-006
- ISS-007

## Report

## DA Report:

- Task: TASK-013
- Phase: CODE_REVIEW
- Lens: Sustainability
- Verdict: PROCEED
- Date: 2026-06-21
- Source: claude-hook

### Executive Summary

Sustainability lens: the public surface (clock?, createVirtualScheduler, ITimerScheduler.process?(now?)) is minimal, additive-optional, correctly @unstable-tagged, and well-documented in both JSDoc and README. SemVer MINOR is correct — all new fields are optional and defaults (Date.now, createDefaultScheduler, process default arg) keep old callers byte-identical, with a dedicated back-compat guard test (#11) and explicit README note (161-163). The schedulerProvided dual-path is clearly commented at every branch and pinned by tests #11/#12, so the hidden-state-coupling risk is contained. The behavioral-vs-telemetry clock split is real and correct: behavioral sites use this.clock() with DST-aware comments, telemetry stays Date.now(). The only sustainability gaps are LOW advisory carry-forwards: the telemetry Date.now() site lacks an explicit non-virtualization comment (F-S-1), the flush(16) magic constant could rot (F-S-2), and the hand-rolled virtual-scheduler wrapper duplicates the interface surface (F-S-3). No CRITICAL/HIGH/MEDIUM findings; both UR goals COVERED. Gate clears with three LOW findings logged as open da_finding carry-forwards.

### UR-Goal Traceability

| UR-ID | Goal | Status | Evidence |
|---|---|---|---|
| UR-001 | options.clock + createVirtualScheduler for deterministic replay | COVERED | Public surface is minimal and future-proof: StateMachineOptions.clock?: () => number (types.ts:128), createVirtualScheduler(clock) (scheduler.ts:259), ITimerScheduler.process?(now?) (types.ts:75) all exported and @unstable-tagged in index.ts:144-172. Clock type alias matches Date.now signature. README DST section (README.md:97-172) + JSDoc on each symbol guide consumers; API reference table at README.md:167-172 is complete. |
| UR-002 | Close wallclock blockers without disturbing default behavior; default byte-identical (HARD CONSTRAINT) — sustainable dual-path | COVERED | schedulerProvided dual-path is explicitly commented at setTimer (state_machine.ts:2192-2204), clearTimer (2210-2231), and transitionTimeout finally-gate (1797-1802); back-compat guard documented (README.md:161-163) and pinned by dst.test.ts #11 (default real-time) and #12 (explicit unstarted scheduler routed). Behavioral clock sites (251/264/281/496/2142/2462) use this.clock() with DST-aware comment at 2469-2473; telemetry duration site (2044/2056) intentionally retains Date.now() for monitor.recordTransition. |

### Phase-Specific Challenges

- [LOW] Telemetry Date.now() site lacks an intent-of-non-virtualization comment
  - Challenge: The transition-duration telemetry at state_machine.ts:2044 (transitionStartTime = Date.now()) and :2056 (Date.now() - transitionStartTime, fed to monitor.recordTransition) is the only Date.now() call in behavioral hot-path code that is NOT this.clock(). Unlike the behavioral sites — which carry explicit DST-aware comments (e.g. 2469-2473) — this telemetry site has no comment stating it is intentionally left on wall-clock. A future maintainer doing a 'virtualize all clocks' sweep could either (a) wrongly convert it to this.clock() and pollute monitor durations with virtual deltas, or (b) under an injected virtual clock that does not advance during the synchronous setCurrentState span, silently record ~0ms durations as if they were real. The intentional behavioral-vs-telemetry split is real and correct, but it is implicit at this site.
  - Alternative: Add a one-line comment at state_machine.ts:2044 marking it as intentional wall-clock telemetry (not virtual-time behavior), e.g. 'Date.now() not this.clock(): real wall-clock duration for monitor metrics; must NOT be virtualized.' This pins the split for the next maintainer and matches the comment discipline already applied to the behavioral sites.
  - Risk: Maintainability/telemetry-only; no behavioral impact and back-compat is unaffected. Carry-forward advisory; does not block the gate.
  - Ref: packages/statemachine/src/state_machine.ts:2044
- [LOW] flush(16) microtask-drain helper is a magic-constant that can rot
  - Challenge: dst.test.ts:32 uses a fixed 16-iteration microtask flush (flush(times = 16)) to settle chained invoke -> raiseEvent -> processQueues -> re-armed-invoke layers. The 16 is an empirical upper bound, not derived from the engine's actual microtask depth. If a future change deepens the transition microtask chain (e.g. extra await layers in processQueues), the constant could become insufficient and produce intermittent false negatives, or it silently over-iterates and masks ordering regressions. The pattern is bounded and documented (comment at 27-31) so it is not currently fragile, but it is a maintenance footgun.
  - Alternative: Either (a) document why 16 is a safe upper bound with reference to the max chain depth exercised, or (b) replace fixed-count flush with a drain-to-quiescence helper (loop until queue empty / no pending microtask state) so the test scales with engine depth automatically. Defer to a follow-up; the existing comment at 27-31 makes intent traceable for now.
  - Risk: Test-maintainability only; current tests pass and the constant is generously sized. Carry-forward advisory; does not block the gate.
  - Ref: packages/statemachine/src/tests/dst.test.ts:32
- [LOW] createVirtualScheduler hand-rolled object duplicates TimerScheduler surface
  - Challenge: createVirtualScheduler (scheduler.ts:259-278) wraps an inner TimerScheduler in a fresh literal object that re-declares isActive/schedule/cancel/process by hand rather than returning the instance directly (or exposing a virtual-mode flag on TimerScheduler). If ITimerScheduler grows a method, the wrapper must be hand-updated in lockstep or it silently omits the new method (it is optional-typed). The duplication is small and the comment at 260-261 explains the reuse, so the coupling burden is minor, but it is a second place that must track the interface shape.
  - Alternative: Consider either returning a configured TimerSchedule directly (it already accepts a clock and isActive() reflects intervalId) with a forced isActive override, or adding a 'virtual: true' construction flag so the single class is the one surface to maintain. Acceptable as-is given the explicit comment; revisit only if ITimerScheduler expands.
  - Risk: Coupling/complexity only; no behavioral or compat impact. Carry-forward advisory; does not block the gate.
  - Ref: packages/statemachine/src/scheduler.ts:259

### Verdict

**PROCEED**

Sustainability lens: the public surface (clock?, createVirtualScheduler, ITimerScheduler.process?(now?)) is minimal, additive-optional, correctly @unstable-tagged, and well-documented in both JSDoc and README. SemVer MINOR is correct — all new fields are optional and defaults (Date.now, createDefaultScheduler, process default arg) keep old callers byte-identical, with a dedicated back-compat guard test (#11) and explicit README note (161-163). The schedulerProvided dual-path is clearly commented at every branch and pinned by tests #11/#12, so the hidden-state-coupling risk is contained. The behavioral-vs-telemetry clock split is real and correct: behavioral sites use this.clock() with DST-aware comments, telemetry stays Date.now(). The only sustainability gaps are LOW advisory carry-forwards: the telemetry Date.now() site lacks an explicit non-virtualization comment (F-S-1), the flush(16) magic constant could rot (F-S-2), and the hand-rolled virtual-scheduler wrapper duplicates the interface surface (F-S-3). No CRITICAL/HIGH/MEDIUM findings; both UR goals COVERED. Gate clears with three LOW findings logged as open da_finding carry-forwards.
