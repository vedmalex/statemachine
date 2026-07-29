/**
 * W8/V2 — consumer-side LIFECYCLE TRACER: a debugging instrument built on the
 * `IMonitor.recordLifecycle` observability channel.
 *
 * The engine emits a raw {@link LifecycleEvent} stream (see `types.ts`) that is
 * deliberately time-free and un-aggregated. That stream answers the hard
 * questions — "in which order did the regions enter?", "which callback is
 * hung?", "which guard never returned true?" — but only after a consumer has
 * written the pairing, grouping and rendering code themselves. This module IS
 * that code, so a consumer debugging a machine writes three lines instead of a
 * hundred.
 *
 * The tracer is a PURE SUBSCRIBER: it never calls back into the machine, never
 * mutates a record, and never throws out of a sink method. (The engine wraps
 * every dispatch in its own sink guard, but a tracer that relies on that guard
 * would silently lose records — so this one simply does not throw.)
 *
 * @see docs/lifecycle-tracing.md for recipes and the channel's blind spots.
 */

import type { IMonitor, LifecycleEvent } from './types'

/** Default retention of {@link LifecycleTracerOptions.limit}. */
const DEFAULT_LIMIT = 10_000

/** Owner substituted when a record arrives without a usable `owner`. */
const UNKNOWN_OWNER: object = Object.freeze({ unknownOwner: true })

/**
 * Spaces of `format()` indentation per level of state nesting. Kept at ONE
 * because the dotted state path already stair-steps on its own — a second full
 * indent unit on top of that pushes the hook column far to the right without
 * adding information.
 */
const INDENT_PER_LEVEL = 1

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One retained lifecycle record: the engine's {@link LifecycleEvent} plus the
 * SUBSCRIBER's timestamp.
 *
 * The engine record carries no time by design (determinism). `ts` is stamped
 * here by {@link LifecycleTracerOptions.now}, so a simulation plane can inject
 * a virtual clock and get a byte-identical rendering.
 */
export interface LifecycleRecord extends LifecycleEvent {
  /** Subscriber-stamped time, in whatever unit `options.now` returns. */
  readonly ts: number
}

/** Construction options for {@link createLifecycleTracer}. */
export interface LifecycleTracerOptions {
  /**
   * Clock used to stamp {@link LifecycleRecord.ts}. Default `Date.now`.
   * Inject a virtual clock (the same one passed as `StateMachineOptions.clock`)
   * for deterministic tests and simulation.
   */
  now?: () => number
  /**
   * Maximum number of retained records — a RING buffer, so a long-lived process
   * cannot leak. When full, the OLDEST record is dropped and the drop is counted
   * in {@link LifecycleTracerStats.dropped} (and surfaced by `format()`).
   *
   * Default `10_000`. Pass `Number.POSITIVE_INFINITY` for unbounded retention.
   * A non-integer / non-positive value falls back to the default rather than
   * throwing — a debugging aid must not be the thing that breaks the build.
   */
  limit?: number
}

/** Retention and intake counters — see {@link LifecycleTracer.stats}. */
export interface LifecycleTracerStats {
  /** Records currently retained (`getTrace().length`). */
  readonly recorded: number
  /** Records accepted since construction / last `reset()`, including dropped. */
  readonly seen: number
  /** Records evicted by the ring buffer. */
  readonly dropped: number
  /** Payloads rejected as unusable (not an object). */
  readonly malformed: number
  /** Effective retention limit (possibly `Infinity`). */
  readonly limit: number
}

/**
 * Per-transition guard coverage — the data behind "which guard never returned
 * true?", the single most common silent state-machine bug.
 */
