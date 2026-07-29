import { describe, expect, it } from 'vitest'
import { StateMachine } from '../state_machine'
import type {
  IMonitor,
  LifecycleEvent,
  StateMachineConfig,
  StatePersistenceAdapter,
} from '../types'

/**
 * A1 / A2 BEHAVIOUR suite — the observable half of what the source scan pins
 * structurally.
 *
 * Four claims are exercised here, each of which was FALSE before this wave:
 *  1. the four consumer slots the lifecycle channel could not see — the
 *     event/transition callbacks, a consumer `onError`, `invoke[].cond`, and the
 *     persistence adapter — now emit paired spans;
 *  2. a `transitionTimeout` that wins its race NO LONGER closes the callback's
 *     span. The body is still running, so the `begin` stays open and the deadline
 *     is reported as its own point pair;
 *  3. the progress heartbeat advances on engine phases only, and names the
 *     consumer callable holding the drain when it does not advance;
 *  4. the in-flight count is a live scalar that returns to zero.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(5)
  }
  throw new Error(`waitFor: ${what} did not hold within ${timeoutMs}ms`)
}

interface Box {
  state: string
}

/** A recording monitor — declaring `recordLifecycle` switches the channel on. */
function recordingMonitor(): IMonitor & { readonly records: LifecycleEvent[] } {
  const records: LifecycleEvent[] = []
  return {
    records,
    recordTransition: () => {},
    recordError: () => {},
    recordLifecycle: (e) => {
      records.push(e)
    },
  }
}

