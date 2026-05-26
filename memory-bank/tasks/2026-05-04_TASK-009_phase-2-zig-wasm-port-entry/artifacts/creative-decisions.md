# CREATIVE Decisions — TASK-009 (Phase 2 zig-wasm-port)

> **Phase**: CREATIVE → PLAN exit
> **Updated**: 2026-05-26 (TigerStyle re-pass + DA-REVISE r01 closure)
> **Lenses applied**:
> - **WIB** (Simplicity-of-Spread Routing Check from `mb3` skill) — every TD must (1) prefer existing primitive, (2) be the lightest form, (3) introduce new surface only when concrete limitation cited.
> - **TigerStyle** (UR-013, adopted 2026-05-26) — Safety > Performance > DX priority order; NASA Power of Ten; pair assertions; static memory; fail-fast on programmer errors.
> - **ZTB** (companion cross-lens for IMPLEMENT/QA/CODE_REVIEW) — registered in `CODING_RULES.md` §Methodology + `project-config.json.ztbLens`.
>
> **ZTB scope at CREATIVE (explicit, locked 2026-05-26)**: at this phase ZTB-General applies **advisorily** as a design-pattern lens — it catches design-time decisions destined for hot path (e.g., TD-T9-14 ring buffer was authored under TigerStyle §3.3 control/data plane). ZTB-Zig is **dormant** until TASK-010 produces the first `.zig` file. Downstream PLAN / TECH_SPEC DA gates inherit this scope decision; they do NOT re-litigate it unless an explicit operator amendment changes UR-013.
> **Companion artefacts**: `zig-016-release-notes.md`, `zig-016-phase2-impact.md`, `zig-016-stdlib-index.md`
> **Carry-forward inputs**: `grainjs-prod/packages/statemachine TASK-001/004/006` (cross-project links recorded in tasks-registry.jsonl)

---

## Operator-confirmed decisions

### 2026-05-04 (initial WIB pass)

1. **Dual consumer model** — Zig core must be reusable from BOTH TS host (via WASM bridge) AND other Zig projects (via Zig package manager). Single source, two builds.
2. **One machine = one memory block** — each StateMachine instance owns dedicated memory; no shared linear memory pool across instances.
3. **ABI versioning implemented manually** — explicit `getAbiVersion(): u32` export from Zig core; baseline = 1 (we are post-1.0.0-beta.1).
4. **TASK-017 added as 7th child** — Zig package publishing is a separate gate, not folded into TASK-010 toolchain.

### 2026-05-26 (TigerStyle re-pass)

5. **TigerStyle + ZTB methodology adopted** (UR-013) — Safety > Performance > DX is the canonical priority order for all library packages. ZTB cross-lens is active on every DA gate from this point forward.
6. **Zig opt-in via separate factory in separate package** (operator answer to Q1) — `useZigCore: true` constructor flag REJECTED. Replacement: `createMachineZig()` factory exported from a separate package `@vedmalex/statemachine-zig` (consumer A path). `createMachine()` signature in `@vedmalex/statemachine` remains unchanged from 1.0.0-beta.1 → UR-005 honoured strictly.
7. **UR-007 behavioural parity owned by TASK-014** (operator answer to Q2) — TASK-014 ABI-parity suite reruns the existing TS behavioural test suite against the Zig-backed factory (`createMachineZig`). Zig-side `std.testing` unit tests restored to **MUST** (no longer deferred) — they cover Zig core internals that the public ABI cannot reach.
8. **`wasmIntegrity` hash-pin REJECTED** — orthogonal to ABI semantics (catches content drift, not ABI breaks). `getAbiVersion()` is the sole authoritative ABI gate. npm `package-lock.json` sha512 already covers content integrity.
9. **`wasm32-wasi` test target dropped** — no filesystem-touching ABI fixtures exist; single target `wasm32-unknown-none` for production AND test builds (TigerStyle "minimum surface").
10. **Bundle budget locked at 250 KB total** (200 KB raw `.wasm` + 50 KB JS shim) — matches `zig-016-phase2-impact.md` empirical derivation (2× current 122 KB ESM). Inflated 350 KB figure rejected as undocumented drift.

---

## TD-T9-* — Final 13 CREATIVE decisions

### TD-T9-1: Dual-consumer hybrid model

**Resolves Q-T9-1** (single-package WASM vs hybrid).

**Decision**: Single Zig source `packages/statemachine-zig/src/state_machine.zig` produces TWO consumer-facing artefacts:

