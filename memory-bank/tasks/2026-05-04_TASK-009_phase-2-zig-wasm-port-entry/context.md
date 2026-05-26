# Context — TASK-009: Phase 2 entry — zig-wasm-port (RM-001-P02)

## Preamble

Updated: 2026-05-04
Profile: creative-first | Tier: T5:epic | QA: MAX | Execution Mode: subagent_driven

This is the **planning + decomposition** task for RM-001 Phase 2. Concrete porting work happens in child tasks (TASK-010+). This file holds the rich VAN content (questions, hypotheses, risks, acceptance criteria, traceability tables) so that the auto-generated `_task.md` projection rerender does not destroy it.

## Cross-Project Provenance

Three typed cross-project links to `/Users/vedmalex/work/grainjs-prod/packages/statemachine`:

| Relation | Legacy task | What's used | UR refs |
|---|---|---|---|
| `continuation` | TASK-001 (bootstrap parent) | UR-001..UR-011 verbatim carry-forward into this task's requests.md (preserved IDs). Phase 1 history remains in legacy work tree as historical record. | UR-001..UR-011 |
| `artifact_source` | TASK-004 (WASM-friendly design + singleton elimination) | `zig-port-considerations.md` (5 sections), IMonitor / ITimerScheduler / IErrorHandler injection contracts (TD-T4-2/2a/2b), TD-T4-1..TD-T4-8 architectural commitments, singleton-elimination invariant test (4 cases). | UR-009 |
| `artifact_source` | TASK-006 (API docs + EP catalog + ABI tests) | `etc/statemachine.api.md` (api-extractor surface snapshot), `STABILITY.md` (5 firm @stable + @unstable tiers), `src/tests/abi/*.abi.test.ts` (7 EP ABI tests verified by md5 — the contract any port must satisfy). | UR-005, UR-007, UR-010 |

DA finding F-VAN-C4-1 fix: cross-project artifactRefs are now per-task and honest — TASK-001 contributes only `requests` (UR source); the actual creative/tech_spec/implementation/qa/reflect artifacts belong to TASK-004 and TASK-006.

## Scope (Phase 2 entry — this task)

- Phase 2 program-level CREATIVE decisions (target Zig version, WASM ABI strategy, timer-host shape, FFI typing, build pipeline, ABI versioning, panic/trap, allocator)
- Decomposition into 4–6+ child tasks with locked tier + dependency DAG
- Updated orchestration packet for `mb3-smart-executor`
- Risk register specific to Zig/WASM (memory model, GC bridging, sourcemaps, debugging, licensing, CI/CD, multi-tenant)

### Out of scope (deferred to TASK-010+)

- Actual Zig source files
- WASM module compilation
- Per-EP shim implementations (IMonitor / ITimerScheduler / IErrorHandler bridging)
- Performance benchmarking vs JS implementation
- Browser smoke for the WASM build

## Acceptance Criteria for TASK-009 (DA finding F-VAN-C2-3 fix)

TASK-009 itself (the decomposition task) is DONE when all of the following hold:

1. **CREATIVE phase outputs program-level decisions** for all 13 open questions (Q-T9-1..Q-T9-13).
2. **PLAN phase locks the child-task DAG** with final tier per child and explicit dependency direction (no `D || C` ambiguity remaining).
3. **Risk register v1** covers all 9 R-T9 items with assigned ownership (TASK-009 CREATIVE / TASK-010 / TASK-011 / etc.).
4. **`taskDecompose` function gate** cleared by `mb3-critic` with verdict PROCEED.
5. **Orchestration packet updated** with the final child set, DAG, and stop conditions.
6. **All 12 UR (UR-001..UR-012)** explicitly mapped to either "satisfied by Phase 1" or "covered by a planned child task".
   - **Amendment 2026-05-26**: AC#6 scope extended to include **UR-013** (TigerStyle + ZTB methodology adoption) — `artifacts/creative-decisions.md` UR Coverage Matrix authoritatively tracks all 13 URs at CREATIVE exit.
7. **TASK-009 ARCHIVE event** emitted only after operator approves the orchestration packet for child dispatch.

## Assumptions

- RM-001-P01 closed in this repo (TASK-002..007 ARCHIVED, `@vedmalex/statemachine@1.0.0-beta.1` live on npm).
- Public surface frozen by `etc/statemachine.api.md` and STABILITY.md tiers from TASK-006.
- WASM-friendly singleton elimination from TASK-004 (zig-port-considerations.md) is the architectural baseline; legacy DA-review for TASK-001 (advisory C-5) flagged "Phase 2 WASM boundary contract is undefined" — this task partially closes that gap by enumerating Q-T9-1..Q-T9-13.
- Cross-project links in tasks-registry.jsonl record provenance without duplicating Phase-1 history here.

