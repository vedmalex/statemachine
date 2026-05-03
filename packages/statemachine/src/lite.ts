// src/lite.ts (INTERNAL module; the public API is exposed via src/index.ts)
// This file holds the createMachine factory. Do NOT add subsystem re-exports here—
// they belong in src/index.ts. Adding them here creates duplicate exports under
// node16 moduleResolution.

import { StateMachine } from './state_machine'
import {
  type Adapter,
  MemoryAdapter,
  type StateMachineConfig,
  type StateMachineOptions,
} from './types'

/**
 * Public factory for @vedmalex/statemachine. DI-free; the only factory in this package.
 */
export function createMachine<T extends object>(
  config: StateMachineConfig<T>,
  owner?: T | Adapter<T>,
  options?: StateMachineOptions,
): StateMachine<T, any> {
  if (owner && 'get' in owner) {
    return new StateMachine(config, owner as any, options)
  } else if (owner) {
    const adapter = new MemoryAdapter(owner)
    return new StateMachine(config, adapter as any, options)
  } else {
    return new StateMachine(config, undefined, options)
  }
}