| Consumer | Use case | Build target | Distribution package |
|---|---|---|---|
| **A — TS host via WASM** | npm consumers who explicitly opt into Zig-backed core via `createMachineZig()` | `zig build -Dtarget=wasm32-unknown-none -Doptimize=ReleaseSafe` | new npm package **`@vedmalex/statemachine-zig`** (PENDING UR-011 availability check, see TASK-017); ships `.wasm` + `.d.ts` shim; depends on `@vedmalex/statemachine` for public types |
| **B — Zig direct** | Other Zig projects | `zig build` (native target chosen by consumer) | Zig package via `build.zig.zon` (PENDING UR-011 name decision — candidate `vedmalex/statemachine`; TASK-017 verifies registry availability before locking) |

**TS canonical path unchanged**: `@vedmalex/statemachine` `createMachine()` continues to return the TS-implemented StateMachine — UR-005 (stabilize current public API) honoured strictly. Operators who want the Zig-backed core import `createMachineZig` from `@vedmalex/statemachine-zig` explicitly. No flag, no API redesign in the canonical package.

**UR refs**: UR-003, UR-005, UR-009, UR-010, UR-011

**TigerStyle justification**: Separate factory in separate package is the **minimum-surface** form (TigerStyle §4.2 "simplify signatures": `void > bool > u64 > ?u64 > !u64`; adding constructor option grows return-type dimensionality and propagates `?Zig | TS` through every caller). Operator explicitly answered Q1=B on 2026-05-26.

**WIB justification**: TS surface already shipped (1.0.0-beta.1). New surface is **only the Zig package** and **only the `createMachineZig` symbol** — no edits to `createMachine()` signature. Two distribution channels required by the dual-consumer requirement; simpler form (single channel) would force consumer B to depend on JS toolchain — concrete limitation.

**PENDING UR-011**: Both package names (`@vedmalex/statemachine-zig` for npm, and final Zig-package slug) require `npm view`/registry availability checks + operator confirmation before TASK-017 publishes. TASK-017 owns the verification and may amend names with operator approval.

---

### TD-T9-2: Zig 0.16.0 stable

**Resolves Q-T9-2**.

**Decision**: pin `0.16.0` exact in `build.zig.zon` and CI workflows. No nightly dependency.

**Rationale** (from `zig-016-phase2-impact.md`):
- Released stable; ships with macOS 13.0+ / Win 10 / Linux 5.10+ (covers UR-006 runtime tier targets).
- `heap.ArenaAllocator` lock-free + thread-safe — directly enables TD-T9-13.
- `std.Io` interface — mirrors our IMonitor/ITimerScheduler pattern.
- `std.debug` rework with safe unwinding — closes Q-T9-6 without bespoke trace mapping.
- LLVM 21 backend; native CI for new BSD/aarch64/loongarch targets — improves R-T9-8 platform coverage.

**UR refs**: UR-006, UR-008, UR-009

**WIB justification**: Stable point release; minimal version surface (single tag, no nightly rolling).

---

### TD-T9-3: WASM target = `wasm32-unknown-none` (single target for prod + test)

**Resolves Q-T9-3**.

**Decision**:
- **Core production build (consumer A)**: `wasm32-unknown-none` — no WASI runtime requirement, smallest bundle, universal across hosts.
- **Test/CI build (consumer A)**: same `wasm32-unknown-none` target. The 7 ABI tests (`packages/statemachine/src/tests/abi/*.abi.test.ts`) are pure type/structural conformance — none touch the filesystem. No second WASM target is justified.
- **Native build (consumer B)**: target chosen by consumer (`x86_64-linux`, `aarch64-darwin`, `wasm32-*`, etc. — not our concern).
- **NOT `wasm32-wasi`** — was previously listed for "filesystem fixtures" that do not exist; if a future TASK introduces fs-touching ABI fixtures (e.g., persistence adapter round-trip via `std.Io.File`), this decision is revisited and the fixture is named explicitly in that task's `_task.md`.
- **NOT `wasm32-emscripten`** — adds runtime overhead and breaks UR-006 portability.

**UR refs**: UR-006, UR-009

**TigerStyle justification**: "Положи лимит на всё" + "minimum surface" — one build target until a concrete fixture demands the second. CI matrix shrinks; bundle artefact surface shrinks; reasoning surface shrinks.

**WIB justification**: Core uses no fs/proc/net at runtime — pure computation. WASI is new surface (host runtime requirement) without evidence.

---

### TD-T9-4: Memory ownership — one machine = one memory block

**Resolves Q-T9-4 (memory model — ownership boundary only).**

**Decision**:

| Consumer | Memory ownership |
|---|---|
| **A (WASM via TS host)** | Each `createMachineZig()` (consumer A entry from `@vedmalex/statemachine-zig`) instantiates a fresh `WebAssembly.Instance` with its own linear memory (own `WebAssembly.Memory`). `dispose()` discards the Instance. **No memory sharing across StateMachine instances.** |
| **B (Zig direct)** | `StateMachine.init(allocator: std.mem.Allocator)` accepts caller-provided allocator. Lifetime of the allocator is the consumer's responsibility — StateMachine never frees the outer allocator, only its own arena (see TD-T9-13). |

