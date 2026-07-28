import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * W0 B3 — source-scan guard: the "no dynamic compilation in non-test src"
 * invariant, enforced as a test so a regression cannot silently re-open the
 * RCE-class surface that W0 closed.
 *
 * Contract: NON-test source under `src/` contains ZERO real `new Function(` /
 * `eval(` call sites, with exactly ONE explicit whitelist entry —
 * `src/sim/define.ts` (`recreateLiteral`, harness-side literal re-creation).
 * That whitelist is an OPEN DEBT tracked as task #26 (full closure in W5);
 * until then it is an acknowledged, single, audited exception — NOT licence to
 * add another. Adding a second dynamic-compilation site (or removing define.ts
 * without updating this guard) turns this test red.
 *
 * Precedent for scanning source text from a test: `sim/wire_settle.test.ts`
 * (~36-38) and `sim/metrics.test.ts` (~153-155) grep the source the same way.
 * Comments and string/template literals are stripped first so a doc-comment or
 * a description string that merely MENTIONS the idiom (e.g. security.ts's
 * `'Direct eval() usage'` blocklist label, or the `re-eval` notes in
 * sim/scenario.ts) does not register as a real call site.
 */

const SRC_DIR = fileURLToPath(new URL('../', import.meta.url))

// Exactly one audited dynamic-compilation site is permitted (task #26 debt).
const WHITELIST = new Set<string>(['sim/define.ts'])

const NEW_FUNCTION = /new\s+Function\s*\(/
const EVAL_CALL = /\beval\s*\(/

/** Enumerate every non-test `.ts` file under `src/`, path relative to `src/`. */
function listNonTestSourceFiles(dir: string, relBase = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (entry.name === 'tests') continue // exclude the test tree itself
      out.push(...listNonTestSourceFiles(`${dir}/${entry.name}`, rel))
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(rel)
    }
  }
  return out
}

/** Strip block + line comments and string/template literals, leaving only CODE. */
function stripCommentsAndStrings(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/\/\/.*$/gm, '') // line comments
    .replace(/'(?:[^'\\]|\\.)*'/g, "''") // single-quoted strings
    .replace(/"(?:[^"\\]|\\.)*"/g, '""') // double-quoted strings
    .replace(/`(?:[^`\\]|\\.)*`/g, '``') // template literals
}

describe('W0 B3 — no dynamic compilation in non-test src (RCE-class guard)', () => {
  const files = listNonTestSourceFiles(SRC_DIR)

  it('enumerates a non-trivial set of source files (walker sanity)', () => {
    expect(files.length).toBeGreaterThan(5)
    // The whitelisted debt file must still exist — a stale whitelist is a bug.
    expect(files).toContain('sim/define.ts')
  })

  it('contains NO real `new Function(` call outside the task-#26 whitelist', () => {
    const offenders = files.filter((rel) => {
      const code = stripCommentsAndStrings(
        readFileSync(`${SRC_DIR}${rel}`, 'utf8'),
      )
      return NEW_FUNCTION.test(code) && !WHITELIST.has(rel)
    })
    expect(offenders).toEqual([])
  })

  it('the ONLY `new Function(` site is the whitelisted src/sim/define.ts', () => {
    const withNewFunction = files.filter((rel) =>
      NEW_FUNCTION.test(
        stripCommentsAndStrings(readFileSync(`${SRC_DIR}${rel}`, 'utf8')),
      ),
    )
    // Exactly the whitelist — no more (regression), no fewer (stale whitelist).
    expect(withNewFunction.sort()).toEqual([...WHITELIST].sort())
  })

  it('contains NO real `eval(` call anywhere in non-test src', () => {
    const offenders = files.filter((rel) =>
      EVAL_CALL.test(
        stripCommentsAndStrings(readFileSync(`${SRC_DIR}${rel}`, 'utf8')),
      ),
    )
    expect(offenders).toEqual([])
  })
})
