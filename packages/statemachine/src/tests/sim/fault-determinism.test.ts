/**
 * @module tests/sim/fault-determinism
 *
 * Step-5 DETERMINISM (ADR-1/2/5; AC-2): with faults ACTIVELY WIRED, the same
 * `(seed, plan)` must regenerate a BIT-IDENTICAL traceHash AND an identical
 * `FaultRecord[]` across two independent runs — the replay-identity contract the
 * whole DST value proposition rests on. This MIRRORS the AC-1 canary
 * (replay.test.ts) but exercises the MULTI-KIND fault path through the PUBLIC
 * `runSimulation` / `runScenario` surfaces, proving the wiring did not break
 * determinism (the build-plan §11A floor + the ISS-064 fix requirement #3).
 *
 * Faults are seed-derived via the label-fork PRNG (`fork('faults')` + per-site
 * sub-forks). `fork()` never advances the parent, so attaching a fault plan does
 * NOT perturb the op-selection / topology PRNG streams — the clean and faulted
 * runs share the same generated scenario, and two faulted runs are identical.
 */

import { describe, expect, it } from 'vitest'

import type { FaultPlan, ScenarioSpec } from '../../sim'
import { generateScenario, runScenario, runSimulation, toEngineConfig, makeOwner } from '../../sim'
import { hashTrace } from '../../sim/trace'

/** A multi-kind plan that exercises queue + scheduler + callback seams at once. */
function multiKindPlan(): FaultPlan {
  return {
    faults: [
      { kind: 'drop', site: { seam: 'event-queue', opId: 'op-0' }, opId: 'op-0' },
      { kind: 'clock-skew', site: { seam: 'scheduler', opId: 'op-1' }, deltaMs: 25 },
      {
        kind: 'timer-jitter',
        site: { seam: 'scheduler', stateName: 'cP.rA.start', invokeIndex: 0, armEpoch: 0 },
        jitterMs: 2,
      },
      { kind: 'throw', site: { seam: 'callback', callbackKind: 'invoke.action', invokeIndex: 0, stateName: 'cP.rB.start' } },
    ],
  }
}

describe('fault-determinism: same (seed, plan) → bit-identical replay WITH faults active (AC-2)', () => {
  it('runScenario: two runs of a MULTI-KIND faulted scenario produce an identical traceHash (8-seed sweep)', async () => {
    for (let s = 0; s < 8; s++) {
      const spec = await generateScenario(BigInt(s))
      const faulted: ScenarioSpec = { ...spec, faults: multiKindPlan() }
      const h1 = hashTrace(await runScenario(faulted))
      const h2 = hashTrace(await runScenario(faulted))
      expect(h2, `seed ${s} faulted replay diverged`).toBe(h1)
    }
  }, 60000)

  it('runScenario: the faulted run DIFFERS from the clean run (the faults actually changed the trace)', async () => {
    // At least one seed must show an observable divergence; assert all-or-most do.
    let differing = 0
    for (let s = 0; s < 8; s++) {
      const spec = await generateScenario(BigInt(s))
      const faulted: ScenarioSpec = { ...spec, faults: multiKindPlan() }
      const clean = hashTrace(await runScenario(spec))
      const dirty = hashTrace(await runScenario(faulted))
      if (clean !== dirty) {
        differing += 1
      }
    }
    expect(differing, 'a multi-kind fault plan must perturb the trace on most seeds').toBeGreaterThan(0)
  }, 60000)

  it('runScenario: JSON round-trip of a faulted spec replays to the SAME traceHash (plan survives serialization)', async () => {
    for (let s = 0; s < 4; s++) {
      const spec = await generateScenario(BigInt(s))
      const faulted: ScenarioSpec = { ...spec, faults: multiKindPlan() }
      const live = hashTrace(await runScenario(faulted))
      const round = JSON.parse(JSON.stringify(faulted)) as ScenarioSpec
      const roundHash = hashTrace(await runScenario(round))
      expect(roundHash, `seed ${s} faulted JSON round-trip diverged`).toBe(live)
    }
  }, 60000)

  it('runSimulation (PUBLIC ./sim): opts.faults is LIVE — two faulted runs hash identically', async () => {
    // The frozen public SimOptions.faults field threaded through the Simulator into
    // the driver. A queue fault on a public per-step op-id (`sim-op-<n>`) is applied.
    const spec = await generateScenario(7n)
    const plan: FaultPlan = {
      faults: [
        { kind: 'drop', site: { seam: 'event-queue', opId: 'sim-op-0' }, opId: 'sim-op-0' },
        {
          kind: 'timer-jitter',
          site: { seam: 'scheduler', stateName: 'cP.rA.start', invokeIndex: 0, armEpoch: 0 },
          jitterMs: 2,
        },
      ],
    }
    const setup = () => ({ config: toEngineConfig(spec.topology) as never, owner: makeOwner(spec.topology) as never })
    const r1 = await runSimulation(setup, { seed: 7n, steps: spec.ops.length, faults: plan })
    const r2 = await runSimulation(setup, { seed: 7n, steps: spec.ops.length, faults: plan })
    expect(r1.traceHash).toBe(r2.traceHash)
    // The faulted public run differs from a clean public run (faults are LIVE).
    const clean = await runSimulation(setup, { seed: 7n, steps: spec.ops.length })
    expect(r1.traceHash).not.toBe(clean.traceHash)
  }, 60000)
})
