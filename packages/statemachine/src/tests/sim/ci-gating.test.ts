import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Step-11 CI-wiring structural checks (UNGATED determinism-floor — they assert the
 * SHAPE of the rendered workflow YAML + package.json, with NO heavy run, so they
 * are cheap and run on every leg). Dependency-free: parses the raw YAML text with
 * string/regex predicates rather than `actionlint`/`gh`/a YAML lib (build-plan §11
 * DoD 1/7/9/10).
 */

// Repo root is two levels up from packages/statemachine.
const REPO_ROOT = resolve(process.cwd(), '..', '..')
const PKG_ROOT = process.cwd()

function readRepo(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8')
}
function readPkg(rel: string): string {
  return readFileSync(resolve(PKG_ROOT, rel), 'utf8')
}

// ── DoD 1: ci.yml tier-a-node gets the four node-20-ONLY DST steps ────────────

describe('Step 11 — ci.yml latest-LTS (Node 24) DST gate (DoD 1)', () => {
  const ci = readRepo('.github/workflows/ci.yml')

  it('appends sim:pr / api:check:sim / sim-api diff / verify-dist-bytes, each once', () => {
    const steps = [
      'npm run sim:pr',
      'npm run api:check:sim',
      'git diff --exit-code etc/statemachine-sim.api.md',
      'node test/verify-dist-bytes.cjs',
    ]
    for (const s of steps) {
      const occurrences = ci.split(s).length - 1
      expect(occurrences, `step ${JSON.stringify(s)} must occur exactly once in ci.yml`).toBe(1)
    }
  })

  it('the DST steps run on the single latest-LTS tier-a-node leg (Node 24), with no node-18/20 matrix or per-version guard', () => {
    // Latest-LTS-only policy: CI dropped the former [18, 20] build matrix and its
    // per-version `if: matrix.node-version == 20` guards. tier-a-node now pins Node 24
    // and the DST steps run unconditionally on that single leg (never on tier-a-bun/tier-b).
    expect(ci, 'tier-a-node must pin Node 24 (latest LTS)').toMatch(/tier-a-node:[\s\S]*?node-version:\s*24/)
    expect(ci, 'the dropped node-18/20 build matrix must not return').not.toMatch(/node-version:\s*\[/)
    expect(ci, 'per-version matrix guards must be gone').not.toContain('matrix.node-version')
    const lines = ci.split('\n')
    const newRunFragments = [
      'npm run sim:pr',
      'npm run api:check:sim',
      'git diff --exit-code etc/statemachine-sim.api.md',
      'node test/verify-dist-bytes.cjs',
    ]
    for (const frag of newRunFragments) {
      const runIdx = lines.findIndex((l) => l.includes(frag))
      expect(runIdx, `fragment ${frag} not found`).toBeGreaterThan(0)
      // No matrix guard above the step — it runs on the single leg.
      const guardWindow = lines.slice(Math.max(0, runIdx - 1), runIdx + 1).join('\n')
      expect(guardWindow, `step ${frag} must NOT be matrix-guarded`).not.toMatch(/matrix\.node-version/)
    }
  })

  it('the DST steps live in tier-a-node, never in tier-a-bun/tier-b', () => {
    // Slice the YAML by job; the DST fragments must only appear in tier-a-node.
    const tierANodeStart = ci.indexOf('tier-a-node:')
    const tierBDenoStart = ci.indexOf('tier-b-deno:')
    expect(tierANodeStart).toBeGreaterThan(0)
    expect(tierBDenoStart).toBeGreaterThan(tierANodeStart)
    const tierANode = ci.slice(tierANodeStart, tierBDenoStart)
    const elsewhere = ci.slice(0, tierANodeStart) + ci.slice(tierBDenoStart)
    for (const frag of ['npm run sim:pr', 'npm run api:check:sim', 'node test/verify-dist-bytes.cjs']) {
      expect(tierANode, `${frag} belongs in tier-a-node`).toContain(frag)
      expect(elsewhere, `${frag} must NOT appear outside tier-a-node`).not.toContain(frag)
    }
  })
})

// ── DoD 7: sim-nightly.yml is a SEPARATE file with the required structure ─────

describe('Step 11 — sim-nightly.yml structural check (DoD 7)', () => {
  const nightly = readRepo('.github/workflows/sim-nightly.yml')

  it('has a cron schedule + workflow_dispatch trigger', () => {
    expect(nightly).toMatch(/schedule:/)
    expect(nightly).toMatch(/cron:\s*["']0 3 \* \* \*["']/)
    expect(nightly).toMatch(/workflow_dispatch:/)
  })

  it('shards 0..7 (length 8), fail-fast:false, timeout 60, working-directory pinned', () => {
    expect(nightly).toMatch(/shard:\s*\[0, 1, 2, 3, 4, 5, 6, 7\]/)
    expect(nightly).toMatch(/fail-fast:\s*false/)
    expect(nightly).toMatch(/timeout-minutes:\s*60/)
    expect(nightly).toMatch(/working-directory:\s*packages\/statemachine/)
  })

  it('runs the sweep with SM_SIM/SIM_SHARD/SIM_SHARDS and uploads repro on failure', () => {
    expect(nightly).toMatch(/npm run sim:sweep/)
    expect(nightly).toMatch(/SIM_SHARDS:\s*["']8["']/)
    expect(nightly).toMatch(/if:\s*failure\(\)/)
    expect(nightly).toMatch(/actions\/upload-artifact@v4/)
    // The upload path is rooted to survive defaults.run.working-directory.
    expect(nightly).toMatch(/packages\/statemachine\/\.sim-out\/\*\*/)
  })

  it('the perf REGRESSION (sim:perf) runs in nightly, NOT on the PR leg', () => {
    expect(nightly).toMatch(/npm run sim:perf/)
    const ci = readRepo('.github/workflows/ci.yml')
    expect(ci, 'sim:perf regression must NOT be on the ci.yml PR leg').not.toContain('npm run sim:perf')
  })
})

// ── DoD 9/10: package.json scripts + prepublishOnly wiring ────────────────────

describe('Step 11 — package.json script wiring (DoD 9/10)', () => {
  const pkg = JSON.parse(readPkg('package.json')) as { scripts: Record<string, string> }

  it('sim:pr / sim:sweep / api:check:sim scripts exist', () => {
    expect(pkg.scripts['sim:pr']).toBeDefined()
    expect(pkg.scripts['sim:sweep']).toBeDefined()
    expect(pkg.scripts['api:check:sim']).toContain('api-extractor run --local --config api-extractor.sim.json')
  })

  it('prepublishOnly runs verify-dist-bytes after verify-dist', () => {
    const ppo = pkg.scripts.prepublishOnly
    expect(ppo).toContain('node test/verify-dist.cjs')
    expect(ppo).toContain('node test/verify-dist-bytes.cjs')
    expect(ppo.indexOf('verify-dist.cjs')).toBeLessThan(ppo.indexOf('verify-dist-bytes.cjs'))
  })

  it('release.yml ALSO carries the byte guard after verify-dist.cjs', () => {
    const rel = readRepo('.github/workflows/release.yml')
    expect(rel).toContain('node test/verify-dist-bytes.cjs')
    expect(rel.indexOf('verify-dist.cjs')).toBeLessThan(rel.indexOf('verify-dist-bytes.cjs'))
  })
})

// ── DoD 11: .sim-out/** is gitignored ─────────────────────────────────────────

describe('Step 11 — .sim-out gitignore (DoD 11)', () => {
  it('.sim-out/ is ignored at the repo root so a local sweep never dirties the tree', () => {
    const gi = readRepo('.gitignore')
    expect(gi).toMatch(/\.sim-out\//)
  })
})
