# CREATIVE Decisions — TASK-009 (Phase 2 zig-wasm-port)

> **Phase**: CREATIVE → PLAN exit
> **Updated**: 2026-05-04
> **WIB lens applied**: Simplicity-of-Spread Routing Check from `mb3` skill — every TD must (1) prefer existing primitive, (2) be the lightest form, (3) introduce new surface only when concrete limitation cited.
> **Companion artefacts**: `zig-016-release-notes.md`, `zig-016-phase2-impact.md`, `zig-016-stdlib-index.md`
> **Carry-forward inputs**: `grainjs-prod/packages/statemachine TASK-001/004/006` (cross-project links recorded in tasks-registry.jsonl)

---

## Operator-confirmed decisions (2026-05-04)

Three structural decisions confirmed by operator after WIB-review iteration:

1. **Dual consumer model** — Zig core must be reusable from BOTH TS host (via WASM bridge) AND other Zig projects (via Zig package manager). Single source, two builds.
2. **One machine = one memory block** — each StateMachine instance owns dedicated memory; no shared linear memory pool across instances.
3. **ABI versioning implemented manually** — explicit `getAbiVersion(): u32` export from Zig core; baseline = 1 (we are post-1.0.0-beta.1).
4. **TASK-017 added as 7th child** — Zig package publishing is a separate gate, not folded into TASK-010 toolchain.

---

## TD-T9-* — Final 13 CREATIVE decisions

### TD-T9-1: Dual-consumer hybrid model

**Resolves Q-T9-1** (single-package WASM vs hybrid).

**Decision**: Single Zig source `lib/state_machine.zig` produces TWO consumer-facing artefacts:

| Consumer | Use case | Build target | Distribution |
|---|---|---|---|
| **A — TS host via WASM** | npm consumers; existing JS surface preserved | `zig build -Dtarget=wasm32-unknown-none -Doptimize=ReleaseSafe` | npm tarball `@vedmalex/statemachine` ships `.wasm` + `.d.ts` shim |
| **B — Zig direct** | Other Zig projects | `zig build` (native target chosen by consumer) | Zig package via `build.zig.zon` (e.g. git tag on `vedmalex/statemachine`) |

TS host (consumer A) is **default**; Zig core is **opt-in via `useZigCore: true` flag** in `createMachine()` for Phase 2. Phase 3+ may consider promoting Zig to default.

**UR refs**: UR-005, UR-009, UR-010

**WIB justification**: TS surface already shipped (1.0.0-beta.1). New surface is the Zig core; its evidence is **WASM portability + Zig consumer reuse (UR-009)** which existing TS primitive cannot deliver. Two distribution channels required by the dual-consumer requirement; simpler form (single channel) would force consumer B to depend on JS toolchain — concrete limitation.

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

### TD-T9-3: WASM target = `wasm32-unknown-none`

**Resolves Q-T9-3**.

**Decision**:
- **Core production build (consumer A)**: `wasm32-unknown-none` — no WASI runtime requirement, smallest bundle, universal across hosts.
- **Test/CI build (consumer A)**: `wasm32-wasi` separately — needed only for filesystem fixtures during ABI parity tests.
- **Native build (consumer B)**: target chosen by consumer (`x86_64-linux`, `aarch64-darwin`, `wasm32-*`, etc. — not our concern).
- **NOT `wasm32-emscripten`** — adds runtime overhead and breaks UR-006 portability.

**UR refs**: UR-006, UR-009

**WIB justification**: Core uses no fs/proc/net at runtime — pure computation. WASI is new surface (host runtime requirement) without evidence at runtime; tests only touch it as separate build target.

---

### TD-T9-4 / TD-T9-13: One machine = one memory block

**Unifies Q-T9-4 (memory model) and Q-T9-13 (allocator strategy).**

**Decision**:

| Consumer | Implementation |
|---|---|
| **A (WASM via TS host)** | Each `createMachine()` instantiates a fresh `WebAssembly.Instance` with its own linear memory (own `WebAssembly.Memory`). `dispose()` discards the Instance. **No memory sharing across StateMachine instances.** |
| **B (Zig direct)** | `StateMachine.init(allocator: std.mem.Allocator)` accepts caller-provided allocator. Inside, the StateMachine creates its own `std.heap.ArenaAllocator(allocator)` for its lifetime. `dispose()` calls `arena.deinit()` — bulk free, no leaks. |

**Per-instance overhead** (consumer A only): ~5-50ms instantiate cost, ~64KB minimum linear memory per Instance. Recorded as part of TD-T9-7 size budget mitigation.

**UR refs**: UR-006, UR-009

**WIB justification**: Per-instance ArenaAllocator + own WebAssembly.Instance is the **minimum** isolation primitive — no carving logic, no concurrent allocator sharing. R-T9-9 (multi-tenant isolation) closes by construction.

