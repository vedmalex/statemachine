/**
 * Configuration validation module for StateMachine library
 * Validates StateMachine configurations to prevent runtime errors.
 *
 * W2b (SPEC §1а/§1б, defects F10 / П11): the validator CONSUMES the normalized
 * model (`compileModel`, src/model.ts) instead of re-parsing dotted paths with a
 * third ad-hoc "valid path" implementation. Every path / initial / reachability /
 * region question is answered against the SAME model the runtime uses, so a config
 * the runtime accepts is never spuriously rejected (F10/V1/V2/V4/V11/V12), and the
 * genuinely-broken configs the runtime throws on are caught up front.
 */

import { type CompiledModel, compileModel, type ModelNode } from './model'
import { stateMachineLogger } from './logger'
import type { Event, Events, State, StateMachineConfig, States } from './types'

// Validation result types
export interface ValidationResult {
  isValid: boolean
  errors: ValidationError[]
  warnings: ValidationWarning[]
  /**
   * Advisory INFO-level notes (severity `'info'`). Never affect `isValid` and are
   * never promoted by strict mode — purely advisory selection/migration hints
   * (e.g. WILDCARD_SHADOWED). Additive surface (TASK W2b).
   */
  infos: ValidationInfo[]
}

export interface ValidationError {
  code: string
  message: string
  severity: 'error' | 'warning' | 'info'
  path: string
  details?: Record<string, any>
  suggestion?: string // Текстовая подсказка "Как исправить"
  documentationUrl?: string // Ссылка на раздел документации
}

export interface ValidationWarning extends ValidationError {
  severity: 'warning'
}

export interface ValidationInfo extends ValidationError {
  severity: 'info'
}

// Custom-rule extension surface
interface ValidationContext {
  addError(
    code: string,
    message: string,
    path: string,
    suggestion?: string,
  ): void
  addWarning(
    code: string,
    message: string,
    path: string,
    suggestion?: string,
  ): void
}

type CustomRule<T extends object = any> = {
  id: string
  validate: (config: StateMachineConfig<T>, context: ValidationContext) => void
}

// Validation rules configuration
export interface ValidationConfig {
  strictMode: boolean
  allowEmptyStates: boolean
  allowEmptyEvents: boolean
  maxStateDepth: number
  maxStatesCount: number
  maxEventsCount: number
  requireInitialState: boolean
  validateTransitionPaths: boolean
  validateActionReferences: boolean
  customRules?: CustomRule[]
}

export const DEFAULT_VALIDATION_CONFIG: ValidationConfig = {
  strictMode: false,
  allowEmptyStates: false,
  allowEmptyEvents: false,
  maxStateDepth: 10,
  maxStatesCount: 1000,
  maxEventsCount: 1000,
  requireInitialState: true,
  validateTransitionPaths: true,
  validateActionReferences: false,
}

/**
 * Error codes that make a machine genuinely UNBUILDABLE — a broken transition
 * path the runtime cannot honor at all. Per SPEC §1а (V6) these THROW at machine
 * construction rather than logging "validation failed" and building a broken
 * machine.
 *
 * Scope note: the OTHER model errors (REGION_STARTS_FINAL, REGION_NO_PATH_TO_FINAL,
 * UNSATISFIABLE_FROM, DUPLICATE_REGION_NAME) are still reported as validateConfig
 * ERRORS (isValid:false, promoted by strict mode, surfaced programmatically) but
 * do NOT throw at construction, because the runtime DELIBERATELY supports those
 * degenerate configurations — a composite with a single `final` leaf that joins
 * immediately (D12 all-final initial config; the run-away / finite-cascade
 * suites), a region that never completes (negative all-final join tests), and the
 * flattened toJSON/fromJSON round-trip form. Throwing on them would delete tested
 * runtime behavior. Broken PATHS have no such legitimate runtime use, so they
 * alone are fatal.
 */
export const MODEL_ERROR_CODES: ReadonlySet<string> = new Set(['INVALID_STATE_PATH'])

// Configuration validator class
export class ConfigValidator {
  private config: ValidationConfig
  private errors: ValidationError[] = []
  private warnings: ValidationWarning[] = []
  private infos: ValidationInfo[] = []

  // ── model index (built once per validate()) ────────────────────────────────
  private model: CompiledModel | null = null
  /** Non-region node id → its raw config (for `initial`/`invoke` payloads). */
  private stateCfgById = new Map<string, any>()
  /** Region node id → its raw region-states config. */
  private regionCfgById = new Map<string, any>()
  /** id → {state,region} mint counts (collision detection). */
  private idCounts = new Map<string, { state: number; region: number }>()
  private reachableSet = new Set<string>()
  private enterMemo = new Set<string>()

  constructor(config: Partial<ValidationConfig> = {}) {
    this.config = { ...DEFAULT_VALIDATION_CONFIG, ...config }
  }

  /**
   * Validates a complete StateMachine configuration
   */
  validate<T extends object>(
    smConfig: StateMachineConfig<T>,
  ): ValidationResult {
    this.errors = []
    this.warnings = []
    this.infos = []
    this.model = null
    this.stateCfgById.clear()
    this.regionCfgById.clear()
    this.idCounts.clear()
    this.reachableSet.clear()
    this.enterMemo.clear()

    try {
      // Basic structure validation
      this.validateBasicStructure(smConfig)

      // Build the normalized model ONCE (only when states is a usable object).
      const statesOk =
        smConfig.states && typeof smConfig.states === 'object'
      if (statesOk) {
        this.buildModelIndex(smConfig.states as States<T>)
      }

      // States validation (structural: names, regions shape, history, invoke)
      if (smConfig.states && typeof smConfig.states === 'object') {
        this.validateStates(smConfig.states, 'states')
      }

      // Events validation (transition path validity via model)
      if (
        smConfig.events &&
        typeof smConfig.events === 'object' &&
        this.model
      ) {
        this.validateEvents(smConfig.events, smConfig.states, 'events')
      }

      // Initial state validation (top-level root + composite/region pointers)
      this.validateInitialState(smConfig)
      if (this.model) this.validateInitialPointers()

      // Cross-references: reachability + unused events (MODEL-based)
      if (this.model) {
        this.buildReachable(smConfig)
        this.validateCrossReferences(smConfig)
      }

      // Performance validation
      this.validatePerformanceConstraints(smConfig)

      // SCXML/UML final-state + done.state join validation
      this.validateFinalStates(smConfig)

      // Model-structural correctness (§1а): collisions, region-starts-final,
      // region-no-path-to-final, unsatisfiable composite `from`, dead ends.
      if (this.model) {
        this.validateModelStructure(smConfig)
        this.validateSelectionWarnings(smConfig)
      }

      // Custom rules
      this.runCustomRules(smConfig)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.addError(
        'VALIDATION_FAILED',
        `Validation process failed: ${msg}`,
        'validation',
      )
    }

    // V10 (SPEC §1а): strict mode PROMOTES advisory warnings to errors so that
    // validateConfigStrict actually fails (docs previously lied — it did not).
    // INFO notes stay advisory and are never promoted.
    if (this.config.strictMode && this.warnings.length > 0) {
      for (const w of this.warnings) {
        this.errors.push({ ...w, severity: 'error' })
      }
      this.warnings = []
    }

    const result: ValidationResult = {
      isValid: this.errors.length === 0,
      errors: this.errors,
      warnings: this.warnings,
      infos: this.infos,
    }

    if (!result.isValid) {
      stateMachineLogger.error('StateMachine configuration validation failed', {
        errorCount: this.errors.length,
        warningCount: this.warnings.length,
        configName: smConfig.name,
      })
    } else if (this.warnings.length > 0) {
      stateMachineLogger.warn('StateMachine configuration has warnings', {
        warningCount: this.warnings.length,
        configName: smConfig.name,
      })
    }

    return result
  }

