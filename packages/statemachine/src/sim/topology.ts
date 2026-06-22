/**
 * @module sim/topology
 * @unstable
 *
 * ADR-1/3/5 Step-4 topology generator. `genConfig(prng, bounds)` grows a
 * depth-bounded machine CORRECT-BY-CONSTRUCTION: every `from`/`to` path is
 * produced by the SAME walk the validator performs, so `validateConfig(cfg)`
 * yields `isValid:true` (errors empty) and ONLY whitelisted warnings
 * (`SELF_TRANSITION`, optionally `TOO_MANY_STATES`/`TOO_MANY_EVENTS`). There is
 * NO discard-retry: an `isValid:false` is a GENERATOR BUG (assert+throw at the
 * `define.ts` boundary).
 *
 * Validator contract (config_validator.ts, re-verified):
 *  - `MAX_DEPTH_EXCEEDED` is the ONLY count/size ERROR (`:253` addError) — so
 *    `bounds.maxStateDepth<=10` is the clamp that prevents an ERROR.
 *  - `TOO_MANY_STATES`/`TOO_MANY_EVENTS` are WARNINGS (`:884`/`:892`); the
 *    state/event clamps only suppress warning-noise, never flip `isValid`.
 *  - To stay warning-clean we also AVOID: `UNREACHABLE_STATE` (every state is a
 *    transition target or a reachable final leaf), `UNUSED_EVENT` (every event
 *    has a valid from/to), `MIXED_PRIORITIES` (priorities are all-or-none per
 *    event), `COMPLEX_TRANSITIONS` (transitions <= 3*stateCount),
 *    `REGION_MISSING_INITIAL` (every composite pins `initial`),
 *    `DONE_VS_PARALLEL_EXIT_AMBIGUITY` (a composite with a done.state join is
 *    never ALSO a bare user-event `from`), `FINAL_STATE_HAS_OUTGOING` (a final
 *    leaf is never a transition source), `INVALID_DISPLAY` (no `display`).
 *
 * CLOSURE-FREE LITERAL GUARDS/ACTIONS/CONDS (R13, security.ts:640): every emitted
 * callback body reads ONLY its single parameter; drawn constants are INLINED as
 * literals (`(o)=>(o.k%7)===3`, never a closure over `m,r`). This survives the
 * restricted-scope re-eval (which shadows eval/Function/setTimeout/… globals).
 *
 * Non-numeric state names (`s0,s1,…`) are REQUIRED: region init reads
 * `Object.keys(region)[0]` insertion-ordered (state_machine.ts:1317-1320) and
 * integer-index keys would reorder; a leading non-digit name keeps insertion
 * order stable.
 */

import type { Prng } from './prng'
import type {
  Bounds,
  EventSpec,
  InvokeSpec,
  LiteralCallback,
  StateSpec,
  TopologySpec,
  TransitionSpec,
} from './scenario'

/** Owner field names the closure-free probes/guards touch. */
const OWNER_LOG = 'log'
const OWNER_K = 'k'

/**
 * Build a closure-free literal callback. `source` must read ONLY its parameter
 * (no free identifiers) so it survives `security.ts:640`. The live `fn` is
 * created by the SAME source text via the SAME restricted-scope contract, so
 * `fn` and a re-eval of `source` are behaviorally identical.
 */
function literal(source: string, fn: (...args: never[]) => unknown): LiteralCallback {
  return { source, fn }
}

/** A pure-append owner-marker probe `(o)=>{o.log.push(N)}` (I-4 family, closure-free). */
function markerProbe(marker: number): LiteralCallback {
  return literal(
    `(o)=>{o.${OWNER_LOG}.push(${marker})}`,
    ((o: { log: number[] }) => {
      o.log.push(marker)
    }) as (...args: never[]) => unknown,
  )
}

/**
 * A closure-free literal ASYNC action `async (o)=>{await Promise.resolve();
 * o.log.push(N)}` — the producing input for the Step-3 `inFlightAsyncCount`
 * settledness path + ISS-030's "opaque async consumer action".
 */
function asyncMarkerProbe(marker: number): LiteralCallback {
  return literal(
    `async (o)=>{await Promise.resolve();o.${OWNER_LOG}.push(${marker})}`,
    (async (o: { log: number[] }) => {
      await Promise.resolve()
      o.log.push(marker)
    }) as (...args: never[]) => unknown,
  )
}

/** A closure-free literal guard `(o)=>(o.k%m)===r` with INLINED constants. */
function modGuard(m: number, r: number): LiteralCallback {
  return literal(
    `(o)=>(o.${OWNER_K}%${m})===${r}`,
    ((o: { k: number }) => o.k % m === r) as (...args: never[]) => unknown,
  )
}

