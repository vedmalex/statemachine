/**
 * @module tests/owner_detach — B3.
 *
 * `load → fire → save` over a table is the documented batch shape, and it is
 * unsound for a machine whose states arm `invoke` timers. Not because timers
 * fire later — that is what timers are — but because nothing ever told the
 * machine the row had been RELEASED. The timer armed on entry stays armed, fires
 * on its own schedule, finds the leaf still active in the object it closed over,
 * and writes a new state into a row the loop saved and moved past. The database
 * says `working`, the orphaned object says `timedOut`, and no error is raised.
 *
 * Both halves of the teardown already existed per owner (`teardownStateTimers`
 * over `activeTimersByOwner`, and `invokesFor(obj)` + `controller.abort()`), and
 * `reset` already ran them — but `reset` RE-ENTERS the initial state, re-arming
 * exactly what it just tore down. What was missing was the lifecycle boundary
 * itself: a way to say "this machine no longer manages this object".
 *
 * `detachOwner(owner)` is that boundary.
 */
import { describe, expect, it, vi } from 'vitest'
import { MemoryAdapter, createMachine, type StateMachineConfig } from '../index'

type Row = { id: number; state: string }

const timerCfg = {
  name: 'timerBatch',
  stateAttribute: 'state',
  initialState: 'idle',
  states: {
    idle: {},
    working: { invoke: [{ delay: 1000, event: 'timeout' }] },
    timedOut: {},
  },
  events: {
    start: { transitions: [{ from: 'idle', to: 'working' }] },
    timeout: { transitions: [{ from: 'working', to: 'timedOut' }] },
  },
} as unknown as StateMachineConfig<Row>

