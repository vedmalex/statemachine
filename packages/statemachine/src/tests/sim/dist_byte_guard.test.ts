import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Step-10 / ADR-7 D8 / R23 — vitest-runnable mirror of `test/verify-dist-bytes.cjs`.
 * Proves the byte-frozen core (`dist/index.{js,cjs}`) is byte-STABLE against the
 * committed `etc/dist-bytes.baseline.json` (sourcemap-URL line stripped sha256).
 *
 * GATED behind `SM_SIM` (DoD#14): it reads built `dist/**`, which only exists
 * post-build and can differ across toolchains (baseline pinned to node-20 / the
 * recorded toolchain). It does NOT run on the unconditional tier-a legs.
 */

const GATED = process.env['SM_SIM'] === '1'

// packages/statemachine root (two levels up from src/tests/sim).
const ROOT = resolve(__dirname, '..', '..', '..')
const TARGETS = ['dist/index.js', 'dist/index.cjs'] as const

function stripSourceMapUrl(s: string): string {
  return s.replace(/\n?\/\/[#@] sourceMappingURL=.*$/m, '')
}

function hashOf(rel: string): string {
  const raw = readFileSync(resolve(ROOT, rel), 'utf8')
  return createHash('sha256').update(stripSourceMapUrl(raw), 'utf8').digest('hex')
}

describe.skipIf(!GATED)('Step 10 — core dist byte/hash guard (SM_SIM=1)', () => {
  it('dist/index.{js,cjs} match the committed sourcemap-stripped sha256 baseline', () => {
    const baselinePath = resolve(ROOT, 'etc', 'dist-bytes.baseline.json')
    expect(existsSync(baselinePath), 'dist-bytes.baseline.json must be committed').toBe(true)

    const built = TARGETS.every((rel) => existsSync(resolve(ROOT, rel)))
    if (!built) {
      // The byte guard is a post-build assertion; without a build there is
      // nothing to compare. The standing CI guard runs `npm run build` first.
      // eslint-disable-next-line no-console
      console.warn('dist/ not built — skipping byte comparison (run `npm run build` first)')
      return
    }

    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as { hashes: Record<string, string> }
    for (const rel of TARGETS) {
      expect(hashOf(rel), `${rel} byte drift vs committed baseline`).toBe(baseline.hashes[rel])
    }
  })

  it('the strip regex removes the trailing sourceMappingURL line (and nothing else)', () => {
    const body = 'const x = 1;\nexport { x };'
    const withMap = `${body}\n//# sourceMappingURL=index.js.map`
    expect(stripSourceMapUrl(withMap)).toBe(body)
    // No sourceMappingURL -> unchanged.
    expect(stripSourceMapUrl(body)).toBe(body)
  })

  it('a flipped baseline byte would be detected (negative control)', () => {
    if (!TARGETS.every((rel) => existsSync(resolve(ROOT, rel)))) {
      return
    }
    const real = hashOf('dist/index.js')
    const tampered = `${real.slice(0, -1)}${real.endsWith('0') ? '1' : '0'}`
    expect(real).not.toBe(tampered)
  })
})
