# Claude Instructions

## MB3 Workflow

This repository must be operated through the MB3 workflow.
- Start MB3 work through `mb3` and keep meaningful changes task-backed.
- Use canonical MB3 phases (`VAN -> CREATIVE -> PLAN -> TECH_SPEC -> IMPLEMENT -> QA -> CODE_REVIEW -> REFLECT -> ARCHIVE`) unless the active tier intentionally skips some phases.
- Treat `mb3-critic` as the authoritative Devil's Advocate gate for DA-reviewed phase exits.

### Core MB3 Skills

- `mb3` — unified router and intake entrypoint
- `mb3-phases` — phase execution and exit criteria
- `mb3-critic` — authoritative DA gate and adversarial review
- `mb3-commit` — commit/backlog integration for MB3 tasks

### Common MB3 Commands

- `mb3 create "Task name"`
- `mb3 status`
- `mb3 phase check-exit`
- `mb3 task advance`

### Specialist Routing Hints

- `mb3-orchestration-intake` — use when roadmap-backed startup must be shaped and no valid `orchestration_packet` exists yet
- `mb3-smart-executor` — use when a valid `orchestration_packet` already exists and downstream roadmap execution should continue
- `mb3-critic` — use for DA / critic review at gated phase exits or when you want adversarial review

### DA Gate Emission Policy

- Authoritative DA clearance MUST come from `Agent(subagent_type="mb3-critic")` captured by the post-tool hook.
- Never emit `da_reviewed`, `da_verdict`, `critic_verdict`, or `tier_change` via CLI `event emit` or MCP `mb3_event`. The runtime rejects these paths as RUNTIME_OWNED.
- Advisory `da_review` event remains open for non-authoritative notes; use it for advisory verdicts that do NOT clear gates.
- If the hook silently fails to persist a legitimate critic review, diagnose with `MB3_HOOK_TRACE=1`; do not fabricate a replacement emit.

## Project context

See `AGENTS.md` for full project description, repo topology, dev commands, and code style.
