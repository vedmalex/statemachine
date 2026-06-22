/**
 * @module sim/scenarios/persistence
 * @unstable
 *
 * Persistence + timer-resume capability scenario (F-PF-1: now COVERING, not a
 * gap-placeholder).
 *
 * `persistence.serialize` / `persistence.deserialize` / `timer.resume` are driven
 * by the coverage runner's wire-time `snapshotRestore` path: after the op stream
 * the runner calls the engine's PUBLIC `saveState(mem)` (serialize) then
 * `restoreState(mem)` (deserialize + `resumeTimers()` re-arm — state_machine.ts:740)
 * and appends exactly ONE `synthetic:'post-restore'` frame. The three probes read
 * that frame:
 *  - `persistence.serialize` / `persistence.deserialize`: `synthetic:'post-restore'`
 *    is the serialize→restore round-trip witness.
 *  - `timer.resume`: `restoreState` re-arms the timer-bearing state's invoke timers
 *    via `resumeTimers()`; the same `synthetic:'post-restore'` frame is the witness.
 *
 * The machine carries a timer-bearing state (`tm` arms a `delay:5` invoke) so the
 * restore genuinely re-arms a pending invoke timer (timer.resume), not just a
 * stateless round-trip.
 */

import type { CoverageScenario } from '../coverage'
import type { TopologySpec } from '../scenario'
import { fire, spec } from './_helpers'

const topology: TopologySpec = {
  name: 'persistence',
  stateAttribute: 'state',
  initialState: 'sa',
  ownerSeed: { log: [], k: 0 },
  states: {
    sa: {},
    // tm arms a pending invoke timer so restoreState's resumeTimers() re-arms it
    // (the timer.resume witness). We DO NOT advance past the delay, so the timer is
    // still pending at snapshot time and must be re-armed on restore.
    tm: { invoke: [{ delay: 5, event: 'tick' }] },
    tfired: {},
  },
  events: {
    go: { transitions: [{ from: 'sa', to: 'tm' }] },
    tick: { transitions: [{ from: 'tm', to: 'tfired' }] },
  },
}

const opStream = [fire('go')] // sa -> tm (arms the delay:5 invoke timer)

/**
 * The registered persistence + timer-resume coverage scenario. The `snapshotRestore`
 * envelope flag drives the wire-time save/restore round-trip (see module doc); the
 * `synthetic:'post-restore'` frame the runner appends covers all three ids.
 */
export const persistenceScenario: CoverageScenario = {
  name: 'persistence',
  spec: spec(505n, topology, opStream),
  snapshotRestore: true,
  expects: ['persistence.serialize', 'persistence.deserialize', 'timer.resume'],
}
