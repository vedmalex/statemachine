# TASK-011: Normalize dispatch inputs and simplify callback contract

- **Profile**: creative-first
- **Tier**: T3:moderate
- **QA Level**: STANDARD
- **Execution Mode**: sequential
- **Status**: completed
- **Phase**: VAN
- **Created**: 2026-05-06T07:16:01Z
- **Updated**: 2026-05-06T07:31:38Z
- **Parent**: TASK-009
- **Continues**: TASK-009
- **Continuation reason**: Consumer-side MB3 plugin state machines had to add a shared `resolveAdaptee` helper because callbacks currently receive adapter-shaped inputs. Investigate whether statemachine should normalize inputs once at the dispatch boundary and expose one callback contract, while keeping the surface small and Zig-port-friendly.

## Description

Explore whether statemachine should normalize adapter/object inputs once at the dispatch boundary and expose one callback contract to consumers, rather than requiring every consumer to unwrap adapters locally. Keep the API surface minimal and aligned with the eventual Zig/WASM port: no new public helper unless it materially improves the core contract.

## Scope

- packages/statemachine/src/state_machine.ts
- packages/statemachine/src/types.ts
- packages/statemachine/src/index.ts
- packages/statemachine/src/tests/**
- packages/statemachine/docs/zig-port-considerations.md

## Cross-Project Links

- artifact_source -> /Users/vedmalex/work/agent-skills :: TASK-312 (Fix plugins bun typecheck errors) [task_found]
  - Reason: Agent-skills TASK-312 added consumer-side `resolveAdaptee` normalization across multiple MB3 state machines after testing showed repeated adapter/adaptee boilerplate. Use that DX pain as concrete evidence for whether this library should absorb normalization internally instead of exporting a helper API.
  - Artifact refs: plugins/_shared/runtime/adaptee-utils.ts, plugins/workflow-plugins/coding-workflow/machines/phase-sm.config.ts

## Tags

- zig-port
- dx
- api
- adapter

## UR Coverage

- [ ] UR-001 — missing

## Notes

- Consumer evidence came from agent-skills TASK-312, where multiple MB3 state machines needed a shared `resolveAdaptee` helper to remove repeated adapter/adaptee boilerplate.
- Implemented dispatch-boundary callback owner normalization: config callbacks now receive the underlying owner object directly, with adapter unwrapping kept internal. Updated tests and docs. Verified with `bun run typecheck` and `bun run test` in packages/statemachine.
- DA cleared: mb3-critic verdict PROCEED. Contract is consistent across inline callbacks, adapter-backed string callbacks, and setContext() string callbacks. Verified with `bun run typecheck` and `bun run test` in packages/statemachine.