describe('B3 · detachOwner — the released-row lifecycle boundary', () => {
  it('WITHOUT detach, a timer armed for a released row still writes into it (the defect)', async () => {
    vi.useFakeTimers()
    try {
      const sm = createMachine<Row>(timerCfg as never)
      const row: Row = { id: 1, state: 'idle' }

      await sm.fireEventFor(row, 'start')
      const persisted = row.state // what `save(row)` wrote to the database
      expect(persisted).toBe('working')

      // The loop has released the row. Time passes.
      await vi.advanceTimersByTimeAsync(2000)

      // The object diverged from the row that was actually saved.
      expect(row.state).toBe('timedOut')
      expect(row.state).not.toBe(persisted)
    } finally {
      vi.useRealTimers()
    }
  })

  it('detachOwner cancels the armed timer, so the released row is never written', async () => {
    vi.useFakeTimers()
    try {
      const sm = createMachine<Row>(timerCfg as never)
      const row: Row = { id: 1, state: 'idle' }

      await sm.fireEventFor(row, 'start')
      const persisted = row.state
      sm.detachOwner(row) // the loop releases the row

      await vi.advanceTimersByTimeAsync(10_000)

      expect(row.state).toBe(persisted)
      expect(row.state).toBe('working')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports what it released, and reports nothing on a second call', async () => {
    vi.useFakeTimers()
    try {
      const sm = createMachine<Row>(timerCfg as never)
      const row: Row = { id: 1, state: 'idle' }
      await sm.fireEventFor(row, 'start')

      expect(sm.detachOwner(row)).toEqual({
        timersCleared: 1,
        operationsAborted: 0,
        queuedEventsDropped: 0,
      })
      // Idempotent: there is nothing left to release.
      expect(sm.detachOwner(row)).toEqual({
        timersCleared: 0,
        operationsAborted: 0,
        queuedEventsDropped: 0,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('detaches ONE owner only — every other row keeps its live timer', async () => {
    vi.useFakeTimers()
    try {
      const sm = createMachine<Row>(timerCfg as never)
      const released: Row = { id: 1, state: 'idle' }
      const resident: Row = { id: 2, state: 'idle' }
      await sm.fireEventFor(released, 'start')
      await sm.fireEventFor(resident, 'start')

      sm.detachOwner(released)
      await vi.advanceTimersByTimeAsync(2000)

      expect(released.state).toBe('working')
      expect(resident.state).toBe('timedOut')
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts the owner’s in-flight `invoke` operation', async () => {
    let sawAbort = false
    let settled = false
    const opCfg = {
      name: 'opBatch',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        working: {
          invoke: [
            {
              src: (_adaptee: Row, signal: AbortSignal) =>
                new Promise((resolve) => {
                  signal.addEventListener('abort', () => {
                    sawAbort = true
                  })
                  setTimeout(() => {
                    settled = true
                    resolve('done')
                  }, 50)
                }),
              onDone: 'finish',
            },
          ],
        },
        finished: {},
      },
      events: {
        start: { transitions: [{ from: 'idle', to: 'working' }] },
        finish: { transitions: [{ from: 'working', to: 'finished' }] },
      },
    } as unknown as StateMachineConfig<Row>

    const sm = createMachine<Row>(opCfg as never)
    const row: Row = { id: 1, state: 'idle' }
    await sm.fireEventFor(row, 'start')
    await new Promise((r) => setTimeout(r, 10))

    const result = sm.detachOwner(row)
    expect(result.operationsAborted).toBeGreaterThan(0)
    expect(sawAbort).toBe(true)

    // Even when the operation's own promise resolves afterwards, the completion
    // event never reaches the released row.
    await new Promise((r) => setTimeout(r, 80))
    expect(settled).toBe(true)
    expect(row.state).toBe('working')
  })

  it('drops an event a timer had ALREADY raised for the owner but not yet drained', async () => {
    vi.useFakeTimers()
    try {
      const sm = createMachine<Row>(timerCfg as never)
      const row: Row = { id: 1, state: 'idle' }
      await sm.fireEventFor(row, 'start')

      // Advance the SCHEDULER only: the timer callback runs and raises
      // `timeout` into the internal queue, but the drain is a microtask that
      // has not run yet. Detaching in that window must still spare the row.
      vi.advanceTimersByTime(1500)

      const result = sm.detachOwner(row)
      expect(result.queuedEventsDropped).toBe(1)

      await vi.advanceTimersByTimeAsync(0)
      expect(row.state).toBe('working')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT touch the state field — the saved position is the machine’s last word', async () => {
    vi.useFakeTimers()
    try {
      const sm = createMachine<Row>(timerCfg as never)
      const row: Row = { id: 7, state: 'idle' }
      await sm.fireEventFor(row, 'start')
      sm.detachOwner(row)
      expect(row).toEqual({ id: 7, state: 'working' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the owner’s history — a re-adopted object starts clean', async () => {
    const histCfg = {
      name: 'histBatch',
      stateAttribute: 'state',
      initialState: 'out',
      states: {
        out: {},
        box: {
          initial: 'r.one',
          history: 'deep',
          regions: { r: { one: {}, two: {} } },
        },
      },
      events: {
        enter: { transitions: [{ from: 'out', to: 'box' }] },
        advance: { transitions: [{ from: 'box.r.one', to: 'box.r.two' }] },
        leave: { transitions: [{ from: 'box', to: 'out' }] },
      },
    } as unknown as StateMachineConfig<Row>

    const sm = createMachine<Row>(histCfg as never)
    const row: Row = { id: 1, state: 'out' }
    await sm.fireEventFor(row, 'enter')
    await sm.fireEventFor(row, 'advance')
    await sm.fireEventFor(row, 'leave')
    expect(row.state).toBe('out')

    // Still attached: re-entering restores the remembered leaf.
    await sm.fireEventFor(row, 'enter')
    expect(row.state).toBe('box.r.two')
    await sm.fireEventFor(row, 'leave')

    sm.detachOwner(row)

    // Re-adopted after detach: history is gone, so the composite `initial` wins.
    await sm.fireEventFor(row, 'enter')
    expect(row.state).toBe('box.r.one')
  })

  it('accepts an explicit Adapter as well as a raw owner', async () => {
    vi.useFakeTimers()
    try {
      const sm = createMachine<Row>(timerCfg as never)
      const adapter = new MemoryAdapter<Row>({ id: 1, state: 'idle' })
      await sm.fireEvent('start', adapter)
      expect(sm.detachOwner(adapter).timersCleared).toBe(1)
      await vi.advanceTimersByTimeAsync(2000)
      expect(adapter.get('state')).toBe('working')
    } finally {
      vi.useRealTimers()
    }
  })

  it('detaching the CONSTRUCTION owner releases its runtime and leaves the machine usable', async () => {
    vi.useFakeTimers()
    try {
      const primary: Row = { id: 0, state: 'idle' }
      const sm = createMachine<Row>(timerCfg as never, primary)
      await sm.fireEvent('start')
      expect(primary.state).toBe('working')

      expect(sm.detachOwner(primary).timersCleared).toBe(1)
      await vi.advanceTimersByTimeAsync(2000)
      expect(primary.state).toBe('working')

      // The machine still points at it: firing re-adopts the object.
      expect(sm.getCurrentState()).toBe('working')
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles a caller still awaiting a fire for the detached owner instead of hanging it', async () => {
    vi.useFakeTimers()
    try {
      const sm = createMachine<Row>(timerCfg as never)
      const row: Row = { id: 1, state: 'idle' }
      const pending = sm.fireEventDetailedFor(row, 'start')
      const dropped = sm.detachOwner(row).queuedEventsDropped
      expect(dropped).toBe(1)
      await expect(pending).resolves.toMatchObject({
        fired: false,
        reason: 'aborted',
      })
      expect(row.state).toBe('idle')
    } finally {
      vi.useRealTimers()
    }
  })
})
