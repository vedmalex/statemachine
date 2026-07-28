import { describe, expect, it } from 'vitest'
import { createMachine } from '/Users/vedmalex/work/statemachine/packages/statemachine/src/index'

/**
 * ФИКСИРУЕТ ТЕКУЩЕЕ (НЕВЕРНОЕ) поведение селекции переходов:
 * getAllowedTransitions выбирает по правилу last-declared-wins
 * (при равном/отсутствующем priority побеждает ПОСЛЕДНИЙ объявленный
 * кандидат в event.transitions — источник порядка = порядок массива).
 *
 * Это ХАРАКТЕРИЗАЦИЯ, не целевое поведение: каждый ассерт — фактический
 * победитель СЕЙЧАС (запущено, посмотрено, зафиксировано). Юнит C2 —
 * единственный ДАТЧИК чувствительности к селекции для W2: у остальной
 * суиты нулевая чувствительность (полная замена правила селекции даёт
 * побайтово тот же прогон), поэтому тихий сдвиг источника порядка в W2
 * (компилятор меняет источник порядка переходов) ловится ТОЛЬКО здесь.
 *
 * В W3 каждый тест переписывается в ПАРНЫЙ целевой SCXML-ассерт
 * (SCXML/UML: побеждает наиболее вложенный/специфичный источник и
 * приоритет по порядку документа, а не last-declared). ДЕЛЬТА между
 * текущим ассертом и целевым = готовый СКЕЛЕТ migration-note.
 *
 * Все тесты ЗЕЛЁНЫЕ — фиксируют движок КАК ЕСТЬ, ничего не чинят.
 * (owner передаётся как `{} as any` — движок сам ставит initialState.)
 */
