# DA Review — TASK-014 — QA — Iteration 1

- Task: TASK-014
- Phase: QA
- Iteration: 1
- Status: rejected
- Verdict: REVISE
- Source: claude-hook
- Review Mode: subagent
- Gate Authority: authoritative
- Timestamp: 2026-06-22T14:01:25.911Z
- Review Schema: mb3-critic.review/v2
- Lens: Coverage
- UR Refs: UR-002, UR-001, UR-003, UR-004, UR-005
- Follow-up Issues: ISS-057, ISS-058, ISS-059, ISS-060

## Follow-up Issues

- ISS-057
- ISS-058
- ISS-059
- ISS-060

## Report

## DA Report:

- Task: TASK-014
- Phase: QA
- Lens: Coverage
- Verdict: REVISE
- Date: 2026-06-22
- Source: claude-hook

### Executive Summary

Spot-checks confirm the AC oracles are genuinely non-vacuous: AC-1 replay canary compares four hashes incl. a throwing invoke action across fake/real timers (replay.test.ts:26-44); AC-2/AC-3 wire the REAL engine and plant+detect violations (faults.test.ts:432-457, invariants.test.ts I-2..I-12 dirty/clean + real-engine I-6/I-10 throws); AC-8 capability gate is teethed with a real negative proof (capabilities_gap_pin.test.ts:74-114) and drift/false-cover guards (coverage.test.ts), with the 7 documented gaps each justified structurally in tech_spec sim-api §11. Skip-tiering is honest: the six SM_SIM-gated files are exactly the heavy/build-artifact/subprocess legs (tsc spawn, perf sweep, dist-byte read, nightly shards, PR-fast + coverage CLI subprocesses); every AC has an ungated oracle and the gate LOGIC itself is tested ungated via computeCoverage. Determinism (AC-1/AC-10) is canary-proven and grep-enforced ungated. REVISE is driven by ONE genuine coverage gap on a headline user goal: the fault/generator-driven found-failing-trace -> shrink -> re-executing public ./sim repro chain is proven only in decomposed/synthetic links and never end-to-end (F-Q-1, HIGH -> UR-002 PARTIAL), with the AC-4 evidence row over-claiming relative to that reality (F-Q-2, MEDIUM). Resolve by landing one end-to-end test (or honestly downgrading the AC-4 claim + explicit REFLECT carry-forward), then re-run the DA gate. LOW items F-Q-3 (empty qa.md stub) and F-Q-4 (ISS-055 CODE_REVIEW carry-forward) are advisory carry-forwards and do not themselves block.

### UR-Goal Traceability

| UR-ID | Goal | Status | Evidence |
|---|---|---|---|
| UR-001 | VOPR-style DST: real engine in a controlled deterministic env, seed-driven, bit-exact replay, faults, Safety+Liveness, shrinker, CI | COVERED | replay.test.ts four-run canary (incl. throw fault) + 16-seed reproducibility; faults.test.ts wires the REAL engine (throw observed at boundary :432-457); invariants.test.ts plants I-2..I-12 dirty/clean pairs + real-engine I-6/I-10 throws; liveness.test.ts STUCK/PROGRESSED; ci-gating.test.ts nightly structure. All UNGATED. |
| UR-002 | Bug-hunting via fault-injection: a FOUND failing trace (from generator+faults) is auto-shrunk to a minimal reproducer that re-fails | PARTIAL | ddmin proven with synthetic structure-deterministic runners (shrinker.test.ts); public Safety path fires+re-fires a PLANTED USER invariant via runSimulation/Simulator.step (public_invariants.test.ts); emitted *.repro parses/public-only/flush-free + JSON re-fails fingerprint (repro-codegen.test.ts, repro-artifact.test.ts). GAP: no end-to-end test where the GENERATOR/FAULT layer produces a REAL engine violation that is shrunk and whose emitted *.repro.test.ts is EXECUTED and re-fails through public ./sim. Generated scenarios are correct-by-construction with faults STUBBED EMPTY (define.ts:16,346), so a fault-driven found-failing-trace -> shrink -> re-executing-repro chain is never exercised whole; defaultShrinkRunner is only smoke-tested on a CLEAN scenario (shrinker.test.ts:722-741). |
| UR-003 | Deterministic debug + load/stress perf environment; consumer-constructible | COVERED | public_sim_surface.test.ts wire()/runSimulation/Simulator.step/snapshot + deterministic ping-pong; metrics.test.ts perf plane (median-of-N bands, traceLen zero-tolerance, two-sided baseline) ungated; heavy perf gated SM_SIM (metrics.perf.test.ts) by design. |
| UR-004 | Cover ALL machine capabilities + mandatory programmatic gate + declarative registry | COVERED | coverage.test.ts drives full registry (DoD5), drift detection (:87-114), hand-marked status cannot falsely cover (:153-181), probe purity (no live engine read, errorClass-keyed); capabilities_gap_pin.test.ts deep-equal pins 7 gaps + NEGATIVE proof (remove covering scenario -> exit 1, :74-114). Gate is genuinely teethed and ungated. |
| UR-005 | Internal + public @unstable ./sim entry; core ABI/bundle byte-stability; perf thresholds; coverage gate; full 7-kind fault set | COVERED | public_sim_surface.test.ts presence+banned-internals ratchet (ungated); FaultKind exactly 7 literals closed union (faults.test.ts:67-78); dist byte-guard correctly gated SM_SIM (needs built dist) with surface presence proven ungated; ci-gating.test.ts verifies separate ./sim wiring + api:check:sim. |

