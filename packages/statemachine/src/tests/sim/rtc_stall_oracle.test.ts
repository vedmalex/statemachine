/**
 * I-13 ENQUEUE-SCHEDULED — the opt-in RTC-stall oracle and the three engine
 * properties its one-turn bound rests on.
 *
 * ## Why this oracle is not the fifth withdrawn RTC oracle
 * Four predecessors (`stuck >= QUIET_FLUSH`, `microtask-budget`,
 * `budget-progressing`, `WAITING_ON_INTERNAL`) all read a FIXED WINDOW ELAPSING as
 * a positive observation, and each was refuted by a correct machine whose
 * legitimate frozen chain was one turn longer than the window. I-13 reads no
 * window. Its predicate
 *
 *     queue.total > 0 && isProcessingEvents() === false && inFlightAsyncCount() === 0
 *
 * has exactly two causes: a PENDING `queueMicrotask(processQueues)` (which, being
 * FIFO and setting `isProcessing = true` synchronously, is visible as `processing`
 * on the VERY NEXT sample), or nothing scheduled at all — which is the bug. The
 * threshold is therefore >= 2 MICROTASK-ADJACENT samples, and 2 is enough because
 * the self-clearing case is bounded at exactly 1 by the engine's own structure,
 * not by a measured constant.
 *
 * The tests below, in order:
 *  1. the CORRECT-machine reading: exactly ONE positive sample, and `processing`
 *     true on the sample immediately after it — the bound, observed;
 *  2. the MUTATION: the same machine with `scheduleProcessing` neutralised stalls
 *     for the rest of the budget and I-13 fires;
 *  3. the SAMPLE DEFINITION pin (`sampleCount === turns` + a single source site) —
 *     the guard against a second sampling site, which is what would make the
 *     oracle unsound;
 *  4. property 1 — `isProcessing = true` is written synchronously before any
 *     `await` in `processQueues`;
 *  5. property 2 — the run-away break clears BOTH queues, leaving no persistent
 *     violating state;
 *  6. property 3 — every enqueue is paired with a schedule (the CONVENTION guard);
 *  7. vacuity, opt-in-ness, and a zero-false-positive corpus with I-13 attached.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { ITimerScheduler } from '../../index'
import { MemoryAdapter, StateMachine, type StateMachineConfig } from '../../index'
import { makeSimClock } from '../../sim/clock'
import { makeAsyncCounter, makeEnv, makeObservableScheduler } from '../../sim/env'
import {
  INVARIANTS,
  type CheckerContext,
  buildConfigGraph,
} from '../../sim/invariants'
import { runSafety } from '../../sim/invariants.runner'
import { runSimulation } from '../../sim/public'
import {
  type SettleScheduler,
  type SettleSample,
  makeRtcStallRecorder,
  settleMacrostep,
} from '../../sim/settle'
import type { CanonicalHeader, CanonicalTrace } from '../../sim/trace'

// ── fixtures ────────────────────────────────────────────────────────────────

interface Box {
  state: string
}

/**
 * `ITimerScheduler.process` is declared OPTIONAL while `SettleScheduler.process`
 * is required; the observable shim always supplies it. Narrow once, loudly, rather
 * than casting at four call sites.
 */
function asSettleScheduler(s: ITimerScheduler): SettleScheduler {
  const fn = s.process
  if (typeof fn !== 'function') {
    throw new Error('scheduler shim exposes no process() — the settle pump cannot fire timers')
  }
  return { process: (now?: number): void => { fn.call(s, now) } }
}

/**
 * `a -(invoke delay:0, async action)-> b`. The follow-on `go` is raised from the
 * invoke timer's callback — a FLOATING microtask that was queued ahead of the
 * pump's own continuation. That is precisely the shape which makes a CORRECT
 * machine produce one positive sample: the pump's continuation runs before the
 * freshly-queued `processQueues` and sees `queue > 0 && !processing` once.
 */
function invokeChainConfig(): StateMachineConfig<Box> {
  return {
    name: 'rtc-chain',
    stateAttribute: 'state',
    initialState: 'a',
    states: {
      a: {
        invoke: [
          { delay: 0, event: 'go', action: async () => { await Promise.resolve() } },
        ],
      },
      b: {},
    },
    events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
  } as unknown as StateMachineConfig<Box>
}

