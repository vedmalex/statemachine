/**
 * ── W3C SCXML IRP CONFORMANCE VECTORS (MASTER §4в / U3, #36) ───────────────────
 *
 * ПОЧЕМУ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ (независимая опора, не дубль своих тестов).
 * `selection_scxml.test.ts` / `selection_characterization.test.ts` / `ots_microstep.test.ts`
 * читают ту же SPEC (`.plan/SPEC-selection-and-microstep.md` §4/§6), что и их оракул.
 * Значит adversarial-verify по построению СЛЕП к классу дефекта «SPEC внутренне
 * непротиворечива, но расходится со СТАНДАРТОМ»: оракул совпадает со специфицируемым.
 * Единственная независимая опора — вектор, чей ОЖИДАЕМЫЙ ИСХОД задан НЕ автором
 * библиотеки, а W3C. Именно ПРОИСХОЖДЕНИЕ ожидаемого исхода даёт независимость, а не
 * форма теста.
 *
 * ЧЕСТНАЯ РАМКА ЛЕЙБЛОВ. Библиотека — НЕ SCXML-процессор: у неё нет `<transition>`
 * как дочернего элемента состояния, нет `.scxml`-парсера, событийная модель другая
 * (единый список `events[E].transitions[]`, а не per-state `<transition event=…>`).
 * Поэтому нельзя «прогнать» бинарные `.txml`-файлы IRP. Что МОЖНО и что здесь
 * сделано: взять НОРМАТИВНОЕ ПРАВИЛО SCXML §3.13 (Selecting Transitions / microstep),
 * которое каждый из перечисленных IRP-тестов и проверяет, транслировать сценарий в
 * конфиг ЭТОЙ библиотеки и ассертировать наблюдаемый исход ПРОТИВ W3C-критерия.
 * Номера тестов (test403*, test404, test405/406, test504/505/506) названы как ЯКОРЬ
 * на конкретный нормативный пункт — источник истины для «что правильно» тут W3C
 * SCXML 1.0 Rec (2015-09-01) §3.13, а не SPEC пакета.
 *
 * ── КАРТА ПРИМЕНИМОСТИ ─────────────────────────────────────────────────────────
 * ПРИМЕНИМО (ассертируется ниже, пересечение семантик библиотеки и стандарта):
 *   • test403b — потомок преемптит предка (child-over-parent preemption).
 *   • test403a — при равном источнике побеждает первый в document order.
 *   • test403c — optimal transition set: непротиворечивые переходы в разных
 *     параллельных регионах срабатывают ВСЕ за один микрошаг.
 *   • test404 — exit order: потомки выходят раньше предков (reverse document order).
 *   • test504 — то же для параллельных регионов: оба лэйна выходят до композита.
 *   • test505/506 — entry order: предки входят раньше потомков (document order).
 *   • test405/406 — порядок исполняемого контента в микрошаге:
 *     onExit → контент перехода (onTransition) → onEnter.
 *
 * НАМЕРЕННО НЕ ПРИМЕНИМО (легитимное расхождение/расширение — НЕ пробел conformance,
 * НЕ подгоняется):
 *   • Числовой `priority` (SPEC §4.1) — РАСШИРЕНИЕ библиотеки. В чистом SCXML
 *     приоритета-атрибута нет: приоритет = document/child order. Ни один IRP-вектор
 *     его не покрывает, потому что в стандарте такой оси не существует. Тесты на
 *     `priority` живут в selection_scxml/characterization как СВОЙ контракт, не как
 *     conformance.
 *   • Полное множество IRP по <invoke>/<send>/<datamodel>/<script>/event-i/o
 *     (напр. test355 — порядок ОЧЕРЕДИ событий, не селекции; test render/foreach) —
 *     вне подсистемы селекции/микрошага. Другой субсистемный контур — не транслируется
 *     сюда осознанно.
 *   • Internal vs external transition (разница exit-set у `type="internal"`) — в
 *     библиотеке нет различения internal/external на уровне конфига; выходной набор
 *     считается по LCCA всегда. Легитимное сужение, не покрывается.
 *   • Cross-region КОНФЛИКТ с пересекающимся exit-set (test403c, вторая половина:
 *     document order региона при конфликте) — разрешается §6.2 библиотеки по
 *     document order листа; ассертируется в ots_microstep.test.ts (§6.2), здесь НЕ
 *     дублируется, чтобы не выдавать свой тест за независимый вектор.
 *
 * ПОЛНОТА НЕЗАВИСИМОЙ ОПОРЫ. §4в закрыт на ПЕРЕСЕЧЕНИИ семантик: 8 реальных
 * применимых нормативных векторов SCXML §3.13 (preemption, document-order,
 * OTS, exit-order ×2, entry-order, exec-content-order). Это существенное покрытие
 * ядра правила селекции + микрошага, но НЕ полный прогон корпуса IRP (бинарные
 * .txml неисполнимы против не-SCXML-движка — см. «честная рамка» выше). Оси, где
 * библиотека расширяет стандарт (`priority`), намеренно оставлены своим тестам.
 */