**Per-instance overhead** (consumer A only): ~5–50 ms instantiate cost, ~64 KB minimum linear memory per Instance. Recorded as part of TD-T9-7 size budget mitigation; multi-tenant deployments document the per-tenant Instance pattern (R-T9-9 closure).

**UR refs**: UR-006, UR-009

**TigerStyle justification**: TigerStyle §2.5 «статическая память после init» — the WebAssembly.Instance's linear memory is sized at instantiate; no growth after init. Per-Instance isolation is the **minimum** safety boundary (one bad machine cannot corrupt another). R-T9-9 (multi-tenant isolation) closes by construction.

**WIB justification**: Per-Instance memory + caller-allocator pattern is the lightest form — no carving logic, no concurrent allocator sharing.

---

### TD-T9-13: Allocator strategy inside the ownership boundary

**Resolves Q-T9-13 (allocator strategy — split back from TD-T9-4 per F-CRE-C1-12).**

**Decision**:

| Consumer | Inner allocator strategy |
|---|---|
| **A (WASM via TS host)** | Inside the per-Instance linear memory, use `std.heap.wasm_allocator` (Zig 0.16 standard for `wasm32-unknown-none` builds) as the page-level backing. On top of it, `std.heap.ArenaAllocator(wasm_allocator)` carries all transient StateMachine allocations; `dispose()` calls `arena.deinit()` (bulk free). |
| **B (Zig direct)** | Inside StateMachine, wrap the caller-provided `allocator` in `std.heap.ArenaAllocator(allocator)` for the lifetime of the StateMachine. `dispose()` calls `arena.deinit()` — only StateMachine-owned allocations are freed; the outer allocator is untouched. |

**Why ArenaAllocator (both consumers):**
- TigerStyle §2.5 «hot path без аллокаций» — long-lived per-machine allocations happen at `init`; tick/transition path uses pre-allocated slots (TD-T9-14 ring buffer covers IMonitor batching).
- Bulk free on `dispose()` is the simplest correct lifetime model: no per-object free, no use-after-free, no double-free.
- Zig 0.16 `ArenaAllocator` is **lock-free + thread-safe** — free safety net if consumer code accidentally shares one StateMachine across threads.

**Why NOT alternatives:**
- `GeneralPurposeAllocator` — incompatible with simple WASM linear-memory model + heavier per-alloc overhead.
- `FixedBufferAllocator` standalone (without arena on top) — no free, even bulk; cannot dispose intermediate scratch.
- `std.heap.ThreadSafeAllocator` — REMOVED in Zig 0.16 (was an anti-pattern).

**UR refs**: UR-006, UR-009

**TigerStyle justification**: ArenaAllocator + bulk-reset on dispose collapses the lifetime model to a single dimension (machine alive vs machine disposed) — TigerStyle §4.2 "fewer dimensions in return/state types". `comptime assert(@sizeOf(StateMachine) <= max_machine_bytes)` (limit value TBD in TASK-011) becomes the budget gate; "положи лимит на всё".

**WIB justification**: Single allocator strategy across both consumers — minimum surface. Per-tenant isolation already given by TD-T9-4 ownership boundary; inner allocator does not need extra concurrency machinery.

---

### TD-T9-5: ITimerScheduler shim into JS callbacks (no native timer-wheel)

**Resolves Q-T9-5**.

**Decision**:
- **Consumer A (WASM)**: Zig core exports `tick(now_ms: u64) -> u32` (returns next-fire-deadline-ms or 0). JS host owns `setTimeout`/`setInterval` and calls `tick()` on schedule. JS host implements existing `ITimerScheduler` interface from Phase-1 EP catalog.
- **Consumer B (Zig direct)**: same `tick()` Zig function; consumer provides their own `ITimerScheduler`-equivalent Zig-native interface (or uses `std.Io.Timestamp`).

No Zig-native timer-wheel inside the core.

**UR refs**: UR-009, UR-010

**WIB justification**: ITimerScheduler is **existing Phase-1 primitive**; we reuse, not extend. Native timer-wheel = new surface without evidence (host already has scheduler).

---

### TD-T9-6: DWARF debug info via `.debug.wasm`

**Resolves Q-T9-6**.

**Decision**:
- TASK-010 build pipeline: dev builds emit `.debug.wasm` with DWARF (`-fno-strip-debug-info`); production builds strip.
- Browsers/Node DevTools consume DWARF natively (Chrome DevTools Protocol; Node `--inspect`).
- No JS-side trace mapping layer.

**UR refs**: UR-007

**WIB justification**: Zig 0.16 emits DWARF natively; modern hosts consume it without bridge. Adding JS-side mapping = new surface with no concrete failure of native path.

---

### TD-T9-7: Bundle size ratchet (mirrors api-extractor pattern)

