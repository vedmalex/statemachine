/**
 * @module sim/trace
 * @unstable
 *
 * ADR-1 FROZEN canonical content-only trace schema + hashTrace + the '|'
 * part-normalizer + configHash.
 *
 * The single cross-module type dependency is `import type { SettleReason }`
 * (settle.ts) — a TYPE-ONLY import (fully erased, no runtime edge / cycle) so the
 * frame can record WHY a boundary was non-quiescent for the I-3 oracle.
 *
 * The hash plane is content-ONLY: a {@link TraceFrame} is structurally
 * incapable of carrying wall-clock / duration / heap / hrtime / errorCode /
 * message. Two runs of the same scenario+seed produce byte-identical
 * {@link hashTrace} output regardless of how long they took or how much memory
 * they used. {@link hashTrace} MUST NOT JSON.stringify anything that could carry
 * a function (functions stringify to `undefined` and silently drop), and
 * {@link configHash} folds `Function.prototype.toString()` bodies WITHOUT ever
 * calling JSON.stringify / toJSON / toSecureJSON (those bake
 * `createdAt: Date.now()` at security.ts:430/462/468).
 *
 * `cause` and `synthetic` are TWO ORTHOGONAL closed unions (R6): `cause` is the
 * 4 engine-causal kinds; `synthetic` is the separate harness-origin discriminator.
 */

import type { SettleReason } from './settle'

/** CLOSED engine-causal kinds. */
export type TraceCause = 'init' | 'external' | 'timer' | 'internal'
/** CLOSED harness-origin discriminator — ORTHOGONAL to {@link TraceCause}. */
export type TraceSynthetic = 'errorState-fallback' | 'corrupt-state' | 'post-restore'
/** Outcome of a single fireEvent. */
export type FireOutcome = 'resolve-true' | 'resolve-false' | 'reject'

/**
 * FROZEN errorClass enum — computed ONCE at the harness try/catch boundary by
 * field-selection, NEVER from error.message (the frame strips message).
 * Each literal maps to a verified engine throw/reject site.
 */
export type ErrorClass =
  | 'queue-overflow' // state_machine.ts:234 (sync reject at enqueue)
  | 'max-transition-depth' // :303
  | 'transition-timeout' // :1790 (no Date.now; Promise.race :1798/:1802)
  | 'invalid-event' // :383
  | 'injected-fault' // harness InjectedFault; callAction catch ~:1774
  | 'contradictory-state' // validateCompositeState throw :1614 — I-6 witness
  | 'invalid-state-path' // read-path throw :1220 — I-10 witness

/**
 * CLOSED content-only trace frame. NO duration/timestamp/heap/hrtime/errorCode/
 * message member — the exclusion is STRUCTURAL: such a field is a compile error
 * on a frame literal (proven by @ts-expect-error tests).
 */