import { describe, expect, it } from 'vitest'
import { createMachine } from '../index'

const base = { name: 'Conformance', stateAttribute: 'state' as const }

/** Build, fire `ev` once, return the reached configuration string = the winner. */
async function winnerOf(config: any): Promise<string | undefined> {
  const sm = createMachine(config, {} as any)
  await sm.fireEvent('ev')
  return sm.getCurrentState()
}

// ─────────────────────────────────────────────────────────────────────────────
// IRP test403b — PREEMPTION: descendant transition preempts ancestor's.
//
// (a) W3C SCXML §3.13 (Selecting Transitions): "States are ordered so that a
//     descendant comes before its ancestors. removeConflictingTransitions keeps
//     the transition with the higher-priority source, and a descendant source has
//     higher priority than an ancestor source." W3C pass-criterion: when a state
//     AND its descendant both have a transition enabled by the same event, the
//     DESCENDANT's transition is taken — independent of textual/document order of
//     the two <transition> elements.
// (b) Translation: one composite `P` with an active leaf `P.r.child`; two library
//     transitions on the SAME event — `from:'P'` (ancestor) and `from:'P.r.child'`
//     (descendant). Both are candidates. We test BOTH declaration orders so the
//     outcome cannot be an artefact of last/first-declared.
// (c) Assert (vs W3C): the descendant target is always reached.
// ─────────────────────────────────────────────────────────────────────────────
describe('IRP test403b — descendant transition preempts ancestor (W3C §3.13)', () => {
  const states = {
    P: { regions: { r: { child: {} } }, initial: 'child' },
    ancestorTook: {},
    descendantTook: {},
  }
  const mk = (transitions: any[]) => ({
    ...base,
    initialState: 'P',
    states,
    events: { ev: { transitions } },
  })

  it('declared [ancestor, descendant] → descendant wins (W3C preemption)', async () => {
    expect(
      await winnerOf(
        mk([
          { from: 'P', to: 'ancestorTook' },
          { from: 'P.r.child', to: 'descendantTook' },
        ]),
      ),
    ).toBe('descendantTook')
  })

  it('declared [descendant, ancestor] → STILL descendant wins (order-independent, W3C)', async () => {
    expect(
      await winnerOf(
        mk([
          { from: 'P.r.child', to: 'descendantTook' },
          { from: 'P', to: 'ancestorTook' },
        ]),
      ),
    ).toBe('descendantTook')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// IRP test403a — DOCUMENT ORDER among transitions with the SAME source.
//
// (a) W3C SCXML §3.13: within a single source state, "the transitions are
//     evaluated in document order and the first transition whose condition is
//     satisfied is selected." W3C pass-criterion: when two enabled transitions
//     share the same source, the one appearing EARLIER in document order wins.
// (b) Translation: two transitions with the identical `from:'s0'` on the same
//     event, distinct targets. Sources are identical → preemption does not
//     discriminate → document order is the sole tie-break. Both orders tested.
// (c) Assert (vs W3C): the FIRST-declared transition's target is reached.
// ─────────────────────────────────────────────────────────────────────────────
describe('IRP test403a — same-source conflict resolves by document order (W3C §3.13)', () => {
  const states = { s0: {}, first: {}, second: {} }
  const mk = (transitions: any[]) => ({
    ...base,
    initialState: 's0',
    states,
    events: { ev: { transitions } },
  })

  it('[first, second] → first-declared wins', async () => {
    expect(
      await winnerOf(
        mk([
          { from: 's0', to: 'first' },
          { from: 's0', to: 'second' },
        ]),
      ),
    ).toBe('first')
  })

  it('[second, first] → the now-first-declared wins (document order, not identity)', async () => {
    expect(
      await winnerOf(
        mk([
          { from: 's0', to: 'second' },
          { from: 's0', to: 'first' },
        ]),
      ),
    ).toBe('second')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// IRP test403c — OPTIMAL TRANSITION SET across parallel regions.
//
// (a) W3C SCXML §3.13 (microstep / selectTransitions): the enabled transition set
//     may contain MORE THAN ONE transition — at most one per parallel region — and
//     all non-conflicting members fire together in a single microstep. W3C
//     pass-criterion: an event enabled in several orthogonal regions advances ALL
//     of them at once, not one-per-event.
// (b) Translation: composite `sys` with 3 orthogonal regions each `run`→`stop`;
//     one event has a transition per region. Non-conflicting (disjoint exit sets)
//     → all three fire in one `fireEvent`.
// (c) Assert (vs W3C): all three regions reach their target in one microstep, and
//     fireEventDetailed reports all three fired transitions (§7 surfaces the set).
// ─────────────────────────────────────────────────────────────────────────────
describe('IRP test403c — optimal transition set fires one-per-region (W3C §3.13)', () => {
  const states = {
    sys: {
      initial: 'a.run|b.run|c.run',
      regions: {
        a: { run: {}, stop: {} },
        b: { run: {}, stop: {} },
        c: { run: {}, stop: {} },
      },
    },
  }
  const mkSm = () =>
    createMachine(
      {
        ...base,
        initialState: 'sys',
        states,
        events: {
          ev: {
            transitions: [
              { from: 'sys.a.run', to: 'sys.a.stop' },
              { from: 'sys.b.run', to: 'sys.b.stop' },
              { from: 'sys.c.run', to: 'sys.c.stop' },
            ],
          },
        },
      } as any,
      { state: 'sys' } as any,
    )

  it('one event advances ALL parallel regions in a single microstep', async () => {
    const sm = mkSm()
    await sm.fireEvent('ev')
    expect(sm.getCurrentState()?.split('|').sort()).toEqual(
      ['sys.a.stop', 'sys.b.stop', 'sys.c.stop'].sort(),
    )
  })

  it('fireEventDetailed exposes the whole optimal set (all three fired)', async () => {
    const sm = mkSm()
    const res = await (sm as any).fireEventDetailed('ev')
    expect(res.fired).toBe(true)
    expect(res.transitions.map((t: any) => t.to).sort()).toEqual(
      ['sys.a.stop', 'sys.b.stop', 'sys.c.stop'].sort(),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// IRP test404 — EXIT ORDER: descendants before ancestors (reverse document order).
//
// (a) W3C SCXML §3.13 (exitStates): "states are exited in exit order, which is
//     the reverse of document order" → a child is exited BEFORE its parent, and
//     the deepest active leaf exits first. W3C pass-criterion: onexit handlers
//     fire deepest-first.
// (b) Translation: a strictly nested chain G ▸ p ▸ c (single region per level, so
//     depth is unambiguous — no same-depth sibling ambiguity). Leave G entirely.
// (c) Assert (vs W3C): onExit order is exactly c, p, G (descendant-first).
// ─────────────────────────────────────────────────────────────────────────────
describe('IRP test404 — exit order is descendant-first (W3C §3.13 reverse document order)', () => {
  it('nested G▸p▸c exits c, then p, then G', async () => {
    const log: string[] = []
    const sm = createMachine(
      {
        ...base,
        initialState: 'G',
        states: {
          G: {
            initial: 'p',
            onExit: () => log.push('G'),
            regions: {
              r: {
                p: {
                  initial: 'c',
                  onExit: () => log.push('p'),
                  regions: { s: { c: { onExit: () => log.push('c') } } },
                },
              },
            },
          },
          OUT: {},
        },
        events: { go: { transitions: [{ from: 'G', to: 'OUT' }] } },
      } as any,
      { state: 'G' } as any,
    )
    log.length = 0
    await sm.fireEvent('go')
    expect(sm.getCurrentState()).toBe('OUT')
    // W3C: exit = reverse document order = deepest (c) first, root-of-subtree (G) last.
    expect(log).toEqual(['c', 'p', 'G'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// IRP test504 — EXIT ORDER for PARALLEL states: all descendants before the parent.
//
// (a) W3C SCXML §3.13 (exitStates on a <parallel>): every active descendant of a
//     parallel state is exited before the parallel state itself. W3C
//     pass-criterion: both region leaves' onexit fire before the composite parent's
//     onexit. (Same-depth sibling order across regions is document order in SCXML;
//     the library documents it as insertion-dependent — so we assert the ROBUST
//     W3C layer-relation, order-insensitively across the two siblings, not a
//     brittle sibling sequence.)
// (b) Translation: composite `wrap` with two regions r1/r2, exit the whole wrap.
// (c) Assert (vs W3C): both r1.a and r2.x exit BEFORE wrap; wrap before target.
// ─────────────────────────────────────────────────────────────────────────────
describe('IRP test504 — parallel exit: both region leaves exit before the composite (W3C §3.13)', () => {
  it('r1 and r2 leaves onExit precede the composite onExit', async () => {
    const log: string[] = []
    const sm = createMachine(
      {
        ...base,
        initialState: 'wrap',
        states: {
          wrap: {
            initial: 'r1.a|r2.x',
            onExit: () => log.push('wrap'),
            regions: {
              r1: { a: { onExit: () => log.push('r1.a') } },
              r2: { x: { onExit: () => log.push('r2.x') } },
            },
          },
          done: { onEnter: () => log.push('enter:done') },
        },
        events: { finish: { transitions: [{ from: 'wrap', to: 'done' }] } },
      } as any,
      { state: 'wrap' } as any,
    )
    log.length = 0
    await sm.fireEvent('finish')
    expect(sm.getCurrentState()).toBe('done')

    const wrapIdx = log.indexOf('wrap')
    // W3C: descendants before ancestor — both leaves before the composite.
    expect(log.indexOf('r1.a')).toBeLessThan(wrapIdx)
    expect(log.indexOf('r2.x')).toBeLessThan(wrapIdx)
    // And the composite exits before the target is entered.
    expect(wrapIdx).toBeLessThan(log.indexOf('enter:done'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// IRP test505/506 — ENTRY ORDER: ancestors before descendants (document order).
//
// (a) W3C SCXML §3.13 (enterStates): "states are entered in entry order," which
//     places an ancestor BEFORE its descendants, and default initial children are
//     entered after their parent. W3C pass-criterion: onentry of a parent fires
//     before onentry of its (default) children.
// (b) Translation: transition INTO a composite `W` whose initial config expands a
//     nested chain W ▸ p ▸ c (single-region levels → unambiguous depth ordering).
// (c) Assert (vs W3C): onEnter order is exactly W, p, c (ancestor-first).
// ─────────────────────────────────────────────────────────────────────────────
describe('IRP test505/506 — entry order is ancestor-first (W3C §3.13 document order)', () => {
  it('entering composite W▸p▸c enters W, then p, then c', async () => {
    const log: string[] = []
    const sm = createMachine(
      {
        ...base,
        initialState: 'START',
        states: {
          START: {},
          W: {
            initial: 'p',
            onEnter: () => log.push('W'),
            regions: {
              r: {
                p: {
                  initial: 'c',
                  onEnter: () => log.push('p'),
                  regions: { s: { c: { onEnter: () => log.push('c') } } },
                },
              },
            },
          },
        },
        events: { enter: { transitions: [{ from: 'START', to: 'W' }] } },
      } as any,
      { state: 'START' } as any,
    )
    log.length = 0
    await sm.fireEvent('enter')
    expect(sm.getCurrentState()).toBe('W.r.p.s.c')
    // W3C: entry = document order = ancestor (W) first, deepest (c) last.
    expect(log).toEqual(['W', 'p', 'c'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// IRP test405/406 — EXECUTABLE CONTENT ORDER within one microstep.
//
// (a) W3C SCXML §3.13 (microstep): a microstep executes, in order, (1) the onexit
//     handlers of the exited states, (2) the executable content of the taken
//     transition(s), (3) the onentry handlers of the entered states. W3C
//     pass-criterion: onexit BEFORE transition content BEFORE onentry.
// (b) Translation: A --ev--> B; A has onExit, the transition has onTransition
//     (the library's "executable content of the transition"), B has onEnter.
// (c) Assert (vs W3C): observed order is exactly [exit:A, transition, enter:B].
// ─────────────────────────────────────────────────────────────────────────────
describe('IRP test405/406 — microstep content order: onExit → transition → onEnter (W3C §3.13)', () => {
  it('single transition runs onExit, then transition content, then onEnter', async () => {
    const log: string[] = []
    const sm = createMachine(
      {
        ...base,
        initialState: 'A',
        states: {
          A: { onExit: () => log.push('exit:A') },
          B: { onEnter: () => log.push('enter:B') },
        },
        events: {
          ev: {
            transitions: [{ from: 'A', to: 'B', onTransition: () => log.push('transition') }],
          },
        },
      } as any,
      { state: 'A' } as any,
    )
    log.length = 0
    await sm.fireEvent('ev')
    expect(sm.getCurrentState()).toBe('B')
    expect(log).toEqual(['exit:A', 'transition', 'enter:B'])
  })
})

/**
 * ── DIVERGENCE FROM W3C (found by §4в) ─────────────────────────────────────────
 * None found ON THE 8 ASSERTED VECTORS: the library's observed behaviour matches
 * the W3C SCXML §3.13 pass-criteria. Had any gone red it would have been pinned
 * here with `it.fails` + a W3C-vs-library note (never silently retargeted) for the
 * orchestrator to adjudicate bug-vs-extension.
 *
 * KNOWN UNASSERTED W3C-NORMED AXIS (honest scope, NOT "none found"): the same-depth
 * SIBLING exit/entry order ACROSS parallel regions. W3C §3.13 NORMS it (exit =
 * reverse document order ⇒ region r2's leaf exits before region r1's; entry = the
 * mirror). The library documents this order as INSERTION-DEPENDENT, so test504/
 * 505-506 deliberately assert only the ROBUST layer relation (all leaves before/
 * after the composite parent), order-INSENSITIVELY across siblings — they do NOT
 * pin the sibling sequence. This is a REAL W3C-normed axis left unasserted (a
 * POTENTIAL divergence if the engine's insertion order disagrees with document
 * order), distinct from `priority` (an axis the standard does not have at all).
 * Pinning it is tracked as a §4в follow-up; it is called out here so the "none
 * found" claim is scoped to what is actually asserted, not read as full coverage.
 *
 * Legitimate EXTENSIONS (numeric `priority`) are covered under «НАМЕРЕННО НЕ
 * ПРИМЕНИМО» above and are not conformance failures.
 */
