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
 *   • W8/V3b + W8/V11 — SIBLING-ось: порядок enter/exit ОДНОУРОВНЕВЫХ состояний в
 *     РАЗНЫХ параллельных регионах, и форма обхода при ВЛОЖЕННЫХ композитах.
 *     ИЗМЕРЕНО через публичный канал `IMonitor.recordLifecycle` (W8/V1). V3b нашёл
 *     на этой оси ДВЕ дивергенции (D1 — sibling-порядок на выходе был прямым вместо
 *     обратного; D2 — обход был depth-major вместо DFS-preorder) и ЗАПИННИЛ их.
 *     W8/V11 ПОЧИНИЛ обе в ядре (одна сортировка по `documentIndex` модели), и
 *     векторы ПЕРЕВЁРНУТЫ на W3C-ожидания. ВСЯ ось теперь ПОКРЫТА как conformance:
 *     entry = document order (DFS preorder), exit = reverse document order.
 *     ДИВЕРГЕНЦИЙ НА ЭТОЙ ОСИ БОЛЬШЕ НЕТ — см. футер файла.
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
import { createMachine, type IMonitor, type LifecycleEvent } from '../index'

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

// ═════════════════════════════════════════════════════════════════════════════
// W8/V3b — MEASURING the previously-UNASSERTED axis: same-depth SIBLING order
// across parallel regions, and the traversal shape over NESTED composites.
//
// WHY THIS IS NOW MEASURABLE. Until W8 the ORDER of enter/exit callbacks was only
// observable by side-effect logging inside user hooks — which cannot distinguish
// "the engine called r1 first" from "the engine called both and my log raced".
// W8/V1 added the PUBLIC lifecycle observability channel (`IMonitor.recordLifecycle`,
// see `LifecycleEvent` in types.ts): the engine emits a `begin`/`end` edge for every
// state hook it invokes, with a per-machine monotonic `seq`. Filtering `edge:'begin'`
// yields the exact INVOCATION sequence. That is the instrument this section uses.
//
// The vectors below are NOT a re-run of test504/505-506 (those assert only the
// LAYER relation — all leaves before/after the composite — order-INSENSITIVELY
// across siblings). These assert the SEQUENCE those tests deliberately left open.
// ═════════════════════════════════════════════════════════════════════════════

/** A monitor that records nothing but the lifecycle stream. */
function lifecycleSink(): { events: LifecycleEvent[]; monitor: IMonitor } {
  const events: LifecycleEvent[] = []
  return {
    events,
    monitor: {
      recordTransition() {},
      recordError() {},
      recordLifecycle(event) {
        events.push(event)
      },
    },
  }
}

/**
 * The INVOCATION sequence of the `onEnter`/`onExit` slot: `edge:'begin'` only (an
 * `end` edge would report SETTLE order, a different question), one entry per state,
 * in `seq` order. `onBeforeX`/`onAfterX` are filtered out — they are per-state
 * grouped around the same slot and would only triple the noise (verified: the six
 * hooks of one state always run as one contiguous block, see the assertion below).
 */
const enterExitSequence = (events: LifecycleEvent[], kind: 'enter' | 'exit'): string[] =>
  events
    .filter(
      (e) =>
        e.kind === kind &&
        e.edge === 'begin' &&
        e.hook === (kind === 'enter' ? 'onEnter' : 'onExit'),
    )
    .map((e) => e.state)

const settle = () => new Promise((r) => setTimeout(r, 0))

/**
 * Build `wrap` (a composite with `regions`), enter it from `START`, then leave it
 * to `done`; return the measured enter- and exit-invocation sequences.
 */
