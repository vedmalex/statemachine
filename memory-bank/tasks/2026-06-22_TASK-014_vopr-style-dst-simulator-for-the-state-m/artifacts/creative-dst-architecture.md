# TASK-014 — CREATIVE Architecture Decision Record: VOPR-style DST Environment for `@vedmalex/statemachine`

> **Status: PROPOSED — pending CREATIVE-exit `mb3-critic` DA gate.**
> Package `packages/statemachine` (`@vedmalex/statemachine`, `1.0.0-beta.3`). Tier **T4:standard**, profile **creative-first**. Input of record: `.plan/TASK-014-dst-simulation-plan.md`. Continuation of TASK-013 (clock seam) + TASK-012 (composite-region semantics).

## Architecture thesis

The entire DST value proposition (seed → bit-exact replay, sound ddmin shrinking, free determinism-regression detection, a permanent load/debug tool, and a programmatic capability-coverage gate) rests on **one** artifact — a canonical, content-only, hashable trace whose bytes are a pure function of `(seed, scenario, pinned-runtime)` — produced by running the **REAL, byte-for-byte-unchanged engine** wrapped in a thin additive harness that injects determinism through the five existing DI seams (`clock`, `scheduler`, `monitor`, `errorHandler`, `logger`) and never edits a core source line. Determinism is achieved by a uniform **allowlist-exclusion** policy (no wall-clock/timestamp/error-id/heap field is ever a member of the hashed `TraceFrame`) backed by full DI neutralization, with capture sourced from an **adapter-level state-write interception** that observes every configuration change (including the engine paths that bypass `recordTransition`), so the trace is both complete and replayable on a public `./sim` consumer running under real `Date.now()`.

## UR map

| UR | Demand | Primary ADRs |
|---|---|---|
| **UR-002** | Real engine, seed → bit-exact replay, fault injection at event-queue/scheduler/callback, Safety + Liveness, shrinker, long-running CI | ADR-1, ADR-2, ADR-3, ADR-4, ADR-5, ADR-6 |
| **UR-003** | Dual bug-hunter AND permanent load/debug tool; constructible for arbitrary consumer machines | ADR-2, ADR-5, ADR-6, ADR-7 |
| **UR-004** | Cover ALL functionality; MANDATORY programmatic coverage gate (defense-in-depth); declarative/extensible | ADR-1, ADR-2, ADR-6, ADR-8 |
| **UR-005** | BOTH internal harness AND public `./sim`; API stability + bundle budget + ABI zero-diff; stress+perf with CI regression thresholds; full v1 fault set | ADR-1, ADR-3, ADR-5, ADR-7, ADR-8 |

## Cross-cutting resolution (one coherent architecture)

Two cross-decision conflicts surfaced in the adversarial review and are resolved **once** here, binding on every ADR below:

- **CAPTURE SEAM CONFLICT (resolves ADR-1 / ADR-3 / ADR-6 contradictions).** ADR-1, ADR-3, and ADR-6 all originally specified per-transition capture *inside* `SimMonitor.recordTransition` reading `getCurrentState()` for both `from` and `to`. Source verification (`state_machine.ts:2048` `setCurrentState(newState)` runs **before** `:2060` `recordTransition`; and the errorState fallback at `:2017–2021` and `abortOnExitError` paths change/decline config **without** ever reaching `:2060`) proves that mechanism is (a) unable to read `from` and (b) blind to engine config changes that bypass `recordTransition`. **The ratified capture seam is a harness-owned Adapter wrapper that wraps the consumer `Adapter.set(...)` method (the `Adapter` interface has exactly one `set()`, `types.ts:295`), thereby intercepting ALL THREE engine state-write sites — `state_machine.ts:1116` (shallow-history restore), `:1126` (deep-history restore), and `:1204` (`setCurrentStateInternal`)**, capturing `(from, to)` atomically at the exact write, complemented by a settle-boundary `getCurrentState()` diff for non-state-changing outcomes (`resolve-false`, `reject`). NOTE (source-verified, fixes a load-bearing miscitation): `:1116` and `:1126` each `return` BEFORE reaching `:1204`, so they bypass `setCurrentStateInternal` entirely — wrapping `Adapter.set` (NOT "intercepting `:1204`") is what makes the seam complete; an implementer who reads "intercept `:1204`" literally would silently miss the two history-restore writes and under-report `from`/`to` for `history.shallow`/`history.deep` transitions. `SimMonitor` is retained **only** as the leak-neutralizing deterministic `IMonitor` (never the capture point). This is the single capture contract for ALL three ADRs.

- **SETTLEDNESS SEAM CONFLICT (resolves ADR-4 CRIT-1/CRIT-2).** ADR-4's structural-predicate-only quiescence is provably wrong for in-flight async invoke actions and same-instant timer re-arms. The ratified primitive is a **converged macrostep** that interleaves `scheduler.process(clock.now())` with the microtask drain to a joint fixed point, and folds an **in-flight-async counter exposed by the already-injected harness DI** into the quiescence predicate. This needs no core ABI change and is detailed in ADR-4.

---

## ADR-1 — Trace-hash canonicalization & determinism contract (resolves OQ#1)

**Affects:** UR-002, UR-004, UR-005.

### Context
The hash is the load-bearing artifact: shrinker soundness (predicate = "same invariantId + same normalized witness"), the zero-tolerance `traceLen` perf gate, and the AC-1 replay canary are all downstream of the hash being a pure function of `(seed, scenario, runtime)`. OQ#1 forces the central choice because the engine deliberately measures real transition latency with wall-clock `Date.now()`.

Verified forces (re-confirmed against current source, not the plan summary):
- The transition-duration leak is **intentional and load-bearing for telemetry**: `state_machine.ts:2047` `const transitionStartTime = Date.now()`, `:2059` delta, `:2060` `this.monitor.recordTransition(transitionTime, true)`. The verbatim comment at `:2044–2046` states: *"Intentional wall-clock telemetry (NOT this.clock()) … a virtual clock would report meaningless ~0ms durations. Do not virtualize."* TASK-013 ratified this (commit `197ec34`).
- `recordTransition` is the SOLE call site, hardcoded `success=true`, no `TransitionContext` (verified `:2060`). `recordError` is gated behind `errorHandler.isEnabled()` (`:424`). `recordEvent` is never called. → outcome cannot come from `IMonitor`.
- Other wall-clock sources would corrupt a naively serialized hash: default monitor `Date.now()` (`monitoring.ts:97`); `EnhancedStateMachineError.timestamp`/`errorCode` (`error_handling.ts:79/88`); `security.ts` `serializeAction createdAt:Date.now()` baked into the FNV hash (`:430/:462/:468`); logger timestamps. Engine state/selection paths have NO `Math.random`/`performance.now`/other `new Date()` (only `logger.ts:116`).
- Rendered `currentState` = `Array.from(map.values()).join('|')` in **insertion order** (`:1202`); only `isInState` sorts (`:639`). A non-normalized hash is unstable across semantically identical parallel configs and brittle to a future Map-iteration refactor.
- The hash cannot be cross-runtime: quiescence relies on single-V8-isolate microtask FIFO; vitest fakes `'Date'` but NOT `queueMicrotask` (`vitest.config.ts`). A public `./sim` consumer runs real `Date.now()`, so the hash MUST be Date-independent **by construction**.

### Decision (ACCEPTED)
**EXCLUDE** the transition-duration `Date.now()` telemetry — and ALL other wall-clock/timestamp/heap/error-id/serialized-byte fields — from the canonical hash; do **NOT** virtualize. The hash is computed over a content-only `CanonicalTrace` of normalized `TraceFrame`s.

`TraceFrame` is the **CLOSED hashed schema** (`src/sim/trace.ts`):
```ts
interface TraceFrame {
  step: number                 // per-transition discriminator (monotonic)
  t: number                    // LOGICAL virtual time = SimClock.now(); NEVER Date.now()
  cause: 'init'|'external'|'timer'|'internal'   // CLOSED to the 4 ENGINE-CAUSAL kinds only
  synthetic?: 'errorState-fallback'|'corrupt-state'|'post-restore'  // CLOSED harness/recovery-origin discriminator (see ADR-3/ADR-6); orthogonal to `cause`
  event?: string               // 'done.state.<C>' and '*' distinguishable (isEngineDoneEvent :367)
  from: string                 // normalized split('|').sort().join('|')
  to: string                   // normalized split('|').sort().join('|')
  queue: { internal: number; external: number }
  quiescent: boolean
  errorClass?: string          // STABLE class/category enum ONLY (see ADR-3 errorClass enum)
  faultApplied?: string        // FaultKind tag applied at this step, if any
  fireOutcome?: 'resolve-true'|'resolve-false'|'reject'
}
```
`hashTrace(CanonicalTrace)` is a key-sorted stable serialization of `{header, frames}` that is **structurally incapable** of referencing any excluded field (enforced by the type, not by runtime filtering). NEVER hashed: any duration/latency; any timestamp; the timestamped `errorCode` and the full error `message`; any heap/hrtime sample; the raw bytes of `toJSON()`/`toSecureJSON()`.

`CanonicalTrace.header = { seed, configHash, engine, version, runtime, prngVersion }`. The seed→bit-exact-hash contract is scoped to ONE pinned runtime; cross-runtime equivalence is an explicit non-goal.

### Options considered
- **CHOSEN — Exclude duration; hash a content-only `TraceFrame` allowlist.** Provable zero replay-fidelity loss; zero engine change; honors `:2044`; structurally excludes ALL wall-clock leaks for free; deterministic by construction; works under real `Date.now()` for a `./sim` consumer.
- *Rejected* — Virtualize the duration (`this.clock()`): overturns the ratified TASK-013 `:2044` comment; requires an engine edit perturbing `etc/statemachine.api.md` + dist bytes (UR-005 zero-core-diff non-goal); yields meaningless ~0ms durations; fixes only 1 of 5 leak classes.
- *Rejected* — Hash native `toJSON()`/`toSecureJSON()` bytes: `security.ts:430/462/468` bakes `createdAt:Date.now()` into the FNV hash → byte-nondeterministic. Non-starter.
- *Rejected* — Derive outcome from `IMonitor`: `recordTransition` always `success=true`, no context; `recordError` gated; `recordEvent` never called.
- *Rejected* — Per-settle capture: collapses multi-transition RTC drains, losing intermediate configs the shrinker fingerprint needs.
- *Rejected* — Promise cross-runtime hash equivalence: a false portability promise; node/bun/browser microtask ordering can legitimately diverge.

