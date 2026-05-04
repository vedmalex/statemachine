import { describe, expect, it } from 'vitest'
import { expectTypeOf } from 'vitest'

import { validateConfig, validateConfigStrict, isValidConfig, type ValidationResult } from '../../index'
import type { StateMachineConfig } from '../../index'

interface TestCtx { state: string }

const validConfig: StateMachineConfig<TestCtx> = {
  name: 'test',
  initialState: 'idle',
  stateAttribute: 'state',
  states: { idle: {}, active: {} },
  events: { start: { transitions: [{ from: 'idle', to: 'active' }] } },
}

describe('EP-7 validateConfig — ABI conformance', () => {
  it('validateConfig returns ValidationResult for valid config', () => {
    const result = validateConfig(validConfig)
    expectTypeOf(result).toMatchTypeOf<ValidationResult>()
    expect(typeof result.isValid).toBe('boolean')
    expect(result.isValid).toBe(true)
  })

  it('validateConfigStrict returns ValidationResult for valid config', () => {
    const result = validateConfigStrict(validConfig)
    expectTypeOf(result).toMatchTypeOf<ValidationResult>()
    expect(result.isValid).toBe(true)
  })

  it('isValidConfig returns boolean for valid config', () => {
    const result = isValidConfig(validConfig)
    expectTypeOf(result).toMatchTypeOf<boolean>()
    expect(result).toBe(true)
  })

  it('validateConfig catches invalid config', () => {
    const invalidConfig = {
      ...validConfig,
      initialState: 'nonexistent' as keyof typeof validConfig.states,
    }
    const result = validateConfig(invalidConfig)
    expect(typeof result.isValid).toBe('boolean')
  })
})
