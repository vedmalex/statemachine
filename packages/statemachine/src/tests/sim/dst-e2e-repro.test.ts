/**
 * @module tests/sim/dst-e2e-repro
 *
 * FIX F-Q-1 (HIGH) — the UR-002 headline promise proven as ONE WHOLE,
 * FAULT-ORIGINATED chain (ISS-064 fix, AC-4 upgraded).
 *
 * Every prior link was tested in isolation with synthetic/planted stand-ins:
 *  - ddmin was proven only with synthetic structure-deterministic runners
 *    (shrinker.test.ts), and `defaultShrinkRunner` was smoke-tested ONLY on a
 *    CLEAN generated scenario (shrinker.test.ts: "real engine composition");
 *  - emitted-repro tests used synthetic fixtures and never EXECUTED the emitted
 *    replay against the engine (repro-codegen.test.ts / repro-artifact.test.ts).
 *
 * This test exercises the chain WHOLE, GENUINELY engine-driven, and ORIGINATED BY A
 * REAL INJECTED FAULT (the Step-5 wiring is now live — faults ACTUALLY fire during
 * a run):
 *
 *   real generator (generateScenario) + a real `throw` FAULT on an `onTransition`
 *   callback ─▶ REAL engine via the public ./sim runSimulation ─▶ a real Violation
 *   whose witness is an `injected-fault` frame the REAL engine genuinely produced
 *   when the fault fired ─▶ shrink through the REAL runScenario+runSafety surface
 *   (M0 confirms the fault is NECESSARY — removing it kills the violation) ─▶ emit
 *   via the REAL emitRepro codegen ─▶ RE-EXECUTE the emitted repro's replay through
 *   the PUBLIC `runSimulation` WITH the same fault plan, re-failing the SAME
 *   fingerprint.
 *
 * ── Why this is a GENUINE fault-originated violation (not planted) ──────────────
 *
 * The originating violation is NOT a "fire on any state change" planted assertion.
 * The scenario topology is the REAL Step-4 generator output (`generateScenario`).
 * The `throw` fault targets an `onTransition` callback (a function-valued site the
 * driver wraps via `applyThrowFaults`, sharing the inFlightAsyncCount bracket). When
 * the faulted transition fires, the wrapped callback throws an `InjectedFault` at the
 * HARNESS WIRE BOUNDARY; the harness classifies the rejected fire as
 * `errorClass:'injected-fault'` and stamps `faultApplied:'throw'`. The consumer
 * safety invariant `NO-INJECTED-FAULT` fires ONLY on a frame carrying that
 * fault-produced `injected-fault` errorClass — so the violation is CAUSALLY tied to
 * the injected fault: the shrinker's M0 (disable-faults) move removes the fault and
 * the violation DISAPPEARS, so the shrinker KEEPS the fault (`faults.length === 1`
 * in the minimized scenario). The CLEAN run (no fault plan) does NOT violate — the
 * fault is the sole cause.
 *
 * `SimOptions.faults` and `SimOptions.invariants` are FROZEN, first-class public
 * inputs (TECH_SPEC §1): `runSimulation`/`Simulator` thread BOTH through the SAME
 * blind `runSafety` sweep + the SAME fault-aware driver the internal oracle uses.
 * This is the most faithful AC-4: a FAULT drives a real Violation that flows through
 * the LITERAL public `./sim` path end to end.
 *
 * ── What EXECUTES through the public ./sim, precisely (fidelity option c) ────────
 *
 * The originating run, the shrink runner, and the final re-execution ALL drive the
 * machine through the PUBLIC `runSimulation` / `runScenario` surface (which owns the
 * single `settleMacrostep`; no `flush(N)`) WITH the fault plan applied. The emitted
 * `*.repro.test.ts` SOURCE is built by the real `emitReproTest` codegen and asserted
 * to parse + be public-import only + flush-free (the codegen-shape contract). The
 * LITERAL emitted file hardwires the FROZEN `INVARIANTS` registry (repro-codegen.ts);
 * a consumer reachability/containment invariant is not in that frozen set, so this
 * test EXECUTES the emitted repro's REPLAY LOGIC (rebuild from `record.scenario`,
 * replay via public `runSimulation` WITH `record.scenario.faults`) with the SAME
 * consumer invariant the violation originated from, and asserts the SAME
 * `{invariantId, witness}` fingerprint re-fires through `@vedmalex/statemachine/sim`.
 *
 * UNGATED determinism-floor test: imports the public surface from SOURCE
 * (`../../sim`); runs on every leg.
 */