### Consequences
- Seed → bit-exact `traceHash` holds even for a public `./sim` consumer under real `Date.now()`; the AC-1 canary is achievable.
- Shrinker fingerprint predicate is stable (pure function of semantic configuration, not Map order or wall-clock).
- `traceLen` is a free zero-tolerance determinism-regression detector.
- Zero core-engine change → `etc/statemachine.api.md` zero-diff and dist byte-stability preserved; no TASK-013 decision overturned.
- **ACCEPTED COST:** per-transition latency is absent from the hashed plane; it lives only in the non-hashed `PerfReport` at `'ms-coarse'` resolution (invalid under vitest's faked Date — perf latency uses real `hrtime`/`performance.now`, handled by ADR-7/§4.7).
- **OBLIGATION:** a region-part-order regression test MUST pin `'|'`-normalization (see folded hole below) or the "normalized by construction" guarantee is unproven.

### Contracts-on-implementation
1. `TraceFrame` is the CLOSED hashed schema above with TWO closed discriminator unions, kept ORTHOGONAL and reconciled here so ADR-1/ADR-3/ADR-6 agree (resolves the cross-decision contradiction in CREATIVE, NOT deferred to TECH_SPEC): (a) **`cause` stays CLOSED to the four ENGINE-CAUSAL kinds** `'init'|'external'|'timer'|'internal'` — these name what the engine causally did, and NOTHING else may be a member; (b) a SEPARATE CLOSED `synthetic?` discriminator carries the harness/recovery-origin markers `'errorState-fallback'|'corrupt-state'|'post-restore'` (the engine's recovery write at `state_machine.ts:2020`, the 8th `corrupt-state` probe's own `adaptee.set`, and the post-restore routing marker), so `errorState-fallback` is NEVER smuggled into the `cause` union (which would fail `tsc` against the closed union or silently widen it). A state-changing recovery/probe frame therefore carries a normal `cause` value for the engine-causal context PLUS the `synthetic` tag for its origin. No duration/timestamp/heap/hrtime/errorCode/message field may ever be added. Adding any new MEMBER to the closed `cause` union OR the closed `synthetic` union, or any new hashed field, requires a `header.version` bump.
2. `hashTrace` MUST be a key-sorted stable serialization over `{header, frames}` and MUST be structurally incapable of referencing any excluded field.
3. `from`, `to`, every `Violation` witness, and `replay.finalState` MUST be normalized `split('|').sort().join('|')` before hashing/comparison (mirrors `isInState` `:639`, compensates `:1202`).
4. `t` is the LOGICAL virtual time (`SimClock.now()`); no hashed field reads `Date.now()`/`performance.now()`/`process.hrtime`/`Math.random`.
5. **Within a single RTC drain `t` is constant; `step` is the per-transition discriminator. `t` discriminates ACROSS macrosteps/settles.** Both remain hashed; per-transition uniqueness rests on `step` (folded LOW hole).
6. `errorClass` carries only a stable class/category string with `errorCode` and `extendedContext.timestamp` explicitly stripped; NEVER an `error.toJSON()` dump (CODE_REVIEW grep-audit line item).
7. The `:2047/:2059` `Date.now()` is NOT virtualized and NOT hashed; read only by the non-hashed perf plane. No engine source line is modified by this decision.
8. `configHash` MUST be derived from a deterministic structural representation that **folds `Function.prototype.toString()` bodies of all guard/action/cond/hook callbacks** (mirroring `security.ts:457`) and MUST NOT use `JSON.stringify` (drops functions) nor `toJSON()`/`toSecureJSON()` (embeds `createdAt`). Function-body stability is scoped to `header.runtime` (folded MED hole).
9. The region-order regression test MUST construct a machine with **≥2 parallel regions** and assert that two runs whose region-key insertion order differs (two configs differing only in region declaration order, or a fault that reorders region init) produce the SAME normalized `traceHash` (folded MED hole — vacuous-test fix).
10. Capture is per-transition (ADR-3 capture seam), never per-settle; **`fireOutcome`-bearing frames for `resolve-false`/`reject` are HARNESS-captured at the `fireEvent` await boundary, not monitor-captured** (folded HIGH hole — see ADR-3).
11. The AC-1 canary (action-throw + snapshot/restore → identical `traceHash` twice) is the executable proof.

### Adversarial findings folded
- **MED — SimMonitor must not stamp `Date.now()` via `MetricsCollector` (`monitoring.ts:97`).** RESOLVED by ADR-3 contract: SimMonitor is a FRESH `IMonitor`, never delegating to `StateMachineMonitor`/`MetricsCollector`, performing no `Date.now()` read. The `:97` stamp is structurally unreachable, not merely "never started".
- **LOW — `t` collapses to a constant within a drain.** RESOLVED: contract #5 documents `step` as the per-transition discriminator; both stay hashed.
- **MED — region-order regression test could be vacuous.** RESOLVED: contract #9 pins a ≥2-region permutable-insertion-order assertion.
- **MED — `configHash` "structural representation" underspecified; `JSON.stringify` silently drops functions.** RESOLVED: contract #8 mandates folding `Function.prototype.toString()` bodies and forbids `JSON.stringify`/`toJSON()`.
- **HIGH — `resolve-false`/`reject` produce no `recordTransition` frame, so the one-frame-per-transition rule cannot observe no-op fires or rejections.** RESOLVED: contract #10 + ADR-3 split capture — state-changing transitions via the Adapter-write seam; non-state-changing outcomes via harness-boundary `fireEvent` frames using `getCurrentState` deltas.
- *Missed-alternative (sanitized snapshot witness)* — noted; the bespoke `TraceFrame` is retained because it captures `cause`/`event`/`queue`/`fireOutcome` a raw config snapshot lacks.
- *Missed-alternative (`getCurrentState` throws on a corrupted adaptee)* — folded into ADR-6: the harness wraps `getCurrentState` in try/catch and treats a throw as the I-10 witness.

---

## ADR-2 — PRNG and seed architecture: splitmix64/bigint, number-facade, label-addressed `fork()` with a FROZEN combine

**Affects:** UR-002, UR-003, UR-004, UR-005.

### Context
Every nondeterministic harness choice (topology, op stream, fault scheduling) must flow from ONE seeded source so "same seed → identical `traceHash`" (I-1). The PRNG is the determinism floor, built and tested first. Verified forces: the engine has NO PRNG and NO bigint anywhere (grep over `src` excluding tests is empty for both), so the sim generator is purely additive. `BigInt` is ES2020, available on node18+ in both esm+cjs (`tsup` target `node18`). A raw bigint cannot be `JSON.stringify`'d, so the serialized seed must be a string. The nightly sweep accumulates a regression corpus; if adding a knob renumbers existing draws for a fixed seed, the whole corpus is invalidated (UR-004 extensibility). `security.ts:382–386` is a 32-bit FNV-1a idiom (offset `0x811c9dc5`, prime `0x01000193`).

### Decision (ACCEPTED)
Adopt a single canonical PRNG: **splitmix64 over a 64-bit bigint state**, exposed through a Number-returning facade, with **label-addressed `fork()` whose combine function and golden vectors are FROZEN in this ADR** (closing the original under-specification).

1. **Core mixer = splitmix64 (Vigna), constants FROZEN:** increment `0x9E3779B97F4A7C15n`, multipliers `0xBF58476D1CE4E5B9n` then `0x94D049BB133111EBn`, output shifts `>>30`, `>>27`, `>>31`, all masked to `MASK64=(1n<<64n)-1n`. Golden vector (seed=0): `[0xe220a8397b1dcdaf, 0x6e789e6aa1b965f4, 0x06c45d188009454f, 0xf88bb8a8724c81ec, 0x1b39896a51a8749b]`.
2. **Number-returning facade:** `nextU32()=Number(v>>32n)>>>0`; `nextFloat()=Number(v>>11n)/2**53`; `int(maxExclusive)`, `pick`, `weighted`, `bool`. Only `seed:bigint` and `state():bigint` expose bigint.
3. **64-bit label salt + FROZEN combine (folds HIGH hole #2 collision ceiling).** The label hash is a **64-bit FNV-1a** computed in bigint (offset `0xcbf29ce484222325n`, prime `0x100000001b3n`), NOT the 32-bit `security.ts` variant. The fork derivation is FROZEN as: `childSeed = splitmix64_mix( (parent.state() ^ rotl64(fnv64(label), 17n)) & MASK64 )`, where `splitmix64_mix` is the single-word z-mixing of splitmix64. `fork()` MUST NOT advance the parent's draw position. Per-step forks are addressed `(parent.state(), fnv64(label), ordinal i)` so `step:i` sub-streams cannot collide even at long-running scale.
4. **Seed input domain:** canonical 64-bit unsigned bigint; wire form is a string (decimal or `0x`-hex). `makePrng(seed: bigint|string)` is canonical. A `number` seed is a **validated convenience for `[0, 2^53)` only**: `makePrng` throws a typed `SimError` on `NaN`/`Infinity`/non-integer/`|seed|>=2^53`/negative, directing the caller to the bigint/string form (folds MED hole #3). All 64 bits including 0 are valid via bigint/hex.
5. **`state()` is FROZEN as the post-increment 64-bit counter** and round-trips losslessly through snapshot/restore: `makePrng(snapshot)` reconstructs a generator whose subsequent `next()` and `fork(label)` are byte-identical (folds MED hole #4). A golden test pins draw-k → `state()` → `fork('x')` equivalence and a mid-fork snapshot/restore reproduction.
6. **`int()` unbiasing is FROZEN as 64-bit Lemire reduction** (exactly ONE `next()` draw per `int()` call → draw-count-stable, corpus-safe). `int(n)` throws for `n<=0`; `pick`/`weighted` throw on empty/zero-total inputs (folds LOW hole #5). The unbiasing method is corpus-frozen like the mixer constants.
7. **OQ#6 resolution:** the Number-based xorshift fast-path is DEFERRED out of v1. splitmix64/bigint is the sole generator for both planes; if a fast-path is later added it is a SEPARATE generator selected by `header.prngVersion`, never silently substituted into the deterministic plane.

### Options considered
- **CHOSEN — splitmix64/bigint + number facade + 64-bit-salt FROZEN-combine label fork.** Bit-exact; published golden vectors; corpus-stable under knob growth; seeds well from 0; ES2020-safe; string seed round-trips through JSON.
- *Rejected* — `Math.random` (unseedable, no replay/fork).
- *Rejected* — single global call-counter PRNG (any draw add/remove renumbers the entire corpus).
- *Rejected* — Number xorshift128+ as sole generator (float-facade drift risk; still needs a 64-bit mixer for fork; weaker published golden reference).
- *Rejected* — crypto CSPRNG (`crypto.subtle.digest` is async → injects awaits into the draw path, interleaving with the engine microtask drain).
- *Rejected* — xorshift fast-path present in v1 (premature; second determinism-sensitive path before measurement).

### Consequences
- `src/sim/prng.ts` owns the canonical generator; sim-only, never imported by core (preserves `'.'` bundle/ABI byte-stability).
- The driver owns exactly ONE root `Prng` per run, forked by domain label (`'topology'`, `'ops'`, `'faults'`, `'step:'+i`). A CODE_REVIEW grep-audit confirms no `Math.random`/`Date.now`/`performance.now` reaches any draw path.
- splitmix constants, the 64-bit FNV constants, the rotl/combine, the Lemire `int`, and the `state()` semantics are FROZEN; any change is a corpus-breaking event requiring a `header.prngVersion` bump and corpus regeneration.
- `prng.test.ts` ships first with golden vectors for the raw 64-bit sequence, the `nextU32`/`nextFloat` facade, fork independence + reproducibility, snapshot/restore-fork equivalence, and a corpus-stability regression (fork('a'),fork('b') byte-stable after a hypothetical fork('c') is added).
- bigint draw cost (~5–10× Number) accepted in v1; OQ#6 deferred.

### Contracts-on-implementation
1. `Prng` interface: `{ readonly seed: bigint; nextU32():number; nextFloat():number; int(maxExclusive:number):number; pick<T>(xs:readonly T[]):T; weighted<T>(xs:readonly (readonly [T,number])[]):T; bool(p?:number):boolean; fork(label:string):Prng; state():bigint }`.
2. `makePrng(seed: bigint|string)` canonical; `number` seeds validated to `[0,2^53)` integers else typed throw.
3. Mixer + 64-bit FNV + rotl-combine + Lemire-`int` + post-increment-`state()` are FROZEN with golden vectors; the fork golden vector MUST pin `fork(seed=0,'topology').state()` + first 3 draws and `fork(seed=0,'ops')` first draw.
4. `fork(label)` MUST NOT advance the parent or any sibling; identical `(parentState,label,ordinal)` → identical child; different labels/ordinals → independent streams.
5. Domain forks are fixed labels owned by the driver; new dimensions add NEW labels and MUST NOT renumber existing draws; a corpus-stability regression test guards this.
6. The PRNG output feeds only harness decisions, never a hashed trace field directly; `prng.ts` is sim-only.

### Adversarial findings folded
- **HIGH #1 — fork combine under-specified (2-arg `mix64` undefined; no golden vector).** RESOLVED in-ADR: the exact `rotl64`+xor+`splitmix64_mix` combine is FROZEN with a pinned fork golden vector (decision item 3, contract 3).
- **HIGH #2 — 32-bit FNV salt collision ceiling (~0.69 at 1e5 step-labels), correlating sub-streams.** RESOLVED: 64-bit FNV-1a (bigint) PLUS per-fork ordinal addressing (decision item 3). The 32-bit `security.ts` reuse is explicitly dropped as the salt source.
- **MED #3 — `makePrng(number)` lossy/unsafe at edges.** RESOLVED: number path validated to `[0,2^53)` integers; typed throw on `NaN`/`Infinity`/non-integer/over-range/negative; full 64-bit only via bigint/hex (decision item 4).
- **MED #4 — `state()` snapshot/restore-fork determinism unproven.** RESOLVED: `state()` FROZEN as post-increment counter with a golden round-trip + mid-fork snapshot test (decision item 5).
- **LOW #5 — degenerate `int(0)`/`pick([])` + deferred unbiasing renumbers the corpus.** RESOLVED: Lemire `int` (one draw/call) FROZEN now; typed throws on degenerate inputs (decision item 6) — the OQ is closed, not deferred.
- *Missed-alternatives (PCG stream parameter, splitmix `split()`, 64-bit FNV)* — the 64-bit-FNV + FROZEN-combine adoption captures the substantive fix (eliminating the collision ceiling) while keeping the published splitmix64 golden reference; PCG/`split()` are noted as future options behind a `prngVersion` bump.

---

## ADR-3 — Leak-neutralization policy: inject deterministic DI (SimMonitor / SimErrorHandler / NoopLogger); trace content only; capture via Adapter-write interception

**Affects:** UR-002, UR-003, UR-004, UR-005.

### Context
The harness runs the unchanged engine and requires bit-exact replay. TASK-013 gave the clock seam and virtual scheduler (neutralizing time-flow and timers) but NOT the wall-clock/randomness the engine's other injectable dependencies stamp onto observable surfaces. Verified leak inventory (file:line): default monitor `Date.now()` (`monitoring.ts:77/97`, armed via `createDefaultMonitor` at `state_machine.ts:153`); `EnhancedStateMachineError.timestamp`/`errorCode` (`error_handling.ts:79/88`) re-emitted by `toJSON()` (`:92–103`); `RetryRecoveryStrategy.recover()` real `setTimeout` (`error_handling.ts:154`, registered by default at `:347`); `security.ts serializeAction createdAt:Date.now()` folded into the FNV hash (`:430/:462/:468`); `ConsoleLogger` timestamps (`logger.ts`). The engine touches `errorHandler` at exactly two sites — construction and the `isEnabled()` gate (`:424`); it NEVER calls `handleError`/`recover`. vitest fakes `'Date'` but NOT `queueMicrotask`; the DST suites already run real `Date` (no `vi.useFakeTimers()` in `dst.test.ts`/`concurrency.test.ts`/`event_queue.test.ts`), so the policy is *validated*, not masked.

### Decision (ACCEPTED)
A closed leak-neutralization policy enforced at the DI boundary, with the canonical trace carrying CONTENT only, and **capture via Adapter-write interception** (the ratified cross-cutting seam).

**(A) Mandatory injection.** Every simulated machine is constructed with ALL FIVE deterministic DI slots wired together: `{ clock: simClock.now, scheduler: virtualScheduler, monitor: SimMonitor, errorHandler: SimErrorHandler, logger: NoopLogger }`. Omission of any slot is a wiring bug (ADR-7 makes them required-by-contract; scheduler omission is the worst — the type system cannot catch the silent real-time `createDefaultScheduler()` at `:155`).

**(B) SimMonitor (FRESH deterministic `IMonitor`; NEVER `createDefaultMonitor`; NEVER `.start()`; NEVER delegates to `StateMachineMonitor`/`MetricsCollector`).** It implements `recordTransition`/`recordError` as no-op deterministic counters that read NO `Date.now()`. The engine-supplied duration arg is recorded ONLY on the non-hashed perf channel. It is **not** the trace capture point.

**(C) Capture seam = harness-owned Adapter wrapper (the ratified mechanism).** The harness wraps the consumer adapter's single `Adapter.set(...)` method (the `Adapter` interface declares exactly one `set()`, `types.ts:295`) so that EVERY `adaptee.set(stateAttribute, newValue)` write is intercepted, capturing `(oldValue → newValue)` atomically as the `(from, to)` of a state-changing `TraceFrame` (`cause`/`event`/`faultApplied`/`synthetic` supplied by the harness's current macrostep context). Wrapping the method — NOT "intercepting `:1204`" — is load-bearing: the engine has **THREE** distinct state-write sites and `:1204` (`setCurrentStateInternal`) is only one of them. The other two are the **history-restore writes** `:1116` (shallow-history) and `:1126` (deep-history), each of which `return`s BEFORE reaching `:1204` and so bypasses `setCurrentStateInternal` entirely (source-verified). Wrapping `Adapter.set` therefore captures **every** config change, including the engine paths that bypass `recordTransition`: the **errorState fallback** (`:2020` `setCurrentState(errorNewState); return` — verified to skip `:2060`), the **history-restore** writes (`:1116`/`:1126` — required-to-cover `history.shallow`/`history.deep` capabilities, §6, that would otherwise be structurally unobservable), and any future bypass. Non-state-changing outcomes (`resolve-false`, `reject`) are captured as harness-side frames at the `fireEvent` await boundary via `getCurrentState()` deltas. Intermediate mid-drain configs are preserved (per-transition, never per-settle).

**(D) SimErrorHandler (wall-clock-free; retry recovery DISABLED; `isEnabled()===true`).** Implements the full six-method `IErrorHandler` contract (`types.ts:107–114`); registers NO `RetryRecoveryStrategy` (the real `setTimeout` at `:154` is unreachable). `isEnabled()` returns **true** (pinned, recorded in the trace header as a determinism parameter) so the engine's real `recordError` gate (`:424`) is exercised, matching UR-002's "real error paths"; but `monitor.recordError` is the no-op deterministic SimMonitor method, so nothing leaks. `getAnalytics()` returns a frozen deterministic stand-in that the harness MUST NOT trace/hash. (The retry-disable is defense-in-depth, not a correctness invariant — the engine never drives `handleError`; documented for the `./sim` consumer who might.)

**(E) NoopLogger (`ILogger` with empty side-effect-free methods).** Logs are never traced.

**(F) Trace-content policy (defense-in-depth, independent of A–E).** `hashTrace` OMITS every duration/timestamp/heap/errorCode/message field. Errors record only a stable `errorClass` enum (ADR-3 enum below), derived by explicit field selection — never `error.toJSON()`. Injected faults throw a PLAIN `InjectedFault extends Error` (never `StateMachineError`/`EnhancedStateMachineError`). Snapshot/restore ops contribute only the reconstructed `'|'`-normalized `currentState` + `stateEntryTimes`; `toJSON()`/`toSecureJSON()` bytes are NEVER hashed. The shrinker cache key serializes guard/action via `Function.prototype.toString()`, excluding `createdAt`.

**(G) `errorClass` enum (FROZEN in TECH_SPEC, computed once at the harness boundary from verified messages):** `'queue-overflow'` (`:234`), `'max-transition-depth'` (`:303`), `'transition-timeout'` (`:1790`, a base `StateMachineError`, not Enhanced — no `Date.now()`), `'invalid-event'` (`:383`), `'injected-fault'` (`InjectedFault`). Probes/oracles switch on this enum, never on `message`.

**(H) AC-1 canary (blocking).** A seeded scenario that BOTH throws inside an action AND performs snapshot+restore MUST produce a bit-identical `hashTrace` across **four** runs: two with `vi.useFakeTimers()` active and two without (folds the MED hole — directly proves invariance to the runner's Date fake, the real `./sim`-consumer guarantee). The independent leak-audit and a CODE_REVIEW grep-audit are the second and third lines.

### Options considered
- **CHOSEN — Inject SimMonitor+SimErrorHandler+NoopLogger; content-only trace; capture via Adapter-write interception.** Defense-in-depth; closes all verified leaks at the DI boundary; zero engine change; works under real Date; the Adapter seam captures `from`/`to` atomically and catches the `recordTransition`-bypassing errorState path.
- *Rejected* — Clock+scheduler only, keep default monitor/errorHandler/logger: factually false single-leak premise; fails UR-002.
- *Rejected* — Virtualize engine wall-clock leaks in place: engine edit, overturns `:2044`, ABI churn, zero fidelity gain.
- *Rejected* — Hash `toJSON()`/`toSecureJSON()` bytes for snapshot fidelity: `createdAt:Date.now()` in the FNV hash breaks replay.
- *Rejected* — `isEnabled()===false` + leak-free `recordError`: the original draft chose this, but it makes whether an error frame exists depend on a harness boolean that perturbs `traceLen`; the ratified choice pins `isEnabled()===true` with a no-op SimMonitor.recordError so the real gate is exercised and nothing leaks (folds the MED hole on the unpinned `isEnabled()` value).
- *Rejected* — `SimMonitor` doubling as capture point: caused the from/to single-read contradiction and the errorState blind spot; replaced by the Adapter-write seam (the missed-alternative the original ADR did not weigh, now adopted).

### Consequences
- UR-002 bit-exact replay achievable for both the internal harness and an external `./sim` consumer, independent of vitest's Date fake — the (H) canary is the gating proof.
- New production classes under `src/sim` (`sim-monitor.ts`, `sim-error-handler.ts`, `noop-logger.ts`, the Adapter-wrapper in `harness.ts`) are subject to the knip dead-code gate (`project:['src/**/*.ts']`, ignores `src/tests` NOT `src/sim`) and biome unused-symbol errors; they must be reachable from the `./sim` entry.
- Error observability shifts to the harness boundary: every `fireEvent` is awaited with `.catch` and classified `resolve-true`/`resolve-false`/`reject`; overflow/invalid-event/timeout arrive as rejections distinguished by the `errorClass` enum.
- The errorState config change is captured by the Adapter seam (resolves the HIGH hole) and, because the engine recovers and `fireEvent` resolves, is emitted as a frame tagged `synthetic:'errorState-fallback'` (NOT a `cause` value — `cause` stays closed to the four engine-causal kinds per ADR-1 contract #1; the frame keeps its engine-causal `cause` and adds the `synthetic` origin tag); the harness MUST diff `getCurrentState` at every settle to catch errorState/abortOnExitError deltas that bypass `:2060`.
- Hard coupling to ADR-7: the documented `setup(env)` wiring MUST forward all five seams together.
- The intentional `:2047` `Date.now()` and the `security createdAt` hash remain in the engine unchanged — `etc/statemachine.api.md` zero diff.

### Contracts-on-implementation
1. A simulated `StateMachine` MUST be constructed with all five options present; omitting any (esp. `scheduler`) is a contract violation (ADR-7 runtime probe).
2. SimMonitor MUST be a FRESH `IMonitor`, MUST NOT call `Date.now()`/`performance.now()`, MUST NOT be `createDefaultMonitor()`, MUST NOT have `.start()` invoked, and MUST NOT delegate to `StateMachineMonitor`/`MetricsCollector`.
3. **Capture is via the harness Adapter wrapper wrapping the consumer `Adapter.set(...)` method (`types.ts:295`, exactly one `set()`), catching ALL THREE engine write sites `:1116`/`:1126`/`:1204` — NOT "intercepting `:1204`"**; `from`=prior value, `to`=new value, captured atomically. Non-state-changing `fireOutcome` frames are harness-boundary-captured. The errorState/abortOnExitError config deltas AND the history-restore writes (`:1116` shallow, `:1126` deep — which `return` before `:1204`) MUST be captured (recordTransition is necessary-but-not-sufficient; the Adapter-method-wrap is the sufficient seam). A regression test MUST assert that a `history.shallow` restore and a `history.deep` restore each produce a captured `(from, to)` frame, protecting the `history.*` coverage capabilities (§6) from being structurally unobservable.
4. SimErrorHandler MUST implement the six-method contract, register NO `RetryRecoveryStrategy`, return `isEnabled()===true` (pinned in header), and `getAnalytics()` MUST return a frozen deterministic stand-in never traced/hashed.
5. NoopLogger MUST implement `ILogger` with empty methods; nothing logged is traced.
6. `hashTrace` MUST exclude every duration/timestamp/heap/errorCode/message; errors recorded as the FROZEN `errorClass` enum only.
7. Injected faults MUST be a plain `InjectedFault extends Error`.
8. Snapshot/restore ops contribute only the reconstructed `'|'`-normalized `currentState` + `stateEntryTimes`; `toJSON()`/`toSecureJSON()` bytes NEVER hashed nor used as a cache key.
9. The AC-1 canary MUST run four ways (fake-timers × {on,off}) and produce one identical `traceHash`.

### Adversarial findings folded
- **HIGH — SimMonitor.recordTransition cannot read `from`.** RESOLVED by the Adapter-write capture seam (contract 3); SimMonitor is demoted to neutralization-only.
- **HIGH — errorState fallback changes config without `recordTransition`, producing a frame-less config delta and a lost `done.state`.** RESOLVED: the Adapter seam captures the `:2020` write; the settle-diff backstop catches it; emitted as a frame tagged `synthetic:'errorState-fallback'` (the closed `synthetic` discriminator of ADR-1, NOT a `cause` member). (Also documented: `abortOnExitError` `:1985–1988` stays in source, returns false, no config change — benign.)
- **MED — vitest Date-fake framing imprecise + weak AC-1 guard.** RESOLVED: context corrected (DST suites run real Date by default); AC-1 strengthened to a four-run fake×{on,off} identity (contract 9).
- **LOW — `getAnalytics()` is a latent `Date.now()` surface.** RESOLVED now (not deferred): frozen deterministic stand-in, never traced (contract 4).
- *Missed-alternative (NoopMonitor + harness-side settle-diffing capture)* — substantively ADOPTED: capture is decoupled from the monitor (Adapter seam + settle diff); SimMonitor exists only to neutralize the default-monitor `Date.now()`.

---

## ADR-4 — Single shared converged-macrostep quiescence primitive; budget exhaustion is a liveness finding

**Affects:** UR-002, UR-003, UR-004, UR-005.

### Context
After every macrostep the harness must wait until the engine fully settles before recording, sampling, or firing the next op. There is no synchronous settledness signal; draining is `queueMicrotask(()=>processQueues())` under an `isProcessing` guard (`:286–290`), and `processQueues` drains the whole internal-before-external queue in one async loop (`:292–340`). Settledness is observable only through `getQueueDepth().total` (`:483–493`), `isProcessingEvents()` (`:509–511`), plus scheduler heap state. The fixed `flush(16)` idiom is an unprincipled guess. `MAX_TRANSITION_DEPTH=100` is dormant under the flat drain (counter ~0 at any settle). Verified hazards: the async invoke callback `await this.callAction(...)` runs BEFORE `raiseEvent`+`scheduleProcessing` (`:2169–2173`), so a structural-predicate-only pump reports premature quiescence while the action is in flight (CRIT-1); a `delay:0` / jitter-to-0 / forward-skew timer re-armed during a drain becomes due at the current `t`, which a single `scheduler.process(t)` per macrostep never re-processes (CRIT-2). Construction is async (`setInitialState` fire-and-forget enter + `checkCompletion` `queueMicrotask`), so frame 0 needs a post-construction drain.

### Decision (ACCEPTED)
ONE shared **converged-macrostep** quiescence primitive, used identically by driver, Safety, Liveness, perf, shrinker, and `runSimulation`. There is NO fixed `flush(N)` anywhere in `src/sim/**`; `flush(16)` and `Op.flush{microtasks}` are forbidden.

`settleMacrostep(sm, scheduler, clock, env, policy)` is the single determinism surface. Its inner converged loop:
```
loop:
  scheduler.process(clock.now())                 // re-process same-instant re-arms (closes CRIT-2)
  while (sm.getQueueDepth().total>0 || sm.isProcessingEvents() || env.inFlightAsyncCount()>0)
        and turns<maxTurns:
    await Promise.resolve(); turns++
until ( queue empty && !isProcessingEvents() && env.inFlightAsyncCount()===0
        && schedulerEmptyAt(clock.now()) )  OR  turns>=maxTurns
```
- **`env.inFlightAsyncCount()` (closes CRIT-1)** is a counter on the already-injected harness DI, incremented when an invoke/transition-timeout async action begins and decremented when it completes. This is a **zero core-ABI / zero `etc/statemachine.api.md` diff** seam: the count is maintained by the harness's wrapped callbacks (it wraps function-valued callbacks anyway for fault injection, ADR-5) and/or a `SimMonitor` hook, never by a new `StateMachine` public method. If a consumer-supplied action is opaque, the count is maintained by the harness wrapper around the consumer's callbacks at wire time (ADR-7).
- **WAITING_ON_TRANSITION_TIMEOUT** is handled: when `isProcessingEvents()===true` (or `inFlightAsyncCount>0`) and the only pending scheduler task is a not-yet-due transition-timeout, the primitive JUMPS the clock to `earliestExecuteAt()` and re-processes so the timeout fires and unwedges the in-flight transition (folds the MED hole).
- **`policy`** parameterizes the single clock-jump location: `Safety` records `WAITING_ON_TIMER` as data and never auto-jumps a future timer; `Liveness` auto-jumps to `earliestExecuteAt()`. This makes the determinism surface genuinely singular and grep-enforceable (folds HIGH hole #3 — the second control path the original "single primitive" claim accidentally contradicted).
- **Budget exhaustion is a FIRST-CLASS LIVENESS FINDING:** on `turns>=maxTurns` return `{quiescent:false, reason:'microtask-budget', turns}` → Liveness `TIMEOUT_BUDGET_EXCEEDED`/`STUCK`; Safety records a non-quiescent settle frame. It is a CODE_REVIEW error to swallow it.
- **Two budgets, separated (folds HIGH hole #4):** (1) settledness no longer relies on counting microtask turns to dominate action-await depth — `inFlightAsyncCount()===0` is the settledness signal, so consumer action-await depth is irrelevant to the settle POINT; (2) a SEPARATE non-termination budget based on monotonic-progress fingerprint (queue+heap+config unchanged across a full converged macrostep) is the livelock verdict, logged distinctly from the last-resort `maxTurns` safety stop. `maxTurns` defaults high (1024) as a last-resort stop only, NOT a model of `MAX_TRANSITION_DEPTH` and NOT 16.
- **Post-construction drain** is the mandatory first action after `new StateMachine(...)`, before the first `clock.set`/`scheduler.process`; frame 0 is recorded only after it.
- **Capture ordering (folds MED hole #6):** per-transition content frames are captured by the **Adapter-write seam (ADR-3) DURING** the converged drain (because `adaptee.set` runs mid-drain); the harness records exactly ONE additional settle-boundary frame (queue depth + error summary + `quiescent`) AFTER the converged drain returns. A test pins per-transition frame count = number of `adaptee.set` writes in a macrostep (no off-by-one vs the settle frame).
- **Determinism premise recorded in the header:** the primitive is deterministic only because V8 microtask ordering is FIFO within one isolate and virtual mode creates no real timers/IO; `header.runtime` pins this. The seed→hash contract holds only when consumer-supplied actions are deterministic and synchronous-or-immediately-resolved; with the `inFlightAsyncCount` settledness signal the settle POINT is await-topology-independent even if the turn COUNT varies (folds MED hole #7).

### Options considered
- **CHOSEN — single shared `settleMacrostep` converged loop (scheduler-reprocess + microtask-drain to joint fixed point), `inFlightAsyncCount` settledness, single policy-parameterized clock-jump, budget=liveness finding, mandatory post-construction drain.** Correct regardless of chain depth, async-invoke in-flight, and same-`t` re-arms; one determinism surface; distinguishes settled/working/non-terminating.
- *Rejected* — Fixed `flush(N)`: unprincipled, truncates deep drains (false determinism failure), cannot power Liveness, the shrinker would minimize the harness artifact.
- *Rejected* — structural-predicate-only pump (the original ADR-4 draft): provably wrong for in-flight async invokes (CRIT-1) and same-`t` re-arms (CRIT-2); empirically returned `{quiescent:true,turns:0}` with the transition unapplied.
- *Rejected* — engine `await sm.untilIdle()` seam: ABI change (UR-005 zero-diff); still needs a cap on top; **but the `untilIdle` rejection's rationale that "a seam gives no determinism gain" was wrong** — a settledness seam IS more correct than the structural predicate; the ratified fix achieves the settledness gain WITHOUT a core ABI change via the harness-owned `inFlightAsyncCount` (folds MED hole #5).
- *Rejected* — synchronous-drain by replacing `queueMicrotask`: impossible without an engine change; monkey-patching global `queueMicrotask` is a process-global side effect that breaks isolation and the `./sim` contract.

### Consequences
- Every harness component calls the same `settleMacrostep`; reviewers grep `src/sim/**` for any second settle/flush definition (CODE_REVIEW gate).
- Liveness gets its non-termination detector for free; composes with the eventually-healthy window and the guard-blocked demotion (ADR-6) so a guard-blocked rest is `QUIESCENT_NO_WORK`, not false `STUCK`.
- The macrostep ordering is fixed and load-bearing: `clock.set(t) → settleMacrostep(... policy) → record per-transition frames (Adapter seam, during) + one settle-boundary frame (after) → invariant checks`.
- The harness wraps consumer callbacks at wire time to maintain `inFlightAsyncCount`; this is the same wrap point ADR-5 uses for fault injection (one seam, two uses).
- `maxTurns` (last-resort) and `healWindow`/non-termination fingerprint budget validated during IMPLEMENT against the deepest legal scenario (parallel regions + `checkCompletion` re-raise + N action-bearing invokes); the generator exposes `maxArmedDelay`/chain-length.
- `MAX_TRANSITION_DEPTH` is NOT a settle bound or runaway oracle (dormant); the observable runaway bound is `maxQueueDepth` overflow (I-9).
- PerfHarness places the converged drain as an explicit async settle barrier after `scheduler.process()` and runs the post-construction drain before the first clock advance.

### Contracts-on-implementation
1. `settleMacrostep(sm, scheduler, clock, env, policy)` is the ONE quiescence primitive; no other settle/flush helper may exist in `src/sim/**`.
2. The quiescence predicate is exactly: `getQueueDepth().total===0 && isProcessingEvents()===false && env.inFlightAsyncCount()===0 && schedulerEmptyAt(clock.now())===true`, reached via the converged loop (scheduler-reprocess + microtask-drain).
3. The pump body is `await Promise.resolve()`; it MUST NOT use `setTimeout`/`setImmediate`/`process.nextTick`/any real timer.
4. Same-instant re-arms (`delay:0`, jitter-to-0, forward-skew collapsing to current `t`) MUST be converged by re-invoking `scheduler.process(clock.now())` inside the loop, NOT treated as non-quiescence.
5. The clock-jump for strictly-future timers lives in EXACTLY ONE place (the `policy`-parameterized branch); every implicit jump is recorded as a trace frame.
6. Budget exhaustion MUST return `quiescent:false, reason:'microtask-budget'` and be surfaced as a liveness finding; swallowing it is a CODE_REVIEW error.
7. The first harness action after construction MUST be `settleMacrostep`; frame 0 is recorded only after it.
8. `maxTurns` MUST NOT be 16 or any `MAX_TRANSITION_DEPTH`-derived value; the livelock verdict uses the SEPARATE monotonic-progress fingerprint budget, not the turn count.
9. `env.inFlightAsyncCount()` is maintained by the harness wrapper (zero core-ABI diff); it is NOT a new `StateMachine` public method.
10. `schedulerEmptyAt(t)` and `earliestExecuteAt()` come from the single `ObservableScheduler` (ADR-6) mirroring `executeAt=clock()+delay` with lazy-cancel semantics; the engine `ITimerScheduler` is not modified.

### Adversarial findings folded
- **CRIT-1 — false quiescence on in-flight async invoke actions.** RESOLVED: `inFlightAsyncCount()` in the predicate (harness-maintained, zero ABI diff). Also fixes the resumeTimers/restore path (`:2503–2506` awaits `callAction` before `fireEvent`).
- **CRIT-2 — same-instant timer re-arm reported as false non-quiescence/STUCK.** RESOLVED: the converged loop re-invokes `scheduler.process(clock.now())` until the same-`t` heap is empty.
- **HIGH #3 — "single determinism surface" contradicted by Liveness's clock-jump.** RESOLVED: one `settleMacrostep` owns BOTH same-`t` re-process and the future-clock-jump, parameterized by `policy`.
- **HIGH #4 — `maxTurns` conflates action-await depth and non-termination.** RESOLVED: two separated budgets (settledness via `inFlightAsyncCount`; livelock via progress fingerprint); `maxTurns` is a last-resort stop only.
- **MED #5 — `untilIdle` rejected on a false determinism rationale.** RESOLVED: the settledness gain is acknowledged and obtained via the harness `inFlightAsyncCount` without a core ABI change.
- **MED #6 — capture ordering mis-described ("drain → record").** RESOLVED: per-transition frames captured DURING the drain (Adapter seam); one settle frame AFTER; frame-count test pins the relation.
- **MED #7 — consumer await-topology can shift the settle point/budget.** RESOLVED: with `inFlightAsyncCount` settledness the settle POINT is await-topology-independent; documented in the header determinism premise.
- *Missed-alternatives (converged fixed-point, monitor settledness hook, stable-fingerprint detector, single `settleMacrostep(policy)`)* — all four ADOPTED into the ratified primitive.

---

## ADR-5 — DST fault taxonomy and v1 boundary across the three adapted seams

**Affects:** UR-002, UR-003, UR-004, UR-005.

### Context
TigerBeetle injects faults at network/disk/process; this single-process engine has none, so faults adapt to three engine seams: event queue, scheduler, callback. Verified forces: `processQueues` drains internal-before-external as an RTC GUARANTEE (`:315/:323`); function-valued guard/action/hook callbacks flow through the single chokepoint `callAction` (`:1726`) while `invoke[].cond` is called DIRECTLY (`:2153/:2497`) and a throw there is caught-continued (never reaching `processError`/`recordError`); `EnhancedStateMachineError` bakes `Date.now()` into `errorCode`/`timestamp` (`:79/88`); the scheduler min-heap has NO insertion tiebreak (orders by `executeAt` only); queue overflow is a Promise REJECTION at enqueue (`:228–240`); `callAction` hardcodes `context.phase='action'` for every call (`:1738`) so engine phase is useless for targeting; `StateMachineOptions` has no `queueInterceptor` and the ABI is frozen.

### Decision (ACCEPTED)
A v1 fault taxonomy `FaultKind = 'reorder'|'drop'|'dup'|'throw'|'clock-skew'|'timer-jitter'|'overflow'` (event-queue: reorder/drop/dup + overflow; scheduler: clock-skew + timer-jitter; callback: throw), attached ENTIRELY to existing injectable seams via a thin `SimHarness` wrapper around the unchanged engine. No additive engine seam in v1.

Per seam:
- **EVENT QUEUE (external only).** A fault-aware submission buffer in front of `fireEvent()` may drop / dup / swap within `reorderWindow`. The INTERNAL queue is NEVER scrambled (internal-before-external RTC is an engine guarantee). Every flushed `fireEvent` is `await`ed with `.catch(captureRejection)`.
- **QUEUE OVERFLOW.** Flood `fireEvent` past `maxQueueDepth` (minimal flood = `maxQueueDepth - currentDepth + 1`); the `(max+1)`-th Promise REJECTION (`errorClass:'queue-overflow'`) is the observed fault, distinguished from the **depth-exceeded** rejection (`errorClass:'max-transition-depth'`, `:303`) by **structured classification, not prose**: the harness `captureRejection` classifies by whether the rejection arrived from THIS flood's `fireEvent` synchronously (overflow-at-enqueue) vs a previously-pending `fireEvent` rejected during drain (depth), and records the FROZEN `errorClass` enum, never the raw English message (folds MED hole #5). The two engine message strings are pinned as test fixtures so a prose change fails a regression test.
- **SCHEDULER clock skew.** Forward-only `clock.set(Math.max(currentT, target+skew))`; `makeSimClock` throws on any backward set.
- **SCHEDULER timer jitter.** `ObservableScheduler` decorator perturbs `delay` to `eff=Math.max(0,delay+j)` before `inner.schedule`; preserves `isActive()===true`. **Jitter is keyed by a stable timer-site identity** `(stateName, invokeIndex, armEpoch)` via a deterministic site-derived PRNG fork (`fork('jitter:'+timerSiteId)`), NOT a monotonic schedule-call counter, so a timer re-armed by `resumeTimers` after snapshot/restore re-derives the SAME jitter (folds HIGH hole #2 — the double-jitter/replay divergence, verified at `:2486/:2519`). Affects invoke delays and `transitionTimeout`.
- **CALLBACK throw.** Before construction, wrap FUNCTION-VALUED callbacks resolved through `callAction` (guard, onTransition, event onBefore/onAfter/onSuccess, state onBefore/onEnter/onAfterEnter + exit triad, `invoke[].action`) to throw an `InjectedFault` (plain `Error`, never `StateMachineError`/`EnhancedStateMachineError`).

Equal-`executeAt` ordering: NO engine tiebreak in v1; the trace captures the ACTUAL fired-callback order as ground truth.

Fault targeting: by a harness-controlled `FaultSite` descriptor, NEVER by `context.phase`.

**transitionTimeout is a FIRST-CLASS rejection outcome (folds MED hole #1).** Timer-jitter can collapse the `transitionTimeout` deadline; the engine then throws a base `StateMachineError('Transition timeout')` (`:1790`, NOT Enhanced — no `Date.now()`). The trace records `errorClass:'transition-timeout'` with a normalized message (action name stripped) as a distinct outcome from `'injected-fault'`. AC-1 pins that timer-jitter + snapshot/restore yields an identical hash including the timeout path.

v1 EXCLUSIONS (documented gaps, not silent omissions): (a) `invoke[].cond` throw-injection (cond throw is caught-continued, not an error transition); (b) string-method (`ActionOrString` name-resolved) callbacks (cannot be wrapped by config mutation). The coverage gate MUST NOT report `error.guard-throw`/`error.action-throw` covered for a string-method-only machine. **A generator obligation:** emit at least one `invoke` whose `cond` is a literal-inlined deterministically-false function so `timer.invoke.cond-skip` is genuinely exercised via the legitimate skip path; `cond` is subject to the same closure-free/literal-inline rule as guards (folds LOW hole #6).

### Options considered
- **CHOSEN — seven-kind taxonomy on existing seams; `InjectedFault` plain Error; cond + string-method excluded; FaultSite targeting; no engine seam; transitionTimeout as first-class rejection; site-keyed jitter.** Zero engine/ABI change; exercises real error/backpressure/timer paths; replay bit-exact; honest gaps.
- *Rejected* — Scramble the internal queue: internal-before-external is an engine guarantee; would test harness corruption (I-7 would assert against a config the engine never emits).
- *Rejected* — Add `queueInterceptor?` to `StateMachineOptions`: breaks the zero-diff ABI; buys nothing in v1.
- *Rejected* — Throw `StateMachineError`/`EnhancedStateMachineError`: embeds `Date.now()` in `errorCode`/`timestamp`; breaks replay.
- *Rejected* — Inject cond/string-method throws to claim full coverage: asserts non-existent behavior; falsely claims coverage.
- *Rejected* — Impose a FIFO `(executeAt, seq)` tiebreak: engine/ABI change altering timer semantics for all consumers.
- *Rejected* — Filter faults by engine phase: `callAction` hardcodes `'action'`; the filter is useless.

### Consequences
- The `FaultPlan`/`FaultRecord` schema is fixed for v1; a monotonic `faultStep` counter drives one PRNG draw per opportunity so `FaultRecord[]` regenerates identically on replay (AC-2) — EXCEPT scheduler jitter/skew, which use **site-keyed** PRNG forks so snapshot/restore re-arms reproduce.
- `InjectedFault` is a plain Error; the trace records only the FROZEN `errorClass` enum; never `error.toJSON()`.
- The `SimErrorHandler` disables retry recovery so an injected throw never spawns the real `setTimeout` (`:154`); ADR-3 clarifies this is defense-in-depth (the engine never drives `handleError`).
- Overflow, depth, invalid-event, and transition-timeout all arrive as Promise REJECTIONS classified by the `errorClass` enum (structured, not prose). Every `fireEvent` is awaited with `.catch`.
- I-7 is meaningful only because internal is never scrambled; reorder faults are whitelisted via `frame.faultApplied==='reorder'`.
- Two coverage gaps are first-class (cond throw, string-method throw); REFLECT and the gate record them; hook/throw coverage is scoped to FUNCTION-VALUED callbacks (folds LOW hole #7 — the COVERED set is shape-scoped).
- Shrinker fault moves: M0 disables faults; M4 binary-searches `clockSkew.deltaMs`/`timerJitter.jitterMs`/`overflow.floodCount` toward the boundary; faults reference ops by stable op-id.
- No `queueInterceptor`; `StateMachineOptions` and `etc/statemachine.api.md` byte-identical (UR-005, AC-9).

### Contracts-on-implementation
1. `FaultKind` is exactly the seven-literal union; no internal-queue fault kind exists in v1.
2. Reorder/drop/dup operate ONLY on the external submission buffer; the engine `internalQueue` is never touched by the harness.
3. Throw injection wraps ONLY function-valued callbacks dispatched through `callAction`; `invoke[].cond` and string-method callbacks are NOT wrapped.
4. The thrown object is `class InjectedFault extends Error`; the trace records the FROZEN `errorClass` enum only.
5. Clock skew is forward-only `clock.set(Math.max(currentT, target+skew))`; `makeSimClock` throws on backward set.
6. Timer jitter applies `eff=Math.max(0,delay+j)` inside `ObservableScheduler`; jitter is keyed by stable timer-site identity via `fork('jitter:'+timerSiteId)` so resumed/re-armed timers re-derive identical perturbation.
7. Queue overflow is induced by flooding to `maxQueueDepth+1`; `captureRejection` classifies overflow vs depth structurally (synchronous-at-enqueue vs pending-during-drain), recording the `errorClass` enum; the two engine messages are pinned as regression fixtures.
8. Every `fireEvent` emitted by the harness is awaited with a `.catch` recording `resolve-true`/`resolve-false`/`reject`.
9. Fault targeting keys on a harness-owned `FaultSite`, never `context.phase`.
10. Equal-`executeAt` ties are recorded as the actual fired-callback order; no engine tiebreak.
11. transitionTimeout is recorded as `errorClass:'transition-timeout'` (distinct from `'injected-fault'`) with the action name stripped; AC-1 pins jitter+snapshot/restore hash stability including the timeout path.
12. The generator MUST emit at least one literal-inlined deterministically-false `cond` so `timer.invoke.cond-skip` is exercised via the legitimate skip path.
13. `StateMachineOptions` is unchanged; the sim attaches only to the five DI seams + `maxQueueDepth` + pre-construction config callbacks.

### Adversarial findings folded
- **HIGH #2 — timer-jitter + snapshot/restore double-jitters and re-draws at a different `faultStep`.** RESOLVED: site-keyed jitter PRNG fork (contract 6); `resumeTimers` re-arms re-derive identical jitter; AC pins jitter+snapshot/restore hash stability.
- **MED #1 — transitionTimeout `StateMachineError` outcome under-specified.** RESOLVED: first-class `errorClass:'transition-timeout'` outcome with normalized message (contract 11).
- **MED #5 — overflow vs depth disambiguated by fragile English prose.** RESOLVED: structured classification (synchronous-at-enqueue vs pending-during-drain) → FROZEN `errorClass` enum; messages pinned as fixtures (contract 7).
- **MED — `isEnabled()`-gated `recordError` value unpinned (cross-ADR with ADR-3).** RESOLVED in ADR-3: `isEnabled()===true` pinned in the header; SimMonitor.recordError is a no-op; the canonical error signal is the harness-boundary rejection only (never `recordError`/`traceLen`).
- **LOW #3 — consequence #3 over-claims the retry-timer risk.** RESOLVED in ADR-3: reworded — SimErrorHandler's load-bearing job is the deterministic `isEnabled()`; retry-disable is defense-in-depth.
- **LOW #6 — `timer.invoke.cond-skip` coverage unreachable without a deterministically-false cond.** RESOLVED: generator obligation (contract 12).
- *Missed-alternatives (site-keyed jitter fork, transitionTimeout as first-class outcome)* — both ADOPTED.

---

## ADR-6 — Safety/Liveness oracle architecture: blind-iterated declarative Invariant registry + fingerprint-and-fire-boolean Liveness; first-violation-wins shrinker target

**Affects:** UR-002, UR-003, UR-004, UR-005.

### Context
The engine exposes almost no model-checker observability: `recordTransition` always `success=true`/no context (`:2060`), `recordError` gated (`:424`), `recordEvent` never called, no done-event listener. Outcome/error must come from the `fireEvent` Promise + before/after `getCurrentState()` deltas. The engine's OWN guards enforce two structural safety properties by THROWING before corrupting state: `validateCompositeState` (`:1608`, called pre-write at `:1203`) and `getCurrentState` (`:1219`). `MAX_TRANSITION_DEPTH` is dormant. `getAvailableEvents`/`canFireEvent` do NOT execute guards (`:520`) so "structurally enabled" over-approximates "fireable" (the central Liveness hazard). Verified: in the normal transition path a `validateCompositeState` throw is CAUGHT and aborts cleanly (`fireEvent` resolves false), so the v1 fault set cannot drive I-6/I-10 through the propagating-throw path (HIGH hole #4); the errorState fallback changes config without `recordTransition` (HIGH hole #2); resumed invoke callbacks route through `fireEvent` (external, `:2506`) vs initial `raiseEvent` (internal, `:2172`) — a queue-routing asymmetry across restore (MED hole #5).

### Decision (ACCEPTED)
A two-part oracle, both driven off the ONE canonical content-only trace and the `settleMacrostep` substrate (ADR-4).

**A. SAFETY = a declarative `Invariant` registry the runner iterates BLIND.**
```ts
interface Invariant {
  readonly id: string; readonly scope: 'step'|'final'|'both'
  readonly capabilityTags?: readonly string[]
  checkStep?(frame: TraceFrame, ctx: CheckerContext): Violation|null
  checkFinal?(state: FinalState, ctx: CheckerContext): Violation|null
}
```
The runner holds a `readonly Invariant[]`, never references any id literally, calls `checkStep` per frame and `checkFinal` at run end. `CheckerContext.graph` is a read-only `ConfigGraph` computed ONCE from the config. The I-1..I-12 catalog is ratified with the verified must_fix framing (outcome from the `fireEvent` Promise + Adapter-seam state deltas, never `IMonitor`; I-6/I-10 reframed as "the engine's own guard fired and contained the fault"; I-8 rescoped to `maxQueueDepth` overflow; I-4 via config-injected pure-append owner-marker probes checked against the engine's `:1596–1603` collation; I-5 via `isDone(C)` deltas; I-12 done-gating via `isEngineDoneEvent` `:367`).

**Capture (the ratified cross-cutting seam, ADR-3):** state-changing frames via wrapping the consumer `Adapter.set(...)` method (`types.ts:295`), which catches ALL THREE engine write sites — `:1204` (`setCurrentStateInternal`), `:1116` (shallow-history restore), `:1126` (deep-history restore) — capturing `from`/`to` atomically AND the errorState/`abortOnExitError` bypass deltas AND the history-restore writes (`:1116`/`:1126` each `return` before `:1204`, so they would be invisible to a "`:1204`-only" reading; this is what makes the `history.shallow`/`history.deep` coverage capabilities of §6 observable); non-state-changing outcomes (`resolve-false`/`reject`) as harness-boundary frames; the harness wraps `getCurrentState` in try/catch (a throw is the I-10 witness). A guard-block emits NO state-write frame and is read from the harness-boundary `fireOutcome:'resolve-false'` (folds the MED hole on guard-block observability and the HIGH hole on `from`).

**I-6/I-10 triggering input (folds HIGH hole #4).** An **8th harness fault `corrupt-state`** is added (a direct `adaptee.set` of a contradictory/bogus composite before a probe read) so I-6/I-10 have an input that makes the engine's `validateCompositeState`/`getCurrentState` guard actually throw on the NEXT `updateState`/`getCurrentState`. Without a triggering input these invariants test nothing. (This 8th fault is harness-only, never reorders/throws via `callAction`; it is the sole way a bogus config reaches those guards, since the normal path catches-and-aborts.) **The `corrupt-state` probe issues its bogus write through the SAME consumer `Adapter.set` the capture seam wraps (verified: all state writes flow through `Adapter.set`), so it IS captured and produces a frame; that frame is tagged `synthetic:'corrupt-state'` (the closed `synthetic` discriminator of ADR-1, NOT a `cause` member) so it is reconciled with the frozen `TraceFrame` schema and distinguishable from an engine-causal write.** The `corrupt-state` fault and its capabilities are documented; it does not widen the seven-kind *channel* taxonomy of ADR-5 — it is a distinct state-corruption probe used exclusively by I-6/I-10.

**I-4 errorState exclusion (folds the MED hole).** The errorState configuration is entered via a bare `setCurrentState` (`:2020`) that does NOT run `executeEnterActions`, so enter-order probes are structurally silent there; errorState-targeted transitions are excluded from the I-4 probe-bearing topology family, documented as a deliberate engine behavior (errorState entry bypasses SCXML enter actions).

**B. LIVENESS = an explicit verdict model** (`PROGRESSED`|`STUCK`|`TIMEOUT_BUDGET_EXCEEDED`) over a `ProgressFingerprint = {config(normalized), queueDepth, pendingTimers, earliestTimerAt}`, run per-seed AFTER Safety on the `settleMacrostep` substrate. Quiescence classified `TERMINAL_FINAL`|`QUIESCENT_NO_WORK`|`WAITING_ON_TIMER`|`WAITING_ON_TRANSITION_TIMEOUT`|`ACTIVE`. The eventually-healthy window suppresses Liveness while `isHealthyAt(clock.t)` is false (progress-blocking faults cease after `healAtVirtualMs`). **The load-bearing fix — thread the fire boolean:** after firing a structurally-enabled event, `resolve-false` + unchanged fingerprint + healed → `QUIESCENT_NO_WORK` (guard-blocked rest), NOT STUCK; STUCK only when a fire `resolve-true` left the fingerprint unchanged or queue/timers churn (config stable) without reaching final/quiescent. A bounded cycle detector (`K=states.length+1`) catches A→B→A oscillations. `WAITING_ON_TRANSITION_TIMEOUT` (in-flight transition awaiting a not-yet-due timeout) is handled by the `settleMacrostep` clock-jump (ADR-4), closing the wedge.

**C. SHRINKER TARGET = FIRST-VIOLATION-WINS (lowest step).** At most one `Violation` per run: the lowest-step `checkStep` violation, else the first `checkFinal`, with I-1 short-circuiting. The single `Violation` carries `{invariantId, normalized witness, errorClass}`; the predicate re-fails iff SAME invariantId AND SAME fingerprint. **Each scenario contributing to coverage/shrink MUST pass I-1 (replay bit-exactness) first** (folds the LOW hole — a non-deterministic scenario is excluded and itself fails CI, so coverage never certifies via a broken trace).

**Restore replay scope (folds MED hole #5).** Because the resumed invoke callback routes through `fireEvent` (external) while the initial routes through `raiseEvent` (internal), a restore-bearing run is replay-equivalent only to ITSELF (same restore op at the same step), NOT to the pre-restore continuous run. Bit-exact replay is guaranteed for a CONTINUOUS run; I-7's internal-before-external assertion whitelists the post-restore external routing of resumed invoke events via the `synthetic:'post-restore'` marker (the closed `synthetic` discriminator of ADR-1, carried on the affected frames alongside their engine-causal `cause`; NOT a `cause` member). A regression test pins that a restore-bearing scenario hashes stably to its own re-run.

### Options considered
- **CHOSEN — blind declarative registry (Safety) + fingerprint/fire-boolean verdict (Liveness) + first-violation-wins (shrinker); capture via Adapter seam; I-6/I-10 fed by an 8th `corrupt-state` harness fault.** Decouples runner from invariants; `capabilityTags` wire into the coverage gate; one substrate; reuses the engine's own throwing guards.
- *Rejected* — hand-coded checker tree / per-invariant switch: couples runner to each invariant; cannot mechanically wire `capabilityTags`.
- *Rejected* — source `IMonitor` as the transition/error oracle: falsified by source (`:2060`/`:424`/never-called).
- *Rejected* — keep I-6/I-10 as independent reimplemented containment assertions: tests the harness, not the engine; and (now) provides no triggering input.
- *Rejected* — pure no-advance fingerprint stall detector (no fire boolean): false STUCK on guard-blocked rest and drop-heavy seeds; misses A→B→A cycles.
- *Rejected* — add a pending-count accessor to `ITimerScheduler`: ABI change; the additive `ObservableScheduler` achieves it with zero churn.
- *Rejected* — report all/last/any-failure violations: ddmin slippage / no single fingerprint.

### Consequences
- SimMonitor is neutralization-only (ADR-3); transition outcome/error come from the `fireEvent` boundary; capture is the Adapter-write seam.
- I-6/I-10 require the 8th `corrupt-state` harness fault to have a triggering input; they assert the engine's own `validateCompositeState`/`getCurrentState` throw fired and the post-fault config is graph-valid.
- I-8 no longer asserts a `transitionDepth` bound (dormant); runaway observed only via `maxQueueDepth` overflow (I-9); `queue.depth-bound.max-transition` is marked dormant/observed-only.
- I-4 requires the generator to inject pure-append owner-marker probes on enter/exit (closure-free literals to survive snapshot/restore); errorState targets are excluded from the I-4 family.
- Liveness needs the generator to expose `maxArmedDelay`/longest-chain so `budgetVirtualMs`/`healWindow` dominate the longest legal chain.
- The single `ObservableScheduler` (mirrors `executeAt=clock()+delay` + lazy cancel, `isActive()===true`) is the sole timer-visibility seam (zero engine/ABI change).
- The runner emits at most one `Violation` per run; trace-hash exclusion (ADR-1) is the hard prerequisite verified by the AC-1 canary; restore-bearing runs replay only to themselves.
- `invoke[].cond` throws are OUT of the Safety/error model for v1; the gate reports `timer.invoke.cond-skip` (cond returned false) but no error capability for a cond throw.

### Contracts-on-implementation
1. `Invariant` and `Violation` interfaces are FROZEN at TECH_SPEC; the runner iterates a `readonly Invariant[]` and never references any id literally; it reports the LOWEST-step `Violation` only (I-1 short-circuits).
2. `Violation` carries a derived fingerprint `{invariantId, witness (split('|').sort().join('|')), errorClass}` as the shrinker target.
3. `CheckerContext.graph` is a read-only `ConfigGraph` computed ONCE; checkers are pure functions of `(frame|state, ctx)` with no live engine reads beyond the frame.
4. Capture is the Adapter-write seam — wrapping the consumer `Adapter.set(...)` method (`types.ts:295`), catching ALL THREE engine write sites `:1116`/`:1126`/`:1204` (NOT "`:1204`-only"; `:1116`/`:1126` history-restore writes `return` before `:1204`) — for state-changing frames + harness-boundary frames (`resolve-false`/`reject`); `getCurrentState` reads are try/catch-wrapped (a throw is the I-10 witness). A regression test asserts history.shallow/history.deep restores each produce a captured `(from, to)` frame.
5. `fireOutcome` is exactly `resolve-true`|`resolve-false`|`reject`, sourced from the awaited `fireEvent` Promise; a blind/invalid fire MUST be awaited with `.catch`.
6. `LivenessVerdict` and `ProgressFingerprint` are FROZEN; `maybeFireEnabledEvent` fires ONLY structurally-enabled events and branches on the fire result (`resolve-false`+unchanged+healed → `QUIESCENT_NO_WORK`; `resolve-true`+unchanged → `STUCK`; `reject` routed distinctly).
7. Liveness is SUPPRESSED while `isHealthyAt(clock.t)===false`; progress-blocking faults cease by `healAtVirtualMs`; cycle bound `K=states.length+1`.
8. The `ObservableScheduler` is the sole timer-visibility seam; no engine/ABI change.
9. I-6/I-10 assert the engine's own throw occurred and the post-fault config is graph-valid; they REQUIRE the 8th `corrupt-state` harness fault as their triggering input.
10. Each scenario contributing to coverage/shrink MUST pass I-1 first; a non-deterministic scenario is excluded from the coverage union and fails CI.
11. Restore-bearing scenarios are replay-equivalent only to their own re-run; I-7 whitelists the post-restore external routing of resumed invoke events via the `synthetic:'post-restore'` frame marker (the closed `synthetic` discriminator, never a `cause` member).
12. The shrinker predicate is contingent on I-1 (AC-1 canary).

### Adversarial findings folded
- **HIGH #1 — `recordTransition` cannot read `from`.** RESOLVED by the Adapter-write capture seam (contract 4; cross-cutting resolution).
- **HIGH #2 — errorState fallback changes config without `recordTransition`.** RESOLVED: Adapter seam captures `:2020`; settle-diff backstop; emitted with the closed `synthetic:'errorState-fallback'` discriminator (ADR-1 contract #1 / ADR-3), NOT a `cause` member.
- **HIGH #4 — I-6/I-10 vacuous (no v1 fault produces a propagating containment throw).** RESOLVED: 8th `corrupt-state` harness fault as the triggering input (contract 9).
- **MED — I-4 enter-order probes silent for errorState entry.** RESOLVED: errorState targets excluded from the I-4 family; documented engine behavior.
- **MED #5 — restore double-routes resumed invokes (internal→external), breaking I-1/I-7 across restore.** RESOLVED: restore-bearing runs replay only to themselves; I-7 whitelists post-restore external routing (contract 11).
- **MED — WAITING_ON_TRANSITION_TIMEOUT unmodeled, wedges the drain.** RESOLVED by the `settleMacrostep` clock-jump (ADR-4) + the new quiescence class.
- **LOW — default monitor "arms setInterval every transition" overstated.** RESOLVED: SimMonitor is custom solely to avoid the `monitoring.ts:97` `Date.now()` stamp; `.start()`/`setInterval` is never armed by the engine (defensive guidance only).
- **LOW — coverage can certify via a non-deterministic trace.** RESOLVED: contributing scenarios must pass I-1 first (contract 10).
- *Missed-alternative (Adapter `set()` interception)* — ADOPTED as the primary capture seam.

---

## ADR-7 — DST packaging, public sim surface, and the DI-first wiring boundary

**Affects:** UR-002, UR-003, UR-004, UR-005.

### Context
UR-005 demands BOTH an internal harness AND a public entrypoint while preserving API stability, the bundle budget, and the ABI baseline. Verified: determinism is wholly DI-driven (five seams, each falling back to a wall-clock/real-time default when omitted); `schedulerProvided = scheduler!==undefined` (`:154`) keys off presence not the clock, so forwarding `clock` while omitting `scheduler` silently yields the real-time `createDefaultScheduler()` (`:155`) under a virtual clock (a type-unenforceable footgun); the core `'.'` surface (5 stable symbols) and `etc/statemachine.api.md` are frozen, gated by `git diff --exit-code` on node-20; `tsup` has one entry/`splitting:false`, one exports key `'.'`, `sideEffects:false`; `verify-dist.cjs` asserts only file existence; shared `tsconfig` includes `src/**` (NOT excluding `src/sim`), so a sim type error blocks `check`/`build`/`prepublishOnly` (tier-a-bun + tier-a-node 18/20 are blocking; tier-b deno/browser are `continue-on-error`); knip `project:['src/**/*.ts']` does not ignore `src/sim`. **Empirically proven:** rebuilding with `entry:['src/index.ts','src/sim/index.ts']` `splitting:false` leaves `dist/index.js`/`dist/index.cjs` byte-identical and duplicates the engine into `dist/sim/`. `StateMachine.scheduler` is a PRIVATE field with no public getter; `StateMachine.schedulerProvided` is private (verified by grep — no `getScheduler`/`getOptions`).

### Decision (ACCEPTED)
Ship the DST environment as a SEPARATE public sub-entrypoint `@vedmalex/statemachine/sim`, additive and opt-in, with the core `'.'` surface and `dist/index.{js,cjs}` BYTES unchanged.

**D1 Packaging.** Add `src/sim/index.ts` as a SECOND tsup entry; keep `splitting:false`. Add a SECOND exports key `./sim` (types `./types/sim/index.d.ts`, import `./dist/sim/index.js`, require `./dist/sim/index.cjs`); the `'.'` key is byte-identical; `sideEffects:false` unchanged. Add a SECOND `api-extractor.sim.json` (main `types/sim/index.d.ts`, report `statemachine-sim.api.md`) + `api:check:sim`.

**D2 DI-first public API.** Export `runSimulation(setup, opts)` and a `Simulator` class. **The sanctioned path is `wire(env, config, owner)` (the ratified safer variant): the harness ITSELF constructs the `StateMachine(config, owner, {clock, scheduler, monitor, errorHandler, logger})` with all five seams pre-forwarded, so the scheduler-omission footgun is STRUCTURALLY impossible on the supported path** (folds CRIT — the original identity-assertion was infeasible because the field is private). A `setup(env)` that returns a pre-built instance is supported best-effort and documented as unverifiable. `SimEnv` exposes the five deterministic seams + `random`/`now`. The sim imports the engine ONLY via the public `../index` surface (doubling as a public-ABI conformance harness). **`wire()` and the driver always pass the harness-wrapped Adapter as the EXPLICIT 2nd positional arg to `fireEvent`, never relying on the overload's non-Adapter-unshift path (`:469–471`), so consumer-supplied event args are unambiguous (contract 13).**

**D3 Scheduler-required wiring + behavioral probe (folds CRIT + HIGH).** Since `StateMachine.scheduler` is private, identity comparison is infeasible; the runtime guard is a **behavioral probe** owned by `wire()`: arm a harness-owned sentinel timer (an injected `transitionTimeout` or invoke during `init()`, so even **timer-less consumer machines** get one probe — closing the HIGH blind spot), advance `env.clock` past its delay, call `env.scheduler.process()`, drain to quiescence, and assert the sentinel fired through `env.scheduler`; if not (pending on a real `setTimeout` because `schedulerProvided===false`), FAIL LOUDLY. `wire()` is the required path; raw `setup()`-returns-instance is best-effort.

**D4 Stability tiering.** Tag EVERY sim symbol `@unstable` (own island). The sim surface is governed by `etc/statemachine-sim.api.md` + a `public_sim_surface.test.ts` asserting symbol PRESENCE (not md5). The 5 core stable symbols and `etc/statemachine.api.md` are untouched.

**D5 Bundle tradeoff.** Accept engine DUPLICATION into `dist/sim` under `splitting:false` (empirically proven core bytes unchanged). Document that consumers pick ONE entrypoint and do not mix `'.'` and `./sim` engine instances in one module graph. Do NOT enable splitting (would rewrite the core chunk layout).

**D6 Shared-tsconfig consequence.** ISOLATE sim type-check + declaration emission so a sim type error cannot block core build/`prepublishOnly`/tier-a legs; that is the ratified target. Fallback (if isolation is infeasible without breaking `types/sim/index.d.ts` emission) is explicit acceptance + documentation. (Blast radius corrected: blocks tier-a-bun + tier-a-node 18/20 + `prepublishOnly`; tier-b deno/browser surface it as non-blocking `continue-on-error`.)

**D7 knip reachability (corrected mechanism).** `src/sim/index.ts` auto-registers via knip default `index.ts` globs (verified: exits 0 even WITHOUT the `./sim` exports key). The real exposure is NON-`index` sim files unreachable from the entry. **Three reachability classes** must be green before folding `sim:coverage` into `check`: (1) the public `./sim` surface; (2) the gate CLI (`coverage.ts` — register as an explicit knip `entry`); (3) `scenarios/*.ts` (reachable via `coverage.test.ts` importing the scenario registry, or an explicit entry). Do NOT blanket-ignore `src/sim`.

**D8 New dist byte/hash guard** on `dist/index.{js,cjs}` proving the core bytes are unchanged after the second entry — neither `verify-dist.cjs` (existence-only) nor `api:check` (type-surface-only) covers dist byte stability.

### Options considered
- **CHOSEN — separate `./sim` entry; `wire()`-from-consumer-config DI-first API; behavioral scheduler probe; `@unstable` tiering; `splitting:false` engine duplication; isolated sim tsconfig; new dist byte guard.** Core bytes provably unchanged; consumer simulates their own machine; sim ABI gated independently; footgun structurally eliminated on the supported path.
- *Rejected* — fold sim into `'.'`: non-zero `etc/statemachine.api.md` diff (UR-005 violation); grows the core bundle.
- *Rejected* — internal-only harness, no public entry: fails the explicit UR-005 public-sim requirement and UR-003 constructibility.
- *Rejected* — separate entry with `splitting:true`: rewrites the core chunk layout → core bytes change.
- *Rejected* — config-first API (harness authors topology): fails UR-003 "arbitrary consumer machine"; re-introduces the omitted-seam footgun internally.
- *Rejected* — `setup()`-returns-instance as the PRIMARY path with object-identity assertion: the scheduler field is PRIVATE → identity assertion infeasible (the CRIT hole). Replaced by `wire()`-from-config (the missed-alternative now ADOPTED) + a behavioral probe for the best-effort path.
- *Rejected* — additive `@unstable` getter on `StateMachine` to expose the scheduler: adds a line to `etc/statemachine.api.md` (conflicts with zero-diff) for no benefit over the `wire()` structural fix.

### Consequences
- Core consumers importing `'.'` are unaffected: no new bytes/symbols; `etc/statemachine.api.md` zero-diff continues to pass.
- A NEW dist byte/hash guard is added and wired into CI (existence-only `verify-dist.cjs` does not cover content).
- A second api-extractor baseline `etc/statemachine-sim.api.md` + `api:check:sim` + a `git diff --exit-code` step land on the node-20 leg.
- Engine code is duplicated into `dist/sim`; published size grows; documented as opt-in; one entrypoint per module graph.
- The scheduler footgun is structurally eliminated on the `wire()` path and behaviorally probed on the best-effort path (timer-less machines get a sentinel probe).
- `src/sim` production code is under biome + tsc + knip; symbols must be reachable from the `./sim` entry (three reachability classes).
- Shared tsconfig: a sim type error blocks tier-a (bun + node 18/20) + `prepublishOnly` unless isolation lands; tier-b surfaces it non-blockingly.
- All sim symbols `@unstable`; governed by its own api-extractor baseline + a presence test.
- Downstream: a nightly sweep workflow + an env-gated heavy sim suite excluded from the default vitest include; PR-fast budget on node-20 only. Changeset is MINOR (additive `./sim`), mirroring the TASK-013 precedent.

### Contracts-on-implementation
1. `package.json` exports adds exactly one `./sim` key; the `'.'` key is byte-identical; `sideEffects:false` unchanged.
2. `tsup.config.ts` entry is `['src/index.ts','src/sim/index.ts']`; `splitting` STAYS false; format/target/outExtension unchanged so `dist/index.{js,cjs}` regenerate byte-identically.
3. A dist byte/hash guard asserts `dist/index.{js,cjs}` hashes unchanged vs a committed baseline; fails CI on drift.
4. `etc/statemachine.api.md` MUST remain zero-diff; the 5 stable core symbols are untouched.
5. A second `api-extractor.sim.json` + `api:check:sim`; `etc/statemachine-sim.api.md` committed and drift-gated on node-20.
6. `src/sim/index.ts` is the ONLY public sim entry; NOT re-exported by `src/index.ts`; the sim imports the engine ONLY via `../index`.
7. Every exported sim symbol carries an `@unstable` tag; `public_sim_surface.test.ts` asserts presence, not md5.
8. `SimEnv` exposes `clock: Clock`, `scheduler: ITimerScheduler` (NON-optional), `monitor: IMonitor`, `errorHandler: IErrorHandler`, `random`, `now` — all harness-supplied deterministic; the `traceHash` derives only from observable transition data.
9. The sanctioned `wire(env, config, owner)` constructs the `StateMachine` with all five seams; the scheduler-omission footgun is structurally impossible on this path. A behavioral sentinel probe verifies the env scheduler is in use (for the best-effort `setup()`-returns-instance path), arming a harness-owned timer even for timer-less machines.
10. knip green on three reachability classes (public surface, gate CLI entry, scenarios) before `sim:coverage` folds into `check`; no blanket `src/sim` ignore.
11. Sim type-check/declaration emission isolated so a sim error cannot block core build/`prepublishOnly`/tier-a; else the coupling is documented as an accepted risk.
12. The heavy sim suite is env-gated (`SM_SIM`/`describe.skipIf`) OUT of the default vitest include; the fast sim budget + `api:check:sim` + coverage gate run only on node-20.
13. **fireEvent sequencing — args[0] disambiguation (folds the un-folded half of the plan's `fireEvent sequencing contract` must_fix, plan line 413).** `fireEvent` is overloaded: `fireEvent(eventName, obj?, ...args)` (`state_machine.ts:457–460`); when the 2nd positional arg is NOT an `Adapter` (`isAdapter` is the duck-test `'set' in inp && 'get' in inp`, `types.ts:301`), the engine `unshift`s it into `args` and falls back to `this.adaptee` as the target (`:469–471`). Therefore every harness-emitted `fireEvent` MUST pass the explicit (harness-wrapped) Adapter as the 2nd positional arg and NEVER rely on the overload's unshift path, so `args[0]` is unambiguous and the fire targets the intended adaptee. For generated scenarios `Op.args` is already constrained to `number[]` (plan §4.2), so this hazard cannot arise; for the arbitrary-consumer `wire()` path it MUST be documented that consumer-supplied event args are passed only as the trailing `...args` (3rd-onward positional) — never as the 2nd positional — and a consumer args value that is itself an object (especially one carrying `set`/`get` keys) would otherwise be mis-parsed as the Adapter and silently re-routed, producing a replay-divergent or wrong-target fire. (The macrostep await-ordering half of the plan's must_fix is already pinned in ADR-4 line 258 + §3.2: `clock.set → settleMacrostep → deliver/await → record`.)

### Adversarial findings folded
- **CRIT — object-identity scheduler assertion infeasible (private field).** RESOLVED: `wire()`-from-config makes the footgun structurally impossible on the supported path; the best-effort path uses a behavioral sentinel probe (contract 9).
- **HIGH — footgun undetectable for timer-less machines.** RESOLVED: `wire()` arms a harness-owned sentinel timer during `init()` even for timer-less machines.
- **MED — CI blast radius overstated.** RESOLVED: corrected to tier-a (bun + node 18/20) + `prepublishOnly` blocking; tier-b `continue-on-error`.
- **LOW — knip auto-registration mechanism mis-stated.** RESOLVED: auto-registers via default `index.ts` globs; the exposure is non-`index` files → three reachability classes (D7, contract 10).
- *Missed-alternatives (`wire`-from-consumer-config; `@unstable` getter)* — `wire()`-from-config ADOPTED; the getter explicitly rejected on the zero-diff cost.

---

## ADR-8 — Coverage-gate model: closed-union `CapabilityRegistry` with runtime trace-probes as the primary signal; honestly-scoped mandatory-gate semantics

**Affects:** UR-004, UR-005.

### Context
UR-004 demands ALL functionality covered, enforced by a MANDATORY programmatic gate, declarative + extensible. Verified: `IMonitor` cannot be the signal (`recordTransition` `:2060` is `(duration,true)`, no context; `recordError` gated `:424`; `recordEvent` never called) — coverage must be reconstructed at the harness boundary. The observable surface that CAN ground a probe: `getCurrentState()`/`getCurrentStateInfo()`/`getQueueDepth()`/`isProcessingEvents()`/`getAvailableEvents()` (no guards) and `isDone(compositeId)` (requires an id, `:1433`); done.state separable via `isEngineDoneEvent` (`:367`); rendered `currentState` is insertion-ordered (`:1202`). knip `project:['src/**/*.ts']` does not ignore `src/sim`, biome errors on unused, `check`=`biome+tsc+knip` with no sim step.

### Decision (ACCEPTED)
A two-layer coverage gate in `src/sim/capabilities.ts` + `coverage.ts`.

**(A) Registry as a GENUINE closed union + exhaustive `Record`.** `export type CapabilityId = '<every §6 row literal>'` (an explicit string-literal union, NOT `string & {}`) and `export const CAPABILITIES: Record<CapabilityId, Capability>`. The union MUST contain NO `string`/`string & {}` widening member (a single such member silently re-opens it and defeats `tsc`). Because the value is a total `Record` over the closed union, `tsc --noEmit` fails if ANY declared id lacks an entry — compile-time completeness for DECLARED capabilities. **A sim test deliberately removes one `CAPABILITIES` entry and asserts `tsc --noEmit` fails**, pinning the guarantee (folds HIGH hole #1 — the plan's literal `string & {}` would silently collapse to `Record<string,…>` and enforce ZERO totality; the bogus `config_validator:132` "exhaustiveness" precedent citation is dropped).

**(B) Pure trace-probes as the PRIMARY signal.** `type CapabilityProbe = (trace: SimTrace) => boolean`, a pure function over the recorded canonical trace. **Error probes switch on the FROZEN `errorClass` enum (ADR-3/ADR-5), NOT `e.message`** (folds HIGH hole #2 — the hashed `TraceFrame` strips `message`; the §4.9 `e.message.includes(...)` probes cannot fire over the canonical trace). The `errorClass` enum (`'queue-overflow'`|`'max-transition-depth'`|`'transition-timeout'`|`'invalid-event'`|`'injected-fault'`) is computed once at the harness boundary from the verified engine messages and is the probe input. Edges are reconstructed via the Adapter-write seam (ADR-3) + harness-known event name + `fireOutcome`. Done via `isEngineDoneEvent` + `isDone(C)` deltas. Hook-phase via scenario-pushed owner-markers. All state-derived values `'|'`-normalized.

**Trace has TWO frame sources (folds MED hole #3 — guard-block observability).** (1) state-changing frames via the Adapter-write seam; (2) harness-boundary settle frames carrying `fireOutcome` (`resolve-true`/`resolve-false`/`reject`) emitted for EVERY fired event regardless of whether a transition applied. `transition.guard.block` reads source (2) `fireOutcome==='resolve-false'` with config-stable before/after state, NEVER source (1) (a guard-block emits no state-write frame).

**`transition.priority` probe (folds MED hole #4).** The generator emits a priority conflict where the high-priority `to` is structurally UNREACHABLE except via priority selection, making the winning `to` the witness; if that is infeasible for a given topology, the capability is covered via a scenario-side owner-marker (the scenario KNOWS it constructed the conflict). Either way a concrete probe exists so the "every §6 row has a probe" claim holds.

**(C) Optional drift-checked tags.** A scenario MAY declare `expects: readonly CapabilityId[]`; the gate FAILS CI if a claimed probe never fired (drift). Tags document intent; they are never the pass signal.

**(D) Gate algorithm.** `computeCoverage` replays all registered scenarios (**each must pass I-1 first**, ADR-6), unions probe-fired ids, computes `uncovered = keys(CAPABILITIES) \ covered`, exits non-zero on `uncovered>0 || drift>0` with `id + engineRefs + "add a scenario that…"`. Runnable as a CLI (`sim:coverage`) and `src/tests/sim/coverage.test.ts`.

**(E) Enforced new-feature loop, residual named honestly.** (1) add a `CapabilityId` + `CAPABILITIES` entry (else `tsc` fails); (2) add/extend a scenario so the probe fires (else `computeCoverage` fails); (3) optional drift-checked `expects`. The HONEST residual — nothing in tooling forces a NOVEL engine branch to ACQUIRE a `CapabilityId`, and nothing prevents silently DELETING an id (a smaller closed union is still total) — is closed by a PR-template/CODE_REVIEW checklist PLUS a **committed snapshot of the `CAPABILITIES` key set** (`etc/sim-capabilities.txt`) so a removal is a reviewable drift (folds the missed-alternative). REFLECT records coverage as "registry-scoped", not literally exhaustive.

**(F) CI placement: resolve knip first, then fold.** Per ADR-7 D7's three reachability classes; only after knip is green does `sim:coverage` join as a node-20-only fast-PR step + the standing `coverage.test.ts`.

### Options considered
- **CHOSEN — genuine closed-union `CapabilityId` + total `Record` + pure trace-probes (errorClass-keyed) as primary signal; drift-checked tags; key-set snapshot.** `tsc` enforces declared-capability completeness; probes assert the REAL engine exercised the path (defense-in-depth); reads the one canonical trace; declarative/extensible.
- *Rejected* — tags-only: certifies author intent, not engine behavior; violates UR-004 defense-in-depth.
- *Rejected* — `IMonitor` counters: disproven by source.
- *Rejected* — add an engine seam (`IMonitor.recordHook`/context-bearing `recordTransition`): ABI change (zero-diff non-goal); owner-markers suffice for v1.
- *Rejected* — open registry (plain array, no closed union): loses the compile-time guarantee.
- *Rejected* — `string & {}` union (the plan's literal source): OPEN branded string → `Record<string,…>` → zero `tsc` totality. The decision OVERRIDES it with a real literal union.
- *Rejected* — fold `sim:coverage` into `check` before resolving knip: breaks `check` for everyone.

### Consequences
- A DECLARED capability with no covering scenario is a hard CI failure; the gate is genuinely mandatory for the closed set. Engine branches never given a `CapabilityId` are intentionally outside the tooling guarantee (PR-template + key-set snapshot).
- Each capability requires a correct probe (CODE_REVIEW surface; the drift-check is partial cross-validation).
- The gate consumes the same canonical trace as Safety/shrinker; the `TraceFrame` shape + `errorClass` enum must be frozen in TECH_SPEC before probes are written.
- Hook-phase coverage depends on owner-markers; string-method-callback machines are a documented v1 gap, never "covered"; hook/throw coverage is scoped to function-valued callbacks.
- Folding into `check` is BLOCKED until knip's three reachability classes are green; until then the gate runs as `coverage.test.ts` + a node-20 PR step.
- REFLECT records coverage as "registry-scoped".

### Contracts-on-implementation
1. `CapabilityId` is a GENUINE closed string-literal union (no `string`/`string & {}` member); `CAPABILITIES` is a total `Record<CapabilityId, Capability>`; a sim test removing one entry MUST make `tsc --noEmit` fail.
2. `CapabilityProbe` is a pure `(trace: SimTrace) => boolean` over the canonical trace; error probes switch on the FROZEN `errorClass` enum, NEVER `message`; a probe MUST NOT read `IMonitor` counters, wall-clock, or non-trace state.
3. Edges reconstructed via the Adapter-write seam + harness-known event name + `fireOutcome`; the gate MUST NOT depend on `IMonitor.recordTransition`.
4. Error/failure coverage captured at the harness boundary (`await fire().catch`), classified by the `errorClass` enum; NEVER `monitor.recordError`.
5. Done coverage uses `isEngineDoneEvent` (`:367`) + `isDone(C)` deltas; NO zero-arg global-done capability.
6. Any state-derived value a probe inspects MUST be `'|'`-normalized.
7. `transition.guard.block` reads the harness-boundary `fireOutcome:'resolve-false'` source, never a state-write frame.
8. `transition.priority` has a concrete probe (unreachable-except-via-priority `to`, or a scenario owner-marker).
9. `expects` is drift-checked; tags are never the pass signal.
10. `computeCoverage` exits non-zero on `uncovered>0 || drift>0`; each contributing scenario MUST pass I-1 first.
11. Hook-phase capabilities via owner-markers; string-method machines reported as a documented gap; hook/throw coverage scoped to function-valued callbacks.
12. knip green on three reachability classes before `sim:coverage` folds into `check`; a committed `etc/sim-capabilities.txt` key-set snapshot gates id removal; the catalog-completeness residual is a documented PROCESS gap.

### Adversarial findings folded
- **HIGH #1 — `string & {}` defeats `tsc` totality; bogus `config_validator:132` precedent.** RESOLVED: genuine literal union + no-widening-member rule + a remove-one-entry `tsc`-fails test (contract 1); precedent citation dropped.
- **HIGH #2 — probes read `e.message` but the hashed frame strips `message`.** RESOLVED: probes switch on the FROZEN `errorClass` enum (contract 2; ADR-3/ADR-5).
- **MED #3 — `transition.guard.block` not in a `recordTransition` frame.** RESOLVED: two frame sources; guard-block read from the harness-boundary `resolve-false` (contract 7).
- **MED #4 — `transition.priority` had no pure-trace probe.** RESOLVED: structurally-unreachable-except-via-priority `to` or scenario owner-marker (contract 8).
- **MED #5 — knip reachability under-specified for the gate CLI + scenarios.** RESOLVED: three reachability classes (ADR-7 D7, contract 12).
- **LOW — coverage can union over a non-deterministic trace.** RESOLVED: contributing scenarios pass I-1 first (contract 10).
- **LOW — hook/throw coverage shape-scoped to function-valued callbacks.** RESOLVED: documented (contract 11).
- *Missed-alternatives (AST/v8 source-coverage secondary signal; key-set snapshot)* — key-set snapshot ADOPTED (contract 12); source-coverage NAMED as a deferred option for giving the catalog-completeness residual some tooling teeth (REFLECT/OQ#5).

---

## Determinism leak ledger

Full audited inventory. `reaches-hash` is the property the architecture must guarantee is **no** for every row. `§5.1` = whether the plan's §5.1 table already listed it. Rows beyond §5.1 flagged **GAP** are folded into the ADR-3 neutralization policy (NOT dropped).

| Site | Pattern | Reaches hash? | §5.1 | Resolution / where neutralized |
|---|---|---|---|---|
| `state_machine.ts:2047,2059` | `Date.now` (transition-duration telemetry) | no | yes | EXCLUDE from hash (ADR-1); perf-plane only; not virtualized (honors `:2044`). |
| `state_machine.ts:156` | `Date.now` (default clock fallback) | no | yes | SimClock injected; `Date.now` never selected. |
| `state_machine.ts:2207` | `setTimeout` (real-timer fallback in `setTimer`) | conditional | **no — GAP** | Dead under sim: `schedulerProvided===true` (`:2199`) routes to the virtual scheduler; reachable only if a consumer forwards `clock` but omits `scheduler` — neutralized by ADR-3/ADR-7 mandatory `scheduler` injection + the `wire()` behavioral probe. Added to the neutralization policy. |
| `scheduler.ts:36,64` | `Date.now` / `setInterval` (TimerScheduler ctor default clock + `start()` poller) | no | **no — GAP** | Bypassed by `createVirtualScheduler` (constructs inner with the injected virtual clock at `:262`; `isActive()` is a hardcoded `return true`, never the intervalId; `start()` never called). Added to the neutralization policy as "bypassed by createVirtualScheduler". |
| `monitoring.ts:77,97,122,163,170,371,550,645,653,661,677,681` | `Date.now` (default monitor startTime + per-record timestamp + utils) | conditional | yes | Inject FRESH SimMonitor (ADR-3); NEVER `createDefaultMonitor`; NEVER delegate to `MetricsCollector` (so `:97` is structurally unreachable); NEVER `.start()`. `:645–688` `MonitoringUtils` is inert (no engine call site). |
| `monitoring.ts:230,337` | `setInterval` (Performance/Health `.start()`) | no | yes | Engine never calls `.start()`; SimMonitor never started. |
| `error_handling.ts:79,88` | `Date.now` (`EnhancedStateMachineError.timestamp` + `errorCode`) | conditional | yes | Trace records only the FROZEN `errorClass` enum; `errorCode`/timestamp stripped by explicit field selection; `InjectedFault` is a plain Error. |
| `error_handling.ts:154` | `setTimeout` (`RetryRecoveryStrategy.recover()`) | no | yes | SimErrorHandler registers NO `RetryRecoveryStrategy`; the engine never drives `handleError` (only `isEnabled()` at `:424`) — defense-in-depth. |
| `error_handling.ts:249` | `Date.now` (`getStats()` bucketing) | no | yes | Reporting only; never on the transition path; `getAnalytics()` returns a frozen stand-in never traced (ADR-3). |
| `security.ts:430,462` | `Date.now` (`serializeAction createdAt`) | conditional | yes | Never hash raw `toJSON()`/`toSecureJSON()`; snapshot/restore contributes only reconstructed normalized `currentState` + `stateEntryTimes`; `configHash` folds `Function.prototype.toString()` bodies, excludes `createdAt`. |
| `security.ts:367–388` | `crypto.subtle` SHA-256 / FNV-1a fallback | no | **no — GAP** | Deterministic given identical input, but its INPUT embeds `createdAt:Date.now` and it is reachable only via `serializeActionAsync`→`toSecureJSON` (persistence), never the transition path. Same resolution as `:430/:462` (never hash raw serialized bytes). Added to the neutralization policy + the CODE_REVIEW grep-audit. |
| `logger.ts:113,116,189` | `Date.now` / `new Date` (log timestamps; the ONLY `new Date` in engine src) | no | yes | NoopLogger injected; logs never traced. |
| engine state paths | `Math.random` | no | yes | ZERO occurrences in non-test src (verified). |
| engine state paths | `performance.now` / `process.hrtime` | no | yes | ZERO in non-test src (verified). |
| engine | `setImmediate`/`nextTick`/`uuid`/`getRandomValues`/`randomUUID`/`os.*`/`process.env` | no | n/a | ZERO anywhere (catch-all grep) — inventory complete for these patterns. |
| `state_machine.ts:289` | `queueMicrotask` (RTC drain seam) | no | n/a | Not a wall-clock/random leak; the quiescence-drain seam (ADR-4). Deterministic within one isolate; `header.runtime` pins it. vitest does NOT fake `queueMicrotask`. |
| `state_machine.ts:1202,1170–1199,2308,2352` | Map insertion-order `currentState` render | conditional | **no — order hazard, handled in §4.4/§5.3** | `'|'`-normalization `split('|').sort().join('|')` before hashing (ADR-1 contract 3/9); region-order regression test. |
| `state_machine.ts:1493` | depth-only `checkCompletion` candidates sort; same-depth sibling `done.state.<C>` emit order is insertion-driven | conditional | **no — GAP (substantive)** | **The one substantive new gap (verified `:1493–1495`: `.sort((a,b)=>b.split('.').length-a.split('.').length)` — depth ONLY, no tiebreak; same-depth siblings fall back to `atomicLeaves`/`seen` insertion order).** This is the `done.state` analogue of the equal-`executeAt` timer-tie finding. SELECTION is unaffected (which composites are done is set-determined); only the RAISE-ORDER of multiple sibling done events in one macrostep is insertion-driven. **Folded into ADR-3 neutralization policy:** the trace captures the ACTUAL raised-event order as ground truth (as it already does for timer ties), and a regression test pins sibling `done.state` order so a future Map-iteration refactor cannot silently change the hash. Added to the CODE_REVIEW grep-audit. |
| `state_machine.ts:355–361,1808–1848` | transition selection ordering | no | yes | Deterministic: `event.transitions.filter()` preserves declaration order; highest priority with strict `<`, first-declared wins on ties. No Map/Set iteration in the selection loop. |
| `state_machine.ts:1312–1334` | region init order | no | yes | Deterministic: `Object.entries(regions)` insertion order; `regionStatesConfig.initial \|\| Object.keys()[0]`. |
| `state_machine.ts:1596–1603` | enter/exit `.sort` | no | yes | Explicit total order with index tiebreak (`a.depth-b.depth\|\|a.index-b.index`); deterministic. |

**Gaps beyond §5.1 (all folded into ADR-3's neutralization policy, none dropped):**
1. `state_machine.ts:2207` real-`setTimeout` fallback — neutralized by mandatory scheduler injection.
2. `scheduler.ts:36,64` ctor `Date.now` + `start()` `setInterval` — bypassed by `createVirtualScheduler`.
3. `security.ts:367–388` crypto/FNV — same as `serializeAction` (never hash raw serialized bytes); on the CODE_REVIEW grep-audit.
4. **`state_machine.ts:1493` same-depth sibling `done.state` raise-order — SUBSTANTIVE: capture actual raised-event order as ground truth + a regression pin on sibling done-event order.**

---

## Decision → UR → downstream-phase traceability

| ADR | Decision headline | URs | Downstream phase obligations |
|---|---|---|---|
| ADR-1 | EXCLUDE wall-clock from a closed content-only `TraceFrame`; normalize `'|'`-parts | UR-002, UR-004, UR-005 | TECH_SPEC: freeze `TraceFrame` + `errorClass` enum + `configHash` recipe. IMPLEMENT: `hashTrace`, region-order + AC-1 canary tests. CODE_REVIEW: grep-audit no `error.toJSON()`/`message` in `errorClass`. |
| ADR-2 | splitmix64/bigint, number facade, FROZEN 64-bit-salt label `fork()` + Lemire `int` | UR-002, UR-003, UR-004, UR-005 | TECH_SPEC: pin combine formula + fork golden vector. IMPLEMENT (step 1): `prng.ts` + golden/corpus-stability/snapshot-fork tests. |
| ADR-3 | Inject SimMonitor/SimErrorHandler/NoopLogger; capture via Adapter-write seam; content-only trace | UR-002, UR-003, UR-004, UR-005 | TECH_SPEC: freeze `errorClass` enum + `isEnabled()===true` header param. IMPLEMENT (step 2): DI classes + Adapter wrapper; AC-1 four-run canary. CODE_REVIEW: whole-package grep-audit. |
| ADR-4 | Single `settleMacrostep` converged primitive; `inFlightAsyncCount` settledness; budget=liveness finding | UR-002, UR-003, UR-004, UR-005 | IMPLEMENT (step 3): `settleMacrostep`; frame-count test; validate `maxTurns`/`healWindow` vs deepest scenario. CODE_REVIEW: grep for any second settle/flush. |
| ADR-5 | Seven-kind fault taxonomy on existing seams; plain `InjectedFault`; site-keyed jitter; transitionTimeout first-class; cond/string-method gaps | UR-002, UR-003, UR-005 | TECH_SPEC: `FaultPlan`/`FaultRecord`. IMPLEMENT (step 5): faults + `harness.ts` + `ObservableScheduler`; jitter+snapshot AC. REFLECT: cond/string-method gaps. |
| ADR-6 | Blind declarative Invariant registry + fire-boolean Liveness + first-violation-wins; 8th `corrupt-state` fault for I-6/I-10 | UR-002, UR-003, UR-004 | IMPLEMENT (step 6): I-1..I-12 + liveness + fairness; `corrupt-state` probe fault; restore-replay-to-self test. |
| ADR-7 | Separate `./sim` entry; `wire()`-from-config DI-first; behavioral scheduler probe; `@unstable`; dist byte guard | UR-002, UR-003, UR-005 | TECH_SPEC: wiring diff + `wire()` probe mechanism + tsconfig isolation feasibility. IMPLEMENT (step 10): packaging + dist byte guard. CODE_REVIEW: `'.'` zero-diff + dist bytes. |
| ADR-8 | Genuine closed-union `CapabilityRegistry` + errorClass-keyed trace-probes; honest mandatory-gate; key-set snapshot | UR-004, UR-005 | TECH_SPEC: freeze `SimTrace` shape. IMPLEMENT (step 9): registry + probes + gate CLI + key-set snapshot; resolve knip (3 classes). REFLECT: registry-scoped honesty. |

---

## Accepted risks & residual open questions

| # | Item | Decision / acceptance | Owner phase |
|---|---|---|---|
| OQ#1 | EXCLUDE transition duration vs virtualize | RATIFIED: EXCLUDE (ADR-1). Closed. | — (closed in CREATIVE) |
| OQ#6 | Number xorshift fast-path PRNG in v1? | DEFERRED (ADR-2): v1 ships splitmix64/bigint only; any fast-path is `header.prngVersion`-versioned. | REFLECT (revisit if perf proves bigint is the bottleneck) |
| **OQ#2** | Concrete perf baselines (events/sec floor, peak-heap ceiling) for `etc/sim-perf.baseline.json` | ACCEPTED RISK: requires a one-time measurement pass on the CI runner class; wide bands (throughput 20%, mem 25%, p99 30%), median-of-N=5, `traceLen` zero-tolerance. | **IMPLEMENT** (measurement pass) → REFLECT (record) |
| OQ#3 | `process.memoryUsage()` under tier-b deno/browser | ACCEPTED RISK: node-only runtime guard so the sim core stays portable; advisory downgrade if `--expose-gc` absent. | TECH_SPEC / IMPLEMENT |
| **OQ#4** | Add `IMonitor.recordHook?` vs owner-marker-only | DEFERRED (ADR-6/ADR-8): owner-marker-only for v1; `recordHook` would be a core ABI change. | REFLECT (v2 candidate behind an additive `@unstable` seam) |
| **OQ#5** | Catalog-completeness process gap (a novel engine branch is not forced to acquire a `CapabilityId`; id deletion shrinks a still-total union) | ACCEPTED RISK (ADR-8): closed by PR-template/CODE_REVIEW checklist + a committed `etc/sim-capabilities.txt` key-set snapshot; source-coverage (v8/AST) named as a deferred tooling-teeth option. REFLECT records coverage as "registry-scoped", not literally exhaustive. | **REFLECT** (honesty note) + CODE_REVIEW (key-set snapshot review) |
| RR-1 | Engine duplicated into `dist/sim` under `splitting:false` | ACCEPTED (ADR-7): empirically proven core `'.'` bytes unchanged; consumers pick one entrypoint. | IMPLEMENT (dist byte guard) |
| RR-2 | Sim type error blocks core build/tier-a (shared tsconfig) | TARGET: isolate sim tsconfig; FALLBACK: accept + document. | TECH_SPEC (feasibility) → IMPLEMENT |
| RR-3 | Cross-runtime microtask-order divergence | ACCEPTED (ADR-1/ADR-4): `header.runtime` pins the contract; corpus + replay scoped to one runtime. | REFLECT (documented scope) |
| RR-4 | v1 fault gaps: `invoke[].cond` throw + string-method-callback throw; hook/throw coverage scoped to function-valued callbacks | ACCEPTED (ADR-5): documented gaps; the gate must not falsely claim coverage. | REFLECT (honesty note) |
| RR-5 | Restore-bearing runs replay only to themselves (resumed-invoke internal→external routing asymmetry) | ACCEPTED (ADR-6): bit-exact replay scoped to a continuous run; I-7 whitelists post-restore external routing. | IMPLEMENT (restore-replay-to-self test) |
| RR-6 | `corrupt-state` is a harness-only probe fault (not a real consumer-reachable channel) | ACCEPTED (ADR-6): it is the sole input that drives the engine's own containment guards (`validateCompositeState`/`getCurrentState`); documented as a probe, not a wire-level fault channel. | REFLECT (documented) |

---

## DA-gate self-check (pre-empting likely `mb3-critic` CREATIVE-lens challenges)

- **Design integrity.** The three cross-ADR contradictions (capture inside `recordTransition` reading both `from`/`to`; "single determinism surface" vs Liveness's clock-jump; structural-predicate quiescence) are resolved into ONE coherent architecture: ONE capture seam (Adapter-write interception + harness-boundary outcome frames), ONE quiescence primitive (`settleMacrostep` with `inFlightAsyncCount` + policy-parameterized clock-jump), ONE PRNG with FROZEN combine, ONE canonical content-only trace, ONE first-violation-wins shrinker target. Every CRIT/HIGH adversarial hole is either folded into a decision (the majority) or recorded as an explicit accepted risk with an owner phase. No ADR contradicts another.

- **UR-goal traceability.** Every ADR maps to ≥1 UR (table above); UR-002 (real-engine bit-exact replay + faults + Safety/Liveness + shrinker + long-running CI) is served by ADR-1/2/3/4/5/6; UR-003 (dual tool + constructible) by ADR-2/5/6/7; UR-004 (cover-all + mandatory gate + declarative) by ADR-1/2/6/8; UR-005 (public `./sim` + ABI/bundle + perf thresholds + full fault set) by ADR-1/3/5/7/8. The full v1 fault set (UR-005.4: reorder/drop/dup, guard/action/callback throws, clock skew, timer jitter, queue overflow) is exactly ADR-5's taxonomy; the mandatory programmatic coverage gate is ADR-8; the perf regression thresholds are ADR-7/§4.7. "ALL functionality" is honestly scoped as registry-scoped (ADR-8 OQ#5/REFLECT), not falsely claimed as exhaustive.

- **Determinism soundness.** The hash is deterministic BY CONSTRUCTION (closed-allowlist `TraceFrame` that structurally cannot reference a wall-clock/timestamp/heap/error-id/serialized-byte field), backed by full DI neutralization (FRESH SimMonitor that never touches `MetricsCollector`; SimErrorHandler with no retry strategy; NoopLogger), `'|'`-normalization, and a frozen PRNG. The leak ledger is exhaustive for the grepped patterns and adds FOUR gaps beyond §5.1 — all folded into ADR-3, none dropped — the substantive one being the same-depth sibling `done.state` raise-order (`:1493`), neutralized by capturing actual raised-event order + a regression pin. The seed→hash contract is honestly scoped to one pinned runtime (`header.runtime`), not falsely promised cross-runtime. The AC-1 canary (action-throw + snapshot/restore, four runs fake×{on,off}) is the executable proof that no leak re-entered the hash, independent of vitest's Date fake.

- **API stability.** Zero core-engine source line is modified by any ADR; the intentional `:2047` `Date.now()` and the `security createdAt` hash stay unchanged (no TASK-013 decision overturned). The `'.'` exports key and `etc/statemachine.api.md` are byte-identical (empirically proven: a second `splitting:false` tsup entry leaves `dist/index.{js,cjs}` byte-identical and only duplicates the engine into `dist/sim`). The public `./sim` is a separate `@unstable` island with its own `etc/statemachine-sim.api.md` baseline; a NEW dist byte/hash guard closes the existence-only `verify-dist.cjs` gap. The scheduler-omission footgun is structurally eliminated on the sanctioned `wire()`-from-config path (the original infeasible private-field identity assertion is replaced) and behaviorally probed (with a sentinel for timer-less machines) on the best-effort path.
