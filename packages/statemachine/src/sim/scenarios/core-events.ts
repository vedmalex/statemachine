/**
 * @module sim/scenarios/core-events
 * @unstable
 *
 * Core event-handling capability scenario: external fire, guard pass/block,
 * priority, wildcard, onTransition + the full entry/exit hook triad + event-level
 * onBefore/onAfter — all observed through the content-only trace. Hooks are
 * observed via the marker→sentinel-guard indirection: each hook APPENDS a distinct
 * integer to `o.log`, and a downstream sentinel event's guard reads
 * `o.log.includes(N)`, so a `resolve-true` on the sentinel event is the proof THAT
 * specific hook ran (no live engine read). Every callback is a closure-free
 * literal that reads only its parameter (R13).
 */

import type { CoverageScenario } from '../coverage'
import type { TopologySpec } from '../scenario'
import { fire, lit, spec } from './_helpers'

interface O {
  state: string
  log: number[]
  k: number
}

/** Closure-free literal that appends `n` to `o.log` (a hook marker). */
function mark(n: number) {
  return lit(`(o)=>{o.log.push(${n})}`, (o: O) => {
    o.log.push(n)
  })
}

/** Closure-free literal guard `o.log.includes(n)` (a hook witness). */
function sawMark(n: number) {
  return lit(`(o)=>o.log.includes(${n})`, (o: O) => o.log.includes(n))
}

const topology: TopologySpec = {
  name: 'core-events',
  stateAttribute: 'state',
  initialState: 'sa',
  ownerSeed: { log: [], k: 0 },
  states: {
    sa: {},
    // entry/exit hook host: each hook appends a distinct marker.
    hub: {
      onBeforeEnter: mark(11),
      onEnter: mark(12),
      onAfterEnter: mark(13),
      onBeforeExit: mark(21),
      onExit: mark(22),
      onAfterExit: mark(23),
    },
    sc: {},
    sd: {},
    se: {},
    low: {},
    phi: {},
    p2: {},
    wa: {},
    wb: {},
    ot1: {},
    ot2: {},
    eb1: {},
    eb2: {},
    ea1: {},
    ea2: {},
  },
  events: {
    // event.fire.external + enter the hook host (entry triad appends 11,12,13).
    enterHub: { transitions: [{ from: 'sa', to: 'hub' }] },
    // entry-triad witnesses (each reads its own marker).
    wOnBeforeEnter: { transitions: [{ from: 'hub', to: 'sc', guard: sawMark(11) }] },
    wOnEnter: { transitions: [{ from: 'sc', to: 'sd', guard: sawMark(12) }] },
    wOnAfterEnter: { transitions: [{ from: 'sd', to: 'se', guard: sawMark(13) }] },
    // guard pass / block sentinels.
    wGuardPass: { transitions: [{ from: 'se', to: 'ot1', guard: sawMark(13) }] },
    wGuardBlock: { transitions: [{ from: 'ot1', to: 'ot2', guard: sawMark(999) }] },
    // re-enter hub from ot1 to set up the exit triad.
    reEnterHub: { transitions: [{ from: 'ot1', to: 'hub' }] },
    // leaving hub appends 21,22,23; the exit witnesses read them.
    leaveHub: { transitions: [{ from: 'hub', to: 'eb1', guard: sawMark(13) }] },
    wOnBeforeExit: { transitions: [{ from: 'eb1', to: 'eb2', guard: sawMark(21) }] },
    wOnExit: { transitions: [{ from: 'eb2', to: 'ea1', guard: sawMark(22) }] },
    wOnAfterExit: { transitions: [{ from: 'ea1', to: 'ea2', guard: sawMark(23) }] },
    // priority: higher-priority 'phi' must win over 'low'.
    toPrio: { transitions: [{ from: 'ea2', to: 'p2' }] },
    wPrio: {
      transitions: [
        { from: 'p2', to: 'low', priority: 1 },
        { from: 'p2', to: 'phi', priority: 10 },
      ],
    },
    // onTransition marker → witness.
    otGo: { transitions: [{ from: 'phi', to: 'low', onTransition: mark(41) }] },
    wOnTransition: { transitions: [{ from: 'low', to: 'eb1', guard: sawMark(41) }] },
    // event-level onBefore / onAfter markers → witnesses.
    evtBeforeGo: { transitions: [{ from: 'eb1', to: 'eb2' }], onBefore: mark(31) },
    wOnBefore: { transitions: [{ from: 'eb2', to: 'ea1', guard: sawMark(31) }] },
    evtAfterGo: { transitions: [{ from: 'ea1', to: 'ea2' }], onAfter: mark(32) },
    wOnAfter: { transitions: [{ from: 'ea2', to: 'wa', guard: sawMark(32) }] },
    // wildcard: 'wWildcard' is NOT declared as its own event; '*' catches it.
    '*': { transitions: [{ from: 'wa', to: 'wb' }] },
  },
}

/** Deterministic op stream: each declared edge taken in order. */
const opStream = [
  fire('enterHub'), // sa -> hub  (entry triad appends 11,12,13)
  fire('wOnBeforeEnter'), // hub -> sc  (onBeforeEnter witness: log has 11)
  fire('wOnEnter'), // sc -> sd          (onEnter witness: 12)
  fire('wOnAfterEnter'), // sd -> se     (onAfterEnter witness: 13)
  fire('wGuardPass'), // se -> ot1       (guard log.includes(13) true)
  fire('wGuardBlock'), // ot1            (guard log.includes(999) false → resolve-false)
  fire('reEnterHub'), // ot1 -> hub      (re-enter hub: entry triad appends again)
  fire('leaveHub'), // hub -> eb1        (leaving hub appends 21,22,23)
  fire('wOnBeforeExit'), // eb1 -> eb2   (onBeforeExit witness: 21)
  fire('wOnExit'), // eb2 -> ea1         (onExit witness: 22)
  fire('wOnAfterExit'), // ea1 -> ea2    (onAfterExit witness: 23)
  fire('toPrio'), // ea2 -> p2
  fire('wPrio'), // p2 -> phi            (priority: higher wins)
  fire('otGo'), // phi -> low            (onTransition appends 41)
  fire('wOnTransition'), // low -> eb1   (onTransition witness)
  fire('evtBeforeGo'), // eb1 -> eb2     (onBefore appends 31)
  fire('wOnBefore'), // eb2 -> ea1       (onBefore witness)
  fire('evtAfterGo'), // ea1 -> ea2      (onAfter appends 32)
  fire('wOnAfter'), // ea2 -> wa         (onAfter witness)
  fire('wWildcard'), // wa -> wb         (wildcard catches the undeclared event)
]

/** The registered core-events coverage scenario. */
export const coreEventsScenario: CoverageScenario = {
  name: 'core-events',
  spec: spec(101n, topology, opStream),
  expects: [
    'event.fire.external',
    'transition.guard.pass',
    'transition.guard.block',
    'transition.priority',
    'transition.onTransition',
    'event.wildcard',
    'hook.entry.onBeforeEnter',
    'hook.entry.onEnter',
    'hook.entry.onAfterEnter',
    'hook.exit.onBeforeExit',
    'hook.exit.onExit',
    'hook.exit.onAfterExit',
    'event.onBefore',
    'event.onAfter',
    'inspection.getQueueDepth',
    'inspection.getCurrentStateInfo',
  ],
}
