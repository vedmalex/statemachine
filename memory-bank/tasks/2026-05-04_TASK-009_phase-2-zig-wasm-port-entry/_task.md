# TASK-009: Phase 2 entry — zig-wasm-port (RM-001-P02)

- **Profile**: creative-first
- **Tier**: T5:epic (escalation candidate — Phase 2 entry covers planning + scope decomposition; sub-tasks will be authored as TASK-010+)
- **QA Level**: MAX
- **Execution Mode**: subagent_driven
- **Status**: pending (VAN ready)
- **Phase**: VAN
- **Created**: 2026-05-04
- **Parent**: TASK-001 (RM-001 Statemachine Standalone Evolution)
- **Continues**: RM-001-P02 zig-wasm-port (Phase 2 entry)
- **Carry-forward UR refs**: UR-001 (umbrella), UR-009 (WASM/Zig portability)
- **Continuation reason**: Phase 2 entry decomposes the zig-wasm-port goal into actionable child tasks. Inputs: `packages/statemachine/docs/zig-port-considerations.md` (TASK-004 deliverable) + `etc/statemachine.api.md` (TASK-006 surface snapshot) + STABILITY.md (Phase 1 contract).

## Scope (Phase 2 entry — this task)

This is the **planning + decomposition** task for Phase 2. Concrete porting work happens in child tasks (TASK-010+). This task delivers:

- Phase 2 program-level CREATIVE decisions (target Zig version, WASM ABI strategy, timer-host shape, FFI typing, build pipeline)
- Decomposition into 4–6 child tasks with named tier + dependency DAG
- Updated orchestration packet for `mb3-smart-executor` if the operator wants automated execution
- Risk register specific to Zig/WASM (memory model, GC bridging, sourcemaps, debugging)

## Out of scope (deferred to TASK-010+)

- Actual Zig source files
- WASM module compilation
- Per-EP shim implementations (IMonitor / ITimerScheduler / IErrorHandler bridging)
- Performance benchmarking vs JS implementation
- Browser smoke for the WASM build

## Inputs

1. `/Users/vedmalex/work/statemachine/packages/statemachine/docs/zig-port-considerations.md` — TASK-004 architectural commitments (5 sections)
2. `/Users/vedmalex/work/statemachine/packages/statemachine/etc/statemachine.api.md` — public surface snapshot (api-extractor)
3. `/Users/vedmalex/work/statemachine/packages/statemachine/STABILITY.md` — stability tier policy (5 firm @stable + @unstable)
4. `/Users/vedmalex/work/statemachine/packages/statemachine/src/tests/abi/*.abi.test.ts` — 7 EP ABI test files (contracts the Zig port must satisfy)
5. Phase 1 ARCHIVED state: `/Users/vedmalex/work/statemachine/memory-bank/system/current-context.md`

## Open questions for VAN

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

## Initial child-task hypothesis (for CREATIVE refinement)

| Hypothetical task | Tier | Scope |
|---|---|---|
| TASK-010 Zig toolchain + WASM build pipeline | T3:moderate | install Zig, scaffold packages/statemachine-zig/, set up build.zig.zon + wasm32 target, smoke-build a hello-world WASM |
| TASK-011 Core types port (StateMachineConfig, Transition, State) | T3:moderate | port `@stable` types as Zig structs; design FFI representations |
| TASK-012 StateMachine class core port | T4:standard | port StateMachine constructor + transition machinery; per-instance state in linear memory |
| TASK-013 EP shims (IMonitor / ITimerScheduler / IErrorHandler) | T3:moderate | JS-side glue calling into Zig + Zig-side glue calling back to JS |
| TASK-014 ABI parity tests | T3:moderate | run all 7 ABI tests against the WASM build; ensure `bunx vitest` proves contract parity |
| TASK-015 Browser + Node + Deno smoke | T2:quick | extend Tier B CI to exercise WASM build under all 3 runtimes |
| TASK-016 Bundle size + perf benchmark | T2:quick | size budget enforcement, microbenchmark vs TS |

(Subject to revision in CREATIVE.)

## Dependencies

- TASK-001 (parent)
- RM-001-P01 closed (TASK-002..008 ARCHIVED)
- Phase 2 entry decision by operator (THIS TASK)

## Risks (preliminary; full register in CREATIVE)

- R-T9-1: Zig 0.15 stable timing — Zig has frequent breaking changes; pin version + document
- R-T9-2: WASM-JS FFI cost — every `IMonitor.recordTransition` call crosses the boundary; may need batching
- R-T9-3: Bundle size regression — WASM toolchain output may exceed JS implementation by 2–3×
- R-T9-4: Debugging UX — sourcemaps for WASM are nascent; runtime errors may surface as opaque "trap"s
- R-T9-5: Maintenance burden — dual TS+Zig implementations doubles surface to maintain; choose carefully
- R-T9-6: Browser compat — older Safari/iOS WASM support varies; check engines field

## Notes for VAN phase

VAN should:
1. Read all 5 inputs above end-to-end
2. Capture current state of `docs/zig-port-considerations.md` Open Questions (§5) and align with Q-T9-1..Q-T9-10
3. Confirm Phase 1 closure (`current-context.md` Active Roadmap section)
4. Decide on T5 vs T4 escalation for THIS task (decomposition is heavy; suggest T5)
5. Surface any Phase-1 carry-forwards that block Phase 2 (KI-1 dist-tag, knip Node 18) — most are operationally orthogonal but document explicitly

After VAN clears, CREATIVE owns the program-level decisions; PLAN authors the child-task DAG; TECH_SPEC pins the build pipeline; IMPLEMENT spawns children as separate MB3 tasks (TASK-010+).
