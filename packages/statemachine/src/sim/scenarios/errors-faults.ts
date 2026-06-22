/**
 * @module sim/scenarios/errors-faults
 * @unstable
 *
 * Error-recovery capability scenario: the `errorState` zombie-state fallback. A
 * throwing `onEnter` on the target state routes the engine to the configured
 * `errorState` (state_machine.ts:2020) — observable as a transition whose
 * normalized `to` reaches the sentinel errorState `errst`.
 *
 * The function-valued-callback throws (`error.guard-throw` / `error.action-throw`
 * / `error.recovery.abortOnExitError`) are DOCUMENTED_GAP ids: the engine SWALLOWS
 * a function-valued throw inside callAction's `.catch(processError)`
 * (state_machine.ts:1774), so the throw is a HARNESS-boundary signal (Step-5
 * `applyThrowFaults`), NOT an `errorClass` in the fault-free content trace this
 * gate drives. On a STRING-METHOD machine they are additionally structurally
 * unreachable — reported `n/a-string-method`, never a silent pass (ISS-029).
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
  name: 'errors-faults',
  stateAttribute: 'state',
  initialState: 'sa',
  ownerSeed: { log: [], k: 0 },
  states: {
    sa: {},
    // entering 'boom' throws in onEnter → engine routes to the errorState.
    boom: {
      onEnter: lit('(o)=>{throw new Error("boom"+(o.k*0))}', (_o: O) => {
        throw new Error('boom')
      }),
    },
    // the configured zombie-state fallback.
    errst: {},
  },
  events: {
    // wErrorState fires sa -> boom; boom's onEnter throws → fallback to errst.
    wErrorState: { transitions: [{ from: 'sa', to: 'boom' }] },
  },
}

const opStream = [
  fire('wErrorState'), // sa -> boom (onEnter throws) → errorState 'errst'
]

/**
 * The registered error-recovery coverage scenario. `transitionTimeoutMs` is left
 * unset (the timeout capability is a DOCUMENTED_GAP id driven only by the Step-5
 * fault plane). The `errorState` wiring is threaded by the coverage runner from
 * `spec.errorState` below.
 */
export const errorsFaultsScenario: CoverageScenario = {
  name: 'errors-faults',
  spec: spec(404n, topology, opStream),
  errorState: 'errst',
  expects: ['error.recovery.errorState'],
}
