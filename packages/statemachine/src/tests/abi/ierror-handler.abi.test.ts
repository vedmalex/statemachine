import { describe, expect, it } from 'vitest'
import { expectTypeOf } from 'vitest'

import type { IErrorHandler } from '../../index'
import { ErrorAnalytics, type ErrorRecoveryStrategy } from '../../index'

describe('EP-3 IErrorHandler — ABI conformance', () => {
  it('minimal stub is structurally assignable', () => {
    const stub: IErrorHandler = {
      isEnabled: () => false,
      enable: () => {},
      disable: () => {},
      addRecoveryStrategy: (_strategy: ErrorRecoveryStrategy) => {},
      removeRecoveryStrategy: (_name: string) => {},
      getAnalytics: () => new ErrorAnalytics(),
    }
    expectTypeOf(stub).toMatchTypeOf<IErrorHandler>()
    expect(typeof stub.isEnabled).toBe('function')
    expect(typeof stub.enable).toBe('function')
    expect(typeof stub.disable).toBe('function')
    expect(typeof stub.addRecoveryStrategy).toBe('function')
    expect(typeof stub.removeRecoveryStrategy).toBe('function')
    expect(typeof stub.getAnalytics).toBe('function')
  })

  it('enable/disable state contract is invocable', () => {
    let enabled = false
    const handler: IErrorHandler = {
      isEnabled: () => enabled,
      enable: () => { enabled = true },
      disable: () => { enabled = false },
      addRecoveryStrategy: () => {},
      removeRecoveryStrategy: () => {},
      getAnalytics: () => new ErrorAnalytics(),
    }
    expect(handler.isEnabled()).toBe(false)
    handler.enable()
    expect(handler.isEnabled()).toBe(true)
    handler.disable()
    expect(handler.isEnabled()).toBe(false)
  })
})
