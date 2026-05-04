import { describe, expect, it } from 'vitest'
import { expectTypeOf } from 'vitest'

import type { StatePersistenceAdapter } from '../../index'

describe('EP-6 StatePersistenceAdapter — ABI conformance', () => {
  it('minimal in-memory stub is structurally assignable', () => {
    type PersistedState = { currentState: string; history: unknown; stateEntryTimes: unknown }
    let saved: PersistedState | undefined

    const adapter: StatePersistenceAdapter = {
      async save(state?: PersistedState): Promise<void> {
        if (state) saved = state
      },
      async restore(): Promise<PersistedState> {
        return saved ?? { currentState: '', history: [], stateEntryTimes: {} }
      },
    }
    expectTypeOf(adapter).toMatchTypeOf<StatePersistenceAdapter>()
    expect(typeof adapter.save).toBe('function')
    expect(typeof adapter.restore).toBe('function')
  })

  it('save/restore round-trip preserves all required fields', async () => {
    type PersistedState = { currentState: string; history: unknown; stateEntryTimes: unknown }
    let saved: PersistedState | undefined

    const adapter: StatePersistenceAdapter = {
      async save(state?: PersistedState): Promise<void> {
        if (state) saved = state
      },
      async restore(): Promise<PersistedState> {
        return saved ?? { currentState: '', history: [], stateEntryTimes: {} }
      },
    }

    const toSave: PersistedState = {
      currentState: 'active',
      history: ['idle'],
      stateEntryTimes: { active: 1000 },
    }
    await adapter.save(toSave)
    const restored = await adapter.restore()
    // All 3 required fields present in restored shape
    expect(restored.currentState).toBe('active')
    expect(restored.history).toEqual(['idle'])
    expect(restored.stateEntryTimes).toEqual({ active: 1000 })
  })
})
