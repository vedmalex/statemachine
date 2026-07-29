import { describe, expect, it } from 'vitest'
import { createMachine } from '../index'

/**
 * W3-B REWRITE — ранее эта суита ФИКСИРОВАЛА старое (неверное) правило селекции
 * `last-declared-wins` (`getAllowedTransitions` с `priority ?? -Infinity` и
 * eager-гардами) как W2-ДАТЧИК чувствительности. В W3-B правило селекции
 * ЗАМЕНЕНО на SCXML/UML (SPEC §4): priority(default 0) → специфичность источника
 * → доминирование потомка → document order, с ЛЕНИВЫМИ гардами (§5). Датчик
 * больше не может фиксировать старое поведение — движок его не производит.
 *
 * Поэтому КАЖДЫЙ прежний характеризационный ассерт ПЕРЕПИСАН в свой ПАРНЫЙ
 * целевой SCXML-ассерт (НЕ удалён — переписан, с фиксацией дельты
 * «было last-declared → стало SCXML» прямо в имени и комментарии теста). Набор
 * этих дельт — готовый СКЕЛЕТ migration-note (SPEC §9). Companion-суита
 * `selection_scxml.test.ts` — независимая целевая (RED на HEAD, GREEN после
 * W3-B) плюс conformance-векторы; эта — «до/после» карта тех же 5 осей.
 *
 * Все тесты ЗЕЛЁНЫЕ на движке ПОСЛЕ W3-B и КРАСНЫЕ были бы на HEAD-до-W3-B
 * (обратное old-правило). owner передаётся как `{} as any` — движок сам ставит
 * initialState.
 *
 * ── Карта дельт (migration-note §9 скелет) ────────────────────────────────────
 *   Ось 1 (предок vs потомок):
 *     [ancestor, descendant]  было descWon (last-declared) → стало descWon (доминирование) — СОВПАЛО
 *     [descendant, ancestor]  было ancWon  (last-declared) → стало descWon (доминирование) — ИЗМЕНИЛОСЬ
 *   Ось 2 (wildcard '*' vs явный):
 *     [wildcard, explicit]    было explWon (last-declared) → стало explWon (специфичность) — СОВПАЛО
 *     [explicit, wildcard]    было wildWon (last-declared) → стало explWon (специфичность) — ИЗМЕНИЛОСЬ
 *   Ось 3 (отсутствующий priority vs отрицательный -5):
 *     [absent, negative]      было negWon  (absent=-∞)     → стало absWon (absent=0>-5) — ИЗМЕНИЛОСЬ
 *     [negative, absent]      было negWon  (absent=-∞)     → стало absWon (absent=0>-5) — ИЗМЕНИЛОСЬ
 *   Ось 4 (равная глубина, ≥2 кандидата, без priority):
 *     [dA, dB]                было dB (last-declared)      → стало dA (document order) — ИЗМЕНИЛОСЬ
 *     [dB, dA]                было dA (last-declared)      → стало dB (document order) — ИЗМЕНИЛОСЬ
 *   Ось 5 (равный ЯВНЫЙ priority 10):
 *     [dA, dB]                было dB (last-declared tie)  → стало dA (document order) — ИЗМЕНИЛОСЬ
 *     [dB, dA]                было dA (last-declared tie)  → стало dB (document order) — ИЗМЕНИЛОСЬ
 */
