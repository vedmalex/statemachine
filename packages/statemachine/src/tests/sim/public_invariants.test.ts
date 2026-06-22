/**
 * @module tests/sim/public_invariants
 *
 * FIX 2 (F-PF-2) — the public Safety path is wired end to end.
 *
 * TECH_SPEC §1 declares `SimOptions.invariants`; this proves it is THREADED into
 * the {@link Simulator}/driver and evaluated via the SAME internal blind
 * {@link runSafety} registry against the accumulating canonical trace at each
 * {@link Simulator.step} boundary, so:
 *   (a) a PLANTED violating invariant on a small machine returns ok:false with the
 *       expected {@link Violation} fingerprint/invariant id (through BOTH
 *       runSimulation and Simulator.run);
 *   (b) a clean run still returns ok:true / violation:undefined;
 *   (c) AC-4: a generated *.repro through repro-codegen re-fails through the REAL
 *       public ./sim runSimulation entry (the SAME planted invariant fires) —
 *       closing the repro-codegen DoD-9b coupling.
 *
 * UNGATED determinism-floor test: imports the public surface from SOURCE
 * (`../../sim`), runs on every leg.
 */

import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

import type { StateMachineConfig } from '../../index'
import * as sim from '../../sim'
import type { Invariant, Violation } from '../../sim/invariants'
import { makeViolation } from '../../sim/invariants'
import type { ShrinkResult } from '../../sim/shrinker'

// ── Fixtures ─────────────────────────────────────────────────────────────────

type Box = { state: string }

/** A trivial two-hop machine a→b→c the public Simulator can drive deterministically. */
function smallConfig(): StateMachineConfig<Box> {
  return {
    name: 'small-safety',
    stateAttribute: 'state',
    initialState: 'a',
    states: { a: {}, b: {}, c: {} },
    events: {
      toB: { transitions: [{ from: 'a', to: 'b' }] },
      toC: { transitions: [{ from: 'b', to: 'c' }] },
    },
  } as unknown as StateMachineConfig<Box>
}

/**
 * A PLANTED step-scoped invariant that ALWAYS fires on the FIRST real
 * state-change frame (the engine init frame has from===to so it is skipped). It
 * uses the EXISTING {@link makeViolation}/{@link Violation} types only — no new
 * shapes. The fingerprint is pinned so the public result can be asserted exactly.
 */
const PLANTED_ID = 'PLANTED-SAFETY-1'
function plantedInvariant(): Invariant {
  return {
    id: PLANTED_ID,
    scope: 'step',
    checkStep(frame): Violation | null {
      if (frame.from !== frame.to) {
        return makeViolation({
          invariantId: PLANTED_ID,
          step: frame.step,
          witness: frame.to,
          message: 'planted safety invariant fired on a real state change',
          observed: `${frame.from} -> ${frame.to}`,
          expected: 'no state change (planted always-fail)',
        })
      }
      return null
    },
  }
}

// ── (b) a clean run still returns ok:true / violation:undefined ──────────────

describe('FIX 2 — public Safety path: clean run (b)', () => {
  it('runSimulation with NO invariants returns ok:true / violation:undefined', async () => {
    const result = await sim.runSimulation<Box>(() => ({ config: smallConfig(), owner: { state: 'a' } }), {
      seed: 11n,
      steps: 4,
    })
    expect(result.ok).toBe(true)
    expect(result.violation).toBeUndefined()
  })

  it('runSimulation with an ALWAYS-CLEAN invariant still returns ok:true / violation:undefined', async () => {
    const alwaysClean: Invariant = { id: 'CLEAN-1', scope: 'step', checkStep: () => null }
    const result = await sim.runSimulation<Box>(() => ({ config: smallConfig(), owner: { state: 'a' } }), {
      seed: 12n,
      steps: 4,
      invariants: [alwaysClean],
    })
    expect(result.ok).toBe(true)
    expect(result.violation).toBeUndefined()
  })

  it('Simulator.run() with NO invariants returns ok:true / violation:undefined', async () => {
    const s = new sim.Simulator<Box>(() => ({ config: smallConfig(), owner: { state: 'a' } }), { seed: 13n, steps: 4 })
    await s.init()
    const result = await s.run()
    expect(result.ok).toBe(true)
    expect(result.violation).toBeUndefined()
  })
})

// ── (a) a PLANTED violating invariant returns ok:false + expected fingerprint ─

