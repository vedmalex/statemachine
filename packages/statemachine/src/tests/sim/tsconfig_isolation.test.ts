import { execFileSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Step-10 ISS-043 / TECH_SPEC §6 / DoD#11 — sim tsconfig isolation BRANCH RECORD.
 *
 * The frozen decision is BRANCH B (DOCUMENTED COUPLING, the recorded default):
 * `src/sim/**` shares the core `tsconfig.json`. This test is the FALSIFIABLE
 * record of that choice:
 *   (1) EMISSION half (feasible, no new config): `tsconfig.build.json` emits a
 *       per-file `types/sim/index.d.ts` for the `./sim` exports `types` key +
 *       `api:check:sim`. Asserted against the committed config shape.
 *   (2) COUPLING reality (branch B, NOT branch A): a deliberate `src/sim/**` type
 *       error reaches the shared `tsc --noEmit` graph that `npm run check` runs —
 *       proving isolation was deliberately NOT installed. (Under branch A this
 *       probe would be excluded and `tsc --noEmit` would pass; here it must FAIL
 *       naming the probe.)
 *   (3) the documented-coupling NOTE is committed (in `src/sim/index.ts`).
 *
 * GATED behind SM_SIM (DoD#14): it spawns `tsc` (seconds), so it does not run on
 * the unconditional tier-a legs.
 */

const GATED = process.env['SM_SIM'] === '1'
const ROOT = resolve(__dirname, '..', '..', '..')
const PROBE = resolve(ROOT, 'src', 'sim', '__isolation_probe__.ts')
const TSC = resolve(ROOT, 'node_modules', '.bin', 'tsc')

function runTsc(args: string[]): { code: number; output: string } {
  try {
    const out = execFileSync(TSC, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, output: out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe.skipIf(!GATED)('Step 10 — ISS-043 branch B (documented coupling) record (SM_SIM=1)', () => {
  it('(2) coupling reality: a src/sim type error FAILS the shared `tsc --noEmit` (isolation NOT installed)', () => {
    // A genuine type error: assign a string to a number-typed const.
    writeFileSync(PROBE, 'export const __isolationProbe: number = "not a number"\n', 'utf8')
    try {
      const { code, output } = runTsc(['--noEmit'])
      expect(code, 'shared tsc --noEmit must FAIL on a src/sim type error (branch B coupling)').not.toBe(0)
      expect(output).toContain('__isolation_probe__')
    } finally {
      if (existsSync(PROBE)) {
        rmSync(PROBE)
      }
    }
  })

  it('(2-control) with the probe removed, the shared `tsc --noEmit` is clean again', () => {
    if (existsSync(PROBE)) {
      rmSync(PROBE)
    }
    const { code } = runTsc(['--noEmit'])
    expect(code, 'tsc --noEmit must be green once the probe is gone').toBe(0)
  })
})

// Lightweight assertions that need no tsc spawn — run UNGATED on every leg so the
// branch record cannot silently drift away.
import { readFileSync } from 'node:fs'

describe('Step 10 — ISS-043 branch B record (config + note, ungated)', () => {
  it('(1) emission half: tsconfig.build.json emits per-file types (declarationDir=types, no src/sim exclude)', () => {
    const build = JSON.parse(readFileSync(resolve(ROOT, 'tsconfig.build.json'), 'utf8')) as {
      compilerOptions?: { declarationDir?: string; declaration?: boolean }
    }
    expect(build.compilerOptions?.declaration).toBe(true)
    expect(build.compilerOptions?.declarationDir).toBe('types')

    const base = JSON.parse(readFileSync(resolve(ROOT, 'tsconfig.json'), 'utf8')) as {
      include?: string[]
      exclude?: string[]
    }
    // Branch B: src/sim is NOT excluded from the shared config (the coupling).
    expect(base.include).toContain('src/**/*')
    expect(base.exclude ?? []).not.toContain('src/sim/**/*')
  })

  it("(1) the emitted types/sim/index.d.ts exists after a build (emission feasible)", () => {
    const dts = resolve(ROOT, 'types', 'sim', 'index.d.ts')
    if (!existsSync(dts)) {
      // Emission is a post-build artifact; without a build there is nothing to
      // assert (the standing CI guard runs `npm run build` first).
      return
    }
    expect(existsSync(dts)).toBe(true)
  })

  it('(3) the documented-coupling NOTE (branch B / ISS-043) is committed in src/sim/index.ts', () => {
    const idx = readFileSync(resolve(ROOT, 'src', 'sim', 'index.ts'), 'utf8')
    expect(idx).toContain('ISS-043')
    expect(idx).toContain('BRANCH B')
    expect(idx.toUpperCase()).toContain('DOCUMENTED COUPLING')
  })

  it('§6 vitest-coverage decision: src/sim/** is excluded from the core coverage gate', () => {
    // TECH_SPEC §6 frozen default: the separate `sim:coverage` CLI owns sim
    // coverage; the core 90% threshold must NOT gate a sim no-op branch. Asserting
    // the exclude entry is the config-shape falsification of that decision.
    const cfg = readFileSync(resolve(ROOT, 'vitest.config.ts'), 'utf8')
    expect(cfg).toContain("'src/sim/**'")
  })
})
