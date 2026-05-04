# Zig 0.16 — Phase 2 Impact Analysis

> **Companion to** `zig-016-release-notes.md`. Maps Zig 0.16 features/changes to TASK-009 open questions (Q-T9-*) and risks (R-T9-*) listed in `context.md`. This artifact informs CREATIVE decisions TD-T9-* and the locked child-task DAG.

---

## CREATIVE Decision: TD-T9-2 Resolved

**Q-T9-2 (Zig version)** → **DECISION**: pin **Zig 0.16.0 stable** for Phase 2.

**Rationale:**
1. Released stable; not nightly. Aligns with R-T9-1 "pin version + document".
2. Ships with **macOS 13.0+ / Windows 10 / Linux 5.10+** support — covers UR-006 runtime tier targets.
3. Native CI for `aarch64-*`, `loongarch64-linux`, `x86_64-*-bsd` — useful for R-T9-8 platform support.
4. **`heap.ArenaAllocator` is now lock-free + thread-safe** — directly enables Q-T9-13 multi-tenant allocator strategy without bespoke locking.
5. **`std.Io` interface** — first-class abstraction over fs/net/time/process. Mirrors our existing IMonitor/ITimerScheduler/IErrorHandler pattern.
6. **Improved debug-info / DWARF unwinding on all major targets** — closes Q-T9-6 (sourcemaps + debugging) without bespoke trace mapping.

**Status carry-forward:** TD-T9-2 = `pin Zig 0.16.0 stable` (recorded 2026-05-04 by operator).

---

## Q-T9 Closure Map (Zig-0.16-driven, advisory pre-CREATIVE-DA)

