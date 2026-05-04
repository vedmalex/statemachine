import type { Adapter, StatePersistenceAdapter } from './types'

/**
 * Interface for a minimal state machine that can be updated from the adapter
 */
interface ISyncableStateMachine {
  restoreState(): Promise<void>
}

/**
 * BroadcastChannelAdapter wraps any other adapter and synchronizes state across browser tabs/windows
 */
export class BroadcastChannelAdapter<T extends object>
  implements Adapter<T>, StatePersistenceAdapter
{
  adaptee: T
  private inner: Adapter<T> & Partial<StatePersistenceAdapter>
  private channel: BroadcastChannel
  private sm?: ISyncableStateMachine

  constructor(
    inner: Adapter<T> & Partial<StatePersistenceAdapter>,
    channelName: string,
  ) {
    this.inner = inner
    this.adaptee = inner.adaptee
    this.channel = new BroadcastChannel(channelName)

    // Listen for messages from other tabs
    this.channel.onmessage = (event) => {
      const { type, property, value } = event.data

      if (type === 'SET') {
        this.inner.set(property, value)
      } else if (type === 'SAVE' && this.sm) {
        // If save notification received, restore state in current tab
        this.sm.restoreState().catch((err) => {
          console.error(
            '[BroadcastChannelAdapter] Failed to auto-restore state:',
            err,
          )
        })
      }
    }
  }

  /**
   * Bind a state machine instance to this adapter for automatic updates
   */
  bindStateMachine(sm: ISyncableStateMachine) {
    this.sm = sm
  }

  get(property: keyof T): T[keyof T] {
    return this.inner.get(property)
  }

  set(property: keyof T, value: T[keyof T]): void {
    this.inner.set(property, value)
    // Notify other tabs
    this.channel.postMessage({ type: 'SET', property, value })
  }

  async save(state?: any): Promise<void> {
    if (this.inner.save) {
      await this.inner.save(state)
      // Notify other tabs that data has been updated in storage
      this.channel.postMessage({ type: 'SAVE', state })
    }
  }

  async restore(): Promise<any> {
    if (this.inner.restore) {
      return await this.inner.restore()
    }
    return { currentState: '', history: {}, stateEntryTimes: {} }
  }

  /**
   * Close the underlying BroadcastChannel
   */
  destroy() {
    this.channel.close()
  }
}
