# Architecture — @vedmalex/statemachine

Updated: 2026-05-04

## Overview

Standalone TypeScript hierarchical state machine library. Lite-only DI-free public surface. ESM + CJS dual emission.

## Repository topology

```
/Users/vedmalex/work/statemachine/        ← standalone repo root (monorepo)
├── packages/
│   └── statemachine/                      ← primary package (@vedmalex/statemachine)
│       ├── src/
│       │   ├── index.ts                   ← curated public surface (5 firm @stable + @unstable types)
│       │   ├── lite.ts                    ← createMachine factory
│       │   ├── state_machine.ts           ← StateMachine class
│       │   ├── types.ts                   ← interfaces (IMonitor, ITimerScheduler, IErrorHandler, ILogger, Adapter, etc.)
│       │   ├── monitoring.ts              ← StateMachineMonitor + createDefaultMonitor
│       │   ├── scheduler.ts               ← TimerScheduler + createDefaultScheduler
│       │   ├── error_handling.ts          ← ErrorHandler + createDefaultErrorHandler
│       │   ├── adapters.ts                ← MemoryAdapter et al
│       │   ├── config_validator.ts        ← validateConfig / validateConfigStrict / isValidConfig
│       │   ├── logger.ts                  ← internal Logger (not public)
│       │   ├── presets.ts                 ← examples (excluded from coverage + dist)
│       │   ├── security.ts                ← @deprecated source-tree marker (not in dist)
│       │   └── tests/                     ← vitest test suite (29 files; 353 tests; ABI tests at tests/abi/)
│       ├── docs/
│       │   ├── extension-points.md        ← EP-1..EP-7 catalog
│       │   ├── zig-port-considerations.md ← Phase 2 RM-001-P02 architectural notes
│       │   └── api-html/                  ← TypeDoc output (deployed to gh-pages)
│       ├── etc/
│       │   └── statemachine.api.md        ← api-extractor surface snapshot (CI ratchet)
│       ├── test/                          ← smoke fixtures (cjs-smoke, deno-smoke, browser, verify-dist)
│       ├── tsconfig.json                  ← strict TS (8 flags)
│       ├── tsconfig.build.json            ← --emitDeclarationOnly profile
│       ├── tsup.config.ts                 ← ESM+CJS dual emit (target node18)
│       ├── vitest.config.ts               ← coverage thresholds (≥90% all metrics)
│       ├── knip.json                      ← unused-exports auditor
│       ├── api-extractor.json             ← surface-snapshot config
│       ├── playwright.config.ts           ← browser smoke
│       ├── STABILITY.md                   ← stability policy doc
│       ├── README.md                      ← package readme (CI badges + docs links)
│       ├── package.json                   ← @vedmalex/statemachine, type:module, exports map
│       ├── CHANGELOG.md                   ← Changesets-generated
│       └── etc.
├── examples/integration/                  ← 3 sample EP integrations (Bun workspace members)
│   ├── custom-adapter/
│   ├── observability-injection/
│   └── persistence-adapter/
├── .changeset/                            ← Changesets config + pre.json + pending changesets
├── .github/workflows/                     ← ci.yml (Tier A+B), release.yml, docs.yml
├── memory-bank/                           ← MB3 work tree (post-TASK-008 migration)
│   ├── system/                            ← project-config, current-context, ARCH/PRD/ISSUES/CODING_RULES
│   └── tasks/                             ← per-task artifacts (TASK-008+)
├── RELEASING.md                           ← operator playbook
├── bunfig.toml
├── bun.lock
├── package.json                           ← workspaces: ["packages/*", "examples/integration/*"]
└── README.md                              ← root README
```

## Public API surface (5 firm @stable symbols)

1. `createMachine` — factory (lite.ts)
2. `StateMachine` — class (state_machine.ts)
3. `StateMachineConfig` — interface (types.ts)
4. `Transition` — type (types.ts)
5. `State` — type (types.ts)

All other exports: `@unstable` per package-level JSDoc default (see `src/index.ts`). See `STABILITY.md` for full policy.

## Extension points (EP-1..EP-7)

7 injection contracts for host integration (see `docs/extension-points.md`):

- EP-1 IMonitor (observability)
- EP-2 ITimerScheduler (timer host)
- EP-3 IErrorHandler (error recovery)
- EP-4 Adapter<T> (host data binding)
- EP-5 ILogger (logging)
- EP-6 StatePersistenceAdapter (persistence)
- EP-7 validateConfig / validateConfigStrict / isValidConfig (config validation)

## Build pipeline

- `tsup` (esbuild-based) → ESM `dist/index.js` + CJS `dist/index.cjs` + sourcemaps
- `tsc --emitDeclarationOnly` → `types/*.d.ts`
- Coverage gate ≥90% all 4 metrics via vitest+@vitest/coverage-v8
- knip + api-extractor in CI for surface drift detection

## CI/CD

- **ci.yml**: Tier A (Bun + Node 18 + Node 20, blocking) + Tier B (Deno + Browser, allowed-fail under beta)
- **release.yml**: workflow_dispatch trigger; bun publish via .npmrc literal-token; routes pre-release to `beta` dist-tag
- **docs.yml**: TypeDoc → gh-pages on main push or manual

## Stability policy

- `@stable` — firm contract; SemVer major bump on breaking change (5 symbols)
- `@unstable` — may change between minor versions; not bound by SemVer (most exports today)
- `@deprecated` — will be removed; consumer migration required

`etc/statemachine.api.md` is the canonical machine-checked surface ratchet. STABILITY.md is the human-readable policy doc.
