# Product Requirements — @vedmalex/statemachine

Updated: 2026-05-04

## Vision

A standalone, framework-agnostic, WASM-friendly hierarchical state machine library for TypeScript. Lite-only DI-free public surface. Multi-runtime support (Bun + Node 18/20 primary; Deno + Browser tracked).

## Phase 1 (RM-001-P01 bootstrap-extraction) — DELIVERED

Goals achieved:
- ✅ UR-001: standalone monorepo extracted from grainjs-prod with zero @grainjs runtime deps
- ✅ UR-002: zero @grainjs deps in published artifact
- ✅ UR-003: multi-package monorepo (Bun workspaces, packages/statemachine layout)
- ✅ UR-004: DI removed from core
- ✅ UR-005: strict TypeScript with exactOptionalPropertyTypes (8 flags)
- ✅ UR-006: CI/CD pipeline with multi-runtime matrix + Changesets release
- ✅ UR-007: ≥90% test coverage on all 4 metrics
- ✅ UR-008: GitHub repo + push + CI green + first publish
- ✅ UR-009: WASM/Zig-friendly design (singletons eliminated; injection contracts)
- ✅ UR-010: API docs (TypeDoc) + EP catalog + 3 integration examples + STABILITY policy
- ✅ UR-011: NPM_TOKEN + scope claim + first 1.0.0-beta.1 publish

## Phase 2 (RM-001-P02 zig-wasm-port) — NOT STARTED

Out of scope until explicit operator decision. Architectural prerequisites documented in `docs/zig-port-considerations.md`:
- §1 Architectural prerequisites (no module-level mutable state; injection via options; pure factories)
- §2 TS-vs-WASM access modifier divergence
- §3 Mutable-state audit (best-effort baseline)
- §4 Per-instance observability trade-off
- §5 Open questions for the actual Zig port (deferred)

## Phase 3+ (future)

- MB3 DSL adoption
- grainjs-prod consumer migration
- WIB-driven public API redesign (post-1.0.0)

## Stability commitments

- `1.0.0-beta.x` line: pre-release; surface may evolve without SemVer breakage.
- `1.0.0` stable graduation: requires `bunx changeset pre exit`; firm `@stable` contract.
- 5 firm `@stable` symbols (createMachine, StateMachine, StateMachineConfig, Transition, State) — changing their signatures post-1.0.0 is a major bump.

## Non-goals (Phase 1)

- Not exposing internal monitoring/scheduler/logger as public API
- Not bundling @grainjs DI container (intentionally excluded)
- Not supporting Node < 18 (engines.node ">=18")
- Not auto-publishing on every main push (manual workflow_dispatch trigger)
