/**
 * Shared source-scan primitives for the structural guards that read
 * `src/state_machine.ts` as TEXT (`dispatch_funnel_source_scan.test.ts` A1/A2,
 * `rtc_stall_oracle.test.ts` I-13 premise 3).
 *
 * These guards are all ABSENCE claims ("no such shape occurs") or ADJACENCY
 * claims ("this is followed by that"). Both are vacuously satisfiable by a
 * mangled input, so the stripper below is load-bearing for every one of them and
 * lives in ONE place rather than being re-derived per test file.
 *
 * NOT production code: `src/tests/**` is knip-ignored and excluded from the
 * published build, exactly like `mocks.ts`.
 */

/**
 * Strip comments and string/template literals, leaving only CODE, PRESERVING
 * every surviving character's LINE so a reported index is the real one.
 *
 * ## Why this is a tokeniser and not a chain of `.replace()` calls
 * It used to be a chain, ordered block-comment → `'…'` → `"…"` → `` `…` `` →
 * `//…`. That order was chosen deliberately (stripping `//` first truncates a
 * `'https://…'` literal into a runaway quote) and the quote classes excluded
 * `\n`, so a stray quote could eat at most one line.
 *
 * The TEMPLATE class had no such exclusion — it matches across newlines BY
 * DESIGN — and line comments were still stripped LAST. A single unbalanced
 * backtick inside a `//` comment therefore paired with the next backtick
 * anywhere downstream and BLANKED everything between. Line count was preserved,
 * so member indices stayed plausible; the blanked region simply stopped existing
 * for the scan. MEASURED on this engine: a lone backtick in the `//` comment at
 * :6931 blanks 327 lines, a raw dispatch site planted inside them is invisible
 * to both A1 sweeps, and the structural sanity check still reports 146 members
 * and finds all 14 required names. That is the false-negative direction that
 * matters: the guards report green over exactly the regression they exist to
 * catch.
 *
 * Reordering cannot fix it, because the backtick class is the one that MUST span
 * lines. Only a single left-to-right pass — which recognises `//` BEFORE
 * anything inside the comment can open a literal — cannot desynchronise. The
 * engine survives at HEAD only by luck: 516 backticks live inside its `//`
 * comments and three inline-code spans straddle two lines (:1593-1594,
 * :6293-6294, :6990-6991), each balanced by accident of wording.
 *
 * `describe('A0')` in `dispatch_funnel_source_scan.test.ts` pins all of this,
 * including that {@link legacyStripChain} is defeated by the same input this
 * survives.
 *
 * SCOPE: `${…}` interpolations are treated as CODE (they are), so a raw dispatch
 * written inside one is VISIBLE to the sweeps — strictly stronger than the
 * chain, which blanked whole templates. Regex literals are NOT modelled; the
 * engine contains none and A0 fails loudly if one appears.
 */
export function stripCommentsAndStrings(src: string): string {
  const out: string[] = []
  /** Emit verbatim. */
  const keep = (c: string): void => {
    out.push(c)
  }
  /** Drop, but never a newline — the line map must stay exact. */
  const drop = (c: string): void => {
    if (c === '\n') out.push('\n')
  }

  /**
   * One entry per OPEN template literal, recording the `{` depth of the code
   * region it was opened in. A `}` closes the enclosing `${…}` exactly when the
   * depth is back at the top entry's value, which is what lets a template nested
   * inside an interpolation nest correctly.
   */
  const templates: number[] = []
  let inTemplate = false
  let depth = 0
  let i = 0
  const n = src.length

  while (i < n) {
    const c = src[i] as string
    const d = i + 1 < n ? (src[i + 1] as string) : ''

    if (inTemplate) {
      if (c === '\\') {
        drop(c)
        if (i + 1 < n) drop(d)
        i += 2
        continue
      }
      if (c === '`') {
        keep('`')
        templates.pop()
        inTemplate = false
        i += 1
        continue
      }
      if (c === '$' && d === '{') {
        keep('$')
        keep('{')
        inTemplate = false
        i += 2
        continue
      }
      drop(c)
      i += 1
      continue
    }

    // ── CODE. Comments are recognised FIRST: nothing inside one can open a
    //    literal, which is the property the old chain lacked.
    if (c === '/' && d === '/') {
      i += 2
      while (i < n && src[i] !== '\n') i += 1
      continue // the '\n' itself is emitted by the next iteration
    }
    if (c === '/' && d === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        drop(src[i] as string)
        i += 1
      }
      i = Math.min(n, i + 2)
      continue
    }
    if (c === "'" || c === '"') {
      keep(c)
      i += 1
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') {
          drop(src[i] as string)
          i += 1
          if (i < n) {
            drop(src[i] as string)
            i += 1
          }
          continue
        }
        drop(src[i] as string)
        i += 1
      }
      if (i < n && src[i] === c) {
        keep(c)
        i += 1
      }
      continue
    }
    if (c === '`') {
      keep('`')
      templates.push(depth)
      inTemplate = true
      i += 1
      continue
    }
    if (c === '{') {
      depth += 1
      keep(c)
      i += 1
      continue
    }
    if (c === '}') {
      if (templates.length > 0 && depth === (templates[templates.length - 1] as number)) {
        // Closes the `${…}` of the enclosing template: resume template mode.
        keep(c)
        inTemplate = true
        i += 1
        continue
      }
      depth -= 1
      keep(c)
      i += 1
      continue
    }
    keep(c)
    i += 1
  }
  return out.join('')
}

