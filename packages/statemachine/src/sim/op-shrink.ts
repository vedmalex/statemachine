/**
 * @module sim/op-shrink
 * @unstable
 *
 * Delta-debugging over an OP STREAM (W9/Г3).
 *
 * ## Why this exists instead of reusing `shrink()`
 * The existing {@link shrink} minimizes a `ScenarioSpec` — a GENERATED spec whose
 * callbacks are inline source strings with no closures. `checkMachine` runs a
 * consumer's LIVE `StateMachineConfig` with real closures, and there is no total
 * translation from the latter to the former, so that shrinker has nothing to be
 * handed. Three structural blockers followed from it:
 *
 *   1. different inputs (live config vs ScenarioSpec);
 *   2. no acceptance predicate — a `kind:'user'` violation is born outside the
 *      oracle registry and carries no `Violation.fingerprint`;
 *   3. object payloads are not corpus-serializable (they collapse to
 *      `[object Object]` in the shrinker's memo key, so a "minimal" repro could be
 *      accepted without ever being verified).
 *
 * All three dissolve once the thing being reduced is the OP STREAM rather than the
 * spec: the candidate is the SAME live config with the SAME closures — only the
 * sequence of driven ops changes. The predicate is supplied by the caller (which
 * knows how to compare a user violation), and payload values ride along in memory
 * as opaque values — serialization is needed only to PRINT a repro, never to
 * shrink one.
 *
 * ## Anti-fabrication
 * Every candidate is decided by an actual re-run through the caller's predicate;
 * a candidate that does not reproduce is rejected. The worst case is therefore the
 * INPUT stream unchanged — never a smaller stream that was not verified. The
 * caller is expected to run a verify-first pass before shrinking at all (see
 * {@link OpShrinkResult.verified}).
 *
 * PURE: no engine, no clock, no randomness. Ordering is deterministic, so the same
 * (ops, predicate) always yields the same minimal stream.
 */

/** The op shapes this module reduces (structurally the driver's `DriverOp`). */
export type ShrinkableOp =
  | { readonly kind: 'fire'; readonly event: string; readonly args?: readonly unknown[]; readonly opId?: string }
  | { readonly kind: 'advance'; readonly dtMs: number; readonly opId?: string }
  | { readonly kind: 'noop'; readonly opId?: string }

/**
 * Does this candidate stream still reproduce the SAME finding? The caller owns the
 * comparison (a builtin violation compares its `fingerprint`; a user violation
 * compares the `{invariant, witness}` tuple), because only the caller can run the
 * machine.
 */
export type OpShrinkPredicate = (candidate: readonly ShrinkableOp[]) => Promise<boolean>

export interface OpShrinkBudget {
  /** Hard ceiling on predicate invocations (each is a full re-run). */
  readonly maxRuns: number
  /** Stop after this many consecutive rounds that removed nothing. */
  readonly maxStagnantRounds: number
}

export const DEFAULT_OP_SHRINK_BUDGET: OpShrinkBudget = {
  maxRuns: 200,
  maxStagnantRounds: 2,
}

export interface OpShrinkResult {
  /** The reduced stream. Equals the input when nothing could be removed. */
  readonly ops: readonly ShrinkableOp[]
  /** Predicate invocations actually spent. */
  readonly runs: number
  /** Accepted reductions. */
  readonly moves: number
  /**
   * True iff the search ran to a fixpoint (a full stagnant round removed nothing)
   * rather than stopping on the budget. `false` means "valid, but possibly not
   * 1-minimal" — the same honesty flag `shrink()` carries.
   */
  readonly minimal: boolean
}

/**
 * Stable memo key: WHICH ORIGINAL OPS survive (by their index in the input stream)
 * plus the current advance magnitudes.
 *
 * Keying on op CONTENT (event names) would be UNSOUND, and in exactly the way that
 * blocked reusing `shrinkCacheKey`: a payload generator emits DIFFERENT args for
 * different calls of the SAME event, so `[fire('E',{v:1}), fire('E',{v:2})]` yields
 * two distinct candidates — drop-first and drop-second — that a content key cannot
 * tell apart. One would silently inherit the other's verdict: at best a valid
 * reduction is missed, at worst a stream is accepted that was never actually run.
 * Index identity is exact and needs no payload serialization at all.
 */
function keyOf(ops: readonly IndexedOp[]): string {
  return ops.map((o) => (o.op.kind === 'advance' ? `${o.idx}@${o.op.dtMs}` : `${o.idx}`)).join(',')
}

