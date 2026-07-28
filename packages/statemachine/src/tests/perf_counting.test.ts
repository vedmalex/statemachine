// U7 / #15 (MASTER §4б) — COUNTING PERF PROBE for the composite write hot path.
//
// §4б mandates a perf-RED that is a COUNTED metric, not wall-clock ms (CI
// hardware makes ms flaky). We install a TEST-ONLY probe (symbol-gated on
// globalThis; see `state_machine.ts` PERF_PROBE_KEY) that counts "units of work"
// on two hot paths, and assert the counts grow O(R) in the region count R — NOT
// Θ(R²) — over a gradient R ∈ {40, 80, 160, 320}. Deterministic: the counters
// are exact integers, so the slope is a fact, not a timing.
//
// Two Θ(R²) sites were found by this probe on HEAD-before-fix and repaired:
//
//   PERF-03  computeInternalWrite — the per-part conflict scan re-scanned the
//            whole (growing) config map for every incoming region part, so
//            constructing an R-region parallel composite (setInitialState writes
//            the R-part expanded configuration) cost R(R-1)/2 units:
//              R=40→780  R=80→3160  R=160→12720  R=320→51040   (≈4× per doubling
//              of R ⇒ Θ(R²); ratio 320/40 ≈ 65 ≈ 8²).
//            After the fix (O(depth) ancestor prefix-walk + depth-gated
//            descendant scan) it is 2·R:  40→80 80→160 160→320 320→640.
//
//   PERF-02  isCompositeDone — the per-region `find` scanned all R leaves for
//            each of the R regions, so a COMPLETING R-region composite cost
//            R(R+1)/2 units (reached UNCONDITIONALLY from checkCompletion on
//            every write):
//              R=40→820  R=80→3240  R=160→12880  R=320→51360   (≈4× per doubling
//              ⇒ Θ(R²); ratio 320/40 ≈ 63 ≈ 8²).
//            After the fix (one O(R) region→leaf index pass) it is R:
//              40→40 80→80 160→160 320→320. checkCompletion additionally
//            early-returns when no `done.state.*` event is declared, so the scan
//            is not even reached in the common case.
//
// The probe is TEST-ONLY: production never installs the probe object, so the
// instrumented paths pay a single truthy check. Nothing about engine behaviour
// changes — the full suite (1004 tests) is the behaviour-preservation oracle.

import { describe, expect, it } from 'vitest'
import { StateMachine } from '../state_machine'
import type { StateMachineConfig } from '../types'

const PERF_PROBE_KEY = Symbol.for('@vedmalex/statemachine:perfProbe')

interface SmPerfProbe {
  internalWriteScan: number
  completionScan: number
}

interface Ctx {
  state: string
}

const GRADIENT = [40, 80, 160, 320] as const

/** R parallel regions, each `{ idle, work }` — the composite-write stressor. */
function buildParallel(R: number): StateMachineConfig<Ctx> {
  const regions: Record<string, Record<string, unknown>> = {}
  for (let i = 0; i < R; i++) {
    regions[`r${i}`] = { idle: {}, work: {} }
  }
  return {
    name: `P${R}`,
    initialState: 'P',
    stateAttribute: 'state',
    states: { P: { regions } },
    events: {},
  } as unknown as StateMachineConfig<Ctx>
}

/** R parallel regions, each a single `final` leaf — drives a COMPLETING scan. */
function buildAllFinal(R: number): StateMachineConfig<Ctx> {
  const regions: Record<string, Record<string, unknown>> = {}
  for (let i = 0; i < R; i++) {
    regions[`r${i}`] = { done: { final: true } }
  }
  return {
    name: `PF${R}`,
    initialState: 'P',
    stateAttribute: 'state',
    states: { P: { regions } },
    events: {},
  } as unknown as StateMachineConfig<Ctx>
}

/** Run `fn` with a fresh probe installed; always removes it afterward. */
function withProbe<T>(fn: (probe: SmPerfProbe) => T): T {
  const probe: SmPerfProbe = { internalWriteScan: 0, completionScan: 0 }
  const g = globalThis as Record<symbol, unknown>
  g[PERF_PROBE_KEY] = probe
  try {
    return fn(probe)
  } finally {
    delete g[PERF_PROBE_KEY]
  }
}

/**
 * Assert `counts[i]` grows LINEARLY in `GRADIENT[i]`, i.e. O(R) not Θ(R²):
 * every doubling of R roughly doubles the count (~2×), and the full-range ratio
 * is ~8× (2³), NOT ~64× (8²) which a quadratic path would show. Bounds are wide
 * enough to absorb small constant terms yet reject any super-linear growth
 * (a doubling ratio ≥ 3, or a total ratio ≥ 16, means super-linear).
 */
function expectLinear(label: string, counts: number[]): void {
  // Non-trivial work must actually happen, else the assertion is vacuous.
  expect(counts.every((c) => c > 0), `${label}: probe counted work`).toBe(true)

  for (let i = 1; i < counts.length; i++) {
    const ratio = counts[i] / counts[i - 1] // R doubled between samples
    expect(
      ratio,
      `${label}: doubling R (${GRADIENT[i - 1]}→${GRADIENT[i]}) must ~double the count (linear), got ${ratio.toFixed(2)}× [${counts.join(', ')}]`,
    ).toBeLessThan(3)
  }

  const totalRatio = counts[counts.length - 1] / counts[0] // R grew 8×
  expect(
    totalRatio,
    `${label}: R grew 8× (${GRADIENT[0]}→${GRADIENT[GRADIENT.length - 1]}); a linear path grows ~8×, a Θ(R²) path ~64×. Got ${totalRatio.toFixed(1)}× [${counts.join(', ')}]`,
  ).toBeLessThan(16)
}

