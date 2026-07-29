/**
 * @module tests/sim/check_machine_shrink — W9/Г3: delta-debugging wired into
 * `checkMachine`, producing a VERIFIED `CheckViolation.minimal` + an executable
 * repro.
 *
 * The unit under test is not "does it shrink" — `op_shrink.test.ts` already pins
 * the ddmin core. It is the INTEGRATION contract, and every describe below pins
 * one of its load-bearing promises:
 *
 *   1. a long failing run collapses to a 1-minimal op stream;
 *   2. an OBJECT payload survives minimization (the case the pre-W9 shrinker
 *      structurally could not reach);
 *   3. the printed `script` is genuinely EXECUTABLE — fed back in, it fails again;
 *   4. ABSTINENCE beats fabrication: no fresh owner / no reproduction ⇒ a
 *      `shrink-skipped` warning and NO `minimal`;
 *   5. minimization is INVISIBLE to the rest of the report (the (b) refactor
 *      insurance — a shrink replay must not contaminate the sweep's coverage,
 *      guard outcomes, saturation, or verdict);
 *   6. `SimOptions.script` replays deterministically on its own.
 */
import { describe, expect, it } from 'vitest'
import type { StateMachineConfig } from '../../index'
import { MemoryAdapter } from '../../index'
import { checkMachine } from '../../sim/check-machine'
import type { CheckOptions, CheckReport, CheckScriptOp } from '../../sim/check-machine'
import { runSimulation } from '../../sim/public'

type Box = { state: string; [k: string]: unknown }

// ═══════════════════════════════════════════════════════════════════════════
// 1. a long failing run collapses to a minimal op stream
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A machine with a NOISE self-loop (`tick`) alongside the single op that matters
 * (`go1`). The fuzzer draws freely between them, so a 60-step run records a long
 * stream of which exactly one op is load-bearing.
 */
const noisy: StateMachineConfig<Box> = {
  name: 'noisy',
  stateAttribute: 'state',
  initialState: 's1',
  states: { s1: {}, s2: {}, s3: { final: true } },
  events: {
    tick: { transitions: [{ from: 's1', to: 's1' }] },
    go1: { transitions: [{ from: 's1', to: 's2' }] },
    go2: { transitions: [{ from: 's2', to: 's3' }] },
  },
} as unknown as StateMachineConfig<Box>
const noisyOwner = (): Box => ({ state: 's1' })