**Resolves Q-T9-7**.

**Decision**:
- After TASK-010 produces first stable `.wasm`, record baseline size into `packages/statemachine-zig/etc/wasm-size.txt` (exact filename and location finalized in TASK-010 PLAN).
- CI fail at `>150% of baseline` — same ratchet philosophy as `etc/statemachine.api.md` from TASK-006.
- **Hard budget: ≤200 KB raw `.wasm` + ≤50 KB JS shim = ≤250 KB total** (2× the current 122 KB ESM bundle; derived empirically in `zig-016-phase2-impact.md` Q-T9-7 + R-T9-3).
- If first stable build exceeds 250 KB, TASK-010 raises a CREATIVE re-evaluation gate (not a silent rebaseline).
- Per-instance memory overhead (~64 KB) is **runtime memory**, not bundle; documented separately in `STABILITY.md` §"Runtime cost notes".

**UR refs**: UR-006, UR-007

**TigerStyle justification**: «положи лимит на всё» (TigerStyle §2.2). Named upper-bound constants + fail-fast (CI gate) on breach. Tighter limit wins over loose limit; the 350 KB figure that previously appeared here was an undocumented inflation and is rejected.

**WIB justification**: Existing pattern from TASK-006 (api-extractor surface ratchet) — reuse. New surface = bundle-size measurement script; minimal (one bash + one txt file).

---

### TD-T9-8: One universal `.wasm` + 3-line per-host JS loader

**Resolves Q-T9-8**.

**Decision**:
- **Single `.wasm` artefact** — works on Bun, Node 20+, Browser, Deno/Edge.
- **Per-host JS loader** — 3-4 lines each:
  - **Browser**: `WebAssembly.instantiateStreaming(fetch('statemachine.wasm'), imports)`.
  - **Node**: `WebAssembly.compile(await readFile('statemachine.wasm')); WebAssembly.instantiate(module, imports)`.
  - **Deno**: `WebAssembly.instantiateStreaming(fetch(import.meta.resolve('./statemachine.wasm')), imports)`.

No runtime feature detection; package.json `exports` field gives correct path per host.

**UR refs**: UR-006

**WIB justification**: WASM binary already universal — minimum form. Per-host detection logic = unnecessary surface.

---

### TD-T9-9: TS canonical for Phase 2; Zig opt-in via separate package

**Resolves Q-T9-9.** **Reformulated 2026-05-26 per operator answer Q1=B (TigerStyle re-pass).**

**Decision**:
- For 1.0.0-beta.x and 1.0.0-stable: `@vedmalex/statemachine` `createMachine()` continues to return the TS implementation. **Signature unchanged from 1.0.0-beta.1** — no new constructor option, no flag, no API redesign. UR-005 honoured strictly.
- Zig-backed core is consumed via the **separate package** `@vedmalex/statemachine-zig` exporting `createMachineZig()` with a signature compatible with `createMachine()` (same `StateMachineConfig`, same return type — `StateMachine`). Opt-in happens at the **import boundary**, not at the call site.
- Zig core MUST pass the existing 7 ABI tests (consumer A WASM build) + behavioural parity via the rerun TS test suite (TASK-014, see TD-T9-10).
- Phase 3 (or Phase 4) re-evaluates whether `@vedmalex/statemachine` should re-export `createMachineZig` or whether the two packages remain physically separate.

**UR refs**: UR-003, UR-005, UR-009

**TigerStyle justification (operator-validated 2026-05-26)**: TigerStyle §4.2 "simplify signatures" + "fewer dimensions in return/state types". A constructor flag (`useZigCore: true`) would have inserted a `TS | Zig` dimension into every code path inside `createMachine` and every downstream test asserting on `StateMachine` shape. Separate factory in separate package removes the dimension entirely — `createMachine` and `createMachineZig` each have a single, knowable backing implementation, and the opt-in is recorded in `package.json` dependency lists (auditable, reviewable, version-pinnable).

**WIB justification**: UR-005 explicitly disallows API redesign in current cycle. Adding a flag = additive API change inside the same cycle. Separate package = zero edits to the canonical package's public surface.

---

### TD-T9-10: ABI parity + behavioural parity + Zig-side unit tests — all MUST

**Resolves Q-T9-10.** **Reformulated 2026-05-26 per operator answer Q2=C (TigerStyle re-pass).**

**Decision** — three test layers, all MUST for TASK-014 closure:

1. **Structural ABI parity (TASK-014a)** — all 7 existing ABI conformance tests (`src/tests/abi/*.abi.test.ts`) rerun against the WASM build (consumer A). Verifies shape: IMonitor, ITimerScheduler, IErrorHandler, ILogger, Adapter, StatePersistenceAdapter, validate-config. This is the same suite Phase 1 uses.
2. **Behavioural parity (TASK-014b)** — the **full existing TS behavioural test suite** of `packages/statemachine/` is rerun with `createMachine` symbol-swapped for `createMachineZig` (consumer A path through `@vedmalex/statemachine-zig`). Mechanism: a test-harness file that re-exports `createMachineZig as createMachine` and re-runs every `*.test.ts` that imports from `@vedmalex/statemachine`. Behavioural parity = both factories produce semantically identical StateMachine instances under the existing test suite.
3. **Zig-side unit tests (TASK-014c)** — `std.testing` unit tests covering Zig-core internals that the public ABI cannot exercise (allocator wiring, comptime invariants, packed-struct layout, error-set membership, transition machinery edge cases). Restored to **MUST** status (previously deferred); part of UR-007 90% coverage budget for the Zig path.

Consumer B (Zig-direct path) uses TASK-014c unit tests directly + its own ABI bindings to confirm public Zig surface matches the WASM surface.

**UR refs**: UR-007, UR-009

**TigerStyle justification (operator-validated 2026-05-26)**:
- TigerStyle §2.9 «92% катастроф из необработанных ошибок + тестируйте error handlers + fault injection» — exempting the WASM path from UR-007 (the option A we rejected) would have left a class of bugs untestable.
- TigerStyle pair-assertions philosophy — behavioural parity is a "pair assertion" at the test-suite level: two implementations checked against the same contract; drift surfaces as test failure.
- Zig-side unit tests are the only way to reach comptime invariants (`@sizeOf`, `@bitSizeOf`, packed-struct alignment) that public ABI tests cannot observe.

**WIB justification**: Layer (1) is existing primitive; layer (2) reuses existing TS test suite (no new test surface, only a different import); layer (3) is new but unavoidable — Zig comptime invariants live below the public surface. Minimum-surface achieved by re-binding existing tests, not by writing parallel suites.

---

### TD-T9-11: Manual ABI versioning via `getAbiVersion(): u32` export

**Resolves Q-T9-11.** **Restored from advisory after operator confirmation.**

**Decision**:
- Zig core exports `pub export fn getAbiVersion() callconv(.C) u32` — returns build-time integer baked from `build.zig.zon` (comptime constant).
- **ABI baseline version = `1`** (we are post-1.0.0-beta.1; public ABI starts now).
- ABI version bumped on any breaking change to:
  - public exported function signatures (parameters, return type, calling convention),
  - public struct/union/enum layout (field order, field types, enum discriminant semantics, tag value reassignment),
  - public error set membership (adding errors is non-breaking; removing is breaking).
- Patch refactors (renames of internal symbols, comments, internal-impl changes) do NOT bump.

**Per-consumer enforcement**:

| Consumer | Mechanism |
|---|---|
| **A (WASM)** | JS host throws on instantiate if `instance.exports.getAbiVersion() !== EXPECTED_ABI_VERSION` (compiled into `.d.ts` shim of `@vedmalex/statemachine-zig`). Pair-assertion: the same check is mirrored Zig-side at module init (`comptime assert(abi_version == 1)`). |
| **B (Zig direct)** | `comptime if (statemachine.abi_version != EXPECTED) @compileError("ABI mismatch — expected " ++ ... ++ ", got " ++ ...)`. |
| **Content integrity** | npm `package-lock.json` sha512 already covers tarball content drift; no additional `wasmIntegrity` field. |

**`wasmIntegrity` hash-pin REJECTED (operator-confirmed 2026-05-26)**:
- The field would catch content drift (right bytes shipped) but NOT ABI semantics (right shape promised). These are orthogonal concerns.
- npm tarball sha512 in `package-lock.json` already handles content drift for consumer A; Zig package hashes in `build.zig.zon` handle it for consumer B.
- Adding `wasmIntegrity` would create two version surfaces (`abi_version` and `wasmIntegrity`) with overlapping intent — TigerStyle §4.2 "fewer dimensions" violated.

**UR refs**: UR-005, UR-007, UR-009

**TigerStyle justification**: TigerStyle §2.3 pair assertions — `getAbiVersion()` checked at both writer (Zig comptime) and reader (JS host instantiate), with matching `comptime assert` Zig-side. Fail-fast at instantiate (TigerStyle §2.4: programmer-error path → crash, not retry).

**WIB justification**: Compiler/loader checks alone catch only structural mismatch (LinkError). They do NOT catch semantic ABI breaks (renamed fields, reordered params, reassigned enum tags, drift between npm and Zig package versions). `getAbiVersion()` is the **minimum** explicit surface that fails fast at instantiate; alternative (no manual versioning) leaves silent ABI drift between dual consumers — concrete limitation cited.

---

### TD-T9-12: Trap → IErrorHandler.fatal + re-instantiate Instance

**Resolves Q-T9-12**.