/**
 * The stripper as it was BEFORE this wave, kept as the falsification target for
 * A0: the tokeniser's claim is only worth anything if the input that defeats the
 * chain is SHOWN to defeat the chain.
 */
export function legacyStripChain(src: string): string {
  const keepLines = (m: string): string => '\n'.repeat((m.match(/\n/g) ?? []).length)
  return src
    .replace(/\/\*[\s\S]*?\*\//g, keepLines)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, (m) => `\`\`${keepLines(m)}`)
    .replace(/\/\/.*$/gm, '')
}

/** Outcome of {@link analyzeAdjacency}. */
export type Adjacency =
  | { readonly ok: true; readonly atLine: number }
  | { readonly ok: false; readonly atLine: number; readonly why: string }

/**
 * Is `follower` UNCONDITIONALLY reached from the site at (`startLine`,
 * `startCol`), with nothing suspending in between?
 *
 * This is the structural replacement for a textual proximity window. A window
 * ("some `this.scheduleProcessing()` within the next 30 lines") is blind to
 * control flow and accepts all of:
 *
 *     if (a) { raise() }  if (b) { schedule() }   // different branches
 *     raise(); if (b) { schedule() }              // conditionally scheduled
 *     raise(); return; schedule()                 // unreachable schedule
 *
 * none of which pairs the enqueue with a drain. This walks forward tracking
 * brace depth RELATIVE to the site and rejects each of them by construction:
 *
 *  - depth < 0 — the block containing the site closed first, so any later
 *    `follower` is in a DIFFERENT block;
 *  - depth > 0 at the follower — it is nested inside a branch the site is not
 *    in, so it is conditional;
 *  - `return` / `throw` / `continue` / `break` at depth 0 before it — the
 *    follower is not reached at all;
 *  - an `await` at depth 0 before it — the pairing is no longer atomic, which is
 *    the sampling gap the I-13 oracle's one-turn bound depends on being closed.
 *
 * `lines` MUST already be stripped by {@link stripCommentsAndStrings}: a brace
 * inside a comment or a string would desynchronise the depth count, which is the
 * same class of defect A0 removed from the stripper itself.
 */
export function analyzeAdjacency(
  lines: readonly string[],
  startLine: number,
  startCol: number,
  follower: string,
  window = 30,
): Adjacency {
  const EXITS = ['return', 'throw', 'continue', 'break'] as const
  const isWordEdge = (s: string, k: number): boolean => k < 0 || k >= s.length || !/[\w$]/.test(s[k] as string)

  let depth = 0
  const awaits: string[] = []
  const last = Math.min(lines.length, startLine + window)

  for (let i = startLine; i < last; i += 1) {
    const full = lines[i] as string
    const from = i === startLine ? startCol : 0
    const text = full.slice(from)

    for (let k = 0; k < text.length; k += 1) {
      if (text.startsWith(follower, k)) {
        if (depth > 0) {
          return {
            ok: false,
            atLine: i,
            why: `\`${follower}\` sits ${depth} block(s) deeper than the site — it is CONDITIONAL, not paired`,
          }
        }
        if (awaits.length > 0) {
          return {
            ok: false,
            atLine: i,
            why: `separated from \`${follower}\` by an await (${awaits.join(' | ')}) — a sample can land in the gap`,
          }
        }
        return { ok: true, atLine: i }
      }
      const ch = text[k] as string
      if (ch === '{') {
        depth += 1
        continue
      }
      if (ch === '}') {
        depth -= 1
        if (depth < 0) {
          return { ok: false, atLine: i, why: `the block containing the site closes before any \`${follower}\`` }
        }
        continue
      }
      if (depth !== 0) continue
      if (text.startsWith('await', k) && isWordEdge(text, k - 1) && isWordEdge(text, k + 5)) {
        awaits.push(full.trim())
        continue
      }
      for (const kw of EXITS) {
        if (text.startsWith(kw, k) && isWordEdge(text, k - 1) && isWordEdge(text, k + kw.length)) {
          return {
            ok: false,
            atLine: i,
            why: `\`${kw}\` at line ${i + 1} leaves the block before \`${follower}\` — it is not reached`,
          }
        }
      }
    }
  }
  return { ok: false, atLine: startLine, why: `no \`${follower}\` within ${window} lines of the site` }
}
