/**
 * W2b — MB3 corpus acceptance (SPEC §1а criterion).
 *
 * Faithful reproduction of the real MB3 workflow machine
 * `~/work/agent-skills/plugins/workflow-plugins/core-workflow/machines/gated-phase-composite.config.ts`
 * (createGatedPhaseSmConfig): a phase lane where DA-gated phases are composites
 * with two orthogonal regions `work` (WORK_OPEN → WORK_READY[final]) and `gate`
 * (DA_PENDING → DA_REVIEWING → DA_CLEARED[final] with a rejection loop).
 *
 * On HEAD (aa6bf5a) validateConfig emitted 28 warnings on this corpus — the bulk
 * FALSE: UNREACHABLE_STATE on every region entry leaf (WORK_OPEN / DA_PENDING…)
 * plus REGION_MISSING_INITIAL churn from the F10 initial-resolution bug. The
 * criterion: after the model-based rewrite, ONLY genuine warnings remain. This
 * corpus pins EVERY region's initial to first-key order WITHOUT an explicit
 * `initial` (mirroring the real config's documented choice), so the only honest
 * advisory left is REGION_MISSING_INITIAL — and NOTHING else (no UNREACHABLE, no
 * DEAD_END, no error, construction does not throw).
 */
import { describe, expect, it } from 'vitest'
import { createMachine } from '../lite'
import { validateConfig } from '../config_validator'

type Phase = string

/** Region sub-tree for a DA-gated phase (work || gate). NB: NO explicit `initial`. */
function gatedRegions(): Record<string, any> {
  return {
    work: {
      WORK_OPEN: { display: 'Work in progress' },
      WORK_READY: { display: 'Work ready', final: true },
    },
    gate: {
      DA_PENDING: { display: 'DA review pending' },
      DA_REVIEWING: { display: 'DA review in progress' },
      DA_CLEARED: { display: 'DA gate cleared', final: true },
      DA_REJECTED: { display: 'DA review rejected' },
      CORRECTION_LOOP_OPEN: { display: 'Correction loop open' },
    },
  }
}

/** Reproduce createGatedPhaseSmConfig for an ordered phase list with a gated subset. */
function buildGatedPhaseConfig(
  allowedPhases: Phase[],
  daGatedPhases: Phase[],
): any {
  const gated = new Set(daGatedPhases)
  const states: Record<string, any> = {}
  for (const phase of allowedPhases) {
    if (gated.has(phase)) {
      states[phase] = {
        display: `Phase: ${phase} (DA-gated)`,
        regions: gatedRegions(),
      }
    } else {
      states[phase] = { display: `Phase: ${phase}` }
    }
  }

  const advanceTransitions: Array<{ from: string; to: string }> = []
  for (let i = 0; i < allowedPhases.length - 1; i++) {
    advanceTransitions.push({
      from: allowedPhases[i]!,
      to: allowedPhases[i + 1]!,
    })
  }

  const workComplete = daGatedPhases.map((p) => ({
    from: `${p}.work.WORK_OPEN`,
    to: `${p}.work.WORK_READY`,
  }))
  const reviewSubmitted = daGatedPhases.flatMap((p) => [
    { from: `${p}.gate.DA_PENDING`, to: `${p}.gate.DA_REVIEWING` },
    { from: `${p}.gate.DA_REVIEWING`, to: `${p}.gate.DA_REVIEWING` },
  ])
  const reviewApproved = daGatedPhases.map((p) => ({
    from: `${p}.gate.DA_REVIEWING`,
    to: `${p}.gate.DA_CLEARED`,
  }))
  const reviewRejected = daGatedPhases.map((p) => ({
    from: `${p}.gate.DA_REVIEWING`,
    to: `${p}.gate.DA_REJECTED`,
  }))
  const correctionApplied = daGatedPhases.map((p) => ({
    from: `${p}.gate.DA_REJECTED`,
    to: `${p}.gate.CORRECTION_LOOP_OPEN`,
  }))
  const correctionResolved = daGatedPhases.map((p) => ({
    from: `${p}.gate.CORRECTION_LOOP_OPEN`,
    to: `${p}.gate.DA_PENDING`,
  }))

  return {
    name: 'gated-phase-sm',
    stateAttribute: 'state',
    initialState: allowedPhases[0]!,
    states,
    events: {
      PHASE_ADVANCE: { transitions: advanceTransitions },
      WORK_COMPLETE: { transitions: workComplete },
      REVIEW_SUBMITTED: { transitions: reviewSubmitted },
      REVIEW_APPROVED: { transitions: reviewApproved },
      REVIEW_REJECTED: { transitions: reviewRejected },
      CORRECTION_APPLIED: { transitions: correctionApplied },
      CORRECTION_RESOLVED: { transitions: correctionResolved },
    },
  }
}

describe('W2b — MB3 corpus (gated-phase-composite) yields only REAL warnings', () => {
  // A representative tier: VAN, PLAN(gated), IMPLEMENT(gated), QA(gated), ARCHIVE.
  const config = buildGatedPhaseConfig(
    ['VAN', 'PLAN', 'IMPLEMENT', 'QA', 'ARCHIVE'],
    ['PLAN', 'IMPLEMENT', 'QA'],
  )

  it('validateConfig produces NO errors (isValid) and NO false UNREACHABLE', () => {
    const r = validateConfig(config)
    expect(r.errors, JSON.stringify(r.errors.map((e) => e.code))).toHaveLength(0)
    expect(r.isValid).toBe(true)

    // The F10 false-positive family must be GONE.
    expect(r.warnings.some((w) => w.code === 'UNREACHABLE_STATE')).toBe(false)
    expect(r.warnings.some((w) => w.code === 'DEAD_END_STATE')).toBe(false)
    expect(
      r.warnings.some((w) => w.code === 'ANCESTOR_DESCENDANT_OVERLAP'),
    ).toBe(false)
  })

  it('the ONLY warnings left are GENUINE: REGION_MISSING_INITIAL + SELF_TRANSITION', () => {
    const r = validateConfig(config)
    const codes = new Set(r.warnings.map((w) => w.code))
    // REGION_MISSING_INITIAL — real: the corpus deliberately does not pin
    // `initial`, relying on first-key order (documented in the source config).
    // SELF_TRANSITION — real: the idempotent re-submit DA_REVIEWING→DA_REVIEWING.
    // Both are HONEST advisories; the false UNREACHABLE/F10 churn is gone.
    expect([...codes].sort()).toEqual([
      'REGION_MISSING_INITIAL',
      'SELF_TRANSITION',
    ])
    // 2 regions × 3 gated = 6 REGION_MISSING_INITIAL + 1 self-transition × 3 = 9.
    expect(r.warnings).toHaveLength(9)
  })

  it('the region entry leaves are NOT flagged unreachable (F10 fix)', () => {
    const r = validateConfig(config)
    const unreachable = r.warnings
      .filter((w) => w.code === 'UNREACHABLE_STATE')
      .map((w) => w.path)
    expect(unreachable).not.toContain('states.PLAN.work.WORK_OPEN')
    expect(unreachable).not.toContain('states.PLAN.gate.DA_PENDING')
  })

  it('the machine constructs without throwing (model errors would be fatal, but there are none)', () => {
    expect(() => createMachine(config, { state: '' })).not.toThrow()
  })
})
