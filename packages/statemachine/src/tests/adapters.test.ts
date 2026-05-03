import { describe, expect, it, spyOn } from 'bun:test'
import { BroadcastChannelAdapter } from '../adapters'
import { StateMachine } from '../state_machine'
import { LocalStorageAdapter, MemoryAdapter } from '../types'
import './mocks'

describe('BroadcastChannelAdapter', () => {
  const config = {
    name: 'test',
    stateAttribute: 'state',
    initialState: 'idle',
    states: {
      idle: {},
      busy: {},
    },
    events: {
      work: {
        transitions: [{ from: 'idle', to: 'busy' }],
      },
    },
  } as any

  it('should synchronize SET operations between adapters', () => {
    const data1 = { state: 'idle', val: 1 }
    const data2 = { state: 'idle', val: 1 }

    const inner1 = new MemoryAdapter(data1)
    const inner2 = new MemoryAdapter(data2)

    const adapter1 = new BroadcastChannelAdapter(inner1, 'test_channel')
    const adapter2 = new BroadcastChannelAdapter(inner2, 'test_channel')

    adapter1.set('val', 2)

    expect(data1.val).toBe(2)
    expect(data2.val).toBe(2)

    adapter1.destroy()
    adapter2.destroy()
  })

  it('should trigger restoreState on other state machines when save is called', async () => {
    const data1 = { state: 'idle' }
    const data2 = { state: 'idle' }

    // Use LocalStorageAdapter as inner to actually persist data in mock storage
    const inner1 = new LocalStorageAdapter(data1, 'sync_test')
    const inner2 = new LocalStorageAdapter(data2, 'sync_test')

    const adapter1 = new BroadcastChannelAdapter(inner1, 'sync_channel')
    const adapter2 = new BroadcastChannelAdapter(inner2, 'sync_channel')

    const sm1 = new StateMachine(config, adapter1)
    const sm2 = new StateMachine(config, adapter2)

    adapter1.bindStateMachine(sm1)
    adapter2.bindStateMachine(sm2)

    const restoreSpy = spyOn(sm2, 'restoreState')

    // Transition sm1 to busy and save
    await sm1.fireEvent('work')
    await sm1.saveState()

    expect(sm1.currentState).toBe('busy')

    // Check if sm2.restoreState was called automatically
    expect(restoreSpy).toHaveBeenCalled()

    // sm2 should now also be in 'busy' state because they share the same storage key in LocalStorage
    expect(sm2.currentState).toBe('busy')

    adapter1.destroy()
    adapter2.destroy()
  })
})
