/**
 * @module sim/capture
 * @unstable
 *
 * ADR-3 C (R1) Adapter-write capture seam — the single ratified capture
 * primitive. A harness-owned wrapper of the consumer's {@link Adapter} that
 * observes EVERY engine state-write as a raw `(from,to)` pair, REPLACING the
 * superseded capture-inside-`recordTransition` mechanism (which runs `(time,true)`
 * at state_machine.ts:2060 AFTER the :2048 write, cannot read `from`, and is
 * blind to the errorState fallback at :2020 and the history-restore bypasses).
 *
 * Wrapping the `set` METHOD is load-bearing: all THREE write sites funnel through
 * `adaptee.set(this.stateAttribute, ...)`:
 *  - :1116 shallow-history restore (`return` before :1204)
 *  - :1126 deep-history restore    (`return` before :1204)
 *  - :1204 setCurrentStateInternal
 * plus the errorState fallback at :2020 (`setCurrentState; return`, which skips
 * the :2060 recordTransition).
 *
 * {@link CaptureSink} is CONTEXT-FREE: it observes only the raw `(from,to)` of
 * each write. The driver (Step 3) supplies the live sink that stamps
 * `cause` / `event` / `synthetic` / `faultApplied`. This seam does NOT touch
 * `inFlightAsyncCount` (Step 3) and does NOT wrap callbacks for faults (Step 5).
 */

import type { Adapter } from '../index'

/** A single observed engine state-write, as raw (pre-normalization) strings. */
export interface CapturedWrite {
  /** Value read from the state attribute BEFORE the write (`'' ` if absent). */
  readonly from: string
  /** Value being written to the state attribute. */
  readonly to: string
}

/**
 * Context-free sink fed one {@link CapturedWrite} per state-attribute write, in
 * write order. The Step-3 driver supplies the live implementation; the seam
 * itself never synthesizes cause/event/synthetic.
 */
export interface CaptureSink {
  onStateWrite(write: CapturedWrite): void
}

/**
 * Wrap a consumer {@link Adapter} so every write to `stateAttribute` emits a
 * raw `(from,to)` {@link CapturedWrite} to `sink`, atomic read-before-set:
 * read `from` from the inner adapter, perform the inner write, THEN emit. Writes
 * to any OTHER property pass through unobserved.
 *
 * The returned object delegates `get` and the `adaptee` getter to `adaptee`, so
 * the engine treats it as a real Adapter: `isAdapter(wrapped) === true`
 * (types.ts:301 — `'set' in inp && 'get' in inp`) and the `adaptee` getter is
 * preserved (ADR-7 c13).
 *
 * @typeParam T owner object type
 * @param adaptee the real consumer adapter to wrap
 * @param stateAttribute the engine's `config.stateAttribute` — the ONLY property
 *   whose writes are observed
 * @param sink context-free observer of `(from,to)` pairs
 */
export function wrapAdapterForCapture<T extends object>(
  adaptee: Adapter<T>,
  stateAttribute: keyof T,
  sink: CaptureSink,
): Adapter<T> {
  const wrapped: Adapter<T> = {
    get adaptee(): T {
      return adaptee.adaptee
    },
    get(property: keyof T): T[keyof T] {
      return adaptee.get(property)
    },
    set(property: keyof T, value: T[keyof T]): void {
      if (property === stateAttribute) {
        // atomic read-before-set: capture `from` from the inner adapter first
        const from = String(adaptee.get(stateAttribute) ?? '')
        adaptee.set(property, value)
        sink.onStateWrite({ from, to: String(value) })
        return
      }
      adaptee.set(property, value)
    },
  }
  // The wrapper has both `get` and `set` own-properties by construction, so
  // isAdapter(wrapped) is statically true (types.ts:301 — `'set' in inp &&
  // 'get' in inp`). The seam preserves Adapter-ness (ADR-7 c13); a
  // capture-seam.test.ts case asserts isAdapter(wrapped) === true behaviorally.
  return wrapped
}