export interface GuardCoverage {
  /**
   * The `"<from> -> <to>"` transition label. Two transitions leaving the same
   * source are indistinguishable by state alone, which is why the label — not
   * the state — is the key. Falls back to the state path when the engine
   * omitted the label.
   */
  readonly transition: string
  /** Source state of the transition. */
  readonly state: string
  /** Number of SETTLED guard evaluations (a hung guard is in `unfinished()`). */
  readonly evaluations: number
  /** The guard admitted the transition at least once. */
  readonly sawTrue: boolean
  /** The guard rejected the transition at least once. */
  readonly sawFalse: boolean
  /** How many evaluations THREW (reported by the engine as `outcome:false`). */
  readonly threw: number
}

/** Rendering options for {@link LifecycleTracer.format}. */
export interface LifecycleFormatOptions {
  /**
   * Render only this owner's records. Accepts the owner object itself OR an
   * adapter wrapping it (`MemoryAdapter`), because `event.owner` is the
   * ADAPTEE and passing the adapter is the obvious mistake.
   */
  owner?: object
  /** Render only these microstep ids. */
  microstep?: number | readonly number[]
  /** Show `NNms` durations for settled hooks. Default `true`. */
  timings?: boolean
  /** Append the trailing summary line. Default `true`. */
  summary?: boolean
}

/**
 * A lifecycle tracer. IS an {@link IMonitor} (pass it straight to
 * `StateMachineOptions.monitor`) and can also DECORATE an existing monitor via
 * {@link LifecycleTracer.wrap}.
 */
export interface LifecycleTracer extends IMonitor {
  /**
   * The lifecycle sink the engine calls — REQUIRED here (it is optional on
   * `IMonitor`), because its presence is what switches the channel on.
   * Never throws. `recordTransition` / `recordError` are inherited as
   * documented NO-OPS: a throwing callback already surfaces as `failed:true`
   * on its lifecycle `end` edge, so mirroring the error channel here would
   * double-count. Use {@link LifecycleTracer.wrap} to keep a real metrics
   * monitor alongside the trace.
   */
  recordLifecycle(event: LifecycleEvent): void

  /**
   * Decorate an EXISTING monitor: the returned monitor forwards every call to
   * `inner` (including `inner.recordLifecycle`, when it has one) AND feeds this
   * tracer. Use this when the consumer already has a metrics monitor and does
   * not want to choose between metrics and tracing.
   *
   * `recordEvent` / `getMetrics` are forwarded only when `inner` defines them,
   * so feature-detection on the wrapper keeps working.
   */
  wrap(inner: IMonitor): IMonitor

  /** Retained records, OLDEST first. A copy — safe to sort/splice. */
  getTrace(): LifecycleRecord[]

  /** Human-readable rendering of the trace. The primary debugging surface. */
  format(opts?: LifecycleFormatOptions): string

  /**
   * Hooks that STARTED and never settled — the direct answer to "who is hung?".
   * Returns the unmatched `begin` records.
   */
  unfinished(): LifecycleRecord[]

  /** Hooks that THREW — the `edge:'end'` records carrying `failed:true`. */
  failures(): LifecycleRecord[]

  /** Per-transition guard coverage, in first-seen order. */
  guardOutcomes(): GuardCoverage[]

  /**
   * Records belonging to one owner. Accepts the owner object OR an adapter
   * wrapping it (see {@link LifecycleFormatOptions.owner}).
   */
  byOwner(owner: object): LifecycleRecord[]

  /** Records of one microstep. */
  byMicrostep(microstep: number): LifecycleRecord[]

  /** Distinct microstep ids present in the trace, ascending. */
  microsteps(): number[]

  /** Distinct owner objects present in the trace, in first-seen order. */
  owners(): object[]

  /** Retention / intake counters. */
  stats(): LifecycleTracerStats