/** A three-hop delay:0 re-arm chain — drives SEVERAL outer settle iterations. */
function reArmChainConfig(): StateMachineConfig<Box> {
  return {
    name: 'rtc-rearm',
    stateAttribute: 'state',
    initialState: 'a',
    states: {
      a: { invoke: [{ delay: 0, event: 'e1' }] },
      b: { invoke: [{ delay: 0, event: 'e2' }] },
      c: { invoke: [{ delay: 0, event: 'e3' }] },
      d: {},
    },
    events: {
      e1: { transitions: [{ from: 'a', to: 'b' }] },
      e2: { transitions: [{ from: 'b', to: 'c' }] },
      e3: { transitions: [{ from: 'c', to: 'd' }] },
    },
  } as unknown as StateMachineConfig<Box>
}

interface Driven {
  readonly samples: readonly SettleSample[]
  /** Turn indices at which the stall predicate held. */
  readonly positives: readonly number[]
  readonly maxRun: number
  readonly turns: number
  readonly sm: StateMachine<Box, StateMachineConfig<Box>>
}

/**
 * Construct a machine, optionally neutralise its `scheduleProcessing`, and run ONE
 * bounded `settleMacrostep` with the I-13 sample recorder attached.
 *
 * `mutate: true` is THE ENGINE MUTATION this oracle exists to catch, applied at
 * the instance seam rather than by editing the source: `processQueues`,
 * `enqueueEvent`, `enqueueDetailedEvent` and all five `raiseEvent` call sites reach
 * it through `this.scheduleProcessing()`, so an own-property override neutralises
 * every one of them. Verified equivalent to deleting the source line: a copy of
 * `state_machine.ts` with the `scheduleProcessing()` after the invoke-timer
 * `raiseEvent` physically removed produces a byte-identical sample stream and the
 * same `maxRun` as this override.
 */
async function drive(
  config: StateMachineConfig<Box>,
  opts: { mutate?: boolean; maxTurns?: number } = {},
): Promise<Driven> {
  const clock = makeSimClock(0)
  const { scheduler, view } = makeObservableScheduler(clock)
  const env = makeEnv(makeAsyncCounter(), view)
  const owner = new MemoryAdapter<Box>({ state: 'a' })
  const sm = new StateMachine<Box, StateMachineConfig<Box>>(config, owner, {
    scheduler,
    clock: clock.now,
  })
  if (opts.mutate === true) {
    ;(sm as unknown as { scheduleProcessing: () => void }).scheduleProcessing = () => {}
  }
  const samples: SettleSample[] = []
  const recorder = makeRtcStallRecorder()
  const result = await settleMacrostep({
    sm,
    scheduler: asSettleScheduler(scheduler),
    clock,
    env,
    policy: 'safety',
    maxTurns: opts.maxTurns ?? 64,
    onSample: (s) => {
      samples.push(s)
      recorder.onSample(s)
    },
  })
  const positives = samples
    .filter((s) => s.queueTotal > 0 && s.processing === false && s.inFlight === 0)
    .map((s) => s.turn)
  return {
    samples,
    positives,
    maxRun: recorder.observation().maxRun,
    turns: result.turns,
    sm,
  }
}

/** Render a sample stream for a failure message. */
const render = (ss: readonly SettleSample[]): string =>
  ss.map((s) => `${s.turn}:${s.queueTotal}|${s.processing}|${s.inFlight}`).join(' ')

// ── 1. the correct-machine reading: the one-turn window, observed ────────────

