/**
 * Step 2 — Adapter-write capture seam tests (TASK-014, ADR-3 C / R1).
 *
 * Proves the harness-owned wrapper of consumer Adapter.set observes EVERY engine
 * state-write as a raw (from,to) pair across all THREE write sites
 * (:1116 shallow-history, :1126 deep-history, :1204 setCurrentStateInternal)
 * plus the errorState fallback (:2020, which bypasses :2060 recordTransition),
 * while non-state-attribute writes pass through unobserved and isAdapter stays
 * true.
 */

import { describe, expect, it } from 'vitest'
import { type CapturedWrite, wrapAdapterForCapture } from '../../sim/capture'
import { SimMonitor } from '../../sim/sim-monitor'
import { StateMachine } from '../../state_machine'
import { isAdapter, MemoryAdapter, type StateMachineConfig } from '../../types'

interface Box {
  state: string
  count: number
}

function makeSink(): { writes: CapturedWrite[]; sink: { onStateWrite(w: CapturedWrite): void } } {
  const writes: CapturedWrite[] = []
  return { writes, sink: { onStateWrite: (w) => writes.push(w) } }
}

const flatConfig: StateMachineConfig<Box> = {
  name: 'Flat',
  stateAttribute: 'state',
  initialState: 'a',
  states: { a: {}, b: {} },
  events: { t: { transitions: [{ from: 'a', to: 'b' }] } },
}

