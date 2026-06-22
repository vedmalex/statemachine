# DA Review — TASK-014 — CODE_REVIEW — Iteration 1

- Task: TASK-014
- Phase: CODE_REVIEW
- Iteration: 1
- Status: approved
- Verdict: PROCEED
- Source: claude-hook
- Review Mode: subagent
- Gate Authority: authoritative
- Timestamp: 2026-06-22T15:26:11.029Z
- Review Schema: mb3-critic.review/v2
- Lens: Sustainability
- UR Refs: UR-001, UR-002, UR-003, UR-004, UR-005
- Follow-up Issues: ISS-072, ISS-073, ISS-074, ISS-075

## Follow-up Issues

- ISS-072
- ISS-073
- ISS-074
- ISS-075

## Report

## DA Report:

- Task: TASK-014
- Phase: CODE_REVIEW
- Lens: Sustainability
- Verdict: PROCEED
- Date: 2026-06-22
- Source: claude-hook

### Executive Summary

Sustainability lens CODE_REVIEW exit. (1) Load-bearing whole-package determinism grep-audit is CLEAN: a negative-lookahead grep over all src/sim/** production code returns ZERO non-comment hits for Date.now/new Date/Math.random/performance.now/randomUUID/getRandomValues/crypto. — every wall-clock/random token in src/sim is inside a DoD-assertion comment. The only sanctioned wall-clock (process.hrtime.bigint()/process.memoryUsage()) is confined to metrics.ts and feeds PerfSample (wallNs/heap/eventsPerSec) only; traceLen is READ from trace.frames.length, never recomputed or hashed. The hashed path is structurally content-only: TraceFrame.t is logical SimClock virtual time (trace.ts:50), CanonicalHeader carries NO createdAt, and configHash/hashTrace use structuralWalk/stableSerialize which explicitly never call JSON.stringify/toJSON/toSecureJSON (trace.ts:101,201-203) so the engine's Date.now-stamped createdAt at security.ts:430/462/468 can never fold into the hash. No wall-clock or random reaches a hashed field. (2) ABI/dist CLEAN: core etc/statemachine.api.md has zero sim/fault symbol leak (only SimpleStateName/StatePaths substring matches + the retained pre-existing TASK-013 Clock/createVirtualScheduler symbols at :21/:35/:567/:577); the separate ./sim @unstable surface has its own etc/statemachine-sim.api.md baseline; package.json ./sim is a separate export entry; dist_byte_guard.test.ts mirrors verify-dist-bytes.cjs against a committed sourcemap-stripped sha256 baseline. (3) Maintainability CLEAN: settleMacrostep is the SOLE settle primitive (grep-confirmed no second flush/drainToQuiescence/Op.flush; only negative-assertion comments elsewhere); CapabilityId is a genuine 38-literal closed string union with NO string/string&{} member (capabilities.ts:38-77); the no-fault fast path (driver.ts:466-475) is byte-identical to the pre-Step-5 driver so clean-run trace/hash/perf are unchanged; faults are seed-derived via label-fork PRNG and recorded as deterministic FaultRecords; clock-skew is forward-only Math.max-guarded (driver.ts:441-443). (4) Carry-forwards assessed: ISS-055 (MED, QUIET_FLUSH=16 untested margin) is an acceptable DOCUMENTED carry-forward, NOT a CODE_REVIEW blocker — the constant is empirically justified (~5-6 observed turns, generous headroom into the 1024 budget), the observable 4-conjunct isQuiescent predicate is preserved EXACTLY (settle.ts:112-123), and it is backstopped by the AC-1 canary + determinism-gated coverage runner; it was already accepted at IMPLEMENT-exit and QA-exit DA gates and is not newly introduced at CODE_REVIEW. ISS-068/067/047 (LOW) are correctly characterized and not over-claimed. No new CRITICAL/HIGH/MEDIUM defect was introduced by CODE_REVIEW-scope work. REFLECT MUST record the four open carry-forwards.

### UR-Goal Traceability

| UR-ID | Goal | Status | Evidence |
|---|---|---|---|
| UR-001 | VOPR-style deterministic simulation testing built on the TASK-013 clock/scheduler seam | COVERED | src/sim/** wires the REAL engine through SimClock + harness virtual scheduler (driver.ts:222-232 forwards all five DI seams); single seed -> bit-identical trace proven determinism-clean by the grep-audit and fault-determinism.test.ts |
| UR-002 | Full fault model (reorder/drop/dup/overflow/clock-skew/timer-jitter/throw), safety+liveness, invariant checkers, shrinker, CI integration | COVERED | All 7 FaultKinds genuinely applied during real runs (driver.ts fireWithFaults/clockSkewAt/recordPlanJitter + harness applyThrowFaults; ISS-064 closed); SettlePolicy safety\|liveness (settle.ts:54); invariants.ts/invariants.runner.ts; shrinker.ts first-violation; ci.yml single Node-24 leg + sim-nightly.yml |
| UR-003 | Simulation ENVIRONMENT for load/stress testing and deterministic feature debugging, not only bug-hunting | COVERED | metrics.ts perf plane (throughput/heap/latency/traceLen via hrtime+memoryUsage, walled off from hash) + repro-codegen.ts/dst-e2e-repro reproducible debug path |
| UR-004 | Coverage of the whole machine feature surface + a mandatory CI gate that fails when a capability is uncovered | COVERED | capabilities.ts 38-literal closed CapabilityId union with TOTAL Record (tsc teeth, capabilities_totality.test.ts) + computeCoverage runtime gate + sim:coverage runner (exit 0); ci-gating.test.ts |
| UR-005 | Exported ./sim sub-entry separate from core bundle, ABI-tested, with the full v1 fault set | COVERED | package.json ./sim separate export + types/sim + tsup 2nd entry + api-extractor.sim.json + statemachine-sim.api.md; core etc/statemachine.api.md byte-clean of sim symbols; verify-dist-bytes core byte-freeze |

### Phase-Specific Challenges

- [MEDIUM] QUIET_FLUSH=16 stability window has no falsifiable margin/boundary test
  - Challenge: settle.ts:188 hardcodes QUIET_FLUSH=16 as the consecutive-no-change stability witness in the determinism-critical settle primitive. The comment justifies it empirically (~5-6 observed turns between an observable going idle and its delayed follow-on enqueue) but there is no test asserting the margin is real — nothing proves 15 would fail or that the deepest engine microtask chain can never exceed 16. An untested magic constant in the sole settle primitive is a latent sustainability risk if a future engine change lengthens the resolved-action -> raiseEvent -> scheduleProcessing -> queueMicrotask chain.
  - Alternative: Accept as a DOCUMENTED carry-forward (NOT CODE_REVIEW-blocking): the observable 4-conjunct isQuiescent predicate (settle.ts:112-123) is preserved exactly, the 1024-turn budget leaves ample headroom, and the AC-1 canary + determinism-gated coverage runner backstop drift. REFLECT must record adding a falsifiable margin/boundary assertion (e.g. a scenario that measures the actual max quiet-window depth and asserts headroom below 16) as a follow-up.
  - Risk: If a future engine change lengthens the microtask follow-on chain past 16, the settle could conclude quiescence prematurely and silently mask un-enqueued work; the canary/coverage backstops would catch most regressions but not all margin shrinkage. Severity MEDIUM, mitigated by preserved predicate + backstops + prior IMPLEMENT/QA-exit acceptance; carried forward, not re-opened as blocking.
  - Ref: packages/statemachine/src/sim/settle.ts:188
- [LOW] Throw-fault single-shot latch keyed by FaultSite object identity
  - Challenge: harness.ts:345-352 keys the per-site once-only latch (fired: Set<FaultSite>) by FaultSite OBJECT identity. Currently safe/deterministic because the site object is created once in the plan and threaded through unchanged, but it is latently fragile: if a FaultSite were ever reconstructed (e.g. plan normalization/cloning), identity-keying would silently re-arm the latch and break replay determinism.
  - Alternative: Carry forward to REFLECT/follow-up: consider keying the latch by a structural site key (callbackKind+invokeIndex+opId) instead of object identity, or assert the site object is never cloned on the plan path.
  - Risk: No current defect (call path never reconstructs sites); latent replay-determinism fragility only under a future refactor. LOW.
  - Ref: packages/statemachine/src/sim/harness.ts:345-352
- [LOW] reorder fault is a structural no-op on single-op step()
  - Challenge: reorder is only observable on a >=2-op fireMany window; a reorder targeting a lone single-op step() buffer is a structural no-op (driver.ts:660-678). This is documented and the FaultRecord is still recorded/tagged, so it is not over-claimed, but the single-op no-op behavior is a subtlety a future maintainer could misread as broken reorder.
  - Alternative: Carry forward: ensure the documented-gap note survives into REFLECT and the integration test (fireMany >=2-op window) remains the canonical reorder witness.
  - Risk: Documentation/comprehension risk only; behavior is correct and recorded. LOW.
  - Ref: packages/statemachine/src/sim/driver.ts:660-678
- [LOW] Cosmetic tech-spec line-citation off-by-ones + node-20/node-24 doc drift
  - Challenge: ISS-047 records 3 cosmetic tech-spec line-citation off-by-ones; additionally dist_byte_guard.test.ts:14 comment says the baseline is pinned to node-20 while the active CI is a single Node-24 leg. These are comment/citation drift only — the baseline JSON (not the comment) is what is actually byte-compared, and the test skips gracefully when dist is unbuilt.
  - Alternative: Carry forward to REFLECT: correct the 3 line citations and the node-20 -> node-24 comment in the next docs/citation pass.
  - Risk: Zero behavioral impact; comprehension/accuracy only. LOW.
  - Ref: packages/statemachine/src/tests/sim/dist_byte_guard.test.ts:14

### Verdict

**PROCEED**

Sustainability lens CODE_REVIEW exit. (1) Load-bearing whole-package determinism grep-audit is CLEAN: a negative-lookahead grep over all src/sim/** production code returns ZERO non-comment hits for Date.now/new Date/Math.random/performance.now/randomUUID/getRandomValues/crypto. — every wall-clock/random token in src/sim is inside a DoD-assertion comment. The only sanctioned wall-clock (process.hrtime.bigint()/process.memoryUsage()) is confined to metrics.ts and feeds PerfSample (wallNs/heap/eventsPerSec) only; traceLen is READ from trace.frames.length, never recomputed or hashed. The hashed path is structurally content-only: TraceFrame.t is logical SimClock virtual time (trace.ts:50), CanonicalHeader carries NO createdAt, and configHash/hashTrace use structuralWalk/stableSerialize which explicitly never call JSON.stringify/toJSON/toSecureJSON (trace.ts:101,201-203) so the engine's Date.now-stamped createdAt at security.ts:430/462/468 can never fold into the hash. No wall-clock or random reaches a hashed field. (2) ABI/dist CLEAN: core etc/statemachine.api.md has zero sim/fault symbol leak (only SimpleStateName/StatePaths substring matches + the retained pre-existing TASK-013 Clock/createVirtualScheduler symbols at :21/:35/:567/:577); the separate ./sim @unstable surface has its own etc/statemachine-sim.api.md baseline; package.json ./sim is a separate export entry; dist_byte_guard.test.ts mirrors verify-dist-bytes.cjs against a committed sourcemap-stripped sha256 baseline. (3) Maintainability CLEAN: settleMacrostep is the SOLE settle primitive (grep-confirmed no second flush/drainToQuiescence/Op.flush; only negative-assertion comments elsewhere); CapabilityId is a genuine 38-literal closed string union with NO string/string&{} member (capabilities.ts:38-77); the no-fault fast path (driver.ts:466-475) is byte-identical to the pre-Step-5 driver so clean-run trace/hash/perf are unchanged; faults are seed-derived via label-fork PRNG and recorded as deterministic FaultRecords; clock-skew is forward-only Math.max-guarded (driver.ts:441-443). (4) Carry-forwards assessed: ISS-055 (MED, QUIET_FLUSH=16 untested margin) is an acceptable DOCUMENTED carry-forward, NOT a CODE_REVIEW blocker — the constant is empirically justified (~5-6 observed turns, generous headroom into the 1024 budget), the observable 4-conjunct isQuiescent predicate is preserved EXACTLY (settle.ts:112-123), and it is backstopped by the AC-1 canary + determinism-gated coverage runner; it was already accepted at IMPLEMENT-exit and QA-exit DA gates and is not newly introduced at CODE_REVIEW. ISS-068/067/047 (LOW) are correctly characterized and not over-claimed. No new CRITICAL/HIGH/MEDIUM defect was introduced by CODE_REVIEW-scope work. REFLECT MUST record the four open carry-forwards.