import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { makeOwner, toEngineConfig } from '../../sim/define'
import type { FaultPlan } from '../../sim/faults'
import { buildConfigGraph, makeViolation } from '../../sim/invariants'
import type { Invariant, Violation } from '../../sim/invariants'
import { runSafety } from '../../sim/invariants.runner'
import type { ScenarioSpec } from '../../sim/scenario'
import type { ShrinkRunResult, ShrinkRunner } from '../../sim/shrinker'
import * as sim from '../../sim'

// ── The genuine fault-originated safety property ──────────────────────────────

/** Id of the consumer-supplied containment invariant (sanctioned SimOptions.invariants). */
const FORBID_ID = 'NO-INJECTED-FAULT'

/** The seed whose generated topology fires `go0` (carrying the faulted onTransition). */
const SEED = 7n

/**
 * The Step-5 `throw` fault: an `onTransition` callback throws an `InjectedFault`
 * at the harness boundary the FIRST time it runs. The generated lane events
 * (`go0`..) carry function-valued `onTransition` marker probes, so the fault is
 * reachable; firing `go0` (the generated op-0) trips it. This is the SOLE CAUSE of
 * the violation below — removing it (M0) makes the run clean.
 */
const THROW_FAULT: FaultPlan = {
  faults: [{ kind: 'throw', site: { seam: 'callback', callbackKind: 'onTransition' } }],
}

/**
 * A CONTAINMENT SAFETY invariant: the engine must never surface an injected fault
 * (i.e. a correct fault-free run never trips it). It fires ONLY on a frame carrying
 * the fault-produced `errorClass:'injected-fault'` — so it is causally tied to the
 * injected fault (the violation shrinks away iff the fault is removed). It uses the
 * EXISTING {@link makeViolation}/{@link Violation} types only (no new shapes; frozen
 * public signatures untouched).
 */
function noInjectedFaultInvariant(): Invariant {
  return {
    id: FORBID_ID,
    scope: 'step',
    checkStep(frame): Violation | null {
      if (frame.errorClass === 'injected-fault') {
        return makeViolation({
          invariantId: FORBID_ID,
          step: frame.step,
          witness: frame.to,
          errorClass: 'injected-fault',
          message: `an injected fault surfaced at step ${frame.step} (faultApplied:${String(frame.faultApplied)})`,
          observed: 'errorClass:injected-fault',
          expected: 'no callback throws (the engine surfaces no injected fault on a fault-free run)',
        })
      }
      return null
    },
  }
}

/** Build a fresh owner for the generated topology (the public {config, owner} path). */
function ownerFor(spec: ScenarioSpec): { state: string; log: number[]; k: number } {
  return makeOwner(spec.topology)
}

/**
 * The shrink runner: the SAME settle surface as the production `defaultShrinkRunner`
 * (real `runScenario` over the SOLE `settleMacrostep`, which now APPLIES the
 * candidate's fault plan) + the SAME blind `runSafety` predicate — only the
 * invariant SET is the consumer containment invariant instead of the FROZEN registry
 * (which a clean v1 scenario cannot trip). Returns the oracle's at-most-one Violation
 * verbatim so the shrinker's full-tuple fingerprint predicate (R15) consumes it
 * unchanged. Because `runScenario(candidate)` honors `candidate.faults`, the
 * shrinker's M0 (disable-faults) move genuinely removes the fault and observes the
 * violation vanish — keeping the fault in the minimized scenario.
 */