  /** Drop every record AND reset all counters. */
  reset(): void
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal row model (one row per HOOK INVOCATION, not per edge)
// ─────────────────────────────────────────────────────────────────────────────

type RowStatus = 'ok' | 'failed' | 'unfinished' | 'orphan'

interface Row {
  begin?: LifecycleRecord
  kind: string
  hook: string
  state: string
  transition: string | undefined
  owner: object
  microstep: number
  event: string | undefined
  startTs: number
  status: RowStatus
  outcome: boolean | undefined
  durationMs: number | undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function resolveLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT
  if (raw === Number.POSITIVE_INFINITY) return raw
  if (!Number.isInteger(raw) || raw < 1) return DEFAULT_LIMIT
  return raw
}

/** Coerce anything to a display string without ever throwing. */
function asText(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return fallback
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Owner matching that tolerates the obvious mistake: `event.owner` is the
 * ADAPTEE, so a consumer holding a `MemoryAdapter` would otherwise get an empty
 * result with no hint why.
 */
function matchesOwner(recordOwner: object, query: object): boolean {
  if (recordOwner === query) return true
  const adaptee = (query as { adaptee?: unknown }).adaptee
  return typeof adaptee === 'object' && adaptee !== null && recordOwner === adaptee
}

/** Pairing key: identifies ONE hook invocation across its two edges. */
function pairKey(record: LifecycleRecord, ownerIdx: number): string {
  return `${ownerIdx} ${record.kind} ${record.hook} ${record.state} ${record.microstep} ${record.transition ?? ''}`
}

/**
 * Collapse a `begin`/`end` stream into one row per hook invocation.
 *
 * LIFO matching (a stack per key) is correct because the engine awaits each
 * callback, so a repeated key within one microstep nests rather than overlaps.
 * An `end` with no `begin` (its `begin` was evicted by the ring buffer) becomes
 * an honest `orphan` row rather than being silently dropped.
 */
function pairUp(records: readonly LifecycleRecord[], ownerIndex: Map<object, number>): Row[] {
  const rows: Row[] = []
  const open = new Map<string, Row[]>()

  for (const record of records) {
    const ownerIdx = ownerIndex.get(record.owner) ?? 0
    const key = pairKey(record, ownerIdx)

    if (record.edge === 'end') {
      const stack = open.get(key)
      const row = stack?.pop()
      if (row) {
        row.status = record.failed === true ? 'failed' : 'ok'
        row.outcome = record.outcome
        row.durationMs = record.ts - row.startTs
        continue
      }
      // Orphan end — the matching `begin` is gone (dropped, or reset() between
      // the two edges). Surfacing it is more useful than pretending it is a
      // complete invocation.
      rows.push({
        kind: record.kind,
        hook: record.hook,
        state: record.state,
        transition: record.transition,
        owner: record.owner,
        microstep: record.microstep,
        event: record.event,
        startTs: record.ts,
        status: 'orphan',
        outcome: record.outcome,
        durationMs: undefined,
      })
      continue
    }

    const row: Row = {
      begin: record,
      kind: record.kind,
      hook: record.hook,
      state: record.state,
      transition: record.transition,
      owner: record.owner,
      microstep: record.microstep,
      event: record.event,
      startTs: record.ts,
      status: 'unfinished',
      outcome: undefined,
      durationMs: undefined,
    }
    rows.push(row)
    let stack = open.get(key)
    if (!stack) {
      stack = []
      open.set(key, stack)
    }
    stack.push(row)
  }

  return rows
}

/** Status/outcome annotation for one row. */
function annotate(row: Row, timings: boolean): string {
  const parts: string[] = []

  if (row.kind === 'guard') {
    if (row.status === 'failed') parts.push('✗ threw')
    else if (row.status === 'unfinished') parts.push('⧗ unfinished')
    else if (row.status === 'orphan') parts.push('⚠ end only')
    else if (row.outcome === true) parts.push('✓ true')
    else if (row.outcome === false) parts.push('✗ false')
  } else if (row.status === 'failed') parts.push('✗ failed')
  else if (row.status === 'unfinished') parts.push('⧗ unfinished')
  else if (row.status === 'orphan') parts.push('⚠ end only')

  if (timings && row.durationMs !== undefined && row.durationMs > 0) {
    parts.push(`${row.durationMs}ms`)
  }
  return parts.join('  ')
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a lifecycle tracer.
 *
 * @example Quick start
 * ```ts
 * const tracer = createLifecycleTracer()
 * const sm = new StateMachine(config, owner, { monitor: tracer })
 * await sm.fireEvent('go')
 * console.log(tracer.format())
 * ```
 *
 * @example Decorating a monitor you already have
 * ```ts
 * const sm = new StateMachine(config, owner, { monitor: tracer.wrap(myMonitor) })
 * ```
 */
export function createLifecycleTracer(options: LifecycleTracerOptions = {}): LifecycleTracer {
  const clock = typeof options.now === 'function' ? options.now : Date.now
  const limit = resolveLimit(options.limit)
  const unbounded = limit === Number.POSITIVE_INFINITY

  let buffer: LifecycleRecord[] = []
  let head = 0
  let dropped = 0
  let seen = 0
  let malformed = 0
  let lastTs = 0

  function stamp(): number {
    try {
      const value = clock()
      if (typeof value === 'number' && Number.isFinite(value)) {
        lastTs = value
        return value
      }
    } catch {
      /* a hostile clock must not break tracing */
    }
    return lastTs
  }

  function push(record: LifecycleRecord): void {
    seen++
    if (unbounded || buffer.length < limit) {
      buffer.push(record)
      return
    }
    buffer[head] = record
    head = head === limit - 1 ? 0 : head + 1
    dropped++
  }

  function trace(): LifecycleRecord[] {
    if (head === 0) return buffer.slice()
    return buffer.slice(head).concat(buffer.slice(0, head))
  }

  /** First-seen owner order — the numbering used by `format()`'s `#N` markers. */
  function ownerIndexOf(records: readonly LifecycleRecord[]): Map<object, number> {
    const index = new Map<object, number>()
    for (const record of records) {
      if (!index.has(record.owner)) index.set(record.owner, index.size + 1)
    }
    return index
  }

  function ingest(event: LifecycleEvent): void {
    try {
      if (event === null || typeof event !== 'object') {
        malformed++
        return
      }
      const owner =
        typeof event.owner === 'object' && event.owner !== null ? event.owner : UNKNOWN_OWNER
      // `kind`/`hook` are documented as EXTENSIBLE — never switch exhaustively,
      // never reject an unknown member. `edge` is the one narrow union; an
      // unrecognised value is treated as a `begin` (it will simply surface as
      // unfinished rather than corrupting the pairing).
      const record: LifecycleRecord = {
        kind: asText(event.kind, 'unknown') as LifecycleEvent['kind'],
        hook: asText(event.hook, 'unknown'),
        state: asText(event.state, '?'),
        owner,
        microstep: asCount(event.microstep),
        seq: asCount(event.seq),
        edge: event.edge === 'end' ? 'end' : 'begin',
        ...(event.event !== undefined ? { event: asText(event.event, '?') } : {}),
        ...(event.failed !== undefined ? { failed: event.failed === true } : {}),
        ...(event.outcome !== undefined ? { outcome: event.outcome === true } : {}),
        ...(event.transition !== undefined ? { transition: asText(event.transition, '?') } : {}),
        ts: stamp(),
      }
      push(record)
    } catch {
      // A tracer that throws would lose records behind the engine's sink guard
      // with no diagnostic at all. Count and carry on.
      malformed++
    }
  }

  function filtered(opts: LifecycleFormatOptions | undefined): LifecycleRecord[] {
    const records = trace()
    if (!opts) return records
    const owner = opts.owner
    const ms = opts.microstep
    const wanted =
      ms === undefined ? undefined : new Set<number>(typeof ms === 'number' ? [ms] : ms)
    return records.filter(
      (r) =>
        (owner === undefined || matchesOwner(r.owner, owner)) &&
        (wanted === undefined || wanted.has(r.microstep)),
    )
  }

  function format(opts: LifecycleFormatOptions = {}): string {
    const timings = opts.timings !== false
    const withSummary = opts.summary !== false
    const records = filtered(opts)

    if (records.length === 0) {
      const empty = '(no lifecycle records)'
      return withSummary && dropped > 0 ? `${empty}\n— 0 records · ${dropped} dropped` : empty
    }

    const ownerIndex = ownerIndexOf(records)
    const rows = pairUp(records, ownerIndex)
    const multiOwner = ownerIndex.size > 1

    // Indent the STATE column by hierarchy depth, relative to the shallowest
    // state present — so a flat machine is not pushed right for no reason.
    const depthOf = (row: Row) => row.state.split('.').length - 1
    let minDepth = Number.POSITIVE_INFINITY
    for (const row of rows) minDepth = Math.min(minDepth, depthOf(row))

    // Three aligned columns: KIND | (indented) STATE | HOOK. The state cell is
    // padded to a common width so the hook column lines up regardless of depth —
    // scanning "which hook" down a trace is the actual reading task.
    // A guard's identity is its TRANSITION, which SPANS the state+hook columns.
    interface Cell {
      indentedState: string | undefined
      span: string | undefined
    }
    const cells = new Map<Row, Cell>()
    let stateWidth = 0
    for (const row of rows) {
      const indent = ' '.repeat(Math.max(0, depthOf(row) - minDepth) * INDENT_PER_LEVEL)
      if (row.kind === 'guard' && row.transition !== undefined) {
        cells.set(row, { indentedState: undefined, span: `${indent}${row.transition}` })
        continue
      }
      const indentedState = `${indent}${row.state}`
      cells.set(row, { indentedState, span: undefined })
      stateWidth = Math.max(stateWidth, indentedState.length)
    }

    const lefts = new Map<Row, string>()
    let leftWidth = 0
    for (const row of rows) {
      const cell = cells.get(row)
      const body =
        cell?.span ?? `${(cell?.indentedState ?? '').padEnd(stateWidth)}  ${row.hook}`
      const left = `${row.kind.padEnd(6)} ${body}`
      lefts.set(row, left)
      leftWidth = Math.max(leftWidth, left.length)
    }

    const lines: string[] = []
    let groupStart = 0
    while (groupStart < rows.length) {
      let groupEnd = groupStart
      const microstep = rows[groupStart]?.microstep ?? 0
      while (groupEnd < rows.length && rows[groupEnd]?.microstep === microstep) groupEnd++
      const group = rows.slice(groupStart, groupEnd)
      groupStart = groupEnd

      const eventName = group.find((r) => r.event !== undefined)?.event
      const groupOwners = new Set(group.map((r) => r.owner))
      const uniformOwner = multiOwner && groupOwners.size === 1

      // `microstep 0` is the reserved id for work outside any microstep
      // (construction, reset, resumeTimers) — say so instead of showing a bare 0.
      const tags: string[] = []
      if (eventName !== undefined) tags.push(`event: '${eventName}'`)
      else if (microstep === 0) tags.push('outside any microstep')
      if (uniformOwner) {
        const first = group[0]
        if (first) tags.push(`owner #${ownerIndex.get(first.owner) ?? 1}`)
      }
      lines.push(`microstep ${microstep}${tags.length > 0 ? `  (${tags.join(', ')})` : ''}`)

      for (const row of group) {
        const marker = multiOwner && !uniformOwner ? `#${ownerIndex.get(row.owner) ?? 1} ` : ''
        const left = lefts.get(row) ?? ''
        const note = annotate(row, timings)
        const body = note === '' ? left : `${left.padEnd(leftWidth)}  ${note}`
        lines.push(`  ${marker}${body}`.trimEnd())
      }
    }

    if (withSummary) {
      const hung = rows.filter((r) => r.status === 'unfinished').length
      const failed = rows.filter((r) => r.status === 'failed').length
      const bits = [`${records.length} records`]
      if (hung > 0) bits.push(`${hung} unfinished`)
      if (failed > 0) bits.push(`${failed} failed`)
      if (ownerIndex.size > 1) bits.push(`${ownerIndex.size} owners`)
      if (dropped > 0) bits.push(`${dropped} dropped (limit ${limit})`)
      if (malformed > 0) bits.push(`${malformed} malformed`)
      lines.push(`— ${bits.join(' · ')}`)
    }

    return lines.join('\n')
  }

  const tracer: LifecycleTracer = {
    // ── IMonitor surface ────────────────────────────────────────────────────
    recordTransition() {
      /* a tracer observes the lifecycle channel only */
    },
    recordError() {
      /* a throwing callback already shows up as `failed:true` on the lifecycle end edge */
    },
    recordLifecycle(event) {
      ingest(event)
    },

    wrap(inner) {
      const wrapper: IMonitor = {
        recordTransition(duration, success, context) {
          inner.recordTransition(duration, success, context)
        },
        recordError(error, context) {
          inner.recordError(error, context)
        },
        // ALWAYS present: this is what enables the channel in the engine, even
        // when `inner` never implemented it.
        recordLifecycle(event) {
          ingest(event)
          try {
            inner.recordLifecycle?.(event)
          } catch {
            /* the decorated monitor's failure must not cost us the record */
          }
        },
      }
      // Forwarded only when the inner monitor has them, so feature-detection on
      // the wrapper keeps reporting the truth about `inner`.
      const innerRecordEvent = inner.recordEvent
      if (typeof innerRecordEvent === 'function') {
        wrapper.recordEvent = (eventName, duration) =>
          innerRecordEvent.call(inner, eventName, duration)
      }
      const innerGetMetrics = inner.getMetrics
      if (typeof innerGetMetrics === 'function') {
        wrapper.getMetrics = () => innerGetMetrics.call(inner)
      }
      return wrapper
    },

    // ── Query surface ───────────────────────────────────────────────────────
    getTrace: trace,
    format,

    unfinished() {
      const records = trace()
      return pairUp(records, ownerIndexOf(records))
        .filter((row): row is Row & { begin: LifecycleRecord } =>
          row.status === 'unfinished' && row.begin !== undefined,
        )
        .map((row) => row.begin)
    },

    failures() {
      return trace().filter((r) => r.edge === 'end' && r.failed === true)
    },

    guardOutcomes() {
      const byTransition = new Map<string, GuardCoverage>()
      for (const record of trace()) {
        if (record.kind !== 'guard' || record.edge !== 'end') continue
        const key = record.transition ?? record.state
        const prev = byTransition.get(key)
        byTransition.set(key, {
          transition: key,
          state: record.state,
          evaluations: (prev?.evaluations ?? 0) + 1,
          sawTrue: (prev?.sawTrue ?? false) || record.outcome === true,
          sawFalse: (prev?.sawFalse ?? false) || record.outcome === false,
          threw: (prev?.threw ?? 0) + (record.failed === true ? 1 : 0),
        })
      }
      return [...byTransition.values()]
    },

    byOwner(owner) {
      return trace().filter((r) => matchesOwner(r.owner, owner))
    },

    byMicrostep(microstep) {
      return trace().filter((r) => r.microstep === microstep)
    },

    microsteps() {
      return [...new Set(trace().map((r) => r.microstep))].sort((a, b) => a - b)
    },

    owners() {
      return [...ownerIndexOf(trace()).keys()]
    },

    stats() {
      return { recorded: buffer.length, seen, dropped, malformed, limit }
    },

    reset() {
      buffer = []
      head = 0
      dropped = 0
      seen = 0
      malformed = 0
    },
  }

  return tracer
}