**Lock-free 0.16 ArenaAllocator benefit**: not strictly needed (each machine is single-threaded), but **remains free safety net** if consumer code shares one StateMachine across threads.

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
- After TASK-010 produces first stable `.wasm`, record baseline size into `etc/wasm-size.txt` (or similar; exact filename TBD in PLAN).
- CI fail at `>150% of baseline` — same ratchet philosophy as `etc/statemachine.api.md` from TASK-006.
- Initial budget guidance: **≤300 KB raw `.wasm`** + **≤50 KB JS shim** (covers WebAssembly.Instance per-instance overhead context).
- Per-instance memory overhead (~64 KB) is **runtime memory**, not bundle; documented separately.

**UR refs**: UR-006, UR-007

**WIB justification**: Existing pattern from TASK-006 (api-extractor surface ratchet) — reuse. New surface = bundle size measurement script; minimal (one bash + one txt file).

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

### TD-T9-9: TS canonical for Phase 2; Zig opt-in

**Resolves Q-T9-9**.

**Decision**:
- For 1.0.0-beta.x and 1.0.0-stable: TS implementation remains canonical default. Zig core opt-in via `useZigCore: true` flag in `createMachine()`.
- Zig core MUST pass the same 7 ABI tests + behavioral parity (TASK-014 gate).
- Phase 3 (or Phase 4) re-evaluates promoting Zig to default after operator decision.

**UR refs**: UR-005, UR-009

**WIB justification**: UR-005 explicitly disallows API redesign in current cycle; default-flip is API behavior change. Opt-in flag is minimum form.

---

### TD-T9-10: ABI parity tests are MUST; Zig-side unit tests deferred

**Resolves Q-T9-10**.

**Decision**:
- TASK-014 (ABI parity) MUST pass all 7 ABI tests against the WASM build — this is the contract.
- Zig-side `std.testing` unit tests DEFERRED to TASK-012 IMPLEMENT phase: added only if specific scenarios from TASK-012 design surface gaps not covered by ABI tests.
- Consumer B (Zig direct) will exercise the same ABI tests via Zig-native bindings (TASK-014b).

**UR refs**: UR-007, UR-009

**WIB justification**: ABI tests already exist and cover the contract; existing primitive. New `std.testing` surface introduced only on demonstrated gap.

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
| **A (WASM)** | JS host throws on instantiate if `instance.exports.getAbiVersion() !== EXPECTED_ABI_VERSION` (compiled into `.d.ts` shim). |
| **B (Zig direct)** | `comptime if (statemachine.abi_version != EXPECTED) @compileError("ABI mismatch — expected " ++ ... ++ ", got " ++ ...)`. |
| **npm tarball** | sha512 integrity in `package-lock.json` (orthogonal — fixes content not ABI semantics). |

**UR refs**: UR-005, UR-007, UR-009

**WIB justification**: Compiler/loader checks alone catch only structural mismatch (LinkError). They do NOT catch semantic ABI breaks (renamed fields, reordered params, reassigned enum tags, drift between npm and Zig package versions). `getAbiVersion()` is the **minimum** explicit surface that fails fast at instantiate; alternative (no manual versioning) leaves silent ABI drift between dual consumers — concrete limitation cited.

---

### TD-T9-12: Trap → IErrorHandler.fatal + re-instantiate Instance

**Resolves Q-T9-12**.

**Decision**:
- WebAssembly trap surfaces in JS as `RuntimeError`.
- JS host catches `RuntimeError`, calls `IErrorHandler.fatal(error: 'wasm_trap', ctx: ...)`.
- After fatal: WASM Instance is **discarded** (memory state undefined post-trap per WebAssembly spec). Subsequent `createMachine()` instantiates fresh Instance.
- No "soft restart" protocol that reuses post-trap Instance.

For consumer B (Zig direct):
- Zig `@panic` propagates through normal error handling (`error.X` or stack unwind via `std.debug.captureCurrentStackTrace`).
- Consumer-provided `IErrorHandler`-equivalent receives stack trace; consumer decides retry/discard.

Document this in `STABILITY.md` (added section "Fatal error semantics").

**UR refs**: UR-007, UR-009

**WIB justification**: `IErrorHandler` is existing Phase-1 primitive — reuse. Discard-and-reinstantiate is the WebAssembly-spec-mandated minimum; soft-restart = new surface without evidence.

---

## UR Coverage Matrix

| UR | Carry-forward / local | Driving TD | Status |
|---|---|---|---|
| UR-001 | carry-forward | — | SATISFIED by Phase 1 |
| UR-002 | carry-forward | — | SATISFIED by Phase 1 |
| UR-003 | carry-forward | TD-T9-1 (separate package) | APPLICABLE — `packages/statemachine-zig` is separate package |
| UR-004 | carry-forward | — | SATISFIED by Phase 1 |
| UR-005 | carry-forward | TD-T9-9, TD-T9-11 | TD-T9-9 preserves API surface; TD-T9-11 enforces ABI |
| UR-006 | carry-forward | TD-T9-2, TD-T9-3, TD-T9-7, TD-T9-8 | Multi-runtime support architected |
| UR-007 | carry-forward | TD-T9-6, TD-T9-10, TD-T9-11, TD-T9-12 | Test coverage + debug + ABI versioning |
| UR-008 | carry-forward | TD-T9-2, R-T9-8 (CI/CD platform) | Zig toolchain in CI matrix |
| UR-009 | carry-forward | **PRIMARY DRIVER** for ALL TD-T9-* | Phase 2 zig-wasm-port |
| UR-010 | carry-forward | TD-T9-1, TD-T9-5 | EP catalog preserved (IMonitor/ITimerScheduler/IErrorHandler etc.) |
| UR-011 | carry-forward | TASK-017 (Zig package publishing) | Verify package names before publish |
| UR-012 | local | All TD-T9-* | Phase 2 entry — operator decision |

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