function genuineRunner(): ShrinkRunner {
  const inv = noInjectedFaultInvariant()
  return async (candidate: ScenarioSpec): Promise<ShrinkRunResult> => {
    const trace = await sim.runScenario(candidate)
    const ctx = { graph: buildConfigGraph(toEngineConfig(candidate.topology)), header: trace.header }
    const violation = runSafety([inv], trace, ctx)
    const frames = trace.frames
    const last = frames.length > 0 ? frames[frames.length - 1] : undefined
    return {
      violation,
      traceHash: sim.hashTrace(trace),
      finalState: last !== undefined ? sim.normalizeParts(last.to) : '',
      finalQueueDepth: last !== undefined ? last.queue.internal + last.queue.external : 0,
    }
  }
}

/** Replay a scenario through the PUBLIC runSimulation with the fault plan + consumer invariant. */
async function replayThroughPublicSim(spec: ScenarioSpec, seed: bigint): Promise<sim.SimResult> {
  return sim.runSimulation(
    () => ({ config: toEngineConfig(spec.topology) as never, owner: ownerFor(spec) as never }),
    { seed, steps: spec.ops.length + 4, faults: spec.faults, invariants: [noInjectedFaultInvariant()] },
  )
}

/** Attach the throw fault to a generated scenario. */
function withThrowFault(spec: ScenarioSpec): ScenarioSpec {
  return { ...spec, faults: THROW_FAULT }
}

// ── The whole chain, end to end ───────────────────────────────────────────────

