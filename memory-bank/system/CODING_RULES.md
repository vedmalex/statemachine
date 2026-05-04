# Coding Rules — @vedmalex/statemachine

Updated: 2026-05-04

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