describe('I-13: a CORRECT machine produces at most ONE positive sample', () => {
  it('the invoke chain yields exactly one positive, and the NEXT sample shows processing:true', async () => {
    const d = await drive(invokeChainConfig())

    // Exactly one positive reading. This is the reading the four withdrawn RTC
    // oracles would have convicted on; I-13 does not, by construction.
    expect(d.positives.length, `stream: ${render(d.samples)}`).toBe(1)
    expect(d.maxRun).toBe(1)

    // THE MECHANISM, asserted rather than assumed: the pending processQueues that
    // made the positive reading legitimate runs on the very next turn and sets
    // `isProcessing = true` synchronously before its first await. If that write
    // ever moved past an await this assertion goes red — and so does the bound.
    const t = d.positives[0] as number
    const next = d.samples.find((s) => s.turn === t + 1)
    expect(next, `no sample after the positive at turn ${t}: ${render(d.samples)}`).toBeDefined()
    expect(next?.processing, `stream: ${render(d.samples)}`).toBe(true)
  })

  it('a plain external fireEvent yields ZERO positives (the schedule precedes the pump)', async () => {
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableScheduler(clock)
    const env = makeEnv(makeAsyncCounter(), view)
    const owner = new MemoryAdapter<Box>({ state: 'a' })
    const config = {
      name: 'rtc-flat',
      stateAttribute: 'state',
      initialState: 'a',
      states: { a: {}, b: {} },
      events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
    } as unknown as StateMachineConfig<Box>
    const sm = new StateMachine<Box, StateMachineConfig<Box>>(config, owner, {
      scheduler,
      clock: clock.now,
    })
    void sm.fireEvent('go' as never).catch(() => {})
    const recorder = makeRtcStallRecorder()
    await settleMacrostep({
      sm, scheduler: asSettleScheduler(scheduler), clock, env, policy: 'safety', maxTurns: 64,
      onSample: recorder.onSample,
    })
    // `scheduleProcessing` ran BEFORE the pump's first await, so the very first
    // sample already sees the drain in progress.
    expect(recorder.observation().maxRun).toBe(0)
    expect(recorder.observation().samples).toBeGreaterThan(0)
  })
})

// ── 2. the mutation: teeth ──────────────────────────────────────────────────

describe('I-13 HAS TEETH: an engine that enqueues without scheduling is convicted', () => {
  it('the SAME machine with scheduleProcessing neutralised stalls, and I-13 fires', async () => {
    const clean = await drive(invokeChainConfig())
    const mutant = await drive(invokeChainConfig(), { mutate: true })

    // The mutation changes NOTHING up to the enqueue: the streams agree until the
    // turn at which the clean machine's processQueues would have run.
    const t = clean.positives[0] as number
    expect(mutant.samples.slice(0, t).map((s) => `${s.queueTotal}|${s.processing}|${s.inFlight}`))
      .toEqual(clean.samples.slice(0, t).map((s) => `${s.queueTotal}|${s.processing}|${s.inFlight}`))

    // …and everything after it: the queue never drains.
    expect(mutant.maxRun, `mutant stream: ${render(mutant.samples.slice(0, 30))}`)
      .toBeGreaterThanOrEqual(2)
    expect(clean.maxRun).toBe(1)

    // The observation becomes an I-13 violation through the real registry sweep.
    const v = runSafety(INVARIANTS, traceOf(), {
      ...baseCtx(),
      rtcStall: {
        samples: mutant.samples.length,
        maxRun: mutant.maxRun,
        witnessQueueTotal: 1,
      },
    })
    expect(v?.invariantId).toBe('I-13')

    // …and the clean machine's observation does NOT.
    const clear = runSafety(INVARIANTS, traceOf(), {
      ...baseCtx(),
      rtcStall: { samples: clean.samples.length, maxRun: clean.maxRun, witnessQueueTotal: 1 },
    })
    expect(clear).toBeNull()
  })
})

// ── 3. THE SAMPLE-DEFINITION PIN ────────────────────────────────────────────

const settleSrcPath = fileURLToPath(new URL('../../sim/settle.ts', import.meta.url))
const settleSrcRaw = readFileSync(settleSrcPath, 'utf8')
/** LIVE code only — the file's own prose deliberately discusses the sampling rule. */
const settleCode = settleSrcRaw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join('\n')