export interface TraceFrame {
  readonly step: number
  /** LOGICAL virtual time = SimClock.now(); NEVER Date.now(). */
  readonly t: number
  readonly cause: TraceCause
  readonly synthetic?: TraceSynthetic
  /** 'done.state.<C>' / '*' distinguishable (isEngineDoneEvent state_machine.ts:367). */
  readonly event?: string
  /** normalized split('|').sort().join('|'). */
  readonly from: string
  /** normalized. */
  readonly to: string
  readonly queue: { readonly internal: number; readonly external: number }
  readonly quiescent: boolean
  /** FROZEN enum ONLY; never error.message / toJSON(). */
  readonly errorClass?: ErrorClass
  /** channel-fault tag (NOT 'corrupt-state'). */
  readonly faultApplied?: FaultKind
  readonly fireOutcome?: FireOutcome
  /**
   * Why a settle of this step did NOT reach quiescence — the {@link SettleReason}
   * the macrostep returned. This is DETERMINISTIC content (never wall-clock): a
   * WAITING_ON_* boundary is a DOCUMENTED, legitimate non-quiescence (a concurrent
   * region's own future timer / transitionTimeout), which the I-3
   * RTC-serialization oracle MUST NOT mistake for a real serialization break.
   * Absent on a step whose every settle converged — so it perturbs the content
   * hash ONLY for scenarios that were genuinely non-quiescent. (C1 fix.)
   *
   * WHICH settle. Normally the one whose outcome {@link quiescent} also reports:
   * the step's post-fire drain, or the construction drain for a `cause:'init'`
   * frame. A step also runs a PRE-fire drain (after any clock advance, before the
   * op) whose result was previously discarded entirely; when THAT one failed to
   * converge and the post-fire one succeeded, its reason is recorded here instead
   * — otherwise a budget exhaustion that the following fire happened to clear
   * would leave no trace at all, and the advisory budget warnings would
   * under-count. In that case (and only that case) `quiescent` is `true` while
   * this field is present: the step DID end settled, and the reason describes an
   * earlier drain within the same step. Oracles key on `quiescent === false`
   * first, so the combination cannot manufacture a violation.
   */
  readonly settleReason?: SettleReason
  /**
   * captured isDone(C)-per-composite at the settle boundary, stored as DERIVED
   * frame data. Probes read THIS, never a live sm.isDone() (which requires a
   * compositeId — state_machine.ts:1433).
   */
  readonly doneDelta?: ReadonlyArray<{ readonly composite: string; readonly done: boolean }>
}

/**
 * The seven channel-fault literals (NOT 'corrupt-state'). Owned conceptually by
 * Step 5 (faults.ts) but referenced by {@link TraceFrame.faultApplied} here so
 * the frame schema is self-contained at Step 1. Step 5 re-exports its own
 * `FaultKind`; this alias is the frozen shape both share.
 */
export type FaultKind =
  | 'reorder'
  | 'drop'
  | 'dup'
  | 'overflow'
  | 'clock-skew'
  | 'timer-jitter'
  | 'throw'

/**
 * FROZEN prng version tag. Tied to the FROZEN splitmix64 mixer / FNV / fork
 * combine / Lemire constants in prng.ts. A change to ANY of those constants
 * MUST bump this tag (it is a corpus-breaking change).
 */
export const PRNG_VERSION = 'splitmix64-bigint-v1' as const

/** Canonical trace header — every field participates in {@link hashTrace}. */
export interface CanonicalHeader {
  /** serialized bigint seed. */
  readonly seed: string
  /** structural walk folding Function.prototype.toString(); NEVER JSON.stringify/toJSON/toSecureJSON. */
  readonly configHash: string
  readonly engine: string
  /** trace-schema version (bump on closed-union/hashed-field change). */
  readonly version: string
  /** pins microtask-FIFO + Date-fake scope. */
  readonly runtime: string
  readonly prngVersion: typeof PRNG_VERSION
  /** ADR-3(D): isEnabled()===true pinned (gate state_machine.ts:424). */
  readonly errorHandlerEnabled: true
}

/** Canonical trace = header + frames. The hash input. */
export interface CanonicalTrace {
  readonly header: CanonicalHeader
  readonly frames: readonly TraceFrame[]
}

/** Alias for the canonical trace. */
export type SimTrace = CanonicalTrace

/**
 * Normalize a '|'-separated composite-state string: split on '|', sort with the
 * DEFAULT lexicographic comparator (byte-for-byte the same ordering as
 * state_machine.ts:639 `currentState.split('|').sort()` — NO custom/locale
 * comparator), and rejoin. This compensates the insertion-order render at
 * state_machine.ts:1202 so two states differing only by part order normalize
 * equal.
 */
export function normalizeParts(s: string): string {
  return s.split('|').sort().join('|')
}

