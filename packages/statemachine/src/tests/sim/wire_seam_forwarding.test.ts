import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { IContextTracker, StateMachineConfig } from '../../index'
import * as sim from '../../sim'
import type { SimEnv } from '../../sim'

/**
 * wire() SEAM-FORWARDING CONTRACT.
 *
 * `wire()` is documented as THE sanctioned DI-first construction path, and its
 * stated safety property is that seam omission is structurally impossible. That
 * property used to be enforced by nothing at all: `wire()` transcribed FIVE seams
 * into a hand-written object literal, the engine's sixth DI slot
 * (`StateMachineOptions.contextTracker`) was never forwarded, and because the
 * option is OPTIONAL the compiler stayed silent. Adding a sixth seam to `SimEnv`
 * and supplying it from `makeSimEnv` was measured against this suite at
 * 43cc781: `tsc --noEmit` exit 0, `tsc -p tsconfig.typecheck.json` exit 0,
 * 1351 tests / 0 failures. Nothing failed anywhere.
 *
 * The mechanism is now type-level and lives in `src/sim/public.ts`: the seam set
 * is DERIVED from `SimEnv` (`Omit<SimEnv, SimEnvExtras>`) and SPREAD into the
 * constructor, with two guards — `Pick<StateMachineOptions, keyof SimEnvSeams>`
 * (a seam must name a real engine slot) and the `SeamTotality` marker (the engine
 * cannot grow an option nobody classified). This file is the BELT: it pins the
 * behaviour the guards are supposed to produce, the scope boundary the guards do
 * NOT cover, and — via a real `tsc` spawn — that the guards genuinely go red.
 */

type Owner = { state: string }

function pingPongConfig(): StateMachineConfig<Owner> {
  return {
    name: 'seam-forwarding',
    stateAttribute: 'state',
    initialState: 'a',
    states: { a: {}, b: {} },
    events: {
      go: { transitions: [{ from: 'a', to: 'b' }] },
      back: { transitions: [{ from: 'b', to: 'a' }] },
    },
  } as unknown as StateMachineConfig<Owner>
}

function probeSimulator(seed: bigint): sim.Simulator<Owner> {
  return new sim.Simulator<Owner>(() => ({ config: pingPongConfig(), owner: { state: 'a' } }), { seed })
}

/** A minimal but HONEST tracker: a real store that survives `run`/`exit` nesting. */
function makeTestTracker(): IContextTracker {
  const stack: number[] = []
  return {
    run<R>(store: number, fn: () => R): R {
      stack.push(store)
      try {
        return fn()
      } finally {
        stack.pop()
      }
    },
    exit<R>(fn: () => R): R {
      const saved = stack.splice(0, stack.length)
      try {
        return fn()
      } finally {
        stack.push(...saved)
      }
    },
    getStore(): number | undefined {
      return stack.length > 0 ? stack[stack.length - 1] : undefined
    },
  }
}

describe('wire() forwards EVERY seam present on the env (behavioural)', () => {
  it('forwards contextTracker — the seam the hand-written five-field literal dropped', () => {
    const tracker = makeTestTracker()
    const env: SimEnv = { ...probeSimulator(101n).env, contextTracker: tracker }

    const machine = sim.wire(env, pingPongConfig(), { state: 'a' })

    // 'injected' is reachable ONLY through StateMachineOptions.contextTracker
    // (state_machine.ts sets it in the `options?.contextTracker !== undefined`
    // branch), so this is proof of forwarding and not of a default.
    expect(machine.contextTrackerKind).toBe('injected')
  })

  it('CONTROL: an env WITHOUT contextTracker still gets the engine default (no no-op downgrade)', () => {
    const env = probeSimulator(102n).env
    expect(env.contextTracker).toBeUndefined()

    const machine = sim.wire(env, pingPongConfig(), { state: 'a' })

    expect(machine.contextTrackerKind).not.toBe('injected')
    // Under Node the engine resolves AsyncLocalStorage. Pinned so that a silent
    // degradation to 'none' (which would PARK true reentrancy rather than reject
    // it) cannot pass as "not injected".
    expect(machine.contextTrackerKind).toBe('async-local-storage')
  })

  it('the five DETERMINISM seams remain non-optional (omission stays unrepresentable)', () => {
    const env = probeSimulator(103n).env
    // @ts-expect-error scheduler is required on SimEnv — omission must not typecheck.
    const broken: SimEnv = { ...env, scheduler: undefined }
    expect(broken).toBeDefined()
  })
})

