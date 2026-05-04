import { describe, expect, it } from 'vitest'
import { expectTypeOf } from 'vitest'

import type { ITimerScheduler } from '../../index'

describe('EP-2 ITimerScheduler — ABI conformance', () => {
  it('minimal stub is structurally assignable', () => {
    const stub: ITimerScheduler = {
      isActive: () => false,
      schedule: (_delay: number, _callback: () => void): object => ({}),
      cancel: (_token: object) => {},
    }
    expectTypeOf(stub).toMatchTypeOf<ITimerScheduler>()
    expect(typeof stub.isActive).toBe('function')
    expect(typeof stub.schedule).toBe('function')
    expect(typeof stub.cancel).toBe('function')
  })

  it('schedule returns opaque token that cancel accepts', () => {
    // Token contract: schedule() returns object, cancel() accepts that object.
    const tokens: object[] = []
    const scheduler: ITimerScheduler = {
      isActive: () => tokens.length > 0,
      schedule: (_delay: number, _callback: () => void): object => {
        const token = { id: Math.random() }
        tokens.push(token)
        return token
      },
      cancel: (token: object) => {
        const idx = tokens.indexOf(token)
        if (idx !== -1) tokens.splice(idx, 1)
      },
    }
    const token = scheduler.schedule(100, () => {})
    expect(scheduler.isActive()).toBe(true)
    scheduler.cancel(token)
    expect(scheduler.isActive()).toBe(false)
  })
})
