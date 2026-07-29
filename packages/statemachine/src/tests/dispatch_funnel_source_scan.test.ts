import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { legacyStripChain, stripCommentsAndStrings } from './source-scan'

/**
 * A1 / A2 — SOURCE-SCAN GUARDS.
 *
 * Both DoDs of this wave are structural claims about `src/state_machine.ts`, and
 * a structural claim that is only stated in a comment drifts. The wave exists
 * BECAUSE a "list of instrumented slots" drifted four times. So both are enforced
 * here, on the source text, the way `security_source_scan.test.ts` already
 * enforces the no-dynamic-compilation invariant.
 *
 * A1 — "no consumer-supplied callable is invoked outside the dispatch funnel":
 *   1. `Reflect.apply` occurs EXACTLY ONCE in the file, inside `dispatchUser`.
 *   2. NONE of the syntactic invocation shapes the pre-A1 code used to reach
 *      consumer callables occurs anywhere (`.cond(`, `.src(`, `.save(`,
 *      `.restore(`, `action(`, `handler(`, `.guard(`, `.onEnter(`, …). This is the
 *      tripwire: a regression cannot re-open a hole without re-introducing one of
 *      the exact shapes it removed.
 *   3. Every member of the closed `DispatchHook` union is actually WIRED — a
 *      declared origin nobody dispatches is a lie about coverage, and an
 *      undeclared one is a compile error by construction.
 *
 * A2 — "every drain-plane await is followed by a heartbeat tick":
 *   The drain plane is computed STRUCTURALLY, never listed. Seeds are the four
 *   drain primitives the brief names (`internalQueue`, `raiseEvent`, `callAction`,
 *   `scheduleProcessing`); membership is then transitively closed over `this.X`
 *   references. A method that reaches none of them — the whole ~50-await
 *   serialization/persistence plane — is exempt by that property alone, so the
 *   exemption polices itself instead of being a trust list.
 *
 *   The ONE exemption class is per-await, marked at the site, and its total is
 *   pinned: `/* tick-exempt: consumer-body *​/` marks an `await` whose subject is
 *   the CONSUMER's own callable. Those are covered by A1's span, not by A2's
 *   heartbeat — ticking them would credit consumer time as engine progress.
 */

const SM_PATH = fileURLToPath(new URL('../state_machine.ts', import.meta.url))
const RAW = readFileSync(SM_PATH, 'utf8')

const CODE = stripCommentsAndStrings(RAW)
const CODE_LINES = CODE.split('\n')