describe('selection characterization — CURRENT last-declared-wins rule (W2 sensor)', () => {
  const base = { name: 'SelChar', stateAttribute: 'state' as const }

  /** Собирает машину, шлёт `ev` один раз, возвращает достигнутое состояние = победитель. */
  async function winnerOf(config: any): Promise<string | undefined> {
    const sm = createMachine(config, {} as any)
    await sm.fireEvent('ev')
    return sm.getCurrentState()
  }

  // ── Ось 1: предок vs потомок на ОДНОМ событии, ОБА порядка объявления ──
  // current = parent.r.leaf; кандидаты `from:'parent'` (предок, ancestor-scan)
  // и `from:'parent.r.leaf'` (потомок, точный) ОБА проходят isTransitionPossible.
  // ТЕКУЩЕЕ: побеждает ПОСЛЕДНИЙ объявленный, глубина НЕ учитывается.
  // W3-ЦЕЛЬ (SCXML): потомок (наиболее вложенный источник) должен побеждать
  // в ОБОИХ порядках → migration-note дельта именно здесь.
  describe('axis 1 — ancestor vs descendant, both declaration orders', () => {
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

    it('order [ancestor, descendant] → descendant wins (last declared)', async () => {
      expect(
        await winnerOf(
          mk([
            { from: 'parent', to: 'ancWon' },
            { from: 'parent.r.leaf', to: 'descWon' },
          ]),
        ),
      ).toBe('descWon')
    })

    it('order [descendant, ancestor] → ancestor wins (last declared; NOT deepest)', async () => {
      // W3-ЦЕЛЬ: должно остаться 'descWon' (потомок), а СЕЙЧАС 'ancWon'.
      expect(
        await winnerOf(
          mk([
            { from: 'parent.r.leaf', to: 'descWon' },
            { from: 'parent', to: 'ancWon' },
          ]),
        ),
      ).toBe('ancWon')
    })
  })

  // ── Ось 2: wildcard from:'*' vs явный from, ОБА порядка ──
  // Оба кандидата на одном событии проходят isTransitionPossible
  // (wildcard всегда true; явный совпадает с current). Приоритет отсутствует.
  // ТЕКУЩЕЕ: last-declared-wins; wildcard НЕ понижен в приоритете.
  // W3-ЦЕЛЬ (SCXML): явный источник специфичнее wildcard → явный в ОБА порядка.
  describe('axis 2 — wildcard from:* vs explicit from, both declaration orders', () => {
    const states = { s0: {}, wildWon: {}, explWon: {} }
    const mk = (transitions: any[]) => ({
      ...base,
      initialState: 's0',
      states,
      events: { ev: { transitions } },
    })

    it('order [wildcard, explicit] → explicit wins (last declared)', async () => {
      expect(
        await winnerOf(
          mk([
            { from: '*', to: 'wildWon' },
            { from: 's0', to: 'explWon' },
          ]),
        ),
      ).toBe('explWon')
    })

    it('order [explicit, wildcard] → wildcard wins (last declared; NOT least-specific-loses)', async () => {
      // W3-ЦЕЛЬ: должно остаться 'explWon' (явный специфичнее), а СЕЙЧАС 'wildWon'.
      expect(
        await winnerOf(
          mk([
            { from: 's0', to: 'explWon' },
            { from: '*', to: 'wildWon' },
          ]),
        ),
      ).toBe('wildWon')
    })
  })

  // ── Ось 3: отсутствующий priority vs отрицательный ──
  // Отсутствующий priority трактуется как Number.NEGATIVE_INFINITY (самый низкий),
  // поэтому ЯВНЫЙ отрицательный (-5) ВСЕГДА бьёт отсутствующий — приоритет
  // доминирует над порядком, победитель ОДИН И ТОТ ЖЕ в обоих порядках.
  // (Осевой контраст с осями 4/5: там priority равен → включается last-declared.)
  describe('axis 3 — absent priority vs negative priority', () => {
    const states = { s0: {}, absWon: {}, negWon: {} }
    const mk = (transitions: any[]) => ({
      ...base,
      initialState: 's0',
      states,
      events: { ev: { transitions } },
    })

    it('order [absent, negative] → negative wins (absent === -Infinity)', async () => {
      expect(
        await winnerOf(
          mk([
            { from: 's0', to: 'absWon' },
            { from: 's0', to: 'negWon', priority: -5 },
          ]),
        ),
      ).toBe('negWon')
    })

    it('order [negative, absent] → negative STILL wins (priority dominates order)', async () => {
      expect(
        await winnerOf(
          mk([
            { from: 's0', to: 'negWon', priority: -5 },
            { from: 's0', to: 'absWon' },
          ]),
        ),
      ).toBe('negWon')
    })
  })

  // ── Ось 4: равная глубина, ≥2 кандидата ──
  // Два перехода из одного источника s0 (равная глубина), без priority.
  // ТЕКЁ: чистый last-declared-wins — победитель = ПОСЛЕДНИЙ объявленный,
  // а не имя цели (реверс порядка меняет победителя).
  describe('axis 4 — equal depth, >=2 candidates', () => {
    const states = { s0: {}, dA: {}, dB: {} }
    const mk = (transitions: any[]) => ({
      ...base,
      initialState: 's0',
      states,
      events: { ev: { transitions } },
    })

    it('order [dA, dB] → dB wins (last declared)', async () => {
      expect(
        await winnerOf(
          mk([
            { from: 's0', to: 'dA' },
            { from: 's0', to: 'dB' },
          ]),
        ),
      ).toBe('dB')
    })

    it('order [dB, dA] → dA wins (last declared; order, not target name)', async () => {
      expect(
        await winnerOf(
          mk([
            { from: 's0', to: 'dB' },
            { from: 's0', to: 'dA' },
          ]),
        ),
      ).toBe('dA')
    })
  })

  // ── Ось 5: равный ЯВНЫЙ priority ──
  // Два перехода из s0 с ОДИНАКОВЫМ явным priority:10. Равенство (не '<')
  // → включается tie-break = last-declared-wins.
  describe('axis 5 — equal explicit priority', () => {
    const states = { s0: {}, dA: {}, dB: {} }
    const mk = (transitions: any[]) => ({
      ...base,
      initialState: 's0',
      states,
      events: { ev: { transitions } },
    })

    it('order [dA, dB] both priority 10 → dB wins (last declared on tie)', async () => {
      expect(
        await winnerOf(
          mk([
            { from: 's0', to: 'dA', priority: 10 },
            { from: 's0', to: 'dB', priority: 10 },
          ]),
        ),
      ).toBe('dB')
    })

    it('order [dB, dA] both priority 10 → dA wins (last declared on tie)', async () => {
      expect(
        await winnerOf(
          mk([
            { from: 's0', to: 'dB', priority: 10 },
            { from: 's0', to: 'dA', priority: 10 },
          ]),
        ),
      ).toBe('dA')
    })
  })
})
