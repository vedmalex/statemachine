/**
 * @module tests/sim/capabilities_gap_pin
 *
 * FIX 1 (F-PF-1) — PIN the ADR-8 mandatory coverage gate's exclusion set.
 *
 * `DOCUMENTED_GAP_IDS` is the ONLY place `computeCoverage` (coverage.ts) excludes a
 * CapabilityId from the `uncovered>0` gate failure. It was once silently widened
 * from the TECH_SPEC §3.7-frozen minimal set to twelve ids, neutering the gate on
 * ~1/3 of the registry. This test deep-equal PINS the exact final set (sorted) so
 * it cannot drift again, and asserts every gapped id is a REAL CapabilityId (no
 * phantom/typo). Adding or removing a gap id here REQUIRES updating this pin (and
 * the TECH_SPEC §3.7 record) — that is the intended friction.
 */

import { describe, expect, it } from 'vitest'
import { CAPABILITIES, type CapabilityId, DOCUMENTED_GAP_IDS, capabilityKeys } from '../../sim/capabilities'
import { type CoverageScenario, computeCoverage } from '../../sim/coverage'
import { COVERAGE_SCENARIOS } from '../../sim/scenarios/index'

/**
 * The EXACT frozen-minimal gap set (sorted). Four frozen-minimal (string-method
 * error throws + dormant queue-depth bound) + three additionally-kept-gapped,
 * structurally-unreachable ids recorded in TECH_SPEC §3.7 (F-PF-1 amendment):
 *   - queue.internal-before-external (boundary-only trace ⇒ internal===0 always)
 *   - event.onSuccess (engine never dispatches it at runtime)
 *   - event.onError (dispatched un-awaited; ErrorHandler returns void)
 */
const EXPECTED_GAP_IDS_SORTED: readonly CapabilityId[] = [
  'error.action-throw',
  'error.guard-throw',
  'error.recovery.abortOnExitError',
  'event.onError',
  'event.onSuccess',
  'queue.depth-bound.max-transition',
  'queue.internal-before-external',
]

describe('FIX 1 — DOCUMENTED_GAP_IDS is pinned to the frozen-minimal set', () => {
  it('deep-equals the exact expected gap set (sorted) — cannot silently re-widen', () => {
    const actualSorted = [...DOCUMENTED_GAP_IDS].sort()
    expect(actualSorted).toEqual([...EXPECTED_GAP_IDS_SORTED])
    // Size guard makes an accidental ADD legible (not just a reorder).
    expect(DOCUMENTED_GAP_IDS.size).toBe(EXPECTED_GAP_IDS_SORTED.length)
    expect(DOCUMENTED_GAP_IDS.size).toBe(7)
  })

  it('every gapped id is a real CapabilityId (no typo / phantom id)', () => {
    const all = new Set<CapabilityId>(capabilityKeys())
    for (const id of DOCUMENTED_GAP_IDS) {
      expect(all.has(id), `gap id ${id} is not a real CapabilityId`).toBe(true)
      // It is a real registry entry with a probe.
      expect(typeof CAPABILITIES[id].probe).toBe('function')
    }
  })

  it('the five F-PF-1-recovered ids are NOT gapped (they are now covered)', () => {
    // The exact eight ids the gate was wrongly excluding; five are now coverable and
    // MUST NOT be in the gap set. (The remaining three stay gapped above.)
    const recovered: readonly CapabilityId[] = [
      'queue.backpressure.overflow',
      'timer.transitionTimeout',
      'timer.resume',
      'persistence.serialize',
      'persistence.deserialize',
    ]
    for (const id of recovered) {
      expect(DOCUMENTED_GAP_IDS.has(id), `${id} must NOT be a documented gap (it is covered)`).toBe(false)
    }
  })
})

// ── negative proof: removing a newly-covering scenario re-fails the gate ──────

describe('FIX 1 — the strengthened gate is genuinely teethed (negative proof)', () => {
  it('removing the overflow scenario leaves queue.backpressure.overflow UNCOVERED + exit 1', async () => {
    // Drop the overflow scenario from the registered set; its id is no longer a
    // documented gap, so the gate MUST report it uncovered and exit non-zero. This
    // is the programmatic equivalent of "delete a covering scenario → gate fails",
    // committed as a permanent regression guard (proves the gate is not vacuous).
    const without: readonly CoverageScenario[] = COVERAGE_SCENARIOS.filter((s) => s.name !== 'queue-overflow')
    const result = await computeCoverage(without)
    expect(result.uncovered.has('queue.backpressure.overflow')).toBe(true)
    expect(result.exitCode).not.toBe(0)
  }, 60_000)

  it('removing the snapshot/restore scenario leaves the three persistence ids UNCOVERED + exit 1', async () => {
    const without: readonly CoverageScenario[] = COVERAGE_SCENARIOS.filter((s) => s.name !== 'persistence')
    const result = await computeCoverage(without)
    for (const id of ['persistence.serialize', 'persistence.deserialize', 'timer.resume'] as const) {
      expect(result.uncovered.has(id), `${id} should be uncovered without the persistence scenario`).toBe(true)
    }
    expect(result.exitCode).not.toBe(0)
  }, 60_000)

  it('removing the transitionTimeout scenario leaves timer.transitionTimeout UNCOVERED + exit 1', async () => {
    const without: readonly CoverageScenario[] = COVERAGE_SCENARIOS.filter((s) => s.name !== 'transition-timeout')
    const result = await computeCoverage(without)
    expect(result.uncovered.has('timer.transitionTimeout')).toBe(true)
    expect(result.exitCode).not.toBe(0)
  }, 60_000)

  it('the FULL registered set still passes the strengthened gate (exit 0, the recovered ids covered)', async () => {
    const result = await computeCoverage(COVERAGE_SCENARIOS)
    expect(result.exitCode).toBe(0)
    for (const id of [
      'queue.backpressure.overflow',
      'timer.transitionTimeout',
      'timer.resume',
      'persistence.serialize',
      'persistence.deserialize',
    ] as const) {
      expect(result.covered.has(id), `${id} must be covered by the full set`).toBe(true)
    }
  }, 60_000)
})
