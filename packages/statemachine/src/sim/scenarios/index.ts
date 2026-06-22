/**
 * @module sim/scenarios
 * @unstable
 *
 * The registered Step-9 coverage scenario set. Each module exports one
 * {@link CoverageScenario} (a hand-authored {@link ScenarioSpec} + an optional
 * `expects` capability tag list). `coverage.test.ts` imports THIS barrel, which is
 * the knip reachability path for the `scenarios/*.ts` class (ADR-7 D7 class #3).
 *
 * Every callback is a closure-free literal (reads ONLY its parameter) so it
 * survives the `security.ts:640` restricted-scope re-eval the harness uses to
 * re-create it from `source` (R13). All scenarios are DETERMINISTIC: the coverage
 * gate runs each twice and asserts byte-identical `hashTrace` (I-1) before
 * counting.
 */

import type { CoverageScenario } from '../coverage'
import { overflowScenario, transitionTimeoutScenario } from './backpressure-timeout'
import { coreEventsScenario } from './core-events'
import { errorsFaultsScenario } from './errors-faults'
import { hierarchyRegionsScenario } from './hierarchy-regions'
import { condSkipScenario, historyTimersScenario } from './history-timers'
import { persistenceScenario } from './persistence'

/** The full ordered coverage scenario registry consumed by {@link import('../coverage').computeCoverage}. */
export const COVERAGE_SCENARIOS: readonly CoverageScenario[] = [
  coreEventsScenario,
  hierarchyRegionsScenario,
  historyTimersScenario,
  condSkipScenario,
  errorsFaultsScenario,
  persistenceScenario,
  overflowScenario,
  transitionTimeoutScenario,
]

export { coreEventsScenario } from './core-events'
export { hierarchyRegionsScenario } from './hierarchy-regions'
export { condSkipScenario, historyTimersScenario } from './history-timers'
export { errorsFaultsScenario } from './errors-faults'
export { persistenceScenario } from './persistence'
export { overflowScenario, transitionTimeoutScenario } from './backpressure-timeout'
