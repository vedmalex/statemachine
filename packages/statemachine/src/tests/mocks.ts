/// <reference lib="dom" />

export class MockStorage {
  store: Record<string, any>
  constructor() {
    this.store = {}
  }

  getItem(key) {
    return this.store[key] || null
  }

  setItem(key, value) {
    this.store[key] = String(value)
  }

  removeItem(key) {
    delete this.store[key]
  }

  clear() {
    this.store = {}
  }
}

globalThis.localStorage = new MockStorage() as unknown as Storage
globalThis.sessionStorage = new MockStorage() as unknown as Storage

export class MockBroadcastChannel {
  name: string
  onmessage: ((event: any) => void) | null = null
  static channels: Map<string, MockBroadcastChannel[]> = new Map()

  constructor(name: string) {
    this.name = name
    const existing = MockBroadcastChannel.channels.get(name) || []
    MockBroadcastChannel.channels.set(name, [...existing, this])
  }

  postMessage(data: any) {
    const channels = MockBroadcastChannel.channels.get(this.name) || []
    channels.forEach((channel) => {
      if (channel !== this && channel.onmessage) {
        channel.onmessage({ data })
      }
    })
  }

  close() {
    const channels = MockBroadcastChannel.channels.get(this.name) || []
    MockBroadcastChannel.channels.set(
      this.name,
      channels.filter((c) => c !== this),
    )
  }
}

globalThis.BroadcastChannel = MockBroadcastChannel as any
