import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Step-10 / ADR-7 D8 / R23 — vitest-runnable mirror of `test/verify-dist-bytes.cjs`.
 * Proves the byte-frozen core (`dist/index.{js,cjs}`) is byte-STABLE against the
 * committed `etc/dist-bytes.baseline.json` (sourcemap-URL line stripped sha256).
 *
 * GATED behind `SM_SIM` (DoD#14): it reads built `dist/**`, which only exists
 * post-build and can differ across toolchains (baseline pinned to node-24 / the
 * recorded toolchain). It does NOT run on the unconditional tier-a legs.
 *
 * IT DOES RUN IN CI. `npm run sim:guards` (package.json) invokes this file with
 * `SM_SIM=1` from `.github/workflows/ci.yml`'s `tier-a-node` leg, AFTER
 * `npm run build`. Before this wave `SM_SIM=1` reached no CI leg that ran this
 * file — the only `SM_SIM=1` step is `sim:pr`, which scopes vitest to a single
 * unrelated file — so this whole describe was dormant on every leg.
 *
 * ## An absent `dist/` is a FAILURE, not a skip
 * The main assertion used to `console.warn` and `return` when `dist/` was
 * missing, which made an unbuilt tree pass green. A guard that passes when there
 * is nothing to guard asserts nothing; the run must say so out loud and tell the
 * caller to build.
 */

const GATED = process.env['SM_SIM'] === '1'

// packages/statemachine root (two levels up from src/tests/sim).
const ROOT = resolve(__dirname, '..', '..', '..')
const TARGETS = ['dist/index.js', 'dist/index.cjs'] as const

function stripSourceMapUrl(s: string): string {
  return s.replace(/\n?\/\/[#@] sourceMappingURL=.*$/m, '')
}

/**
 * The hash under test, over ARBITRARY bytes rather than a fixed path — so the
 * negative control can push tampered bytes through the very same function the
 * real assertion uses, instead of asserting something about its output string.
 */
function hashBytes(raw: string): string {
  return createHash('sha256').update(stripSourceMapUrl(raw), 'utf8').digest('hex')
}

function hashOf(rel: string): string {
  return hashBytes(readFileSync(resolve(ROOT, rel), 'utf8'))
}

function readBaseline(): { hashes: Record<string, string> } {
  return JSON.parse(readFileSync(resolve(ROOT, 'etc', 'dist-bytes.baseline.json'), 'utf8')) as {
    hashes: Record<string, string>
  }
}

describe.skipIf(!GATED)('Step 10 — core dist byte/hash guard (SM_SIM=1)', () => {
  it('the built artifacts EXIST — an unbuilt tree FAILS instead of passing green', () => {
    expect(
      existsSync(resolve(ROOT, 'etc', 'dist-bytes.baseline.json')),
      'dist-bytes.baseline.json must be committed',
    ).toBe(true)
    const missing = TARGETS.filter((rel) => !existsSync(resolve(ROOT, rel)))
    expect(
      missing,
      'dist/ is not built, so every byte comparison below would be vacuous. Run `npm run build` ' +
        'first — CI runs it before `npm run sim:guards`.',
    ).toEqual([])
  })

  it('dist/index.{js,cjs} match the committed sourcemap-stripped sha256 baseline', () => {
    const baseline = readBaseline()
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

  it('NEGATIVE CONTROL: one flipped byte in a COPY of the artifact is REJECTED', () => {
    // The old control hashed the real artifact, mutated the resulting HEX STRING
    // and asserted `real !== tampered`. That is a fact about string inequality —
    // it never re-invoked the comparison, so it demonstrated nothing about
    // whether a byte flip would be caught.
    //
    // This one flips a byte in the ARTIFACT, in a scratch copy outside the repo,
    // and pushes it back through the SAME hash and the SAME baseline comparison
    // the real assertion uses. `dist/` and `etc/dist-bytes.baseline.json` are
    // never written.
    const baseline = readBaseline()
    const dir = mkdtempSync(join(tmpdir(), 'sm-dist-byteguard-'))
    try {
      for (const rel of TARGETS) {
        const raw = readFileSync(resolve(ROOT, rel), 'utf8')
        // The control is only meaningful if the UNtampered copy still passes.
        expect(hashBytes(raw), `${rel}: the untampered copy must reproduce the baseline`).toBe(
          baseline.hashes[rel],
        )

        // Flip ONE character at a deterministic interior offset, far from the
        // sourcemap-URL tail the strip regex is allowed to remove.
        const at = Math.floor(raw.length / 2)
        const ch = raw[at] as string
        const flipped = `${raw.slice(0, at)}${ch === 'a' ? 'b' : 'a'}${raw.slice(at + 1)}`
        expect(flipped, 'the flip must actually change the bytes').not.toBe(raw)

        const copy = join(dir, rel.replace('/', '_'))
        writeFileSync(copy, flipped, 'utf8')

        // Re-run the guard's own comparison against the tampered artifact.
        expect(
          hashBytes(readFileSync(copy, 'utf8')),
          `${rel}: a single flipped byte hashed to the baseline — the guard cannot detect tampering`,
        ).not.toBe(baseline.hashes[rel])
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('NEGATIVE CONTROL: the strip regex is the ONLY place a byte change is invisible', () => {
    // The one legitimate blind spot, pinned to its exact extent: a change inside
    // the stripped `sourceMappingURL` line is invisible by design; a change on
    // the line before it must not be.
    const body = 'const x = 1;\nexport { x };'
    expect(hashBytes(`${body}\n//# sourceMappingURL=a.map`)).toBe(hashBytes(`${body}\n//# sourceMappingURL=b.map`))
    expect(hashBytes(`${body}\n//# sourceMappingURL=a.map`)).not.toBe(
      hashBytes('const x = 2;\nexport { x };\n//# sourceMappingURL=a.map'),
    )
  })
})
