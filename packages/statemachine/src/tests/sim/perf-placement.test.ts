import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Step-11 (E) — perf PLACEMENT (UNGATED, dependency-free). The median-of-N=5 perf
 * REGRESSION (bands 20/25/30 + traceLen-zero, `--expose-gc`) runs ONLY in
 * sim-nightly.yml; the PR leg runs only the THROUGHPUT/traceLen-only perf SMOKE
 * inside `sim:pr`. This locks the split so a future edit cannot accidentally move
 * the slow regression onto the PR leg (slow-runner-flake avoidance).
 */

const REPO_ROOT = resolve(process.cwd(), '..', '..')

function readRepo(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8')
}

describe('Step 11 — perf regression placement (DoD 7/E)', () => {
  it('sim:perf (the regression) is in the nightly workflow, NOT the PR ci.yml leg', () => {
    const nightly = readRepo('.github/workflows/sim-nightly.yml')
    const ci = readRepo('.github/workflows/ci.yml')
    expect(nightly, 'nightly must run the perf regression').toContain('npm run sim:perf')
    expect(ci, 'ci.yml PR leg must NOT run the perf regression').not.toContain('npm run sim:perf')
  })

  it('the PR leg runs the bounded sim:pr (which carries the threshold-free perf SMOKE), not sim:perf', () => {
    const ci = readRepo('.github/workflows/ci.yml')
    expect(ci).toContain('npm run sim:pr')
    // sim:pr runs on the single latest-LTS tier-a-node leg (no node-18/20 matrix guard).
    const lines = ci.split('\n')
    const idx = lines.findIndex((l) => l.includes('npm run sim:pr'))
    expect(idx).toBeGreaterThan(0)
    expect(lines.slice(Math.max(0, idx - 1), idx + 1).join('\n')).not.toMatch(/matrix\.node-version/)
  })

  it('the sim:pr perf SMOKE is threshold-free (traceLen determinism only) — no band literal in sim-pr.ts', () => {
    const smokeSrc = readFileSync(resolve(process.cwd(), 'src/sim/cli/sim-pr.ts'), 'utf8')
    const code = smokeSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    // No throughput/heap/p99 band threshold in the PR-gate code path.
    expect(/p99|throughput.*threshold|heapPeak|eventsPerSec\s*[<>]/.test(code)).toBe(false)
    // The smoke compares traceLen across runs (determinism), not a magnitude.
    expect(code).toContain('traceLen')
  })
})
