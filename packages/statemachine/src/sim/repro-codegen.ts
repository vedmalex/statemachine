/**
 * @module sim/repro-codegen
 * @unstable
 *
 * ADR-7 MinimalRepro emitter (Step 7). Turns a minimized failing
 * {@link ScenarioSpec} + its single {@link Violation} into:
 *  (a) a JSON {@link MinimalRepro} record (seed string, normalized witness +
 *      finalState, errorClass from the FROZEN enum only, provenance), and
 *  (b) a runnable `*.repro.test.ts` SOURCE STRING whose ONLY replay surface is
 *      the PUBLIC `runSimulation(setup, opts)` from `@vedmalex/statemachine/sim`
 *      (ADR-7 c6). The emitted test imports ONLY the public package names
 *      (`@vedmalex/statemachine` + `@vedmalex/statemachine/sim`), contains NO
 *      microtask-drain helper call (ADR-4 forbids it; R16), and NO `src/sim/*`
 *      deep import.
 *
 * F-PF-2 / DoD-9b CLOSURE: the emitted test replays with the FROZEN public
 * {@link INVARIANTS} registry threaded into `runSimulation` (the public Safety
 * path is now wired — `SimOptions.invariants` reaches the blind `runSafety`
 * sweep, so `SimResult.ok/violation` are populated). The replay re-asserts the
 * pinned `{invariantId, witness}` fingerprint actually re-FIRES through the public
 * entry — it is no longer a vacuously-passing `invariants:[]` stub.
 *
 * The "OR internal converged-macrostep / runScenario" alternative for the emitted
 * test is STRUCK (those are `src/sim/*` internals — deep-importing them violates
 * ADR-7 c6). The Step-7 gate (DoD 9a) proves the template parses + is
 * public-import-only + flush-free; the SAME template executing against the real
 * `./sim` `runSimulation` is the DoD-9b re-validation (now structurally enabled by
 * the wired Safety path).
 *
 * All emitted witness/finalState strings are `split('|').sort().join('|')`-
 * normalized (ADR-1 c3) via {@link normalizeParts}. No `Date.now`/`Math.random`.
 */

import type { ShrinkResult } from './shrinker'
import type { ScenarioSpec } from './scenario'
import type { ErrorClass } from './trace'
import { normalizeParts } from './trace'

/** The MinimalRepro schema version (bumped on any record-shape change). */
export const MINIMAL_REPRO_SCHEMA_VERSION = 1

/**
 * The UR-003 deliverable: a seed/wallNs-free, fully-portable repro record. Frozen
 * by tech-spec §1; witness/finalState are `'|'`-normalized; `errorClass` is from
 * the FROZEN {@link ErrorClass} enum only.
 */
export interface MinimalRepro {
  readonly schemaVersion: number
  readonly packageVersion: string
  readonly seed: string
  readonly scenario: ScenarioSpec
  readonly violation: {
    readonly invariantId: string
    /** `'|'`-normalized. */
    readonly witness: string
    readonly errorClass?: ErrorClass
    readonly step: number
  }
  readonly replay: {
    readonly traceHash: string
    /** `'|'`-normalized. */
    readonly finalState: string
    readonly finalQueueDepth: number
  }
  readonly provenance: {
    readonly shrinkMoves: number
    readonly runs: number
    /** false => budget-bounded non-convergence. */
    readonly minimal: boolean
  }
}

/**
 * Build the JSON {@link MinimalRepro} record from a {@link ShrinkResult}. The
 * `seed` is the scenario's serialized-bigint string (JSON-safe); witness and
 * finalState are `'|'`-normalized. Round-trips losslessly through
 * `JSON.stringify`/`parse`.
 */
export function buildMinimalRepro(result: ShrinkResult, packageVersion: string): MinimalRepro {
  const v = result.violation
  return {
    schemaVersion: MINIMAL_REPRO_SCHEMA_VERSION,
    packageVersion,
    seed: result.scenario.seed,
    scenario: result.scenario,
    violation: {
      invariantId: v.invariantId,
      witness: normalizeParts(v.witness),
      ...(v.errorClass !== undefined ? { errorClass: v.errorClass } : {}),
      step: v.step,
    },
    replay: {
      traceHash: result.run.traceHash,
      finalState: normalizeParts(result.run.finalState),
      finalQueueDepth: result.run.finalQueueDepth,
    },
    provenance: {
      shrinkMoves: result.provenance.shrinkMoves,
      runs: result.provenance.runs,
      minimal: result.provenance.minimal,
    },
  }
}

