# Orchestration Packet — RM-001 Phase 2 (zig-wasm-port)

This packet drives Phase 2 entry decomposition. It is the canonical input for `mb3-smart-executor` if/when the operator decides to run Phase 2 in subagent_driven mode.

## Identity + Vocabulary

- **Program**: Statemachine Standalone Evolution (RM-001)
- **Phase scope of this packet**: Phase 2 only — `RM-001-P02 zig-wasm-port`. Phase 3 (mb3-dsl-adoption) and Phase 4 (grainjs-prod-migration) are out of scope.
- **Parent task**: TASK-009 (Phase 2 entry; T5:epic candidate)
- **Children** (CREATIVE-locked; PLAN finalizes tiers and per-task ACs):
  - TASK-010 Zig toolchain + WASM build pipeline (T3) — **dual outputs**: native Zig lib + `wasm32-unknown-none` artefact
  - TASK-011 Core types port (T3) — public Zig API + WASM extern surface; exports `abi_version`
  - TASK-012 StateMachine class core port (**T4 candidate, T5 likely** — DA F-VAN-C2-1; PLAN re-evaluates and decomposes if T5)
  - TASK-013 EP shims (T3) — JS host implements IMonitor/ITimerScheduler/IErrorHandler; consumer A only
  - TASK-014 ABI parity tests (T3) — TASK-014a WASM extern + TASK-014b Zig native bindings (consumer B parity)
  - TASK-015 Multi-runtime smoke (T2) — Bun, Node 20+, Browser (Safari iOS), Deno/Edge
  - TASK-016 Bundle size + perf benchmark (T2) — `etc/wasm-size.txt` ratchet at +50% over baseline
  - TASK-017 Zig package publishing (T3) — `build.zig.zon` registry / git tag; semver-align with npm `@vedmalex/statemachine`; UR-011 name verification

**Dual-consumer model (TD-T9-1)**: Single Zig source produces TWO artefacts — npm tarball with `.wasm` (consumer A: TS host via WASM) + Zig package (consumer B: other Zig projects via Zig package manager). Both consumers exercise the same 7 ABI tests for parity.
- **Vocabulary alignment**: lifecycle phases (VAN..ARCHIVE) per MB3 topology. Authoritative DA actor remains `mb3-critic`.

## Scope + Binding

- **Roadmap binding**: RM-001 Phase 2 (RM-001-P02 `zig-wasm-port`).
- **Project binding**: `/Users/vedmalex/work/statemachine/` — the standalone monorepo (post-Phase-1 closure).
- **MB3 work tree**: `/Users/vedmalex/work/statemachine/memory-bank/` (NOT the legacy grainjs-prod tree; D15 bifurcation is closed post-TASK-008).
- **UR coverage** (TASK-009 inherits): UR-001 (umbrella), UR-009 (WASM/Zig portability). Other URs (002/005/007/008/010/011) inherited via Phase 1 closure as constraints — Phase 2 must NOT regress them.
- **Out of scope** (per Phase 2 stop scope):
  - Phase 3 MB3 DSL adoption
  - Phase 4 grainjs-prod consumer migration
  - Public extraction of `@vedmalex/di-ioc` (D6 — deferred)

## Execution Model

### Execution mode

**`subagent_driven`** — each child task dispatched to a fresh subagent for IMPLEMENT. Independent children fan out in parallel; main agent retains orchestrator role. Same as Phase 1 model.

### Dependency graph (DAG, hypothetical — refined in CREATIVE)

```
TASK-010 Zig toolchain + WASM build (A) — dual output: native lib + .wasm
  └── TASK-011 Core types port (B) — public Zig API + abi_version export
        ├── TASK-012 StateMachine core (C) ──┐
        │                                    │
        └── TASK-013 EP shims (D) ───────────┤
                                             │
              TASK-014 ABI parity tests (E) ◄┘   (E waits for both C and D)
                └── TASK-015 Multi-runtime smoke (F)
                      └── TASK-016 Bundle + perf (G)
                            └── TASK-017 Zig package publishing (H)
```

Critical path: A → B → C → E → F → G → H. Parallel cluster after B: C || D (both depend on B; E waits for both).

> **Note (DA finding F-VAN-C2-2 fix)**: D was previously drawn as a child of C; corrected to show D as a sibling of C, both depending on B. Cluster C dispatch instructions in §`Execution timeline` (TASK-012 + TASK-013 parallel after B.ARCHIVE) match this corrected DAG.

> **Note (DA finding F-VAN-C2-1)**: TASK-012 is currently sized as T4:standard but PLAN must re-evaluate as a likely T5:epic candidate. If escalated, TASK-012 should be decomposed into sub-tasks (TASK-012a flat-state core, TASK-012b nested/parallel state regions, TASK-012c adapter integration) before subagent dispatch.

