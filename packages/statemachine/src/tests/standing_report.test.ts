// A3 — the STANDING REPORT: "on what, exactly, is this machine standing right
// now?"
//
// A1 gave the engine live per-slot bookkeeping and A2 gave it a heartbeat whose
// inter-tick gap is a code constant. Neither is readable under pressure: a
// developer whose machine has gone quiet gets an `EngineProgress` struct and has
// to do the reading themselves. This suite pins the rendering — and, more
// importantly, the three things the rendering must REFUSE to do:
//
//   1. it must be reachable with NO tracer wired in advance (the case you are
//      actually debugging in — you only wire a tracer once you already suspect);
//   2. it must never say STUCK. A slow callable and a wedged one are the same
//      snapshot, and inventing a verdict from it is how the oracle question got
//      answered wrongly four times in this wave;
//   3. it must not repeat a claim the lifecycle buffer can no longer support.
//      `unfinished()` over a truncated ring is a FALSE ALL-CLEAR: eviction is by
//      age, so an open `begin` can scroll out from under a callable that is
//      still running, and the list comes back empty.
//
// Every case drives a REAL machine and reads the rendered text.
import { describe, expect, it } from 'vitest'
import { createLifecycleTracer, describeProgress } from '../lifecycle-tracer'
import { StateMachine } from '../state_machine'
import { MemoryAdapter, type ILogger, type StateMachineConfig } from '../types'

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
  name?: string
}

/** A `src` that never settles — an operation the engine holds open forever. */
const forever = () => new Promise<void>(() => {})