## Constraints

- Active task is the decomposition; no Zig sources, no WASM compilation in this task.
- All 7 ABI tests in `src/tests/abi/*.abi.test.ts` (verified by md5: adapter, ierror-handler, ilogger, imonitor, itimer-scheduler, state-persistence-adapter, validate-config) define the contract any port must satisfy.
- Phase-1 carry-forwards (KI-1 dist-tag, knip Node 18 skip, ITimerScheduler.schedule object→TimerToken promotion) are orthogonal but must be surfaced in VAN.

## Upstream Plan Inputs (sourcing per file)

1. `packages/statemachine/docs/zig-port-considerations.md` — TASK-004 deliverable (5 sections; §5 lists 3 Open Questions). **Verified to exist at HEAD `5b9901d`**.
2. `packages/statemachine/etc/statemachine.api.md` — TASK-006 surface snapshot (api-extractor).
3. `packages/statemachine/STABILITY.md` — TASK-006 stability tier policy.
4. `packages/statemachine/src/tests/abi/*.abi.test.ts` — TASK-006 ABI tests, **7 unique files** (md5-verified, F-VAN-C5-1 false-alarm closed).
5. `memory-bank/system/current-context.md` — Phase 1 ARCHIVED state + carry-forwards.

## Open Questions for VAN — 13 items (DA findings F-VAN-C1-1/2/3 add Q-T9-11/12/13)

- **Q-T9-1**: Single-package WASM (statemachine compiled to WASM) vs hybrid (TS host + Zig core via FFI for hot paths)?
- **Q-T9-2**: Zig version (0.15+ stable vs nightly)?
- **Q-T9-3**: WASM target — `wasm32-unknown-none` (raw) vs `wasm32-wasi` (with WASI) vs `wasm32-emscripten`?
- **Q-T9-4**: Memory model — single linear memory shared with JS, or isolated arena per StateMachine instance?
- **Q-T9-5**: Timer host — `ITimerScheduler` shim that calls back into JS for actual `setTimeout`, OR Zig-native timer-wheel for headless WASM contexts?
- **Q-T9-6**: Sourcemaps + debugging — emit `.debug.wasm` with DWARF, OR rely on JS-side trace mapping?
- **Q-T9-7**: Bundle size budget — what's acceptable WASM bundle for the StateMachine core (relative to current 122 KB ESM)?
- **Q-T9-8**: Browser-vs-Node-vs-Deno — does the Zig core need different entry points per host, or one universal?
- **Q-T9-9**: Should Phase 2 keep the TS implementation as the canonical reference, with Zig as opt-in via a feature flag, OR full replacement?
- **Q-T9-10**: Test parity — Zig port must pass the same 7 ABI tests; should we add Zig-side unit tests AS WELL?
- **Q-T9-11** *(new from DA F-VAN-C1-1)*: ABI versioning policy across WASM module rebuilds — hash-pin, semver export, opaque version string, or module-version exports for load-time drift detection? Must resolve before TASK-011 (core types port) designs struct layouts.
- **Q-T9-12** *(new from DA F-VAN-C1-2)*: Panic / trap propagation across the WASM→JS FFI boundary — are Zig panics distinguishable from JS errors? Does a trap leave the WASM module in a usable state, or must the JS wrapper discard and re-instantiate the module? Prerequisite for TASK-013 (EP shims) and TASK-012 (StateMachine core port) IErrorHandler design.
- **Q-T9-13** *(new from DA F-VAN-C1-3)*: Zig allocator strategy (FixedBufferAllocator from a pre-allocated linear-memory region, ArenaAllocator with explicit reset on machine teardown, GeneralPurposeAllocator, or page allocator)? Distinct from Q-T9-4 — Q-T9-4 is memory ownership; Q-T9-13 is allocator choice. Determines whether multiple StateMachine instances coexist in one WASM module instance and whether memory can be freed without destroying the entire module.

## §5 zig-port-considerations.md ↔ Q-T9 mapping (DA finding F-VAN-C5-2 fix)

