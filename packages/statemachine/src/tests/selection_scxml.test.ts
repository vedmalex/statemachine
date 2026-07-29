/**
 * W3-B — TARGET (RED) suite for the NEW transition-selection rule (SPEC §4/§5/§7).
 *
 * These tests encode the CORRECT post-fix (SCXML/UML) behaviour and FAIL on HEAD,
 * whose engine still resolves conflicts by last-declared-wins with
 * `priority ?? -Infinity` and eager guards (see `getAllowedTransitions`,
 * `state_machine.ts`). This is the RED role: DO NOT edit `src/` to make these
 * pass — that is the GREEN wave's job.
 *
 * Companion: `selection_characterization.test.ts` pins the OLD last-declared-wins
 * winner per axis (the W2 sensor). This file is its paired target — the delta
 * between the two files IS the migration-note skeleton (SPEC §9).
 *
 * Reproduced on HEAD (probe, 2026-07-28, commit 6fabd39):
 *   axis1 [descendant,ancestor] → 'ancWon'   (target: 'descWon' — deepest source)
 *   axis2 [absent,negative]     → 'negWon'    (target: 'absWon'  — absent === 0 > -5)
 *   axis3 [explicit,wildcard]   → 'wildWon'   (target: 'explWon' — explicit is specificity 0)
 *   axis4 [r1,r2] incomparable  → 'fromR2'    (target: 'fromR1'  — first in document order)
 *   axis5 winner 'B', BOTH guards fired       (target: winner 'A', losers' guards NOT fired)
 *   fireEventDetailed            → undefined   (target: a method distinguishing guard-error)
 *
 * The NEW rule (SPEC §4), ordering candidates BEFORE guards run:
 *   1. priority DESC, default = 0   (NOT -Infinity: a negative priority is now
 *      BELOW an unspecified one — the F9 fix).
 *   2. source specificity ASC: 0 fully-explicit `from` · 1 partial wildcard `'a|*'`
 *      · 2 full `'*'`. Lower = higher precedence (explicit ALWAYS beats wildcard,
 *      never by declaration order — F9/V2 fix).
 *   3. descendant dominance (pointwise, applied as a FILTER after a stable sort,
 *      never as a comparator branch): the more-nested source wins; incomparable
 *      sources are NOT ranked here.
 *   4. document order — the FIRST-declared candidate wins on an otherwise exact tie.
 * Guards run LAZILY in that order, up to the first that passes; the rest are NOT
 * evaluated (SPEC §5).
 */
import { describe, expect, it } from 'vitest'
import { createMachine } from '../index'

const base = { name: 'SelSCXML', stateAttribute: 'state' as const }

/** Build the machine, fire `ev` once, return the reached state = the winner. */
async function winnerOf(config: any): Promise<string | undefined> {
  const sm = createMachine(config, {} as any)
  await sm.fireEvent('ev')
  return sm.getCurrentState()
}

// ── Axis 1 — descendant vs ancestor, BOTH declaration orders → descendant ALWAYS
// SPEC §4.3: the more-nested (descendant) source dominates. Unlike HEAD, the
// winner does NOT depend on declaration order — the deepest matched source wins
// in both orders.
describe('axis 1 — descendant dominates ancestor in BOTH declaration orders', () => {
  const states = {
    parent: { regions: { r: { leaf: {} } }, initial: 'leaf' },
    ancWon: {},
    descWon: {},
  }
  const mk = (transitions: any[]) => ({
    ...base,
    initialState: 'parent',
    states,
    events: { ev: { transitions } },
  })

  it('order [ancestor, descendant] → descendant (descWon)', async () => {
    expect(
      await winnerOf(
        mk([
          { from: 'parent', to: 'ancWon' },
          { from: 'parent.r.leaf', to: 'descWon' },
        ]),
      ),
    ).toBe('descWon')
  })

  it('order [descendant, ancestor] → STILL descendant (descWon) — RED: HEAD gives ancWon', async () => {
    expect(
      await winnerOf(
        mk([
          { from: 'parent.r.leaf', to: 'descWon' },
          { from: 'parent', to: 'ancWon' },
        ]),
      ),
    ).toBe('descWon')
  })
})