**Decision**:
- WebAssembly trap surfaces in JS as `RuntimeError`.
- JS host (inside `@vedmalex/statemachine-zig`) catches `RuntimeError`, calls `IErrorHandler.fatal(error: 'wasm_trap', ctx: ...)`.
- After fatal: WASM Instance is **discarded** (memory state undefined post-trap per WebAssembly spec). Subsequent `createMachineZig()` call instantiates a fresh Instance — `createMachine()` from the canonical `@vedmalex/statemachine` package returns the TS implementation and is unaffected by this path.
- No "soft restart" protocol that reuses post-trap Instance.

For consumer B (Zig direct):
- Zig `@panic` propagates through normal error handling (`error.X` or stack unwind via `std.debug.captureCurrentStackTrace`).
- Consumer-provided `IErrorHandler`-equivalent receives stack trace; consumer decides retry/discard.

Document this in `STABILITY.md` (added section "Fatal error semantics").

**UR refs**: UR-007, UR-009

**WIB justification**: `IErrorHandler` is existing Phase-1 primitive — reuse. Discard-and-reinstantiate is the WebAssembly-spec-mandated minimum; soft-restart = new surface without evidence.

---

### TD-T9-14: IMonitor batching ring buffer (control-plane / data-plane split)

**Added 2026-05-26 per F-CRE-C1-9 + TigerStyle re-pass.**

**Problem**: Without batching, every `IMonitor.recordTransition(event)` call would cross the WASM↔JS FFI boundary on every transition — that is per-transition FFI cost, violating R-T9-2's mitigation claim and TigerStyle §3.3 control-plane / data-plane separation.

**Decision**:
- Zig core owns a **fixed-capacity ring buffer** in its arena (`MonitorEvent` records, capacity `max_pending_monitor_events`; default value finalized in TASK-013 PLAN, candidate 1024).
- `recordTransition()` on the Zig side **never crosses the FFI boundary** — it writes into the ring buffer (O(1), zero-allocation in hot path; TigerStyle §3.3 data plane is branch-free).
- The ring buffer is **flushed via a Zig-package-local interface `IZigMonitor` (extends `IMonitor`)** in three explicit cases:
  1. `tick()` boundary — once per fire, drain all queued events.
  2. Explicit `flush()` call from the JS host (e.g., before `dispose()`).
  3. Ring buffer reaches `max_pending_monitor_events` — backpressure path emits operating error `error.MonitorRingBufferFull` to the JS host (NOT an assert; ring full is an operating event under sustained burst — see TigerStyle §2.4).
- Comptime invariants (TASK-013): `comptime assert(@sizeOf(MonitorEvent) <= 64)`; `comptime assert(max_pending_monitor_events > config.pipelining_max)` (ring must outpace pipelining).
- Consumer B (Zig direct) uses the same ring buffer; the Zig consumer's `IZigMonitor`-equivalent receives a slice on flush.

**IMonitor surface scoping (UR-005 critical)**: the `flush(events: []const MonitorEvent)` method lives on **`IZigMonitor` exported only from `@vedmalex/statemachine-zig`** — `IZigMonitor extends IMonitor` and adds `flush()` as a `@public` member of the new package's surface. The canonical `@vedmalex/statemachine` `IMonitor` interface (4 members: `getMetrics?`, `recordError`, `recordEvent?`, `recordTransition`) is **unchanged from 1.0.0-beta.1** — no new optional method, no signature drift. UR-005 honoured strictly: only the Zig-opt-in package gains the batching surface; TS-canonical callers see no API change. This mirrors the Q1=B reformulation pattern (Zig-only surface lives in the Zig-only package).

**UR refs**: UR-009, UR-010

**TigerStyle justification (primary driver)**:
- §3.3 control plane vs data plane — `recordTransition` runs per-transition (data plane, hot path); flush runs per-tick (control plane, cold path). Per-event ассерты amortize across the batch.
- §3.4 push-fors-down — `IMonitor.flush(events: []const MonitorEvent)` batches one FFI crossing per N events instead of N crossings.
- §2.5 static memory — ring buffer capacity locked at `init`; no `alloc` in transition path.
- §2.3 pair assertion — ring write checks `assert(write_index < capacity)`; ring read on flush checks `assert(read_count <= write_count)`.

**WIB justification**: Existing primitive (Phase 1 `IMonitor` interface) — reuse. New surface = ring buffer (one struct + 4 functions: `init`, `push`, `flush`, `deinit`). Minimum form; "batch is cheaper than per-event" is the concrete limitation that justifies the surface.

**Closes**: R-T9-2 (FFI cost) properly — TD-T9-5 alone (timer scheduling) does NOT close per-transition FFI; TD-T9-14 does.

---

## UR Coverage Matrix