/** An op carrying its position in the ORIGINAL stream — the identity the memo uses. */
interface IndexedOp {
  readonly idx: number
  readonly op: ShrinkableOp
}

/**
 * Reduce `ops` to a locally-minimal stream that still satisfies `predicate`.
 *
 * Two moves, cheapest-first, repeated to a fixpoint:
 *  - **drop**: classic ddmin — try removing contiguous chunks, halving the chunk
 *    size when a full pass removes nothing (n → n/2 → … → 1);
 *  - **shrink-advance**: binary-search each `advance.dtMs` toward 0.
 *
 * There is no config move (the config is constant here) and no fault move (this
 * path drives no faults) — the two `shrink()` moves that have no meaning for a
 * live-config run.
 */
export async function shrinkOps(
  ops: readonly ShrinkableOp[],
  predicate: OpShrinkPredicate,
  budget: OpShrinkBudget = DEFAULT_OP_SHRINK_BUDGET,
): Promise<OpShrinkResult> {
  // Work on INDEXED ops so the memo key is a true identity (see `keyOf`).
  let best: readonly IndexedOp[] = ops.map((op, idx) => ({ idx, op }))
  let runs = 0
  let moves = 0
  let stagnant = 0
  const memo = new Map<string, boolean>()

  const accepts = async (candidate: readonly IndexedOp[]): Promise<boolean> => {
    const key = keyOf(candidate)
    const hit = memo.get(key)
    if (hit !== undefined) {
      return hit
    }
    if (runs >= budget.maxRuns) {
      return false
    }
    runs += 1
    let ok: boolean
    try {
      ok = await predicate(candidate.map((c) => c.op))
    } catch {
      // A candidate that cannot even be run is not a reproduction.
      ok = false
    }
    memo.set(key, ok)
    return ok
  }

  const budgetLeft = (): boolean => runs < budget.maxRuns

  while (stagnant < budget.maxStagnantRounds && budgetLeft()) {
    const before = best.length + advanceMagnitude(best)

    // ── move 1: ddmin chunk drop ────────────────────────────────────────────
    let chunk = Math.max(1, Math.floor(best.length / 2))
    while (chunk >= 1 && budgetLeft()) {
      let removedThisPass = false
      for (let start = 0; start + chunk <= best.length && budgetLeft(); ) {
        const candidate = [...best.slice(0, start), ...best.slice(start + chunk)]
        if (candidate.length !== best.length && (await accepts(candidate))) {
          best = candidate
          moves += 1
          removedThisPass = true
          // keep `start` — the window now holds different ops
        } else {
          start += chunk
        }
      }
      if (!removedThisPass) {
        chunk = chunk === 1 ? 0 : Math.floor(chunk / 2)
      }
    }

    // ── move 2: binary-search each advance toward 0 ─────────────────────────
    for (let i = 0; i < best.length && budgetLeft(); i++) {
      const entry = best[i]
      if (entry === undefined || entry.op.kind !== 'advance' || entry.op.dtMs === 0) {
        continue
      }
      const originalDt = entry.op.dtMs
      let lo = 0
      let hi = originalDt
      let bestDt = originalDt
      while (lo < hi && budgetLeft()) {
        const mid = Math.floor((lo + hi) / 2)
        const candidate = best.map((e, j) =>
          j === i && e.op.kind === 'advance' ? { idx: e.idx, op: { ...e.op, dtMs: mid } } : e,
        )
        if (await accepts(candidate)) {
          bestDt = mid
          hi = mid
        } else {
          lo = mid + 1
        }
      }
      if (bestDt !== originalDt) {
        best = best.map((e, j) =>
          j === i && e.op.kind === 'advance' ? { idx: e.idx, op: { ...e.op, dtMs: bestDt } } : e,
        )
        moves += 1
      }
    }

    const after = best.length + advanceMagnitude(best)
    stagnant = after >= before ? stagnant + 1 : 0
  }

  return { ops: best.map((e) => e.op), runs, moves, minimal: stagnant >= budget.maxStagnantRounds }
}

/** Summed advance magnitude — part of the "did this round reduce anything" metric. */
function advanceMagnitude(ops: readonly IndexedOp[]): number {
  let total = 0
  for (const { op } of ops) {
    if (op.kind === 'advance') {
      total += Math.min(op.dtMs, 1000)
    }
  }
  return total
}
