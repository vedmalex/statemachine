/**
 * @module sim/scenarios/hierarchy-regions
 * @unstable
 *
 * Hierarchy + parallel-region capability scenario:
 *  - `hierarchy.nested-enter`: entering composite C enters its initial child.
 *  - `composite.parallel-regions`: a parallel composite renders a |-joined config.
 *  - `composite.join.done-state` + `inspection.isDone`: a parallel composite whose
 *    region leaves are ALL final STAYS done (no `done.state.<C>` transition leaves
 *    it), so the coverage runner samples isDone(C)=true at the settle boundary and
 *    stores it on the frame's `doneDelta` — the probes read THAT projection, never
 *    a live sm.isDone(). (A composite that immediately transitions out on
 *    `done.state.<C>` is done only transiently and cannot be sampled post-hoc.)
 *  - `event.raise.internal`: a `delay:0` invoke at the initial state raises its
 *    event during the post-construction init drain (a `cause:'init'` state change).
 */

import type { CoverageScenario } from '../coverage'
import type { TopologySpec } from '../scenario'
import { fire, lit, spec } from './_helpers'

interface O {
  state: string
  log: number[]
  k: number
}

const topology: TopologySpec = {
  name: 'hierarchy-regions',
  stateAttribute: 'state',
  initialState: 'boot',
  ownerSeed: { log: [], k: 0 },
  states: {
    // event.raise.internal: a delay:0 invoke fires during the init drain (the
    // raised 'booted' event is processed internally → cause:'init' state change).
    boot: { invoke: [{ delay: 0, event: 'booted', cond: lit('(o)=>o.k===0', (o: O) => o.k === 0) }] },
    sa: {},
    // hierarchy.nested-enter: entering 'C' enters its initial child c1.
    C: { initial: 'c1', states: { c1: {}, c2: {} } },
    // composite.parallel-regions + join + isDone: P's regions are ALL final, so P
    // STAYS done (no done.state.P transition leaves it).
    P: {
      initial: 'pr1.f1|pr2.f2',
      regions: {
        pr1: { f1: { final: true }, g1: {} },
        pr2: { f2: { final: true }, g2: {} },
      },
    },
  },
  events: {
    // delay:0 init raise routes boot -> sa internally.
    booted: { transitions: [{ from: 'boot', to: 'sa' }] },
    // hierarchy.nested-enter: sa -> C.
    wNestedEnter: { transitions: [{ from: 'sa', to: 'C' }] },
    // enter the parallel composite (stays done).
    toParallel: { transitions: [{ from: 'C', to: 'P' }] },
  },
}

/**
 * Op stream: the init drain raises 'booted' (boot -> sa). Then enter the nested
 * composite and the parallel composite. Entering P with all regions final makes it
 * done and it STAYS done; the runner samples isDone('P')=true at the boundary.
 */
const opStream = [
  fire('wNestedEnter'), // sa -> C (enters c1)
  fire('toParallel'), // C -> P (parallel; all regions final → P stays done)
]

/** The registered hierarchy + regions coverage scenario. */
export const hierarchyRegionsScenario: CoverageScenario = {
  name: 'hierarchy-regions',
  spec: spec(202n, topology, opStream),
  expects: [
    'hierarchy.nested-enter',
    'composite.parallel-regions',
    'composite.join.done-state',
    'inspection.isDone',
    'event.raise.internal',
  ],
}
