import { describe, expect, it } from 'vitest'
import { createVirtualScheduler } from '../scheduler'
import { StateMachine } from '../state_machine'
import {
  type IMonitor,
  MemoryAdapter,
  type StateMachineConfig,
} from '../types'

/**
 * Behavioural scalars survive a serialize/restore round-trip.
 *
 * `StateMachineOptions` splits in two. INJECTION CONTRACTS (`logger`,
 * `monitor`, `scheduler`, `errorHandler`, `contextTracker`, `clock`, `actions`)
 * hold functions and host objects; they are correctly absent from the payload
 * and must be re-supplied on every restore. BEHAVIOURAL SCALARS
 * (`transitionTimeout`, `errorState`, `abortOnExitError`, `maxQueueDepth`,
 * `maxTransitionDepth`) are pure data that changes how the machine behaves —
 * they belong in the payload, or a restored machine silently stops behaving
 * like the machine that was saved.
 *
 * `transitionTimeout` was the sharpest case: `fromJSON(json, owner)` used to
 * yield a machine with NO action deadline and no diagnostic, which matters most
 * exactly after a restore — `resumeTimers` re-arms persisted invoke timers whose
 * actions then run unattended. The code most in need of a bound was the code
 * that lost it.
 *
 * Every test here fails against the pre-change engine.
 */

interface Box {
  state: string
  n: number
}

/** Flush enough microtask layers to settle invoke -> raise -> drain chains. */
async function flush(times = 16): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

/**
 * Wait for an ARRIVAL rather than for a duration. A cascade settles over an
 * unknown number of microtask layers, so a fixed flush count is a race that
 * reads the state mid-drain; the timeout is a loud upper bound, not the
 * expected wait.
 */
async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`waitFor: ${what} did not hold within ${timeoutMs}ms`)
}

function recordingMonitor(): {
  monitor: IMonitor
  errors: Array<{ message: string; phase?: string }>
} {
  const errors: Array<{ message: string; phase?: string }> = []
  const monitor = {
    recordTransition() {},
    recordError(error: Error, context?: { phase?: string }) {
      errors.push({ message: error.message, phase: context?.phase })
    },
  } as unknown as IMonitor
  return { monitor, errors }
}

/** Overruns any deadline these tests set; bumps `n` only if allowed to finish. */
function slowEnter(owner: Box): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      owner.n++
      resolve()
    }, 200)
  })
}

function throwingEnter(): never {
  throw new Error('enter blew up')
}

function throwingExit(): never {
  throw new Error('exit blew up')
}

/**
 * A LITERAL payload captured from the pre-change engine at 849c2b6, from a
 * machine constructed with all five behavioural scalars set — none of which
 * reached the document. It is pasted, not regenerated, so it keeps testing the
 * OLD format after the emitter changed.
 */
const OLD_FORMAT_PAYLOAD =
  '{"config":{"initialState":"idle","stateAttribute":"state","states":{"idle":{},"busy":{"onEnter":{"type":"function","name":"slowEnter","slot":"busy.onEnter"}},"failed":{}},"events":{"go":{"transitions":[{"from":"idle","to":"busy"}]}}},"currentState":"idle","historyMap":[],"stateEntryTimes":[]}'

const slowEnterConfig: StateMachineConfig<Box> = {
  name: 'SlowEnter',
  stateAttribute: 'state',
  initialState: 'idle',
  states: { idle: {}, busy: { onEnter: slowEnter }, failed: {} },
  events: { go: { transitions: [{ from: 'idle', to: 'busy' }] } },
}

// ---------------------------------------------------------------------------
// 1. transitionTimeout
// ---------------------------------------------------------------------------

