// src/lite.ts (INTERNAL module; the public API is exposed via src/index.ts)
// This file holds the createMachine factory. Do NOT add subsystem re-exports here—
// they belong in src/index.ts. Adding them here creates duplicate exports under
// node16 moduleResolution.

import { StateMachine } from './state_machine'
import {
  type Adapter,
  MemoryAdapter,
  type States,
  type StateMachineConfig,
  type StateMachineOptions,
  type TypedMachineConfig,
} from './types'

/**
 * Public factory for @vedmalex/statemachine. DI-free; the only factory in this package.
 *
 * The `const S` type parameter is INFERRED from `config.states`, so the literal
 * state keys are preserved and `initialState` / every transition `from` / `to`
 * are checked against {@link TypedMachineConfig | the actual declared states}
 * — a typo (`initialState: 'closd'`, `from: 'clsed'`, `to: 'opn'`) is a COMPILE
 * error. Prefer the inferred form `createMachine(config, owner)`; an explicit
 * single type argument (`createMachine<Ctx>(config, owner)`) still compiles but
 * falls back to the widened `States<T>` default and forgoes the path checking.
 */
export function createMachine<
  T extends object,
  const S extends States<T> = States<T>,
>(
  config: TypedMachineConfig<T, S>,
  owner?: T | Adapter<T>,
  options?: StateMachineOptions,
): StateMachine<T, any> {
  const smConfig = config as unknown as StateMachineConfig<T>
  if (owner && 'get' in owner) {
    return new StateMachine(smConfig, owner as any, options)
  } else if (owner) {
    const adapter = new MemoryAdapter(owner)
    return new StateMachine(smConfig, adapter as any, options)
  } else {
    return new StateMachine(smConfig, undefined, options)
  }
}
