# Zig 0.16 Standard Library — Index Pointer

> **Source**: https://ziglang.org/documentation/0.16.0/std/
> **Note**: The std-docs index page is rendered client-side by Zig's autogen-doc-viewer (autodoc.js). Static `WebFetch` returns only the empty SPA shell. To extract individual module documentation, use one of:
> - `playwright` skill / `dev-browser` for JS-rendered fetch.
> - Direct Zig source inspection: `git clone https://github.com/ziglang/zig --depth 1 --branch 0.16.0 && ls lib/std/`.
> - Per-module page direct fetch (e.g., https://ziglang.org/documentation/0.16.0/std/#std.heap.ArenaAllocator) — also JS-rendered.

This artifact records what we know about std-lib relevant to Phase 2 directly from `zig-016-release-notes.md` (canonical extraction); fetch the full module pages only when TASK-011 / TASK-013 detailed-design needs concrete signatures.

---

## Modules relevant to Phase 2 (release-notes-derived)

### `std.Io`
The new central interface for I/O, time, sync, randomness, fs, net, process. **Anything that potentially blocks or introduces nondeterminism is owned by `Io`**.

Implementations in 0.16:
- `Io.Threaded` — feature-complete, recommended.
- `Io.Evented` — WIP (Linux io_uring, macOS kqueue, Grand Central Dispatch).
- `Io.failing` — no-op simulator.

Core types:
- `Io.Future(T)` — async tasks.
- `Io.Group` — task group, await/cancel together.
- `Io.Timestamp` — clock + duration (replaces `std.time.Instant`/`Timer`/`timestamp`).
- `Io.Mutex`, `Io.RwLock`, `Io.Semaphore`, `Io.Event`, `Io.Condition`, `Io.Futex` — sync primitives migrated from `std.Thread`.
- `Io.Random.IoSource` — entropy interface.
- `Io.Dir`, `Io.File`, `Io.File.Permissions`, `Io.File.Reader`, `Io.File.Writer` — fs.
- `Io.net.HostName`, `Io.net.Socket` — networking.

### `std.heap` — Allocators

Confirmed shipped in 0.16:
- **`ArenaAllocator`** — **lock-free, thread-safe** (new in 0.16; ~7-thread speedup).
- **`FixedBufferAllocator`** — fixed pre-allocated region.
- **`GeneralPurposeAllocator`** — full-featured GPA.
- **`page_allocator`** — OS page-level.
- **`c_allocator`** — libc malloc wrapper.

**Removed in 0.16:**
- `heap.ThreadSafeAllocator` (anti-pattern; individual allocators should be lock-free).

**Phase 2 choice (TD-T9-13)**: per-StateMachine `ArenaAllocator` carved from `FixedBufferAllocator` over WASM linear memory. Reset on `dispose()` for batch free.

### `std.wasm` (existing in pre-0.16; status in 0.16 unchanged per release notes)
- WASM-format helpers, opcodes, sections.
- Used by Zig's WebAssembly backend (compiler), not consumer-facing for typical WASM ports.

### `std.os.wasi` (existing in pre-0.16; updated WASI libc in 0.16)
- WASI syscall surface.
- Used only when target = `wasm32-wasi`. For `wasm32-unknown-none` (Phase 2 default), this module is unused.

### `std.testing`
- Updated with **unit test timeouts** in 0.16.
- Used in TASK-014 ABI parity tests (Zig-side) and TASK-016 perf benchmarks.

### `std.fmt`
Renamed in 0.16:
- `fmt.Formatter` → `Alt`.
- `fmt.format` → `std.Io.Writer.print`.
- `fmt.FormatOptions` → `Options`.
- `fmt.bufPrintZ` → `bufPrintSentinel`.

### `std.compress` (Deflate / Zlib)
- New deflate compression from scratch.
- ~9.7% faster at default; 1.00% better compression than zlib.
- Probably out of scope for Phase 2 (StateMachine doesn't compress); listed for completeness.

### `std.crypto`
New: AES-SIV, AES-GCM-SIV, Ascon-AEAD, Ascon-Hash, Ascon-CHash. Out of scope for Phase 2.

### `std.process`
Renamed/migrated in 0.16:
- `std.process.Init` (replaces global env / args) — passed to `main`.
- `std.process.spawn` (replaces `Child.spawn`).
- `std.process.run` (replaces `child.wait`).
- `std.process.replace` (replaces `execv`).
- `std.process.executablePath`, `executableDirPath` (moved from `fs`).

### `std.debug`
**Reworked in 0.16.** Phase 2 relevant:
- `captureCurrentStackTrace`, `writeCurrentStackTrace`, `dumpCurrentStackTrace`.
- `StackUnwindOptions { first_address, context, allow_unsafe_unwind }`.
- Safe unwinding without frame pointers.
- DWARF-based on Linux/macOS; Windows DWARF planned.
- Override via `@import("root").debug.SelfInfo`.

For TASK-013 (EP shims), `IErrorHandler` will receive Zig stack traces when unwinding succeeds.

### `std.builtin`
Removed: `std.builtin.subsystem`. Use `zig.Subsystem` instead.

### `std.meta`
Removed: `meta.declList`. Use direct decl iteration if needed.

### `std.mem` / `std.Allocator`
- Allocator interface unchanged in API shape.
- `mem.cut` introduced (split-once helper).
- "index of" renamed to "find" across helpers.

---

## Modules NOT used in Phase 2 (for clarity)

- `std.json`, `std.zon` — config parsing happens in TS host.
- `std.tar`, `std.zip` — irrelevant.
- `std.dynamic_library`, `std.DynLib` — Windows support removed; not relevant to WASM.
- `std.posix` / `std.os.windows` — most medium-level functions removed; we use `std.Io` directly.
- `std.Thread.*` — sync primitives migrated to `std.Io.*`.

---

## When to fetch full std module docs

Defer to TASK-011 (core types port) and TASK-013 (EP shims) IMPLEMENT phase. At that point:
1. Use `playwright` skill to render https://ziglang.org/documentation/0.16.0/std/#std.heap.ArenaAllocator and child pages, OR
2. Clone the Zig source: `git clone https://github.com/ziglang/zig --depth 1 --branch 0.16.0 zig-016-source` and read `lib/std/heap/arena_allocator.zig` directly.

For VAN/CREATIVE/PLAN of TASK-009, the release-notes-derived module summary above is sufficient to lock decisions.

---

## Phase-2-relevant changes summary table

| Area | Change | Phase 2 implication |
|---|---|---|
| `std.Io` | New interface for fs/net/time/process | Mirror our IMonitor/ITimerScheduler pattern in Zig core |
| `std.heap.ArenaAllocator` | Lock-free, thread-safe | TD-T9-13: per-StateMachine arena |
| `std.heap.ThreadSafeAllocator` | REMOVED | Don't try to wrap allocators with mutexes |
| `std.posix` / `std.os.windows` | Most medium-level fns removed | Use `std.Io` (Phase 2) or `std.posix.system` (low-level) |
| `std.debug` | Reworked, safe unwinding | TD-T9-6: emit `.debug.wasm` with DWARF |
| `@cImport` | DEPRECATED (build-system) | TASK-010 build.zig must use `addTranslateC` if any C interop |
| `@Type` | REMOVED, 8 specialized builtins | TASK-011 port uses `@Struct`/`@Union`/`@Int` etc. |
| Pointers in packed structs/unions | FORBIDDEN | TASK-011: use `usize` + `@ptrFromInt`/`@intFromPtr` for FFI struct fields |
| Enum/packed implicit backing in extern | FORBIDDEN | TASK-011: explicit `enum(u8)`/`packed struct(u32)` for FFI types |
| `process.Init` "Juicy Main" | New | StateMachine WASM not a binary; this affects only test harnesses |
| `WebAssembly` backend | Improved code-gen | TD-T9-1 hybrid model viable |
| LLVM 21 | New | Loop-vec disabled (workaround); slight code-size impact |
| OS minimums | macOS 13, Win 10, Linux 5.10 | UR-006 satisfied (consistent with TASK-005 CI matrix Node 20+ era) |
