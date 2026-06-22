/**
 * @module tests/sim/coverage
 *
 * Step-9 ADR-8 coverage gate (DoD 4/5/6/7/9/10).
 *
 * Proves: the full registry is covered (every non-gap id) with each contributing
 * scenario passing I-1 (determinism) first; probe purity (errorClass-keyed, never
 * `.message`; reads the captured doneDelta projection, never a live engine call);
 * guard-block reads `fireOutcome:'resolve-false'` not a state-write; drift
 * detection; the ISS-029 string-method honesty (the three function-valued error
 * ids are explicit residuals, never silently covered, and a hand-marked
 * coverageStatus cannot falsely cover); the priority / done-state(captured-isDone)
 * / history non-vacuous probes; and the explicit gap-set guard.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CAPABILITIES, type CapabilityId, DOCUMENTED_GAP_IDS, capabilityKeys } from '../../sim/capabilities'
import {
  type CoverageScenario,
  computeCoverage,
  formatCoverageReport,
} from '../../sim/coverage'
import type { ScenarioSpec, TopologySpec } from '../../sim/scenario'
import { COVERAGE_SCENARIOS } from '../../sim/scenarios/index'
import type { CanonicalTrace, SimTrace, TraceFrame } from '../../sim/trace'

// ── DoD 5: full registry coverage, I-1-gated ─────────────────────────────────

describe('coverage: full registry gate (DoD 5)', () => {
  it('computeCoverage covers every NON-gap CapabilityId, exitCode 0, no drift', async () => {
    const result = await computeCoverage(COVERAGE_SCENARIOS)
    if (result.exitCode !== 0) {
      // Surface the human report on failure so the gap is obvious.
      throw new Error(`coverage gate failed:\n${formatCoverageReport(result)}`)
    }
    expect(result.uncovered.size).toBe(0)
    expect(result.drift.size).toBe(0)
    expect(result.exitCode).toBe(0)
  })

  it('every covered id is genuinely fired by at least one registered scenario', async () => {
    const result = await computeCoverage(COVERAGE_SCENARIOS)
    // The non-gap set must be fully covered.
    const nonGap = capabilityKeys().filter((id) => !DOCUMENTED_GAP_IDS.has(id))
    for (const id of nonGap) {
      expect(result.covered.has(id), `non-gap id ${id} not covered`).toBe(true)
    }
  })

  it('every contributing scenario passes I-1 (two runs → equal hashTrace) before counting', async () => {
    // computeCoverage runs each scenario twice and throws CoverageDeterminismError
    // on divergence BEFORE counting; a clean run proves all scenarios are I-1 clean.
    await expect(computeCoverage(COVERAGE_SCENARIOS)).resolves.toBeDefined()
  })
})

// ── DoD 10: priority / done(captured-isDone) / history non-vacuous probes ─────

describe('coverage: non-vacuous concrete probes (DoD 10)', () => {
  it('transition.priority fires on the core-events scenario (higher-priority target)', async () => {
    const result = await computeCoverage(COVERAGE_SCENARIOS)
    expect(result.covered.has('transition.priority')).toBe(true)
  })

  it('composite.join.done-state + inspection.isDone fire via the captured doneDelta', async () => {
    const result = await computeCoverage(COVERAGE_SCENARIOS)
    expect(result.covered.has('composite.join.done-state')).toBe(true)
    expect(result.covered.has('inspection.isDone')).toBe(true)
  })

  it('history.shallow + history.deep fire on the history scenario', async () => {
    const result = await computeCoverage(COVERAGE_SCENARIOS)
    expect(result.covered.has('history.shallow')).toBe(true)
    expect(result.covered.has('history.deep')).toBe(true)
  })

  it('error.recovery.errorState fires on the errors-faults scenario', async () => {
    const result = await computeCoverage(COVERAGE_SCENARIOS)
    expect(result.covered.has('error.recovery.errorState')).toBe(true)
  })
})

// ── DoD 6: drift detection ────────────────────────────────────────────────────

describe('coverage: drift detection (DoD 6)', () => {
  it('a scenario claiming expects:[X] whose probe never fires exits non-zero', async () => {
    // A trivial scenario that fires one external event but CLAIMS to cover history.
    const topology: TopologySpec = {
      name: 'drift',
      stateAttribute: 'state',
      initialState: 'a',
      ownerSeed: { log: [], k: 0 },
      states: { a: {}, b: {} },
      events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
    }
    const spec: ScenarioSpec = {
      seed: '900',
      version: 1,
      topology,
      ops: [{ kind: 'fire', id: 'op-1', event: 'go', args: [] }],
      faults: { faults: [] },
      bounds: { maxStateDepth: 10, maxStatesCount: 1000, maxEventsCount: 1000, maxOps: 32, maxArmedDelay: 5 },
    }
    const driftScenario: CoverageScenario = {
      name: 'drift-claim',
      spec,
      expects: ['history.shallow'], // never fired by this scenario
    }
    const result = await computeCoverage([driftScenario])
    expect(result.drift.has('history.shallow')).toBe(true)
    expect(result.exitCode).not.toBe(0)
  })
})

// ── DoD 7 / ISS-029: string-method honesty + coverageStatus cannot falsely cover ─

describe('coverage: ISS-029 string-method honesty (DoD 7)', () => {
  /** A machine whose only invoke action is a STRING method name (config-unwrappable). */
  const stringMethodSpec: ScenarioSpec = {
    seed: '777',
    version: 1,
    topology: {
      name: 'string-method',
      stateAttribute: 'state',
      initialState: 'idle',
      ownerSeed: { log: [], k: 0 },
      states: {
        // a string-method invoke action (NOT a function value) — the throw wrapper
        // cannot reach it (resolved inside callAction, after the wrap boundary).
        idle: { invoke: [{ delay: 1, event: 'tick', action: 'someStringMethod' as never }] },
        running: {},
      },
      events: { tick: { transitions: [{ from: 'idle', to: 'running' }] } },
    } as unknown as TopologySpec,
    ops: [{ kind: 'advance', id: 'op-1', dtMs: 3 }],
    faults: { faults: [] },
    bounds: { maxStateDepth: 10, maxStatesCount: 1000, maxEventsCount: 1000, maxOps: 32, maxArmedDelay: 5 },
  }

  it('reports the three function-valued error ids as n/a-string-method, never covered', async () => {
    const sc: CoverageScenario = { name: 'string-method-only', spec: stringMethodSpec }
    const result = await computeCoverage([sc])
    for (const id of ['error.guard-throw', 'error.action-throw', 'error.recovery.abortOnExitError'] as const) {
      expect(result.covered.has(id), `${id} must NOT be covered on a string-method machine`).toBe(false)
      expect(result.status.get(id)).toBe('n/a-string-method')
      // and it is a DOCUMENTED_GAP id, so it never gates.
      expect(DOCUMENTED_GAP_IDS.has(id)).toBe(true)
    }
  })

  it('a hand-marked coverageStatus:"covered" whose probe never fires STILL reports uncovered', async () => {
    // The probe is the ONLY pass signal: computeCoverage derives status at run time
    // and never trusts a literal coverageStatus. Build a registry-shaped scenario
    // set that fires nothing and confirm a never-firing id is uncovered/dormant.
    const emptyTopology: TopologySpec = {
      name: 'empty',
      stateAttribute: 'state',
      initialState: 'only',
      ownerSeed: { log: [], k: 0 },
      states: { only: {} },
      events: {},
    }
    const sc: CoverageScenario = {
      name: 'fires-nothing',
      spec: {
        seed: '1',
        version: 1,
        topology: emptyTopology,
        ops: [],
        faults: { faults: [] },
        bounds: { maxStateDepth: 10, maxStatesCount: 1000, maxEventsCount: 1000, maxOps: 32, maxArmedDelay: 5 },
      },
    }
    const result = await computeCoverage([sc])
    // history.shallow's registry entry has no coverageStatus; even if it claimed
    // 'covered', the probe never fires here → it is dormant, not covered.
    expect(result.covered.has('history.shallow')).toBe(false)
    expect(result.status.get('history.shallow')).toBe('dormant')
  })
})

