# @vedmalex/statemachine-monorepo

Monorepo root. See [packages/statemachine/README.md](packages/statemachine/README.md) for the main package documentation.

## MB3 work tree

This repository hosts the source code only. Memory Bank 3.0 task tracking, plans, DA reviews, and the `Statemachine Standalone Evolution` roadmap (`RM-001`) live in a sibling work tree:

- Path: `/Users/vedmalex/work/grainjs-prod/packages/statemachine/memory-bank/`
- Program scope: `tasks/2026-05-02_TASK-001_bootstrap-standalone-statemachine-monore/artifacts/orchestration-packet.md`
- Active task lifecycle artifacts: `memory-bank/tasks/<DATE>_<TASK-ID>_<slug>/` (one directory per task — `_task.md`, `plan.md`, `tech_spec.md`, `implementation.md`, `qa.md`, `code-review.md`, etc.)

Subagents dispatched against tags in this repo (e.g., `bootstrap-source-stable`) MUST consult the MB3 work tree for requirements, acceptance criteria, ISSUES.md, and DA history before authoring artifacts.