/** Class members declared at the class body's indentation (two spaces). */
const MEMBER_DECL =
  /^ {2}(?:public |private |protected |static |readonly |async |get |set )*([A-Za-z_$][\w$]*)\s*[(<]/

interface MemberBody {
  readonly name: string
  readonly start: number
  readonly lines: readonly string[]
}

function memberBodies(): MemberBody[] {
  const decls: Array<{ name: string; line: number }> = []
  CODE_LINES.forEach((l, i) => {
    const m = MEMBER_DECL.exec(l)
    if (m?.[1]) decls.push({ name: m[1], line: i })
  })
  return decls.map((d, i) => ({
    name: d.name,
    start: d.line,
    lines: CODE_LINES.slice(d.line, decls[i + 1]?.line ?? CODE_LINES.length),
  }))
}

const MEMBERS = memberBodies()

/** The member whose body contains source line index `i` (0-based). */
function memberAt(i: number): string {
  let found = '<module>'
  for (const m of MEMBERS) {
    if (m.start <= i) found = m.name
    else break
  }
  return found
}

// ═══════════════════════════════════════════════════════════════════════════
// A0 — the SCANNER's own integrity
//
// A1 and A2 are absence claims ("no such shape occurs"). An absence claim over a
// mangled string is vacuously true, so the stripper is a load-bearing part of
// both, and a defect in it produces the SILENT direction of failure: green.
// These tests are the only thing that makes the two sweeps below mean anything.
// ═══════════════════════════════════════════════════════════════════════════

const RAW_LINES = RAW.split('\n')

/**
 * A line index of a REAL `//` line comment inside a method body, late in the
 * file. "Late" matters: an EARLY blanking also wipes the class declarations and
 * the sanity test below catches it by accident. A late one leaves all 14 named
 * members and a 120+ member count intact — the case that passes for the wrong
 * reason.
 */
const LATE_LINE_COMMENT = ((): number => {
  const from = Math.floor(RAW_LINES.length * 0.9)
  const at = RAW_LINES.findIndex((l, i) => i >= from && /^\s{4,}\/\/ /.test(l))
  if (at < 0) throw new Error('no late `//` comment found in the engine — fixture assumption broken')
  return at
})()

/** `RAW` with `inserted` spliced in immediately after line index `at`. */
function withLinesAfter(at: number, ...inserted: string[]): string {
  const lines = [...RAW_LINES]
  lines.splice(at + 1, 0, ...inserted)
  return lines.join('\n')
}

describe('A0 — the stripper cannot be desynchronised by comment content', () => {
  it('a lone backtick in a `//` comment does NOT blank the code after it', () => {
    // The exact defeat: an unbalanced inline-code span in a comment, followed by
    // a raw dispatch site of the shape A1 exists to forbid.
    const PLANT = '    await handler(evt)'
    const mutated = withLinesAfter(
      LATE_LINE_COMMENT,
      '    // NOTE: a lone ` (an inline-code span opened and never closed)',
      PLANT,
    )
    const plantedAt = LATE_LINE_COMMENT + 2

    const tokenised = stripCommentsAndStrings(mutated).split('\n')
    expect(tokenised.length, 'the line map must survive the injection').toBe(mutated.split('\n').length)
    expect(
      tokenised[plantedAt],
      'the planted raw dispatch site was BLANKED — every A1/A2 absence claim below is vacuous',
    ).toContain('handler(evt)')

    // And it is visible to the sweep, not merely present in the text.
    const seen = tokenised.filter((l) => /(?<![\w.$])handler\s*\(/.test(l))
    expect(seen.length, 'the identifier sweep must SEE the planted site').toBe(1)

    // FALSIFICATION: the pre-wave chain is defeated by this very input. Without
    // this half, "the tokeniser handles it" is an untested claim about an input
    // nothing was ever shown to break.
    const legacy = legacyStripChain(mutated).split('\n')
    expect(
      legacy[plantedAt],
      'the legacy chain is expected to blank the planted site — if it no longer does, ' +
        'this fixture stopped reproducing the defect and proves nothing',
    ).not.toContain('handler(evt)')
    expect(legacy.filter((l) => /(?<![\w.$])handler\s*\(/.test(l))).toEqual([])
  })

  it('the legacy chain ALSO kept the sanity test green while blanked (why A0 is needed)', () => {
    // The blanking is invisible to the structural sanity check: it is late
    // enough that all 14 required members and the >120 count still hold.
    const mutated = withLinesAfter(
      LATE_LINE_COMMENT,
      '    // NOTE: a lone ` (an inline-code span opened and never closed)',
      '    await handler(evt)',
    )
    const legacyLines = legacyStripChain(mutated).split('\n')
    const names = new Set<string>()
    for (const l of legacyLines) {
      const m = MEMBER_DECL.exec(l)
      if (m?.[1]) names.add(m[1])
    }
    expect(names.has('dispatchUser')).toBe(true)
    expect(legacyLines.filter((l) => MEMBER_DECL.test(l)).length).toBeGreaterThan(120)
    // …and yet a whole region of the file was erased. Measured against the
    // TOKENISED strip of the same input, so the delta is the chain's defect and
    // nothing else.
    const baseLines = stripCommentsAndStrings(mutated).split('\n')
    const blanked = legacyLines.filter(
      (l, i) => (baseLines[i] ?? '').trim() !== '' && l.trim() === '',
    ).length
    expect(blanked, 'the legacy chain must be shown to blank a real region').toBeGreaterThan(100)
  })

  it('stripping is STABLE: an unbalanced delimiter in a comment is line-local', () => {
    // The general form of the property. For every delimiter that could open a
    // multi-line span, injecting a LONE one inside a `//` comment must leave the
    // stripped output byte-identical outside the injected line itself.
    for (const [name, delim] of [
      ['backtick', '`'],
      ['single quote', "'"],
      ['double quote', '"'],
      ['block-comment opener', '/*'],
      ['block-comment closer', '*/'],
    ] as const) {
      const mutated = withLinesAfter(LATE_LINE_COMMENT, `    // a lone ${delim} inside a line comment`)
      const got = stripCommentsAndStrings(mutated).split('\n')
      got.splice(LATE_LINE_COMMENT + 1, 1) // remove the injected line itself
      expect(got.join('\n'), `a lone ${name} in a comment changed the stripped code elsewhere`).toBe(CODE)
    }
  })

  it('the engine contains no REGEX LITERAL — the one shape the tokeniser does not model', () => {
    // A regex literal may contain a quote or a backtick, and the tokeniser reads
    // `/` as division. There are none today; if one appears, the tokeniser must
    // learn regex literals BEFORE the sweeps below can be trusted again. This is
    // the honest form of that limit: an assertion, not a comment.
    const REGEX_START = /(?:^|[([{,;:!&|?+\-*%~^<>=]|\b(?:return|case|typeof|in|of|do|else|yield|await))\s*$/
    const suspects: string[] = []
    CODE.split('\n').forEach((line, i) => {
      for (let k = 0; k < line.length; k += 1) {
        if (line[k] !== '/') continue
        if (REGEX_START.test(line.slice(0, k))) suspects.push(`line ${i + 1}: ${line.trim().slice(0, 80)}`)
      }
    })
    expect(suspects, 'a regex literal appeared in the engine — teach the tokeniser about it').toEqual([])
  })

  it('the tokeniser reads `${…}` interpolations as CODE (strictly stronger than the chain)', () => {
    const src = ['const s = `pre ${ handler(evt) } post`', 'const t = `plain`'].join('\n')
    const got = stripCommentsAndStrings(src).split('\n')
    expect(got[0], 'an interpolated call must survive stripping').toContain('handler(evt)')
    expect(got[1], 'template TEXT must still be blanked').toBe('const t = ``')
    // Nested template inside an interpolation must not close the outer one early.
    const nested = stripCommentsAndStrings('const u = `a ${ x ? `b ${ f(1) }` : y } c`')
    expect(nested).toContain('f(1)')
    expect(nested).not.toContain('post')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// A1 — the dispatch funnel is the SOLE consumer-callable invocation site
// ═══════════════════════════════════════════════════════════════════════════

describe('A1 — every consumer-supplied callable is invoked through ONE funnel', () => {
  it('sanity: the stripper preserves the class structure it is asked to reason about', () => {
    // If this regresses, every other assertion in the file silently weakens to
    // "no occurrences found in a mangled string" — which is how a source scan
    // passes for the wrong reason.
    const names = new Set(MEMBERS.map((m) => m.name))
    for (const required of [
      'dispatchUser',
      'callAction',
      'processError',
      'applyMicrostep',
      'selectTransition',
      'executeExitActions',
      'executeEnterActions',
      'armStateInvoke',
      'resumeTimers',
      'saveState',
      'restoreState',
      'evaluateInvokeCond',
      'launchInvokeOperation',
      'tick',
    ]) {
      expect(names.has(required), `member ${required} not found by the scanner`).toBe(true)
    }
    expect(MEMBERS.length).toBeGreaterThan(120)
  })

  it('Reflect.apply occurs EXACTLY ONCE, and inside dispatchUser', () => {
    // OCCURRENCES, not lines: two applies squeezed onto one line must fail too.
    const total = (CODE.match(/Reflect\.apply/g) ?? []).length
    expect(total, 'Reflect.apply must be the single dispatch chokepoint').toBe(1)
    const line = CODE_LINES.findIndex((l) => l.includes('Reflect.apply'))
    expect(memberAt(line)).toBe('dispatchUser')
  })

  it('NONE of the pre-A1 raw invocation shapes survives anywhere in the engine', () => {
    // Each entry is a shape the engine ACTUALLY used before A1. A regression that
    // re-opens a hole has to write one of them again.
    const BANNED_SHAPES = [
      '.cond(', // invoke[].cond — arm / re-arm / resume
      '.src(', // invoke[].src
      '.save(', // StatePersistenceAdapter.save
      '.restore(', // StatePersistenceAdapter.restore
      '.guard(',
      '.onEnter(',
      '.onExit(',
      '.onBeforeEnter(',
      '.onAfterEnter(',
      '.onBeforeExit(',
      '.onAfterExit(',
      '.onBefore(',
      '.onAfter(',
      '.onTransition(',
      '.onError(',
    ]
    const offenders: string[] = []
    for (const shape of BANNED_SHAPES) {
      CODE_LINES.forEach((l, i) => {
        if (l.includes(shape)) offenders.push(`${shape} at ${i + 1} in ${memberAt(i)}`)
      })
    }
    // Locals that hold an ALREADY-RESOLVED consumer callable. `handler` is the
    // `processError` one; `action`/`actionName` are the three `callAction` arms.
    for (const ident of ['action', 'actionName', 'handler', 'errorHandler', 'cond', 'src']) {
      const re = new RegExp(String.raw`(?<![\w.$])${ident}\s*\(`)
      CODE_LINES.forEach((l, i) => {
        if (re.test(l)) offenders.push(`${ident}( at ${i + 1} in ${memberAt(i)}`)
      })
    }
    expect(offenders, 'consumer callable invoked outside dispatchUser').toEqual([])
  })

  it('every declared DispatchHook is actually wired to a call site', () => {
    // The union is closed so a NEW slot cannot be added without declaring itself.
    // This is the other direction: a DECLARED slot nobody dispatches would be an
    // inventory that overstates its own coverage.
    const unionBlock = /type DispatchHook =([\s\S]*?)\n\n/.exec(RAW)
    expect(unionBlock, 'DispatchHook union not found').not.toBeNull()
    const declared = [...(unionBlock?.[1] ?? '').matchAll(/\|\s*'([\w.]+)'/g)].map((m) => m[1] as string)
    expect(declared.length).toBeGreaterThanOrEqual(9)

    // A hook is wired when it appears as a literal argument somewhere OTHER than
    // the union declaration itself — either at a `dispatchUser(...)` call or as
    // the value of `ENGINE_OWNED_DISPATCH`.
    const body = RAW.slice((unionBlock?.index ?? 0) + (unionBlock?.[0].length ?? 0))
    const unwired = declared.filter((h) => !body.includes(`'${h}'`))
    expect(unwired, 'DispatchHook members declared but never dispatched').toEqual([])
  })

  it('the funnel takes its origin as a REQUIRED first parameter', () => {
    // The `RaiseOrigin` shape: omitting the origin is a compile error, not a
    // silent hole. Assert the signature keeps that property.
    const sig = /private dispatchUser\(\s*\n\s*(hook: DispatchHook,)/.exec(RAW)
    expect(sig, 'dispatchUser must take a required `hook: DispatchHook` first').not.toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// A2 — the heartbeat covers every drain-plane await
// ═══════════════════════════════════════════════════════════════════════════

const SEEDS = ['internalQueue', 'raiseEvent', 'callAction', 'scheduleProcessing'] as const

/** Structurally derived drain plane: seeds, transitively closed over `this.X`. */
function drainPlane(): Set<string> {
  const bodyOf = new Map<string, string>()
  for (const m of MEMBERS) {
    bodyOf.set(m.name, `${bodyOf.get(m.name) ?? ''}\n${m.lines.join('\n')}`)
  }
  const drain = new Set<string>(['callAction', 'raiseEvent', 'scheduleProcessing'])
  for (const [name, body] of bodyOf) {
    if (SEEDS.some((s) => new RegExp(String.raw`this\.${s}\b`).test(body))) drain.add(name)
  }
  for (;;) {
    let grew = false
    for (const [name, body] of bodyOf) {
      if (drain.has(name)) continue
      const refs = [...body.matchAll(/this\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1] as string)
      if (refs.some((r) => drain.has(r))) {
        drain.add(name)
        grew = true
      }
    }
    if (!grew) break
  }
  return drain
}

describe('A2 — the drain plane is derived, not listed, and every await in it ticks', () => {
  const DRAIN = drainPlane()

  it('the derived drain plane contains the engine and excludes the serialization plane', () => {
    for (const inPlane of [
      'processQueues',
      'executeQueuedTransition',
      'computeEnabledSet',
      'selectTransition',
      'applyMicrostep',
      'executeExitActions',
      'executeEnterActions',
      'runExitAction',
      'runLifecycleAction',
      'runTracedInvokeAction',
      'armStateInvoke',
      'resumeTimers',
    ]) {
      expect(DRAIN.has(inPlane), `${inPlane} must be drain-plane`).toBe(true)
    }
    // The exemption CLASS the brief asks for, verified as a property rather than
    // as a list: the whole async serialization plane reaches no drain primitive.
    for (const exempt of [
      'serializeStateAsync',
      'serializeEventAsync',
      'serializeActionAsync',
      'deserializeStatesAsync',
      'deserializeEventsAsync',
      'deserializeActionAsync',
      'toSecureJSON',
      'saveState',
    ]) {
      expect(DRAIN.has(exempt), `${exempt} must NOT be drain-plane`).toBe(false)
    }
    // It is a genuine partition, not "everything".
    const total = new Set(MEMBERS.map((m) => m.name)).size
    expect(DRAIN.size).toBeLessThan(total / 2)
  })

  it('every await in a drain-plane member is followed by a tick, or carries the ONE exemption', () => {
    const EXEMPT_MARK = '/* tick-exempt: consumer-body */'
    const rawLines = RAW.split('\n')
    const missing: string[] = []
    let exemptions = 0

    for (const m of MEMBERS) {
      if (!DRAIN.has(m.name)) continue
      m.lines.forEach((l, j) => {
        if (!/(?<![\w.$])await\s/.test(l)) return
        const abs = m.start + j
        // The exemption is marked ON the await's own statement (the marker line
        // is stripped from CODE, so it is read from the RAW text).
        const near = rawLines.slice(Math.max(0, abs - 3), abs + 1).join('\n')
        if (near.includes(EXEMPT_MARK)) {
          exemptions += 1
          return
        }
        // A tick must appear before the NEXT await in the same member — i.e. the
        // hop this await paid is accounted for before another one is paid.
        const rest = m.lines.slice(j + 1)
        let ok = false
        for (const nxt of rest) {
          if (nxt.includes('this.tick(')) {
            ok = true
            break
          }
          if (/(?<![\w.$])await\s/.test(nxt)) break
        }
        if (!ok) missing.push(`${m.name}:${abs + 1}  ${l.trim().slice(0, 90)}`)
      })
    }

    expect(missing, 'drain-plane await with no heartbeat tick').toEqual([])
    // PINNED. The exemption is a class, but its population is not open-ended: a
    // new one has to move this number, which is a visible diff.
    expect(exemptions, 'consumer-body exemption count changed').toBe(4)
  })

  it('no tick is emitted outside the drain plane', () => {
    const stray = MEMBERS.filter(
      (m) => !DRAIN.has(m.name) && m.name !== 'tick' && m.lines.some((l) => l.includes('this.tick(')),
    ).map((m) => m.name)
    expect(stray, 'heartbeat tick outside the drain plane').toEqual([])
  })

  it('every declared EngineTickSite is actually used', () => {
    const block = /type EngineTickSite =([\s\S]*?)\n\n/.exec(RAW)
    expect(block).not.toBeNull()
    const declared = [...(block?.[1] ?? '').matchAll(/\|\s*'([\w.]+)'/g)].map((m) => m[1] as string)
    expect(declared.length).toBeGreaterThanOrEqual(13)
    const used = new Set(
      [...RAW.matchAll(/this\.tick\('([\w.]+)'\)/g)].map((m) => m[1] as string),
    )
    expect(declared.filter((d) => !used.has(d)), 'EngineTickSite declared but never ticked').toEqual([])
  })
})
