'use strict'

/**
 * Step-10 / ADR-7 D8 / R23 — CORE-BUNDLE BYTE/HASH GUARD.
 *
 * Proves the byte-frozen core surface (`dist/index.js` + `dist/index.cjs`) is
 * STABLE across rebuilds: it sha256-hashes both files (with the trailing
 * `//# sourceMappingURL=` line STRIPPED — `sourcemap:true` emits a filename-
 * relative URL that is path-noise, not runtime ABI) and compares to the committed
 * baseline `etc/dist-bytes.baseline.json`. Exits non-zero on drift.
 *
 * SCOPE: the executable JS/CJS bytes only. `.map` files are intentionally OUT OF
 * SCOPE (the sourceMappingURL is filename-relative; maps are not the runtime ABI).
 *
 * This is DISTINCT from `test/verify-dist.cjs` (presence/non-empty only) and from
 * the api-extractor `etc/statemachine.api.md` diff (type surface only — necessary
 * but not sufficient for dist-byte stability).
 *
 * Baseline is pinned to the toolchain that produced it (recorded in the file's
 * `toolchain` field). Refresh with `SM_DIST_UPDATE_BASELINE=1 node test/verify-dist-bytes.cjs`.
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const root = path.resolve(__dirname, '..')
const baselinePath = path.join(root, 'etc', 'dist-bytes.baseline.json')

/** Files whose bytes are the byte-frozen core ABI. */
const TARGETS = ['dist/index.js', 'dist/index.cjs']

/**
 * Strip the trailing sourceMappingURL line. tsup emits, at EOF, a line of the
 * form `//# sourceMappingURL=index.js.map` (or `//@ sourceMappingURL=...`).
 * EMPIRICALLY PROVEN this regex matches tsup output.
 */
function stripSourceMapUrl(s) {
  return s.replace(/\n?\/\/[#@] sourceMappingURL=.*$/m, '')
}

function hashFile(rel) {
  const abs = path.join(root, rel)
  const raw = fs.readFileSync(abs, 'utf8')
  return crypto.createHash('sha256').update(stripSourceMapUrl(raw), 'utf8').digest('hex')
}

function computeHashes() {
  const out = {}
  for (const rel of TARGETS) {
    out[rel] = hashFile(rel)
  }
  return out
}

function main() {
  // Guard: dist must exist (run after `npm run build`).
  for (const rel of TARGETS) {
    const abs = path.join(root, rel)
    if (!fs.existsSync(abs)) {
      console.error(`✗ ${rel} missing — run \`npm run build\` first`)
      process.exit(1)
    }
  }

  const observed = computeHashes()

  if (process.env.SM_DIST_UPDATE_BASELINE === '1') {
    const payload = {
      schemaVersion: 1,
      note: 'sha256 of dist/index.{js,cjs} with the trailing //# sourceMappingURL= line stripped. Pinned to the toolchain below. Refresh with SM_DIST_UPDATE_BASELINE=1.',
      toolchain: { node: process.version },
      hashes: observed,
    }
    fs.writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    console.log(`✓ baseline refreshed: ${path.relative(root, baselinePath)}`)
    for (const rel of TARGETS) {
      console.log(`  ${rel}  ${observed[rel]}`)
    }
    process.exit(0)
  }

  if (!fs.existsSync(baselinePath)) {
    console.error(`✗ baseline ${path.relative(root, baselinePath)} missing — create it with SM_DIST_UPDATE_BASELINE=1`)
    process.exit(1)
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
  const expected = baseline.hashes || {}
  let failed = false
  for (const rel of TARGETS) {
    if (observed[rel] === expected[rel]) {
      console.log(`✓ ${rel}  ${observed[rel]}`)
    } else {
      console.error(`✗ ${rel} byte drift`)
      console.error(`    expected: ${expected[rel]}`)
      console.error(`    observed: ${observed[rel]}`)
      failed = true
    }
  }

  if (failed) {
    console.error(
      '\nCore dist bytes changed. If this is an intentional core-engine change, refresh with SM_DIST_UPDATE_BASELINE=1 (and justify in CODE_REVIEW). For TASK-014 the core is byte-frozen — investigate the drift.',
    )
    process.exit(1)
  }
}

main()
