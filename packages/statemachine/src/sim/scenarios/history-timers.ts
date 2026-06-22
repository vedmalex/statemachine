/**
 * @module sim/scenarios/history-timers
 * @unstable
 *
 * History + timer capability scenarios:
 *  - `history.shallow`: a shallow-history composite remembers its first-level
 *    region child; after leaving and re-entering, the restore reaches the
 *    remembered child ('hs2'), distinct from a fresh enter (the initial 'hs1').
 *  - `history.deep`: a deep-history composite remembers the FULL nested path; the
 *    restore reaches the remembered grandchild leaf ('hdy'), distinct from the
 *    initial 'hd1'.
 *  - `timer.invoke.fire`: an armed invoke fires after an `advance` op and reaches
 *    the sentinel target leaf 'tfired'.
 *  - `timer.invoke.cond-skip`: an invoke with a literal-false cond is armed but its
 *    transition never fires (a separate scenario so the cond-skip probe's
 *    "no timer reached the would-be target" guard holds).
 *  - `timer.invoke.cancel-on-exit`: leaving the timer-bearing state before its
 *    delay lazily cancels the armed timer so it never fires.
 *
 * The gate runs in mode='safety'; explicit `advance` ops bring the clock to each
 * armed-timer epoch (no liveness clock-jump).
 */

import type { CoverageScenario } from '../coverage'
import type { TopologySpec } from '../scenario'
import { advance, fire, lit, spec } from './_helpers'

interface O {
  state: string
  log: number[]
  k: number
}

// ── shallow + deep history + a firing invoke timer ────────────────────────────

const historyTopology: TopologySpec = {
  name: 'history',
  stateAttribute: 'state',
  initialState: 'SH',
  ownerSeed: { log: [], k: 0 },
  states: {
    // Shallow-history composite: remembers the first-level region child (hs1/hs2).
    SH: {
      initial: 'r.hs1',
      history: 'shallow',
      regions: { r: { hs1: {}, hs2: { initial: 'm.q', regions: { m: { q: {}, w: {} } } } } },
    },
    // Deep-history composite: remembers the full nested path down to the grandchild.
    DH: {
      initial: 'r.hd1',
      history: 'deep',
      regions: { r: { hd1: {}, hd2: { initial: 'm.hdx', regions: { m: { hdx: {}, hdy: {} } } } } },
    },
    OUT: {},
    // Timer host: an armed invoke fires 'tick' (→ tfired) after a delay.
    TM: { invoke: [{ delay: 3, event: 'tick' }] },
    tfired: {},
  },
  events: {
    // shallow walk: hs1 -> hs2 (first-level child changes), leave, restore → hs2.
    shTo2: { transitions: [{ from: 'SH.r.hs1', to: 'SH.r.hs2' }] },
    shOut: { transitions: [{ from: 'SH', to: 'OUT' }] },
    wHistShallow: { transitions: [{ from: 'OUT', to: 'SH' }] },
    // deep walk: hd1 -> hd2 (enters hdx) -> hdy (grandchild), leave, restore → hdy.
    dhEnter: { transitions: [{ from: 'SH', to: 'DH' }] },
    dhTo2: { transitions: [{ from: 'DH.r.hd1', to: 'DH.r.hd2' }] },
    dhToY: { transitions: [{ from: 'DH.r.hd2.m.hdx', to: 'DH.r.hd2.m.hdy' }] },
    dhOut: { transitions: [{ from: 'DH', to: 'OUT' }] },
    wHistDeep: { transitions: [{ from: 'OUT', to: 'DH' }] },
    // arm a timer host; the timer fires 'tick' (→ tfired) after the advance.
    toTimer: { transitions: [{ from: 'DH', to: 'TM' }] },
    tick: { transitions: [{ from: 'TM', to: 'tfired' }] },
  },
}

const historyOps = [
  fire('shTo2'), // SH.r.hs1 -> SH.r.hs2 (shallow now remembers hs2)
  fire('shOut'), // SH -> OUT
  fire('wHistShallow'), // OUT -> SH (shallow restore → hs2)
  fire('dhEnter'), // SH -> DH
  fire('dhTo2'), // DH.r.hd1 -> DH.r.hd2 (enters hdx)
  fire('dhToY'), // DH.r.hd2.m.hdx -> DH.r.hd2.m.hdy (deep now remembers hdy)
  fire('dhOut'), // DH -> OUT
  fire('wHistDeep'), // OUT -> DH (deep restore → hdy)
  fire('toTimer'), // DH -> TM (arms the invoke timer)
  advance(5), // clock past the delay → timer fires 'tick' → tfired
]

/** The registered history + firing-timer coverage scenario. */
export const historyTimersScenario: CoverageScenario = {
  name: 'history-timers',
  spec: spec(303n, historyTopology, historyOps),
  expects: ['history.shallow', 'history.deep', 'timer.invoke.fire'],
}

// ── cond-skip + cancel-on-exit (separate scenario; no timer reaches its target) ─

const condSkipTopology: TopologySpec = {
  name: 'cond-skip',
  stateAttribute: 'state',
  initialState: 'arm',
  ownerSeed: { log: [], k: 0 },
  states: {
    // Two armed invokes: one whose cond is literal-false (cond-skip), one we leave
    // before its delay (cancel-on-exit). NEITHER ever reaches its target leaf.
    arm: {
      invoke: [
        { delay: 2, event: 'skipped', cond: lit('(o)=>false', (_o: O) => false) },
        { delay: 9, event: 'cancelled' },
      ],
    },
    moved: {},
    cancelTarget: {},
    skiptarget: {},
  },
  events: {
    // leaving 'arm' before delay:9 lazily cancels the 'cancelled' timer.
    wCancelArm: { transitions: [{ from: 'arm', to: 'moved' }] },
    // would-be targets; never reached (cond false / timer cancelled).
    skipped: { transitions: [{ from: 'arm', to: 'skiptarget' }] },
    cancelled: {
      transitions: [
        { from: 'arm', to: 'cancelTarget' },
        { from: 'moved', to: 'cancelTarget' },
      ],
    },
  },
}

const condSkipOps = [
  advance(3), // past delay:2 → 'skipped' invoke cond → false → SKIP (no transition)
  fire('wCancelArm'), // arm -> moved (lazily cancels the delay:9 'cancelled' timer)
  advance(12), // past delay:9 → the cancelled timer is gone → no fire
]

/** The registered cond-skip + cancel-on-exit coverage scenario. */
export const condSkipScenario: CoverageScenario = {
  name: 'cond-skip-cancel',
  spec: spec(304n, condSkipTopology, condSkipOps),
  expects: ['timer.invoke.cond-skip', 'timer.invoke.cancel-on-exit'],
}