| UR | Carry-forward / local | Driving TD | Status |
|---|---|---|---|
| UR-001 | carry-forward | — | SATISFIED by Phase 1 |
| UR-002 | carry-forward | — | SATISFIED by Phase 1 (TS standalone library shipped 1.0.0-beta.1) |
| UR-003 | carry-forward | TD-T9-1 (separate `@vedmalex/statemachine-zig` package) | COVERED |
| UR-004 | carry-forward | — | SATISFIED by Phase 1 |
| UR-005 | carry-forward | TD-T9-9 (Zig opt-in via separate package; `createMachine()` signature unchanged), TD-T9-11 (ABI versioning) | COVERED — UR-005 honoured strictly via separate factory in separate package |
| UR-006 | carry-forward | TD-T9-2, TD-T9-3, TD-T9-7, TD-T9-8 | COVERED — multi-runtime support architected |
| UR-007 | carry-forward | TD-T9-6, TD-T9-10 (three test layers all MUST), TD-T9-11, TD-T9-12, TD-T9-14 (ring buffer comptime invariants) | COVERED — behavioural parity via test-suite swap + Zig `std.testing` unit MUST + ABI parity tests |
| UR-008 | carry-forward | TD-T9-2 + R-T9-8 closure | COVERED — Zig 0.16.0 in CI matrix |
| UR-009 | carry-forward | **PRIMARY DRIVER** for ALL TD-T9-* | COVERED — Phase 2 zig-wasm-port |
| UR-010 | carry-forward | TD-T9-1, TD-T9-5, TD-T9-14 (IMonitor batching reuses Phase-1 IMonitor contract) | COVERED — EP catalog preserved |
| UR-011 | carry-forward | TASK-017 (Zig package publishing) — TD-T9-1 carries `PENDING UR-011` marker on both npm and Zig package names | PARTIAL — final verification owned by TASK-017 |
| UR-012 | local | All TD-T9-* | COVERED — Phase 2 entry decomposition complete |
| UR-013 | local (2026-05-26) | TigerStyle + ZTB lens applied across all 14 TD-T9-*; registered in `CODING_RULES.md` §Methodology + `project-config.json.ztbLens` | COVERED — methodology adopted, all TD-T9-* re-evaluated through Safety > Perf > DX priority order |

---

## Updated Child-task DAG

```
TASK-010 Zig toolchain + WASM build pipeline (A)
  └── TASK-011 Core types port (B)
        ├── TASK-012 StateMachine class core port (C) ──┐
        │                                               │
        └── TASK-013 EP shims (D) ──────────────────────┤
                                                        │
              TASK-014 ABI parity tests (E) ◄──────────┘   (E waits for both C and D)
                └── TASK-015 Multi-runtime smoke (F)
                      └── TASK-016 Bundle + perf (G)
                            └── TASK-017 Zig package publishing (H)
```

**TASK-017** added as 7th child — Zig package publishing gate, sequential after TASK-016 (so size+perf measured before public release).

| Task | Tier | Scope (revised per CREATIVE 2026-05-26) | Notes |
|---|---|---|---|
| TASK-010 | T3:moderate | Install Zig 0.16.0; scaffold `packages/statemachine-zig/`; `build.zig.zon` + `build.zig` producing **single `wasm32-unknown-none` target** for both prod and test + native targets; smoke-build hello-world WASM. | TD-T9-2, TD-T9-3 |
| TASK-011 | T3:moderate | Port `@stable` types as Zig structs (StateMachineConfig, Transition, State); design FFI representation respecting Zig 0.16 packed-struct restrictions; export `abi_version` constant; `comptime assert(@sizeOf(StateMachineConfig) == N)` for all wire-format structs (TigerStyle §Z4). | TD-T9-1, TD-T9-11 |
| TASK-012 | **T4:large baseline** — escalates to **T5:epic** if PLAN finds ANY of: (a) Zig port exceeds 700 lines (~10× 70-line cap); (b) ≥2 distinct concurrency patterns required in one file (flat + nested + parallel + adapter); (c) PLAN cannot author the full task plan in a single document of ≤ ~400 lines. On escalation: decompose into TASK-012a (flat core + transition machinery), TASK-012b (nested/parallel state regions), TASK-012c (adapter integration). | Port StateMachine class core. | TD-T9-4, TD-T9-13, TD-T9-14 |
| TASK-013 | T3:moderate | EP shims: JS host implements IMonitor/ITimerScheduler/IErrorHandler; Zig core exports `tick()`, **ring buffer + `flush()` for IMonitor batching (TD-T9-14)**, `fatal()` error reporting. Consumer B uses Zig-native interfaces. | TD-T9-5, TD-T9-12, TD-T9-14 |
| TASK-014 | T3:moderate | Three layers all MUST: **a** structural ABI parity (7 existing ABI tests against WASM); **b** behavioural parity (rerun full TS test suite with `createMachine` symbol-swapped for `createMachineZig`); **c** Zig-side `std.testing` unit tests for comptime invariants + transition machinery internals. | TD-T9-10 |
| TASK-015 | T2:quick | Extend Tier B CI: WASM smoke under Bun, Node 20+, Browser (Safari iOS via BrowserStack), Deno/Edge. Verify Zig toolchain on macOS-ARM, Linux-x64, Windows. | TD-T9-3, TD-T9-8, R-T9-8 |
| TASK-016 | T2:quick | Bundle-size ratchet (`packages/statemachine-zig/etc/wasm-size.txt` baseline; **hard budget 250 KB total**; 150% baseline ratchet on top); perf microbenchmark vs TS implementation. | TD-T9-7 |
| TASK-017 | T3:moderate | Publish `@vedmalex/statemachine-zig` to npm + publish Zig package to `build.zig.zon` registry/git tag; **verify both names via `npm view` and registry checks per UR-011 BEFORE first publish**; semver-align with npm `@vedmalex/statemachine`; document Zig consumer onboarding in README. | UR-011, TD-T9-1 |