/**
 * Stable, key-sorted serialization of a value drawn from a {@link CanonicalTrace}.
 * A canonical trace carries ONLY string / number / boolean / undefined-optional /
 * nested-object / array values — by construction NO function and NO bigint (the
 * content-only schema excludes wall-clock/heap/etc and the {@link TraceFrame}
 * type has no function-valued field). Object keys are sorted with the default
 * comparator; arrays preserve order; absent optionals are dropped so they do not
 * perturb the hash. This is the ONLY serializer {@link hashTrace} uses.
 */
function stableSerialize(value: string | number | boolean | object | readonly unknown[]): string {
  if (value === null) {
    return 'null'
  }
  const t = typeof value
  if (t === 'number' || t === 'boolean' || t === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableSerialize(v as string | number | boolean | object)).join(',')}]`
  }
  // plain object — key-sorted, absent optionals dropped
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts: string[] = []
  for (const k of keys) {
    const v = obj[k]
    if (v === undefined) {
      continue // drop absent optional fields so they don't perturb the hash
    }
    parts.push(`${JSON.stringify(k)}:${stableSerialize(v as string | number | boolean | object)}`)
  }
  return `{${parts.join(',')}}`
}

/**
 * FNV-1a 32-bit string digest rendered as 8 hex chars. Used only to turn the
 * stable serialization into a compact hash string; collision resistance is not
 * a security property here (sim corpus stability is the goal).
 */
function fnv1a32Hex(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * Hash a canonical trace. Key-sorted stable serialization over `{header,frames}`.
 * Structurally incapable of referencing an excluded field (the {@link TraceFrame}
 * type has none) and never JSON.stringify's a value that could carry functions
 * (the content-only trace has none).
 */
export function hashTrace(trace: CanonicalTrace): string {
  const serialized = stableSerialize({ header: trace.header, frames: trace.frames })
  // Two-segment digest over disjoint folds to widen the effective space without
  // pulling in a crypto dependency.
  const a = fnv1a32Hex(serialized)
  const b = fnv1a32Hex(`${serialized}|${serialized.length}`)
  return `${a}${b}`
}

/**
 * Structural / duck-typed config hash. Recursively visits all values; a
 * `typeof === 'function'` value folds its `Function.prototype.toString()` body;
 * objects are key-sorted; this is config-shape-agnostic (no forward dependency
 * on any ScenarioSpec type). NEVER calls JSON.stringify / toJSON / toSecureJSON
 * (those bake `createdAt: Date.now()` — security.ts:430/462/468), so two configs
 * whose function bodies are textually identical hash EQUAL.
 */
function structuralWalk(value: unknown, seen: WeakSet<object>): string {
  if (value === null) {
    return 'null'
  }
  const t = typeof value
  if (t === 'function') {
    return `__fn__(${(value as () => unknown).toString()})`
  }
  if (t === 'bigint') {
    return `__bigint__(${(value as bigint).toString()})`
  }
  if (t === 'number' || t === 'boolean' || t === 'string' || t === 'undefined' || t === 'symbol') {
    return `${t}:${String(value)}`
  }
  // object or array
  const obj = value as object
  if (seen.has(obj)) {
    return '__cycle__'
  }
  seen.add(obj)
  if (Array.isArray(value)) {
    return `[${value.map((v) => structuralWalk(v, seen)).join(',')}]`
  }
  const rec = value as Record<string, unknown>
  const keys = Object.keys(rec).sort()
  const parts = keys.map((k) => `${k}=${structuralWalk(rec[k], seen)}`)
  return `{${parts.join(',')}}`
}

/**
 * Compute a structural hash of an arbitrary config value. See
 * {@link structuralWalk} for the FROZEN behavior (function bodies folded; no
 * JSON.stringify/toJSON/toSecureJSON).
 */
export function configHash(config: unknown): string {
  const walked = structuralWalk(config, new WeakSet<object>())
  const a = fnv1a32Hex(walked)
  const b = fnv1a32Hex(`${walked}|len:${walked.length}`)
  return `${a}${b}`
}