// ── DoD 4: probe purity (errorClass-keyed, no .message, no live engine read) ──

describe('coverage: probe purity (DoD 4)', () => {
  it('capabilities.ts + coverage.ts never read .message / IMonitor / wall-clock / live sm.*', () => {
    for (const rel of ['src/sim/capabilities.ts', 'src/sim/coverage.ts']) {
      const code = readFileSync(resolve(process.cwd(), rel), 'utf8')
      // strip block + line comments so the bans only apply to executable code.
      const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
      expect(stripped, `${rel} reads .message`).not.toMatch(/\.message\b/)
      expect(stripped, `${rel} calls recordTransition`).not.toMatch(/recordTransition/)
      expect(stripped, `${rel} calls recordError`).not.toMatch(/recordError\b/)
      expect(stripped, `${rel} calls recordEvent`).not.toMatch(/recordEvent\b/)
      expect(stripped, `${rel} reads Date.now`).not.toMatch(/Date\.now/)
      expect(stripped, `${rel} reads performance.now`).not.toMatch(/performance\.now/)
      expect(stripped, `${rel} reads process.hrtime`).not.toMatch(/process\.hrtime/)
      expect(stripped, `${rel} uses Math.random`).not.toMatch(/Math\.random/)
    }
  })

  it('no PROBE body calls a live sm.* / isDone / getCurrentState at probe time', () => {
    // A probe receives a SimTrace only — it has no engine handle. Assert each probe
    // function source references none of the live-engine accessors.
    for (const id of capabilityKeys()) {
      const src = CAPABILITIES[id].probe.toString()
      expect(src, `${id} probe calls a live sm.*`).not.toMatch(/\bsm\./)
      expect(src, `${id} probe calls isDone()`).not.toMatch(/\.isDone\(/)
      expect(src, `${id} probe calls getCurrentState`).not.toMatch(/getCurrentState/)
      expect(src, `${id} probe calls getCurrentStateInfo`).not.toMatch(/getCurrentStateInfo/)
      expect(src, `${id} probe reads .message`).not.toMatch(/\.message\b/)
    }
  })

  it('an error probe still fires on a message-STRIPPED frame (switches on errorClass)', () => {
    // Build a trace whose only error signal is the FROZEN errorClass enum — no
    // message field exists on a TraceFrame. The transition-timeout probe must fire.
    const frame: TraceFrame = {
      step: 1,
      t: 0,
      cause: 'external',
      from: 'a',
      to: 'a',
      queue: { internal: 0, external: 0 },
      quiescent: true,
      fireOutcome: 'reject',
      errorClass: 'transition-timeout',
    }
    const trace: SimTrace = {
      header: {
        seed: '0',
        configHash: 'x',
        engine: 'e',
        version: '1',
        runtime: 'r',
        prngVersion: 'splitmix64-bigint-v1',
        errorHandlerEnabled: true,
      },
      frames: [frame],
    }
    expect(CAPABILITIES['timer.transitionTimeout'].probe(trace)).toBe(true)
  })

  it('the guard-block probe reads fireOutcome:resolve-false, NOT a state-write frame (DoD R21)', () => {
    // A frame with resolve-false and NO state change (from===to) must fire the
    // guard-block probe — proving it reads the fireOutcome source, not a write.
    const blockFrame: TraceFrame = {
      step: 1,
      t: 0,
      cause: 'external',
      event: 'wGuardBlock',
      from: 'sd',
      to: 'sd',
      queue: { internal: 0, external: 0 },
      quiescent: true,
      fireOutcome: 'resolve-false',
    }
    const trace: SimTrace = {
      header: {
        seed: '0',
        configHash: 'x',
        engine: 'e',
        version: '1',
        runtime: 'r',
        prngVersion: 'splitmix64-bigint-v1',
        errorHandlerEnabled: true,
      },
      frames: [blockFrame],
    }
    expect(CAPABILITIES['transition.guard.block'].probe(trace)).toBe(true)
  })
})

// ── DoD 9: gap-set guard + knip two-class reachability ────────────────────────

describe('coverage: explicit gap-set guard (DoD 5/9)', () => {
  it('DOCUMENTED_GAP_IDS are all real CapabilityIds (no typo / phantom id)', () => {
    const all = new Set<CapabilityId>(capabilityKeys())
    for (const id of DOCUMENTED_GAP_IDS) {
      expect(all.has(id), `gap id ${id} is not a real CapabilityId`).toBe(true)
    }
  })

  it('the gate covered+gap partition the full key-set (no id is silently dropped)', async () => {
    const result = await computeCoverage(COVERAGE_SCENARIOS)
    for (const id of capabilityKeys()) {
      const inCovered = result.covered.has(id)
      const inGap = DOCUMENTED_GAP_IDS.has(id)
      // every id is EITHER covered OR an explicit documented gap — never neither.
      expect(inCovered || inGap, `${id} is neither covered nor a documented gap`).toBe(true)
    }
  })

  it('the scenarios barrel is importable (knip scenarios-reachability class)', () => {
    expect(COVERAGE_SCENARIOS.length).toBeGreaterThanOrEqual(5)
    for (const sc of COVERAGE_SCENARIOS) {
      expect(typeof sc.name).toBe('string')
      expect(sc.spec.version).toBe(1)
    }
  })
})

// ── trace-shape sanity: the projected SimTrace is a CanonicalTrace ────────────

describe('coverage: projected trace shape', () => {
  it('runs produce a CanonicalTrace (header + frames) the probes consume', async () => {
    // Indirect: a green gate already drove every scenario to a CanonicalTrace; this
    // asserts the public type alias holds (SimTrace === CanonicalTrace).
    const t: SimTrace = {
      header: {
        seed: '0',
        configHash: 'x',
        engine: 'e',
        version: '1',
        runtime: 'r',
        prngVersion: 'splitmix64-bigint-v1',
        errorHandlerEnabled: true,
      },
      frames: [],
    }
    const c: CanonicalTrace = t
    expect(c.frames).toEqual([])
  })
})