// ── Axis 2 — absent priority === 0; a NEGATIVE priority is now BELOW unspecified.
// SPEC §4.1 (F9): default priority is 0, not -Infinity. An explicit `priority:-5`
// therefore LOSES to a transition with no priority, in BOTH orders.
describe('axis 2 — absent priority (=0) beats negative priority (F9)', () => {
  const states = { s0: {}, absWon: {}, negWon: {} }
  const mk = (transitions: any[]) => ({
    ...base,
    initialState: 's0',
    states,
    events: { ev: { transitions } },
  })

  it('order [absent, negative] → absent wins (0 > -5) — RED: HEAD gives negWon', async () => {
    expect(
      await winnerOf(
        mk([
          { from: 's0', to: 'absWon' },
          { from: 's0', to: 'negWon', priority: -5 },
        ]),
      ),
    ).toBe('absWon')
  })

  it('order [negative, absent] → absent STILL wins (priority dominates order) — RED: HEAD gives negWon', async () => {
    expect(
      await winnerOf(
        mk([
          { from: 's0', to: 'negWon', priority: -5 },
          { from: 's0', to: 'absWon' },
        ]),
      ),
    ).toBe('absWon')
  })
})

// ── Axis 3 — specificity: explicit `from` beats wildcard `'*'` in BOTH orders.
// SPEC §4.2 (F9/V2): explicit source is specificity class 0, `'*'` is class 2.
// Explicit wins ALWAYS — never "wildcard wins because declared later".
describe('axis 3 — explicit source beats wildcard in BOTH declaration orders', () => {
  const states = { s0: {}, wildWon: {}, explWon: {} }
  const mk = (transitions: any[]) => ({
    ...base,
    initialState: 's0',
    states,
    events: { ev: { transitions } },
  })

  it('order [wildcard, explicit] → explicit (explWon)', async () => {
    expect(
      await winnerOf(
        mk([
          { from: '*', to: 'wildWon' },
          { from: 's0', to: 'explWon' },
        ]),
      ),
    ).toBe('explWon')
  })

  it('order [explicit, wildcard] → STILL explicit (explWon) — RED: HEAD gives wildWon', async () => {
    expect(
      await winnerOf(
        mk([
          { from: 's0', to: 'explWon' },
          { from: '*', to: 'wildWon' },
        ]),
      ),
    ).toBe('explWon')
  })
})

// ── Axis 4 — equal specificity + priority, INCOMPARABLE sources → document order.
// Two parallel regions r1/r2 are both active; the two candidates match different,
// non-nested sources (different regions). SPEC §4.4: incomparable sources are NOT
// ranked by dominance, so the FIRST-declared candidate wins. HEAD picks the
// LAST-declared (opposite).
describe('axis 4 — incomparable sources resolve by document order (first declared)', () => {
  const states = {
    p: { initial: 'r1.a|r2.b', regions: { r1: { a: {} }, r2: { b: {} } } },
    fromR1: {},
    fromR2: {},
  }
  const mk = (transitions: any[]) => ({
    ...base,
    initialState: 'p',
    states,
    events: { ev: { transitions } },
  })

  it('order [r1, r2] → first-declared r1 wins (fromR1) — RED: HEAD gives fromR2', async () => {
    expect(
      await winnerOf(
        mk([
          { from: 'p.r1.a', to: 'fromR1' },
          { from: 'p.r2.b', to: 'fromR2' },
        ]),
      ),
    ).toBe('fromR1')
  })

  it('order [r2, r1] → first-declared r2 wins (fromR2) — RED: HEAD gives fromR1', async () => {
    expect(
      await winnerOf(
        mk([
          { from: 'p.r2.b', to: 'fromR2' },
          { from: 'p.r1.a', to: 'fromR1' },
        ]),
      ),
    ).toBe('fromR2')
  })
})

