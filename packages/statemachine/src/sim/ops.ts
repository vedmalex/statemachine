/**
 * @module sim/ops
 * @unstable
 *
 * ADR-4/5 Step-4 closed-loop op generator. `genOps(prng, driver, params)` is
 * CLOSED-LOOP against the LIVE Step-3 {@link SimDriver}: between ops the driver
 * has already run the SHARED `settleMacrostep` (in `init()` and at the end of
 * every `step()`), so `getAvailableEvents()` is probed on a SETTLED machine
 * WITHOUT any local drain in this module (R2 — there is NO `drainToQuiescence` /
 * `flush` / `Op.flush` / local drain here; the grep DoD#9 over the four Step-4
 * files returns zero).
 *
 * Op selection (deterministic in the prng draw stream):
 *  - mostly fire a REAL available event (structural availability via
 *    `getAvailableEvents`, guards NOT executed — state_machine.ts:520) to drive
 *    genuine transitions;
 *  - with `pBlind` fire a DECLARED-but-unavailable event to exercise the
 *    `invalid-event` reject path (state_machine.ts:383) — every fire is `.catch`'d
 *    inside the driver, so generation never throws;
 *  - with `pAdvance` advance the virtual clock so armed invoke timers can fire.
 *
 * Every {@link Op} carries a STABLE `id` (R22): `op-0`, `op-1`, … in emission
 * order. Dropping an op leaves the SURVIVING ids unchanged (ids are content, not
 * positions); fault-ref re-keying is Step-5/7-owned.
 */

import type { Op } from './scenario'

/** Tunables for {@link genOps}. */
export interface GenOpsParams {
  /** Hard cap on the emitted op count. */
  readonly maxOps: number
  /** Probability of firing a declared-but-unavailable event (reject path). */
  readonly pBlind: number
  /** Probability of a clock-advance op instead of a fire. */
  readonly pAdvance: number
}

/**
 * The minimal LIVE-driver surface {@link genOps} reads. The real {@link SimDriver}
 * is structurally assignable (it exposes `machine`, `step`, and `t`).
 */
export interface OpDriverView {
  /** The wired engine; genOps probes `getAvailableEvents` + `getQueueDepth`. */
  readonly machine: {
    getAvailableEvents(): string[]
    getQueueDepth(): { internal: number; external: number; total: number }
  }
  /** Drive one macrostep (settles internally; no local drain in this module). */
  step(op: { kind: 'fire'; event: string; args?: readonly unknown[] } | { kind: 'advance'; dtMs: number } | { kind: 'noop' }): Promise<unknown>
}

/** Provide the seeded PRNG surface genOps consumes. */
interface OpPrng {
  bool(p?: number): boolean
  int(maxExclusive: number): number
  pick<T>(xs: readonly T[]): T
}

/**
 * The fixed pool of DECLARED event names a blind fire may target. Drawn from the
 * generated machine's events plus a guaranteed-invalid sentinel so the
 * `invalid-event` reject path is always reachable.
 */
function blindCandidates(available: readonly string[]): readonly string[] {
  // '__no_such_event__' is never a declared event => invalid-event reject.
  return [...available, '__no_such_event__']
}

/**
 * Generate a closed-loop op stream against the live driver. Drives each chosen op
 * THROUGH the driver (so the machine advances and the next probe sees fresh
 * availability), and records the op with a stable id. Returns the recorded ops.
 *
 * @param prng the `fork('ops')` child PRNG
 * @param driver the LIVE Step-3 driver, already `init()`-ed (settled)
 * @param params op-count + blind/advance probabilities
 */
export async function genOps(prng: OpPrng, driver: OpDriverView, params: GenOpsParams): Promise<Op[]> {
  const ops: Op[] = []
  let seq = 0
  const nextId = (): string => `op-${seq++}`

  const maxOps = Math.max(0, params.maxOps)
  for (let i = 0; i < maxOps; i++) {
    // The driver settled at init / end of the previous step, so this probe reads
    // a settled machine (the shared settleMacrostep ran inside the driver — no
    // local drain here).
    const available = driver.machine.getAvailableEvents()

    // Decide the op kind deterministically.
    if (prng.bool(params.pAdvance)) {
      // advance the clock so armed invoke timers can fire.
      const dtMs = 1 + prng.int(8) // 1..8
      const op: Op = { kind: 'advance', id: nextId(), dtMs }
      ops.push(op)
      await driver.step({ kind: 'advance', dtMs })
      continue
    }

    if (prng.bool(params.pBlind) || available.length === 0) {
      // blind fire: target a declared-but-(maybe)-unavailable event, including a
      // guaranteed-invalid sentinel, to exercise the reject / invalid-event path.
      const candidates = blindCandidates(available)
      const event = prng.pick(candidates)
      const op: Op = { kind: 'fire', id: nextId(), event, args: [] }
      ops.push(op)
      await driver.step({ kind: 'fire', event, args: [] })
      continue
    }

    // real fire: pick an AVAILABLE event so the transition genuinely fires.
    const event = prng.pick(available)
    const op: Op = { kind: 'fire', id: nextId(), event, args: [] }
    ops.push(op)
    await driver.step({ kind: 'fire', event, args: [] })
  }

  return ops
}