describe('I-13 sample definition: ONE sample per turn, taken only after the await', () => {
  it('settle.ts CODE calls onSample from exactly ONE site', () => {
    const sites = settleCode.match(/onSample\?\.\(/g) ?? []
    expect(
      sites.length,
      'a SECOND sampling site makes two "consecutive" samples possible with NO microtask ' +
        'boundary between them (the natural one is the per-outer-iteration `prev = fingerprint()`, ' +
        'which runs after a synchronous scheduler.process and executes no await at all). ' +
        'That is exactly how the four withdrawn RTC oracles became unsound.',
    ).toBe(1)
  })

  it('the single site is preceded by `await Promise.resolve()` with no other await between', () => {
    const lines = settleCode.split('\n')
    const at = lines.findIndex((l) => l.includes('onSample?.('))
    expect(at).toBeGreaterThan(0)
    let awaitAt = -1
    for (let i = at - 1; i >= 0; i--) {
      if (/\bawait\b/.test(lines[i] as string)) {
        awaitAt = i
        break
      }
    }
    expect(awaitAt, 'no await precedes the sampling site — a sample without a microtask boundary').toBeGreaterThanOrEqual(0)
    expect((lines[awaitAt] as string).trim()).toBe('await Promise.resolve()')
  })

  it('sampleCount === SettleResult.turns on a settle spanning SEVERAL outer iterations', async () => {
    // The re-arm chain fires a delay:0 timer per hop, so the pump exits its inner
    // loop and re-enters through `scheduler.process` several times. Each of those
    // re-entries re-reads the fingerprint at `prev = fingerprint()` WITHOUT an
    // await — if that read ever emitted a sample, this equality would break.
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableScheduler(clock)
    const env = makeEnv(makeAsyncCounter(), view)
    const owner = new MemoryAdapter<Box>({ state: 'a' })
    const sm = new StateMachine<Box, StateMachineConfig<Box>>(reArmChainConfig(), owner, {
      scheduler,
      clock: clock.now,
    })
    const seen: SettleSample[] = []
    const result = await settleMacrostep({
      sm, scheduler: asSettleScheduler(scheduler), clock, env, policy: 'safety', maxTurns: 400,
      onSample: (s) => seen.push(s),
    })
    expect(result.quiescent).toBe(true)
    expect(seen.length).toBe(result.turns)
    // …and the turn indices are exactly 1..turns with no gaps or repeats.
    expect(seen.map((s) => s.turn)).toEqual(
      Array.from({ length: result.turns }, (_, i) => i + 1),
    )
    // The chain really did span several outer iterations (otherwise the pin above
    // would be exercising a single-pass settle and proving nothing).
    expect(sm.getCurrentState()).toBe('d')
  })

  it('a run cannot span two settleMacrostep calls (turn restarts at 1)', () => {
    // Between two settles the driver does arbitrary SYNCHRONOUS work — not a
    // microtask boundary — so chaining across them would be unsound.
    const rec = makeRtcStallRecorder()
    const stall = (turn: number): SettleSample => ({ turn, queueTotal: 1, processing: false, inFlight: 0 })
    rec.onSample(stall(9)) // last turn of settle A — a positive
    rec.onSample(stall(1)) // first turn of settle B — also a positive
    expect(rec.observation().maxRun).toBe(1)
    expect(rec.observation().samples).toBe(2)
  })
})

// ── 4. property 1: isProcessing = true before any await ─────────────────────

const engineSrcPath = fileURLToPath(new URL('../../state_machine.ts', import.meta.url))
const engineSrc = readFileSync(engineSrcPath, 'utf8').split('\n')

describe('I-13 premise 1: processQueues sets isProcessing SYNCHRONOUSLY before its first await', () => {
  it('structurally: the write precedes every `await` in the method body', () => {
    const start = engineSrc.findIndex((l) => l.includes('private async processQueues'))
    expect(start, 'processQueues not found — the premise cannot be checked').toBeGreaterThan(0)
    let end = start
    while (end < engineSrc.length && !(engineSrc[end] as string).startsWith('  }')) {
      end++
    }
    const body = engineSrc.slice(start, end + 1)
    const writeAt = body.findIndex((l) => l.includes('this.isProcessing = true'))
    const awaitAt = body.findIndex((l) => /\bawait\b/.test(l))
    expect(writeAt, '`this.isProcessing = true` not found in processQueues').toBeGreaterThanOrEqual(0)
    expect(awaitAt).toBeGreaterThanOrEqual(0)
    expect(
      writeAt < awaitAt,
      'a refactor moved the isProcessing write past an await: the I-13 one-turn window ' +
        'becomes UNBOUNDED and the oracle is no longer sound.',
    ).toBe(true)
  })

  it('behaviourally: one microtask after an enqueue, the machine reports processing', async () => {
    const clock = makeSimClock(0)
    const { scheduler } = makeObservableScheduler(clock)
    const owner = new MemoryAdapter<Box>({ state: 'a' })
    const config = {
      name: 'rtc-p1',
      stateAttribute: 'state',
      initialState: 'a',
      states: { a: {}, b: {} },
      events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
    } as unknown as StateMachineConfig<Box>
    const sm = new StateMachine<Box, StateMachineConfig<Box>>(config, owner, {
      scheduler,
      clock: clock.now,
    })
    void sm.fireEvent('go' as never).catch(() => {})
    // Enqueued, drain scheduled but not yet running.
    expect(sm.getQueueDepth().total).toBe(1)
    expect(sm.isProcessingEvents()).toBe(false)
    // ONE microtask later the scheduled drain has run and flipped the flag. Were
    // the write behind an await this would still read false.
    await Promise.resolve()
    expect(sm.isProcessingEvents()).toBe(true)
  })
})

// ── 5. property 2: the run-away break leaves no persistent stall ─────────────

describe('I-13 premise 2: the run-away break clears BOTH queues before breaking', () => {
  it('a run-away drain trips maxTransitionDepth and settles EMPTY — maxRun stays 0', async () => {
    const clock = makeSimClock(0)
    const { scheduler, view } = makeObservableScheduler(clock)
    const env = makeEnv(makeAsyncCounter(), view)
    const owner = new MemoryAdapter<Box>({ state: 'P' })
    const errors: string[] = []
    // Six parallel regions, each arming a delay:0 invoke. `scheduler.process` fires
    // all six timers SYNCHRONOUSLY, so six internal events land in one drain and
    // `transitionDepth` (which counts internal events PER DRAIN) blows the bound.
    // A single-state self-loop does NOT work: each re-armed timer starts a fresh
    // drain, and the counter resets per drain.
    const regions: Record<string, unknown> = {}
    const events: Record<string, unknown> = {}
    for (let i = 0; i < 6; i++) {
      regions[`r${i}`] = {
        [`w${i}`]: { invoke: [{ delay: 0, event: `e${i}` }] },
        [`d${i}`]: {},
      }
      events[`e${i}`] = { transitions: [{ from: `P.r${i}.w${i}`, to: `P.r${i}.d${i}` }] }
    }
    const config = {
      name: 'rtc-runaway',
      stateAttribute: 'state',
      initialState: 'P',
      states: { P: { regions } },
      events,
      onError: (_obj: unknown, err: Error) => { errors.push(err.message) },
    } as unknown as StateMachineConfig<Box>
    const sm = new StateMachine<Box, StateMachineConfig<Box>>(config, owner, {
      scheduler,
      clock: clock.now,
      maxTransitionDepth: 3,
    })
    const recorder = makeRtcStallRecorder()
    const result = await settleMacrostep({
      sm, scheduler: asSettleScheduler(scheduler), clock, env, policy: 'safety', maxTurns: 400,
      onSample: recorder.onSample,
    })
    // The run-away really happened (otherwise this fixture proves nothing).
    expect(errors.some((m) => /Max transition depth exceeded/.test(m)), `errors: ${errors.join(' | ')}`).toBe(true)
    // Both queues cleared before `break`, and the `finally` released the flag —
    // so the break leaves NO persistent `queue > 0 && !processing` state.
    expect(sm.getQueueDepth().total).toBe(0)
    expect(sm.isProcessingEvents()).toBe(false)
    expect(result.quiescent).toBe(true)
    expect(recorder.observation().maxRun).toBe(0)
  })
})

// ── 6. property 3: every enqueue is paired with a schedule ───────────────────

/** Lines from `at` (exclusive) up to the first `this.scheduleProcessing()`, or null. */
function pairing(at: number, window = 30): { schedAt: number; awaits: string[] } | null {
  const seg = engineSrc.slice(at, at + window)
  const k = seg.findIndex((l, i) => i > 0 && l.includes('this.scheduleProcessing()'))
  if (k < 0) {
    return null
  }
  return {
    schedAt: at + k,
    awaits: seg.slice(1, k).filter((l) => /\bawait\b/.test(l)).map((l) => l.trim()),
  }
}

describe('I-13 premise 3: every enqueue is paired with a schedule', () => {
  it('every `this.raiseEvent(` call site schedules processing with NO await in between', () => {
    const sites = engineSrc
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /this\.raiseEvent\(/.test(l))
      .map(({ i }) => i)
    expect(sites.length, 'no raiseEvent call sites found — the check has rotted').toBeGreaterThan(0)
    for (const at of sites) {
      const p = pairing(at)
      expect(p, `raiseEvent at line ${at + 1} has NO scheduleProcessing within 30 lines — ` +
        'the internal queue can grow with nothing scheduled to drain it (the I-13 witness)').not.toBeNull()
      expect(
        p?.awaits,
        `raiseEvent at line ${at + 1} is separated from its scheduleProcessing by an await: ` +
          'a sample can land in the gap and the pairing is no longer atomic',
      ).toEqual([])
    }
  })

  it('every `externalQueue.push(` schedules processing with NO await in between', () => {
    const sites = engineSrc
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.includes('externalQueue.push('))
      .map(({ i }) => i)
    expect(sites.length).toBeGreaterThan(0)
    for (const at of sites) {
      const p = pairing(at)
      expect(p, `externalQueue.push at line ${at + 1} has no scheduleProcessing`).not.toBeNull()
      expect(p?.awaits, `externalQueue.push at line ${at + 1} is separated by an await`).toEqual([])
    }
  })

  it('the pairing is a CONVENTION, not a structure — this test IS the guard', () => {
    // `raiseEvent` pushes onto the internal queue and does NOT schedule; its call
    // sites do. There are therefore exactly two `internalQueue.push(` sites and
    // NEITHER is self-pairing:
    //   - the one inside `raiseEvent` (covered by the call-site check above);
    //   - the `type === 'internal'` branch of `enqueueEvent`, which is DEAD (see
    //     the next assertion) and is the ONLY unpaired push in the engine.
    // Folding `scheduleProcessing` into `raiseEvent` would turn this five-site
    // convention into a compile-shape guarantee. Until that happens, this test is
    // the only thing standing between a dropped call and a silently wedged queue.
    const pushes = engineSrc
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.includes('internalQueue.push('))
    expect(pushes.length).toBe(2)
    for (const { i } of pushes) {
      expect(pairing(i), `internalQueue.push at line ${i + 1} now self-pairs — if raiseEvent was ` +
        'given its own scheduleProcessing, relax this expectation (the guarantee got STRONGER)').toBeNull()
    }
  })

  it('the unpaired `enqueueEvent` internal branch is DEAD (every caller passes "external")', () => {
    const callers = engineSrc.filter((l) => /this\.enqueueEvent\(/.test(l))
    expect(callers.length, 'no enqueueEvent call sites found — the check has rotted').toBeGreaterThan(0)
    for (const l of callers) {
      expect(
        l,
        'a caller now reaches enqueueEvent with a non-external type: that branch pushes onto ' +
          'the internal queue and NEVER schedules processing — an immediate I-13 witness',
      ).toContain("'external'")
    }
  })
})

