import { describe, expect, it } from 'vitest'
import { createMachine } from '../index'

/**
 * RED / baseline target for W2a (единый компилятор конфига, SPEC §1).
 *
 * ЦЕЛЬ МОДЕЛИ (src/model.ts): documentIndex + порядок активной конфигурации
 * ДЕТЕРМИНИРОВАНЫ и КАНОНИЧНЫ — производная от ПОЗИЦИИ узла в документе
 * (Object.keys-обход при компиляции), НЕ от порядка вставки в Map при
 * активации/переходах.
 *
 * СЕГОДНЯ (HEAD) серийный |-порядок активной конфигурации строится из
 * `Array.from(currentStateMap.values()).join('|')` (updateState) — то есть из
 * ПОРЯДКА ВСТАВКИ в Map. Порядок вставки задаётся ПУТЁМ активации (какой
 * регион был перезаписан последним), а НЕ позицией в документе. Признано в
 * state_machine.ts (комментарий checkCompletion ~2118-2122: «the `|`-leaf
 * order is map-insertion dependent»).
 *
 * Этот файл — целевой для модели:
 *  - Часть A (determinism guard): ОДИН и тот же конфиг, две независимые сборки
 *    → идентичный порядок. Должно быть ЗЕЛЁНО на HEAD и ОСТАТЬСЯ зелёным
 *    (модель не должна вносить недетерминизм между сборками/процессами).
 *  - Часть B (target, RED на HEAD): ОДНА и та же семантическая параллельная
 *    конфигурация, достигнутая ДВУМЯ путями активации → СЕЙЧАС даёт РАЗНЫЙ
 *    |-порядок (map-insertion). Модель (documentIndex-упорядочивание активной
 *    конфигурации) обязана сделать порядок КАНОНИЧНЫМ → тест позеленеет.
 *  - Часть C (documenting): два семантически-эквивалентных конфига с
 *    переставленным порядком ключей регионов → СЕЙЧАС разный серийный порядок;
 *    документирует связку «порядок объявления/вставки → серийный |-порядок».
 *
 * НЕ характеризация селекции: selection_characterization.test.ts остаётся
 * единственным датчиком ПРАВИЛА выбора победителя; здесь — про ИСТОЧНИК
 * ПОРЯДКА (documentIndex vs map-insertion), который W2a переносит на модель.
 */
describe('model determinism — documentIndex/active-config order (W2a target)', () => {
  const base = { name: 'ModelDet', stateAttribute: 'state' as const }

  // Композит p с двумя ПАРАЛЛЕЛЬНЫМИ регионами a,b (семантически неупорядочены)
  // + сиблинг-лист s для выхода/повторного входа в композит.
  const mkConfig = (regionOrder: 'ab' | 'ba') => {
    const regions =
      regionOrder === 'ab'
        ? {
            a: { a1: {}, a2: {} },
            b: { b1: {}, b2: {} },
          }
        : {
            b: { b1: {}, b2: {} },
            a: { a1: {}, a2: {} },
          }
    return {
      ...base,
      initialState: 'p',
      states: {
        p: { regions, initial: 'a.a1|b.b1' },
        s: {},
      },
      events: {
        // выйти из композита в сиблинг
        toS: { transitions: [{ from: 'p.a.a1', to: 's' }] },
        // повторно войти в композит, ЯВНО перечислив регионы b→a (reversed)
        toPreversed: { transitions: [{ from: 's', to: 'p.b.b1|p.a.a1' }] },
      },
    }
  }

  // ── Часть A — determinism guard (ожидаемо ЗЕЛЁНО на HEAD, обязано остаться) ──
  it('A: same config, two independent builds → identical initial active-config order', () => {
    const sm1 = createMachine(mkConfig('ab'), {} as any)
    const sm2 = createMachine(mkConfig('ab'), {} as any)
    const order1 = sm1.getCurrentState()
    const order2 = sm2.getCurrentState()
    // Один и тот же конфиг → один и тот же серийный порядок в разных сборках.
    expect(order1).toBe(order2)
    // И это конкретно каноничный document-order 'a' перед 'b'.
    expect(order1).toBe('p.a.a1|p.b.b1')
  })

  // ── Часть B — TARGET: та же семантическая конфигурация, два пути активации ──
  // На HEAD КРАСНЕЕТ: путь A даёт 'p.a.a1|p.b.b1', путь B — 'p.b.b1|p.a.a1'.
  // Модель (активная конфигурация упорядочена по documentIndex) обязана
  // сделать оба пути каноничными → одинаковый серийный порядок.
  it('B: identical semantic parallel config reached via two activation paths → SAME serialized order (canonical documentIndex)', async () => {
    // Путь A: начальный вход.
    const smA = createMachine(mkConfig('ab'), {} as any)
    const pathA = smA.getCurrentState()

    // Путь B: та же машина, выйти в s и вернуться, перечислив регионы b→a.
    const smB = createMachine(mkConfig('ab'), {} as any)
    await smB.fireEvent('toS')
    await smB.fireEvent('toPreversed')
    const pathB = smB.getCurrentState()

    // Обе конфигурации имеют ОДИН И ТОТ ЖЕ набор активных листов.
    expect(new Set((pathA ?? '').split('|'))).toEqual(
      new Set((pathB ?? '').split('|')),
    )

    // ЦЕЛЬ: серийный порядок КАНОНИЧЕН (documentIndex), не зависит от пути.
    // На HEAD это FALSE (map-insertion): pathA='p.a.a1|p.b.b1',
    // pathB='p.b.b1|p.a.a1' — тест КРАСНЫЙ, демонстрирует дефект.
    expect(pathB).toBe(pathA)
  })

  // ── Часть C — documenting: перестановка порядка ключей регионов ──
  // Демонстрирует, что серийный |-порядок СЕЙЧАС = чистая функция от порядка
  // объявления/вставки (Object.keys(regions)), а не канонический инвариант.
  it('C: swapping region-key declaration order changes serialized |-order (map/insertion coupling)', () => {
    const smAB = createMachine(mkConfig('ab'), {} as any)
    const smBA = createMachine(mkConfig('ba'), {} as any)

    const orderAB = smAB.getCurrentState()
    const orderBA = smBA.getCurrentState()

    // Один и тот же набор активных листов (семантически идентичны).
    expect(new Set((orderAB ?? '').split('|'))).toEqual(
      new Set((orderBA ?? '').split('|')),
    )

    // СЕЙЧАС серийный порядок РАЗНЫЙ — задокументированная связка
    // «порядок объявления → серийный порядок» (map-insertion зависимость).
    expect(orderAB).toBe('p.a.a1|p.b.b1')
    expect(orderBA).toBe('p.b.b1|p.a.a1')
    expect(orderBA).not.toBe(orderAB)
  })
})
