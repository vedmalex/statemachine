/**
 * @module sim/scenarios/backpressure-timeout
 * @unstable
 *
 * Queue-backpressure + transitionTimeout capability scenarios (F-PF-1: now
 * COVERING, not gap-placeholders).
 *
 *  - `queue.backpressure.overflow`: the coverage runner's wire-time `overflow`
 *    path floods the engine with `floodCount` rapid `flood` fires under a
 *    `maxQueueDepth:2` bound; the `(max+1)`-th enqueue rejects SYNCHRONOUSLY at
 *    enqueue (state_machine.ts:234) and the runner appends a frame carrying
 *    `errorClass:'queue-overflow'` (the probe reads that errorClass).
 *
 *  - `timer.transitionTimeout`: the coverage runner's wire-time `transitionTimeout`
 *    path fires `slow` (whose `onTransition` is a hanging awaited callback) and
 *    deterministically advances the virtual clock past `timeoutMs` while
 *    processing the scheduler, so the timeout `Promise.race` leg
 *    (state_machine.ts:1789/1798) rejects with `errorClass:'transition-timeout'`
 *    (the probe reads that errorClass). The hanging callback is a closure-free
 *    literal reading only its parameter (R13).
 */

import type { CoverageScenario } from '../coverage'
import type { TopologySpec } from '../scenario'
import { lit, spec } from './_helpers'

interface O {
  state: string
  log: number[]
  k: number
}

// ── overflow ───────────────────────────────────────────────────────────────

const overflowTopology: TopologySpec = {
  name: 'overflow',
  stateAttribute: 'state',
  initialState: 'a',
  ownerSeed: { log: [], k: 0 },
  states: { a: {} },
  // 'flood' is a self-transition: each fire is admitted to the queue, so a rapid
  // flood under maxQueueDepth:2 overflows the bounded queue and the (max+1)-th
  // enqueue rejects synchronously.
  events: { flood: { transitions: [{ from: 'a', to: 'a' }] } },
}

/**
 * The registered overflow coverage scenario. No driven ops (the wire-time
 * `overflow` flood IS the drive); `maxQueueDepth:2` + a flood of 8 guarantees the
 * synchronous backpressure reject.
 */
export const overflowScenario: CoverageScenario = {
  name: 'queue-overflow',
  spec: spec(606n, overflowTopology, []),
  overflow: { event: 'flood', maxQueueDepth: 2, floodCount: 8 },
  expects: ['queue.backpressure.overflow'],
}

// ── transitionTimeout ────────────────────────────────────────────────────────

const timeoutTopology: TopologySpec = {
  name: 'transition-timeout',
  stateAttribute: 'state',
  initialState: 'a',
  ownerSeed: { log: [], k: 0 },
  states: { a: {}, b: {} },
  events: {
    // 'slow' a->b runs a hanging awaited onTransition; with transitionTimeout wired,
    // the timeout Promise.race leg rejects once the clock advances past timeoutMs.
    // The literal reads ONLY its parameter (closure-free, R13): it returns a Promise
    // that never resolves.
    slow: {
      transitions: [
        {
          from: 'a',
          to: 'b',
          onTransition: lit('(o)=>new Promise(()=>{ void o })', (_o: O) => new Promise<void>(() => {})),
        },
      ],
    },
  },
}

/**
 * The registered transitionTimeout coverage scenario. No driven ops (the wire-time
 * `transitionTimeout` path IS the drive); `timeoutMs:2` makes the bounded clock
 * advance fire the timeout race.
 */
export const transitionTimeoutScenario: CoverageScenario = {
  name: 'transition-timeout',
  spec: spec(707n, timeoutTopology, []),
  transitionTimeout: { event: 'slow', timeoutMs: 2 },
  expects: ['timer.transitionTimeout'],
}