// ── 7. vacuity, opt-in-ness, and no false positives ─────────────────────────

const HEADER: CanonicalHeader = {
  seed: '0',
  configHash: 'deadbeefdeadbeef',
  engine: '@vedmalex/statemachine',
  version: '6',
  runtime: 'node-test',
  prngVersion: 'splitmix64-bigint-v1',
  errorHandlerEnabled: true,
}
const traceOf = (): CanonicalTrace => ({
  header: HEADER,
  frames: [
    {
      step: 1, t: 0, cause: 'external', from: 'a', to: 'a',
      queue: { internal: 0, external: 0 }, quiescent: true,
    },
  ],
})
const baseCtx = (): CheckerContext => ({
  graph: buildConfigGraph({ states: { a: {}, b: {} }, events: { go: {} } }),
  header: HEADER,
})

describe('I-13 vacuity + opt-in-ness', () => {
  it('is VACUOUS when no sample plane is wired', () => {
    expect(runSafety(INVARIANTS, traceOf(), baseCtx())).toBeNull()
  })

  it('does NOT fire on a single positive sample (the correct-machine reading)', () => {
    const v = runSafety(INVARIANTS, traceOf(), {
      ...baseCtx(),
      rtcStall: { samples: 50, maxRun: 1, witnessQueueTotal: 1 },
    })
    expect(v).toBeNull()
  })

  it('is NOT in the default builtin set (a regression witness must not inflate oraclesRun)', async () => {
    const setup = () => ({
      config: {
        name: 'rtc-default', stateAttribute: 'state', initialState: 's1',
        states: { s1: {}, s2: {} },
        events: { go: { transitions: [{ from: 's1', to: 's2' }] } },
      },
      owner: { state: 's1' },
    })
    const withDefaults = await runSimulation<Box>(setup as never, { seed: '1', steps: 4 })
    const withAll = await runSimulation<Box>(setup as never, { seed: '1', steps: 4, invariants: INVARIANTS })
    expect(withDefaults.ok).toBe(true)
    expect(withAll.ok).toBe(true)
    // The explicit registry runs strictly more oracles than the default set, and
    // I-13 is among the difference.
    expect(withAll.oraclesRun).toBeGreaterThan(withDefaults.oraclesRun)
    expect(INVARIANTS.some((i) => i.id === 'I-13')).toBe(true)
  })
})