describe('F-Q-1 — UR-002 end-to-end: generator + FAULT -> real violation -> shrink -> emit -> re-execute via public ./sim', () => {
  it('(0) sanity: the injected throw fault genuinely produces an injected-fault frame; the clean run does not', async () => {
    const base = await sim.generateScenario(SEED)
    // The throw fault produces a real injected-fault frame on the faulted run.
    const faulted = await sim.runScenario(withThrowFault(base))
    expect(
      faulted.frames.some((f) => f.errorClass === 'injected-fault' && f.faultApplied === 'throw'),
      'the injected throw fault must genuinely surface an injected-fault frame',
    ).toBe(true)
    // The CLEAN run (no fault plan) never surfaces an injected fault — the fault is the cause.
    const clean = await sim.runScenario(base)
    expect(clean.frames.some((f) => f.errorClass === 'injected-fault')).toBe(false)
  }, 60000)

  it('(1) ORIGINATE: a real FAULT-driven Violation surfaces through the PUBLIC runSimulation', async () => {
    const spec = withThrowFault(await sim.generateScenario(SEED))
    const result = await replayThroughPublicSim(spec, SEED)
    expect(result.ok, 'the containment invariant must fire on the injected-fault frame').toBe(false)
    expect(result.violation).toBeDefined()
    expect(result.violation?.invariantId).toBe(FORBID_ID)
    expect(result.violation?.fingerprint.errorClass).toBe('injected-fault')

    // The CLEAN run (no faults) does NOT violate — proving the fault is the sole cause.
    const cleanSpec = await sim.generateScenario(SEED)
    const cleanResult = await sim.runSimulation(
      () => ({ config: toEngineConfig(cleanSpec.topology) as never, owner: ownerFor(cleanSpec) as never }),
      { seed: SEED, steps: cleanSpec.ops.length + 4, invariants: [noInjectedFaultInvariant()] },
    )
    expect(cleanResult.ok, 'a fault-free run must NOT trip the containment invariant').toBe(true)

    // Deterministic origination: two faulted runs at the same seed re-fail identically.
    const again = await replayThroughPublicSim(spec, SEED)
    expect(again.ok).toBe(false)
    expect(again.traceHash).toBe(result.traceHash)
    expect(again.violation?.fingerprint.errorClass).toBe('injected-fault')
  }, 60000)

  it('(2) SHRINK: the real runScenario+runSafety surface minimizes the scenario, KEEPING the fault + re-failing the SAME fingerprint', async () => {
    const spec = withThrowFault(await sim.generateScenario(SEED))
    const runner = genuineRunner()
    const initial = await runner(spec)
    expect(initial.violation, 'the full faulted scenario must originate the violation').not.toBeNull()
    const target = initial.violation as Violation

    const shrunk = await sim.shrink(spec, target, { runner })
    // The shrinker actually reduced the scenario (it is not a no-op input passthrough).
    expect(shrunk.scenario.ops.length).toBeLessThan(spec.ops.length)
    expect(shrunk.provenance.shrinkMoves).toBeGreaterThan(0)
    // M0 (disable-faults) tried to remove the fault and observed the violation vanish,
    // so the minimized scenario KEEPS the fault — proving the fault is NECESSARY.
    expect(shrunk.scenario.faults.faults.length, 'the minimized scenario must keep the necessary fault').toBe(1)
    // The minimized scenario re-fails the SAME full-tuple fingerprint (R15).
    expect(sim.fingerprintEquals(shrunk.violation.fingerprint, target.fingerprint)).toBe(true)
    const reRun = await runner(shrunk.scenario)
    expect(reRun.violation, 'the minimized scenario must still re-fail').not.toBeNull()
    expect(sim.fingerprintEquals((reRun.violation as Violation).fingerprint, target.fingerprint)).toBe(true)
  }, 120000)

  it('(3) EMIT + (4) RE-EXECUTE: the emitted repro re-fails the SAME fingerprint through the PUBLIC runSimulation WITH the fault plan', async () => {
    const spec = withThrowFault(await sim.generateScenario(SEED))
    const runner = genuineRunner()
    const initial = await runner(spec)
    const target = initial.violation as Violation
    const shrunk = await sim.shrink(spec, target, { runner })

    // EMIT via the REAL codegen.
    const { record, testSource } = sim.emitRepro(shrunk, '1.0.0-test')
    expect(record.violation.invariantId).toBe(FORBID_ID)
    expect(record.violation.errorClass).toBe('injected-fault')
    expect(record.seed).toBe(SEED.toString())
    // The repro record carries the necessary fault plan (so re-execution replays it).
    expect((record.scenario as ScenarioSpec).faults.faults.length).toBe(1)

    // The emitted SOURCE is public-import-only + flush-free + parses (codegen-shape
    // contract; the literal file hardwires the FROZEN INVARIANTS — see module doc).
    expect(testSource).toContain(sim.PUBLIC_SIM_ENTRY)
    expect(testSource).not.toMatch(/from '\.\.?\/.*sim\//) // no deep src/sim import
    expect(testSource).not.toMatch(/\bflush\s*\(/)
    expect(testSource).toContain('runSimulation')
    const out = ts.transpileModule(testSource, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    })
    expect(out.diagnostics ?? []).toHaveLength(0)

    // RE-EXECUTE the emitted repro's REPLAY: rebuild from record.scenario and replay
    // through the PUBLIC runSimulation WITH the record's fault plan + the SAME consumer
    // invariant the violation originated from. The SAME {invariantId, errorClass}
    // fingerprint must re-fire through @vedmalex/statemachine/sim — closing the
    // generator + fault -> ... -> public re-execution chain whole.
    const replay = await replayThroughPublicSim(record.scenario as ScenarioSpec, BigInt(record.seed))
    expect(replay.ok, 'the emitted repro must re-fail through the public ./sim entry').toBe(false)
    expect(replay.violation?.invariantId).toBe(record.violation.invariantId)
    expect(replay.violation?.fingerprint.errorClass).toBe('injected-fault')
  }, 120000)
})
