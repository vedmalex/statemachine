/**
 * @module tests/sim/engine-path-smoke
 *
 * W5a D2 — engine-path fuzz SMOKE in the DEFAULT (ungated) set.
 *
 * The heavy sweep (`sim-pr.run.test.ts`) is gated behind `SM_SIM=1`, so the
 * default `bunx vitest run` never drove the INVARIANTS registry THROUGH the real
 * engine (via `runSimulation`) — a regression that silently disconnects the
 * oracle registry from the engine would pass the default suite unnoticed. This
 * FAST smoke closes that gap: a handful of seeds, a small step budget, real
 * `StateMachine` construction/driving through the public `runSimulation` entry,
 * the FULL {@link INVARIANTS} registry attached.
 *
 * It is NOT the exhaustive corpus (that stays behind SM_SIM); it is the
 * always-on floor asserting the engine ↔ oracle wiring is intact:
 *   - a real multi-hop / async-invoke machine runs the registry and stays clean
 *     (no FALSE violation from a working machine);
 *   - `oraclesRun > 0` (A2 fail-open guard — the registry actually executed);
 *   - the run is deterministic (same seed ⇒ same traceHash).
 */

import { describe, expect, it } from 'vitest'

import type { StateMachineConfig } from '../../index'
import { runSimulation } from '../../sim/index'
import { INVARIANTS } from '../../sim/invariants'

type Box = { state: string }

/** A three-hop event-driven chain a→b→c (pure external fires). */
function chainConfig(): StateMachineConfig<Box> {
  return {
    name: 'smoke-chain',
    stateAttribute: 'state',
    initialState: 'a',
    states: { a: {}, b: {}, c: {} },
    events: {
      toB: { transitions: [{ from: 'a', to: 'b' }] },
      toC: { transitions: [{ from: 'b', to: 'c' }] },
    },
  } as unknown as StateMachineConfig<Box>
}

/** A chain whose b→c hop runs an opaque async invoke (exercises the callAction await path). */
function asyncInvokeConfig(): StateMachineConfig<Box> {
  return {
    name: 'smoke-async-invoke',
    stateAttribute: 'state',
    initialState: 'a',
    states: {
      a: {},
      b: { invoke: [{ delay: 0, event: 'toC', action: async (): Promise<void> => { await Promise.resolve() } }] },
      c: {},
    },
    events: {
      toB: { transitions: [{ from: 'a', to: 'b' }] },
      toC: { transitions: [{ from: 'b', to: 'c' }] },
    },
  } as unknown as StateMachineConfig<Box>
}

const SEEDS = ['1', '2', '3', '7', '42'] as const

describe('W5a D2 — default engine-path fuzz smoke (full INVARIANTS through the real engine)', () => {
  it('a multi-hop chain runs the INVARIANTS registry through the real engine, clean + deterministic, oraclesRun>0', async () => {
    for (const seed of SEEDS) {
      const a = await runSimulation<Box>(() => ({ config: chainConfig(), owner: { state: 'a' } }), {
        seed,
        steps: 12,
        invariants: INVARIANTS,
      })
      const b = await runSimulation<Box>(() => ({ config: chainConfig(), owner: { state: 'a' } }), {
        seed,
        steps: 12,
        invariants: INVARIANTS,
      })
      // A working machine must NOT produce a false violation from the registry.
      expect(a.ok, `chain seed ${seed} must be clean (violation=${a.violation?.invariantId})`).toBe(true)
      expect(a.violation).toBeUndefined()
      // The registry actually executed (A2): the full set + the engine-error channel.
      expect(a.oraclesRun).toBeGreaterThan(0)
      expect(a.oraclesRun).toBe(INVARIANTS.length + 1)
      // Determinism floor: identical seed ⇒ identical trace hash.
      expect(b.traceHash).toBe(a.traceHash)
    }
  })

  it('an async-invoke machine drives the registry through the real callAction await path, clean + deterministic', async () => {
    for (const seed of SEEDS) {
      const a = await runSimulation<Box>(() => ({ config: asyncInvokeConfig(), owner: { state: 'a' } }), {
        seed,
        steps: 12,
        invariants: INVARIANTS,
      })
      const b = await runSimulation<Box>(() => ({ config: asyncInvokeConfig(), owner: { state: 'a' } }), {
        seed,
        steps: 12,
        invariants: INVARIANTS,
      })
      expect(a.ok, `async-invoke seed ${seed} must be clean (violation=${a.violation?.invariantId})`).toBe(true)
      expect(a.oraclesRun).toBeGreaterThan(0)
      expect(b.traceHash).toBe(a.traceHash)
    }
  })

  it('the default (no-invariants) run is NOT fail-open: builtins attach so oraclesRun>0', async () => {
    // The A2 contract, exercised through the real engine in the default set: a
    // naive runSimulation with NO invariants still runs real oracles.
    const r = await runSimulation<Box>(() => ({ config: chainConfig(), owner: { state: 'a' } }), {
      seed: '5',
      steps: 8,
    })
    expect(r.ok).toBe(true)
    expect(r.oraclesRun).toBeGreaterThan(0)
  })
})
