/**
 * @module sim/invariants.runner
 * @unstable
 *
 * ADR-6 SAFETY runner — the BLIND iteration over a `readonly Invariant[]`. This
 * file is DELIBERATELY isolated from the registry data (`invariants.ts`) so the
 * "never references an id literally" property is MECHANICALLY grep-checkable:
 * `runSafety.toString()` (and this whole module) contains NO `/I-\d+/` literal.
 *
 * {@link runSafety} emits AT MOST ONE {@link Violation}: the LOWEST-step
 * `checkStep` violation across all frames and all invariants, else the FIRST
 * `checkFinal` violation in registry order. The first-of-the-determinism family
 * (the meta invariant) short-circuits: if it fails, its violation is returned
 * before any other invariant is evaluated (the caller supplies the cross-run
 * determinism verdict via {@link runSafetyWithDeterminism}).
 *
 * The runner is PURE: it reads only the trace frames + the supplied
 * {@link CheckerContext}; it makes NO live engine call and runs NO settle/drain.
 */

import type {
  CheckerContext,
  Invariant,
  Violation,
} from './invariants'
import { finalStateOf, makeViolation } from './invariants'
import type { CanonicalTrace } from './trace'

/**
 * Run the blind safety sweep over a single trace.
 *
 * Iterates the invariant registry blind:
 *  1. For each step-scoped (or both-scoped) invariant, evaluate `checkStep` on
 *     every frame; track the violation with the LOWEST `step`.
 *  2. If no step violation, evaluate `checkFinal` for each final-scoped (or
 *     both-scoped) invariant in REGISTRY ORDER; return the FIRST.
 *
 * Returns `null` if every invariant is clean.
 */
export function runSafety(
  invariants: readonly Invariant[],
  trace: CanonicalTrace,
  ctx: CheckerContext,
): Violation | null {
  // (1) lowest-step checkStep across all frames × all step/both invariants.
  let lowest: Violation | null = null
  for (const inv of invariants) {
    if (inv.checkStep === undefined) {
      continue
    }
    for (const frame of trace.frames) {
      const v = inv.checkStep(frame, ctx)
      if (v !== null && (lowest === null || v.step < lowest.step)) {
        lowest = v
      }
    }
  }
  if (lowest !== null) {
    return lowest
  }

  // (2) first checkFinal in registry order.
  //
  // The final-scope context carries the trace FRAMES: a `checkStep` hook sees one
  // frame at a time and can never compare a frame with its predecessor, so a sound
  // SEQUENCE-shaped predicate (e.g. counting `false → true` edges of a per-frame
  // projection) has no other honest home. This adds NO impurity — the runner already
  // holds the trace, the frames are the same CAPTURED data `checkStep` receives, and
  // no live engine call is introduced. Supplied here rather than by each caller so a
  // sequence-shaped oracle can never be silently vacuous on one call path and armed
  // on another. Built ONCE per sweep, not per invariant. The runner stays BLIND — it
  // still references no invariant id.
  const finalState = finalStateOf(trace)
  const finalCtx: CheckerContext = { ...ctx, frames: trace.frames }
  for (const inv of invariants) {
    if (inv.checkFinal === undefined) {
      continue
    }
    const v = inv.checkFinal(finalState, finalCtx)
    if (v !== null) {
      return v
    }
  }
  return null
}

/**
 * Run the safety sweep with the meta-determinism short-circuit. The caller runs
 * the SAME scenario twice and supplies both trace hashes; if they DIFFER the
 * determinism invariant (the first registry entry, by convention) fails FIRST and
 * its violation is returned BEFORE any other invariant is evaluated. Otherwise the
 * normal blind sweep runs on the (deterministic) trace.
 *
 * The runner discovers the meta invariant BLIND: it is the first invariant whose
 * `capabilityTags` include the determinism marker — never by id literal.
 */
export function runSafetyWithDeterminism(
  invariants: readonly Invariant[],
  trace: CanonicalTrace,
  ctx: CheckerContext,
  hashes: { readonly a: string; readonly b: string },
): Violation | null {
  if (hashes.a !== hashes.b) {
    const meta = invariants.find((i) => i.capabilityTags?.some((t) => t.startsWith('meta.determinism')))
    const id = meta?.id ?? 'determinism'
    return makeViolation({
      invariantId: id,
      step: 0,
      witness: `${hashes.a}!=${hashes.b}`,
      message: 'two runs of the same seed produced different trace hashes',
      observed: `${hashes.a} vs ${hashes.b}`,
      expected: 'identical traceHash across runs',
    })
  }
  return runSafety(invariants, trace, ctx)
}