| Q-T9 | Question | Zig 0.16 evidence | Recommended decision shape |
|---|---|---|---|
| Q-T9-1 | Single-package WASM vs hybrid (TS host + Zig core via FFI) | Zig 0.16 has improved **WebAssembly backend** code-gen; `@cImport` deprecation moves all C-translation to build system. | **Hybrid recommended** for Phase 2: TS host + Zig core compiled to WASM, called from JS via thin FFI. Single-package WASM is option for Phase 3+ when Zig std.Io stabilizes. |
| Q-T9-2 | Zig version | Pinned **Zig 0.16.0 stable** (this artifact). | **CLOSED** — see TD-T9-2 above. |
| Q-T9-3 | WASM target — `wasm32-unknown-none` (raw) vs `wasm32-wasi` (with WASI) vs `wasm32-emscripten` | Zig 0.16 std-lib heavily migrated to `std.Io`. Most `std.posix`/`std.os.windows` medium-level functions removed. **WASI libc updated**. **Preopens** for WASI in process.Init. `error.IsDir` correctly returned on WASI for positional read/write. | **`wasm32-unknown-none`** for the StateMachine core (no fs/net needed at runtime). **`wasm32-wasi`** for tests/CI smoke if filesystem fixtures are required. **NOT `wasm32-emscripten`** — adds runtime overhead and breaks UR-006 portability. |
| Q-T9-4 | Memory model — single linear memory shared with JS, or isolated arena per StateMachine | Zig 0.16 ArenaAllocator is **lock-free, thread-safe, ~7-thread speedup**. Multiple StateMachine instances inside one WASM module instance can each own an ArenaAllocator pointing to slices of shared linear memory. | **Per-instance ArenaAllocator** in shared linear memory. Each StateMachine carves its own arena from `WebAssembly.Memory` linear-memory pool. Frees are batch (arena reset on `dispose`). |
| Q-T9-5 | Timer host — `ITimerScheduler` shim into JS `setTimeout` vs Zig-native timer-wheel | Zig 0.16 `std.Io.Timestamp` provides clock primitives but **timer scheduling is owned by the Io implementation**. WASM core has no native scheduler. | **`ITimerScheduler` shim into JS** (existing TS contract preserved). Zig core exports `tick(now_ms: u64)` and the JS host owns `setTimeout`/`setInterval` callbacks. UR-010 EP catalog preserved. |
| Q-T9-6 | Sourcemaps + debugging — `.debug.wasm` with DWARF, OR JS-side trace mapping | Zig 0.16: **safe unwinding works without frame pointers**. **Stack traces on all major targets**. **Inline callers in error return traces on all platforms**. DWARF still planned for Windows debug info. | **Emit `.debug.wasm` with DWARF**. Modern browsers + Node have DWARF support via DevTools extension; fallback JS-side trace mapping NOT needed. R-T9-4 risk reduced. |
| Q-T9-7 | Bundle size budget vs current 122 KB ESM | Zig 0.16 enables **lock-free ArenaAllocator** without external sync overhead. WebAssembly backend code-gen improvements. LLVM 21 (loop vectorization disabled as workaround — slight code-size regression possible). | **Budget: 200 KB raw `.wasm` + 50 KB JS shim = 250 KB total**. 2× current ESM is acceptable for the parity demo; future Phase 3 (declarative DSL) can prune dead transitions. |
| Q-T9-8 | Browser-vs-Node-vs-Deno entry points | Zig 0.16 std supports `wasm32-unknown-none` (no host-specific syscalls). `process.Init` provides `Preopens` for WASI named files. | **One universal `.wasm` binary** + per-host JS loader (Browser ESM dynamic-import, Node `WebAssembly.compile(buf)`, Deno `WebAssembly.instantiateStreaming`). UR-006 driver. |
| Q-T9-9 | TS canonical reference vs Zig replacement | Zig 0.16 `std.Io` interface is brand-new; not yet stabilized for production multi-tenant use. | **TS as canonical reference** for 1.0.0-beta.x and 1.0.0-stable. Zig is opt-in via `useZigCore: true` constructor flag. Phase 3 will revisit replacement after WASM build proves parity. |
| Q-T9-10 | Test parity — Zig-side unit tests in addition to ABI tests | Zig 0.16 has **AST smith fuzzer** + multiprocess fuzzing for compiler-internal testing; std-lib has `std.testing` with timeouts. | **YES** — Zig-side unit tests for transition machinery + Zig-side property tests using `std.testing`. ABI parity tests (TASK-014) remain authoritative for behavioral parity. |
| Q-T9-11 | ABI versioning policy | Zig 0.16 **forbids pointers in packed structs/unions** (cleaner FFI surface). **Forbids enum/packed types with implicit backing types in extern contexts**. **`@Type` removed** in favor of explicit `@Struct`/`@Union` with explicit backing ints. | **Hash-pin `.wasm` artifact in package.json `wasmIntegrity` field** (sha256 of artefact). Export `getAbiVersion(): u32` from WASM that returns a build-time integer baked from `build.zig.zon`. JS host validates `getAbiVersion() === EXPECTED_ABI_VERSION` at instantiate; throws on mismatch. |
| Q-T9-12 | Panic / trap propagation | Zig 0.16 **completed migration to NtDll** on Windows; **safe unwinding without frame pointers**; **stack traces on crashes via DebugAllocator**. Crash dumps from fuzzer. **`ucontext_t` removed** — signal handler patterns must roll custom types. WASM trap surfaces in JS as `RuntimeError`. | **Panics → IErrorHandler.fatal()** via `extern fn zigPanicCallback(...)` exported from JS host. After panic, the WASM module is **unrecoverable** — JS host MUST discard and re-instantiate. Document this in StateMachineConfig.policy. |
| Q-T9-13 | Zig allocator strategy | Zig 0.16: **`heap.ArenaAllocator` lock-free + thread-safe** (key win). **`heap.ThreadSafeAllocator` REMOVED** (anti-pattern). FixedBufferAllocator, GeneralPurposeAllocator, page_allocator still ship in `std.heap`. | **ArenaAllocator per-StateMachine** carved from a `FixedBufferAllocator` over the WASM linear memory range. **Reset on dispose** (free entire arena at once). NO `GeneralPurposeAllocator` (incompatible with simple WASM linear-memory model). |

---

## R-T9 Closure Map