| Task | Tier | Scope (revised per CREATIVE) | Notes |
|---|---|---|---|
| TASK-010 | T3:moderate | Install Zig 0.16.0; scaffold `packages/statemachine-zig/`; `build.zig.zon` + `build.zig` producing `wasm32-unknown-none` AND native targets; smoke-build hello-world WASM. | TD-T9-2, TD-T9-3 |
| TASK-011 | T3:moderate | Port `@stable` types as Zig structs (StateMachineConfig, Transition, State); design FFI representation respecting Zig 0.16 packed-struct restrictions; export `abi_version` constant. | TD-T9-1, TD-T9-11 |
| TASK-012 | **T5:epic candidate** (decision in PLAN) | Port StateMachine class core (constructor, transitions, nested/parallel states, adapter integration). DA F-VAN-C2-1: re-evaluate tier; if T5, decompose into TASK-012a (flat core), TASK-012b (nested/parallel regions), TASK-012c (adapter integration). | TD-T9-4/13 |
| TASK-013 | T3:moderate | EP shims: JS host implements IMonitor/ITimerScheduler/IErrorHandler; Zig core exports `tick()`, `recordTransition()` callback, `fatal()` error reporting. Consumer B uses Zig-native interfaces. | TD-T9-5, TD-T9-12 |
| TASK-014 | T3:moderate | Run all 7 ABI tests against the WASM build (consumer A). Run same 7 tests via Zig-native bindings (consumer B as TASK-014b). | TD-T9-10 |
| TASK-015 | T2:quick | Extend Tier B CI: WASM smoke under Bun, Node 20+, Browser (Safari iOS via BrowserStack), Deno/Edge. Verify Zig toolchain on macOS-ARM, Linux-x64, Windows. | TD-T9-3, TD-T9-8, R-T9-8 |
| TASK-016 | T2:quick | Bundle size ratchet (`etc/wasm-size.txt` baseline + 150% CI gate); perf microbenchmark vs TS implementation. | TD-T9-7 |
| TASK-017 | T3:moderate | Publish Zig package to `build.zig.zon` registry/git tag; verify package name availability per UR-011; semver-align with npm `@vedmalex/statemachine`; document Zig consumer onboarding in README. | UR-011, TD-T9-1 |

---

## Risks (R-T9-1..R-T9-9) — closure status

| Risk | TD owner / mitigation |
|---|---|
| R-T9-1 (Zig version pinning) | TD-T9-2 — pinned 0.16.0 exact. |
| R-T9-2 (FFI cost) | TD-T9-5 — `tick()` boundary is per-fire, not per-transition; transitions batched in WASM linear memory. |
| R-T9-3 (Bundle size 2-3×) | TD-T9-7 — explicit budget + ratchet; if exceeded, CREATIVE re-evaluation. |
| R-T9-4 (Debugging UX) | TD-T9-6 — DWARF native; Zig 0.16 safe unwinding. |
| R-T9-5 (Maintenance burden dual TS+Zig) | TD-T9-9 — TS canonical, Zig opt-in; Phase 3 reconsiders. |
| R-T9-6 (Browser compat) | TD-T9-8 — single universal `.wasm`; TASK-015 multi-runtime smoke verifies. |
| R-T9-7 (Zig std/compiler-rt licensing) | TASK-010 verifies and adds attribution to LICENSE/THIRD_PARTY_LICENSES.md if compiler-rt code embedded. |
| R-T9-8 (CI/CD platform) | TASK-010, TASK-015 — `setup-zig@v1` action, `actions/cache`, pinned 0.16.0 across matrix. |
| R-T9-9 (multi-tenant isolation) | TD-T9-4/13 — per-Instance memory isolation by construction; documented in STABILITY.md. |

---

## CREATIVE Acceptance Criteria — closure status

Per `context.md` "Acceptance Criteria for TASK-009":

| AC | Status |
|---|---|
| 1. CREATIVE outputs program-level decisions for Q-T9-1..13 | ✅ — all 13 TD-T9-* recorded above |
| 2. PLAN locks child-task DAG with tiers + dep direction | ⏳ next phase (PLAN owns) |
| 3. Risk register v1 covers R-T9-1..9 | ✅ — closure table above |
| 4. taskDecompose function gate cleared by mb3-critic | ⏳ deferred to PLAN exit (function gate after CREATIVE/PLAN) |
| 5. Orchestration packet updated with final child set | ⏳ — `orchestration-packet.md` updated to include TASK-017 (this commit) |
| 6. All 12 UR mapped to satisfied or covered | ✅ — UR Coverage Matrix above |
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