async function measureWrap(regions: Record<string, any>, initial: string) {
  const { events, monitor } = lifecycleSink()
  const sm = createMachine(
    {
      ...base,
      initialState: 'START',
      states: {
        START: {},
        wrap: { initial, onEnter: () => {}, onExit: () => {}, regions },
        done: {},
      },
      events: {
        go: { transitions: [{ from: 'START', to: 'wrap' }] },
        fin: { transitions: [{ from: 'wrap', to: 'done' }] },
      },
    } as any,
    { state: 'START' } as any,
    { monitor } as any,
  )
  await settle()
  events.length = 0
  await sm.fireEvent('go')
  const entered = enterExitSequence(events, 'enter')
  const config = sm.getCurrentState()
  events.length = 0
  await sm.fireEvent('fin')
  const exited = enterExitSequence(events, 'exit')
  return { entered, exited, config, events }
}

/** A leaf with both hooks present (the channel only reports hooks that exist). */
const leaf = () => ({ onEnter: () => {}, onExit: () => {} })
/** A composite leaf-carrier: `<name>` holding one region `<rk>` with one leaf. */
const nest = (rk: string, child: string) => ({
  initial: `${rk}.${child}`,
  onEnter: () => {},
  onExit: () => {},
  regions: { [rk]: { [child]: leaf() } },
})