  // ── model index construction ────────────────────────────────────────────────

  /**
   * Compile the config into the normalized model and build the auxiliary maps
   * the validator needs (config-by-id, region-config-by-id) plus a mint-count map
   * for collision detection. The compiled model is the SINGLE source of truth for
   * node kind / depth / parent / children / documentIndex / isFinal.
   */
  private buildModelIndex(states: States<any>): void {
    this.model = compileModel(states as any)

    const bump = (id: string, kind: 'state' | 'region') => {
      let c = this.idCounts.get(id)
      if (!c) {
        c = { state: 0, region: 0 }
        this.idCounts.set(id, c)
      }
      c[kind] += 1
    }

    const walkStates = (st: Record<string, any>, parent: string | null) => {
      if (!st || typeof st !== 'object') return
      for (const [name, value] of Object.entries(st)) {
        if (name === 'initial') continue
        const id = parent ? `${parent}.${name}` : name
        bump(id, 'state')
        this.stateCfgById.set(id, value)
        const regions = value?.regions
        if (regions && typeof regions === 'object') {
          for (const [rn, rs] of Object.entries(regions)) {
            const rid = `${id}.${rn}`
            bump(rid, 'region')
            this.regionCfgById.set(rid, rs)
            walkStates(rs as Record<string, any>, rid)
          }
        }
      }
    }
    walkStates(states as Record<string, any>, null)
  }

  // ── model query helpers ─────────────────────────────────────────────────────

  private nodeOf(id: string): ModelNode | undefined {
    return this.model?.nodes.get(id)
  }

  /** True when `id` names a real, addressable state (leaf or composite) — NOT a region container, NOT missing. */
  private isAddressableState(id: string): boolean {
    const n = this.nodeOf(id)
    return !!n && n.kind !== 'region'
  }

  /**
   * True when `part` is a runtime wildcard: the bare `'*'` (any state), or a
   * suffix wildcard `'<prefix>.*'` (any state under prefix). The runtime matches
   * these dynamically (state_machine.ts isTransitionPossible), so the validator
   * must NOT reject them as nonexistent paths (V2).
   */
  private isWildcardPart(part: string): boolean {
    return part.includes('*')
  }

  /** True when `a` is a proper ancestor of `b` in the model tree. */
  private isAncestor(a: string, b: string): boolean {
    if (a === b) return false
    let cur = this.nodeOf(b)?.parent ?? null
    while (cur) {
      if (cur === a) return true
      cur = this.nodeOf(cur)?.parent ?? null
    }
    return false
  }

  /** Ancestor chain of `id`, ROOT-first, including `id` itself. */
  private ancestorsWithSelf(id: string): string[] {
    const chain: string[] = []
    let cur: string | null = id
    while (cur) {
      chain.push(cur)
      cur = this.nodeOf(cur)?.parent ?? null
    }
    return chain.reverse()
  }

  /**
   * M-4 — lowest common ancestor of `a` and `b` in the model tree, or `null`
   * when they share none (both diverge at the virtual root — different root
   * states / different root composites).
   */
  private lcaOf(a: string, b: string): string | null {
    const ca = this.ancestorsWithSelf(a)
    const cb = new Set(this.ancestorsWithSelf(b))
    let lca: string | null = null
    for (const node of ca) {
      if (cb.has(node)) lca = node
      else break
    }
    return lca
  }

  /**
   * M-4 — whether two DISTINCT model nodes can never be co-active.
   *
   * Mutually exclusive when they diverge inside an XOR context:
   *   - their LCA is a `region` node (one active leaf per region); or
   *   - they are both ROOT states (LCA is the virtual root, and only one root
   *     state is active at a time).
   * They are NOT exclusive when their LCA is a parallel `composite` (its regions
   * run concurrently), nor when one is an ancestor of the other (the ancestor is
   * active whenever the descendant is).
   */
  private mutuallyExclusive(a: string, b: string): boolean {
    if (a === b) return false
    if (this.isAncestor(a, b) || this.isAncestor(b, a)) return false
    const lca = this.lcaOf(a, b)
    if (lca === null) {
      // No shared ancestor: both live under the root XOR. Only flag simple root
      // states (depth 0) — descendants of DIFFERENT root composites are left to
      // the composite-level analysis and stay unflagged here.
      return this.nodeOf(a)?.parent === null && this.nodeOf(b)?.parent === null
    }
    return this.nodeOf(lca)?.kind === 'region'
  }

