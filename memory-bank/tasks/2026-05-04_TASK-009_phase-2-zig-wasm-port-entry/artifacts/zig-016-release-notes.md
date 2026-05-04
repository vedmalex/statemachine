# Zig 0.16.0 Release Notes — TASK-009 reference

> **Source**: https://ziglang.org/download/0.16.0/release-notes.html
> **Fetched**: 2026-05-04 (TASK-009 CREATIVE)
> **Scope**: Phase 2 reference. All sections of release notes preserved verbatim from upstream HTML rendering. Use this artifact + `zig-016-phase2-impact.md` as the canonical Zig 0.16 input for CREATIVE/PLAN/TECH_SPEC of TASK-009..016.

---

## Overview

Zig 0.16.0 represents 8 months of work from 244 contributors across 1183 commits. Key highlights include the debut of **I/O as an Interface**, alongside enhancements to the language, compiler, build system, linker, fuzzer, and toolchain.

## Table of Contents

- [Target Support](#target-support)
- [Language Changes](#language-changes)
- [Standard Library](#standard-library)
- [Build System](#build-system)
- [Compiler](#compiler)
- [Linker](#linker)
- [Fuzzer](#fuzzer)
- [Bug Fixes](#bug-fixes)
- [Toolchain](#toolchain)
- [Roadmap](#roadmap)

---

## Target Support

### Tier System

- **Tier 1** — All non-experimental language features work; compiler generates machine code without LLVM.
- **Tier 2** — Cross-platform abstractions; debug info + stack traces; libc when cross-compiling; CI on every push.
- **Tier 3** — Compiler generates code via LLVM; linker produces objects/libraries/executables; not experimental in LLVM.
- **Tier 4** — Compiler generates assembly via LLVM only.

### New Native CI Testing
- `aarch64-freebsd`, `aarch64-netbsd`, `loongarch64-linux`, `powerpc64le-linux`, `s390x-linux`, `x86_64-freebsd`, `x86_64-netbsd`, `x86_64-openbsd` — now tested natively.
- Hardware sponsorship: OSUOSL (AArch64, Power ISA), IBM (z/Architecture).

### New Platform Support
- Cross-compilation for `aarch64-maccatalyst` and `x86_64-maccatalyst`.
- Initial `loongarch32-linux` (libc not yet supported; syscalls via `std.os.linux` only).
- Basic Alpha, KVX, MicroBlaze, OpenRISC, PA-RISC, SuperH (require GCC or external LLVM/Clang fork).

### Removed Support
- Oracle Solaris, IBM AIX, IBM z/OS removed.
- illumos remains supported.

### Reliability Improvements
- Stack tracing significantly improved on almost all major targets (covers crashes).
- Bugs fixed for weakly-ordered architectures and unusual page sizes.
- Big-endian host support improved.
- Big-endian ARM targets emit BE8 object files for ARMv6+ (was BE32).

### OS Version Requirements

| OS | Minimum Version |
|---|---|
| DragonFly BSD | 6.0 |
| FreeBSD | 14.0 |
| Linux | 5.10 |
| NetBSD | 10.1 |
| OpenBSD | 7.8 |
| macOS | 13.0 |
| Windows | 10 |

---

## Language Changes

### switch Statement Enhancements

`packed struct` and `packed union` may now be used as switch prong items, compared solely by backing integer:

```zig
const U = packed union(u2) {
    a: i2,
    b: u2,
};

const u: U = .{ .a = -1 };
switch (u) {
    .{ .b = 3 } => {},
    else => unreachable,
}
```

Additional features:
- Decl literals and result-type-requiring expressions (e.g., `@enumFromInt`) usable as switch prong items.
- Union tag captures allowed for all prongs, not just `inline`.
- Switch prongs may contain errors not in switched error set if the body is `=> comptime unreachable`.
- Switch prong captures may NOT all be discarded.

Bug fixes:
- One-possible-value type issues resolved.
- Unreachable `else` prongs for error switches consistent.
- `void` switch no longer requires `else`.
- Lazy values resolved before comparisons.
- Consistent evaluation order across all switch types.

### Equality Comparisons on Packed Unions

`packed union` types can now be compared for equality without wrapping in a `packed struct`.

### `@cImport` Moving to Build System

`@cImport` is **deprecated**. C translation moves to the build system.

**Before:**
```zig
pub const c = @cImport({
    @cInclude("stdio.h");
    @cInclude("math.h");
});
const c = @import("c.zig").c;
```

**After (build.zig):**
```zig
const translate_c = b.addTranslateC(.{
    .root_source_file = b.path("src/c.h"),
    .target = target,
    .optimize = optimize,
});

const exe = b.addExecutable(.{
    .name = "program",
    .root_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .imports = &.{
            .{
                .name = "c",
                .module = translate_c.createModule(),
            },
        },
    }),
});
```

In `main.zig`: `const c = @import("c");`

Alternative: official translate-c package at https://codeberg.org/ziglang/translate-c.

### `@Type` Replaced with Individual Type-Creating Builtin Functions

`@Type` builtin **removed**, replaced by 8 specialized builtins:

#### `@EnumLiteral()`
Returns the "enum literal" type (`.foo` uncoerced).
```zig
@Type(.enum_literal) → @EnumLiteral()
```

#### `@Int(signedness, bits)`
```zig
@Type(.{ .int = .{ .signedness = .unsigned, .bits = 10 } })
→ @Int(.unsigned, 10)
```

#### `@Tuple(field_types)`
```zig
@Tuple(&.{ u32, [2]f64 })
```
Tuple types with `comptime` fields can no longer be reified.

#### `@Pointer(size, attrs, Element, sentinel)`
```zig
@Pointer(.one, .{ .@"const" = true }, u32, null)
@Pointer(.many, .{ .@"align" = 1 }, u64, 0)
```

#### `@Fn(param_types, param_attrs, ReturnType, attrs)`
"Struct of arrays" pattern:
```zig
@Fn(
    &.{ f64, *const anyopaque },
    &.{ .{}, .{ .@"noalias" = true } },
    u32,
    .{ .@"callconv" = .c, .varargs = true },
)
```
Use `&@splat(.{})` for default attributes on all parameters.

#### `@Struct(layout, BackingInt, field_names, field_types, field_attrs)`
```zig
@Struct(
    .@"extern",
    null,
    &.{ "foo", "bar" },
    &.{ [2]f64, u32 },
    &.{
        .{ .@"align" = 1 },
        .{ .@"comptime" = true, .default_value_ptr = &@as(u32, 123) },
    },
)
```

#### `@Union(layout, ArgType, field_names, field_types, field_attrs)`
```zig
@Union(
    .auto,
    MyEnum,
    &.{ "foo", "bar" },
    &.{ i64, f64 },
    &@splat(.{}),
)
```

#### `@Enum(TagInt, mode, field_names, field_values)`
```zig
@Enum(
    u32,
    .exhaustive,
    &.{ "foo", "bar" },
    &.{ 0, 1 },
)
```

#### Removed (no replacement) — use plain syntax:
- `@Float` → use `std.meta.Float`
- `@Array` → `[len]Elem` or `[len:s]Elem`
- `@Opaque` → `opaque {}`
- `@Optional` → `?T`
- `@ErrorUnion` → `E!T`
- `@ErrorSet` → declare explicitly via `error { ... }`

### Allow Small Integer Types to Coerce to Floats

If all values of an integer type fit in a float without rounding, coercion is implicit:
```zig
var foo_int: u24 = 123;
var foo_float: f32 = foo_int; // OK

var bar_int: u25 = 123;
var bar_float: f32 = @floatFromInt(bar_int); // explicit required
```

### Forbid Runtime Vector Indexes

Vector indexing with runtime indices is no longer permitted.

Upgrade pattern:
```zig
const vector_type = @typeInfo(@TypeOf(vector)).vector;
const array: [vector_type.len]vector_type.child = vector;
for (&array) |elem| { _ = elem; }
```

### Vectors and Arrays No Longer Support In-Memory Coercion

Use explicit coercion (no `@ptrCast`) for array↔vector. Unwrap error unions before coercion.

### Forbid Trivial Local Address Returned from Functions

```zig
fn foo() *i32 {
    var x: i32 = 1234;
    return &x;  // error: returning address of expired local variable 'x'
}
```

### Unary Float Builtins Forward Result Type

`@sqrt`, `@sin`, `@cos`, `@tan`, `@exp`, `@exp2`, `@log`, `@log2`, `@log10`, `@floor`, `@ceil`, `@trunc`, `@round` now forward result types:
```zig
const x: f64 = @sqrt(@floatFromInt(N)); // compiles
```

### `@floor`/`@ceil`/`@round`/`@trunc` Now Convert to Integers

```zig
const actual: u8 = @round(12.5); // → 13
```
`@intFromFloat` is **deprecated**; use `@trunc` instead.

### Forbid Unused Bits in Packed Unions

All fields of a `packed union` must have the same `@bitSizeOf` as the backing integer type.

### **Forbid Pointers in Packed Structs and Unions**

Pointers no longer permitted as fields of `packed struct` or `packed union`. Use `usize` with `@ptrFromInt` and `@intFromPtr` instead.

### Allow Explicit Backing Integers on Packed Unions

```zig
const Split16 = packed union(u16) {
    raw: MaybeSigned16,
    split: packed struct { low: u8, high: u8 },
};
```

### Forbid Enum and Packed Types with Implicit Backing Types in Extern Contexts

```zig
// Error: const Enum = enum { a, b, c, d }; export var e: Enum = .a;
// Fix:   const Enum = enum(u8) { a, b, c, d }; export var e: Enum = .a;
```

### Lazy Field Analysis

Types used as namespaces no longer require field analysis. Fields analyzed only when needed. `*T` no longer requires `T` resolution.

### Pointers to Comptime-Only Types Are No Longer Comptime-Only

`*comptime_int`, `[]comptime_int` are runtime types. Cannot be dereferenced at runtime but can be passed to runtime functions for field access.

### Explicitly-Aligned vs Naturally-Aligned Pointer Types

`*u8` and `*align(1) u8` are now distinct types (still interchangeable through coercion).

### Simplified Dependency Loop Rules

New cases detected as loops; better error messages.

### Zero-bit Tuple Fields No Longer Implicitly comptime

Zero-bit tuple fields no longer promoted to `comptime` implicitly (values still comptime-known).

---

## Standard Library

### **I/O as an Interface** ⭐

Starting with 0.16, all I/O functionality requires an `Io` instance. Anything that potentially blocks or introduces nondeterminism is owned by the I/O interface.

**Implementations:**
- `Io.Threaded` — thread-based, feature-complete, recommended default.
  - `-fno-single-threaded`: task-level concurrency + cancelation.
  - `-fsingle-threaded`: sequential.
- `Io.Evented` — WIP, experimental, M:N "green threads".
  - `Io.Uring` — Linux io_uring proof-of-concept.
  - `Io.Kqueue` — macOS kqueue PoC.
  - `Io.Dispatch` — Grand Central Dispatch PoC.
- `Io.failing` — simulates no-operation.

**Demo HTTP request:**
```zig
const std = @import("std");
const Io = std.Io;

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;

    const args = try init.minimal.args.toSlice(init.arena.allocator());
    const host_name: Io.net.HostName = try .init(args[1]);

    var http_client: std.http.Client = .{ .allocator = gpa, .io = io };
    defer http_client.deinit();

    var request = try http_client.request(.HEAD, .{
        .scheme = "http",
        .host = .{ .percent_encoded = host_name.bytes },
        .port = 80,
        .path = .{ .percent_encoded = "/" },
    }, .{});
    defer request.deinit();

    try request.sendBodiless();

    var redirect_buffer: [1024]u8 = undefined;
    const response = try request.receiveHead(&redirect_buffer);
    std.log.info("received {d} {s}", .{ response.head.status, response.head.reason });
}
```

#### Future / Group / Cancelation / Batch

**Future** — `io.async(fn, args)` returns `Future(T)`; `io.concurrent` requires actual concurrency, may fail with `error.ConcurrencyUnavailable`.
```zig
var foo_future = io.async(foo, .{args});
defer if (foo_future.cancel(io)) |resource| resource.deinit() else |_| {}
const result = try foo_future.await(io);
```

**Group** — manage many independent tasks with O(1) overhead per task; await + cancel together.
```zig
var group: Io.Group = .init;
defer group.cancel(io);
for (&array) |elem| group.async(io, sleepAppend, .{ io, &sorted, &index, elem });
try group.await(io);
```

**Cancelation** — may or may not be acknowledged. Acknowledged → `error.Canceled`. `Io.Threaded` supports cancelation via signals.

Patterns:
1. Propagate the error.
2. `io.recancel()` and don't propagate (rearm).
3. `io.swapCancelProtection()` for unreachable.

**Batch** — low-level concurrency at `Operation` layer (`FileReadStreaming`, `FileWriteStreaming`, `DeviceIoControl`, `NetReceive`).

#### Sync Primitives Migrated to `std.Io`

- `std.Thread.ResetEvent` → `std.Io.Event`
- `std.Thread.WaitGroup` → `std.Io.Group`
- `std.Thread.Futex` → `std.Io.Futex`
- `std.Thread.Mutex` → `std.Io.Mutex`
- `std.Thread.Condition` → `std.Io.Condition`
- `std.Thread.Semaphore` → `std.Io.Semaphore`
- `std.Thread.RwLock` → `std.Io.RwLock`
- `std.once` — **removed**.

#### Entropy

```zig
// Old:                          // New:
std.crypto.random.bytes(buf);    io.random(buf);
const rng = std.crypto.random;   const rng_impl: std.Random.IoSource = .{ .io = io }; const rng = rng_impl.interface();
posix.getrandom(buf);            io.random(buf);
```

```zig
pub fn random(io: Io, buffer: []u8) void
pub fn randomSecure(io: Io, buffer: []u8) RandomSecureError!void
```

#### Time

- `std.time.Instant` → `std.Io.Timestamp`
- `std.time.Timer` → `std.Io.Timestamp`
- `std.time.timestamp` → `std.Io.Timestamp.now`
- Added: clock resolution.

#### File System Migration

All `fs` APIs migrated to `Io`. Typical: `file.close()` → `file.close(io)`.

**Added:** `Io.Dir.hardLink`, `Io.Dir.Reader`, `Io.Dir.setFilePermissions`, `Io.Dir.setFileOwner`, `Io.File.NLink`.

**Removed (no replacement):** `realpathZ/W/W2`, `makeDirAbsoluteZ`, `deleteDirAbsoluteZ`, `openDirAbsoluteZ`, `renameAbsoluteZ`, `renameZ`, `deleteTreeAbsolute`, `symLinkAbsoluteW`, `Dir.symLinkWasi/Z/W`, `Dir.realpathZ/W/W2`, `Dir.deleteFileZ/W`, `Dir.deleteDirZ/W`, `Dir.renameZ/W`, `Dir.readLinkWasi/Z/W`, `Dir.adaptToNewApi`, `Dir.adaptFromNewApi`, `File.isCygwinPty`, `File.adaptToNewApi`, `File.adaptFromNewApi`.

**Moved (selected):**
- `fs.copyFileAbsolute` → `std.Io.Dir.copyFileAbsolute`
- `fs.makeDirAbsolute` → `std.Io.Dir.createDirAbsolute`
- `fs.openFileAbsolute` → `std.Io.Dir.openFileAbsolute`
- `fs.realpath` → `std.Io.Dir.realPathFileAbsolute`
- `fs.cwd` → `std.Io.Dir.cwd`
- `fs.openSelfExe` → `std.process.openExecutable`
- `fs.Dir` → `std.Io.Dir`
- `fs.File` → `std.Io.File`
- `fs.Dir.makeDir` → `std.Io.Dir.createDir`
- `File.setEndPos` → `Io.File.setLength`
- `File.read` / `File.readv` → `Io.File.readStreaming`
- `File.write` / `File.writev` → `Io.File.writeStreaming`
- `File.pread` / `File.preadv` → `Io.File.readPositional`
- `File.pwrite` / `File.pwritev` → `Io.File.writePositional`

**Renamed types:** `fs.File.Mode/PermissionsWindows/PermissionsUnix` → `std.Io.File.Permissions`; `fs.File.default_mode` → `std.Io.File.Permissions.default_file`.

**Deprecated (still available):** `fs.path` → `std.Io.Dir.path`; `fs.max_path_bytes` → `std.Io.Dir.max_path_bytes`; `fs.max_name_bytes` → `std.Io.Dir.max_name_bytes`.

#### Networking

All `net` APIs migrated to `Io`. `Io.Evented` does not yet implement networking.

#### Process

```zig
// Old:
var child = std.process.Child.init(argv, gpa);
child.stdin_behavior = .Pipe; ...
try child.spawn(io);

// New:
var child = try std.process.spawn(io, .{
    .argv = argv,
    .stdin = .pipe, .stdout = .pipe, .stderr = .pipe,
});

// Run + capture output:
const result = std.process.run(allocator, io, .{ ... });

// Replace process:
const err = std.process.replace(io, .{ .argv = argv });
```

#### File.MemoryMap

Pointer contents synced only after explicit sync points. Fallback uses file ops. Evented I/O can use evented file I/O for sync points instead of mapping.

Breaking: positional read/write error sets more constrained. WASI `error.IsDir` correctly returned (was `error.NotOpenForReading`).

#### `posix` and `os.windows` Removals

Most `std.posix` and `std.os.windows` medium-level functions removed. Choose: go higher (use `std.Io`) or lower (use `std.posix.system` directly).

### **`heap.ArenaAllocator` Becomes Thread-Safe and Lock-Free**

New ArenaAllocator implementation is **lock-free and thread-safe**. Compatible with `std.Io` integration and libc. Performs comparably to previous single-threaded usage; **speed-up when used by up to ~7 concurrent threads**.

### `heap.ThreadSafeAllocator` REMOVED

Wrapper allocators with mutexes deemed anti-pattern. Individual allocators should be lock-free instead.

### Add Deflate Compression, Simplify Decompression

New deflate compression from scratch. Writers: `Raw` (uncompressed), `Huffman` (Huffman only). Decompression bit reading simplified using reader peeking.

**Zlib comparison:** 1.00% better at default level, 0.77% better at best level. Performance: ~9.7% faster at default, ~0.8% faster at best.

### Expanded Target Support for Segfault Handling/Unwinding

Stack traces on crashes and DebugAllocator now working on all major targets. Inline callers from debug info on Windows; DWARF support planned. Error return traces include inline callers on all platforms.

### Removal of `ucontext_t`

`ucontext_t` removed. Non-local control flow no longer supported. For machine state inspection in signal handlers, users should roll custom types.

### **Debug Information Reworked** ⭐

Reworked APIs for debug information and stack traces. **New safe unwinding using unwind information avoids crashes when frame pointers unavailable** (e.g., libc compiled with `-fomit-frame-pointer`).

```zig
pub fn writeStackTrace(st: *const StackTrace, t: Io.Terminal) Writer.Error!void
pub noinline fn captureCurrentStackTrace(options: StackUnwindOptions, addr_buf: []usize) StackTrace
pub noinline fn writeCurrentStackTrace(options: StackUnwindOptions, t: Io.Terminal) Writer.Error!void
pub fn dumpCurrentStackTrace(options: StackUnwindOptions) void

pub const StackUnwindOptions = struct {
    first_address: ?usize = null,
    context: ?CpuContextPtr = null,  // for signal handlers
    allow_unsafe_unwind: bool = false,
};
```

Deprecated: `captureStackTrace`, `dumpStackTraceFromBase`, `walkStackWindows`, `writeStackTraceWindows`. `StackIterator` no longer public; use `std.debug.SelfInfo`. Override via `@import("root").debug.SelfInfo`.

### Inter-Process Progress Reporting for Windows

`std.Progress` now supports child process reporting on Windows. Max node length: 40 → 120.

### Windows Networking Without `ws2_32.dll`

All Windows networking now via direct AFD (Async File Dispatch). Fixes bugs, enables Cancelation/Batch, avoids `ws2_32.dll` performance pitfalls.

### Completed Migration to `NtDll`

All Windows std-lib functionality uses NtDll syscall API. Remaining DLL calls: `kernel32.CreateProcessW`, `crypt32` cert chain functions. Batch + Cancelation now have full Windows support.

### "Juicy Main" — `process.Init`

```zig
pub const Init = struct {
    minimal: Minimal,
    arena: *std.heap.ArenaAllocator,
    gpa: Allocator,
    io: Io,
    environ_map: *Environ.Map,
    preopens: Preopens,  // WASI named files from parent
};

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;
    const arena = init.arena;
}
```

### Environment Variables and Process Arguments NON-Global

`environ_map` accessed via `init.environ_map`. Process args via `init.minimal.args`.

### Memory / API Updates

- `mem.cut` introduced; "index of" renamed to "find".
- Selective directory tree walking.
- `fs.path` Windows path improvements.
- `fs.path.relative` now pure function.
- `File.Stat`: access time optional.
- "Preopens" for WASI.
- Atomic / temporary files support.
- Memory locking/protection moved to `process` module.
- "Unmanaged" container migration.
- `PriorityDequeue` added; `PriorityQueue` improved.
- `Thread.Pool` removed.
- `builtin.subsystem` removed; `Target.SubSystem` → `zig.Subsystem`.
- `Io.GenericReader`, `AnyReader`, `FixedBufferStream` deleted.
- `{D}` format → `Io.Duration` format method.
- `fs.getAppDataDir` removed.
- `Io.Writer.Allocating` alignment field.
- `fs.Dir.readFileAlloc` updated.
- `fs.File.readToEndAlloc` updated.

### New Crypto

- AES-SIV, AES-GCM-SIV.
- Ascon-AEAD, Ascon-Hash, Ascon-CHash.

### Misc

**Added:** `Io.Dir.renamePreserve` (rename without replacing destination); `Io.net.Socket.createPair`.

**Removed:** `SegmentedList`, `meta.declList`, `Io.GenericWriter`, `Io.AnyWriter`, `Io.null_writer`, `Io.CountingReader`, `Thread.Mutex.Recursive`.

**Error renames:**
- `error.RenameAcrossMountPoints` → `error.CrossDevice`
- `error.NotSameFileSystem` → `error.CrossDevice`
- `error.SharingViolation` → `error.FileBusy`
- `error.EnvironmentVariableNotFound` → `error.EnvironmentVariableMissing`
- `Io.Dir.rename` returns `error.DirNotEmpty` (was `error.PathAlreadyExists`).

**Type/function renames:**
- `fmt.Formatter` → `Alt`
- `fmt.format` → `std.Io.Writer.print`
- `fmt.FormatOptions` → `Options`
- `fmt.bufPrintZ` → `bufPrintSentinel`
- `compress` lzma/lzma2/xz updated to Io.Reader/Writer.
- `DynLib`: Windows support removed; use `LoadLibraryExW` + `GetProcAddress` directly.
- `math.sign`: returns smallest fitting integer type.
- Auto root cert fetching on Windows triggered.
- `tar.extract`: path traversal sanitization.
- `BitSet`, `EnumSet`: `initEmpty`, `initFull` → decl literals.

---

## Build System

- Ability to override packages locally.
- Fetch packages into project-local directory.
- Unit test timeouts.
- `--error-style` flag.
- `--multiline-errors` flag.
- Temporary Files API.

---

## Compiler

- C translation reworked: build-system-based, deprecates runtime `@cImport`.
- LLVM 21 backend.
- Reworked byval syntax lowering (related to forbidding runtime vector indexes).
- Reworked type resolution: simplified rules, enhanced compile errors.
- Incremental compilation improvements.
- x86 backend: native code-gen improvements.
- aarch64 backend: native code-gen improvements.
- **WebAssembly backend: code-gen enhancements.**
- Generating import libraries from `.def` files without LLVM (Windows build speed).
- Improved code-gen of for-loop safety checks.

---

## Linker

- New ELF linker (performance + correctness for ELF targets).

---

## Fuzzer

- AST smith fuzzer (finds compiler bugs through generated code).
- Multiprocess fuzzing.
- Fuzzing infinite mode.
- Crash dumps.
- Numerous bugs found + fixed via AST smith.

---

## Bug Fixes

This release contains bugs (community reporting encouraged).

---

## Toolchain

- **LLVM 21** (loop vectorization disabled as workaround for regression).
- musl 1.2.5.
- glibc 2.43.
- Linux 6.19 headers.
- macOS 26.4 headers.
- MinGW-w64 updated.
- FreeBSD 15.0 libc.
- WASI libc updated.
- Vendored Zig libc updated.
- `zig cc` cross-compilation improvements.
- Dynamically-linked OpenBSD libc cross-compilation supported.

---

## Roadmap

See https://github.com/ziglang/zig#roadmap for plans toward 1.0.