// ── Axis 5 — LAZY guards: evaluate in §4 order up to the first that passes; the
// rest are NOT evaluated (SPEC §5). The winner is the first-declared passing
// candidate. HEAD evaluates EVERY candidate's guard (eager) and picks the
// last-declared (F8-adjacent counter contract).
describe('axis 5 — guards are lazy: losers after the winner are never evaluated', () => {
  it('first candidate passes → its target wins, later guards NOT called — RED on HEAD (all fire, last wins)', async () => {
    let guardA = 0
    let guardB = 0
    let guardC = 0
    const config = {
      ...base,
      initialState: 's0',
      states: { s0: {}, A: {}, B: {}, C: {} },
      events: {
        ev: {
          transitions: [
            {
              from: 's0',
              to: 'A',
              guard: () => {
                guardA++
                return true
              },
            },
            {
              from: 's0',
              to: 'B',
              guard: () => {
                guardB++
                return true
              },
            },
            {
              from: 's0',
              to: 'C',
              guard: () => {
                guardC++
                return true
              },
            },
          ],
        },
      },
    }
    const sm = createMachine(config as any, {} as any)
    await sm.fireEvent('ev')

    // First-declared passing candidate wins (SCXML document order).
    expect(sm.getCurrentState()).toBe('A')
    // Winner's guard is evaluated exactly once (also the F8 no-recheck contract).
    expect(guardA).toBe(1)
    // Candidates AFTER the first passing one are never evaluated.
    expect(guardB).toBe(0)
    expect(guardC).toBe(0)
  })
})

// ── fireEventDetailed (SPEC §7) — additive, non-throwing, discriminated union.
// `fireEvent` is UNCHANGED (Promise<boolean>, throws on no candidates).
// `fireEventDetailed` NEVER throws and distinguishes guard-error from
// guard-rejected from no-transition (closes F4 fully). Absent on HEAD.
type FireResult =
  | { fired: true; transitions: Array<{ event: string; from: string; to: string }> }
  | {
      fired: false
      reason: 'no-transition' | 'guard-rejected' | 'guard-error'
      rejected?: Array<{
        transition: string
        reason: 'guard-rejected' | 'guard-error'
        error?: Error
      }>
    }

describe('fireEventDetailed (SPEC §7) — additive, distinguishes guard-error', () => {
  const mkSm = (config: any) => createMachine(config, {} as any)

  it('exposes fireEventDetailed alongside an UNCHANGED fireEvent — RED: absent on HEAD', () => {
    const sm = mkSm({
      ...base,
      initialState: 's0',
      states: { s0: {}, A: {} },
      events: { ev: { transitions: [{ from: 's0', to: 'A' }] } },
    })
    // fireEvent must stay boolean-returning (a truthy {fired:false} object would
    // silently invert `if (await sm.fireEvent(e))`).
    expect(typeof (sm as any).fireEventDetailed).toBe('function')
  })

  it('fired transition → { fired:true, transitions:[{event,from,to}] } — RED on HEAD', async () => {
    const sm = mkSm({
      ...base,
      initialState: 's0',
      states: { s0: {}, A: {} },
      events: { ev: { transitions: [{ from: 's0', to: 'A' }] } },
    })
    expect(typeof (sm as any).fireEventDetailed).toBe('function')
    const res: FireResult = await (sm as any).fireEventDetailed('ev')
    expect(res.fired).toBe(true)
    if (res.fired) {
      expect(res.transitions).toEqual([{ event: 'ev', from: 's0', to: 'A' }])
    }
  })

  it('no candidate → { fired:false, reason:"no-transition" } and does NOT throw — RED on HEAD', async () => {
    const sm = mkSm({
      ...base,
      initialState: 's0',
      states: { s0: {}, A: {} },
      // `ev` only fires from a DIFFERENT state, so from s0 there is no candidate.
      events: { ev: { transitions: [{ from: 'A', to: 's0' }] } },
    })
    expect(typeof (sm as any).fireEventDetailed).toBe('function')
    const res: FireResult = await (sm as any).fireEventDetailed('ev')
    expect(res.fired).toBe(false)
    if (!res.fired) expect(res.reason).toBe('no-transition')
  })

  it('guard returns false → reason:"guard-rejected" (distinct from guard-error) — RED on HEAD', async () => {
    const sm = mkSm({
      ...base,
      initialState: 's0',
      states: { s0: {}, A: {} },
      events: {
        ev: {
          transitions: [{ from: 's0', to: 'A', guard: () => false }],
        },
      },
    })
    expect(typeof (sm as any).fireEventDetailed).toBe('function')
    const res: FireResult = await (sm as any).fireEventDetailed('ev')
    expect(res.fired).toBe(false)
    if (!res.fired) {
      expect(res.reason).toBe('guard-rejected')
      expect(res.rejected?.[0]?.reason).toBe('guard-rejected')
    }
  })

  it('guard THROWS → reason:"guard-error" (NOW distinct from guard-rejected, closes F4) — RED on HEAD', async () => {
    const boom = new Error('guard blew up')
    const sm = mkSm({
      ...base,
      initialState: 's0',
      states: { s0: {}, A: {} },
      events: {
        ev: {
          transitions: [
            {
              from: 's0',
              to: 'A',
              guard: () => {
                throw boom
              },
            },
          ],
        },
      },
    })
    expect(typeof (sm as any).fireEventDetailed).toBe('function')
    const res: FireResult = await (sm as any).fireEventDetailed('ev')
    expect(res.fired).toBe(false)
    if (!res.fired) {
      // The load-bearing distinction: a THROWING guard is NOT the same as an
      // honest refusal — HEAD collapses both into the same silent `false`.
      expect(res.reason).toBe('guard-error')
      expect(res.rejected?.[0]?.reason).toBe('guard-error')
    }
  })
})

