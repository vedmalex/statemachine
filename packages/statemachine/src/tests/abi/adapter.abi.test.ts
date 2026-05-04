import { describe, expect, it } from 'vitest'
import { expectTypeOf } from 'vitest'

import type { Adapter } from '../../index'

interface TestContext { count: number; label: string }

describe('EP-4 Adapter<T> — ABI conformance', () => {
  it('minimal stub is structurally assignable', () => {
    const store = new Map<keyof TestContext, TestContext[keyof TestContext]>()
    store.set('count', 0)
    store.set('label', 'idle')

    const adapter: Adapter<TestContext> = {
      get adaptee(): TestContext {
        return { count: store.get('count') as number, label: store.get('label') as string }
      },
      get(property: keyof TestContext): TestContext[keyof TestContext] {
        return store.get(property) as TestContext[keyof TestContext]
      },
      set(property: keyof TestContext, value: TestContext[keyof TestContext]): void {
        store.set(property, value)
      },
    }
    expectTypeOf(adapter).toMatchTypeOf<Adapter<TestContext>>()
    expect(typeof adapter.get).toBe('function')
    expect(typeof adapter.set).toBe('function')
  })

  it('adaptee getter returns underlying object', () => {
    const store = new Map<keyof TestContext, TestContext[keyof TestContext]>()
    store.set('count', 42)
    store.set('label', 'active')

    const adapter: Adapter<TestContext> = {
      get adaptee(): TestContext {
        return { count: store.get('count') as number, label: store.get('label') as string }
      },
      get(property: keyof TestContext) {
        return store.get(property) as TestContext[keyof TestContext]
      },
      set(property: keyof TestContext, value: TestContext[keyof TestContext]) {
        store.set(property, value)
      },
    }
    const adaptee = adapter.adaptee
    expect(adaptee.count).toBe(42)
    expect(adaptee.label).toBe('active')
  })
})
