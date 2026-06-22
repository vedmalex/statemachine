import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { writeRepro } from '../../sim/cli/sim-sweep'
import { fingerprintEquals } from '../../sim/shrinker'
import type { ShrinkRunResult, ShrinkRunner } from '../../sim/shrinker'
import { makeViolation } from '../../sim/invariants'
import type { Op, ScenarioSpec, TopologySpec } from '../../sim/scenario'

/**
 * Step-11 (D) — the NIGHTLY failure path (DoD 8): a planted violation makes the
 * sweep write `<seed>.repro.json` + `<seed>.repro.test.ts` under `.sim-out/`, and
 * the JSON repro re-fails the SAME fingerprint. Uses an INJECTED synthetic runner
 * (the established shrinker-test pattern) so the violation is deterministic and
 * fast — no engine run needed for the artifact-emission contract.
 *
 * UNGATED + cheap: the shrink uses a synthetic runner; no real scenario sweep.
 */

const TOPOLOGY: TopologySpec = {
  name: 'repro-fixture',
  stateAttribute: 'state',
  initialState: 's0',
  states: { s0: {}, s1: {} },
  events: { go: { transitions: [{ from: 's0', to: 's1' }] } },
  ownerSeed: { log: [], k: 0 },
}

function fire(id: string): Op {
  return { kind: 'fire', id, event: 'go', args: [] }
}
function noop(id: string): Op {
  return { kind: 'noop', id }
}

function plantedSpec(ops: readonly Op[]): ScenarioSpec {
  return {
    seed: '42',
    version: 1,
    topology: TOPOLOGY,
    ops,
    faults: { faults: [] },
    bounds: { maxStateDepth: 10, maxStatesCount: 1000, maxEventsCount: 1000, maxOps: 64, maxArmedDelay: 5 },
  }
}

const TARGET = makeViolation({
  invariantId: 'I-PLANT',
  step: 1,
  witness: 's1',
  message: 'planted',
  observed: 's1',
  expected: 's0',
})

/** Synthetic runner: fails with the target fingerprint iff op `KEEP` survives. */
const keepRunner: ShrinkRunner = async (candidate) => {
  const fails = candidate.ops.some((o) => o.id === 'KEEP')
  const result: ShrinkRunResult = fails
    ? { violation: { ...TARGET, fingerprint: { ...TARGET.fingerprint } }, traceHash: 'h', finalState: 's1', finalQueueDepth: 0 }
    : { violation: null, traceHash: 'h', finalState: 's0', finalQueueDepth: 0 }
  return result
}

const outDir = mkdtempSync(join(tmpdir(), 'sim-out-'))

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true })
})

describe('Step 11 — nightly repro artifact emission (DoD 8)', () => {
  it('a planted violation writes <seed>.repro.json + <seed>.repro.test.ts that re-fail the same fingerprint', async () => {
    const spec = plantedSpec([noop('op0'), fire('KEEP'), noop('op2')])
    const files = await writeRepro(spec, { ...TARGET, fingerprint: { ...TARGET.fingerprint } }, '1.0.0-test', outDir, keepRunner)

    expect(files).toHaveLength(2)
    const jsonPath = resolve(outDir, '42.repro.json')
    const testPath = resolve(outDir, '42.repro.test.ts')
    expect(existsSync(jsonPath), 'repro JSON must be written').toBe(true)
    expect(existsSync(testPath), 'repro test must be written').toBe(true)

    // The JSON repro re-fails the SAME fingerprint.
    const record = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
      seed: string
      violation: { invariantId: string; witness: string }
      scenario: { ops: { id: string }[] }
    }
    expect(record.seed).toBe('42')
    expect(
      fingerprintEquals(
        { invariantId: record.violation.invariantId, witness: record.violation.witness },
        TARGET.fingerprint,
      ),
      'repro JSON fingerprint must equal the planted target',
    ).toBe(true)
    // The minimized scenario keeps the failing-core op.
    expect(record.scenario.ops.some((o) => o.id === 'KEEP')).toBe(true)
  })

  it('the emitted *.repro.test.ts imports ONLY the public ./sim entry (R16) and re-asserts the fingerprint', async () => {
    const spec = plantedSpec([fire('KEEP')])
    await writeRepro(spec, { ...TARGET, fingerprint: { ...TARGET.fingerprint } }, '1.0.0-test', outDir, keepRunner)
    const src = readFileSync(resolve(outDir, '42.repro.test.ts'), 'utf8')
    expect(src).toContain("from '@vedmalex/statemachine/sim'")
    // No deep src/sim import, no microtask drain helper.
    expect(src).not.toMatch(/from ['"][.][.]?\/.*sim\//)
    expect(src).not.toMatch(/flush\(/)
    expect(src).toContain('EXPECTED_INVARIANT')
    expect(src).toContain('I-PLANT')
  })
})
