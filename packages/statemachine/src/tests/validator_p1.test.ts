import { describe, expect, it } from 'vitest'
import { ConfigValidator } from '../config_validator'

describe('ConfigValidator P1', () => {
  const baseConfig: any = {
    name: 'TestMachine',
    stateAttribute: 'status',
    initialState: 'idle',
    states: {
      idle: {},
      running: {},
    },
    events: {
      start: { transitions: [{ from: 'idle', to: 'running' }] },
    },
  }

  it('should support custom validation rules', () => {
    const customRule = {
      id: 'force-icon-cls',
      validate: (config: any, context: any) => {
        for (const [name, state] of Object.entries(config.states)) {
          if (!(state as any).iconCls) {
            context.addWarning(
              'MISSING_ICON_CLS',
              `State "${name}" is missing iconCls`,
              `states.${name}`,
              'Add iconCls property for better UI representation',
            )
          }
        }
      },
    }

    const validator = new ConfigValidator({
      customRules: [customRule],
    })

    const result = validator.validate(baseConfig)

    expect(result.isValid).toBe(true) // Warnings don't make it invalid
    expect(result.warnings.length).toBe(2)
    expect(result.warnings[0].code).toBe('MISSING_ICON_CLS')
    expect(result.warnings[0].suggestion).toBe(
      'Add iconCls property for better UI representation',
    )
  })

  it('should provide suggestions for built-in errors', () => {
    const invalidConfig = {
      ...baseConfig,
      initialState: 'non-existent',
    }

    const validator = new ConfigValidator()
    const result = validator.validate(invalidConfig)

    expect(result.isValid).toBe(false)
    const error = result.errors.find((e) => e.code === 'INVALID_INITIAL_STATE')
    expect(error).toBeDefined()
    expect(error?.suggestion).toContain(
      "Ensure that 'non-existent' is defined as a root state",
    )
  })

  it('should handle errors in custom rules gracefully', () => {
    const buggyRule = {
      id: 'buggy',
      validate: () => {
        throw new Error('Boom!')
      },
    }

    const validator = new ConfigValidator({
      customRules: [buggyRule],
    })

    const result = validator.validate(baseConfig)
    expect(result.isValid).toBe(false)
    expect(result.errors[0].code).toBe('CUSTOM_RULE_ERROR')
    expect(result.errors[0].message).toContain('Rule buggy failed: Boom!')
  })
})
