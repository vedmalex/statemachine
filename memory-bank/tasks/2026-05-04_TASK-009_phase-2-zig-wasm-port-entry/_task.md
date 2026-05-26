# TASK-009: Phase 2 entry — zig-wasm-port

- **Profile**: creative-first
- **Tier**: T5:epic
- **QA Level**: MAX
- **Execution Mode**: subagent_driven
- **Status**: in_progress
- **Phase**: CREATIVE
- **Created**: 2026-05-04T13:45:00Z
- **Updated**: 2026-05-04T14:47:54Z
- **Branch**: main

## Scope

- packages/statemachine/**

## Cross-Project Links

- continuation -> /Users/vedmalex/work/grainjs-prod/packages/statemachine :: TASK-001 (Bootstrap standalone statemachine monorepo (TypeScript extraction)) [task_found]
  - Reason: Bootstrap parent for full RM-001 roadmap. UR-001..UR-011 verbatim carry-forward into TASK-009/requests.md (preserved IDs for traceability). UR-009 anticipated this exact follow-up Phase 2 zig-wasm-port task. Phase 1 boundary closed; Phase 2 artifacts authored in this repo only.
  - UR refs: UR-001, UR-002, UR-003, UR-004, UR-005, UR-006, UR-007, UR-008, UR-009, UR-010, UR-011
  - Artifact refs: requests
- artifact_source -> /Users/vedmalex/work/grainjs-prod/packages/statemachine :: TASK-004 (WASM-friendly design and singleton elimination) [task_found]
  - Reason: WASM-friendly design + singleton elimination. Concrete Phase-2 inputs: zig-port-considerations.md (5 sections), IMonitor/ITimerScheduler/IErrorHandler injection contracts, TD-T4-1..TD-T4-8 architectural commitments, singleton-elimination invariant test (4 cases). These artifacts ground the Q-T9-* questions with grep-evidence.
  - UR refs: UR-009
  - Artifact refs: creative_decisions, tech_spec, implementation, qa, reflect
- artifact_source -> /Users/vedmalex/work/grainjs-prod/packages/statemachine :: TASK-006 (API docs, extension-point catalog, examples cookbook, ABI tests) [task_found]
  - Reason: Public surface + ABI contract. Concrete Phase-2 inputs: etc/statemachine.api.md (api-extractor surface snapshot), STABILITY.md (5 firm @stable + @unstable tiers), src/tests/abi/*.abi.test.ts (7 EP ABI tests verified by md5 — the contract any Zig port must satisfy).
  - UR refs: UR-005, UR-007, UR-010
  - Artifact refs: api_md, stability_md, abi_tests

## UR Coverage

> CREATIVE-time status. Authoritative coverage matrix lives in `artifacts/creative-decisions.md` §"UR Coverage Matrix". Final ARCHIVE-time satisfaction tracked when TASK-009 closes.

- [x] UR-001 — SATISFIED (carry-forward from Phase 1 ARCHIVED)
- [x] UR-002 — SATISFIED (carry-forward from Phase 1 ARCHIVED)
- [x] UR-003 — COVERED by TD-T9-1 (`packages/statemachine-zig/` separate package)
- [x] UR-004 — SATISFIED (carry-forward from Phase 1 ARCHIVED)
- [x] UR-005 — COVERED by TD-T9-9 (separate `createMachineZig()` factory; `createMachine()` signature unchanged) + TD-T9-11 (ABI versioning)
- [x] UR-006 — COVERED by TD-T9-2, TD-T9-3, TD-T9-7, TD-T9-8
- [x] UR-007 — COVERED by TD-T9-6, TD-T9-10, TD-T9-11, TD-T9-12 (behavioral parity via TASK-014 + Zig-side `std.testing` MUST)
- [x] UR-008 — COVERED by TD-T9-2 + R-T9-8 closure
- [x] UR-009 — COVERED (PRIMARY DRIVER for all TD-T9-*)
- [x] UR-010 — COVERED by TD-T9-1, TD-T9-5 (EP catalog preserved)
- [ ] UR-011 — PARTIAL (TASK-017 owns final verification; TD-T9-1 carries `PENDING UR-011` marker on Zig package name)
- [x] UR-012 — COVERED (Phase 2 entry decomposition complete)
- [x] UR-013 — COVERED by TigerStyle methodology adoption + ZTB lens registration in `CODING_RULES.md` + `project-config.json`