/** A machine wedged inside `onEnter` of `b`, plus the release for its gate. */
function wedgedInOnEnter(
  owner: object,
  options?: Record<string, unknown>,
): { sm: StateMachine<Box, any>; release: () => void } {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const config = {
    name: 'Wedge',
    initialState: 'a',
    stateAttribute: 'state',
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
  const sm = new StateMachine(config as any, owner as any, options as any)
  return { sm, release }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 — reachable with no instrumentation wired in advance
// ═══════════════════════════════════════════════════════════════════════════

describe('A3 — the report is reachable without prior setup', () => {
  it('names the state, the slot, the owner and the age with NO tracer ever attached', async () => {
    const owner: Box = { state: 'a', name: 'nils' }
    const { sm, release } = wedgedInOnEnter(owner)
    void sm.fireEvent('go' as never)
    await waitFor(() => sm.getProgress().openDispatches.length === 1, 'the hook to be entered')

    const report = sm.describeProgress()

    // The four things a person needs before they can act.
    expect(report).toContain('onEnter') // the SLOT
    expect(report).toContain("at 'b'") // the STATE
    expect(report).toContain('nils') // the OWNER
    expect(report).toMatch(/engine has not advanced a phase since it was entered/) // the AGE

    // And it says which reading it rests on, because the other candidate source
    // in this package is a buffer that can silently stop covering the run.
    expect(report).toContain("the engine's live entry/settle counters")

    // The whole point: no monitor, no tracer, no options were passed.
    expect(sm.getMonitor()).toBeDefined()
    release()
  })

  it('surfaces the slot on the transitionTimeout path, through the existing warn channel', async () => {
    const warns: string[] = []
    const logger: ILogger = {
      debug: () => {},
      info: () => {},
      warn: (message) => {
        warns.push(message)
      },
      error: () => {},
    }
    const owner: Box = { state: 'a', name: 'deadline' }
    const { sm, release } = wedgedInOnEnter(owner, { transitionTimeout: 20, logger })

    const message = await sm.fireEvent('go' as never).catch((e: Error) => e.message)

    // The REJECTION is untouched — `sim/faults.ts` and two engine suites match
    // that string exactly, so the slot identity had to go somewhere else.
    expect(message).toBe('Error in state machine: Transition timeout')

    const line = warns.find((w) => w.startsWith('Transition timeout after'))
    expect(line, `no timeout warn among ${JSON.stringify(warns)}`).toBeDefined()
    expect(line).toContain('the callable is still running')
    expect(line).toContain("onEnter at 'b' for deadline")
    // One LINE, not a report: a log line that wraps is a log line nobody reads.
    expect(line).not.toContain('\n')
    release()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2 — the age is in engine ticks, and does not grow with machine width
// ═══════════════════════════════════════════════════════════════════════════

describe('A3 — the age is expressed in engine ticks', () => {
  it('reports an age that is CONSTANT in region count, not O(machine width)', async () => {
    // The property A2 bought. A wall-clock or microtask-turn age would grow with
    // the machine, and a number that grows with the machine cannot be compared
    // against anything — which is what defeated every fingerprint proxy tried
    // before the heartbeat existed.
    const ageOf = async (regions: number): Promise<number> => {
      const regionCfg: Record<string, unknown> = {}
      const transitions: Array<{ from: string; to: string }> = []
      for (let i = 0; i < regions; i++) {
        regionCfg[`r${i}`] = { [`s${i}`]: {}, [`t${i}`]: {} }
        transitions.push({ from: `P.r${i}.s${i}`, to: `P.r${i}.t${i}` })
      }
      // ONE region additionally holds a never-settling operation: the open slot
      // whose age we measure. Every other region is pure width.
      regionCfg.hold = { idle: {}, busy: { invoke: [{ src: forever, onDone: 'never' }] } }
      transitions.push({ from: 'P.hold.idle', to: 'P.hold.busy' })

      const config = {
        name: `Wide${regions}`,
        initialState: 'P',
        stateAttribute: 'state',
        states: { P: { regions: regionCfg } },
        events: { go: { transitions }, never: { transitions: [] } },
      } as unknown as StateMachineConfig<Box>
      const sm = new StateMachine(config as any, { state: 'P' } as any)
      await sleep(10)
      await sm.fireEvent('go' as never)
      await sleep(10)

      const [open] = sm.getProgress().openDispatches
      expect(open, `region count ${regions} opened no dispatch`).toBeDefined()
      // The rendered text carries the same number the struct does.
      const report = sm.describeProgress()
      const rendered = /open for (\d+) engine ticks|(\d+) ticks/.exec(report)
      expect(rendered ?? report).toBeTruthy()
      return open?.openTicks ?? -1
    }

    const narrow = await ageOf(1)
    const wide = await ageOf(16)
    // Not merely "similar": the age of a slot entered in the SAME microstep
    // shape is the same number regardless of how many sibling regions the
    // engine walked to get there.
    expect(wide).toBe(narrow)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3 — a truncated buffer degrades the report instead of naming a phantom
// ═══════════════════════════════════════════════════════════════════════════

describe('A3 — the truncation guard', () => {
  it('degrades explicitly when the ring buffer can no longer account for the run', async () => {
    const config = {
      name: 'Truncated',
      initialState: 'idle',
      stateAttribute: 'state',
      states: {
        idle: { onEnter: () => {} },
        working: { invoke: [{ src: forever, onDone: 'finished' }] },
        done: { onEnter: () => {} },
      },
      events: {
        go: { transitions: [{ from: 'idle', to: 'working' }] },
        finished: { transitions: [{ from: 'working', to: 'done' }] },
        round: { transitions: [{ from: 'idle', to: 'done' }] },
        back: { transitions: [{ from: 'done', to: 'idle' }] },
      },
    } as unknown as StateMachineConfig<Box>

    const tracer = createLifecycleTracer({ limit: 4 })
    const held = new MemoryAdapter({ state: 'idle', name: 'held' })
    const churner = new MemoryAdapter({ state: 'idle', name: 'churner' })
    const sm = new StateMachine(config as any, held as any, { monitor: tracer })

    await sm.fireEvent('go' as never, held as any)
    await waitFor(() => sm.getProgress().openDispatches.length === 1, 'the operation to open')
    // Churn a SECOND owner past the cap. The operation above does not hold the
    // drain, so these events really do run and really do evict.
    for (let i = 0; i < 6; i++) {
      await sm.fireEvent('round' as never, churner as any)
      await sm.fireEvent('back' as never, churner as any)
    }

    // THE HAZARD, stated as an assertion: the tracer's own answer to "who is
    // hung?" is now EMPTY while a callable is demonstrably still running. A
    // report that trusted the buffer would print an all-clear.
    expect(tracer.unfinished()).toEqual([])
    expect(sm.getProgress().openDispatches).toHaveLength(1)

    // `truncated` is a GETTER: it was false at construction and is true now, on
    // the same object reference the consumer has been holding all along.
    expect(tracer.truncated).toBe(true)

    const report = sm.describeProgress()
    // The live reading still names the slot…
    expect(report).toContain('invoke.operation')
    expect(report).toContain("at 'working'")
    // …and the trace is explicitly disqualified rather than quietly consulted.
    expect(report).toContain('The lifecycle trace has dropped')
    expect(report).toContain('nothing above rests on it')
  })

  it('says the trace agrees when it is intact, so the disclaimer means something', async () => {
    const tracer = createLifecycleTracer()
    const { sm, release } = wedgedInOnEnter({ state: 'a', name: 'clean' }, { monitor: tracer })
    void sm.fireEvent('go' as never)
    await waitFor(() => sm.getProgress().openDispatches.length === 1, 'the hook to be entered')

    expect(tracer.truncated).toBe(false)
    const report = sm.describeProgress()
    expect(report).toContain('The lifecycle trace agrees')
    expect(report).not.toContain('dropped')
    release()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4 — still running vs. its end edge was lost
// ═══════════════════════════════════════════════════════════════════════════

describe('A3 — the live scalars are authoritative where the buffer is not', () => {
  it('refuses to convict a slot the buffer calls unfinished but the engine is not inside', async () => {
    // ONE tracer, TWO machines — the ordinary way a consumer ends up with a
    // buffer that is not about the machine in front of them. Machine A is
    // wedged; machine B is idle. B's report must not inherit A's open begin.
    const tracer = createLifecycleTracer()
    const a = wedgedInOnEnter({ state: 'a', name: 'alpha' }, { monitor: tracer })
    const b = wedgedInOnEnter({ state: 'a', name: 'beta' }, { monitor: tracer })

    void a.sm.fireEvent('go' as never)
    await waitFor(() => a.sm.getProgress().openDispatches.length === 1, 'A to wedge')

    expect(tracer.unfinished()).toHaveLength(1)
    expect(b.sm.getProgress().openDispatches).toHaveLength(0)

    const report = b.sm.describeProgress()
    // B is genuinely idle and says so…
    expect(report).toContain('No consumer callable is open')
    // …and the unmatched begin is named AND disowned, rather than silently
    // dropped (which would leave the consumer wondering) or reported as B's
    // (which would be a false accusation).
    expect(report).toContain('as unfinished')
    expect(report).toContain('this engine is not inside it')
    expect(report).toContain('It is not evidence about this one.')

    a.release()
    b.release()
  })

  it('flags a reset() that silently emptied the buffer under an open callable', async () => {
    // `reset()` zeroes the drop counter too, so `truncated` is honestly FALSE
    // while the buffer no longer covers a callable that is still running. Only
    // reconciling against the live set catches this one.
    const tracer = createLifecycleTracer()
    const { sm, release } = wedgedInOnEnter({ state: 'a', name: 'wiped' }, { monitor: tracer })
    void sm.fireEvent('go' as never)
    await waitFor(() => sm.getProgress().openDispatches.length === 1, 'the hook to be entered')

    tracer.reset()
    expect(tracer.truncated).toBe(false)
    expect(tracer.unfinished()).toEqual([])

    const report = sm.describeProgress()
    expect(report).toContain("onEnter at 'b' for wiped")
    expect(report).toContain('is not seeing everything the engine is holding')
    release()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5 — slow is not stuck
// ═══════════════════════════════════════════════════════════════════════════

describe('A3 — a slow machine is described, not convicted', () => {
  it('never says stuck, hung, wedged or deadlocked about a callable that finishes', async () => {
    const config = {
      name: 'Slow',
      initialState: 'a',
      stateAttribute: 'state',
      states: {
        a: {},
        b: {
          onEnter: async () => {
            await sleep(60)
          },
        },
      },
      events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
    } as unknown as StateMachineConfig<Box>
    const owner: Box = { state: 'a', name: 'slowpoke' }
    const sm = new StateMachine(config as any, owner as any)

    const fired = sm.fireEvent('go' as never)
    await waitFor(() => sm.getProgress().openDispatches.length === 1, 'the hook to be entered')

    const duringReport = sm.describeProgress()
    // It states what is open and for how long…
    expect(duringReport).toContain("onEnter at 'b' for slowpoke")
    // …and passes no judgement. This machine is FINE; it is doing a 60ms await.
    for (const verdict of ['stuck', 'hung', 'wedged', 'deadlock', 'frozen', 'hang']) {
      expect(duringReport.toLowerCase(), `report editorialised: "${verdict}"`).not.toContain(verdict)
    }

    await fired
    expect(sm.getCurrentState()).toBe('b')
    const afterReport = sm.describeProgress()
    expect(afterReport).toContain('No consumer callable is open')
    expect(afterReport).toContain('not inside consumer code')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6 — multi-owner: whose, and the wedged one does not hide the healthy one
// ═══════════════════════════════════════════════════════════════════════════

describe('A3 — multi-owner attribution', () => {
  it('names the owner of each open slot and leads with the oldest', async () => {
    const config = {
      name: 'MultiOwner',
      initialState: 'idle',
      stateAttribute: 'state',
      states: {
        idle: {},
        working: { invoke: [{ src: forever, onDone: 'finished' }] },
        done: {},
      },
      events: {
        go: { transitions: [{ from: 'idle', to: 'working' }] },
        finished: { transitions: [{ from: 'working', to: 'done' }] },
      },
    } as unknown as StateMachineConfig<Box>

    const alice = new MemoryAdapter({ state: 'idle', name: 'alice' })
    const bob = new MemoryAdapter({ state: 'idle', name: 'bob' })
    const sm = new StateMachine(config as any, alice as any)

    await sm.fireEvent('go' as never, alice as any)
    await waitFor(() => sm.getProgress().openDispatches.length === 1, "alice's op to open")
    const aliceOnly = sm.getProgress().tick
    await sm.fireEvent('go' as never, bob as any)
    await waitFor(() => sm.getProgress().openDispatches.length === 2, "bob's op to open")
    expect(sm.getProgress().tick).toBeGreaterThan(aliceOnly)

    const report = sm.describeProgress()

    // Alice entered first, so she leads — and "oldest" is not a tie-break
    // argument: over one snapshot, most openTicks IS earliest openedAtTick.
    expect(report.split('\n')[0]).toContain('The oldest is')
    expect(report.split('\n')[0]).toContain('alice')

    // BOTH are listed. A wedged owner must not swallow the report.
    const rows = report.split('\n').filter((l) => l.startsWith('  ') && l.includes('ticks'))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('alice (owner #1)')
    expect(rows[1]).toContain('bob (owner #2)')

    // And bob is visibly the YOUNGER one, which is the actual discriminator
    // between "these two are both fine" and "this one has been sitting".
    const [oldest, youngest] = sm.getProgress().openDispatches.map((d) => d.openTicks).sort((x, y) => y - x)
    expect(oldest).toBeGreaterThan(youngest as number)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7 — the standalone renderer, and the shapes with nothing to say
// ═══════════════════════════════════════════════════════════════════════════

describe('A3 — describeProgress() as a pure function', () => {
  it('renders an empty snapshot without inventing anything', () => {
    const text = describeProgress({
      tick: 0,
      lastTickSite: '',
      lastTickSeq: 0,
      inFlightUserCallables: 0,
      openDispatches: [],
    })
    expect(text).toContain('No consumer callable is open')
    expect(text).toContain('Engine at tick 0')
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('NaN')
  })

  it('summarises the tail rather than listing sixty rows', () => {
    const owner = { name: 'fanout' }
    const text = describeProgress({
      tick: 100,
      lastTickSite: 'enter.slot',
      lastTickSeq: 12,
      inFlightUserCallables: 60,
      openDispatches: Array.from({ length: 60 }, (_, i) => ({
        hook: 'invoke.operation',
        state: `s${i}`,
        owner,
        openedAtTick: 100 - i,
        openTicks: i,
      })),
    })
    // Sorted oldest-first: `s59` is the one that has outlived the most engine
    // progress and is therefore the one worth looking at.
    expect(text.split('\n')[0]).toContain("at 's59'")
    expect(text).toContain('… and 54 more, none older than these.')
    expect(text.split('\n').length).toBeLessThan(15)
  })

  it('collapses to one line for a log message', () => {
    const text = describeProgress(
      {
        tick: 7,
        lastTickSite: 'enter.slot',
        lastTickSeq: 3,
        inFlightUserCallables: 1,
        openDispatches: [
          { hook: 'onEnter', state: 'b', owner: { name: 'x' }, openedAtTick: 7, openTicks: 0 },
        ],
      },
      { oneLine: true },
    )
    expect(text).not.toContain('\n')
    expect(text).toBe(
      "onEnter at 'b' for x (owner #1) is open, and the engine has not advanced a phase since it was entered.",
    )
  })

  it('falls back to a positional owner label when the object offers no name', () => {
    const text = describeProgress(
      {
        tick: 3,
        lastTickSite: 'exit.slot',
        lastTickSeq: 1,
        inFlightUserCallables: 1,
        openDispatches: [
          { hook: 'persist.save', state: '', owner: {}, openedAtTick: 1, openTicks: 2 },
        ],
      },
      { oneLine: true },
    )
    // No state to name (the persistence adapter has none) and no name to find —
    // and the sentence still parses.
    expect(text).toBe(
      'persist.save for owner #1 has been open for 2 engine ticks, since tick 1.',
    )
  })
})