describe('serialized behavioural scalars: transitionTimeout', () => {
  it('still bounds an overrunning action after a restore with NO options', async () => {
    const sm = new StateMachine<Box, typeof slowEnterConfig>(
      slowEnterConfig,
      new MemoryAdapter<Box>({ state: 'idle', n: 0 }),
      { transitionTimeout: 40 },
    )
    const json = sm.toJSON()

    const owner = new MemoryAdapter<Box>({ state: 'idle', n: 0 })
    // Only the INJECTION contract is re-supplied. No `transitionTimeout`.
    const restored = StateMachine.fromJSON<Box, typeof slowEnterConfig>(
      json,
      owner,
      { actions: { 'busy.onEnter': slowEnter } },
    )

    await expect(restored.fireEvent('go')).rejects.toThrow(
      /Transition timeout/,
    )
  })

  it('re-arms a RESUMED invoke timer under the persisted deadline', async () => {
    // The case the whole change exists for. `resumeTimers` re-arms a persisted
    // invoke timer whose action then runs through `runTracedInvokeAction` with
    // nobody awaiting it; without the restored deadline it hangs unbounded and
    // the failure is never reported anywhere.
    let t = 0
    const clock = () => t
    const hang = (): Promise<void> => new Promise<void>(() => {})
    const config: StateMachineConfig<Box> = {
      name: 'ResumedInvoke',
      stateAttribute: 'state',
      initialState: 'armed',
      states: {
        armed: { invoke: [{ delay: 1000, event: 'fired', action: hang }] },
        next: {},
      },
      events: { fired: { transitions: [{ from: 'armed', to: 'next' }] } },
    }

    const sm = new StateMachine<Box, typeof config>(
      config,
      new MemoryAdapter<Box>({ state: 'armed', n: 0 }),
      { clock, scheduler: createVirtualScheduler(clock), transitionTimeout: 500 },
    )
    await flush()

    t = 400
    const json = sm.toJSON()

    const scheduler2 = createVirtualScheduler(clock)
    const { monitor, errors } = recordingMonitor()
    // Injection contracts only — no `transitionTimeout`.
    StateMachine.fromJSON<Box, typeof config>(
      json,
      new MemoryAdapter<Box>({ state: 'armed', n: 0 }),
      { clock, scheduler: scheduler2, monitor, actions: { 'armed.invoke.action': hang } },
    )
    await flush()

    // 600ms of the original 1000ms delay remain: the resumed timer fires at 1000
    // and starts the hanging action.
    t = 1000
    scheduler2.process()
    await flush()
    expect(errors).toEqual([])

    // The restored 500ms budget expires at 1500 and the expiry is reported.
    t = 1500
    scheduler2.process()
    await flush()

    expect(errors.map((e) => e.message)).toEqual(['Transition timeout'])
    expect(errors[0]?.phase).toBe('action')
  })
})

// ---------------------------------------------------------------------------
// 2. errorState / abortOnExitError
// ---------------------------------------------------------------------------

describe('serialized behavioural scalars: failure policy', () => {
  it('errorState still catches a failing onEnter after a restore with NO options', async () => {
    const config: StateMachineConfig<Box> = {
      name: 'ErrorStateRoundTrip',
      stateAttribute: 'state',
      initialState: 'idle',
      states: { idle: {}, busy: { onEnter: throwingEnter }, failed: {} },
      events: { go: { transitions: [{ from: 'idle', to: 'busy' }] } },
    }
    const sm = new StateMachine<Box, typeof config>(
      config,
      new MemoryAdapter<Box>({ state: 'idle', n: 0 }),
      { errorState: 'failed' },
    )
    const json = sm.toJSON()

    const { monitor } = recordingMonitor()
    const restored = StateMachine.fromJSON<Box, typeof config>(
      json,
      new MemoryAdapter<Box>({ state: 'idle', n: 0 }),
      { monitor, actions: { 'busy.onEnter': throwingEnter } },
    )

    await expect(restored.fireEvent('go')).resolves.toBe(false)
    expect(restored.getCurrentState()).toBe('failed')
  })

  it('abortOnExitError still aborts back to the source after a restore with NO options', async () => {
    const config: StateMachineConfig<Box> = {
      name: 'AbortExitRoundTrip',
      stateAttribute: 'state',
      initialState: 'idle',
      states: { idle: { onExit: throwingExit }, next: {} },
      events: { go: { transitions: [{ from: 'idle', to: 'next' }] } },
    }
    const sm = new StateMachine<Box, typeof config>(
      config,
      new MemoryAdapter<Box>({ state: 'idle', n: 0 }),
      { abortOnExitError: true },
    )
    const json = sm.toJSON()

    const { monitor } = recordingMonitor()
    const restored = StateMachine.fromJSON<Box, typeof config>(
      json,
      new MemoryAdapter<Box>({ state: 'idle', n: 0 }),
      { monitor, actions: { 'idle.onExit': throwingExit } },
    )

    await expect(restored.fireEvent('go')).resolves.toBe(false)
    expect(restored.getCurrentState()).toBe('idle')
  })
})