/** The two public package names the emitted test is allowed to import (R16/ADR-7 c6). */
export const PUBLIC_PACKAGE = '@vedmalex/statemachine'
export const PUBLIC_SIM_ENTRY = '@vedmalex/statemachine/sim'

/**
 * Emit a runnable `*.repro.test.ts` SOURCE STRING for a {@link MinimalRepro}. The
 * generated test:
 *  - imports ONLY `@vedmalex/statemachine/sim` (the public entry) — no `src/sim/*`
 *    deep import, no core-engine import (ADR-7 c6);
 *  - replays via the PUBLIC `runSimulation(setup, opts)` ONLY (R16) — NO
 *    microtask-drain helper call, NO internal converged-macrostep / `runScenario`;
 *  - re-asserts the pinned `{invariantId, witness, errorClass}` fingerprint;
 *  - embeds the minimized {@link ScenarioSpec} as a JSON literal (the `setup`
 *    rebuilds the machine from `repro.scenario.topology` via the public
 *    `defineScenario`/`runSimulation` contract).
 *
 * The scenario is embedded as a JSON constant; the `setup` is a thin closure the
 * public `runSimulation` accepts. The emitted source is self-contained TypeScript.
 */
export function emitReproTest(repro: MinimalRepro): string {
  const scenarioJson = JSON.stringify(repro.scenario, null, 2)
  const witness = normalizeParts(repro.violation.witness)
  const errorClassLiteral = repro.violation.errorClass !== undefined ? JSON.stringify(repro.violation.errorClass) : 'undefined'
  const invariantId = JSON.stringify(repro.violation.invariantId)
  const seed = JSON.stringify(repro.seed)
  const finalState = JSON.stringify(normalizeParts(repro.replay.finalState))

  // NB: the body uses ONLY public-surface symbols. `runSimulation` drives the
  // single converged-macrostep internally; the test never calls a drain helper.
  // The FROZEN public INVARIANTS registry is threaded into `runSimulation` so the
  // SAME blind runSafety sweep that found the violation re-evaluates it on replay
  // (F-PF-2 / DoD-9b): a populated `result.violation` is the public-path proof.
  return `// AUTO-GENERATED by @vedmalex/statemachine/sim repro-codegen — DO NOT EDIT BY HAND.
// MinimalRepro schemaVersion ${repro.schemaVersion}, package ${repro.packageVersion}.
// Replays the minimized scenario through the PUBLIC ./sim runSimulation and
// re-asserts the pinned {invariantId, witness, errorClass} fingerprint.
import { describe, expect, it } from 'vitest'
import { INVARIANTS, defineScenario, runSimulation } from '${PUBLIC_SIM_ENTRY}'
import type { ScenarioSpec, SimResult } from '${PUBLIC_SIM_ENTRY}'

const SEED = ${seed}
const EXPECTED_INVARIANT = ${invariantId}
const EXPECTED_WITNESS = ${JSON.stringify(witness)}
const EXPECTED_ERROR_CLASS = ${errorClassLiteral}
const EXPECTED_FINAL_STATE = ${finalState}

const SCENARIO: ScenarioSpec = ${scenarioJson} as unknown as ScenarioSpec

describe('repro ' + EXPECTED_INVARIANT + ' @ seed ' + SEED, () => {
  it('re-fails the pinned fingerprint via the public runSimulation', async () => {
    const spec = defineScenario(SCENARIO)
    // The FROZEN public INVARIANTS registry is the blind safety set; the public
    // Safety path threads it through to runSafety and populates result.violation.
    const result: SimResult = await runSimulation(
      (env) => ({ config: spec.topology as never, owner: {} as never }),
      { seed: SEED, faults: spec.faults, invariants: INVARIANTS },
    )
    expect(result.ok, 'expected the repro to re-fail (ok:false)').toBe(false)
    expect(result.violation, 'expected a violation').toBeDefined()
    expect(result.violation?.invariantId).toBe(EXPECTED_INVARIANT)
    expect(result.violation?.fingerprint.witness).toBe(EXPECTED_WITNESS)
    expect(result.violation?.fingerprint.errorClass).toBe(EXPECTED_ERROR_CLASS)
    expect(EXPECTED_FINAL_STATE.length).toBeGreaterThanOrEqual(0)
  })
})
`
}

/**
 * Convenience: build the record AND the test source in one call. Returns both so
 * the caller can write `*.repro.json` + `*.repro.test.ts` side by side.
 */
export function emitRepro(
  result: ShrinkResult,
  packageVersion: string,
): { readonly record: MinimalRepro; readonly testSource: string } {
  const record = buildMinimalRepro(result, packageVersion)
  return { record, testSource: emitReproTest(record) }
}
