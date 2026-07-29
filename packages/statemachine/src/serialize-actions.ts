/**
 * Body-free function-reference serialization.
 *
 * The single live serialization primitive extracted from the former
 * `security.ts` (W0.2 §0.6 — the surrounding blocklist/validator layer was dead
 * code and was removed). A callback is serialized as a NAME reference plus,
 * where a stable per-slot identity is available, a composite SLOT key.
 *
 * W0 security invariant (defect П1): the function BODY is NEVER serialized, so
 * no far side can recompile it. Restoration (`state_machine.ts` /
 * `deserializeAction`) resolves the reference against a consumer-supplied
 * registry (`StateMachineOptions.actions`) — an unknown reference throws, a
 * body is never compiled.
 *
 * W0.2 C1: a function's own `.name` is a slot LABEL, not a stable identity —
 * three distinct `onEnter` callbacks all report `.name === 'onEnter'` and would
 * collide in a name-keyed registry. The optional `slot` (e.g.
 * `'green.onEnter'`, `'parent.r1.child.onEnter'`) carries the state-path
 * identity so restoration can prefer an exact per-slot key over the shared name.
 */

import type { ActionOrString, ErrorHandlerOrString } from './types'

/**
 * A serialized action reference. Never carries a function body.
 *
 *  - `{ type: 'string', name }` — a method-name reference resolved at call time
 *    against the owner/context.
 *  - `{ type: 'function', name, slot? }` — a function reference stored by NAME
 *    (its own `.name`) plus, for state-hook slots, a composite `slot` path
 *    (`<stateName>.<hook>`). Restoration prefers the slot key, then the name.
 */
export type SafeSerializedAction =
  | {
      type: 'string'
      name: string
    }
  | {
      type: 'function'
      name: string
      /**
       * Composite state-path identity (`<stateName>.<hook>`) when the callback
       * occupies a named state slot. Absent for event/transition/config hooks
       * that have no state-path identity. Preferred over `name` on restore.
       */
      slot?: string
    }

/**
 * Serializes an action into a body-free reference.
 *
 * - A string action is a method-name reference, kept verbatim.
 * - A function action is stored by its `.name` only (never its body — W0
 *   invariant П1). A `slot` path, when supplied, is emitted alongside for
 *   per-slot disambiguation (W0.2 C1).
 * - Anything else serializes to `undefined`.
 */
export function serializeActionRef<TOwner extends object, R = void>(
  action:
    | ActionOrString<TOwner, R>
    | ErrorHandlerOrString<TOwner>
    | undefined,
  slot?: string,
): SafeSerializedAction | undefined {
  if (typeof action === 'string') {
    return { type: 'string', name: action }
  }
  if (typeof action === 'function') {
    const name = action.name ?? ''
    return slot !== undefined && slot.length > 0
      ? { type: 'function', name, slot }
      : { type: 'function', name }
  }
  return undefined
}

/**
 * Async form of {@link serializeActionRef}. There is no hashing or crypto, so
 * no asynchronous work remains; the async signature is retained for the
 * `toSecureJSON` call-site.
 */
export async function serializeActionRefAsync<
  TOwner extends object,
  R = void,
>(
  action:
    | ActionOrString<TOwner, R>
    | ErrorHandlerOrString<TOwner>
    | undefined,
  slot?: string,
): Promise<SafeSerializedAction | undefined> {
  return serializeActionRef(action, slot)
}