/**
 * ── CONFORMANCE skeleton — W3C SCXML IRP-derived vectors (SPEC §4в) ────────────
 *
 * Adversarial-verify of the selection semantics is BLIND (it reads the same SPEC
 * as its oracle), so these externally-anchored W3C vectors are the only
 * independent check that the new rule matches the standard on the INTERSECTION of
 * the two semantics.
 *
 * APPLICABLE (this suite asserts them):
 *   • test403 family — "a transition in a descendant state has priority over a
 *     conflicting transition in an ancestor" (child-over-parent). Maps to axis 1.
 *   • document-order selection — "when several transitions in the optimal set are
 *     in conflict, the one whose source appears earlier in document order is
 *     selected." Maps to axis 4 (single-transition projection for W3-B).
 *
 * INTENTIONALLY NOT APPLICABLE (documented divergence, NOT a conformance gap):
 *   • `priority` attribute (axis 2) — a library EXTENSION; SCXML has no numeric
 *     transition priority, so no IRP vector covers it.
 *   • Full optimal-transition-set (fire ALL non-conflicting matched transitions
 *     across regions in one microstep) — SIMPLIFIED here to single-transition
 *     selection; OTS lands in W3-C. IRP tests exercising simultaneous multi-region
 *     firing (e.g. parallel-region test cases) are therefore deferred, not failed.
 *   • Eventless/`cond`-only spontaneous transitions and internal/external
 *     transition exit-set differences — out of scope for the selection-rule wave.
 */
describe('conformance — W3C SCXML IRP applicable vectors (SPEC §4в)', () => {
  const mk = (initialState: string, states: any, transitions: any[]) => ({
    ...base,
    initialState,
    states,
    events: { ev: { transitions } },
  })

  // IRP test403-analog: child (descendant) transition preempts the parent's,
  // independent of document order. RED on HEAD in the [child-first] projection
  // (HEAD would let the parent win when declared later).
  it('IRP-403: descendant transition preempts ancestor (child-over-parent)', async () => {
    const states = {
      P: { regions: { r: { child: {} } }, initial: 'child' },
      parentTook: {},
      childTook: {},
    }
    // Declared child-first, parent-last: SCXML still selects the child.
    expect(
      await winnerOf(
        mk('P', states, [
          { from: 'P.r.child', to: 'childTook' },
          { from: 'P', to: 'parentTook' },
        ]),
      ),
    ).toBe('childTook')
  })

  // IRP document-order-analog: two conflicting transitions from incomparable
  // sources of equal precedence → the earlier source in document order is taken.
  // RED on HEAD (HEAD takes the later-declared).
  it('IRP-docorder: on an exact tie the earlier document-order source is selected', async () => {
    const states = {
      p: { initial: 'r1.a|r2.b', regions: { r1: { a: {} }, r2: { b: {} } } },
      firstDecl: {},
      secondDecl: {},
    }
    expect(
      await winnerOf(
        mk('p', states, [
          { from: 'p.r1.a', to: 'firstDecl' },
          { from: 'p.r2.b', to: 'secondDecl' },
        ]),
      ),
    ).toBe('firstDecl')
  })
})