// ─────────────────────────────────────────────────────────────────────────────
// CONFORMANT AXIS — ENTRY sibling order across parallel regions.
//
// W3C SCXML §3.13 (enterStates): the entry set is entered in ENTRY ORDER =
// document order. For two orthogonal regions r1, r2 declared in that order, the
// leaf of r1 is entered BEFORE the leaf of r2.
//
// MEASURED (2 regions): ['wrap', 'wrap.r1.a', 'wrap.r2.x']
// MEASURED (3 regions): ['wrap', 'wrap.r1.a', 'wrap.r2.x', 'wrap.r3.p']
// VERDICT: MATCHES W3C. This axis is hereby a CONFORMANCE VECTOR, no longer
// "unasserted". (It was unasserted only because there was no way to observe the
// sequence; W8/V1's channel made it observable.)
// ─────────────────────────────────────────────────────────────────────────────
describe('IRP test505/506 (sibling axis) — parallel ENTRY order is forward document order (W3C §3.13)', () => {
  it('2 regions: composite first, then r1 leaf, then r2 leaf', async () => {
    const { entered, config } = await measureWrap(
      { r1: { a: leaf() }, r2: { x: leaf() } },
      'r1.a|r2.x',
    )
    expect(config).toBe('wrap.r1.a|wrap.r2.x')
    expect(entered).toEqual(['wrap', 'wrap.r1.a', 'wrap.r2.x'])
  })

  it('3 regions: r1, r2, r3 in declaration order', async () => {
    const { entered } = await measureWrap(
      { r1: { a: leaf() }, r2: { x: leaf() }, r3: { p: leaf() } },
      'r1.a|r2.x|r3.p',
    )
    expect(entered).toEqual(['wrap', 'wrap.r1.a', 'wrap.r2.x', 'wrap.r3.p'])
  })

  it('the sibling order tracks the REGIONS declaration order, not the initial-string order', async () => {
    // Same `initial` string, mirrored `regions` declaration → mirrored sequence.
    // This is what makes "document order" a meaningful claim here: the order is a
    // property of the CONFIG's region declaration (the library's stand-in for SCXML
    // document order), not of how the initial configuration happens to be spelled.
    const declaredR1First = await measureWrap(
      { r1: { a: leaf() }, r2: { x: leaf() } },
      'r2.x|r1.a', // initial spelled r2-first on purpose
    )
    expect(declaredR1First.entered).toEqual(['wrap', 'wrap.r1.a', 'wrap.r2.x'])

    const declaredR2First = await measureWrap(
      { r2: { x: leaf() }, r1: { a: leaf() } },
      'r2.x|r1.a',
    )
    expect(declaredR2First.entered).toEqual(['wrap', 'wrap.r2.x', 'wrap.r1.a'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CONFORMANT AXIS — EXIT sibling order and NESTED traversal shape (W8/V11).
//
// HISTORY (why this block reads as a repaired divergence, not a fresh vector).
// W8/V3b MEASURED this axis for the first time (the W8/V1 `IMonitor.recordLifecycle`
// channel made callback order observable from outside the machine) and found TWO
// divergences from W3C §3.13. They were PINNED here as `describe('DIVERGENCE FROM
// W3C …')`, deliberately asserting the ACTUAL (non-conformant) output so the call
// bug-vs-extension could be made by the maintainer instead of being silently
// papered over. The maintainer adjudicated: BUG. W8/V11 fixed the engine, and the
// vectors below are now flipped to the W3C-NORMATIVE expectations. The historical
// pre-V11 sequences are kept verbatim in the comments so the change is auditable
// and so a regression back to the old shape is legible at a glance.
//
// ── D1 (FIXED in W8/V11): EXIT sibling order is REVERSE document order ─────────
// W3C SCXML §3.13 (exitStates): "the states are exited in EXIT ORDER, which is the
// REVERSE of document order". For regions declared r1, r2 the document order of the
// leaves is (r1.a, r2.x), so the normative exit order is (r2.x, r1.a, wrap).
//   W3C / NOW:      ['wrap.r2.x', 'wrap.r1.a', 'wrap']
//   PRE-V11 (bug):  ['wrap.r1.a', 'wrap.r2.x', 'wrap']   ← siblings were NOT reversed
//   3 regions —
//   W3C / NOW:      ['wrap.r3.p', 'wrap.r2.x', 'wrap.r1.a', 'wrap']
//   PRE-V11 (bug):  ['wrap.r1.a', 'wrap.r2.x', 'wrap.r3.p', 'wrap']
// The pre-V11 engine reversed the DEPTH axis (deepest-first — conformant) but kept
// the SIBLING axis forward. W3C reverses BOTH, because it reverses ONE flat
// document-order list — which is exactly what the fix now does.
//
// ── D2 (FIXED in W8/V11): nested traversal is DFS preorder ────────────────────
// W3C document order is a DEPTH-FIRST PREORDER walk of the state tree: a region is
// entered COMPLETELY (down to its leaf) before its next sibling region is entered
// at all. The pre-V11 engine instead ordered the whole entry set by DEPTH (ascending
// on entry, descending on exit), tie-broken by declaration order — i.e. a
// BREADTH-FIRST / level-order interleaving across regions.
//   Symmetric nesting (r1▸a▸s▸deep, r2▸x▸t▸low) —
//   W3C / NOW      entry: ['wrap','wrap.r1.a','wrap.r1.a.s.deep','wrap.r2.x','wrap.r2.x.t.low']
//   PRE-V11 (bug)  entry: ['wrap','wrap.r1.a','wrap.r2.x','wrap.r1.a.s.deep','wrap.r2.x.t.low']
//   W3C / NOW      exit : ['wrap.r2.x.t.low','wrap.r2.x','wrap.r1.a.s.deep','wrap.r1.a','wrap']
//   PRE-V11 (bug)  exit : ['wrap.r1.a.s.deep','wrap.r2.x.t.low','wrap.r1.a','wrap.r2.x','wrap']
// Note this divergence was INVISIBLE on flat regions: when every region's leaf sits
// at the same depth, level-order and preorder coincide. It only appeared once a
// region contained a nested composite, which is exactly why the pre-W8 layer-only
// assertions could not have caught it.
//
// ── THE FIX (one sort key) ────────────────────────────────────────────────────
// `computeEnterExitSets` now sorts BOTH sets by the compiled model's
// `documentIndex` (model.ts `compileModel` — a deterministic DFS-PREORDER rank of
// the config tree): ASCENDING for entry (= document order), DESCENDING for exit
// (= reverse document order). Because documentIndex IS the preorder rank, ONE key
// repairs D1 and D2 simultaneously and preserves the layer relation for free (an
// ancestor's index is handed out on ENTERING the node, hence always smaller than
// any descendant's). It replaces the `(depth, insertion-order)` key that caused both.
// ─────────────────────────────────────────────────────────────────────────────
describe('IRP test404/504 (sibling axis) — parallel EXIT order is REVERSE document order (W3C §3.13)', () => {
  it('2 regions: r2 leaf first, then r1 leaf, then the composite', async () => {
    const two = await measureWrap({ r1: { a: leaf() }, r2: { x: leaf() } }, 'r1.a|r2.x')
    expect(two.exited).toEqual(['wrap.r2.x', 'wrap.r1.a', 'wrap'])
    // Pre-V11 this was ['wrap.r1.a', 'wrap.r2.x', 'wrap'] (D1). Assert the old
    // shape is gone, so a revert cannot pass this file quietly.
    expect(two.exited).not.toEqual(['wrap.r1.a', 'wrap.r2.x', 'wrap'])
  })

  it('3 regions: r3, r2, r1 — the exact reverse of the declaration order', async () => {
    const three = await measureWrap(
      { r1: { a: leaf() }, r2: { x: leaf() }, r3: { p: leaf() } },
      'r1.a|r2.x|r3.p',
    )
    expect(three.exited).toEqual(['wrap.r3.p', 'wrap.r2.x', 'wrap.r1.a', 'wrap'])
    // The layer relation (test504) is unchanged by the V11 fix: the composite
    // still exits LAST, after every one of its descendants.
    expect(three.exited[three.exited.length - 1]).toBe('wrap')
  })

  it('the exit sibling order is the REVERSE of the declaration order (mirrored config → mirrored exit)', async () => {
    // Declaring r2 FIRST makes r2 exit LAST. Under the pre-V11 forward walk this
    // was r2-first; reversing the declaration must reverse the exit sequence, which
    // is what distinguishes "reverse document order" from "arbitrary but stable".
    const mirrored = await measureWrap({ r2: { x: leaf() }, r1: { a: leaf() } }, 'r1.a|r2.x')
    expect(mirrored.exited).toEqual(['wrap.r1.a', 'wrap.r2.x', 'wrap'])

    // …and the ENTRY axis of the same config stays forward document order, i.e.
    // entry and exit are exact mirrors of each other.
    expect(mirrored.entered).toEqual(['wrap', 'wrap.r2.x', 'wrap.r1.a'])
    expect([...mirrored.exited].reverse()).toEqual(mirrored.entered)
  })
})

describe('IRP test404/505-506 (traversal shape) — nested composites walk DFS preorder (W3C §3.13)', () => {
  it('symmetric nesting: each region is walked CONTIGUOUSLY, no cross-region interleave', async () => {
    const { entered, exited, config } = await measureWrap(
      { r1: { a: nest('s', 'deep') }, r2: { x: nest('t', 'low') } },
      'r1.a|r2.x',
    )
    // The reached CONFIGURATION is unchanged by V11 — only the callback ORDER moved.
    expect(config).toBe('wrap.r1.a.s.deep|wrap.r2.x.t.low')

    // W3C preorder keeps each region contiguous. Pre-V11 (D2) the two regions
    // INTERLEAVED by depth:
    //   ['wrap','wrap.r1.a','wrap.r2.x','wrap.r1.a.s.deep','wrap.r2.x.t.low']
    expect(entered).toEqual([
      'wrap',
      'wrap.r1.a',
      'wrap.r1.a.s.deep',
      'wrap.r2.x',
      'wrap.r2.x.t.low',
    ])
    // Exit = reverse preorder. Pre-V11 (D2):
    //   ['wrap.r1.a.s.deep','wrap.r2.x.t.low','wrap.r1.a','wrap.r2.x','wrap']
    expect(exited).toEqual([
      'wrap.r2.x.t.low',
      'wrap.r2.x',
      'wrap.r1.a.s.deep',
      'wrap.r1.a',
      'wrap',
    ])
    // Exit is the EXACT mirror of entry — the strongest single statement of
    // "document order / reverse document order over one flat list".
    expect([...exited].reverse()).toEqual(entered)

    // The W3C LAYER relation holds on both edges (it held pre-V11 too; the fix
    // must not have traded the sibling axis for the ancestor/descendant one).
    expect(entered.indexOf('wrap.r1.a')).toBeLessThan(entered.indexOf('wrap.r1.a.s.deep'))
    expect(entered.indexOf('wrap.r2.x')).toBeLessThan(entered.indexOf('wrap.r2.x.t.low'))
    expect(exited.indexOf('wrap.r1.a.s.deep')).toBeLessThan(exited.indexOf('wrap.r1.a'))
    expect(exited.indexOf('wrap.r2.x.t.low')).toBeLessThan(exited.indexOf('wrap.r2.x'))
  })

  it('ASYMMETRIC depths: the deep region finishes ENTIRELY before the shallow sibling starts', async () => {
    // r1 nests THREE levels deep, r2 is a bare leaf. This is the discriminating
    // vector: level-order put the shallow r2 leaf BETWEEN two r1 descendants on
    // entry — impossible under a preorder walk, which finishes r1 entirely first.
    const deepR1 = {
      initial: 's.mid',
      onEnter: () => {},
      onExit: () => {},
      regions: { s: { mid: nest('u', 'deep') } },
    }
    const { entered, exited, config } = await measureWrap(
      { r1: { a: deepR1 }, r2: { x: leaf() } },
      'r1.a|r2.x',
    )
    expect(config).toBe('wrap.r1.a.s.mid.u.deep|wrap.r2.x')

    // Pre-V11 (D2) entry was depth-major:
    //   ['wrap','wrap.r1.a','wrap.r2.x','wrap.r1.a.s.mid','wrap.r1.a.s.mid.u.deep']
    expect(entered).toEqual([
      'wrap',
      'wrap.r1.a',
      'wrap.r1.a.s.mid',
      'wrap.r1.a.s.mid.u.deep',
      'wrap.r2.x',
    ])
    // Pre-V11 (D1+D2) exit was:
    //   ['wrap.r1.a.s.mid.u.deep','wrap.r1.a.s.mid','wrap.r1.a','wrap.r2.x','wrap']
    expect(exited).toEqual([
      'wrap.r2.x',
      'wrap.r1.a.s.mid.u.deep',
      'wrap.r1.a.s.mid',
      'wrap.r1.a',
      'wrap',
    ])
    expect([...exited].reverse()).toEqual(entered)

    // The shallow r2 leaf can NEVER sit between two r1 descendants — the exact
    // property that was violated pre-V11.
    expect(entered.indexOf('wrap.r2.x')).toBeGreaterThan(
      entered.indexOf('wrap.r1.a.s.mid.u.deep'),
    )
    // NOTE the layer relation is a WEAKER claim than preorder and is NOT what
    // moved: a bare-leaf sibling has no ancestor/descendant relation to r1's
    // chain at all, so only the traversal shape can order them.
    expect(exited.indexOf('wrap.r1.a.s.mid.u.deep')).toBeLessThan(exited.indexOf('wrap.r1.a'))
  })

  it('mixed depths across THREE regions: preorder = (r1 subtree) then r2 then r3', async () => {
    const { entered, exited } = await measureWrap(
      { r1: { a: nest('s', 'deep') }, r2: { x: leaf() }, r3: { p: leaf() } },
      'r1.a|r2.x|r3.p',
    )
    expect(entered).toEqual([
      'wrap',
      'wrap.r1.a',
      'wrap.r1.a.s.deep',
      'wrap.r2.x',
      'wrap.r3.p',
    ])
    expect(exited).toEqual([
      'wrap.r3.p',
      'wrap.r2.x',
      'wrap.r1.a.s.deep',
      'wrap.r1.a',
      'wrap',
    ])
  })

  it('the W3C order is DETERMINISTIC — 12 independent constructions agree byte-for-byte', async () => {
    // The measurement would be worthless if the order merely happened to come out
    // this way once. A NON-deterministic order would be a far more serious finding
    // than either divergence (it would make onExit/onEnter side effects unorderable),
    // so it is pinned explicitly. Post-V11 the order derives from the compiled
    // model's `documentIndex`, a pure function of the config's shape — determinism
    // is now structural rather than incidental. (Also verified across processes.)
    const runs: string[] = []
    for (let i = 0; i < 12; i++) {
      const { entered, exited } = await measureWrap(
        { r1: { a: nest('s', 'deep') }, r2: { x: leaf() }, r3: { p: leaf() } },
        'r1.a|r2.x|r3.p',
      )
      runs.push(JSON.stringify({ entered, exited }))
    }
    expect(new Set(runs).size).toBe(1)
    // Pre-V11 this same config produced
    //   entered: ['wrap','wrap.r1.a','wrap.r2.x','wrap.r3.p','wrap.r1.a.s.deep']
    //   exited : ['wrap.r1.a.s.deep','wrap.r1.a','wrap.r2.x','wrap.r3.p','wrap']
    expect(JSON.parse(runs[0]!)).toEqual({
      entered: ['wrap', 'wrap.r1.a', 'wrap.r1.a.s.deep', 'wrap.r2.x', 'wrap.r3.p'],
      exited: ['wrap.r3.p', 'wrap.r2.x', 'wrap.r1.a.s.deep', 'wrap.r1.a', 'wrap'],
    })
  })

  it('CAVEAT — "declaration order" is JS own-property order: INTEGER-LIKE region keys re-sort numerically', async () => {
    // Not a divergence so much as a trap in the PREMISE of the two vectors above:
    // the engine's stand-in for document order is the iteration order of the
    // `regions` object (that is what `compileModel` walks), and ECMAScript orders
    // integer-like keys ASCENDING ahead of string keys — regardless of how they
    // were written. So a config declaring `{ '2': …, '1': … }` has document order
    // (1, 2). Fully DETERMINISTIC, but a config author cannot read source order as
    // document order when region keys are numeric.
    const { entered, exited } = await measureWrap(
      { 2: { b: leaf() }, 1: { a: leaf() } },
      '2.b|1.a',
    )
    expect(entered).toEqual(['wrap', 'wrap.1.a', 'wrap.2.b'])
    // Exit reverses THAT effective order, not the source order.
    expect(exited).toEqual(['wrap.2.b', 'wrap.1.a', 'wrap'])
  })

  it('hook GRANULARITY: the six hooks of one state form one contiguous block (justifies the onEnter/onExit-only filter)', async () => {
    // The sequences above read only the `onEnter`/`onExit` slot. That is only a
    // faithful summary if a state's other hooks do not interleave with a sibling's —
    // pinned here so the filter cannot silently start hiding an interleave.
    const hooks = () => ({
      onBeforeEnter: () => {},
      onEnter: () => {},
      onAfterEnter: () => {},
      onBeforeExit: () => {},
      onExit: () => {},
      onAfterExit: () => {},
    })
    const { events } = await measureWrap({ r1: { a: hooks() }, r2: { x: hooks() } }, 'r1.a|r2.x')
    // `events` holds the EXIT microstep (measureWrap clears before each fire).
    // `wrap` itself is built by measureWrap with only `onExit`, and the channel
    // reports only hooks that EXIST — so its block is a single record. The point of
    // the vector is the two LEAVES: r2.x's three exit hooks all run before r1.a's
    // first (V11 reverse order), i.e. the blocks do not interleave. Pre-V11 the
    // r1.a block came first; the GRANULARITY claim — one contiguous block per
    // state — is what this vector protects, and it is unchanged by V11.
    expect(events.filter((e) => e.edge === 'begin').map((e) => `${e.hook}@${e.state}`)).toEqual([
      'onBeforeExit@wrap.r2.x',
      'onExit@wrap.r2.x',
      'onAfterExit@wrap.r2.x',
      'onBeforeExit@wrap.r1.a',
      'onExit@wrap.r1.a',
      'onAfterExit@wrap.r1.a',
      'onExit@wrap',
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// W8/V11 SAFETY NET — what the reordering must NOT have changed.
//
// The V11 fix is a PERMUTATION of the enter/exit sets, nothing else. The two
// vectors above prove the new SEQUENCE; these prove the fix did not smuggle in a
// semantic change alongside it. Distinguishing "the order of equal-standing
// callbacks moved" (intended) from "a callback went missing / the configuration
// changed / the layer relation broke" (a defect) is the whole point — a fix that
// achieved the right sequence by dropping a state would satisfy every assertion
// above and fail every one below.
// ─────────────────────────────────────────────────────────────────────────────
describe('W8/V11 invariants — the reorder is a PERMUTATION, not a semantic change', () => {
  const shapes: Array<{ name: string; regions: Record<string, any>; initial: string }> = [
    { name: '2 flat regions', regions: { r1: { a: leaf() }, r2: { x: leaf() } }, initial: 'r1.a|r2.x' },
    {
      name: '3 flat regions',
      regions: { r1: { a: leaf() }, r2: { x: leaf() }, r3: { p: leaf() } },
      initial: 'r1.a|r2.x|r3.p',
    },
    {
      name: 'symmetric nesting',
      regions: { r1: { a: nest('s', 'deep') }, r2: { x: nest('t', 'low') } },
      initial: 'r1.a|r2.x',
    },
    {
      name: 'asymmetric depth',
      regions: {
        r1: {
          a: {
            initial: 's.mid',
            onEnter: () => {},
            onExit: () => {},
            regions: { s: { mid: nest('u', 'deep') } },
          },
        },
        r2: { x: leaf() },
      },
      initial: 'r1.a|r2.x',
    },
    {
      name: 'mixed depths, 3 regions',
      regions: { r1: { a: nest('s', 'deep') }, r2: { x: leaf() }, r3: { p: leaf() } },
      initial: 'r1.a|r2.x|r3.p',
    },
  ]

  it.each(shapes)('$name — the SET of enter callbacks equals the SET of exit callbacks', async ({ regions, initial }) => {
    const { entered, exited } = await measureWrap(regions, initial)
    // Every state entered is exited exactly once, and vice versa: no callback was
    // dropped, duplicated, or invented by the reordering.
    expect([...entered].sort()).toEqual([...exited].sort())
    expect(new Set(entered).size).toBe(entered.length)
    expect(new Set(exited).size).toBe(exited.length)
  })

  it.each(shapes)('$name — exit is the EXACT reverse of entry (document order ⇄ reverse document order)', async ({ regions, initial }) => {
    const { entered, exited } = await measureWrap(regions, initial)
    expect([...exited].reverse()).toEqual(entered)
  })

  it.each(shapes)('$name — LAYER invariant: strictly ancestor-before-descendant on entry, descendant-before-ancestor on exit', async ({ regions, initial }) => {
    const { entered, exited } = await measureWrap(regions, initial)
    // `a` is an ancestor of `b` iff b starts with a + '.'. Checked over every
    // ordered pair present, so a nested chain of any depth is covered.
    for (const a of entered) {
      for (const b of entered) {
        if (a === b || !b.startsWith(`${a}.`)) continue
        expect(entered.indexOf(a)).toBeLessThan(entered.indexOf(b))
        expect(exited.indexOf(b)).toBeLessThan(exited.indexOf(a))
      }
    }
    // The composite itself always bookends the sequence.
    expect(entered[0]).toBe('wrap')
    expect(exited[exited.length - 1]).toBe('wrap')
  })

  it.each(shapes)('$name — the reached CONFIGURATION is order-independent', async ({ regions, initial }) => {
    const { config, entered } = await measureWrap(regions, initial)
    // Every active leaf in the configuration was entered, and the configuration
    // holds exactly the leaves (no composite parents leak into it).
    const leaves = config!.split('|')
    for (const l of leaves) expect(entered).toContain(l)
    expect(leaves.every((l) => !leaves.some((o) => o !== l && o.startsWith(`${l}.`)))).toBe(true)
  })
})

/**
 * ── DIVERGENCE FROM W3C (found by §4в) — CURRENT STATUS: NONE ──────────────────
 * None on the 8 ORIGINAL vectors (preemption, document-order, OTS, exit-order ×2,
 * entry-order, exec-content-order): the library's observed behaviour matches the
 * W3C SCXML §3.13 pass-criteria there.
 *
 * None, ANY LONGER, on the ninth axis (sibling order + nested traversal shape).
 * Its history, kept because the fix is a BREAKING behaviour change and the audit
 * trail is the point:
 *
 *   • W8/V1 added the lifecycle observability channel (`IMonitor.recordLifecycle`),
 *     making callback order observable from outside the machine for the first time.
 *   • W8/V3b MEASURED the axis and split the outcome three ways:
 *       – ENTRY sibling order across parallel regions — MATCHED W3C (forward
 *         document order = the `regions` declaration order). Promoted then, and
 *         still asserted, in `describe('IRP test505/506 (sibling axis) …')`.
 *       – EXIT sibling order — DIVERGED (D1): the engine exited siblings FORWARD
 *         where W3C §3.13 exits in the REVERSE of document order.
 *       – Nested-composite traversal shape — DIVERGED (D2): the engine ordered the
 *         whole set by DEPTH and interleaved regions level-by-level, where W3C
 *         walks DFS preorder (each region contiguous). Invisible on flat regions.
 *     V3b pinned the ACTUAL behaviour deliberately and explicitly declined to
 *     adjudicate bug-vs-extension, leaving the reproduction for the maintainer.
 *   • W8/V11 — the maintainer adjudicated BUG and fixed the engine.
 *     `computeEnterExitSets` now sorts both sets by the compiled model's
 *     `documentIndex` (a DFS-preorder rank — see model.ts): ASCENDING for entry
 *     (document order), DESCENDING for exit (reverse document order). One key,
 *     both divergences. The V3b vectors were FLIPPED to the W3C expectations and
 *     now live in `describe('IRP test404/504 (sibling axis) …')` and
 *     `describe('IRP test404/505-506 (traversal shape) …')`, each carrying the
 *     pre-V11 sequence in a comment plus a `not.toEqual` / mirror assertion so a
 *     revert to the old shape goes RED rather than drifting. The determinism
 *     vector (12 constructions agree) and the integer-key caveat carry over.
 *
 * BREAKING (1.0.0-beta.x, accepted by the maintainer): user `onExit` callbacks of
 * sibling states in parallel regions now fire in the REVERSE of the declaration
 * order, and nested regions are walked to completion one at a time on BOTH edges.
 * The SET of callbacks invoked, and the reached configuration, are unchanged — only
 * the sequence moved. See README «Callback ordering» and docs/regions-and-parallel.md.
 *
 * Note what never diverged and did not move: the W3C LAYER relations (ancestor
 * before descendant on entry, descendant before ancestor on exit, every descendant
 * of a parallel state before the parallel state itself) — covered by
 * test404/504/505-506 and re-asserted inside the V11 vectors.
 *
 * Legitimate EXTENSIONS (numeric `priority`) are covered under «НАМЕРЕННО НЕ
 * ПРИМЕНИМО» above and are not conformance failures.
 */