| zig-port-considerations.md §5 (TASK-004) | Q-T9 counterpart | Notes |
|---|---|---|
| Timer host integration | Q-T9-5 | Direct lift; legacy doc says ITimerScheduler shim is the WASM-friendly path. |
| GC vs manual memory | Q-T9-4 + Q-T9-13 | Legacy frames it as one question; VAN splits into ownership (Q-T9-4) and allocator strategy (Q-T9-13). |
| FFI type-erasure | Q-T9-1 + Q-T9-3 + Q-T9-11 | Single-vs-hybrid (Q-T9-1) + WASM target (Q-T9-3) + ABI versioning (Q-T9-11) all bear on FFI typing. |
| (no §5 source) | Q-T9-2 | Net-new: Zig version pinning; not in TASK-004 because pinning was deferred to Phase 2. |
| (no §5 source) | Q-T9-6 | Net-new: sourcemaps / DWARF; required because TASK-004 documented the WASM-friendly design but not the debug surface. |
| (no §5 source) | Q-T9-7 | Net-new: bundle size budget; cannot be set until WASM target (Q-T9-3) decided. |
| (no §5 source) | Q-T9-8 | Net-new: per-runtime entry points; UR-006 driver. |
| (no §5 source) | Q-T9-9 | Net-new: TS-as-canonical-reference vs full replacement; UR-005 / UR-007 driver. |
| (no §5 source) | Q-T9-10 | Net-new: Zig-side unit tests in addition to ABI parity. |
| (no §5 source) | Q-T9-12 | Net-new from DA F-VAN-C1-2: panic / trap propagation. |

## Initial child-task hypothesis (for CREATIVE refinement)

| Hypothetical task | Tier | Scope | DA notes |
|---|---|---|---|
| TASK-010 Zig toolchain + WASM build pipeline | T3:moderate | install Zig (version pinned per Q-T9-2), scaffold packages/statemachine-zig/, set up build.zig.zon + wasm32 target, smoke-build a hello-world WASM | — |
| TASK-011 Core types port (StateMachineConfig, Transition, State) | T3:moderate | port `@stable` types as Zig structs; design FFI representations grounded in Q-T9-11 ABI versioning | — |
| TASK-012 StateMachine class core port | **T4:standard → T5:epic candidate** | port StateMachine constructor + transition machinery; per-instance state in linear memory; nested/parallel states; adapter integration | DA F-VAN-C2-1 — likely T5:epic; CREATIVE must re-evaluate. If escalated, decompose into TASK-012a (flat core), TASK-012b (nested/parallel regions), TASK-012c (adapter integration). |
| TASK-013 EP shims (IMonitor / ITimerScheduler / IErrorHandler) | T3:moderate | JS-side glue calling into Zig + Zig-side glue calling back to JS; depends on Q-T9-12 panic propagation | — |
| TASK-014 ABI parity tests | T3:moderate | run all 7 ABI tests against the WASM build; ensure `bunx vitest` proves contract parity | — |
| TASK-015 Browser + Node + Deno smoke | T2:quick | extend Tier B CI to exercise WASM build under all 3 runtimes; must work on all CI platforms (R-T9-8) | — |
| TASK-016 Bundle size + perf benchmark | T2:quick | size budget enforcement (Q-T9-7), microbenchmark vs TS | — |

(Subject to revision in CREATIVE; TASK-012 decomposition gated by DA review.)

## DAG (corrected from DA finding F-VAN-C2-2)

```
TASK-010 (A: toolchain)
  └── TASK-011 (B: core types)
        ├── TASK-012 (C: StateMachine core) ──┐
        │                                     │
        └── TASK-013 (D: EP shims) ───────────┤
                                              │
              TASK-014 (E: ABI parity tests) ◄┘  (E depends on BOTH C and D)
                └── TASK-015 (F: multi-runtime smoke)
                      └── TASK-016 (G: bundle + perf)
```

Critical path: A → B → C → E → F → G. Parallel cluster after B: C || D (both depend on B; E waits for both). Matches `orchestration-packet.md` execution timeline.

## Risks (preliminary; full register in CREATIVE) — 9 items (DA findings F-VAN-C3-1/2/3 add R-T9-7/8/9)