describe('selection migration map — was last-declared-wins → now SCXML (SPEC §4)', () => {
  const base = { name: 'SelChar', stateAttribute: 'state' as const }

  /** Собирает машину, шлёт `ev` один раз, возвращает достигнутое состояние = победитель. */
  async function winnerOf(config: any): Promise<string | undefined> {
    const sm = createMachine(config, {} as any)
    await sm.fireEvent('ev')
    return sm.getCurrentState()
  }

  // ── Ось 1: предок vs потомок на ОДНОМ событии, ОБА порядка объявления ──
  // current = parent.r.leaf; кандидаты `from:'parent'` (предок) и
  // `from:'parent.r.leaf'` (потомок) ОБА проходят isTransitionPossible.
  // БЫЛО: last-declared-wins (глубина игнорировалась).
  // СТАЛО (SPEC §4.3): доминирование потомка — наиболее вложенный источник
  // побеждает в ОБОИХ порядках.
  describe('axis 1 — descendant dominates ancestor (was last-declared)', () => {
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

    it('[ancestor, descendant]: было descWon (last-declared) → стало descWon (dominance, СОВПАЛО)', async () => {
      expect(
        await winnerOf(
          mk([
            { from: 'parent', to: 'ancWon' },
            { from: 'parent.r.leaf', to: 'descWon' },
          ]),
        ),
      ).toBe('descWon')
    })

    it('[descendant, ancestor]: было ancWon (last-declared) → стало descWon (dominance, ИЗМЕНИЛОСЬ)', async () => {
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

  // ── Ось 2: wildcard from:'*' vs явный from, ОБА порядка ──
  // БЫЛО: last-declared-wins; wildcard НЕ понижен в приоритете.
  // СТАЛО (SPEC §4.2): явный источник (специфичность 0) бьёт '*' (класс 2)
  // ВСЕГДА, независимо от порядка объявления.
  describe('axis 2 — explicit source beats wildcard (was last-declared)', () => {
    const states = { s0: {}, wildWon: {}, explWon: {} }
    const mk = (transitions: any[]) => ({
      ...base,
      initialState: 's0',
      states,
      events: { ev: { transitions } },
    })

    it('[wildcard, explicit]: было explWon (last-declared) → стало explWon (specificity, СОВПАЛО)', async () => {
      expect(
        await winnerOf(
          mk([
            { from: '*', to: 'wildWon' },
            { from: 's0', to: 'explWon' },
          ]),
        ),
      ).toBe('explWon')
    })

    it('[explicit, wildcard]: было wildWon (last-declared) → стало explWon (specificity, ИЗМЕНИЛОСЬ)', async () => {
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

  // ── Ось 3: отсутствующий priority vs отрицательный (-5) ──
  // БЫЛО: отсутствующий priority = -Infinity, поэтому ЯВНЫЙ -5 бил отсутствующий
  // в обоих порядках (F9).
  // СТАЛО (SPEC §4.1): отсутствующий priority = 0; 0 > -5, поэтому absWon
  // побеждает в ОБОИХ порядках (отрицательный теперь НИЖЕ неуказанного).
  describe('axis 3 — absent priority (=0) beats negative (was absent=-Infinity, F9)', () => {
    const states = { s0: {}, absWon: {}, negWon: {} }
    const mk = (transitions: any[]) => ({
      ...base,
      initialState: 's0',
      states,
      events: { ev: { transitions } },
    })

    it('[absent, negative]: было negWon (absent=-∞) → стало absWon (absent=0>-5, ИЗМЕНИЛОСЬ)', async () => {
      expect(
        await winnerOf(
          mk([
            { from: 's0', to: 'absWon' },
            { from: 's0', to: 'negWon', priority: -5 },
          ]),
        ),
      ).toBe('absWon')
    })

    it('[negative, absent]: было negWon (absent=-∞) → стало absWon (absent=0>-5, ИЗМЕНИЛОСЬ)', async () => {
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

  // ── Ось 4: равная глубина, ≥2 кандидата, без priority ──
  // БЫЛО: чистый last-declared-wins — победитель = ПОСЛЕДНИЙ объявленный.
  // СТАЛО (SPEC §4.4): при точном равенстве (priority, специфичность,
  // несравнимо по доминированию) побеждает ПЕРВЫЙ объявленный (document order).
  describe('axis 4 — equal depth resolves by document order (was last-declared)', () => {
    const states = { s0: {}, dA: {}, dB: {} }
    const mk = (transitions: any[]) => ({
      ...base,
      initialState: 's0',
      states,
      events: { ev: { transitions } },
    })

    it('[dA, dB]: было dB (last-declared) → стало dA (document order, ИЗМЕНИЛОСЬ)', async () => {
      expect(
        await winnerOf(
          mk([
            { from: 's0', to: 'dA' },
            { from: 's0', to: 'dB' },
          ]),
        ),
      ).toBe('dA')
    })

    it('[dB, dA]: было dA (last-declared) → стало dB (document order, ИЗМЕНИЛОСЬ)', async () => {
      expect(
        await winnerOf(
          mk([
            { from: 's0', to: 'dB' },
            { from: 's0', to: 'dA' },
          ]),
        ),
      ).toBe('dB')
    })
  })

  // ── Ось 5: равный ЯВНЫЙ priority 10 ──
  // БЫЛО: равенство priority → tie-break = last-declared-wins.
  // СТАЛО (SPEC §4.4): равный priority + равная специфичность + несравнимо по
  // доминированию → document order (первый объявленный).
  describe('axis 5 — equal explicit priority resolves by document order (was last-declared)', () => {
    const states = { s0: {}, dA: {}, dB: {} }
    const mk = (transitions: any[]) => ({
      ...base,
      initialState: 's0',
      states,
      events: { ev: { transitions } },
    })

    it('[dA, dB] both priority 10: было dB (last-declared tie) → стало dA (document order, ИЗМЕНИЛОСЬ)', async () => {
      expect(
        await winnerOf(
          mk([
            { from: 's0', to: 'dA', priority: 10 },
            { from: 's0', to: 'dB', priority: 10 },
          ]),
        ),
      ).toBe('dA')
    })

    it('[dB, dA] both priority 10: было dA (last-declared tie) → стало dB (document order, ИЗМЕНИЛОСЬ)', async () => {
      expect(
        await winnerOf(
          mk([
            { from: 's0', to: 'dB', priority: 10 },
            { from: 's0', to: 'dA', priority: 10 },
          ]),
        ),
      ).toBe('dB')
    })
  })
})
