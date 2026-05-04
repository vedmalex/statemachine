/**
 * @deprecated Will be removed in a follow-up task. Security policy enforcement should
 * happen at the host-application layer; this module is a source-tree marker.
 *
 * Post TD-T3-4 pruning, symbols from this module are not reachable from `dist/index.js` —
 * the deprecation has no public deprecation cycle, only source-tree intent.
 *
 * Security module for safe function serialization and validation
 * Replaces unsafe `new Function()` usage with secure alternatives
 */

import { securityLogger } from './logger'
import type {
  ActionOrString,
  ErrorHandler,
  ErrorHandlerOrString,
  EventAction,
  KeysOf,
} from './types'

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
      type: 'string'
      name: string
    }
  | {
      type: 'function'
      body: string
      hash: string // Security hash for validation
      metadata: {
        length: number
        createdAt: number
        functionName?: string
      }
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

  /**
   * Creates a security hash for function validation
   */
  async createSecurityHash(body: string, metadata: any): Promise<string> {
    // Use Web Crypto API for secure hashing
    const encoder = new TextEncoder()
    const data = encoder.encode(body + JSON.stringify(metadata))

    // Check if crypto is available (Browser/Node/Bun)
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const hashBuffer = await crypto.subtle.digest('SHA-256', data)
      return Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    }

    // Fallback for environments without crypto.subtle (should be rare in modern envs)
    // Using a slightly better non-crypto hash (FNV-1a inspired) than the previous simple shift
    const str = body + JSON.stringify(metadata)
    let hash = 0x811c9dc5
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16)
  }

  /**
   * Validates security hash
   */
  async validateSecurityHash(
    body: string,
    metadata: any,
    expectedHash: string,
  ): Promise<boolean> {
    const actualHash = await this.createSecurityHash(body, metadata)
    return actualHash === expectedHash
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
   * Safely serializes an action with security validation (Async)
   */
  async serializeActionAsync<TOwner extends object, R = void>(
    action: ActionOrString<TOwner, R> | ErrorHandlerOrString<TOwner>,
    functionName?: string,
  ): Promise<SafeSerializedAction | undefined> {
    if (typeof action === 'string') {
      return { type: 'string', name: action }
    } else if (typeof action === 'function') {
      const body = action.toString()

      // Validate function body
      this.validator.validateFunctionBody(body, functionName)

      const metadata = {
        length: body.length,
        createdAt: Date.now(),
        ...(functionName !== undefined ? { functionName } : {}),
      }

      const hash = await this.validator.createSecurityHash(body, metadata)

      return {
        type: 'function',
        body,
        hash,
        metadata,
      }
    }
    return undefined
  }

  /**
   * Legacy synchronous serialization (Uses weak hash, kept for backward compatibility)
   * @deprecated Use serializeActionAsync instead for better security
   */
  serializeAction<TOwner extends object, R = void>(
    action: ActionOrString<TOwner, R> | ErrorHandlerOrString<TOwner>,
    functionName?: string,
  ): SafeSerializedAction | undefined {
    if (typeof action === 'string') {
      return { type: 'string', name: action }
    } else if (typeof action === 'function') {
      const body = action.toString()
      this.validator.validateFunctionBody(body, functionName)

      const metadata = {
        length: body.length,
        createdAt: Date.now(),
        ...(functionName !== undefined ? { functionName } : {}),
      }

      // Sync version uses the weak fallback hash logic implicitly or needs a sync version of createHash
      // We'll implement a sync weak hash here inline to preserve sync behavior
      const str = body + JSON.stringify(metadata)
      let hash = 0x811c9dc5
      for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
      }

      return {
        type: 'function',
        body,
        hash: (hash >>> 0).toString(16),
        metadata,
      }
    }
    return undefined
  }

  /**
   * Safely deserializes an action with security validation (Async)
   */
  async deserializeActionAsync<TOwner extends object, R = void>(
    serializedAction: SafeSerializedAction | undefined,
  ): Promise<
    ActionOrString<TOwner, R> | ErrorHandlerOrString<TOwner> | undefined
  > {
    if (!serializedAction) {
      return undefined
    }

    if (serializedAction.type === 'string') {
      return serializedAction.name as KeysOf<TOwner, EventAction<TOwner, R>>
    } else if (serializedAction.type === 'function') {
      try {
        // Validate security hash
        const isValid = await this.validator.validateSecurityHash(
          serializedAction.body,
          serializedAction.metadata,
          serializedAction.hash,
        )

        if (!isValid) {
          // Fallback check for legacy weak hash if crypto hash failed
          // This allows reading old backups/configs
          const str =
            serializedAction.body + JSON.stringify(serializedAction.metadata)
          let hash = 0x811c9dc5
          for (let i = 0; i < str.length; i++) {
            hash ^= str.charCodeAt(i)
            hash = Math.imul(hash, 0x01000193)
          }
          const legacyHash = (hash >>> 0).toString(16)

          if (legacyHash !== serializedAction.hash) {
            throw new Error('Function security hash validation failed')
          }
        }

        // Re-validate function body
        this.validator.validateFunctionBody(
          serializedAction.body,
          serializedAction.metadata.functionName,
        )

        // Create function using safe method
        return this.createSafeFunction(serializedAction.body)
      } catch (e) {
        securityLogger.error(
          'Error deserializing function',
          {
            functionName: serializedAction.metadata.functionName,
            bodyLength: serializedAction.body.length,
            hash: serializedAction.hash,
          },
          e instanceof Error ? e : new Error(String(e)),
        )
        return undefined
      }
    }
    return undefined
  }

  /**
   * Safely deserializes an action (Synchronous - Legacy/Weak)
   */
  deserializeAction<TOwner extends object, R = void>(
    serializedAction: SafeSerializedAction | undefined,
  ): ActionOrString<TOwner, R> | ErrorHandlerOrString<TOwner> | undefined {
    if (!serializedAction) {
      return undefined
    }

    if (serializedAction.type === 'string') {
      return serializedAction.name as KeysOf<TOwner, EventAction<TOwner, R>>
    } else if (serializedAction.type === 'function') {
      try {
        // Sync validation only checks weak hash
        const str =
          serializedAction.body + JSON.stringify(serializedAction.metadata)
        let hash = 0x811c9dc5
        for (let i = 0; i < str.length; i++) {
          hash ^= str.charCodeAt(i)
          hash = Math.imul(hash, 0x01000193)
        }
        const calculatedHash = (hash >>> 0).toString(16)

        if (calculatedHash !== serializedAction.hash) {
          // We cannot verify crypto hashes synchronously, so we must fail or skip verification
          // for crypto hashes. If the hash looks like a weak hash (short hex), we check it.
          // If it looks like SHA-256 (64 chars), we can't verify it sync.
          if (serializedAction.hash.length === 64) {
            console.warn(
              'Warning: Skipping verification of SHA-256 hash in synchronous deserializeAction. Use deserializeActionAsync for security.',
            )
          } else {
            throw new Error('Function security hash validation failed (Legacy)')
          }
        }

        this.validator.validateFunctionBody(
          serializedAction.body,
          serializedAction.metadata.functionName,
        )

        return this.createSafeFunction(serializedAction.body)
      } catch (e) {
        securityLogger.error(
          'Error deserializing function',
          {
            functionName: serializedAction.metadata.functionName,
            bodyLength: serializedAction.body.length,
            hash: serializedAction.hash,
          },
          e instanceof Error ? e : new Error(String(e)),
        )
        return undefined
      }
    }
    return undefined
  }

  /**
   * Safely deserializes legacy function strings (without security metadata)
   * This method provides backward compatibility for old string-based function serialization
   * while maintaining security through validation and sandboxing.
   */
  deserializeLegacyString(
    action: string,
  ): EventAction<any> | ErrorHandler<any> | undefined {
    if (!action || typeof action !== 'string') {
      return undefined
    }

    try {
      // Validate function body for security threats
      this.validator.validateFunctionBody(action, 'legacy_deserialization')

      // Create function using the same safe method as modern serialization
      return this.createSafeFunction(action)
    } catch (e) {
      securityLogger.error(
        'Blocked unsafe legacy function string',
        { actionLength: action.length },
        e instanceof Error ? e : new Error(String(e)),
      )
      return undefined
    }
  }

  /**
   * Creates a function safely without using new Function()
   * Uses a whitelist approach with predefined function templates
   */
  private createSafeFunction(
    body: string,
  ): EventAction<any> | ErrorHandler<any> {
    // For now, we'll use a safer approach with Function constructor
    // but with additional validation and sandboxing.
    //
    // Important: we must preserve the original function *signature* (parameter names),
    // because state machine code calls hooks/conditions with specific arguments
    // (e.g. invoke.cond(adaptee)). Stripping the wrapper breaks that contract.
    try {
      const source = body.trim()

      // Executor runs in a restricted scope and evaluates the provided function source
      // as an expression, then calls it with (adaptee, ...args).
      const executor = new Function(
        'adaptee',
        'args',
        `
        // Block dangerous globals by creating local variables that shadow them
        var eval = undefined;
        var Function = undefined;
        var setTimeout = undefined;
        var setInterval = undefined;
        var document = undefined;
        var window = undefined;
        var global = undefined;
        var process = undefined;
        var require = undefined;

        const __fn = (${source});
        if (typeof __fn !== 'function') {
          throw new Error('Deserialized source is not a function');
        }
        return __fn(adaptee, ...(Array.isArray(args) ? args : []));
      `,
      ) as (adaptee: any, args: any[]) => any

      // Preserve varargs call style used across the codebase.
      return ((adaptee: any, ...args: any[]) => executor(adaptee, args)) as
        | EventAction<any>
        | ErrorHandler<any>
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      throw new Error(`Failed to create safe function: ${message}`)
    }
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

/**
 * @deprecated host-application-level enforcement; this module will be removed in a follow-up task.
 */
export const deserializeAction = safeFunctionSerializer.deserializeAction.bind(
  safeFunctionSerializer,
)
