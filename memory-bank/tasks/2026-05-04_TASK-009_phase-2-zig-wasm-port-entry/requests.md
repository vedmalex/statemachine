# User Requests

## UR-001

- Timestamp: 2026-05-02 22:42 (carry-forward from legacy TASK-001)
- Source: user
- Text (verbatim): "Bootstrap standalone statemachine monorepo (TypeScript extraction)"
- Phase 2 status: SATISFIED by Phase 1 (TASK-002..007 ARCHIVED). Carry-forward for traceability only.

## UR-002
- Timestamp: 2026-05-04 14:42
- Source: user
- Text (verbatim): "Extract @grainjs/statemachine into a standalone, framework-agnostic library with zero @grainjs runtime dependencies, publishable independently to public npm, and intended as the foundation for MB3 development at /Users/vedmalex/work/agent-skills."

## UR-003
- Timestamp: 2026-05-04 14:42
- Source: user
- Text (verbatim): "Place statemachine and di-ioc into a separate dedicated monorepo (multi-package). Any third-party or grainjs-derived dependency must be either extracted into its own publishable package or kept as a separate integration package — never silently inlined into the core."

## UR-004
- Timestamp: 2026-05-04 14:42
- Source: user
- Text (verbatim): "Drop DI from the statemachine core. Remove src/di.config.ts and src/tests/di_integration.test.ts; replace any internal DI usage with constructor injection or factory hooks. di-ioc remains an independent package; any DI bridge is a separate integration package."

## UR-005
- Timestamp: 2026-05-04 14:42
- Source: user
- Text (verbatim): "Stabilize the current public API and ship the first public npm release as 1.0.0-beta.x. A future API redesign through the WIB lens is a separate task and is explicitly out of scope here."

## UR-006
- Timestamp: 2026-05-04 14:42
- Source: user
- Text (verbatim): "The standalone library must support Bun, Node 20+ LTS, Browser, and Deno/Edge runtimes. Provide ESM and CJS builds with proper exports map; the default core entry must avoid Node-specific APIs (fs, path, etc.) so it stays portable."

## UR-007
- Timestamp: 2026-05-04 14:42
- Source: user
- Text (verbatim): "Enforce TypeScript strict + exactOptionalPropertyTypes, ≥90% test coverage on the public API, auto-generated TypeDoc API documentation, and an examples cookbook covering core use cases (basic transitions, hierarchy, validation, persistence, monitoring)."

## UR-008
- Timestamp: 2026-05-04 14:42
- Source: user
- Text (verbatim): "CI/CD must run via GitHub Actions under the personal vedmalex account, managed through the gh CLI. The new monorepo is hosted at github.com/vedmalex/<repo> initially, with the option to move to a dedicated GitHub organization later."

## UR-009
- Timestamp: 2026-05-04 14:42
- Source: user
- Text (verbatim): "Plan for a full Zig/WASM rewrite of the core in a follow-up task. Workflow: snapshot/copy the project into the new monorepo, complete the TypeScript extraction, then build the Zig core plus WASM bridge in the same monorepo and integrate it with the existing JS surface. The TypeScript design in this task must stay WASM-friendly (data-oriented, declarative-friendly, minimal closures/reflection)."

## UR-010
- Timestamp: 2026-05-04 14:42
- Source: user
- Text (verbatim): "Provide documented extension points in the monorepo so future integration packages (DI bridge, MB3 DSL, persistence adapters, observability, etc.) can plug into the core without forking the core package."

## UR-011
- Timestamp: 2026-05-04 14:43
- Source: user
- Text (verbatim): "Package names on public npm must be available without requiring a paid npm organization (personal scope or unscoped). Verify availability via `npm view <name>` and confirm final names with the user before the first publish."

## UR-012
- Timestamp: 2026-05-04 14:43
- Source: user
- Text (verbatim): "Phase 2 entry — zig-wasm-port. Decompose RM-001-P02 into actionable child tasks (TASK-010+) per UR-009, lock the child-task DAG, and resolve open questions Q-T9-1..Q-T9-13 before subagent dispatch."

## UR-013
- Timestamp: 2026-05-26
- Source: user
- Text (verbatim): "mb3 давай будем использовать tiger style ZTB для разработки этой библиотеки"
- Scope (operator-clarified): Apply TigerStyle methodology (`/Users/vedmalex/work/agent-skills/docs/methodology/tiger-style-methodology.md`) + ZTB lens (`/Users/vedmalex/work/agent-skills/docs/methodology/ztb-lens.md`) to ALL library packages — TS core (`packages/statemachine/`), Zig core (`packages/statemachine-zig/`, to be created in TASK-010), and any integration packages.
- Cross-cutting impact: re-frames TD-T9-1..TD-T9-13 through Safety > Performance > DX priority order; makes ZTB lens authoritative for IMPLEMENT / QA / CODE_REVIEW DA gates from this point forward.
