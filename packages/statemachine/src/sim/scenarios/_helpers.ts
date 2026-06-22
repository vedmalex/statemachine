/**
 * @module sim/scenarios/_helpers
 * @unstable
 *
 * Shared authoring helpers for the Step-9 coverage scenarios: closure-free
 * {@link LiteralCallback} construction (source + behaviorally-equal `fn`) and a
 * {@link ScenarioSpec} builder with sane defaults. The harness ALWAYS re-creates
 * a callback from its `source` (define.ts:recreateLiteral) — the `fn` here is the
 * generator-side equivalent and is only used when the spec is driven live; both
 * read ONLY their parameter (R13).
 */

import { DEFAULT_BOUNDS } from '../define'
import type { Bounds, LiteralCallback, Op, ScenarioSpec, TopologySpec } from '../scenario'

/**
 * Build a closure-free {@link LiteralCallback} from its expression `source` and a
 * behaviorally-equal live `fn`. `source` MUST read only its parameter (no free
 * identifiers) so it survives the restricted-scope re-eval.
 */
export function lit(source: string, fn: (...args: never[]) => unknown): LiteralCallback {
  return { source, fn }
}

let opCounter = 0
/** A stable op id (monotonic; survives op removal — ids never renumber). */
function nextOpId(prefix: string): string {
  opCounter += 1
  return `${prefix}-${opCounter}`
}

/** A `fire` op with a stable id. */
export function fire(event: string, ...args: number[]): Op {
  return { kind: 'fire', id: nextOpId('fire'), event, args }
}

/** An `advance` op with a stable id. */
export function advance(dtMs: number): Op {
  return { kind: 'advance', id: nextOpId('advance'), dtMs }
}

/**
 * Build a {@link ScenarioSpec} from a topology + op list. Faults are EMPTY by
 * default (the coverage gate's fault-free content plane); `transitionTimeoutMs`
 * may be set for the timeout capability scenario.
 */
export function spec(
  seed: bigint,
  topology: TopologySpec,
  ops: readonly Op[],
  bounds: Bounds = DEFAULT_BOUNDS,
): ScenarioSpec {
  return {
    seed: seed.toString(),
    version: 1,
    topology,
    ops,
    faults: { faults: [] },
    bounds,
  }
}
