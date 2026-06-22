# TASK-014 — PLAN: VOPR-style DST Environment for `@vedmalex/statemachine`

## Preamble

> Tier **T4:standard** · profile creative-first · QA MAX · continuation of TASK-013 (clock/scheduler seam) + TASK-012 (composite-region semantics). Roadmap RM-001-P03.

This is the canonical PLAN deliverable. The full detail lives in two attached artifacts:
- **Design plan** — `artifacts/dst-simulation-plan.md` (per-dimension design, capability registry, leak §5.1).
- **Ratified architecture (ADR-1..ADR-8)** — `artifacts/creative-dst-architecture.md` (CREATIVE DA-cleared PROCEED).
- **Authoritative build plan** — `artifacts/build-plan.md` (11 ADR-conformant steps, Plan→ADR reconciliation R1..R24, per-step Definition-of-Done, critical path, TECH_SPEC-deferred items).

---

## UR coverage (canonical traceability)

### UR-001 — VOPR-style DST simulator for the state machine (continuation of TASK-013)
COVERED by the whole architecture: ADR-1..ADR-8 + the 11-step build plan, built on the TASK-013 clock/scheduler DI seam (`state_machine.ts:154-156`, `scheduler.ts`) and TASK-012 region semantics. Seed-driven generator (Step 4), fault injection (Step 5), Safety+Liveness (Step 6), shrinker (Step 7), long-running CI (Step 11).

### UR-002 — real engine, seed→bit-exact replay, faults at event-queue/scheduler/callback, Safety+Liveness, shrinker, long-running CI
COVERED: ADR-1 content-only canonical trace + `hashTrace` (Step 1); ADR-2 frozen splitmix64/bigint PRNG (Step 1); ADR-3 DI leak-neutralization + Adapter-write capture seam (Step 2); ADR-4 single `settleMacrostep` quiescence primitive (Step 3); ADR-5 seven-kind fault taxonomy across the three adapted seams (Step 5); ADR-6 Safety invariants I-1..I-12 + Liveness oracle + first-violation-wins (Step 6); shrinker ddmin (Step 7); nightly seed-sweep (Step 11). **AC-1** four-run replay canary (action-throw + snapshot/restore) is the executable bit-exact proof.

### UR-003 — simulation ENVIRONMENT: load/stress testing + deterministic debugging of new features; constructible for consumer machines
COVERED: Step 8 perf/load plane (throughput via hrtime, heap, trace-length distribution, queueDepthPeak); Step 10 public `wire(env,config,owner)` + `runSimulation` for arbitrary consumer machines; Step 7 `MinimalRepro` (JSON + runnable `*.repro.test.ts`) as a deterministic debug fixture. Carry-forward F-PF-1 (ISS-040): add a falsifiable acceptance bullet demonstrating the seed→deterministic-step-trace debug workflow.

