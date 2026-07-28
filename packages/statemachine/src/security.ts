/**
 * @deprecated Will be removed in a follow-up task. Security policy enforcement should
 * happen at the host-application layer; this module is a source-tree marker.
 *
 * Post TD-T3-4 pruning, symbols from this module are not reachable from `dist/index.js` —
 * the deprecation has no public deprecation cycle, only source-tree intent.
 *
 * Governance treatments (multi-treatment file, per TASK-003 CODE_REVIEW F-CR3-8):
 *   - tsconfig.json `include: ["src/**\/*"]` — typechecked under strict TS for now
 *   - vitest.config.ts `coverage.exclude` — excluded from coverage instrumentation
 *   - knip.json `ignore` — excluded from unused-export warnings
 *   - package.json `files: ["dist", "types", ...]` — NOT shipped to npm (since TASK-003 CODE_REVIEW F-CR3-1)
 *
 * Removal trigger: when no in-tree code references the file (currently `src/tests/security.test.ts`
 * does), delete the file plus its test plus all four governance-list entries above.
 *
 * Security module for safe function serialization and validation.
 *
 * W0 (defect П1): this module NO LONGER compiles function bodies. Serialization
 * emits a body-free NAME reference (`{ type: 'function', name }`); restoration is
 * performed by name against a consumer-supplied registry in `state_machine.ts`.
 * There is no `new Function`, no `eval`, and no keyless body+hash path — no
 * deserialization surface turns an attacker-controlled string into code. The
 * `FunctionValidator` static analyzer remains for host-application use.
 */

import type { ActionOrString, ErrorHandlerOrString } from './types'

// Configuration for function security
/**
 * @deprecated host-application-level enforcement; this module will be removed in a follow-up task.
 */
export interface FunctionSecurityConfig {
  allowedFunctionNames: Set<string>
  maxFunctionLength: number
  enableValidation: boolean
  customPatterns?: DangerousPattern[]
}

/**
 * @deprecated host-application-level enforcement; this module will be removed in a follow-up task.
 */
export type FunctionRiskLevel = 'low' | 'medium' | 'high' | 'critical'

/**
 * @deprecated host-application-level enforcement; this module will be removed in a follow-up task.
 */
export interface DangerousPattern {
  pattern: RegExp
  risk: FunctionRiskLevel
  description: string
  category?: string
}

/**
 * @deprecated host-application-level enforcement; this module will be removed in a follow-up task.
 */
export interface FunctionValidationResult {
  isValid: boolean
  errors: string[]
  riskLevel: FunctionRiskLevel
  detectedPatterns: string[]
}