### Phase-Specific Challenges

- [HIGH] AC-4 fault-driven found-failing-trace -> shrink -> re-executing repro is not tested end-to-end (UR-002 sub-goal PARTIAL)
  - Challenge: The headline UR-002 capability ('a FOUND failing trace is auto-minimized to a minimal reproducer that re-fails') is proven only in decomposed links, never as one whole chain driven by a REAL engine/fault violation. shrinker.test.ts proves ddmin only via SYNTHETIC structure-deterministic runners; defaultShrinkRunner (real runScenario+runSafety) is exercised ONLY on a CLEAN, non-failing generated scenario (shrinker.test.ts:722-741, comment line 728 'faults stubbed empty in Step 4'). repro-codegen.test.ts:187-190 confirms the emitted repro uses a 'codegen-shape fixture, NOT an engine violation' and the oracle runs CLEAN (expect(v).toBeNull()). public_invariants.test.ts DoD-9b (:196-220) re-runs runSimulation with a freshly-constructed PLANTED USER invariant on a hand-written 3-state machine -- it does NOT execute the emitted *.repro.test.ts and does NOT originate from the generator/fault layer. repro-artifact.test.ts:14-18 explicitly uses a synthetic keepRunner ('no engine run needed') and never executes the emitted file. Root cause: generated scenarios are correct-by-construction with faults STUBBED EMPTY (define.ts:16,346), so the generator cannot emit a violating scenario in v1.
  - Alternative: Add ONE ungated end-to-end test that: (a) constructs a scenario that genuinely violates a real INVARIANT via the public ./sim path (e.g. drive a fault-injected or corrupt-state-probed scenario, or a generated scenario carrying a non-empty FaultPlan, to a real Violation), (b) shrinks it through defaultShrinkRunner, (c) emits the *.repro via emitReproTest, and (d) EXECUTES the emitted source (transpile+eval or vitest-in-vitest) so the SAME fingerprint re-fails through @vedmalex/statemachine/sim. If v1 genuinely cannot generate a fault-driven violation, instead (i) narrow the AC-4 evidence wording to the decomposed reality and (ii) register the fault-driven-found-trace end-to-end repro as an explicit, rationaled REFLECT carry-forward ISS so the UR-002 sub-goal status is honestly PARTIAL rather than asserted PASS.
  - Risk: The single most user-visible DST promise (bug-hunting: find a failure, auto-shrink it, hand back a runnable reproducer) could silently regress at the integration seam (generator/fault -> shrink -> emitted-file execution) without any test failing, because every individual link is mocked or planted. A consumer following the emitted *.repro.test.ts could find it does not actually reproduce, and CI would stay green.
  - Ref: src/tests/sim/shrinker.test.ts:722; src/tests/sim/public_invariants.test.ts:196; src/tests/sim/repro-codegen.test.ts:187; src/tests/sim/repro-artifact.test.ts:14; src/sim/define.ts:346
