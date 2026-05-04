# AGENTS.md — @vedmalex/statemachine

> **Standalone repo with embedded MB3 (Memory Bank 3.0) work tree at `memory-bank/`.**

## AI Development Workflow

**YOU MUST USE `.cursor/rules/memory-bank-3.0.md` as the MAIN DEVELOPER WORKFLOW.**

This file contains the complete Memory Bank 3.0 system specification with:
- Unified development lifecycle management (VAN → CREATIVE → PLAN → TECH_SPEC → IMPLEMENT → QA → CODE_REVIEW → REFLECT → ARCHIVE)
- Phase-based permissions and DA gate workflows (mb3-critic authoritative)
- LEVER framework integration (mb3-lever advisory)
- Comprehensive quality assurance via mb3-tester / mb3-implementer / mb3-planner

**DO NOT** deviate from the memory-bank-3.0.md specification.

## Project information

- **Name**: `@vedmalex/statemachine`
- **Type**: Hierarchical state machine library for TypeScript (lite-only DI-free)
- **Repo**: https://github.com/vedmalex/statemachine
- **npm**: https://www.npmjs.com/package/@vedmalex/statemachine
- **Docs**: https://vedmalex.github.io/statemachine/

## Repository topology

- `packages/statemachine/` — primary package (`@vedmalex/statemachine`)
- `examples/integration/` — 3 sample EP integrations (Bun workspace members)
- `.github/workflows/` — ci.yml (Tier A+B), release.yml, docs.yml
- `.changeset/` — Changesets pre-release config
- `memory-bank/` — MB3 work tree (system/, tasks/)
- `RELEASING.md` — operator publish playbook

## Development commands

- **Install**: `bun install` (root) — supports `workspace:*` protocol natively
- **Build**: `bun run --cwd packages/statemachine build` — produces ESM + CJS + .d.ts
- **Test**: `bun run --cwd packages/statemachine test` — vitest run
- **Coverage**: `bun run --cwd packages/statemachine test:coverage` — ≥90% all 4 metrics
- **Lint**: `bun run --cwd packages/statemachine knip` — unused-exports auditor
- **API check**: `bun run --cwd packages/statemachine api:check` — api-extractor surface ratchet
- **CJS smoke**: `bun run --cwd packages/statemachine test:cjs-smoke`
- **Docs**: `bunx typedoc` from packages/statemachine/

## Package manager

This project uses **Bun** as the primary package manager. `npm` is supported via `--no-workspaces` flag where needed.

## Code style

- **Language**: Code and JSDoc in English
- **Response language to operator**: Russian (per project preference)
- **Formatting**: 2 spaces, no tabs
- **Strict TypeScript**: 8 flags from TASK-003 (see CODING_RULES.md)
- **Public API discipline**: 5 firm `@stable` symbols + `@unstable` default; api-extractor ratchet enforces

## MB3 work tree

- `memory-bank/system/` — project metadata (project-config.json, current-context.md, ARCH.md, PRD.md, CODING_RULES.md, ISSUES.md, registries)
- `memory-bank/tasks/<DATE>_<TASK-ID>_<slug>/` — per-task artifacts

Phase 1 (RM-001-P01) task artifacts (TASK-002..007) live at the legacy work tree at `/Users/vedmalex/work/grainjs-prod/packages/statemachine/memory-bank/` for historical reference. New tasks are authored here.

## DA gate emission policy

- Authoritative DA clearance MUST come from `Agent(subagent_type="mb3-critic")` captured by the post-tool hook.
- Never emit `da_reviewed`, `da_verdict`, `critic_verdict`, or `tier_change` via CLI `event emit` or MCP `mb3_event` — runtime rejects these paths as RUNTIME_OWNED.
- Advisory `da_review` event remains open for non-authoritative notes.
