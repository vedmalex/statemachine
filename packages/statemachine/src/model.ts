/**
 * W2a — единый компилятор конфига (SPEC §1, дефект-корень F10/V3).
 *
 * Сегодня «валидный путь» / порядок активной конфигурации выводятся из порядка
 * ВСТАВКИ в `Map` (updateState / addRegionStates / getInitialStatesForRegions)
 * и из `split('.').length`. Порядок вставки задаётся ПУТЁМ активации, а не
 * позицией узла в документе — отсюда недетерминизм серийного `|`-порядка
 * (признано в state_machine.ts, комментарий checkCompletion ~2118-2122).
 *
 * Этот модуль компилирует конфиг ОДИН раз (в конструкторе StateMachine) в
 * НОРМАЛИЗОВАННУЮ модель — единый источник ДЕТЕРМИНИРОВАННОГО `documentIndex`
 * и `depth`. `documentIndex` — чистая функция от ПОЗИЦИИ узла в документе
 * (pre-order обход по `Object.keys`), НЕ от порядка вставки в Map при
 * активации/переходах: тот же конфиг → тот же порядок в любом прогоне/процессе.
 *
 * ГРАНИЦЫ W2a (осознанно): модель ВВОДИТСЯ и на неё переводится ПОРЯДОК/DEPTH
 * активной конфигурации. Правило селекции победителя перехода НЕ меняется (W3),
 * валидатор на модель НЕ переводится (W2b), OTS — W3. Строковое представление
 * (`'a.r.x|b.q.y'`) остаётся на границе персистенции/API; модель — внутренняя.
 */

/** Вид узла нормализованной модели. */
export type ModelNodeKind = 'leaf' | 'composite' | 'region'

/**
 * Узел нормализованной модели конфига.
 *
 * Регион — САМОСТОЯТЕЛЬНЫЙ узел (`kind:'region'`, `id = <композит>.<имя региона>`),
 * что снимает неразличимость «лист a.b» vs «регион-контейнер a.b» (следствие
 * `getRegionKey`, которое одинаково укорачивает и то и другое).
 */
export interface ModelNode {
  /** Полный точечный путь узла (`p`, `p.a`, `p.a.a1`). */
  id: string
  /** Лист (атомарное состояние), композит (есть регионы) или регион-контейнер. */
  kind: ModelNodeKind
  /** id родителя (регион для состояния региона; композит для региона; null для корня). */
  parent: string | null
  /**
   * Глубина вложенности: корневые состояния — 0, их регионы — 1, состояния
   * этих регионов — 2, и т.д. НЕ `split('.').length`: считает уровни
   * композит/регион, а не сегменты строки.
   */
  depth: number
  /**
   * Детерминированный индекс pre-order обхода документа (присваивается «на входе
   * в узел»). Единственный источник КАНОНИЧЕСКОГО порядка активной конфигурации.
   */
  documentIndex: number
  /** SCXML/UML `<final>`-маркер атомарного листа (для композита — всегда false). */
  isFinal: boolean
  /** id прямых потомков в порядке документа (регионы у композита, состояния у региона). */
  children: string[]
}

/** Скомпилированная нормализованная модель конфига (внутренний API). */
export interface CompiledModel {
  /** Все узлы по id. */
  nodes: Map<string, ModelNode>
  /** id всех узлов в порядке `documentIndex` (pre-order). */
  order: string[]
  /**
   * `documentIndex` узла по id, или `undefined` если узел не зарегистрирован
   * (напр. wildcard/root-псевдосостояние, не присутствующее в дереве states).
   */
  documentIndexOf(id: string): number | undefined
  /** `depth` узла по id, или `undefined` если узел не зарегистрирован. */
  depthOf(id: string): number | undefined
}

/**
 * Форма states-конфига, которую компилятор обходит. Совместима со
 * `States<T>` / `RegionsConfig<T>` из types.ts, но взята структурно, чтобы
 * компилятор не тянул generic-параметр владельца.
 */
type StatesConfigLike = Record<string, StateConfigLike | undefined>
interface StateConfigLike {
  regions?: Record<string, StatesConfigLike | undefined>
  final?: boolean
  [key: string]: unknown
}

/**
 * Скомпилировать states-конфиг в нормализованную модель.
 *
 * Обход pre-order по `Object.keys`, РЕКУРСИВНО: состояния → их регионы →
 * состояния регионов. `documentIndex` присваивается «на входе в узел» (до
 * обхода потомков) — ровно тот порядок, в котором узлы объявлены в документе.
 * Ключ `'initial'` на любом states-уровне ПРОПУСКАЕТСЯ (он — указатель
 * начального под-состояния региона, а не состояние; паритет с
 * `processStates`, которое так же его пропускает).
 */
export function compileModel(statesConfig: StatesConfigLike): CompiledModel {
  const nodes = new Map<string, ModelNode>()
  const order: string[] = []
  let nextIndex = 0

  const walkStates = (
    states: StatesConfigLike,
    parentId: string | null,
    depth: number,
  ): void => {
    for (const [name, value] of Object.entries(states)) {
      // Паритет с processStates: 'initial' — не состояние, а указатель.
      if (name === 'initial') continue

      const id = parentId ? `${parentId}.${name}` : name
      const regions = value?.regions
      const hasRegions = !!regions && Object.keys(regions).length > 0

      const node: ModelNode = {
        id,
        kind: hasRegions ? 'composite' : 'leaf',
        parent: parentId,
        depth,
        documentIndex: nextIndex++,
        isFinal: Boolean(value?.final),
        children: [],
      }
      nodes.set(id, node)
      order.push(id)
      if (parentId) nodes.get(parentId)?.children.push(id)

      if (hasRegions) {
        walkRegions(regions!, id, depth + 1)
      }
    }
  }

  const walkRegions = (
    regions: Record<string, StatesConfigLike | undefined>,
    compositeId: string,
    depth: number,
  ): void => {
    for (const [regionName, regionStates] of Object.entries(regions)) {
      const regionId = `${compositeId}.${regionName}`
      const node: ModelNode = {
        id: regionId,
        kind: 'region',
        parent: compositeId,
        depth,
        documentIndex: nextIndex++,
        isFinal: false,
        children: [],
      }
      nodes.set(regionId, node)
      order.push(regionId)
      nodes.get(compositeId)?.children.push(regionId)

      if (regionStates) {
        walkStates(regionStates, regionId, depth + 1)
      }
    }
  }

  walkStates(statesConfig, null, 0)

  return {
    nodes,
    order,
    documentIndexOf: (id) => nodes.get(id)?.documentIndex,
    depthOf: (id) => nodes.get(id)?.depth,
  }
}