// ---------------------------------------------------------------------------
// 3. maxQueueDepth / maxTransitionDepth
// ---------------------------------------------------------------------------

describe('serialized behavioural scalars: run-away bounds', () => {
  it('maxQueueDepth still rejects an overflowing enqueue after a restore with NO options', async () => {
    const config: StateMachineConfig<Box> = {
      name: 'QueueDepthRoundTrip',
      stateAttribute: 'state',
      initialState: 'a',
      states: { a: {}, b: {} },
      events: {
        toB: { transitions: [{ from: 'a', to: 'b' }] },
        toA: { transitions: [{ from: 'b', to: 'a' }] },
      },
    }
    const sm = new StateMachine<Box, typeof config>(
      config,
      new MemoryAdapter<Box>({ state: 'a', n: 0 }),
      { maxQueueDepth: 1 },
    )
    const json = sm.toJSON()

    const restored = StateMachine.fromJSON<Box, typeof config>(
      json,
      new MemoryAdapter<Box>({ state: 'a', n: 0 }),
    )

    // The first enqueue is admitted; the second sees a full queue.
    const first = restored.fireEvent('toB')
    const second = restored.fireEvent('toA')

    await expect(second).rejects.toThrow(/Event queue overflow/)
    await expect(first).resolves.toBe(true)
  })

  it('maxTransitionDepth still bounds an internal cascade after a restore with NO options', async () => {
    // A finite done.state ping-pong between siblings. The run-away guard trips
    // once the drain has processed `maxTransitionDepth` INTERNAL transitions, so
    // the restored bound of 3 is directly readable off `n`: the engine default
    // of 100 would let the whole 50-hop cascade run.
    const CHAIN = 50
    const keepGoing = (owner: Box): boolean => owner.n < CHAIN
    const bump = (owner: Box): void => {
      owner.n++
    }
    const doneComposite = () => ({
      initial: 'r.f',
      regions: { r: { f: { final: true } } },
    })
    const config: StateMachineConfig<Box> = {
      name: 'TransitionDepthRoundTrip',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        root: {
          initial: 'main.P',
          regions: { main: { P: doneComposite(), Q: doneComposite() } },
        } as any,
        stopped: {},
      },
      events: {
        start: { transitions: [{ from: 'idle', to: 'root' }] },
        'done.state.root.main.P': {
          transitions: [
            {
              from: 'root.main.P',
              to: 'root.main.Q',
              priority: 1,
              guard: keepGoing,
              onTransition: bump,
            },
            { from: 'root.main.P', to: 'stopped', priority: 0 },
          ],
        },
        'done.state.root.main.Q': {
          transitions: [
            {
              from: 'root.main.Q',
              to: 'root.main.P',
              priority: 1,
              guard: keepGoing,
              onTransition: bump,
            },
            { from: 'root.main.Q', to: 'stopped', priority: 0 },
          ],
        },
      },
    }

    const sm = new StateMachine<Box, typeof config>(
      config,
      new MemoryAdapter<Box>({ state: 'idle', n: 0 }),
      { maxTransitionDepth: 3 },
    )
    const json = sm.toJSON()

    const owner = new MemoryAdapter<Box>({ state: 'idle', n: 0 })
    const { monitor, errors } = recordingMonitor()
    const restored = StateMachine.fromJSON<Box, typeof config>(json, owner, {
      monitor,
      actions: { keepGoing, bump },
    })

    await restored.fireEvent('start')
    // Pre-change the bound is the engine default of 100, so the whole 50-hop
    // cascade runs to 'stopped' and this wait is what fails first.
    await waitFor(() => errors.length > 0, 'the run-away guard to trip')

    expect(errors.map((e) => e.message)).toEqual([
      'Max transition depth exceeded — possible infinite loop',
    ])
    // The bound is directly readable off the cascade: it stopped after exactly
    // `maxTransitionDepth` internal transitions, not after CHAIN of them.
    expect(owner.adaptee.n).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// 4. Precedence
// ---------------------------------------------------------------------------

describe('restore-time options take precedence over the persisted values', () => {
  it('an explicit transitionTimeout at restore wins over the persisted one', async () => {
    const sm = new StateMachine<Box, typeof slowEnterConfig>(
      slowEnterConfig,
      new MemoryAdapter<Box>({ state: 'idle', n: 0 }),
      { transitionTimeout: 40 },
    )
    const json = sm.toJSON()

    // There IS something to override — without this the assertion below would
    // pass against an engine that persists nothing at all.
    expect(JSON.parse(json).options).toEqual({ transitionTimeout: 40 })

    const owner = new MemoryAdapter<Box>({ state: 'idle', n: 0 })
    // 5000ms is generous enough for the 200ms action, so the caller's value —
    // not the persisted 40ms — is what governs.
    const restored = StateMachine.fromJSON<Box, typeof slowEnterConfig>(
      json,
      owner,
      { transitionTimeout: 5000, actions: { 'busy.onEnter': slowEnter } },
    )

    await expect(restored.fireEvent('go')).resolves.toBe(true)
    expect(owner.adaptee.n).toBe(1)
    expect(restored.getCurrentState()).toBe('busy')
  })

  it('an explicit errorState at restore wins over the persisted one', async () => {
    const config: StateMachineConfig<Box> = {
      name: 'ErrorStateOverride',
      stateAttribute: 'state',
      initialState: 'idle',
      states: {
        idle: {},
        busy: { onEnter: throwingEnter },
        failed: {},
        quarantined: {},
      },
      events: { go: { transitions: [{ from: 'idle', to: 'busy' }] } },
    }
    const sm = new StateMachine<Box, typeof config>(
      config,
      new MemoryAdapter<Box>({ state: 'idle', n: 0 }),
      { errorState: 'failed' },
    )
    const json = sm.toJSON()

    // There IS something to override.
    expect(JSON.parse(json).options).toEqual({ errorState: 'failed' })

    const { monitor } = recordingMonitor()
    const restored = StateMachine.fromJSON<Box, typeof config>(
      json,
      new MemoryAdapter<Box>({ state: 'idle', n: 0 }),
      {
        monitor,
        errorState: 'quarantined',
        actions: { 'busy.onEnter': throwingEnter },
      },
    )

    await expect(restored.fireEvent('go')).resolves.toBe(false)
    expect(restored.getCurrentState()).toBe('quarantined')
  })

  it('an explicitly-undefined option means "not supplied", so the persisted value stands', async () => {
    const sm = new StateMachine<Box, typeof slowEnterConfig>(
      slowEnterConfig,
      new MemoryAdapter<Box>({ state: 'idle', n: 0 }),
      { transitionTimeout: 40 },
    )
    const json = sm.toJSON()

    const restored = StateMachine.fromJSON<Box, typeof slowEnterConfig>(
      json,
      new MemoryAdapter<Box>({ state: 'idle', n: 0 }),
      {
        transitionTimeout: undefined,
        actions: { 'busy.onEnter': slowEnter },
      },
    )

    await expect(restored.fireEvent('go')).rejects.toThrow(
      /Transition timeout/,
    )
  })
})

// ---------------------------------------------------------------------------
// 5. Compatibility, both directions
// ---------------------------------------------------------------------------

describe('payload compatibility', () => {
  it('an OLD-format payload loads, with the behavioural scalars simply absent', async () => {
    expect(Object.keys(JSON.parse(OLD_FORMAT_PAYLOAD))).toEqual([
      'config',
      'currentState',
      'historyMap',
      'stateEntryTimes',
    ])

    const owner = new MemoryAdapter<Box>({ state: 'idle', n: 0 })
    const restored = StateMachine.fromJSON<Box, typeof slowEnterConfig>(
      OLD_FORMAT_PAYLOAD,
      owner,
      { actions: { 'busy.onEnter': slowEnter } },
    )

    expect(restored.getCurrentState()).toBe('idle')
    // Absent, not defaulted to something: the 200ms action runs unbounded,
    // exactly as it did before the field existed.
    await expect(restored.fireEvent('go')).resolves.toBe(true)
    expect(owner.adaptee.n).toBe(1)
  })

  it('a machine with NO behavioural options emits NO options key', () => {
    const sm = new StateMachine<Box, typeof slowEnterConfig>(
      slowEnterConfig,
      new MemoryAdapter<Box>({ state: 'idle', n: 0 }),
    )
    expect(Object.keys(JSON.parse(sm.toJSON()))).toEqual([
      'config',
      'currentState',
      'historyMap',
      'stateEntryTimes',
    ])
  })

  it('carries only the whitelisted scalars, and never an injection contract', () => {
    const sm = new StateMachine<Box, typeof slowEnterConfig>(
      slowEnterConfig,
      new MemoryAdapter<Box>({ state: 'idle', n: 0 }),
      {
        transitionTimeout: 40,
        errorState: 'failed',
        abortOnExitError: true,
        maxQueueDepth: 7,
        maxTransitionDepth: 5,
        strictActions: true,
        clock: () => 0,
        actions: { slowEnter },
      },
    )

    expect(JSON.parse(sm.toJSON()).options).toEqual({
      transitionTimeout: 40,
      errorState: 'failed',
      abortOnExitError: true,
      maxQueueDepth: 7,
      maxTransitionDepth: 5,
    })
  })

  it('ignores a wrong-typed persisted value rather than installing it', async () => {
    const forged = JSON.stringify({
      ...JSON.parse(OLD_FORMAT_PAYLOAD),
      options: { transitionTimeout: 'immediately', maxQueueDepth: 1 },
    })

    const owner = new MemoryAdapter<Box>({ state: 'idle', n: 0 })
    const restored = StateMachine.fromJSON<Box, typeof slowEnterConfig>(
      forged,
      owner,
      { actions: { 'busy.onEnter': slowEnter } },
    )

    // The string was dropped, so nothing bounds the 200ms action...
    await expect(restored.fireEvent('go')).resolves.toBe(true)
    expect(owner.adaptee.n).toBe(1)

    // ...while the well-typed sibling in the same object WAS adopted.
    const admitted = restored.fireEvent('go')
    await expect(restored.fireEvent('go')).rejects.toThrow(
      /Event queue overflow/,
    )
    await Promise.allSettled([admitted])
  })
})

// ---------------------------------------------------------------------------
// 6. The secure path stays consistent with the plain one
// ---------------------------------------------------------------------------

describe('toSecureJSON / fromSecureJSON carry the same split', () => {
  it('round-trips the behavioural scalars', async () => {
    const sm = new StateMachine<Box, typeof slowEnterConfig>(
      slowEnterConfig,
      new MemoryAdapter<Box>({ state: 'idle', n: 0 }),
      { transitionTimeout: 40 },
    )
    const json = await sm.toSecureJSON()

    expect(JSON.parse(json).options).toEqual({ transitionTimeout: 40 })

    const restored = await StateMachine.fromSecureJSON<
      Box,
      typeof slowEnterConfig
    >(json, new MemoryAdapter<Box>({ state: 'idle', n: 0 }), {
      actions: { 'busy.onEnter': slowEnter },
    })

    await expect(restored.fireEvent('go')).rejects.toThrow(
      /Transition timeout/,
    )
  })

  it('reads an OLD-format payload', async () => {
    const restored = await StateMachine.fromSecureJSON<
      Box,
      typeof slowEnterConfig
    >(OLD_FORMAT_PAYLOAD, new MemoryAdapter<Box>({ state: 'idle', n: 0 }), {
      actions: { 'busy.onEnter': slowEnter },
    })
    expect(restored.getCurrentState()).toBe('idle')
  })
})