describe('I-13 zero-false-positive corpus: correct machines with I-13 ATTACHED', () => {
  const CORPUS: ReadonlyArray<{ name: string; setup: () => { config: unknown; owner: Box } }> = [
    {
      name: 'flat two-state',
      setup: () => ({
        config: { name: 'c1', stateAttribute: 'state', initialState: 's1', states: { s1: {}, s2: {} }, events: { go: { transitions: [{ from: 's1', to: 's2' }] } } },
        owner: { state: 's1' },
      }),
    },
    {
      name: 'guard-blocked transition',
      setup: () => ({
        config: { name: 'c2', stateAttribute: 'state', initialState: 's1', states: { s1: {}, s2: {} }, events: { go: { transitions: [{ from: 's1', to: 's2', guard: () => false }] } } },
        owner: { state: 's1' },
      }),
    },
    {
      name: 'zero-delay invoke chain with an async action',
      setup: () => ({ config: invokeChainConfig(), owner: { state: 'a' } }),
    },
    {
      name: 'three-hop delay:0 re-arm chain',
      setup: () => ({ config: reArmChainConfig(), owner: { state: 'a' } }),
    },
    {
      name: 'parallel regions reaching a join',
      setup: () => ({
        config: {
          name: 'c5', stateAttribute: 'state', initialState: 'C',
          states: {
            C: { regions: { r1: { w1: {}, d1: { final: true } }, r2: { w2: {}, d2: { final: true } } } },
            after: { final: true },
          },
          events: {
            f1: { transitions: [{ from: 'C.r1.w1', to: 'C.r1.d1' }] },
            f2: { transitions: [{ from: 'C.r2.w2', to: 'C.r2.d2' }] },
            'done.state.C': { transitions: [{ from: 'C', to: 'after' }] },
          },
        },
        owner: { state: 'C' },
      }),
    },
    {
      name: 'wide parallel machine with hooks (the O(width) frozen-chain shape)',
      setup: () => ({
        config: {
          name: 'c6', stateAttribute: 'state', initialState: 'P',
          states: {
            P: {
              regions: {
                a: { a1: { onEnter: async () => { await Promise.resolve() } }, a2: {} },
                b: { b1: { onExit: async () => { await Promise.resolve() } }, b2: {} },
                c: { c1: {}, c2: {} },
                d: { d1: {}, d2: {} },
              },
            },
          },
          events: {
            step: {
              transitions: [
                { from: 'P.a.a1', to: 'P.a.a2' },
                { from: 'P.b.b1', to: 'P.b.b2' },
                { from: 'P.c.c1', to: 'P.c.c2' },
                { from: 'P.d.d1', to: 'P.d.d2' },
              ],
            },
          },
        },
        owner: { state: 'P' },
      }),
    },
  ]

  for (const seed of ['1', '7', '42']) {
    for (const entry of CORPUS) {
      it(`[seed ${seed}] '${entry.name}' → no I-13 violation`, async () => {
        const result = await runSimulation<Box>(entry.setup as never, {
          seed,
          steps: 12,
          mode: 'both',
          invariants: INVARIANTS,
        })
        const violation = (result as { violation?: { invariantId?: string } }).violation
        expect(
          violation?.invariantId,
          `I-13 false positive on a correct machine — this is the fifth failure mode, STOP.`,
        ).not.toBe('I-13')
        expect(result.oraclesRun).toBeGreaterThan(0)
      })
    }
  }
})