/** `kind/hook` -> counts of each edge. */
function inventory(records: readonly LifecycleEvent[]): Map<string, { begin: number; end: number }> {
  const out = new Map<string, { begin: number; end: number }>()
  for (const r of records) {
    const key = `${r.kind}/${r.hook}`
    const cell = out.get(key) ?? { begin: 0, end: 0 }
    if (r.edge === 'begin') cell.begin += 1
    else cell.end += 1
    out.set(key, cell)
  }
  return out
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 — the slots A1 added
// ═══════════════════════════════════════════════════════════════════════════

describe('A1 — the consumer slots that had no span before the funnel', () => {
  it('spans the event/transition callbacks, a consumer onError, and invoke[].cond', async () => {
    const monitor = recordingMonitor()
    const config = {
      name: 'a1-slots',
      stateAttribute: 'state',
      initialState: 'a',
      states: {
        a: {
          invoke: [{ cond: () => true, src: async () => 'v', onDone: 'settled' }],
        },
        b: {},
      },
      events: {
        go: {
          onBefore: async () => {},
          onAfter: async () => {},
          transitions: [{ from: 'a', to: 'b', onTransition: async () => {} }],
        },
        settled: { transitions: [{ from: 'a', to: 'a' }] },
      },
    } as unknown as StateMachineConfig<Box>

    const sm = StateMachine.fromData<Box, typeof config>(config, 'a', { state: 'a' }, { monitor })
    await waitFor(
      () => monitor.records.some((r) => r.hook === 'invoke.operation' && r.edge === 'end'),
      'invoke.src settled',
    )
    await sm.fireEvent('go' as never)
    await sleep(20)

    const inv = inventory(monitor.records)
    // Each of these was NOT observable at all before A1 — the channel's own doc
    // used to list them under "what this channel does NOT see".
    for (const slot of [
      'transition/onBefore',
      'transition/onTransition',
      'transition/onAfter',
      'invoke/invoke.cond',
    ]) {
      const cell = inv.get(slot)
      expect(cell, `no records for ${slot}`).toBeDefined()
      expect(cell?.begin, `${slot} begin`).toBeGreaterThan(0)
      // Every span PAIRS: a begin with no end is the reserved hung-callback shape.
      expect(cell?.end, `${slot} unpaired`).toBe(cell?.begin)
    }
  })

  it('spans a consumer onError handler (kind:error), and NOT the engine default rethrow', async () => {
    const withHandler = recordingMonitor()
    const withoutHandler = recordingMonitor()

    const make = (monitor: IMonitor, onError?: () => void) => {
      const config = {
        name: 'a1-onerror',
        stateAttribute: 'state',
        initialState: 'a',
        states: {
          a: {},
          b: {
            onEnter: () => {
              throw new Error('boom')
            },
          },
        },
        events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
        ...(onError ? { onError } : {}),
      } as unknown as StateMachineConfig<Box>
      return StateMachine.fromData<Box, typeof config>(config, 'a', { state: 'a' }, { monitor })
    }

    await make(withHandler, () => {})
      .fireEvent('go' as never)
      .catch(() => {})
    await make(withoutHandler)
      .fireEvent('go' as never)
      .catch(() => {})
    await sleep(20)

    expect(withHandler.records.some((r) => r.kind === 'error' && r.hook === 'onError')).toBe(true)
    // The engine's own rethrow is NOT consumer code. Reporting it would make the
    // in-flight reading claim engine work as a pending consumer callback.
    expect(withoutHandler.records.some((r) => r.kind === 'error')).toBe(false)
  })

  it('spans the persistence adapter save/restore round trip', async () => {
    const monitor = recordingMonitor()
    let saved: unknown
    const adapter: StatePersistenceAdapter = {
      save: async (data) => {
        saved = data
      },
      restore: async () => saved as never,
    }
    const config = {
      name: 'a1-persist',
      stateAttribute: 'state',
      initialState: 'a',
      states: { a: {}, b: {} },
      events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
    } as unknown as StateMachineConfig<Box>

    const sm = StateMachine.fromData<Box, typeof config>(config, 'a', { state: 'a' }, { monitor })
    await sm.fireEvent('go' as never)
    await sm.saveState(adapter)
    await sm.restoreState(adapter)

    const inv = inventory(monitor.records)
    expect(inv.get('persist/persist.save')).toEqual({ begin: 1, end: 1 })
    expect(inv.get('persist/persist.restore')).toEqual({ begin: 1, end: 1 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2 — the timeout zombie
// ═══════════════════════════════════════════════════════════════════════════

describe('A1 — a transitionTimeout no longer closes the span of a running body', () => {
  it('keeps the callback span OPEN past the deadline and closes it at the BODY settle', async () => {
    const monitor = recordingMonitor()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })

    const config = {
      name: 'a1-timeout',
      stateAttribute: 'state',
      initialState: 'a',
      states: {
        a: {},
        b: {
          onEnter: async () => {
            await gate
          },
        },
      },
      events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
    } as unknown as StateMachineConfig<Box>

    const sm = StateMachine.fromData<Box, typeof config>(config, 'a', { state: 'a' }, {
      monitor,
      transitionTimeout: 20,
    })

    const fired = sm.fireEvent('go' as never).catch((e: Error) => e.message)
    await waitFor(
      () => monitor.records.some((r) => r.hook === 'onEnter.timeout'),
      'the deadline point pair',
    )

    const onEnterEdges = () =>
      monitor.records.filter((r) => r.hook === 'onEnter').map((r) => r.edge)

    // THE REGRESSION THIS PINS: before A1 the `end` was attached to the RACE, so a
    // deadline win reported the callback as settled while its body ran on.
    expect(onEnterEdges()).toEqual(['begin'])
    // The deadline is reported instead — as an adjacent point pair, so `edge`
    // stays a two-member union and "a begin with no end" keeps meaning HUNG.
    expect(monitor.records.filter((r) => r.hook === 'onEnter.timeout').map((r) => r.edge)).toEqual([
      'begin',
      'end',
    ])
    // And the live scalar agrees: one consumer callable is still in flight.
    const mid = sm.getProgress()
    expect(mid.inFlightUserCallables).toBe(1)
    expect(mid.openDispatches.map((d) => `${d.hook}@${d.state}`)).toEqual(['onEnter@b'])
    expect(await fired).toContain('Transition timeout')

    release()
    await waitFor(() => onEnterEdges().length === 2, 'the body finally settling')
    expect(onEnterEdges()).toEqual(['begin', 'end'])
    const done = sm.getProgress()
    expect(done.inFlightUserCallables).toBe(0)
    expect(done.openDispatches).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3 / 4 — the heartbeat and the live scalars
// ═══════════════════════════════════════════════════════════════════════════

describe('A2 — the engine progress heartbeat', () => {
  it('advances monotonically on engine phases and names what is holding the drain', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const config = {
      name: 'a2-heartbeat',
      stateAttribute: 'state',
      initialState: 'a',
      states: {
        a: {},
        b: {
          onEnter: async () => {
            await gate
          },
        },
      },
      events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
    } as unknown as StateMachineConfig<Box>

    const sm = StateMachine.fromData<Box, typeof config>(config, 'a', { state: 'a' })
    // A machine with no hooks and no invoke does NO drain-plane hop at
    // construction, so `0` here is the honest reading, not a missing tick.
    const afterInit = sm.getProgress().tick
    expect(afterInit).toBe(0)

    const fired = sm.fireEvent('go' as never)
    await waitFor(() => sm.getProgress().openDispatches.length === 1, 'the hook to be entered')

    const held = sm.getProgress()
    expect(held.tick).toBeGreaterThanOrEqual(afterInit)
    const [open] = held.openDispatches
    expect(open?.hook).toBe('onEnter')
    expect(open?.state).toBe('b')
    expect(open?.openedAtTick).toBeLessThanOrEqual(held.tick)
    expect(open?.openTicks).toBe(held.tick - (open?.openedAtTick ?? 0))
    // The engine is NOT advancing while a consumer hook holds the drain — which is
    // the whole diagnostic: "the tick has not moved AND this span is open".
    await sleep(30)
    expect(sm.getProgress().tick).toBe(held.tick)

    release()
    await fired
    await sleep(20)
    const after = sm.getProgress()
    expect(after.tick).toBeGreaterThan(held.tick)
    expect(after.inFlightUserCallables).toBe(0)
    expect(after.openDispatches).toEqual([])
    expect(sm.getCurrentState()).toBe('b')
  })

  it('the inter-tick gap is CONSTANT in machine width where the old fingerprint was linear', async () => {
    // The measurement that refutes every fixed-window proxy tried in this wave.
    // A flat N-region machine exits every region in ONE microstep; the settle
    // fingerprint `queueDepth|isProcessing|inFlight` is frozen for the whole
    // microstep, so its longest frozen run grows with N. The heartbeat does not.
    const measure = async (regions: number) => {
      const regionCfg: Record<string, unknown> = {}
      const transitions: Array<{ from: string; to: string }> = []
      for (let i = 0; i < regions; i++) {
        regionCfg[`r${i}`] = { [`s${i}`]: {}, [`t${i}`]: {} }
        transitions.push({ from: `P.r${i}.s${i}`, to: `P.r${i}.t${i}` })
      }
      const config = {
        name: `wide${regions}`,
        stateAttribute: 'state',
        initialState: 'P',
        states: { P: { regions: regionCfg } },
        events: { go: { transitions } },
      } as unknown as StateMachineConfig<Box>
      const sm = StateMachine.fromData<Box, typeof config>(config, undefined, { state: 'P' })
      await sleep(10)

      const fingerprint = (): string =>
        `${sm.getQueueDepth().total}|${sm.isProcessingEvents()}`
      let maxFrozenFingerprint = 0
      let maxFrozenTick = 0
      let runF = 0
      let runT = 0
      let prevF = fingerprint()
      let prevT = sm.getProgress().tick
      const fired = sm.fireEvent('go' as never)
      for (let turn = 0; turn < 4096; turn++) {
        await Promise.resolve()
        const pending = sm.getQueueDepth().total > 0 || sm.isProcessingEvents()
        const f = fingerprint()
        const t = sm.getProgress().tick
        if (!pending) {
          if (turn > 40) break
          runF = 0
          runT = 0
          prevF = f
          prevT = t
          continue
        }
        if (f === prevF) maxFrozenFingerprint = Math.max(maxFrozenFingerprint, ++runF)
        else {
          runF = 0
          prevF = f
        }
        if (t === prevT) maxFrozenTick = Math.max(maxFrozenTick, ++runT)
        else {
          runT = 0
          prevT = t
        }
      }
      await fired
      return { maxFrozenFingerprint, maxFrozenTick }
    }

    const narrow = await measure(2)
    const wide = await measure(16)

    // The OLD proxy grows with the machine's own width — this is exactly why every
    // fixed N-turn window was refuted by a CORRECT machine one region wider.
    expect(wide.maxFrozenFingerprint).toBeGreaterThan(narrow.maxFrozenFingerprint * 4)
    expect(wide.maxFrozenFingerprint).toBeGreaterThan(64)
    // The NEW signal does not. Ticks sit adjacent to the drain's own awaits, so
    // the gap is a property of the engine's code, not of the config's shape.
    expect(wide.maxFrozenTick).toBe(narrow.maxFrozenTick)
    expect(wide.maxFrozenTick).toBeLessThanOrEqual(4)
  })
})
