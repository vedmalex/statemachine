import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

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

/**
 * Strip comments and string/template literals, leaving only CODE, and PRESERVE
 * the line count so a reported index is the real one.
 *
 * ORDER MATTERS and is not the obvious one: string literals are removed BEFORE
 * line comments. Removing `//…` first truncates a URL inside a string literal
 * (`'https://…'`) into an unbalanced quote, and the quote regex then runs away
 * across hundreds of lines and silently deletes real declarations. The
 * single-line character classes are the second half of that guard.
 */
function stripCommentsAndStrings(src: string): string {
  const keepLines = (m: string): string => '\n'.repeat((m.match(/\n/g) ?? []).length)
  return src
    .replace(/\/\*[\s\S]*?\*\//g, keepLines)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, (m) => `\`\`${keepLines(m)}`)
    .replace(/\/\/.*$/gm, '')
}

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