  /**
   * M-4 — flag a `|`-composite `from`/`to` when any pair of its concrete parts is
   * mutually exclusive. Emits `code` once per offending transition side.
   */
  private checkMutualExclusion(
    value: unknown,
    code: 'UNSATISFIABLE_FROM' | 'UNSATISFIABLE_TO',
    path: string,
    side: 'from' | 'to',
    consequence: string,
  ): void {
    if (typeof value !== 'string' || value.indexOf('|') === -1) return
    if (!this.model) return
    const parts = value
      .split('|')
      .filter((p) => p && !this.isWildcardPart(p) && this.model!.nodes.has(p))
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        if (this.mutuallyExclusive(parts[i]!, parts[j]!)) {
          this.addError(
            code,
            `Composite ${side} "${value}" names two mutually-exclusive states ("${parts[i]}", "${parts[j]}") that can never be co-active — ${consequence}`,
            path,
            undefined,
            `A composite \`${side}\` must name at most one state per XOR region; put states from DIFFERENT parallel regions on each side of '|'.`,
          )
          return
        }
      }
    }
  }

  /** Region entry child id (region.initial || first key), NOT recursively resolved. */
  private resolveRegionInitialChildId(regionId: string): string | undefined {
    const rs = this.regionCfgById.get(regionId)
    if (!rs || typeof rs !== 'object') return undefined
    const keys = Object.keys(rs).filter((k) => k !== 'initial')
    const initKey =
      typeof rs.initial === 'string' && rs.initial ? rs.initial : keys[0]
    if (!initKey) return undefined
    return `${regionId}.${initKey}`
  }

  // ── reachability (model-based) ───────────────────────────────────────────────

  /**
   * Build the over-approximate reachable set. Seeds with the initial
   * configuration (initialState expanded through the model — including region
   * entry leaves, which are NEVER an explicit `to` target and were the F10 source
   * of false UNREACHABLE) and every transition `to` part (each '|' branch), each
   * expanded to the full active configuration it enters.
   */
  private buildReachable<T extends object>(smConfig: StateMachineConfig<T>): void {
    this.reachableSet.clear()
    this.enterMemo.clear()
    if (!this.model) return

    if (smConfig.initialState) {
      this.markConfiguration(String(smConfig.initialState))
    }

    // M-2: a transition's `to` is reachable ONLY once its `from` is reachable.
    // Seeding every `to` unconditionally over-approximated the reachable set and
    // masked a region whose only path to `final` starts on an unreachable island
    // (REGION_NO_PATH_TO_FINAL was never raised). Iterate to a fixpoint: on each
    // pass mark the `to` configuration of every transition whose `from` is now
    // enabled, until the reachable set stops growing.
    const transitions: Array<{ from: string; to: string }> = []
    for (const event of Object.values(smConfig.events ?? {})) {
      if (!event || !Array.isArray(event.transitions)) continue
      for (const t of event.transitions) {
        if (typeof t?.to !== 'string') continue
        transitions.push({ from: typeof t.from === 'string' ? t.from : '', to: t.to })
      }
    }

    let changed = true
    while (changed) {
      changed = false
      const before = this.reachableSet.size
      for (const t of transitions) {
        if (!this.isFromEnabled(t.from)) continue
        for (const part of t.to.split('|')) {
          if (!part || this.isWildcardPart(part)) continue
          if (this.model.nodes.has(part)) this.markConfiguration(part)
        }
      }
      if (this.reachableSet.size !== before) changed = true
    }
  }

  /**
   * M-2 — whether a transition `from` can fire given the current reachable set.
   * A `from` is enabled when it is absent (unconditional), any part is a wildcard
   * (fires from whatever is reachable), or any concrete part is itself reachable
   * (a `from` part is a configuration member: leaf, region, or composite ancestor,
   * all of which `markConfiguration` records).
   */
  private isFromEnabled(from: string): boolean {
    if (!from) return true
    for (const part of from.split('|')) {
      if (!part) continue
      if (this.isWildcardPart(part)) return true
      if (this.reachableSet.has(part)) return true
    }
    return false
  }

  /** Mark the full active configuration that contains `id` (id + ancestors, and all sibling regions of composite ancestors at their initials). */
  private markConfiguration(id: string): void {
    const model = this.model
    if (!model?.nodes.has(id)) return
    let cur: string | null = id
    while (cur) {
      this.reachableSet.add(cur)
      const node: ModelNode | undefined = model.nodes.get(cur)
      if (!node) break
      if (node.kind === 'composite') this.enterAllRegions(cur)
      else if (node.kind === 'region') this.enterRegionInitial(cur)
      cur = node.parent
    }
  }

  private enterAllRegions(compositeId: string): void {
    if (this.enterMemo.has(compositeId)) return
    this.enterMemo.add(compositeId)
    const node = this.model!.nodes.get(compositeId)
    if (!node) return
    for (const child of node.children) {
      // children of a composite are region containers
      this.reachableSet.add(child)
      this.enterRegionInitial(child)
    }
  }

  private enterRegionInitial(regionId: string): void {
    const childId = this.resolveRegionInitialChildId(regionId)
    if (!childId || !this.model!.nodes.has(childId)) return
    this.reachableSet.add(childId)
    const c = this.model!.nodes.get(childId)!
    if (c.kind === 'composite') this.enterAllRegions(childId)
  }

  // ── custom rules ─────────────────────────────────────────────────────────────

  private runCustomRules<T extends object>(
    smConfig: StateMachineConfig<T>,
  ): void {
    if (!this.config.customRules || this.config.customRules.length === 0) return

    const context: ValidationContext = {
      addError: (code, msg, path, sugg) =>
        this.addError(code, msg, path, undefined, sugg),
      addWarning: (code, msg, path, sugg) =>
        this.addWarning(code, msg, path, undefined, sugg),
    }

    for (const rule of this.config.customRules) {
      try {
        rule.validate(smConfig, context)
      } catch (e) {
        this.addError(
          'CUSTOM_RULE_ERROR',
          `Rule ${rule.id} failed: ${e instanceof Error ? e.message : String(e)}`,
          'root',
        )
      }
    }
  }

  private validateBasicStructure<T extends object>(
    smConfig: StateMachineConfig<T>,
  ): void {
    if (!smConfig.name || typeof smConfig.name !== 'string') {
      this.addError('MISSING_NAME', 'StateMachine must have a valid name', 'name')
    }

    if (
      !smConfig.stateAttribute ||
      typeof smConfig.stateAttribute !== 'string'
    ) {
      this.addError(
        'MISSING_STATE_ATTRIBUTE',
        'StateMachine must have a valid stateAttribute',
        'stateAttribute',
      )
    }

    if (!smConfig.states || typeof smConfig.states !== 'object') {
      this.addError(
        'MISSING_STATES',
        'StateMachine must have states configuration',
        'states',
      )
      return
    }

    if (!smConfig.events || typeof smConfig.events !== 'object') {
      this.addError(
        'MISSING_EVENTS',
        'StateMachine must have events configuration',
        'events',
      )
      return
    }

    if (
      !this.config.allowEmptyStates &&
      Object.keys(smConfig.states).length === 0
    ) {
      this.addError(
        'EMPTY_STATES',
        'StateMachine cannot have empty states collection',
        'states',
      )
    }

    if (
      !this.config.allowEmptyEvents &&
      Object.keys(smConfig.events).length === 0
    ) {
      this.addError(
        'EMPTY_EVENTS',
        'StateMachine cannot have empty events collection',
        'events',
      )
    }
  }

  private validateStates<T extends object>(
    states: States<T>,
    basePath: string,
    depth = 0,
  ): void {
    if (depth > this.config.maxStateDepth) {
      this.addError(
        'MAX_DEPTH_EXCEEDED',
        `State nesting depth exceeds maximum of ${this.config.maxStateDepth}`,
        basePath,
      )
      return
    }

    for (const [stateName, stateConfig] of Object.entries(states)) {
      if (stateName === 'initial') continue
      const statePath = `${basePath}.${stateName}`
      this.validateState(stateConfig, statePath, depth)
    }
  }

  private validateState<T extends object>(
    state: Omit<State<T>, 'name'>,
    path: string,
    depth: number,
  ): void {
    if (!path.split('.').pop()) {
      this.addError('INVALID_STATE_NAME', 'State name cannot be empty', path)
    }

    if (state.display && typeof state.display !== 'string') {
      this.addWarning(
        'INVALID_DISPLAY',
        'State display should be a string',
        `${path}.display`,
      )
    }

    // Regions validation (structure only; INVALID_INITIAL_STATE is now handled
    // model-side by validateInitialPointers, not by a naive key-membership check).
    if (state.regions) {
      if (typeof state.regions !== 'object') {
        this.addError(
          'INVALID_REGIONS',
          'State regions must be an object',
          `${path}.regions`,
        )
      } else {
        for (const [regionName, regionStates] of Object.entries(
          state.regions,
        )) {
          if (!regionName) {
            this.addError(
              'EMPTY_REGION_NAME',
              'Region name cannot be empty',
              `${path}.regions`,
            )
            continue
          }

          this.validateStates(
            regionStates,
            `${path}.regions.${regionName}`,
            depth + 1,
          )
        }
      }
    }

    if (state.history && !['deep', 'shallow'].includes(state.history)) {
      this.addError(
        'INVALID_HISTORY',
        'State history must be "deep" or "shallow"',
        `${path}.history`,
      )
    }

    if (state.invoke) {
      if (!Array.isArray(state.invoke)) {
        this.addError(
          'INVALID_INVOKE',
          'State "invoke" must be an array of StateInvocation',
          `${path}.invoke`,
        )
      } else {
        state.invoke.forEach((inv, index) => {
          const invPath = `${path}.invoke[${index}]`
          if (typeof inv.delay !== 'number' || inv.delay < 0) {
            this.addError(
              'INVALID_DELAY',
              'Delay must be a positive number',
              `${invPath}.delay`,
            )
          }
          if (!inv.event || typeof inv.event !== 'string') {
            this.addError(
              'INVALID_EVENT_NAME',
              'Event name must be a string',
              `${invPath}.event`,
            )
          }
          if (inv.cond && typeof inv.cond !== 'function') {
            this.addError(
              'INVALID_COND',
              'Condition must be a function',
              `${invPath}.cond`,
            )
          }
        })
      }
    }
  }

  private validateEvents<T extends object>(
    events: Events<T, States<T>>,
    states: States<T>,
    basePath: string,
  ): void {
    for (const [eventName, eventConfig] of Object.entries(events)) {
      const eventPath = `${basePath}.${eventName}`
      this.validateEvent(eventConfig, eventPath, states)
    }
  }

  private validateEvent<T extends object>(
    event: Omit<Event<T, States<T>>, 'name'>,
    path: string,
    _states: States<T>,
  ): void {
    if (!event.transitions || !Array.isArray(event.transitions)) {
      this.addError(
        'MISSING_TRANSITIONS',
        'Event must have transitions array',
        `${path}.transitions`,
      )
      return
    }

    if (event.transitions.length === 0) {
      this.addWarning(
        'EMPTY_TRANSITIONS',
        'Event has no transitions',
        `${path}.transitions`,
      )
    }

    event.transitions.forEach((transition, index) => {
      this.validateTransition(transition, `${path}.transitions[${index}]`)
    })

    // Priority validation (MIXED_PRIORITIES — retained; PRIORITY_INVERTS_DOMINANCE
    // is added alongside in validateSelectionWarnings per SPEC §1а W3 note).
    const priorities = event.transitions
      .map((t) => t.priority)
      .filter((p) => p !== undefined) as number[]

    if (
      priorities.length > 0 &&
      priorities.length !== event.transitions.length
    ) {
      this.addWarning(
        'MIXED_PRIORITIES',
        'Some transitions have priority while others do not',
        `${path}.transitions`,
      )
    }
  }

  private validateTransition(transition: any, path: string): void {
    if (!transition.from || typeof transition.from !== 'string') {
      this.addError(
        'INVALID_FROM_STATE',
        'Transition must have a valid from state',
        `${path}.from`,
      )
    } else if (this.config.validateTransitionPaths) {
      this.validateStatePath(transition.from, `${path}.from`)
    }

    if (!transition.to || typeof transition.to !== 'string') {
      this.addError(
        'INVALID_TO_STATE',
        'Transition must have a valid to state',
        `${path}.to`,
      )
    } else if (this.config.validateTransitionPaths) {
      this.validateStatePath(transition.to, `${path}.to`)
    }

    if (
      transition.priority !== undefined &&
      typeof transition.priority !== 'number'
    ) {
      this.addError(
        'INVALID_PRIORITY',
        'Transition priority must be a number',
        `${path}.priority`,
      )
    }

    if (transition.from === transition.to) {
      this.addWarning(
        'SELF_TRANSITION',
        'Transition from and to states are the same',
        path,
      )
    }
  }

  /**
   * Validate a `from`/`to` expression against the model. Splits composite `|`
   * targets (V11 — same split reachability/UNUSED use). A `'*'` wildcard is
   * runtime-supported (V2) and always valid. A part that resolves to a REGION
   * CONTAINER is invalid (V4 — the runtime throws on entering a bare region).
   */
  private validateStatePath(expr: string, path: string): void {
    if (!this.model) return
    for (const part of expr.split('|')) {
      if (this.isWildcardPart(part)) continue // '*' or '<prefix>.*' (V2)
      const node = this.model.nodes.get(part)
      if (!node) {
        this.addError(
          'INVALID_STATE_PATH',
          `State path "${part}" does not exist`,
          path,
        )
      } else if (node.kind === 'region') {
        this.addError(
          'INVALID_STATE_PATH',
          `State path "${part}" refers to a region container, not an addressable state`,
          path,
          undefined,
          `Target a concrete leaf/composite inside region "${part}" (e.g. "${part}.<leaf>"), not the region container itself.`,
        )
      }
    }
  }

  private validateInitialState<T extends object>(
    smConfig: StateMachineConfig<T>,
  ): void {
    if (this.config.requireInitialState) {
      if (!smConfig.initialState) {
        this.addError(
          'MISSING_INITIAL_STATE',
          'StateMachine must have an initial state',
          'initialState',
        )
        return
      }

      if (!smConfig.states[smConfig.initialState as string]) {
        this.addError(
          'INVALID_INITIAL_STATE',
          `Initial state "${smConfig.initialState}" does not exist`,
          'initialState',
          undefined,
          `Check the 'states' object. Ensure that '${smConfig.initialState}' is defined as a root state.`,
        )
      }
    }
  }

  /**
   * F10 (SPEC §1а): resolve composite/region `initial` pointers THROUGH THE MODEL,
   * exactly as the runtime does — a region-qualified dotted initial ("a.run"), a
   * parallel composite initial ("a.run|b.run"), and a bare leaf name shared across
   * regions ("child1") all resolve to real nodes and must NOT be rejected. Only a
   * pointer that resolves to no addressable node (a GHOST) is flagged.
   */
  private validateInitialPointers(): void {
    if (!this.model) return
    for (const [id, node] of this.model.nodes) {
      if (node.kind !== 'composite') continue
      const cfg = this.stateCfgById.get(id)

      // composite-level initial (may be `|`-joined / dotted / bare)
      if (cfg && typeof cfg.initial === 'string') {
        for (const part of cfg.initial.split('|')) {
          if (!part) continue
          if (!this.resolveCompositeInitialPart(id, part)) {
            this.addError(
              'INVALID_INITIAL_STATE',
              `Initial state "${part}" of composite "${id}" resolves to no state in any region`,
              `states.${id}.initial`,
              undefined,
              `Point \`initial\` at an existing leaf — a bare leaf name present in every region, or a region-qualified path like "<region>.<leaf>".`,
            )
          }
        }
      }

      // region-level initial (GHOST): region config `initial` must name a real leaf
      for (const regionId of node.children) {
        const rs = this.regionCfgById.get(regionId)
        if (rs && typeof rs.initial === 'string' && rs.initial) {
          const target = `${regionId}.${rs.initial}`
          if (!this.isAddressableState(target)) {
            const regionName = regionId.slice(id.length + 1)
            this.addError(
              'INVALID_INITIAL_STATE',
              `Region initial "${rs.initial}" of region "${regionName}" (composite "${id}") does not exist`,
              `states.${id}.regions.${regionName}.initial`,
              undefined,
              `Set the region's \`initial\` to one of its own leaf keys.`,
            )
          }
        }
      }
    }
  }

  /** True when composite-initial `part` resolves to a real addressable descendant of `compositeId`. */
  private resolveCompositeInitialPart(
    compositeId: string,
    part: string,
  ): boolean {
    // region-qualified / dotted form: `${compositeId}.${part}` (e.g. proc + "a.run")
    if (this.isAddressableState(`${compositeId}.${part}`)) return true
    // bare leaf name present inside some region (e.g. parent + "child1")
    const node = this.model?.nodes.get(compositeId)
    if (!node) return false
    for (const regionId of node.children) {
      if (this.isAddressableState(`${regionId}.${part}`)) return true
    }
    return false
  }

  // ── cross references: reachability + unused events ──────────────────────────

  private validateCrossReferences<T extends object>(
    smConfig: StateMachineConfig<T>,
  ): void {
    if (!this.model) return

    // UNREACHABLE_STATE — model reachability. Region containers are structural
    // (never reported); `final` leaves are entered via region expansion and are
    // treated as reachable (never spuriously flagged).
    for (const id of this.model.order) {
      const node = this.model.nodes.get(id)!
      if (node.kind === 'region') continue
      if (node.isFinal) continue
      if (!this.reachableSet.has(id)) {
        this.addWarning(
          'UNREACHABLE_STATE',
          `State "${id}" is not reachable`,
          `states.${id}`,
        )
      }
    }

    // UNUSED_EVENT — an event with no transition whose `from` AND `to` are valid
    // model expressions (V11: both split on '|'; V2: '*' counts as valid).
    for (const [eventName, event] of Object.entries(smConfig.events ?? {})) {
      if (!event || !Array.isArray(event.transitions)) continue
      const hasValid = event.transitions.some(
        (t) =>
          typeof t?.from === 'string' &&
          typeof t?.to === 'string' &&
          this.isValidPathExpr(t.from) &&
          this.isValidPathExpr(t.to),
      )
      if (!hasValid) {
        this.addWarning(
          'UNUSED_EVENT',
          `Event "${eventName}" has no valid transitions`,
          `events.${eventName}`,
        )
      }
    }
  }

  /** Every '|' part of `expr` is either '*' or an addressable state. */
  private isValidPathExpr(expr: string): boolean {
    for (const part of expr.split('|')) {
      if (this.isWildcardPart(part)) continue
      if (!this.isAddressableState(part)) return false
    }
    return true
  }

  // ── model-structural correctness (§1а) ──────────────────────────────────────

  private validateModelStructure<T extends object>(
    smConfig: StateMachineConfig<T>,
  ): void {
    if (!this.model) return

    // DUPLICATE_REGION_NAME / DUPLICATE_STATE_ID — an id minted by two structural
    // sources (the normalized model silently overwrites; we detect it here).
    for (const [id, counts] of this.idCounts) {
      const total = counts.state + counts.region
      if (total <= 1) continue
      if (counts.region >= 1) {
        this.addError(
          'DUPLICATE_REGION_NAME',
          `Region container id "${id}" collides with another node of the same id — region names must be unique within their composite and must not shadow a state path`,
          `states.${id}`,
          undefined,
          `Rename the region or the colliding state so the model id "${id}" is minted exactly once.`,
        )
      } else {
        this.addError(
          'DUPLICATE_STATE_ID',
          `State id "${id}" is defined more than once`,
          `states.${id}`,
        )
      }
    }

    for (const [rid, node] of this.model.nodes) {
      if (node.kind !== 'region') continue

      // REGION_STARTS_FINAL — the region's entry leaf is a `final` leaf, so the
      // join closes immediately and the region never actually runs.
      const entry = this.resolveRegionInitialChildId(rid)
      if (entry) {
        const eln = this.model.nodes.get(entry)
        if (eln && eln.kind === 'leaf' && eln.isFinal) {
          this.addError(
            'REGION_STARTS_FINAL',
            `Region "${rid}" starts in final leaf "${entry}" — the region joins immediately and never does work`,
            `states.${rid}`,
            undefined,
            `Make the region's entry (its \`initial\` / first leaf) a non-final working state, and mark a later leaf \`final\`.`,
          )
        }
      }

      // REGION_NO_PATH_TO_FINAL — the region declares final leaf(s) but NONE are
      // reachable (strengthens REGION_NO_REACHABLE_FINAL: presence != reachability).
      const finals: string[] = []
      const prefix = `${rid}.`
      for (const [fid, fn] of this.model.nodes) {
        if (fn.isFinal && fid.startsWith(prefix)) finals.push(fid)
      }
      if (finals.length > 0 && !finals.some((f) => this.reachableSet.has(f))) {
        this.addError(
          'REGION_NO_PATH_TO_FINAL',
          `Region "${rid}" has final leaf(s) [${finals.join(', ')}] but none is reachable from its entry — the region can never complete`,
          `states.${rid}`,
          undefined,
          `Add a transition path from the region entry to one of its final leaves, or remove the unreachable final marker.`,
        )
      }
    }

    // UNSATISFIABLE_FROM / UNSATISFIABLE_TO — a composite `from`/`to` names two
    // MUTUALLY EXCLUSIVE states that can never be co-active in one configuration.
    // M-4: generalise the old "nearest-region-ancestor" comparison (which only
    // caught two leaves of the SAME region) to LCA-exclusivity — two nodes are
    // mutually exclusive when they diverge inside an XOR context (a region, or
    // the root between two simple sibling states), NOT inside a parallel composite
    // (whose regions run concurrently). A `from` naming both can never be enabled;
    // a `to` naming both can never be entered (runtime collapses last-wins by
    // regionKey).
    for (const [eventName, event] of Object.entries(smConfig.events ?? {})) {
      if (!event || !Array.isArray(event.transitions)) continue
      event.transitions.forEach((t, index) => {
        this.checkMutualExclusion(
          t?.from,
          'UNSATISFIABLE_FROM',
          `events.${eventName}.transitions[${index}].from`,
          'from',
          'so this transition can never be enabled',
        )
        this.checkMutualExclusion(
          t?.to,
          'UNSATISFIABLE_TO',
          `events.${eventName}.transitions[${index}].to`,
          'to',
          'so this transition can never enter both (runtime collapses last-wins by region)',
        )
      })
    }

    // DEAD_END_STATE (warning) — a non-root, non-final leaf with no way out: no
    // transition fires from it, from an ancestor of it, or from '*'.
    const fromParts = this.collectFromParts(smConfig)
    // M-3: a leaf in a parallel region is NOT a dead end when its composite is
    // left by a transition originating in a SIBLING region — that exit kills the
    // whole composite (all its regions, including this leaf). Precompute the set
    // of composites some transition leaves so a watcher-region leaf is credited.
    const exitableComposites = this.computeExitableComposites(smConfig)
    for (const [id, node] of this.model.nodes) {
      if (node.kind !== 'leaf') continue
      if (node.depth === 0) continue // root terminal — legitimate
      if (node.isFinal) continue
      if (this.hasExit(id, fromParts, exitableComposites)) continue
      this.addWarning(
        'DEAD_END_STATE',
        `State "${id}" is a dead end — it has no outgoing transition (and is not a final leaf)`,
        `states.${id}`,
        undefined,
        `Add an outgoing transition from "${id}", mark it \`final: true\` if it is a completion state, or route an ancestor/wildcard transition through it.`,
      )
    }

    // INVOKE_NO_HANDLER — the W3b `invoke.src` form does not exist yet, so this
    // pass is INERT in W2b (wired-but-no-op to avoid a second-wave dead-code
    // block). Активируется в W3b.
    this.validateInvokeHandlers(smConfig)
  }

  /** All concrete `from` parts across every event (split on '|', wildcard kept as '*'). */
  private collectFromParts<T extends object>(
    smConfig: StateMachineConfig<T>,
  ): Set<string> {
    const set = new Set<string>()
    for (const event of Object.values(smConfig.events ?? {})) {
      if (!event || !Array.isArray(event.transitions)) continue
      for (const t of event.transitions) {
        if (typeof t?.from !== 'string') continue
        for (const p of t.from.split('|')) if (p) set.add(p)
      }
    }
    return set
  }

  /** True when some transition can fire from leaf `id` (direct, ancestor, or wildcard). */
  private hasExit(
    id: string,
    fromParts: Set<string>,
    exitableComposites?: Set<string>,
  ): boolean {
    // Collect id + all its ancestors (a transition from any of them exits `id`).
    const ancestry = new Set<string>()
    let cur: string | null = id
    while (cur) {
      ancestry.add(cur)
      cur = this.nodeOf(cur)?.parent ?? null
    }
    for (const fp of fromParts) {
      if (fp === '*') return true
      if (fp.includes('*')) {
        // suffix wildcard '<prefix>.*' — covers everything under prefix
        const prefix = fp.endsWith('.*') ? fp.slice(0, -2) : fp.split('*')[0]!.replace(/\.$/, '')
        if (prefix && ancestry.has(prefix)) return true
        continue
      }
      if (ancestry.has(fp)) return true
    }
    // M-3: a composite ANCESTOR of `id` that some transition leaves (via a
    // sibling-region source) exits `id` too — so `id` is not a dead end.
    if (exitableComposites && exitableComposites.size > 0) {
      for (const anc of ancestry) {
        if (anc === id) continue
        if (exitableComposites.has(anc)) return true
      }
    }
    return false
  }

  /**
   * M-3 — the set of composite ids that at least one transition EXITS: a
   * transition with a `from` part inside composite C (C itself or a descendant)
   * and a `to` part outside C leaves C entirely (and with it every region of C).
   */
  private computeExitableComposites<T extends object>(
    smConfig: StateMachineConfig<T>,
  ): Set<string> {
    const exitable = new Set<string>()
    if (!this.model) return exitable
    const isInside = (id: string, container: string): boolean =>
      id === container || this.isAncestor(container, id)
    for (const event of Object.values(smConfig.events ?? {})) {
      if (!event || !Array.isArray(event.transitions)) continue
      for (const t of event.transitions) {
        if (typeof t?.from !== 'string' || typeof t?.to !== 'string') continue
        const froms = t.from
          .split('|')
          .filter((p) => p && !this.isWildcardPart(p) && this.model!.nodes.has(p))
        const tos = t.to
          .split('|')
          .filter((p) => p && !this.isWildcardPart(p) && this.model!.nodes.has(p))
        if (froms.length === 0 || tos.length === 0) continue
        for (const f of froms) {
          // Composite ancestors of the source (C such that f is inside C).
          let anc: string | null = this.nodeOf(f)?.parent ?? null
          while (anc) {
            const n = this.nodeOf(anc)
            if (n?.kind === 'composite') {
              // C is exited iff some `to` lands OUTSIDE C.
              if (tos.some((to) => !isInside(to, anc!))) exitable.add(anc)
            }
            anc = n?.parent ?? null
          }
        }
      }
    }
    return exitable
  }

  /**
   * W3b PLACEHOLDER (inactive in W2b). Will warn `INVOKE_NO_HANDLER` for the new
   * `invoke` form carrying a `src` with neither `onDone` nor `onError`. Kept as a
   * declared method (not wired into validate()) so the W3b activation is a
   * one-line call, avoiding a second-wave dead-code block. Активируется в W3b.
   */
  private validateInvokeHandlers<T extends object>(
    _smConfig: StateMachineConfig<T>,
  ): void {
    // Активируется в W3b (форма invoke.src ещё не существует в W2b).
  }

  // ── selection warnings (help W3 migration) ──────────────────────────────────

  private validateSelectionWarnings<T extends object>(
    smConfig: StateMachineConfig<T>,
  ): void {
    if (!this.model) return

    for (const [eventName, event] of Object.entries(smConfig.events ?? {})) {
      if (!event || !Array.isArray(event.transitions)) continue

      // Flatten (fromPart, priority) across the event's transitions.
      const froms: Array<{ part: string; priority: number | undefined }> = []
      let hasWildcard = false
      let hasConcrete = false
      for (const t of event.transitions) {
        if (typeof t?.from !== 'string') continue
        for (const p of t.from.split('|')) {
          if (!p) continue
          if (p === '*') {
            hasWildcard = true
            continue
          }
          hasConcrete = true
          froms.push({ part: p, priority: t.priority })
        }
      }

      // WILDCARD_SHADOWED (info): a from:'*' sits next to explicit paths.
      if (hasWildcard && hasConcrete) {
        this.addInfo(
          'WILDCARD_SHADOWED',
          `Event "${eventName}" mixes a from:'*' wildcard with explicit paths; the explicit transitions may shadow (or be shadowed by) the wildcard depending on selection order`,
          `events.${eventName}`,
        )
      }

      // ANCESTOR_DESCENDANT_OVERLAP / PRIORITY_INVERTS_DOMINANCE
      const reported = new Set<string>()
      for (let i = 0; i < froms.length; i++) {
        for (let j = 0; j < froms.length; j++) {
          if (i === j) continue
          const anc = froms[i]!
          const desc = froms[j]!
          if (!this.isAncestor(anc.part, desc.part)) continue
          const key = `${anc.part}>>${desc.part}`
          if (reported.has(key)) continue
          reported.add(key)

          const bothPrio =
            typeof anc.priority === 'number' &&
            typeof desc.priority === 'number'
          if (bothPrio && anc.priority! > desc.priority!) {
            this.addWarning(
              'PRIORITY_INVERTS_DOMINANCE',
              `Event "${eventName}": ancestor "${anc.part}" has HIGHER priority (${anc.priority}) than its descendant "${desc.part}" (${desc.priority}) — a deliberate inversion of the descendant-wins default`,
              `events.${eventName}`,
              undefined,
              `Confirm the inversion is intended; after the W3 default (descendant wins) this priority is what keeps the ancestor dominant.`,
            )
          } else {
            this.addWarning(
              'ANCESTOR_DESCENDANT_OVERLAP',
              `Event "${eventName}": transitions from ancestor "${anc.part}" and descendant "${desc.part}" overlap on the same event — after W3 the descendant wins; add an explicit \`priority\` if the ancestor should dominate`,
              `events.${eventName}`,
              undefined,
              `If the ancestor should win, give it a higher \`priority\`; otherwise the descendant transition is selected.`,
            )
          }
        }
      }
    }
  }

  // ── final states + done.state join validation ───────────────────────────────

  /**
   * Collects every state in the tree as {dottedPath, config} entries, walking
   * region containers (region names are part of the path but never emitted as an
   * entry — mirroring runtime expansion).
   */
  private collectStateEntries<T extends object>(
    states: States<T>,
    prefix: string,
    collector: Array<{ path: string; state: Omit<State<T>, 'name'> }>,
  ): void {
    for (const [stateName, state] of Object.entries(states)) {
      if (stateName === 'initial') continue
      const fullName = prefix ? `${prefix}.${stateName}` : stateName
      collector.push({ path: fullName, state })

      if (state.regions) {
        for (const [regionName, regionStates] of Object.entries(
          state.regions,
        )) {
          this.collectStateEntries(
            regionStates,
            `${fullName}.${regionName}`,
            collector,
          )
        }
      }
    }
  }

  /**
   * True when `composite` has at least one `final:true` atomic substate reachable
   * through its (possibly nested) region tree. Used by REGION_NO_REACHABLE_FINAL.
   */
  private hasReachableFinal<T extends object>(
    composite: Omit<State<T>, 'name'>,
  ): boolean {
    if (!composite.regions) return false
    for (const regionStates of Object.values(composite.regions)) {
      for (const state of Object.values(regionStates)) {
        if (state.final) return true
        if (state.regions && this.hasReachableFinal(state)) return true
      }
    }
    return false
  }

  private validateFinalStates<T extends object>(
    smConfig: StateMachineConfig<T>,
  ): void {
    if (!smConfig.states || typeof smConfig.states !== 'object') return

    const entries: Array<{ path: string; state: Omit<State<T>, 'name'> }> = []
    this.collectStateEntries(smConfig.states, '', entries)

    const finalStatePaths = new Set<string>()

    for (const { path, state } of entries) {
      if (!state.final) continue
      if (state.regions) {
        this.addWarning(
          'FINAL_ON_COMPOSITE',
          `Final flag on composite state "${path}" is ignored; mark an atomic leaf inside a region as final instead`,
          `states.${path}.final`,
          undefined,
          'Remove `final: true` from this composite and set it on the atomic leaf state that represents the region\'s completion.',
        )
      } else {
        finalStatePaths.add(path)
      }
    }

    const userFromStates = new Set<string>()
    const doneStateComposites = new Set<string>()

    for (const [eventName, event] of Object.entries(smConfig.events ?? {})) {
      if (!event.transitions || !Array.isArray(event.transitions)) continue

      if (eventName.startsWith('done.state.')) {
        const compositeId = eventName.slice('done.state.'.length)
        if (compositeId) doneStateComposites.add(compositeId)
      }

      for (const transition of event.transitions) {
        if (typeof transition.from !== 'string') continue
        for (const fromPart of transition.from.split('|')) {
          if (finalStatePaths.has(fromPart)) {
            this.addError(
              'FINAL_STATE_HAS_OUTGOING',
              `Final state "${fromPart}" cannot be the source of transition on event "${eventName}"; a final pseudo-state has no outgoing transitions`,
              `events.${eventName}`,
              undefined,
              `Remove the outgoing transition from "${fromPart}", or clear its \`final: true\` flag if it is not actually a final state.`,
            )
          }

          if (!eventName.startsWith('done.state.')) {
            userFromStates.add(fromPart)
          }
        }
      }
    }

    const entryByPath = new Map(entries.map((e) => [e.path, e.state]))
    for (const compositeId of doneStateComposites) {
      const composite = entryByPath.get(compositeId)
      if (!composite) continue
      if (!this.hasReachableFinal(composite)) {
        this.addWarning(
          'REGION_NO_REACHABLE_FINAL',
          `Join event "done.state.${compositeId}" can never fire: composite "${compositeId}" has no \`final\` substate in any region`,
          `events.done.state.${compositeId}`,
          undefined,
          `Mark the completion leaf of each region under "${compositeId}" with \`final: true\`, or remove the done.state join.`,
        )
      }

      if (userFromStates.has(compositeId)) {
        this.addWarning(
          'DONE_VS_PARALLEL_EXIT_AMBIGUITY',
          `Composite "${compositeId}" has both a done.state join and a user-event transition with from:"${compositeId}"; the user event can preempt the all-final join because it is eligible on any active leaf`,
          `events.done.state.${compositeId}`,
          undefined,
          `Disambiguate by using the done.state.${compositeId} join exclusively, or scope the user-event transition to a specific leaf instead of the bare composite.`,
        )
      }
    }

    // REGION_MISSING_INITIAL (advisory) — a region whose start leaf is not pinned
    // (neither by the composite's `initial` — bare or region-qualified — nor by
    // the region's own `initial`), so runtime expansion falls back to first-key
    // insertion order. Resolved THROUGH THE MODEL so the F10 dotted/parallel
    // initial ("a.run|b.run") is recognized as pinning and NOT falsely warned.
    if (this.model) {
      // A BARE composite `initial` (e.g. 'work') can only pin a region if that
      // key is UNIQUE across the composite's sibling regions — the engine
      // (parseCompositeInitial) requires matches.length===1 and otherwise falls
      // back to first-key. Mirror that gate here so validator-pinned ⟺
      // runtime-enters-there (single source of truth): count bare-key
      // occurrences per composite; a key seen in ≥2 sibling regions is
      // ambiguous and must NOT be treated as pinning (W2.1 residual).
      const bareKeyCountByComposite = new Map<string, Map<string, number>>()
      for (const [rid, node] of this.model.nodes) {
        if (node.kind !== 'region') continue
        const compositeId = node.parent!
        const rs = this.regionCfgById.get(rid)
        if (!rs) continue
        let counts = bareKeyCountByComposite.get(compositeId)
        if (!counts) {
          counts = new Map<string, number>()
          bareKeyCountByComposite.set(compositeId, counts)
        }
        for (const k of Object.keys(rs)) {
          if (k === 'initial') continue
          counts.set(k, (counts.get(k) ?? 0) + 1)
        }
      }

      for (const [rid, node] of this.model.nodes) {
        if (node.kind !== 'region') continue
        const compositeId = node.parent!
        const regionName = rid.slice(compositeId.length + 1)
        const rs = this.regionCfgById.get(rid)
        const regionKeys = rs
          ? Object.keys(rs).filter((k) => k !== 'initial')
          : []
        if (regionKeys.length === 0) continue
        const compositeInitial = this.stateCfgById.get(compositeId)?.initial
        const ambiguousBare = new Set<string>()
        const counts = bareKeyCountByComposite.get(compositeId)
        if (counts) {
          for (const [k, c] of counts) if (c >= 2) ambiguousBare.add(k)
        }
        if (
          this.isRegionPinned(
            compositeInitial,
            regionName,
            regionKeys,
            rs,
            ambiguousBare,
          )
        ) {
          continue
        }
        this.addWarning(
          'REGION_MISSING_INITIAL',
          `Region "${regionName}" of composite "${compositeId}" has no explicit initial; expansion falls back to the first key "${regionKeys[0]}" (insertion-order dependent)`,
          `states.${compositeId}.regions.${regionName}`,
          undefined,
          `Set \`initial\` on composite "${compositeId}" to a leaf of region "${regionName}", to make the starting substate explicit and order-independent.`,
        )
      }
    }
  }

  /** True when the region's starting leaf is explicitly pinned. */
  private isRegionPinned(
    compositeInitial: unknown,
    regionName: string,
    regionKeys: string[],
    regionConfig: any,
    ambiguousBare: ReadonlySet<string> = new Set(),
  ): boolean {
    // region's own `initial`
    if (
      regionConfig &&
      typeof regionConfig.initial === 'string' &&
      regionConfig.initial
    ) {
      return true
    }
    if (typeof compositeInitial !== 'string') return false
    for (const part of compositeInitial.split('|')) {
      if (!part) continue
      // bare leaf key present in this region (generator / hierarchical form).
      // Pins ONLY when unique across sibling regions — a key declared in ≥2
      // regions is ambiguous; the engine cannot resolve it and falls back to
      // first-key, so the validator must NOT claim it pinned (W2.1 residual).
      if (regionKeys.includes(part) && !ambiguousBare.has(part)) return true
      // region-qualified dotted form ("a.run" pins region "a")
      if (part.startsWith(`${regionName}.`)) return true
    }
    return false
  }

  private validatePerformanceConstraints<T extends object>(
    smConfig: StateMachineConfig<T>,
  ): void {
    if (!smConfig.states || typeof smConfig.states !== 'object') return
    const stateCount = this.countStates(smConfig.states)
    const eventCount = smConfig.events ? Object.keys(smConfig.events).length : 0

    if (stateCount > this.config.maxStatesCount) {
      this.addWarning(
        'TOO_MANY_STATES',
        `State count (${stateCount}) exceeds recommended maximum (${this.config.maxStatesCount})`,
        'states',
      )
    }

    if (eventCount > this.config.maxEventsCount) {
      this.addWarning(
        'TOO_MANY_EVENTS',
        `Event count (${eventCount}) exceeds recommended maximum (${this.config.maxEventsCount})`,
        'events',
      )
    }

    let totalTransitions = 0
    for (const event of Object.values(smConfig.events ?? {})) {
      if (event && Array.isArray(event.transitions)) {
        totalTransitions += event.transitions.length
      }
    }

    if (totalTransitions > stateCount * 3) {
      this.addWarning(
        'COMPLEX_TRANSITIONS',
        'High transition-to-state ratio may impact performance',
        'events',
      )
    }
  }

  private countStates<T extends object>(states: States<T>): number {
    let count = 0
    for (const [name, state] of Object.entries(states)) {
      if (name === 'initial') continue
      count += 1
      if (state.regions) {
        for (const regionStates of Object.values(state.regions)) {
          count += this.countStates(regionStates)
        }
      }
    }
    return count
  }

  private addError(
    code: string,
    message: string,
    path: string,
    details?: Record<string, any>,
    suggestion?: string,
  ): void {
    this.errors.push({
      code,
      message,
      severity: 'error',
      path,
      ...(details !== undefined ? { details } : {}),
      ...(suggestion !== undefined ? { suggestion } : {}),
    })
  }

  private addWarning(
    code: string,
    message: string,
    path: string,
    details?: Record<string, any>,
    suggestion?: string,
  ): void {
    this.warnings.push({
      code,
      message,
      severity: 'warning',
      path,
      ...(details !== undefined ? { details } : {}),
      ...(suggestion !== undefined ? { suggestion } : {}),
    })
  }

  private addInfo(
    code: string,
    message: string,
    path: string,
    details?: Record<string, any>,
    suggestion?: string,
  ): void {
    this.infos.push({
      code,
      message,
      severity: 'info',
      path,
      ...(details !== undefined ? { details } : {}),
      ...(suggestion !== undefined ? { suggestion } : {}),
    })
  }
}

// Utility functions
export function validateConfig<T extends object>(
  config: StateMachineConfig<T>,
  validationConfig?: Partial<ValidationConfig>,
): ValidationResult {
  const validator = new ConfigValidator(validationConfig)
  return validator.validate(config)
}

export function validateConfigStrict<T extends object>(
  config: StateMachineConfig<T>,
): ValidationResult {
  return validateConfig(config, { strictMode: true })
}

export function isValidConfig<T extends object>(
  config: StateMachineConfig<T>,
): boolean {
  return validateConfig(config).isValid
}