describe('U7/#15 · composite write hot path is O(R), not Θ(R²) (counting probe)', () => {
  it('PERF-03 · construction conflict-scan grows linearly in region count', () => {
    const counts = GRADIENT.map((R) => {
      const cfg = buildParallel(R)
      return withProbe((probe) => {
        // Construction runs setInitialState → the R-part composite write, the
        // exact path that was Θ(R²) before the fix.
        const sm = new StateMachine(cfg, { state: '' })
        // Sanity: the machine really did enter all R regions.
        expect(sm.getCurrentState()?.split('|').length).toBe(R)
        return probe.internalWriteScan
      })
    })
    expectLinear('computeInternalWrite conflict-scan', counts)
  })

  it('PERF-02 · completion (isCompositeDone) scan grows linearly in region count', () => {
    const counts = GRADIENT.map((R) => {
      const sm = new StateMachine(buildAllFinal(R), { state: '' })
      return withProbe((probe) => {
        // isDone drives isCompositeDone over all R regions of an all-final
        // config — the completing scan that was Θ(R²) before the fix.
        expect(sm.isDone('P')).toBe(true)
        return probe.completionScan
      })
    })
    expectLinear('isCompositeDone region scan', counts)
  })

  it('checkCompletion is conditional: declaring done.state.* adds completion-scan work that the gate removes', async () => {
    // PERF-02 conditional gate. Two identical 2-region composites completing on
    // the same `goA`+`goB` sequence; one DECLARES `done.state.P`, the other does
    // not. isCompositeDone is also reached from join/final detection, so the
    // baseline is non-zero either way — but only the DECLARED machine runs
    // checkCompletion's isCompositeDone probes on each write, so the gate's
    // effect is observable as strictly MORE completion-scan work when declared.
    const base = (withDone: boolean): StateMachineConfig<Ctx> =>
      ({
        name: withDone ? 'gate-on' : 'gate-off',
        initialState: 'P',
        stateAttribute: 'state',
        states: {
          P: {
            regions: {
              a: { s1: {}, f: { final: true } },
              b: { s1: {}, f: { final: true } },
            },
          },
        },
        events: {
          goA: { transitions: [{ from: 'P.a.s1', to: 'P.a.f' }] },
          goB: { transitions: [{ from: 'P.b.s1', to: 'P.b.f' }] },
          ...(withDone ? { 'done.state.P': { transitions: [] } } : {}),
        },
      }) as unknown as StateMachineConfig<Ctx>

    const measure = async (withDone: boolean): Promise<number> => {
      const sm = new StateMachine(base(withDone), { state: '' })
      const probe: SmPerfProbe = { internalWriteScan: 0, completionScan: 0 }
      const g = globalThis as Record<symbol, unknown>
      g[PERF_PROBE_KEY] = probe
      try {
        await sm.fireEvent('goA' as never)
        await sm.fireEvent('goB' as never) // completes composite P
        return probe.completionScan
      } finally {
        delete g[PERF_PROBE_KEY]
      }
    }

    const off = await measure(false)
    const on = await measure(true)
    // The gate removes checkCompletion's per-write completion scan when no
    // completion event is declared: strictly less work than the declared machine.
    expect(on).toBeGreaterThan(off)
  })
})

// U7 correctness companion (critic F4a): the PERF-03 conflict scan must be
// DOT-BOUNDARY exact — entering a leaf in region `r1` must NOT evict a sibling
// region `r10` whose key shares the `r1` string prefix. (The pre-U7 predicate was
// already dot-boundary — `startsWith(regionKey + '.')` — so this is a strict
// equivalence pin, guarding the optimized ancestor-walk + descendant-scan against
// a future naive `startsWith` regression.)
describe('U7/#15 · conflict scan is dot-boundary exact (prefix-named sibling regions survive)', () => {
  it('entering a leaf in region r1 does NOT evict sibling region r10', async () => {
    const cfg: StateMachineConfig<{ state: string }> = {
      name: 'PrefixSibling',
      stateAttribute: 'state',
      initialState: 'P',
      states: {
        P: { regions: { r1: { a: {}, b: {} }, r10: { x: {} } } },
      },
      events: { go: { transitions: [{ from: 'P.r1.a', to: 'P.r1.b' }] } },
    }
    const sm = new StateMachine(cfg, { state: '' })
    const before = sm.getCurrentState()?.split('|') ?? []
    expect(before).toContain('P.r10.x')
    await sm.fireEvent('go' as never)
    const after = sm.getCurrentState()?.split('|') ?? []
    // r1 advanced…
    expect(after).toContain('P.r1.b')
    expect(after).not.toContain('P.r1.a')
    // …and the prefix-named sibling r10 is UNTOUCHED (not evicted by an `r1` prefix).
    expect(after).toContain('P.r10.x')
  })
})