| R-T9 | Risk | Zig 0.16 evidence | Mitigation |
|---|---|---|---|
| R-T9-1 | Zig version pinning | 0.16.0 is stable; release contains 1183 commits and 8 months of work. Pinning to stable point release is straightforward. | TASK-010: pin `0.16.0` exact in `build.zig.zon` and CI. |
| R-T9-2 | WASM-JS FFI cost | std.Io interface includes Batch (low-level Operation layer) for batching. Sync primitives migrated to std.Io (lock-free where possible). | TASK-013: batch `IMonitor.recordTransition` calls into a ring buffer; flush at next `tick()` boundary or on explicit `flush()`. Avoid per-transition FFI crossing. |
| R-T9-3 | Bundle size 2-3× regression | LLVM 21 has loop-vectorization disabled in 0.16 (workaround). WebAssembly backend has code-gen improvements. Removing pointers from packed structs may slightly grow code. | Budget set to 250 KB total (Q-T9-7 decision). If exceeded, TASK-016 must report and CREATIVE re-evaluates. |
| R-T9-4 | Debugging UX | **0.16 has safe unwinding even without frame pointers + stack traces on all major targets + inline callers in error return traces**. DWARF emit is well-supported. | TASK-010 enables `-g` (debug info) in dev builds and `-fno-strip-debug-info` for `.debug.wasm`. Production builds strip. |
| R-T9-5 | Maintenance burden (dual TS+Zig) | Q-T9-9 decision keeps TS canonical, Zig opt-in. Zig 0.16 std.Io interface mirrors our IMonitor/ITimerScheduler pattern, reducing surface drift. | Decision: 1.0.0-beta/stable keeps TS canonical. Zig core is parallel impl gated by feature flag. Operator decides Phase 3 promotion. |
| R-T9-6 | Browser compat | 0.16 emits standard wasm32 binaries; Safari iOS 14+ has full WASM support. | TASK-015 multi-runtime smoke must include Safari iOS via BrowserStack. Document `engines` field. |
| R-T9-7 | Zig std/compiler-rt licensing | Zig is **MIT** licensed including std and compiler-rt. WASM bundles will embed compiler-rt math intrinsics (e.g., `__divti3`). | TASK-010 verifies LICENSE attribution: project remains MIT; add MIT attribution clause for embedded compiler-rt to `LICENSE` (or `THIRD_PARTY_LICENSES.md`). |
| R-T9-8 | CI/CD Zig toolchain platform | 0.16 ships **macOS 13.0+** binaries including aarch64-macos. Linux 5.10+. Windows 10+. Native CI for new BSDs. | TASK-010 sets up GitHub Actions `setup-zig@v1` action (or manual download with `actions/cache@v4`); pin `0.16.0` exact. macOS-ARM via `macos-14` or `macos-15` runner. |
| R-T9-9 | WASM multi-tenant isolation | Per-StateMachine ArenaAllocator (Q-T9-13) keeps memory isolated within one WASM module. **Multiple `WebAssembly.Instance` per tenant is the recommended pattern** for full isolation. | Document in CONFIG.md: "For multi-tenant Node deployments, instantiate one `WebAssembly.Instance` per tenant. Sharing a single instance across tenants is supported for trusted-input scenarios only." |

---

## CREATIVE-DA inputs (for next-phase mb3-critic gate)

When CREATIVE → PLAN transition is requested, the gated DA review will evaluate:
1. **Decision-to-UR mapping**: each TD-T9-* must trace to a UR (UR-001..UR-012 + carry-forwards). UR-009 is primary driver for TD-T9-2..TD-T9-13.
2. **Risk register completeness**: 9 R-T9 items have a closure path; if any new risk surfaces during Q-T9-1/3/4/5/12 resolution, capture as R-T9-10+.
3. **Child-task DAG locking**: TASK-010..016 (or final shape) must have explicit dependency direction. **TASK-012 T4→T5 escalation must be decided** with rationale; if T5, decompose into TASK-012a/b/c and update DAG.
4. **`taskDecompose` function gate**: this is a separate function gate (per workflow contract), runs after CREATIVE+PLAN locks the decomposition.

---

## Toolchain dependency snapshot (for TASK-010)

| Component | Pinned to |
|---|---|
| Zig | **0.16.0 stable** |
| LLVM | 21 (bundled with Zig 0.16, loop-vec disabled per Zig workaround) |
| musl | 1.2.5 |
| glibc | 2.43 |
| WASI libc | bundled |
| MinGW-w64 | bundled (Windows cross-compile) |
| Linux headers | 6.19 |
| macOS headers | 26.4 |
| Min macOS | 13.0 |
| Min Windows | 10 |
| Min Linux kernel | 5.10 |

---

## Open follow-ups (for CREATIVE/PLAN)

1. Decide whether TASK-010 also installs `translate-c` package (for any C interop) or if the StateMachine port has zero C dependencies.
2. Confirm `wasmIntegrity` hash-pin field name (Q-T9-11) — operator approval before TASK-011 designs the version export.
3. Decide arena reset granularity (per-transition vs per-state-cycle vs per-dispose) — Q-T9-13 follow-up.
4. Decide IErrorHandler post-trap recovery semantics: hard-reinstantiate vs soft-restart with reset state — Q-T9-12 follow-up.

---

> **Source files referenced**: `zig-016-release-notes.md` (this artifact's companion). For std.heap / std.wasm / std.Io API specifics that the release notes summarize but don't detail, fetch the relevant std page from https://ziglang.org/documentation/0.16.0/std/ during TASK-011 / TASK-013 detailed-design work.