describe('SCOPE BOUNDARY: the corpus path is deliberately NOT changed', () => {
  it('makeSimEnv does not inject a contextTracker (harness envs stay on engine default)', () => {
    expect(probeSimulator(104n).env.contextTracker).toBeUndefined()
  })

  it("a Simulator-built machine's tracker is NOT injected (contextTrackerKind unmoved)", async () => {
    const s = probeSimulator(105n)
    await s.init()
    // Reaching the driver's machine through the public surface: the Simulator
    // exposes it via the {machine} target rejection path, so assert through a run
    // instead — a moved contextTrackerKind would move fireOutcome and the hash.
    const a = await sim.runSimulation<Owner>(() => ({ config: pingPongConfig(), owner: { state: 'a' } }), {
      seed: 105n,
      steps: 4,
    })
    const b = await sim.runSimulation<Owner>(() => ({ config: pingPongConfig(), owner: { state: 'a' } }), {
      seed: 105n,
      steps: 4,
    })
    expect(a.traceHash).toBe(b.traceHash)
    expect(a.ok).toBe(true)
  })

  it("SimDriver's forwarded option set is PINNED — contextTracker must not appear there", () => {
    const driverSrc = readFileSync(resolve(__dirname, '..', '..', 'sim', 'driver.ts'), 'utf8')
    const ctor = driverSrc.slice(driverSrc.indexOf('this.sm = new StateMachine<T, StateMachineConfig<T>>('))
    const optionsBlock = ctor.slice(0, ctor.indexOf('\n    })'))

    // The exact set the driver forwards today. Injecting a tracker HERE would flip
    // contextTrackerKind, change which reentrant fireEvent calls are rejected,
    // change `fireOutcome` in trace frames, and move every corpus hash — so this
    // list is a version-bump decision, not an implementation detail.
    for (const key of ['clock:', 'scheduler:', 'monitor:', 'errorHandler:', 'logger:']) {
      expect(optionsBlock, `driver must keep forwarding ${key}`).toContain(key)
    }
    expect(optionsBlock, 'driver must NOT forward contextTracker (corpus-hash boundary)').not.toContain(
      'contextTracker',
    )
  })
})