/** A closure-free literal cond that is deterministically FALSE (ADR-5 c12). */
function falseCond(): LiteralCallback {
  return literal('(o)=>false', ((_o: unknown) => false) as (...args: never[]) => unknown)
}

/**
 * The generated machine, returned alongside the live config the driver wires and
 * the owner-seed it constructs the adapter from.
 */
export interface GeneratedTopology {
  readonly topology: TopologySpec
}

/**
 * Grow a depth-bounded, validator-clean machine from `prng`. Deterministic in the
 * prng draw stream. The skeleton is fixed (a flat lane of simple states, ONE
 * composite with >=2 parallel regions reaching `done.state`, history, and invoke
 * timers); the DETAILS — names, which constants, delays, transition wiring — vary
 * by seed so validation is guaranteed clean for every seed.
 */
export function genConfig(prng: Prng, bounds: Bounds): GeneratedTopology {
  // Clamp depth to <=10 (the ONLY ERROR-bearing bound). Our skeleton never
  // exceeds depth 2 (composite -> region -> leaf), but the clamp is the frozen
  // guard and the non-vacuous Bounds test exercises it.
  const maxDepth = Math.min(bounds.maxStateDepth, 10)

  // ── (1) a flat lane of simple states s0..sN, chained by per-edge events ──────
  // Lane length in [3,5]; deterministic from the draw.
  const laneLen = 3 + prng.int(3) // 3..5
  const lane: string[] = []
  for (let i = 0; i < laneLen; i++) {
    lane.push(`s${i}`)
  }

  // The composite lives at the END of the lane so it is a reachable transition
  // target (no UNREACHABLE_STATE). Name it with a non-digit prefix.
  const composite = 'cP'

  const states: Record<string, StateSpec> = {}
  const events: Record<string, EventSpec> = {}

  // history mode for the composite: shallow vs deep, deterministic from the draw.
  const historyMode: 'shallow' | 'deep' = prng.bool() ? 'deep' : 'shallow'

  // ── (2) parallel regions under the composite (>=2 regions, ISS-033 enabling) ─
  // Each region rA/rB has 2 leaves; the SECOND leaf of each is `final`, so the
  // composite reaches done.state.<composite> when both regions are final.
  const regionNames = ['rA', 'rB']
  const regions: Record<string, Record<string, StateSpec>> = {}
  // invoke markers must be UNIQUE across the machine so probes are disambiguable.
  let markerSeq = 1
  // Region-internal transition events (each region's first leaf -> final leaf).
  const regionEdgeEvents: Array<{ event: string; from: string; to: string }> = []

  // SHARED leaf names across regions ('start'/'fin') so a SINGLE composite
  // `initial:'start'` pins EVERY region's starting leaf (the validator warns
  // REGION_MISSING_INITIAL unless `initial` is a key of EACH region —
  // config_validator.ts:834 iterates ALL regions). The full paths still differ
  // per region (`cP.rA.start` vs `cP.rB.start`). Both names are non-digit
  // prefixed so insertion order stays stable.
  const START_LEAF = 'start'
  const FIN_LEAF = 'fin'
  for (let ri = 0; ri < regionNames.length; ri++) {
    const rn = regionNames[ri]!
    // The first leaf arms an invoke timer raising a region-edge event; this is a
    // function-valued invoke action (covered by inFlightAsyncCount). One region
    // uses an ASYNC action (ISS-030 producing input); the other a sync action.
    const delay = 1 + prng.int(Math.max(1, Math.min(bounds.maxArmedDelay, 5)))
    const edgeEvent = `r${rn}Done`
    const useAsync = ri === 0
    const invoke: InvokeSpec[] = [
      {
        delay,
        event: edgeEvent,
        action: useAsync ? asyncMarkerProbe(markerSeq++) : markerProbe(markerSeq++),
      },
    ]
    regions[rn] = {
      [START_LEAF]: {
        onEnter: markerProbe(markerSeq++),
        invoke,
      },
      // the final completion leaf of the region.
      [FIN_LEAF]: { final: true, onEnter: markerProbe(markerSeq++) },
    }
    regionEdgeEvents.push({
      event: edgeEvent,
      from: `${composite}.${rn}.${START_LEAF}`,
      to: `${composite}.${rn}.${FIN_LEAF}`,
    })
  }

  // The composite: pin `initial` to the shared start-leaf name so EVERY region
  // is explicitly seeded (no REGION_MISSING_INITIAL).
  states[composite] = {
    history: historyMode,
    initial: START_LEAF,
    regions,
  }

  // ── (3) wire the flat lane: simple states + an invoke.cond literal-false skip ─
  for (let i = 0; i < lane.length; i++) {
    const name = lane[i]!
    const spec: StateSpec = {}
    const enter = markerProbe(markerSeq++)
    let withEnter: StateSpec = { ...spec, onEnter: enter }
    // The state at index 1 arms an invoke whose cond is literal-FALSE — the
    // driver observes a `cond-skip` (timer armed, cond false, no transition).
    if (i === 1) {
      const skipDelay = 1 + prng.int(Math.max(1, Math.min(bounds.maxArmedDelay, 5)))
      withEnter = {
        ...withEnter,
        invoke: [{ delay: skipDelay, event: 'noFire', cond: falseCond(), action: markerProbe(markerSeq++) }],
      }
    }
    states[name] = withEnter
  }

  // ── (4) lane edge events (sX -> sX+1), last simple state -> composite ────────
  // Each edge event carries a closure-free literal guard on SOME edges so guard
  // pass/block both occur; mixing priority is per-event all-or-none.
  for (let i = 0; i < lane.length - 1; i++) {
    const from = lane[i]!
    const to = lane[i + 1]!
    const ev = `go${i}`
    const transitions: TransitionSpec[] = [{ from, to, guard: modGuard(2, 0), onTransition: markerProbe(markerSeq++) }]
    events[ev] = { transitions }
  }
  // last simple state -> composite. Two transitions on the SAME event (neither
  // priority-bearing, so no MIXED_PRIORITIES):
  //   (1) from: lastSimple, to: cP            — the LIVE edge the engine takes;
  //       its full `to` is the single state `cP`, so the event is USED (the
  //       UNUSED_EVENT check tests the FULL `t.to` against allStateNames).
  //   (2) from: lastSimple, to: cP.rA.rA0|cP.rB.rB0 — a reachability-only edge:
  //       `reachableStates` SPLITS `to` on '|' (config_validator.ts:600-601), so
  //       this marks the region START leaves reachable (they are entered by
  //       expansion, never a bare `to`). The engine never takes (2) because (1)
  //       is eligible first and enters the same parallel configuration.
  const lastSimple = lane[lane.length - 1]!
  const parallelStart = regionNames.map((rn) => `${composite}.${rn}.${START_LEAF}`).join('|')
  events['enterP'] = {
    transitions: [
      { from: lastSimple, to: composite },
      { from: lastSimple, to: parallelStart },
    ],
  }

  // ── (5) region-internal edges (driven by invoke timers) ──────────────────────
  for (const e of regionEdgeEvents) {
    events[e.event] = { transitions: [{ from: e.from, to: e.to }] }
  }

  // ── (6) the done.state.<composite> JOIN: when both regions are final, the
  //        engine raises done.state.cP; route it BACK to the lane head (a single,
  //        reachable simple state) so the join event is USED (full `to` is in
  //        allStateNames) and the composite is NOT a dead-end. The composite `cP`
  //        is NEVER a bare user-event `from` (avoids DONE_VS_PARALLEL_EXIT_AMBIGUITY;
  //        the engine-generated done.state.<C> event is exempt from that check).
  events[`done.state.${composite}`] = { transitions: [{ from: composite, to: lane[0]! }] }

  // ── (6b) the `noFire` invoke event (cond is literal-false so it never raises);
  //        still declare a REAL transition so the event is not UNUSED and a stray
  //        raise would resolve rather than throw `invalid-event`. Scope it to the
  //        cond-bearing state (lane[1]) -> itself's successor.
  if (lane.length >= 3) {
    events['noFire'] = { transitions: [{ from: lane[1]!, to: lane[2]! }] }
  }

  // ── (7) a guard-BLOCK edge: an event whose only transition has a literal cond
  //        guard that can be false, plus a wildcard event for coverage. The
  //        wildcard's transition stays scoped to a real from/to so it is not an
  //        UNUSED_EVENT. We add a second transition on `go0` style only with
  //        consistent (all-or-none) priorities to avoid MIXED_PRIORITIES.
  // (Already covered by the guarded lane edges; nothing further needed.)

  const topology: TopologySpec = {
    name: 'SimGen',
    stateAttribute: 'state',
    initialState: lane[0]!,
    states,
    events,
    ownerSeed: { [OWNER_LOG]: [], [OWNER_K]: prng.int(7) },
  }

  // Defensive: our skeleton depth is 2; assert it never exceeds the clamp so a
  // future skeleton change that deepens the tree trips here, not in the engine.
  /* c8 ignore next 3 */
  if (compositeDepth(states) > maxDepth) {
    throw new Error(`genConfig: generated depth exceeds clamp ${maxDepth}`)
  }

  return { topology }
}

/** Max nesting depth of the generated state tree (composite -> region -> leaf). */
function compositeDepth(states: Readonly<Record<string, StateSpec>>, depth = 0): number {
  let max = depth
  for (const s of Object.values(states)) {
    if (s.regions) {
      for (const region of Object.values(s.regions)) {
        max = Math.max(max, compositeDepth(region, depth + 1))
      }
    }
  }
  return max
}