describe('W9/Г3: a planted user-invariant violation minimizes to its essential ops', () => {
  it('a 60-step failing run reduces to a 1-minimal stream with provenance.minimal===true', async () => {
    const r = await checkMachine<Box>(noisy, noisyOwner, {
      seed: '11',
      steps: 60,
      runs: 1,
      mode: 'safety',
      invariants: [{ name: 'never-in-s2', check: (s) => !s.state.endsWith('s2') }],
    })

    const v = r.violations.find((x) => x.invariant === 'never-in-s2')
    expect(v).toBeDefined()
    const minimal = v?.minimal
    expect(minimal).toBeDefined()
    if (minimal === undefined) {
      return
    }
    // The ONLY way into s2 is one `go1`. A 60-op stream must collapse to it.
    expect(minimal.ops.length).toBeLessThanOrEqual(2)
    expect(minimal.ops).toContainEqual({ kind: 'fire', event: 'go1' })
    expect(minimal.provenance.minimal).toBe(true)
    expect(minimal.provenance.moves).toBeGreaterThan(0)
    // The trace is the trace OF THE MINIMAL STREAM, not of the 60-step run, and
    // it round-trips through JSON (it has to survive a report artifact).
    expect(minimal.trace.length).toBeGreaterThan(0)
    expect(() => JSON.parse(JSON.stringify(minimal.trace))).not.toThrow()
    expect(minimal.trace.some((f) => f.to.includes('s2'))).toBe(true)
  })

  it('the minimized snippet is an EXECUTABLE script call, not a bisect-it-yourself hint', async () => {
    const r = await checkMachine<Box>(noisy, noisyOwner, {
      seed: '11',
      steps: 60,
      runs: 1,
      mode: 'safety',
      invariants: [{ name: 'never-in-s2', check: (s) => !s.state.endsWith('s2') }],
    })
    const code = r.violations.find((x) => x.invariant === 'never-in-s2')?.reproCode ?? ''
    expect(code).toContain('script: [')
    expect(code).toContain(`{ kind: 'fire', event: 'go1' }`)
    expect(code).toContain('runs: 1')
    expect(code).toContain('MINIMIZED')
  })

  it('shrink:false suppresses minimization entirely (no minimal, no extra warning)', async () => {
    const r = await checkMachine<Box>(noisy, noisyOwner, {
      seed: '11',
      steps: 60,
      runs: 1,
      mode: 'safety',
      shrink: false,
      invariants: [{ name: 'never-in-s2', check: (s) => !s.state.endsWith('s2') }],
    })
    expect(r.violations.every((v) => v.minimal === undefined)).toBe(true)
    expect(r.warnings.some((w) => w.kind === 'shrink-skipped')).toBe(false)
  })

  it('an exhausted budget still yields a VERIFIED stream, honestly flagged minimal:false', async () => {
    // maxRuns:1 buys the verify-first pass and nothing more, so the search cannot
    // prove 1-minimality. The published stream must still be one that RAN.
    const r = await checkMachine<Box>(noisy, noisyOwner, {
      seed: '11',
      steps: 60,
      runs: 1,
      mode: 'safety',
      shrink: { budget: { maxRuns: 1 } },
      invariants: [{ name: 'never-in-s2', check: (s) => !s.state.endsWith('s2') }],
    })
    const minimal = r.violations.find((x) => x.invariant === 'never-in-s2')?.minimal
    expect(minimal).toBeDefined()
    expect(minimal?.provenance.minimal).toBe(false)
    expect(minimal?.ops.length).toBe(60) // nothing could be proven removable
    // ...and the snippet says so rather than claiming a minimal repro.
    const code = r.violations.find((x) => x.invariant === 'never-in-s2')?.reproCode ?? ''
    expect(code).toContain('possibly not 1-minimal')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. OBJECT payloads — the case the ScenarioSpec shrinker structurally could not
//    reach (an object collapses in a corpus memo key).
// ═══════════════════════════════════════════════════════════════════════════

type Verdict = { score: number; note: string }

const gate: StateMachineConfig<Box> = {
  name: 'Gate',
  stateAttribute: 'state',
  initialState: 'gate',
  states: { gate: {}, pass: {}, fail: {} },
  events: {
    verdict: {
      transitions: [
        {
          from: 'gate',
          to: 'pass',
          guard: (_o: Box, v: Verdict) => typeof v === 'object' && v !== null && v.score > 7,
        },
        {
          from: 'gate',
          to: 'fail',
          guard: (_o: Box, v: Verdict) => !(typeof v === 'object' && v !== null && v.score > 7),
        },
      ],
    },
    reset: { transitions: [{ from: 'pass', to: 'gate' }, { from: 'fail', to: 'gate' }] },
  },
} as unknown as StateMachineConfig<Box>

describe('W9/Г3: an OBJECT payload survives minimization', () => {
  const opts: CheckOptions<Box> = {
    seed: '5',
    steps: 40,
    runs: 1,
    mode: 'safety',
    events: [{ name: 'verdict', payload: (rng) => [{ score: rng.int(11), note: 'v' } satisfies Verdict] }],
    invariants: [{ name: 'never-pass', check: (s) => !s.state.endsWith('pass') }],
  }

  it('the minimal stream KEEPS the object args that caused the finding', async () => {
    const r = await checkMachine<Box>(gate, () => ({ state: 'gate' }), opts)
    const minimal = r.violations.find((x) => x.invariant === 'never-pass')?.minimal
    expect(minimal).toBeDefined()
    if (minimal === undefined) {
      return
    }
    // Only a payload with score>7 can reach `pass`, so the surviving fire MUST
    // carry it — proving the args rode along through the whole search.
    const fires = minimal.ops.filter((o): o is Extract<typeof o, { kind: 'fire' }> => o.kind === 'fire')
    expect(fires.length).toBeGreaterThan(0)
    const decisive = fires.find((f) => {
      const arg = f.args?.[0] as Verdict | undefined
      return arg !== undefined && arg.score > 7
    })
    expect(decisive).toBeDefined()
    expect(decisive?.args?.[0]).toMatchObject({ note: 'v' })
    expect(decisive?.argsNote).toBeUndefined() // a plain object IS printable
    expect(minimal.ops.length).toBeLessThanOrEqual(3)
  })

  it('the printed script embeds the payload as a literal', async () => {
    const r = await checkMachine<Box>(gate, () => ({ state: 'gate' }), opts)
    const code = r.violations.find((x) => x.invariant === 'never-pass')?.reproCode ?? ''
    expect(code).toContain(`{ kind: 'fire', event: 'verdict', args: [{"score":`)
    expect(code).toContain('"note":"v"')
  })

  it('a NON-printable payload still minimizes; only the SNIPPET degrades', async () => {
    // A class instance has no JSON literal that reconstructs it, so the script
    // cannot be printed — but the reduction itself never needed serialization.
    class Score {
      constructor(readonly score: number) {}
      isHigh(): boolean {
        return this.score > 7
      }
    }
    const classGate: StateMachineConfig<Box> = {
      name: 'ClassGate',
      stateAttribute: 'state',
      initialState: 'gate',
      states: { gate: {}, pass: {}, fail: {} },
      events: {
        verdict: {
          transitions: [
            { from: 'gate', to: 'pass', guard: (_o: Box, v: Score) => v instanceof Score && v.isHigh() },
            { from: 'gate', to: 'fail', guard: (_o: Box, v: Score) => !(v instanceof Score && v.isHigh()) },
          ],
        },
        reset: { transitions: [{ from: 'pass', to: 'gate' }, { from: 'fail', to: 'gate' }] },
      },
    } as unknown as StateMachineConfig<Box>

    const r = await checkMachine<Box>(classGate, () => ({ state: 'gate' }), {
      seed: '5',
      steps: 40,
      runs: 1,
      mode: 'safety',
      events: [{ name: 'verdict', payload: (rng) => [new Score(rng.int(11))] }],
      invariants: [{ name: 'never-pass', check: (s) => !s.state.endsWith('pass') }],
    })
    const v = r.violations.find((x) => x.invariant === 'never-pass')
    const minimal = v?.minimal
    expect(minimal).toBeDefined() // minimization RAN — serialization is not a precondition
    expect(minimal?.ops.length).toBeLessThanOrEqual(3)
    const fire = minimal?.ops.find((o) => o.kind === 'fire')
    expect(fire && 'argsNote' in fire ? fire.argsNote : undefined).toBe('non-serializable')
    // The snippet degrades to the seed-pinned form PLUS the op listing.
    expect(v?.reproCode).not.toContain('script: [')
    expect(v?.reproCode).toContain('MINIMIZED')
    expect(v?.reproCode).toContain('fire verdict(1 non-printable arg(s))')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. the printed script is EXECUTABLE (the whole point of the exercise)
// ═══════════════════════════════════════════════════════════════════════════

describe('W9/Г3: CheckOptions.script re-drives a minimal repro', () => {
  it('feeding minimal.ops back as `script` reproduces the finding', async () => {
    const invariants = [{ name: 'never-in-s2', check: (s: { state: string }) => !s.state.endsWith('s2') }]
    const found = await checkMachine<Box>(noisy, noisyOwner, {
      seed: '11',
      steps: 60,
      runs: 1,
      mode: 'safety',
      invariants,
    })
    const minimal = found.violations.find((x) => x.invariant === 'never-in-s2')?.minimal
    expect(minimal).toBeDefined()
    const script = (minimal?.ops ?? []) as readonly CheckScriptOp[]

    const replayed = await checkMachine<Box>(noisy, noisyOwner, {
      seed: '11',
      steps: script.length,
      runs: 1,
      mode: 'safety',
      shrink: false,
      script,
      invariants,
    })
    expect(replayed.violations.some((x) => x.invariant === 'never-in-s2' && !x.witness.includes('initial'))).toBe(true)
  })

  it('the SAME script replays to the SAME report (deterministic replay)', async () => {
    const script: readonly CheckScriptOp[] = [
      { kind: 'fire', event: 'tick' },
      { kind: 'fire', event: 'go1' },
      { kind: 'fire', event: 'go2' },
    ]
    const opts: CheckOptions<Box> = { seed: '3', steps: 3, runs: 1, mode: 'safety', shrink: false, script }
    const a = await checkMachine<Box>(noisy, noisyOwner, opts)
    const b = await checkMachine<Box>(noisy, noisyOwner, opts)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    // ...and it actually DROVE the script (s3 is reachable only via go1→go2).
    expect(a.reachableStates).toContain('s3')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. ABSTINENCE — the anti-fabrication half
// ═══════════════════════════════════════════════════════════════════════════

describe('W9/Г3: minimization ABSTAINS rather than publish an unverified repro', () => {
  it('a LIVE Adapter owner ⇒ shrink-skipped, and NO minimal is published', async () => {
    const adapter = new MemoryAdapter<Box>({ state: 's1' })
    const r = await checkMachine<Box>(noisy, adapter as never, {
      seed: '11',
      steps: 30,
      runs: 1,
      mode: 'safety',
      invariants: [{ name: 'never-in-s2', check: (s) => !s.state.endsWith('s2') }],
    })
    expect(r.violations.length).toBeGreaterThan(0)
    expect(r.violations.every((v) => v.minimal === undefined)).toBe(true)
    const w = r.warnings.find((x) => x.kind === 'shrink-skipped')
    expect(w).toBeDefined()
    expect(w?.detail).toMatch(/Adapter/)
  })

  it('a finding that does NOT reproduce on replay ⇒ shrink-skipped, and NO minimal', async () => {
    // A predicate that depends on state OUTSIDE the owner — the canonical
    // non-reproducible run. It fails on its 3rd EVER evaluation; by the time the
    // verify-first replay runs, that moment has passed forever, so the finding
    // cannot come back. Publishing a "minimal" here would be fabrication.
    let evaluations = 0
    const r = await checkMachine<Box>(noisy, noisyOwner, {
      seed: '11',
      steps: 30,
      runs: 1,
      mode: 'safety',
      invariants: [
        {
          name: 'flaky-external-counter',
          check: () => {
            evaluations += 1
            return evaluations !== 3
          },
        },
      ],
    })
    expect(r.violations.some((v) => v.invariant === 'flaky-external-counter')).toBe(true)
    expect(r.violations.every((v) => v.minimal === undefined)).toBe(true)
    const w = r.warnings.find((x) => x.kind === 'shrink-skipped')
    expect(w).toBeDefined()
    expect(w?.detail).toMatch(/did NOT reproduce/)
  })

  it('an INITIAL-CONFIGURATION finding has no op stream ⇒ shrink-skipped, not a fake minimal', async () => {
    // `a` is left on step 0 and never re-entered (no self-loop, no way back), so
    // the ONLY configuration that breaks this invariant is the post-construction
    // one — which the init pass reaches at `steps:0`, with zero driven ops.
    const oneWay: StateMachineConfig<Box> = {
      name: 'oneway',
      stateAttribute: 'state',
      initialState: 'a',
      states: { a: {}, b: { final: true } },
      events: { go: { transitions: [{ from: 'a', to: 'b' }] } },
    } as unknown as StateMachineConfig<Box>

    const r = await checkMachine<Box>(oneWay, () => ({ state: 'a' }), {
      seed: '11',
      steps: 8,
      runs: 1,
      mode: 'safety',
      invariants: [{ name: 'not-a-at-init', check: (s) => s.state !== 'a' }],
    })
    const initFinding = r.violations.find((v) => v.witness.includes('initial configuration'))
    expect(initFinding).toBeDefined()
    expect(r.violations.every((v) => v.minimal === undefined)).toBe(true)
    const w = r.warnings.find((x) => x.kind === 'shrink-skipped')
    expect(w?.detail).toMatch(/INITIAL-CONFIGURATION/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. the (b) refactor insurance: minimization is INVISIBLE to the rest of the
//    report. This is the test that would catch a shrink replay leaking into the
//    sweep's coverage / guard outcomes / saturation.
// ═══════════════════════════════════════════════════════════════════════════

/** Strip the W9-added surface so two reports can be compared field-for-field. */
function withoutShrinkSurface(r: CheckReport): unknown {
  return {
    ...r,
    violations: r.violations.map(({ minimal: _m, reproCode: _c, ...rest }) => rest),
    warnings: r.warnings.filter((w) => w.kind !== 'shrink-skipped'),
  }
}

describe('W9/Г3: the report is byte-identical with and without minimization', () => {
  const guardedCfg: StateMachineConfig<Box> = {
    name: 'guarded',
    stateAttribute: 'state',
    initialState: 'a',
    states: { a: {}, b: {}, c: { final: true } },
    events: {
      hop: {
        transitions: [
          { from: 'a', to: 'b', guard: (o: Box) => o.state === 'a' },
          { from: 'b', to: 'c', guard: () => false },
        ],
      },
      spin: { transitions: [{ from: 'a', to: 'a' }] },
    },
  } as unknown as StateMachineConfig<Box>

  it('a FAILING sweep reports identical coverage/guards/saturation/verdict either way', async () => {
    const base = {
      seed: '19',
      steps: 30,
      runs: 3,
      mode: 'safety',
      invariants: [{ name: 'never-b', check: (s: { state: string }) => !s.state.endsWith('b') }],
    } as const
    const off = await checkMachine<Box>(guardedCfg, () => ({ state: 'a' }), { ...base, shrink: false })
    const on = await checkMachine<Box>(guardedCfg, () => ({ state: 'a' }), base)

    // The shrink path re-runs the machine dozens of times. If ANY of that leaked
    // into the sweep's accumulators — guard coverage, reached states, plateau,
    // transitionsFired, oraclesRun — these two would diverge.
    expect(JSON.stringify(withoutShrinkSurface(on))).toBe(JSON.stringify(withoutShrinkSurface(off)))
    expect(on.violations.some((v) => v.minimal !== undefined)).toBe(true) // it DID run
  })

  it('a MINIMIZED report is itself byte-identical across two runs (the search is deterministic)', async () => {
    const base: CheckOptions<Box> = {
      seed: '19',
      steps: 30,
      runs: 3,
      mode: 'safety',
      invariants: [{ name: 'never-b', check: (s) => !s.state.endsWith('b') }],
    }
    const a = await checkMachine<Box>(guardedCfg, () => ({ state: 'a' }), base)
    const b = await checkMachine<Box>(guardedCfg, () => ({ state: 'a' }), base)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(a.violations.some((v) => v.minimal !== undefined)).toBe(true)
  })

  it('a GREEN sweep is byte-identical (minimization costs a clean run nothing)', async () => {
    const base: CheckOptions<Box> = { seed: '19', steps: 20, runs: 3, mode: 'safety' }
    const off = await checkMachine<Box>(noisy, noisyOwner, { ...base, shrink: false })
    const on = await checkMachine<Box>(noisy, noisyOwner, base)
    expect(JSON.stringify(on)).toBe(JSON.stringify(off))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. SimOptions.script at the sim layer
// ═══════════════════════════════════════════════════════════════════════════

describe('W9/Г3: SimOptions.script / SimResult.ops', () => {
  it('a run RECORDS the ops it drove, and re-driving them replays it exactly', async () => {
    const first = await runSimulation<Box>(() => ({ config: noisy, owner: { state: 's1' } }), {
      seed: '77',
      steps: 12,
      mode: 'safety',
    })
    expect(first.ops).toBeDefined()
    expect(first.ops?.length).toBe(12)

    const replay = await runSimulation<Box>(() => ({ config: noisy, owner: { state: 's1' } }), {
      seed: '77',
      steps: 12,
      mode: 'safety',
      script: first.ops ?? [],
    })
    expect(JSON.stringify(replay.ops)).toBe(JSON.stringify(first.ops))
    expect(replay.traceHash).toBe(first.traceHash)
  })

  it('the SAME script replays to the SAME trace even under a DIFFERENT seed', async () => {
    // The script displaces op SELECTION entirely, which is what makes a reduced
    // stream re-drivable at all.
    const script = [
      { kind: 'fire' as const, event: 'go1' },
      { kind: 'fire' as const, event: 'go2' },
    ]
    const a = await runSimulation<Box>(() => ({ config: noisy, owner: { state: 's1' } }), {
      seed: '1',
      steps: 2,
      mode: 'safety',
      script,
    })
    const b = await runSimulation<Box>(() => ({ config: noisy, owner: { state: 's1' } }), {
      seed: '999',
      steps: 2,
      mode: 'safety',
      script,
    })
    expect(b.trace.map((f) => `${f.from}>${f.to}`)).toEqual(a.trace.map((f) => `${f.from}>${f.to}`))
  })

  it('a script SHORTER than the step budget pads with noops (no PRNG fallback)', async () => {
    const r = await runSimulation<Box>(() => ({ config: noisy, owner: { state: 's1' } }), {
      seed: '1',
      steps: 5,
      mode: 'safety',
      script: [{ kind: 'fire', event: 'go1' }],
    })
    expect(r.ops?.length).toBe(5)
    expect(r.ops?.slice(1).every((o) => o.kind === 'noop')).toBe(true)
    // The padding did NOT resume fuzzing: `go2` (the only way out of s2) never
    // fired, so the machine is parked in s2 for the remaining four steps.
    expect(r.trace.every((f) => f.event !== 'go2')).toBe(true)
    expect(r.trace[r.trace.length - 1]?.to).toBe('s2')
  })
})