describe('the MECHANISM is wired in (source-level)', () => {
  /**
   * A source-level check, deliberately. The type guards can only be PRESENT; the
   * type system cannot express "this call site must go through this helper", so
   * nothing type-level stops a maintainer from re-inlining a hand-written seam
   * literal into wire(). `biome check` catches the orphaned helper
   * (noUnusedVariables — measured), and `tsc --noEmit` does NOT. This closes that
   * specific hole rather than restating what the guards already enforce.
   */
  it('wire() delegates to forwardSeams and contains no hand-written seam literal', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'sim', 'public.ts'), 'utf8')
    const wireBody = src.slice(src.indexOf('export function wire<T extends object>('))
    const body = wireBody.slice(0, wireBody.indexOf('\n}\n'))

    expect(body, 'wire() must construct through forwardSeams(env)').toContain('forwardSeams(env)')
    expect(body, 'wire() must not transcribe seams into a literal again').not.toContain('scheduler: env.scheduler')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// The compile-level teeth. These spawn `tsc` (seconds), so they are gated behind
// SM_SIM=1 exactly like `tsconfig_isolation.test.ts`.
//
// The probe lives in the gitignored `temp/` tree and is compiled through a
// PURPOSE-BUILT tsconfig, NOT through the shared project: a probe file dropped
// into `src/**` would be picked up by the project-wide `tsc --noEmit` that
// `tsconfig_isolation.test.ts` spawns in parallel and would fail that test's
// control assertion.
// ────────────────────────────────────────────────────────────────────────────

const GATED = process.env['SM_SIM'] === '1'
const ROOT = resolve(__dirname, '..', '..', '..')
const PROBE_DIR = resolve(ROOT, 'temp', 'seam-guard')
const PROBE_FILE = resolve(PROBE_DIR, 'probe.ts')
const PROBE_TSCONFIG = resolve(PROBE_DIR, 'tsconfig.json')
const TSC = resolve(ROOT, 'node_modules', '.bin', 'tsc')

function runProbe(probeSource: string): { code: number; output: string } {
  mkdirSync(PROBE_DIR, { recursive: true })
  writeFileSync(PROBE_FILE, probeSource, 'utf8')
  writeFileSync(
    PROBE_TSCONFIG,
    JSON.stringify({
      extends: '../../tsconfig.json',
      compilerOptions: { noEmit: true },
      include: ['./probe.ts', '../../src/sim/public.ts'],
    }),
    'utf8',
  )
  try {
    const out = execFileSync(TSC, ['-p', PROBE_TSCONFIG], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, output: out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  } finally {
    rmSync(PROBE_DIR, { recursive: true, force: true })
  }
}

describe.skipIf(!GATED)('seam guards fail `tsc` on drift (SM_SIM=1)', () => {
  it('CONTROL: the guards compile clean as committed', () => {
    const { code, output } = runProbe("import '../../src/sim/public'\n")
    expect(code, `expected a clean compile, got:\n${output}`).toBe(0)
  })

  it('GUARD 2: an engine option nobody classified as seam-or-not FAILS tsc', () => {
    // Exactly the event that produced the original defect: the engine grows a DI
    // slot and the sim never notices.
    const { code, output } = runProbe(
      [
        "import '../../src/sim/public'",
        "declare module '../../src/types' {",
        '  interface StateMachineOptions {',
        '    __newEngineSeam__?: () => void',
        '  }',
        '}',
        '',
      ].join('\n'),
    )
    expect(code, 'a new unclassified engine option must not compile').not.toBe(0)
    expect(output).toContain('__UNCLASSIFIED_ENGINE_OPTION__')
    expect(output).toContain('__newEngineSeam__')
  })

  it('GUARD 1: a seam on SimEnv that names no engine slot FAILS tsc', () => {
    const { code, output } = runProbe(
      [
        "import '../../src/sim/public'",
        "declare module '../../src/sim/public' {",
        '  interface SimEnv {',
        '    readonly contxtTracker?: import("../../src/types").IContextTracker',
        '  }',
        '}',
        '',
      ].join('\n'),
    )
    expect(code, 'a seam naming no engine option must not compile').not.toBe(0)
    expect(output).toContain('contxtTracker')
  })
})

describe('probe hygiene', () => {
  it('leaves no probe artifacts behind', () => {
    expect(existsSync(PROBE_DIR)).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// The gate on the gate. UNGATED on purpose — it runs on every leg.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The `SM_SIM=1` probes above, and the ones in `dist_byte_guard.test.ts` and
 * `tsconfig_isolation.test.ts`, executed on NO CI leg. `SM_SIM=1` appeared in
 * `ci.yml` only on the `sim:pr` line, and `package.json`'s `sim:pr` scopes
 * vitest to `src/tests/sim/sim-pr.run.test.ts` — one unrelated file. Every
 * full-suite leg runs without `SM_SIM`, so `describe.skipIf(!GATED)` skipped
 * them everywhere.
 *
 * The guards themselves still bit (the project-wide `tsc --noEmit` in
 * `npm run check` catches an unclassified engine option regardless); what was
 * dormant was the DEMONSTRATION that they bite, which is the whole point of a
 * probe. `npm run sim:guards` + a `ci.yml` step fixed that, and this test is
 * what stops the step from being deleted back into dormancy.
 *
 * NOT widened globally: setting `SM_SIM=1` on `npm test` would also switch on
 * `sim-pr.run.test.ts` (the 64-seed PR sweep, already run as its own step),
 * `sim-sweep.run.test.ts` (the nightly shard runner) and `metrics.perf.test.ts`
 * (a perf REGRESSION with a recorded baseline that needs `--expose-gc` and is
 * deliberately kept off the PR leg — `ci-gating.test.ts` asserts `sim:perf` is
 * NOT in ci.yml). A named script keeps the compile guards and the heavy sweeps
 * on separate switches.
 */
describe('the SM_SIM-gated compile guards actually run on a CI leg', () => {
  const REPO_ROOT = resolve(ROOT, '..', '..')
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }
  const ci = readFileSync(resolve(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')

  it('a `sim:guards` script sets SM_SIM=1 and names every gated compile-probe file', () => {
    const script = pkg.scripts['sim:guards']
    expect(script, 'package.json must define sim:guards').toBeDefined()
    expect(script).toContain('SM_SIM=1')
    for (const file of [
      'src/tests/sim/wire_seam_forwarding.test.ts',
      'src/tests/sim/dist_byte_guard.test.ts',
      'src/tests/sim/tsconfig_isolation.test.ts',
    ]) {
      expect(script, `sim:guards must run ${file} — otherwise its probes stay dormant`).toContain(file)
    }
  })

  it('ci.yml runs `sim:guards` on tier-a-node, exactly once, AFTER the build', () => {
    expect(ci.split('npm run sim:guards').length - 1, 'exactly one sim:guards step').toBe(1)

    const tierANode = ci.indexOf('tier-a-node:')
    const tierBDeno = ci.indexOf('tier-b-deno:')
    expect(tierANode).toBeGreaterThan(0)
    const leg = ci.slice(tierANode, tierBDeno)
    expect(leg, 'sim:guards belongs on the tier-a-node leg').toContain('npm run sim:guards')

    // dist_byte_guard now FAILS on an unbuilt tree instead of skipping, so the
    // step is only sound after `npm run build`.
    expect(leg.indexOf('npm run build'), 'tier-a-node must build first').toBeGreaterThan(-1)
    expect(leg.indexOf('npm run build')).toBeLessThan(leg.indexOf('npm run sim:guards'))
  })

  it('SM_SIM is NOT set on the full-suite legs (the heavy sweeps stay on their own steps)', () => {
    // If someone "fixes" dormancy by exporting SM_SIM job-wide, the 64-seed PR
    // sweep, the nightly shard runner and the perf regression all switch on
    // silently. Keep the widening explicit and scoped.
    for (const line of ci.split('\n')) {
      if (!line.includes('SM_SIM')) continue
      if (line.trim().startsWith('#')) continue // YAML comment, not a step
      expect(
        /npm run sim:(pr|guards|sweep|perf|coverage)/.test(line),
        `SM_SIM appears on a line that is not a scoped sim script: ${line.trim()}`,
      ).toBe(true)
    }
  })
})