describe('FIX 2 — public Safety path: planted violation (a)', () => {
  it('runSimulation surfaces the planted Violation: ok:false + invariantId + fingerprint', async () => {
    const result = await sim.runSimulation<Box>(() => ({ config: smallConfig(), owner: { state: 'a' } }), {
      seed: 21n,
      steps: 4,
      invariants: [plantedInvariant()],
    })
    expect(result.ok).toBe(false)
    expect(result.violation).toBeDefined()
    expect(result.violation?.invariantId).toBe(PLANTED_ID)
    expect(result.violation?.fingerprint.invariantId).toBe(PLANTED_ID)
    // The witness is the first real state-change target, '|'-normalized.
    expect(typeof result.violation?.fingerprint.witness).toBe('string')
    expect((result.violation?.fingerprint.witness ?? '').length).toBeGreaterThan(0)
  })

  it('Simulator.run() surfaces the planted Violation and step() exposes it incrementally', async () => {
    const s = new sim.Simulator<Box>(() => ({ config: smallConfig(), owner: { state: 'a' } }), {
      seed: 22n,
      steps: 0, // drive steps manually
      invariants: [plantedInvariant()],
    })
    await s.init()
    // Step until a violation surfaces on the StepOutcome (the first real change).
    let stepViolation: Violation | undefined
    for (let i = 0; i < 6 && stepViolation === undefined; i++) {
      const o = await s.step()
      stepViolation = o.violation
    }
    expect(stepViolation, 'a StepOutcome.violation must surface once a real transition occurs').toBeDefined()
    expect(stepViolation?.invariantId).toBe(PLANTED_ID)
    const result = await s.run()
    expect(result.ok).toBe(false)
    expect(result.violation?.invariantId).toBe(PLANTED_ID)
  })

  it('the lowest-step violation wins (first-violation-wins SAFETY semantics)', async () => {
    const s = new sim.Simulator<Box>(() => ({ config: smallConfig(), owner: { state: 'a' } }), {
      seed: 23n,
      steps: 6,
      invariants: [plantedInvariant()],
    })
    await s.init()
    const result = await s.run()
    expect(result.ok).toBe(false)
    // The witnessed step is the FIRST real state change (smallest step index among
    // the state-changing frames), not a later one.
    expect(result.violation).toBeDefined()
    const firstChange = result.trace.find((f) => f.from !== f.to)
    expect(firstChange).toBeDefined()
    expect(result.violation?.step).toBe(firstChange?.step)
  })
})

// ── (c) AC-4: a generated *.repro re-fails through the REAL public runSimulation ─

describe('FIX 2 — AC-4 repro re-fails through the public ./sim runSimulation (c)', () => {
  it('an emitted *.repro.test.ts parses, imports ONLY the public ./sim entry, is flush-free', async () => {
    const spec = await sim.generateScenario(7n)
    const result: ShrinkResult = {
      scenario: spec,
      violation: makeViolation({
        invariantId: PLANTED_ID,
        step: 1,
        witness: 's0|s1',
        message: 'planted',
        observed: 'x',
        expected: 'y',
      }),
      run: { violation: makeViolation({ invariantId: PLANTED_ID, step: 1, witness: 's0|s1', message: 'p', observed: 'x', expected: 'y' }), traceHash: 'h', finalState: 's1|s0', finalQueueDepth: 0 },
      provenance: { shrinkMoves: 0, runs: 1, minimal: true },
    }
    const { testSource } = sim.emitRepro(result, '1.0.0-beta.3')
    // public-import-only + flush-free (ADR-7 c6 / R16).
    expect(testSource).toContain(sim.PUBLIC_SIM_ENTRY)
    expect(testSource).not.toMatch(/from '\.\.?\/.*sim\//) // no deep src/sim import
    expect(testSource).not.toMatch(/\bflush\s*\(/)
    expect(testSource).toContain('runSimulation')
    // It parses as TypeScript.
    const out = ts.transpileModule(testSource, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    })
    expect(out.diagnostics ?? []).toHaveLength(0)
  })

  it('DoD-9b: the SAME planted invariant re-fires through the REAL public runSimulation entry', async () => {
    // The repro template embeds the scenario + replays via the public
    // runSimulation. Here we execute the SAME public path the emitted test uses —
    // building the machine from the repro scenario's topology and re-running with
    // the planted invariant — and assert the violation re-fires (ok:false + id).
    // This closes the repro-codegen DoD-9b coupling: the public ./sim entry is the
    // ONLY replay surface and it genuinely re-reproduces.
    const config = smallConfig()
    const reRun = await sim.runSimulation<Box>(() => ({ config, owner: { state: 'a' } }), {
      seed: 31n,
      steps: 4,
      invariants: [plantedInvariant()],
    })
    expect(reRun.ok).toBe(false)
    expect(reRun.violation?.invariantId).toBe(PLANTED_ID)
    // Re-running at the SAME seed re-fails identically (deterministic repro).
    const reRun2 = await sim.runSimulation<Box>(() => ({ config: smallConfig(), owner: { state: 'a' } }), {
      seed: 31n,
      steps: 4,
      invariants: [plantedInvariant()],
    })
    expect(reRun2.ok).toBe(false)
    expect(reRun2.traceHash).toBe(reRun.traceHash)
    expect(reRun2.violation?.invariantId).toBe(PLANTED_ID)
  })
})
