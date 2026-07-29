import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineScenario, generateScenario, runScenario } from '../../sim/define'
import type { FaultPlan, ScenarioSpec } from '../../sim'
import { hashTrace } from '../../sim/trace'

// ── Step-11 (DoD 13): AC-1 four-run determinism canary — UNGATED ──────────────
//
// The headline DST claim (ADR-3 c9): the SAME seed/spec replays to a BIT-IDENTICAL
// traceHash, independent of whether vitest's fake timers are active. This rests on
// the Step-2 Adapter-write capture seam + the Step-5 `throw` fault (a throwing
// invoke action whose injected throw is observed at the harness boundary). It runs
// UNGATED on EVERY CI leg as a determinism-floor test (build-plan §11A/DoD 13).

afterEach(() => {
  vi.useRealTimers()
})

/** Attach a Step-5 throw fault to the first function-valued invoke action. */
function withThrowFault(spec: ScenarioSpec): ScenarioSpec {
  const faults: FaultPlan = {
    faults: [{ kind: 'throw', site: { seam: 'callback', callbackKind: 'invoke.action', invokeIndex: 0 } }],
  }
  return { ...spec, faults }
}

describe('replay: AC-1 four-run determinism canary (Step 11 DoD 13)', () => {
  it('throw-fault scenario replays to one traceHash across fake-timers on/off × two runs', async () => {
    const spec = withThrowFault(await generateScenario(3n))

    // Two runs with fake timers ACTIVE (matching the repo vitest fakeTimers set).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const fakeA = hashTrace(await runScenario(spec))
    const fakeB = hashTrace(await runScenario(spec))
    vi.useRealTimers()

    // Two runs with real timers.
    const realA = hashTrace(await runScenario(spec))
    const realB = hashTrace(await runScenario(spec))

    expect(fakeA).toBe(fakeB)
    expect(realA).toBe(realB)
    // The headline cross-timer-mode invariance: all four hashes are identical.
    expect(realA, 'fake-timer and real-timer replays must hash identically').toBe(fakeA)
  }, 30000)
})

// ── DoD 1: runScenario pure in (seed, spec, runtime) — identical traceHash ───

describe('replay: same spec -> identical traceHash (DoD 1)', () => {
  it('two independent runScenario runs of the SAME spec produce a bit-identical traceHash (16-seed sweep)', async () => {
    for (let s = 0; s < 16; s++) {
      const spec = await generateScenario(BigInt(s))
      const h1 = hashTrace(await runScenario(spec))
      const h2 = hashTrace(await runScenario(spec))
      expect(h2, `seed ${s} not reproducible`).toBe(h1)
    }
  }, 30000)

  it('generateScenario is itself deterministic: same seed -> identical ops + topology', async () => {
    for (let s = 0; s < 8; s++) {
      const a = await generateScenario(BigInt(s))
      const b = await generateScenario(BigInt(s))
      expect(JSON.stringify(a.ops), `seed ${s} ops differ`).toBe(JSON.stringify(b.ops))
      // topology serializes identically (sources, not live fns)
      expect(JSON.stringify(a.topology), `seed ${s} topology differs`).toBe(JSON.stringify(b.topology))
    }
  }, 30000)
})

// ── DoD 10: JSON round-trip reproduces the same traceHash (end-to-end) ───────

describe('replay: JSON round-trip reproduces the same traceHash (DoD 10)', () => {
  it('defineScenario(JSON.parse(JSON.stringify(spec))) replays to the SAME traceHash', async () => {
    for (let s = 0; s < 8; s++) {
      const spec = await generateScenario(BigInt(s))
      const live = hashTrace(await runScenario(spec))
      const round = defineScenario(JSON.parse(JSON.stringify(spec)))
      const roundHash = hashTrace(await runScenario(round))
      expect(roundHash, `seed ${s} JSON round-trip diverged`).toBe(live)
    }
  }, 30000)
})

// ── DoD 1 (corollary): different seeds generally produce different traces ────

describe('replay: distinct seeds produce distinct traces (sanity)', () => {
  it('a handful of seeds yield more than one distinct traceHash (generator is not constant)', async () => {
    const hashes = new Set<string>()
    for (let s = 0; s < 8; s++) {
      hashes.add(hashTrace(await runScenario(await generateScenario(BigInt(s)))))
    }
    expect(hashes.size).toBeGreaterThan(1)
  }, 30000)
})

// ── W5b #22 — B1 persistent hash + D5 undrivable-op error ────────────────────

describe('W5b #22: repro-hash strength (B1) + undrivable-op error (D5)', () => {
  it('B1: the shrinker replay traceHash is the FULL canonical hashTrace, not the weak configHash:frameCount digest', async () => {
    const { defaultShrinkRunner } = await import('../../sim/shrinker')
    const spec = await generateScenario(11n)
    const run = await defaultShrinkRunner(spec)
    // The persisted replay hash MUST equal the full content-only hashTrace so two
    // distinct runs that merely share a config + frame count cannot collide.
    expect(run.traceHash).toBe(hashTrace(await runScenario(spec)))
    // The weak digest was `${configHash}:${frameCount}` (colon-joined); the full
    // canonical hash is two concatenated fnv1a32 hex segments — never a colon pair.
    expect(run.traceHash).not.toContain(':')
    expect(run.traceHash.length).toBeGreaterThanOrEqual(16)
  }, 30000)

  it('D5: runScenario THROWS on an undrivable restore/snapshot op instead of silently skipping it', async () => {
    const base = await generateScenario(7n)
    const withRestore: ScenarioSpec = {
      ...base,
      ops: [...base.ops, { kind: 'restore', id: 'r1', fromSnapshotId: 'snap1' }],
    }
    await expect(runScenario(withRestore)).rejects.toThrow(/not drivable/)
    const withSnapshot: ScenarioSpec = {
      ...base,
      ops: [...base.ops, { kind: 'snapshot', id: 's1' }],
    }
    await expect(runScenario(withSnapshot)).rejects.toThrow(/not drivable/)
  }, 30000)
})
