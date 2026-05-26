# Coding Rules — @vedmalex/statemachine

Updated: 2026-05-26

## Methodology — TigerStyle + ZTB lens (UR-013, adopted 2026-05-26)

This project commits to the **TigerStyle methodology** for all library packages: TS core (`packages/statemachine/`), Zig core (`packages/statemachine-zig/`, created in TASK-010), and any future integration packages.

- **Reference:** `/Users/vedmalex/work/agent-skills/docs/methodology/tiger-style-methodology.md`
- **DA cross-lens:** `/Users/vedmalex/work/agent-skills/docs/methodology/ztb-lens.md`

### Priority order (non-negotiable)

```
Safety   >   Performance   >   Developer Experience
```

Conflicts resolve top-down. Trade-offs that sacrifice safety for the lower priorities must be explicit and justified in the affected artefact.

### ZTB lens activation

- **Auto-active** for any phase where `.zig` files appear in diff OR `packages/statemachine-zig/build.zig` exists in the working tree.
- **Active by methodology declaration** (this section) for TS-only diffs from the moment of adoption.
- Applies the full **ZTB-General** check set (G1–G13) plus **ZTB-Zig** (Z1–Z10) when Zig files are touched.
- `mb3-critic` envelope `lens` field includes `+ ZTB` suffix on IMPLEMENT / QA / CODE_REVIEW gates.

### Operative TigerStyle baselines for this project

- **Function cap:** 70 lines (TS + Zig). Helpers extract control flow upward; data-plane helpers stay branch-free.
- **Assertion density:** ≥2 ассерта в среднем на новую/изменённую функцию. Парные ассерты у писателя+читателя для критических инвариантов.
- **Operating vs programmer errors:** разделены типами возврата. TS — `Result<T, E>`-подобные union types или `throw` для programmer errors; Zig — `error{...}!T` для operating, `assert`/`unreachable` для programmer.
- **Hot path memory:** zero dynamic allocation. Pre-allocate capacity at `init`; pools instead of per-event `new`.
- **Static-width integers:** Zig — `u32`/`u64`/`i64`, не `usize` в бизнес-логике. TS — branded numeric types где off-by-one критичен.
- **Limits as first-class:** all loops/queues/buffers/timeouts have named upper-bound constants + fail-fast assert on breach.
- **Push ifs up, push fors down:** branches at the caller, loops near data.
- **Control plane / data plane separation:** validation/auth done once per batch; data plane is branch-free.
- **Naming:** существительные (не причастия), единицы в конце имени (`latency_ms_max`, не `max_latency_ms`), без сокращений (`source`/`target`, не `src`/`dst`).
- **`zig fmt` mandatory** before commit for any `.zig` file. Prettier mandatory for TS.
- **Comptime invariants:** wire-format structs MUST carry `comptime assert(@sizeOf(T) == N)`.
- **`errdefer`:** каждая `try gpa.alloc()` сопровождается `errdefer gpa.free(...)` сразу же.

### Conflict with existing rules

Where this section overlaps with sections below (e.g., coverage threshold, strict TypeScript), the stricter rule wins. TigerStyle never relaxes an existing baseline — it only tightens or adds.

---


## Public API discipline

- **5 firm `@stable` symbols** must not change signature without major version bump: `createMachine`, `StateMachine`, `StateMachineConfig`, `Transition`, `State`.
- All other exports are `@unstable` (package-level default in `src/index.ts` JSDoc).
- Adding a public export requires updating: `src/index.ts` re-export block, `etc/statemachine.api.md` (regenerate via `bunx api-extractor run --local`), `STABILITY.md` enumeration, `src/tests/public_surface.test.ts` ratchet.

## Strict TypeScript (8 flags from TASK-003 TD-T3-7)

- `strict: true`
- `exactOptionalPropertyTypes: true`
- `noImplicitOverride: true`
- `noUncheckedIndexedAccess: true` — use guard recipe by default; `!` non-null assertion only in syntactically-bound loops; CODE_REVIEW threshold >10 `!` per file flags as sustainability concern
- `noFallthroughCasesInSwitch: true`
- `noImplicitReturns: true`
- `noUnusedLocals: true` — use `_paramName` convention for intentional shape retention
- `noUnusedParameters: true`

## No singletons

Module-level mutable state is BANNED (per TASK-004 ISS-007/008 closure). All host-pluggable infrastructure (monitor, scheduler, errorHandler, logger, persistence) must be injected via `StateMachineOptions` or `Adapter<T>`. Default factories (`createDefault*`) provide per-instance instances.

## Knip discipline

- Cap `knip.json` `ignoreExports` (or equivalent suppression scope) at ≤5 entries (TASK-003 PLAN F-PL-5 governance).
- Each ignored entry MUST have a corresponding `implementation.md` line (`knip ignore: <symbol> — <justification>`).
- Adding 6th ignore requires CODE_REVIEW DA gate justification.

## Coverage threshold

- ≥90% on all 4 metrics (statements, branches, functions, lines) via vitest+@vitest/coverage-v8.
- Adding to `coverage.exclude` list requires per-entry justification in implementation.md.

## Public-surface ratchet

`src/tests/public_surface.test.ts` enforces:
- Exactly 2 `STABLE_SYMBOLS` runtime exports (createMachine, StateMachine).
- 16+ banned symbols absent (singletons, internal helpers, deprecated).

`src/tests/singleton_elimination.test.ts` enforces:
- No `static getInstance()` on exported classes or internal classes (TimerScheduler, StateMachineMonitor, ErrorHandler).
- Per-instance ref isolation (machineA.monitor !== machineB.monitor).
- Cross-machine non-aggregation (TD-T4-5 invariant).

## Build invariants

- `moduleResolution: "bundler"` (TASK-003 TD-T3-5 conditional closure; flip to node16/nodenext only if non-rewriting bundler is selected).
- `tsup target: 'node18'` matches engines.node ">=18".
- ESM + CJS dual emit with `outExtension` callback forcing `.js` for ESM and `.cjs` for CJS regardless of tsup default behavior.
- Single `npm run build` produces dist + types via `tsup && tsc --emitDeclarationOnly`.

## Release flow

- Pre-release: `.changeset/pre.json` mode=pre, tag=beta active.
- Author changeset with `patch` bump-type (pre-mode counter increments regardless; bump-type only affects post-`pre exit` graduation version).
- `bunx changeset version` consumes pending changesets.
- Operator triggers `release.yml` (workflow_dispatch); `bun publish --tag beta` routes to beta dist-tag.
- Tag `task-NNN-...-stable` after publish-verify; identity stitching documented in qa.md if HEAD diverges from publish source.

## CI/CD

- All Tier A jobs blocking: Bun + Node 18 + Node 20.
- Tier B (Deno, Browser) `continue-on-error: true` per ISS-006 (until 1.0.0 stable).
- api-extractor diff gate runs on Node 20 (canonical runner).
- knip skipped on Node 18 (knip@6 engine constraint requires Node ≥20.19); runs on Bun + Node 20.
