# Orchestration Packet — RM-001 Phase 2 (zig-wasm-port)

This packet drives Phase 2 entry decomposition. It is the canonical input for `mb3-smart-executor` if/when the operator decides to run Phase 2 in subagent_driven mode.

## Identity + Vocabulary

- **Program**: Statemachine Standalone Evolution (RM-001)
- **Phase scope of this packet**: Phase 2 only — `RM-001-P02 zig-wasm-port`. Phase 3 (mb3-dsl-adoption) and Phase 4 (grainjs-prod-migration) are out of scope.
- **Parent task**: TASK-009 (Phase 2 entry; T5:epic candidate)
- **Children** (CREATIVE-locked; PLAN finalizes per-task ACs):
  - TASK-010 Zig toolchain + WASM build pipeline (T3) — **single `wasm32-unknown-none` target** (TD-T9-3) + native targets for consumer B
  - TASK-011 Core types port (T3) — public Zig API + WASM extern surface; exports `abi_version`; `comptime assert(@sizeOf(...))` on all wire-format structs (TigerStyle ZTB-Zig Z4)
  - TASK-012 StateMachine class core port — **T4:large baseline; escalates to T5:epic on ANY of (a) Zig port > 700 lines, (b) ≥2 distinct concurrency patterns in one file, (c) PLAN cannot fit in single document ≤ ~400 lines**. On escalation: TASK-012a (flat core + transitions), TASK-012b (nested/parallel regions), TASK-012c (adapter integration). PLAN owns the trigger evaluation.
  - TASK-013 EP shims (T3) — JS host implements IMonitor/ITimerScheduler/IErrorHandler; **IMonitor batching ring buffer (TD-T9-14)**; consumer A path
  - TASK-014 ABI + behavioural parity tests (T3) — three layers all MUST: (a) 7 structural ABI tests against WASM; (b) full TS test suite rerun via `createMachineZig` symbol-swap; (c) Zig-side `std.testing` unit tests for comptime invariants + internals
  - TASK-015 Multi-runtime smoke (T2) — Bun, Node 20+, Browser (Safari iOS), Deno/Edge
  - TASK-016 Bundle size + perf benchmark (T2) — **hard budget 250 KB total** (200 KB raw `.wasm` + 50 KB JS shim) + 150% baseline ratchet
  - TASK-017 Zig + npm package publishing (T3) — publish `@vedmalex/statemachine-zig` to npm + Zig package to registry/git tag; **UR-011 name verification BEFORE first publish** (both names PENDING)

**Dual-consumer model (TD-T9-1 + TD-T9-9, reformulated 2026-05-26)**: Single Zig source produces TWO artefacts. Consumer A (TS host via WASM) is reached via **separate npm package `@vedmalex/statemachine-zig` exporting `createMachineZig()`** — the canonical `@vedmalex/statemachine.createMachine()` signature is unchanged from 1.0.0-beta.1 (UR-005 honoured strictly). Consumer B (Zig direct) uses Zig package manager. Both consumers exercise the structural ABI tests + Zig-side unit tests; behavioural parity owned by TASK-014b symbol-swap.

**Methodology (UR-013, adopted 2026-05-26)**: TigerStyle + ZTB lens active across all children. `mb3-critic` envelopes carry `+ ZTB` suffix on IMPLEMENT / QA / CODE_REVIEW gates. See `memory-bank/system/CODING_RULES.md` §Methodology.
- **Vocabulary alignment**: lifecycle phases (VAN..ARCHIVE) per MB3 topology. Authoritative DA actor remains `mb3-critic`.

## Scope + Binding

- **Roadmap binding**: RM-001 Phase 2 (RM-001-P02 `zig-wasm-port`).
- **Project binding**: `/Users/vedmalex/work/statemachine/` — the standalone monorepo (post-Phase-1 closure).
- **MB3 work tree**: `/Users/vedmalex/work/statemachine/memory-bank/` (NOT the legacy grainjs-prod tree; D15 bifurcation is closed post-TASK-008).
- **UR coverage** (TASK-009 inherits): UR-001 (umbrella), UR-009 (WASM/Zig portability), UR-013 (TigerStyle + ZTB methodology, adopted 2026-05-26). Other URs (002/005/007/008/010/011) inherited via Phase 1 closure as constraints — Phase 2 must NOT regress them. UR-005 (API stability) is honoured by TD-T9-9 reformulation: Zig opt-in via separate package `@vedmalex/statemachine-zig`, not via `createMachine()` flag.
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

> **Note (DA finding F-VAN-C2-1, resolved 2026-05-26)**: TASK-012 baseline tier is **T4:large** with explicit escalation trigger to **T5:epic** on ANY of: (a) Zig port exceeds 700 lines (~10× TigerStyle 70-line cap × ~10 functions), (b) ≥2 distinct concurrency patterns required in a single file (flat + nested + parallel + adapter), (c) PLAN cannot author the full plan in ≤ ~400 lines of `plan.md`. PLAN owns trigger evaluation; on escalation, decompose into TASK-012a (flat core + transition machinery), TASK-012b (nested/parallel state regions), TASK-012c (adapter integration) before subagent dispatch.

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