### UR-004 — cover ALL functionality; MANDATORY programmatic coverage gate; declarative/extensible; single T4 task
COVERED: ADR-8 closed-union `CapabilityId` + total `Record` (remove-one-entry-tsc-fails teeth) + errorClass-keyed pure trace-probes + `computeCoverage` CI gate failing on any uncovered capability or drift (Step 9); ADR-6 declarative blind-iterated `Invariant` registry (Step 6). "ALL functionality" honestly scoped as registry-scoped (committed `etc/sim-capabilities.txt` key-set snapshot + PR-template process gap, ISS-033/OQ#5). Single T4 task with a detailed plan, no child decomposition (per this UR's tier decision).

### UR-005 — BOTH internal harness AND public `./sim` entry (API stability + bundle budget + ABI); stress+perf with CI regression thresholds; programmatic coverage gate; full v1 fault set
COVERED: ADR-7 separate `./sim` @unstable entry (2nd tsup entry + exports key + 2nd api-extractor report `etc/statemachine-sim.api.md`), core `.` + `dist/index.{js,cjs}` BYTES unchanged (new dist byte/hash guard; `splitting:false` accepted) (Step 10); Step 8 perf regression bands (throughput 20% / mem 25% / p99 30% + traceLen zero-tolerance, median-of-N=5); Step 9 coverage gate; ADR-5 full v1 fault set = reorder/drop/dup + guard/action/callback throw + clock-skew + timer-jitter + overflow (UR-005.4 exactly).

---

## Implementation sequence (11 steps; critical path 1→2→3→5→6→7→9→10→11, Step 8 parallel off {1,2,3,4})

1. PRNG + trace + clock determinism substrate (`prng.ts`, `trace.ts`, `clock.ts`).
2. Deterministic DI components + Adapter-write capture seam (`sim-monitor.ts`, `sim-error-handler.ts`, `noop-logger.ts`, `capture.ts`).
3. Driver: single `settleMacrostep` converged primitive + step loop + mandatory post-construction drain (`driver.ts`, `settle.ts`, `env.ts`).
4. Scenario generator: correct-by-construction config + closed-loop op stream, closure-free literal guards, stable op-ids (`scenario.ts`, `topology.ts`, `ops.ts`, `define.ts`).
5. Fault layer: seven-kind taxonomy + `inFlightAsyncCount` wrapper + `FaultRecord` (`faults.ts`, `harness.ts`, `observable-scheduler.ts`).
6. Invariants + Liveness + Fairness: I-1..I-12 + 8th harness-only corrupt-state probe + cycle detector (`invariants.ts`, `liveness.ts`, `fairness.ts`).
7. Shrinker + repro codegen: ddmin M0-M5 + fingerprint predicate + `MinimalRepro` (`shrinker.ts`, `repro-codegen.ts`).
8. Perf/load metrics plane: hrtime throughput + heap + median-of-N regression + committed baseline (`metrics.ts`).
9. Coverage gate + capability registry: `Record` + probes + gate CLI + key-set snapshot + knip resolution (`capabilities.ts`, `coverage.ts`, `scenarios/*.ts`).
10. Public `./sim` API surface + build wiring + ABI/dist zero-diff guards (`index.ts`, `package.json`, `tsup.config.ts`, `api-extractor.sim.json`, `public_sim_surface.test.ts`, dist byte guard).
11. CI wiring: PR-fast node-20 gate + env-gated suite + nightly seed-sweep + core-bundle byte/hash guard (`ci.yml`, `sim-nightly.yml`).

## Acceptance criteria

AC-1..AC-10 (see `artifacts/dst-simulation-plan.md` §7 / `build-plan.md`), each mapped to UR-002..UR-005: bit-exact replay canary (AC-1), three fault seams reproducible (AC-2), Safety+Liveness oracles (AC-3), shrinker MinimalRepro (AC-4), nightly sweep (AC-5), public-entry constructibility (AC-6), perf regression gate (AC-7), coverage gate (AC-8), `./sim` ABI/dist zero-diff (AC-9), `npm run check` + determinism grep-audit green (AC-10).

## Carry-forward obligations (issue trail)

- CREATIVE DA: ISS-029 (string-method coverage gate), ISS-030 (inFlightAsyncCount await-site enumeration), ISS-031 (corrupt-state isolation), ISS-032 (perf baseline), ISS-033 (non-vacuous regression pins).
- PLAN DA: ISS-039 (string-method-invoke determinism consequence, MED), ISS-040 (UR-003 debug-workflow DoD), ISS-041 (I-6 throwing-site proof), ISS-042 (perf p99 non-zero baseline), ISS-043 (sim tsconfig isolation posture).

## TECH_SPEC entry (next phase)

Freeze signatures (`Prng`, `TraceFrame`/`CanonicalTrace`, `errorClass` enum incl. corrupt-state family, `Invariant`/`Violation`/`LivenessVerdict`, `FaultPlan`/`FaultRecord`/`FaultSite`/`FaultKind`, `SimEnv`/`SimResult`/`MinimalRepro`, `CapabilityId` union); enumerate the inFlightAsyncCount await-site set (`callAction:1726`, invoke:2170, resume:2504, transitionTimeout `Promise.race`:1798) + string-method gap containment (ISS-030/039); pin corrupt-state payload-delivery contract (`:734` primary, ISS-041); assess sim tsconfig isolation feasibility (ISS-043); freeze perf band config (ISS-042).

## UR Coverage

- UR-001 — covered (design plan + 11-step build).
- UR-002 — covered (fault injection wired, Safety/Liveness, shrinker, CI).
- UR-003 — covered (perf/load + debug surface).
- UR-004 — covered (capability gate, registry-scoped).
- UR-005 — covered (separate ./sim entry, ABI/bundle stability).
- UR-006 — release scope (version bump, docs, full commit, gh publish) planned for the ARCHIVE/release phase; executed in ARCHIVE with user confirmation before the irreversible publish.
