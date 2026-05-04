import { createMachine, type StatePersistenceAdapter } from '@vedmalex/statemachine'
import { writeFile, readFile, access } from 'node:fs/promises'

interface PersistentContext { state: string }

// Custom StatePersistenceAdapter saving state to a JSON file — demonstrates EP-6.
// Verified contract: history and stateEntryTimes are REQUIRED fields on the shape.
type PersistedState = {
  currentState: string
  history: unknown
  stateEntryTimes: unknown
}

class JsonFileAdapter implements StatePersistenceAdapter {
  constructor(private path: string) {}

  async save(state?: PersistedState): Promise<void> {
    if (!state) return
    await writeFile(this.path, JSON.stringify(state))
  }

  async restore(): Promise<PersistedState> {
    try {
      await access(this.path)
      const data = await readFile(this.path, 'utf8')
      return JSON.parse(data) as PersistedState
    } catch {
      // Return empty state with all required fields populated.
      return { currentState: '', history: [], stateEntryTimes: {} }
    }
  }
}

const fileAdapter = new JsonFileAdapter('/tmp/statemachine-state.json')
const context: PersistentContext = { state: 's' }

const m = createMachine<PersistentContext>({
  name: 'persistent',
  initialState: 's',
  stateAttribute: 'state',
  states: { s: {} },
  events: {},
}, context)

// Demonstrate adapter wiring (actual integration via machine.saveState/restoreState):
await fileAdapter.save({ currentState: 'persistent.s', history: [], stateEntryTimes: { s: Date.now() } })
const restored = await fileAdapter.restore()
console.log('Persistence example: currentState =', m.currentState)
console.log('Persistence example: restored state =', restored.currentState)