const BUILTIN_PATTERNS: DangerousPattern[] = [
  {
    pattern: /\beval\s*\(/gi,
    risk: 'critical',
    description: 'Direct eval() usage',
    category: 'eval',
  },
  {
    pattern: /\bFunction\s*\(/gi,
    risk: 'high',
    description: 'Dynamic Function constructor call',
    category: 'eval',
  },
  {
    pattern: /new\s+Function\s*\(/gi,
    risk: 'high',
    description: 'Dynamic function creation',
    category: 'eval',
  },
  {
    pattern: /setTimeout\s*\(\s*['"`][^'"`]*['"`]/gi,
    risk: 'high',
    description: 'setTimeout with string code',
    category: 'eval',
  },
  {
    pattern: /setInterval\s*\(\s*['"`][^'"`]*['"`]/gi,
    risk: 'high',
    description: 'setInterval with string code',
    category: 'eval',
  },
  {
    pattern: /\bfetch\s*\(/gi,
    risk: 'medium',
    description: 'Network request via fetch',
    category: 'network',
  },
  {
    pattern: /XMLHttpRequest/gi,
    risk: 'medium',
    description: 'XMLHttpRequest usage',
    category: 'network',
  },
  {
    pattern: /WebSocket/gi,
    risk: 'medium',
    description: 'WebSocket connection',
    category: 'network',
  },
  {
    pattern: /require\s*\(\s*['"`]fs['"`]\s*\)/gi,
    risk: 'high',
    description: 'File system access via require("fs")',
    category: 'filesystem',
  },
  {
    pattern: /import.*from\s*['"`]fs['"`]/gi,
    risk: 'high',
    description: 'File system access via import',
    category: 'filesystem',
  },
  {
    pattern: /document\./gi,
    risk: 'medium',
    description: 'DOM access',
    category: 'dom',
  },
  {
    pattern: /window\./gi,
    risk: 'medium',
    description: 'Window object access',
    category: 'dom',
  },
  {
    pattern: /innerHTML/gi,
    risk: 'high',
    description: 'innerHTML manipulation (XSS risk)',
    category: 'dom',
  },
  {
    pattern: /global\./gi,
    risk: 'high',
    description: 'Global scope access',
    category: 'global',
  },
  {
    pattern: /process\./gi,
    risk: 'high',
    description: 'Process object access',
    category: 'process',
  },
  {
    pattern: /child_process/gi,
    risk: 'critical',
    description: 'Child process execution',
    category: 'process',
  },
  {
    pattern: /exec\s*\(/gi,
    risk: 'critical',
    description: 'Command execution',
    category: 'process',
  },
  {
    pattern: /require\s*\(/gi,
    risk: 'critical',
    description: 'CommonJS require',
    category: 'module',
  },
  {
    pattern: /import\s*\(/gi,
    risk: 'critical',
    description: 'Dynamic import',
    category: 'module',
  },
  {
    pattern: /__proto__/gi,
    risk: 'critical',
    description: 'Prototype pollution',
    category: 'prototype',
  },
  {
    pattern: /constructor/gi,
    risk: 'critical',
    description: 'Constructor access',
    category: 'prototype',
  },
  {
    pattern: /prototype/gi,
    risk: 'critical',
    description: 'Prototype access',
    category: 'prototype',
  },
  {
    pattern: /\[['"]__proto__['"]\]/gi,
    risk: 'critical',
    description: 'Prototype pollution via bracket notation',
    category: 'prototype',
  },
  {
    pattern: /constructor\s*\[/gi,
    risk: 'critical',
    description: 'Constructor access via bracket notation',
    category: 'prototype',
  },
]

/**
 * @deprecated host-application-level enforcement; this module will be removed in a follow-up task.
 */
export const DEFAULT_SECURITY_CONFIG: FunctionSecurityConfig = {
  allowedFunctionNames: new Set([
    // Common safe function patterns
    'onEnter',
    'onExit',
    'onBeforeEnter',
    'onAfterEnter',
    'onBeforeExit',
    'onAfterExit',
    'onTransition',
    'onError',
    'guard',
    'onBefore',
    'onAfter',
    'onSuccess',

    // Internal serializer function names (used as metadata)
    'config_onError',
    'state_onError',
    'event_onBefore',
    'event_onAfter',
    'event_onSuccess',
    'event_onError',
    'transition_guard',
    'transition_onTransition',
    'transition_onError',
    'invoke_cond',
    'invoke_action',

    // Legacy deserialization marker
    'legacy_deserialization',
  ]),
  maxFunctionLength: 10000, // 10KB limit
  enableValidation: true,
  customPatterns: [],
}

/**
 * @deprecated host-application-level enforcement; this module will be removed in a follow-up task.
 */
export type SafeSerializedAction =
  | {
      // A method-name reference resolved at call time against the owner/context.
      type: 'string'
      name: string
    }
  | {
      // A function reference stored by NAME only (never its body). Restoration
      // resolves this name against a consumer-supplied registry
      // (`StateMachineOptions.actions`). W0 invariant: no serialized form ever
      // carries a compilable function body.
      type: 'function'
      name: string
    }

/**
 * @deprecated host-application-level enforcement; this module will be removed in a follow-up task.
 */
export class FunctionValidator {
  private config: FunctionSecurityConfig
  private allPatterns: DangerousPattern[]

  constructor(config: Partial<FunctionSecurityConfig> = {}) {
    this.config = { ...DEFAULT_SECURITY_CONFIG, ...config }
    this.allPatterns = [
      ...BUILTIN_PATTERNS,
      ...(this.config.customPatterns ?? []),
    ]
  }

  public addCustomPattern(pattern: DangerousPattern): void {
    this.allPatterns.push(pattern)
  }

  /**
   * Validates function body for security threats.
   *
   * Never throws: returns a structured result.
   */
  validate(body: string, functionName?: string): FunctionValidationResult {
    if (!this.config.enableValidation) {
      return {
        isValid: true,
        errors: [],
        riskLevel: 'low',
        detectedPatterns: [],
      }
    }

    const errors: string[] = []
    const detectedPatterns: string[] = []
    let riskLevel: FunctionRiskLevel = 'low'

    // Check length limit
    if (body.length > this.config.maxFunctionLength) {
      errors.push(
        `Function body exceeds maximum length of ${this.config.maxFunctionLength} characters`,
      )
      riskLevel = 'high'
    }

    const riskPriority: Record<FunctionRiskLevel, number> = {
      low: 0,
      medium: 1,
      high: 2,
      critical: 3,
    }

    for (const { pattern, risk, description } of this.allPatterns) {
      if (pattern.global || pattern.sticky) {
        pattern.lastIndex = 0
      }
      if (pattern.test(body)) {
        errors.push(`Function contains dangerous pattern: ${description}`)
        detectedPatterns.push(description)
        if (riskPriority[risk] > riskPriority[riskLevel]) {
          riskLevel = risk
        }
      }
    }

    // Validate function name if provided
    if (functionName && !this.config.allowedFunctionNames.has(functionName)) {
      errors.push(`Function name '${functionName}' is not in allowed list`)
      if (riskLevel === 'low') riskLevel = 'medium'
    }

    return {
      isValid: errors.length === 0,
      errors,
      riskLevel,
      detectedPatterns,
    }
  }

  /**
   * Validates function body for security threats
   */
  validateFunctionBody(body: string, functionName?: string): boolean {
    const result = this.validate(body, functionName)
    if (!result.isValid) {
      throw new Error(result.errors.join('; '))
    }
    return result.isValid
  }
}

/**
 * @deprecated host-application-level enforcement; this module will be removed in a follow-up task.
 */
export class SafeFunctionSerializer {
  public validator: FunctionValidator

  constructor(config?: Partial<FunctionSecurityConfig>) {
    this.validator = new FunctionValidator(config)
  }

  /**
   * Serializes an action into a safe, body-free reference (Async).
   *
   * Identical to {@link serializeAction} — there is no hashing or crypto, so no
   * asynchronous work remains. The async signature is retained for the
   * `toSecureJSON` call-site.
   */
  async serializeActionAsync<TOwner extends object, R = void>(
    action: ActionOrString<TOwner, R> | ErrorHandlerOrString<TOwner>,
    functionName?: string,
  ): Promise<SafeSerializedAction | undefined> {
    return this.serializeAction(action, functionName)
  }

  /**
   * Serializes an action into a safe, body-free reference.
   *
   * - A string action is a method-name reference, kept verbatim.
   * - A function action is stored by its NAME only (its own `.name`). W0
   *   invariant (defect П1): the function BODY is never serialized, so no far
   *   side can recompile it. Restoration resolves the name against a
   *   consumer-supplied registry (`StateMachineOptions.actions`); an unknown
   *   name throws instead of compiling anything.
   *
   * The former `functionName` slot label is no longer emitted — it is not a
   * stable identity (many slots share a label) and would collide in a registry.
   */
  serializeAction<TOwner extends object, R = void>(
    action: ActionOrString<TOwner, R> | ErrorHandlerOrString<TOwner>,
    _functionName?: string,
  ): SafeSerializedAction | undefined {
    if (typeof action === 'string') {
      return { type: 'string', name: action }
    }
    if (typeof action === 'function') {
      return { type: 'function', name: action.name ?? '' }
    }
    return undefined
  }
}

/**
 * @deprecated host-application-level enforcement; this module will be removed in a follow-up task.
 */
// Global instance for convenience
export const safeFunctionSerializer = new SafeFunctionSerializer()

/**
 * @deprecated host-application-level enforcement; this module will be removed in a follow-up task.
 */
export const serializeAction = safeFunctionSerializer.serializeAction.bind(
  safeFunctionSerializer,
)