- **R-T9-1** Zig 0.15 stable timing — frequent breaking changes; pin version + document. (Q-T9-2 driver.)
- **R-T9-2** WASM-JS FFI cost — every `IMonitor.recordTransition` call crosses the boundary; may need batching. (Q-T9-1, Q-T9-5 drivers.)
- **R-T9-3** Bundle size regression — WASM toolchain output may exceed JS implementation by 2–3×. (Q-T9-7 driver.)
- **R-T9-4** Debugging UX — sourcemaps for WASM are nascent; runtime errors may surface as opaque `trap`s. (Q-T9-6, Q-T9-12 drivers.)
- **R-T9-5** Maintenance burden — dual TS+Zig implementations doubles surface to maintain. (Q-T9-9 driver.)
- **R-T9-6** Browser compat — older Safari/iOS WASM support varies; check `engines` field. (Q-T9-8, UR-006 drivers.)
- **R-T9-7** *(new from DA F-VAN-C3-1)* Zig std / compiler-rt licensing — verify license compatibility of embedded Zig runtime code in distributed WASM artifact. Confirm no additional attribution required in `package.json` / `LICENSE`. Owner: TASK-009 CREATIVE → TASK-010.
- **R-T9-8** *(new from DA F-VAN-C3-2)* CI/CD Zig toolchain platform support — macOS-ARM (aarch64-macos), Linux-x64, and Windows availability for Zig 0.15 binaries; cache strategy (GitHub Actions cache vs direct download); fallback if nightly is required. HIGH-severity blocker for TASK-015 "Tier B CI". Owner: TASK-010.
- **R-T9-9** *(new from DA F-VAN-C3-3)* WASM multi-tenant isolation — a single WASM module instantiated once shares linear memory across all StateMachine instances; multi-tenant Node.js deployments may require one `WebAssembly.Instance` per tenant. Document the isolation guarantee in the Phase 2 design. Owner: TASK-009 CREATIVE.

## Notes for VAN phase

VAN should:
1. Read all 5 inputs end-to-end.
2. Capture current state of `docs/zig-port-considerations.md` Open Questions (§5) and align with Q-T9-1..Q-T9-13 (mapping table above).
3. Confirm Phase 1 closure (`current-context.md` Active Roadmap section).
4. Decide on T5 vs T4 escalation for THIS task (decomposition is heavy; T5:epic confirmed).
5. Surface any Phase-1 carry-forwards that block Phase 2 (KI-1 dist-tag, knip Node 18, ITimerScheduler.schedule object→TimerToken) — operationally orthogonal but document explicitly.
6. Consume the 13 DA findings (7 HIGH, 5 MEDIUM, 1 false-alarm) — closures listed in `## DA Review Reception` below.

## DA Review Reception (VAN-exit advisory — envelope `mb3-critic.review/v2`)

VAN-exit DA review returned VERDICT = REVISE with 13 findings. Per the runtime hook, VAN is a **no-gate phase** (DA clearance not required), so the advisory is captured for record only. Disposition:

| Finding | Closure | Where addressed |
|---|---|---|
| F-VAN-C1-1 (ABI versioning) | CLOSED | Q-T9-11 added above. |
| F-VAN-C1-2 (panic/trap) | CLOSED | Q-T9-12 added above. |
| F-VAN-C1-3 (allocator strategy) | CLOSED | Q-T9-13 added above; §5 mapping splits Q-T9-4 from Q-T9-13. |
| F-VAN-C2-1 (TASK-012 tier) | DEFERRED to CREATIVE | Marked T4→T5 candidate in child-task table + orchestration packet note. |
| F-VAN-C2-2 (DAG inconsistency) | CLOSED | DAG redrawn above + orchestration-packet.md updated to show D as sibling of C, both children of B. |
| F-VAN-C2-3 (no acceptance criteria for TASK-009) | CLOSED | `## Acceptance Criteria for TASK-009` section above. |
| F-VAN-C3-1 (licensing) | CLOSED | R-T9-7 added above. |
| F-VAN-C3-2 (CI/CD platform) | CLOSED | R-T9-8 added above. |
| F-VAN-C3-3 (multi-tenant security) | CLOSED | R-T9-9 added above. |
| F-VAN-C4-1 (cross-project artifactRefs dishonest) | CLOSED | crossProjectLinks rewritten as 3 typed links: TASK-001 continuation (requests only), TASK-004 artifact_source (creative_decisions/tech_spec/implementation/qa/reflect), TASK-006 artifact_source (api_md/stability_md/abi_tests). |
| F-VAN-C5-1 ("7 ABI files" unverified) | FALSE ALARM — closed | md5-verified 7 unique files in `src/tests/abi/`. Critic was misled by case-insensitive heuristics; only lowercase variants exist. |
| F-VAN-C5-2 (§5 ↔ Q-T9 mapping undocumented) | CLOSED | Mapping table above. |
| F-VAN-C5-3 (UR-009 referenced but absent from requests.md) | CLOSED | UR-009 verbatim imported from legacy TASK-001/requests.md; full UR-001..UR-011 carry-forward + UR-012 local. |