// W3-B.1 (critic-приёмка W3-B, findings #1/#2): subset-dominance + dominance
// as ORDER not filter. A lane leaf (narrow coverage, deep source) preempts the
// composite parent (broad coverage, shallow source) in BOTH declaration orders,
// and when the leaf's guard REJECTS the parent is a legitimate fallback.
describe('W3-B.1 — multi-lane composite: leaf preempts parent, parent is guard-fallback', () => {
  const mk = (transitions: any[]) =>
    createMachine(
      {
        name: 'ml',
        stateAttribute: 'state',
        initialState: 'RUN',
        states: {
          RUN: {
            initial: 'read.busy|write.busy',
            regions: {
              read: { busy: {}, done: {} },
              write: { busy: {}, done: {} },
            },
          },
          ABORTED: {},
          RD: {},
        },
        events: { ev: { transitions } },
      } as any,
      { state: 'RUN' } as any,
    )

  it('finding #1: leaf from:RUN.read.busy beats parent from:RUN — parent declared FIRST', async () => {
    const sm = mk([
      { from: 'RUN', to: 'ABORTED' },
      { from: 'RUN.read.busy', to: 'RD' },
    ])
    await sm.fireEvent('ev')
    // Descendant preempts even though the parent covers 2 lanes (different
    // coverage size) and is declared first. Pre-W3-B.1: 'ABORTED' (last-declared).
    expect(sm.getCurrentState()).toContain('RD')
  })

  it('finding #1: leaf beats parent — leaf declared FIRST (symmetry)', async () => {
    const sm = mk([
      { from: 'RUN.read.busy', to: 'RD' },
      { from: 'RUN', to: 'ABORTED' },
    ])
    await sm.fireEvent('ev')
    expect(sm.getCurrentState()).toContain('RD')
  })

  it('finding #2: leaf guard REJECTS → parent is the fallback (dominance is order, not filter)', async () => {
    const sm = mk([
      { from: 'RUN.read.busy', to: 'RD', guard: () => false },
      { from: 'RUN', to: 'ABORTED' },
    ])
    await sm.fireEvent('ev')
    // The dominated parent was NOT dropped before guards; it fires when the
    // dominating leaf's guard fails. Pre-W3-B.1 filter: neither, RUN stuck.
    expect(sm.getCurrentState()).toBe('ABORTED')
  })
})

// Specificity class 1 ('a|*' partial wildcard) — was uncovered (critic W3-B §5).
describe('specificity: explicit > partial-wildcard (a|*) > full wildcard', () => {
  it('explicit from beats a partial-wildcard from on the same event', async () => {
    const sm = createMachine(
      {
        name: 'spec1',
        stateAttribute: 'state',
        initialState: 'a',
        states: {
          a: { regions: { x: { p: {}, q: {} }, y: { m: {}, n: {} } }, initial: 'x.p|y.m' },
          EXPL: {},
          PART: {},
        },
        events: {
          go: {
            transitions: [
              // partial wildcard declared FIRST; explicit must still win by specificity
              { from: 'a.x.p|*', to: 'PART' },
              { from: 'a.x.p|a.y.m', to: 'EXPL' },
            ],
          },
        },
      } as any,
      { state: 'a' } as any,
    )
    await sm.fireEvent('go')
    expect(sm.getCurrentState()).toBe('EXPL')
  })
})