---

## Risks (R-T9-1..R-T9-9) — closure status

| Risk | TD owner / mitigation |
|---|---|
| R-T9-1 (Zig version pinning) | TD-T9-2 — pinned 0.16.0 exact. |
| R-T9-2 (FFI cost) | **TD-T9-14 (primary)** + TD-T9-5 — IMonitor ring buffer batches per-transition events; `tick()` boundary flushes once per fire; no per-transition FFI crossing. R-T9-2 was previously closed against TD-T9-5 alone, which did not author the batching; TD-T9-14 closes it properly. |
| R-T9-3 (Bundle size 2-3×) | TD-T9-7 — hard budget 250 KB total + ratchet; if exceeded, CREATIVE re-evaluation gate (not silent rebaseline). |
| R-T9-4 (Debugging UX) | TD-T9-6 — DWARF native; Zig 0.16 safe unwinding. |
| R-T9-5 (Maintenance burden dual TS+Zig) | TD-T9-9 — TS canonical, Zig opt-in via separate package; Phase 3 reconsiders. |
| R-T9-6 (Browser compat) | TD-T9-8 — single universal `.wasm`; TASK-015 multi-runtime smoke verifies. |
| R-T9-7 (Zig std/compiler-rt licensing) | TASK-010 verifies and adds attribution to LICENSE/THIRD_PARTY_LICENSES.md if compiler-rt code embedded. |
| R-T9-8 (CI/CD platform) | TASK-010, TASK-015 — `setup-zig@v1` action, `actions/cache`, pinned 0.16.0 across matrix. |
| R-T9-9 (multi-tenant isolation) | TD-T9-4 (ownership boundary) + TD-T9-13 (allocator strategy) — per-Instance memory isolation by construction; documented in STABILITY.md. |

---

## CREATIVE Acceptance Criteria — closure status

Per `context.md` "Acceptance Criteria for TASK-009":

| AC | Status |
|---|---|
| 1. CREATIVE outputs program-level decisions for Q-T9-1..13 | ✅ — all 13 TD-T9-* + TD-T9-14 (added 2026-05-26) recorded above |
| 2. PLAN locks child-task DAG with tiers + dep direction | ⏳ next phase (PLAN owns); TASK-012 escalation trigger now explicit |
| 3. Risk register v1 covers R-T9-1..9 | ✅ — closure table above; R-T9-2 retied to TD-T9-14 |
| 4. taskDecompose function gate cleared by mb3-critic | ⏳ deferred to PLAN exit (function gate after CREATIVE/PLAN) |
| 5. Orchestration packet updated with final child set | ✅ — `orchestration-packet.md` includes TASK-017 + TASK-012 escalation trigger |
| 6. All 13 UR mapped to satisfied or covered | ✅ — UR Coverage Matrix above (incl. UR-013 TigerStyle adoption) |
| 7. TASK-009 ARCHIVE only after operator approves orchestration packet | ⏳ — operator pending after taskDecompose gate |

---

## Next gate: CREATIVE → PLAN

CREATIVE → PLAN is a **DA-gated phase exit**. Required:
1. Run `Agent(subagent_type="mb3-critic")` in `workflow_gate` mode, lens "Design Integrity".
2. Envelope: `mb3-critic.review/v2`. Required fields: `schema, verdict, lens, task_id, phase, ur_traceability, findings`. NO `report_markdown`/`rendered_markdown`/`date`.
3. On `verdict=PROCEED` → `mb3_phase(action="transition", params={to:"PLAN"})`.
4. PLAN authors:
   - locked TASK-010..017 DAG with finalized tiers (especially TASK-012 T4 vs T5),
   - `plan.md` artefact per task,
   - taskDecompose function gate runs at PLAN exit.

Operator may also choose **session checkpoint** before DA gate to keep context fresh.