> **Note (TASK-017 added — operator decision 2026-05-04)**: 7th child for Zig package publishing (consumer B path). Sequential after TASK-016 — size+perf measured before public release; semver alignment with npm `@vedmalex/statemachine`; UR-011 name verification.

### Stop conditions

- **Hard stop**: after TASK-016 (or final child) ARCHIVE if all child tasks close cleanly. Phase 2 closure requires:
  1. WASM build artifacts shipped
  2. ABI parity (all 7 EP tests pass against WASM build)
  3. Multi-runtime smoke green
  4. Bundle size within budget (TBD in CREATIVE)
  5. Documentation updated (`docs/zig-port-considerations.md` graduates from "design" to "implementation guide")
- **Soft stop / human-input required**:
  - Any DA gate REVISE on a structural decision (e.g., Zig version choice)
  - Bundle size exceeding 2× the JS implementation
  - ABI parity test failure that requires public-API change (would trigger SemVer major or pre-release amendment)
  - WASM build infeasibility on a target runtime (Browser/Deno/Node mismatch)

### DA gate handling

- **Auto-advance on PROCEED**: each gated phase exit (CREATIVE, PLAN, TECH_SPEC, QA, CODE_REVIEW, REFLECT) auto-runs `mb3-critic` and auto-transitions on PROCEED.
- **Stop on REVISE/BLOCK**: orchestrator halts the affected child branch; surfaces report.
- **Function gate `taskDecompose`**: cleared when CREATIVE/PLAN of TASK-009 produces the final child set.

## Review References

- **Authoritative DA actor**: `mb3-critic` (only actor that clears DA gates).
- **Lenses by phase**:
  - CREATIVE: `Design Integrity + UR-Goal Traceability`
  - PLAN: `Completeness + UR-Goal Traceability`
  - TECH_SPEC: `Justification`
  - QA: `Coverage`
  - CODE_REVIEW: `Sustainability`
  - REFLECT: `Honesty`
- **Advisory actors**: `mb3-architect` (DQS at structural decisions), `mb3-lever` (reuse / boundary-choice for the WASM bridge).

## Acceptance + Continuation

### Acceptance for this orchestration

The packet is acceptable for handoff to `mb3-smart-executor` when ALL of these hold:
1. RM-001 + RM-001-P02 + TASK-009 are bound (verified post-VAN).
2. TASK-009 CREATIVE/PLAN authors the child decomposition (TASK-010..016 or final shape).
3. `taskDecompose` function gate cleared via authoritative `mb3-critic` review.
4. Each child has parent: TASK-001 (or TASK-009), parentUrRefs populated, continuationReason string.
5. Stop condition explicit (above).

### Continuation policy

- **In-flow continuation** (within Phase 2): orchestrator dispatches the next runnable cluster on cluster-join unless a stop condition fires.
- **Post-Phase-2 continuation**: when final child ARCHIVES, orchestrator stops and reports to operator. Phase 3 (RM-001-P03) is NOT auto-started.
- **Failure continuation**: BLOCK halts the program; REVISE blocks only the affected branch; sibling branches continue if independent.

## Operator Summary

What will happen when this packet is handed to `mb3-smart-executor`:

1. **TASK-009 VAN → CREATIVE → PLAN execution** (no children yet): authors child decomposition, gets `taskDecompose` function gate clearance from `mb3-critic`.
2. **Cluster A dispatch** (after TASK-009 PLAN): TASK-010 Zig toolchain + WASM build pipeline (single, no parallel siblings).
3. **Cluster B dispatch** (after A.ARCHIVE): TASK-011 core types port.
4. **Cluster C dispatch** (after B.ARCHIVE): TASK-012 StateMachine core port + TASK-013 EP shims (parallel).
5. **Cluster D dispatch** (after C+D.ARCHIVE): TASK-014 ABI parity tests.
6. **Cluster E dispatch** (after E.ARCHIVE): TASK-015 multi-runtime smoke.
7. **Cluster F dispatch** (after F.ARCHIVE): TASK-016 bundle + perf benchmark.
8. **Stop**: orchestrator halts after final ARCHIVE. Operator receives summary. Phase 3 NOT auto-started.

Approximate timeline: 5–14 days end-to-end, depending on Zig 0.15 stable timing and developer Zig fluency.

## Open Questions (carry-forward to TASK-009 CREATIVE)

- Q-T9-1..Q-T9-10 from `_task.md` Open questions section.
- All other questions from `docs/zig-port-considerations.md` §5 (timer host, GC vs manual memory, FFI type-erasure).

## End of packet

This packet is a **starter** — TASK-009 CREATIVE/PLAN refines the child set, locks risk register, and produces the final orchestration packet for handoff to `mb3-smart-executor`.