// ---------------------------------------------------------------------------
// DoD#7 — :1204 internal write (post-construction reset) + documented init write
// ---------------------------------------------------------------------------
describe('capture seam — :1204 internal write', () => {
  it('records the construction-time initial write (from="" / to=initialState)', async () => {
    const owner = new MemoryAdapter<Box>({ state: '', count: 0 })
    const { writes, sink } = makeSink()
    const wrapped = wrapAdapterForCapture(owner, 'state', sink)
    // biome-ignore lint/correctness/noUnusedVariables: construction is the act under test
    const _sm = new StateMachine(flatConfig, wrapped)
    await Promise.resolve()
    // sub-assertion: the construction-time initial write is explicit, not an
    // off-by-one surprise.
    const init = writes.find((w) => w.to === 'a')
    expect(init).toBeDefined()
    expect(init?.from).toBe('') // pre-init
    expect(init?.to).toBe('a') // initialState
  })

  it('after post-construction reset, the fired transition is captured (from!==to, pre->post)', async () => {
    const owner = new MemoryAdapter<Box>({ state: '', count: 0 })
    const { writes, sink } = makeSink()
    const wrapped = wrapAdapterForCapture(owner, 'state', sink)
    const monitor = new SimMonitor()
    const sm = new StateMachine(flatConfig, wrapped, { monitor })
    await Promise.resolve()
    // reset/snapshot the sink AFTER construction settles
    writes.length = 0
    const rtBefore = monitor.getTransitionCount()
    await sm.fireEvent('t')
    await Promise.resolve()
    // exactly ONE state-CHANGING write (from!==to); any additional write is an
    // idempotent re-render (from===to) the engine performs at the composite
    // boundary.
    const changing = writes.filter((w) => w.from !== w.to)
    expect(changing).toHaveLength(1)
    expect(changing[0]?.from).toBe('a') // pre-state
    expect(changing[0]?.to).toBe('b') // post-state
    // a real transition advanced recordTransition (sanity: this is NOT the
    // errorState-bypass case)
    expect(monitor.getTransitionCount() - rtBefore).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// DoD#6 — :1116 shallow-history + :1126 deep-history restores
// ---------------------------------------------------------------------------
interface RobotBox {
  state: string
}

function robotConfig(history: 'shallow' | 'deep'): StateMachineConfig<RobotBox> {
  return {
    name: `Robot-${history}`,
    stateAttribute: 'state',
    initialState: 'robot',
    states: {
      robot: {
        initial: 'engine.off|sensors.off|mode.off',
        regions: {
          engine: { off: {}, on: {} },
          sensors: { off: {}, on: {} },
          mode: {
            off: {},
            auto: {
              initial: 'task.scanning',
              history,
              regions: { task: { scanning: {}, cleaning: {} } },
            },
            manual: {},
          },
        },
      },
      stopped: {},
    },
    events: {
      startEngine: { transitions: [{ from: 'robot.engine.off', to: 'robot.engine.on' }] },
      activateSensors: { transitions: [{ from: 'robot.sensors.off', to: 'robot.sensors.on' }] },
      startAuto: { transitions: [{ from: 'robot.mode.off', to: 'robot.mode.auto' }] },
      startCleaning: {
        transitions: [{ from: 'robot.mode.auto.task.scanning', to: 'robot.mode.auto.task.cleaning' }],
      },
      stop: {
        transitions: [
          { from: 'robot.mode.auto.task.cleaning', to: 'stopped' },
          { from: 'robot.mode.manual', to: 'stopped' },
        ],
      },
      resumeAuto: { transitions: [{ from: 'stopped', to: 'robot.mode.auto' }] },
    },
  } as StateMachineConfig<RobotBox>
}

async function driveToHistoryRestore(
  history: 'shallow' | 'deep',
): Promise<CapturedWrite[]> {
  const owner = new MemoryAdapter<RobotBox>({ state: '' })
  const { writes, sink } = makeSink()
  const wrapped = wrapAdapterForCapture(owner, 'state', sink)
  const sm = new StateMachine(robotConfig(history), wrapped)
  await sm.fireEvent('startEngine')
  await sm.fireEvent('activateSensors')
  await sm.fireEvent('startAuto')
  await sm.fireEvent('startCleaning')
  await sm.fireEvent('stop')
  // snapshot the sink right before the restoring transition
  writes.length = 0
  await sm.fireEvent('resumeAuto')
  await Promise.resolve()
  expect(sm.getCurrentState()).toBe('robot.engine.on|robot.sensors.on|robot.mode.auto.task.cleaning')
  return writes
}

describe('capture seam — history restore (:1116 / :1126)', () => {
  // The discriminating proof a :1204-ONLY seam could not give: the
  // history-restore write itself (carrying the restored deep substate
  // task.cleaning, NOT the fresh `initial` task.scanning) is captured. That
  // write is produced at :1116 (shallow) / :1126 (deep) — method-wrapping is
  // what catches it.
  it('history.shallow restore is captured via the wrapped set (:1116)', async () => {
    const writes = await driveToHistoryRestore('shallow')
    expect(writes.length).toBeGreaterThan(0)
    const restore = writes.filter((w) => w.to.includes('task.cleaning'))
    expect(restore).toHaveLength(1)
  })

  it('history.deep restore is captured via the wrapped set (:1126)', async () => {
    const writes = await driveToHistoryRestore('deep')
    expect(writes.length).toBeGreaterThan(0)
    const restore = writes.filter((w) => w.to.includes('task.cleaning'))
    expect(restore).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// DoD#8 — errorState fallback witness (:2020 bypasses :2060)
// ---------------------------------------------------------------------------
describe('capture seam — errorState fallback bypass (:2020)', () => {
  it('throwing onEnter falls back to errorState: recordTransition delta 0 while errorState write IS captured', async () => {
    const owner = new MemoryAdapter<Box>({ state: '', count: 0 })
    const { writes, sink } = makeSink()
    const wrapped = wrapAdapterForCapture(owner, 'state', sink)
    const monitor = new SimMonitor()
    const cfg: StateMachineConfig<Box> = {
      name: 'ErrorState',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        boom: { onEnter: () => { throw new Error('kaboom') } },
        safe: {},
      },
      events: { go: { transitions: [{ from: 'idle', to: 'boom' }] } },
    }
    const sm = new StateMachine(cfg, wrapped, { monitor, errorState: 'safe' })
    await Promise.resolve()
    // snapshot recordTransition count immediately before firing the throwing event
    const rtBefore = monitor.getTransitionCount()
    writes.length = 0
    try {
      await sm.fireEvent('go')
    } catch {
      // the throwing enter rejects the fire; the errorState fallback still ran
    }
    await Promise.resolve()
    // DELTA is 0 — the :2020 write bypasses :2060 recordTransition. (We compare
    // a DELTA, never lifetime totals, because the construction-time
    // setInitialState write makes captured-writes exceed recordTransition for
    // ANY run.)
    expect(monitor.getTransitionCount() - rtBefore).toBe(0)
    // a new captured write whose `to` contains the errorState appears.
    const errorWrite = writes.find((w) => w.to.includes('safe'))
    expect(errorWrite).toBeDefined()
    expect(sm.getCurrentState()).toBe('safe')
  })
})

// ---------------------------------------------------------------------------
// DoD#9 — non-state-attribute writes pass through unobserved; isAdapter true
// ---------------------------------------------------------------------------
describe('capture seam — non-state-attribute passthrough', () => {
  it('writes to a non-state attribute are unobserved and isAdapter stays true', () => {
    const owner = new MemoryAdapter<Box>({ state: 'a', count: 0 })
    const { writes, sink } = makeSink()
    const wrapped = wrapAdapterForCapture(owner, 'state', sink)
    expect(isAdapter(wrapped)).toBe(true)
    wrapped.set('count', 5)
    expect(writes).toHaveLength(0) // unobserved
    expect(wrapped.get('count')).toBe(5) // value passed through
    expect(wrapped.adaptee).toBe(owner.adaptee) // adaptee getter preserved
  })

  it('a state-attribute write IS observed (read-before-set atomicity)', () => {
    const owner = new MemoryAdapter<Box>({ state: 'a', count: 0 })
    const { writes, sink } = makeSink()
    const wrapped = wrapAdapterForCapture(owner, 'state', sink)
    wrapped.set('state', 'b')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toEqual({ from: 'a', to: 'b' })
    expect(wrapped.get('state')).toBe('b')
  })

  it('an absent (undefined) prior state reads as from="" (nullish fallback)', () => {
    // a hand-rolled Adapter whose state attribute reads `undefined` before the
    // first write — exercises the `?? ''` read-before-set fallback so a
    // freshly-constructed owner does not surface `from: 'undefined'`.
    const store: { state?: string } = {}
    const bareAdapter = {
      get adaptee() {
        return store as Box
      },
      get(property: keyof Box): Box[keyof Box] {
        return store[property as 'state'] as Box[keyof Box]
      },
      set(property: keyof Box, value: Box[keyof Box]): void {
        store[property as 'state'] = value as string
      },
    }
    const { writes, sink } = makeSink()
    const wrapped = wrapAdapterForCapture(bareAdapter, 'state', sink)
    wrapped.set('state', 'first')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toEqual({ from: '', to: 'first' })
  })
})