- [MEDIUM] AC-4 qa-evidence row over-claims relative to the decomposed test reality
  - Challenge: The QA artifact AC-4 row (qa.evidence.jsonl line 3) asserts PASS for 'shrinker MinimalRepro re-fails via public ./sim' citing 'repro-codegen replays through public runSimulation w/ frozen INVARIANTS; public_invariants.test.ts DoD-9b'. But repro-codegen.test.ts replays through the INTERNAL runScenario on a non-violating scenario (DoD-9a, :173-191), and public_invariants DoD-9b re-fires a planted user invariant rather than a MinimalRepro produced by the shrinker. No test demonstrates a shrinker-produced MinimalRepro re-failing via the public entry.
  - Alternative: Reword the AC-4 evidence to state precisely what is proven (ddmin in isolation + public Safety path fires/re-fires a planted invariant + emitted-repro shape/JSON-fingerprint), and either land the end-to-end test in F-Q-1 or carry the integration link explicitly. Keep the AC table honest so PROCEED is not granted on a wording gap.
  - Risk: An over-claimed AC row erodes the audit value of the QA artifact and can mask the F-Q-1 integration gap from downstream phases.
  - Ref: memory-bank/tasks/2026-06-22_TASK-014_*/qa.evidence.jsonl (AC-4 row)
- [LOW] Canonical qa.md is an empty materialized stub (evidence lives only in qa.evidence.jsonl)
  - Challenge: memory-bank/tasks/2026-06-22_TASK-014_*/qa.md carries materialized_stub:true with EMPTY Test Results / Verification Evidence / Residual Risks / Sign-off and ALL UR checkboxes unchecked. The substantive QA evidence exists only in the qa.evidence.jsonl event stream. A reader opening the canonical artifact sees nothing.
  - Alternative: Materialize the qa.md from the evidence stream (or confirm the renderer does so at phase close) before CODE_REVIEW so the canonical artifact reflects the re-executed evidence and UR coverage.
  - Risk: Audit/handoff confusion; the canonical artifact appears unfilled despite passing QA.
  - Ref: memory-bank/tasks/2026-06-22_TASK-014_vopr-style-dst-simulator-for-the-state-m/qa.md
- [LOW] ISS-055 settle QUIET_FLUSH margin test is a legitimate CODE_REVIEW carry-forward, not a QA AC hole
  - Challenge: settle.test.ts contains no QUIET_FLUSH / ISS-055 margin assertion (grep clean). The qa evidence carries ISS-055 (settle QUIET_FLUSH=16 margin + deferred-timer rationale) to CODE_REVIEW/REFLECT. Confirmed this does not block any AC-1..AC-10 oracle; the settle primitive's determinism/single-pump is covered (settle.test.ts DoD1/2/3, DEFAULT_MAX_TURNS=1024).
  - Alternative: Track ISS-055 as an open da_finding carry-forward to CODE_REVIEW; no QA action required.
  - Risk: None to QA coverage; deferred robustness margin only.
  - Ref: src/tests/sim/settle.test.ts

### Verdict

**REVISE**

Spot-checks confirm the AC oracles are genuinely non-vacuous: AC-1 replay canary compares four hashes incl. a throwing invoke action across fake/real timers (replay.test.ts:26-44); AC-2/AC-3 wire the REAL engine and plant+detect violations (faults.test.ts:432-457, invariants.test.ts I-2..I-12 dirty/clean + real-engine I-6/I-10 throws); AC-8 capability gate is teethed with a real negative proof (capabilities_gap_pin.test.ts:74-114) and drift/false-cover guards (coverage.test.ts), with the 7 documented gaps each justified structurally in tech_spec sim-api §11. Skip-tiering is honest: the six SM_SIM-gated files are exactly the heavy/build-artifact/subprocess legs (tsc spawn, perf sweep, dist-byte read, nightly shards, PR-fast + coverage CLI subprocesses); every AC has an ungated oracle and the gate LOGIC itself is tested ungated via computeCoverage. Determinism (AC-1/AC-10) is canary-proven and grep-enforced ungated. REVISE is driven by ONE genuine coverage gap on a headline user goal: the fault/generator-driven found-failing-trace -> shrink -> re-executing public ./sim repro chain is proven only in decomposed/synthetic links and never end-to-end (F-Q-1, HIGH -> UR-002 PARTIAL), with the AC-4 evidence row over-claiming relative to that reality (F-Q-2, MEDIUM). Resolve by landing one end-to-end test (or honestly downgrading the AC-4 claim + explicit REFLECT carry-forward), then re-run the DA gate. LOW items F-Q-3 (empty qa.md stub) and F-Q-4 (ISS-055 CODE_REVIEW carry-forward) are advisory carry-forwards and do not themselves block.
