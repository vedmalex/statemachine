# TASK-012: SCXML/UML-correct composite regions: ancestor-first entry/exit + all-final join

- **Profile**: creative-first
- **Tier**: T4:standard
- **QA Level**: MAX
- **Execution Mode**: sequential
- **Status**: completed
- **Phase**: ARCHIVE
- **Created**: 2026-06-15T07:49:34Z
- **Updated**: 2026-06-21T09:42:38Z
- **Branch**: fix/regions-ancestor-entry-and-final-join

## Scope

- packages/statemachine: standards-first region semantics — uniform region expansion across all entry paths
- SCXML ancestor-first entry / descendant-first exit
- parallel-exit (LCCA) join matching
- UML all-regions-final join via State.final?/done.state.<C>/isDone(). Plan-driven via .plan/regions-entry-bugfix. NOT related to TASK-009 (Zig WASM port).

## UR Coverage

- [x] UR-001 — covered
- [x] UR-002 — covered

## Notes

- DA outcome: PROCEED (advisory). mb3-critic returned a consistent PROCEED verdict across 5 runs (CREATIVE lens: Design Integrity + UR-Goal Traceability; UR-A..UR-E all COVERED; zero CRITICAL/HIGH/MEDIUM findings; one LOW advisory: no discrete requests.md, URs derived from scope+PLAN). Authoritative gate auto-clearance is BLOCKED by a hook envelope-capture defect: the PostToolUse/SubagentStop handler parses event.lastAssistantMessage for a balanced JSON object with schema=mb3-critic.review/v2 (collectCriticReviewEnvelopeCandidates in plugins/_shared/runtime/mb3-core.ts), but the mb3-critic subagent emits a prose report without the literal envelope block, so every run reports missing_envelope. Not fabricating da_reviewed via CLI/MCP (RUNTIME_OWNED, forbidden by CLAUDE.md). Per user decision, proceeding on the prose PROCEED. Engineering is complete and independently verified: full suite 379 pass, typecheck/lint/api:check green, 41 commits on fix/regions-ancestor-entry-and-final-join, MINOR changeset. Task left at CREATIVE in the MB3 runtime pending an infra fix to the critic envelope emission/capture.
- RECONCILED (2026-06-21, REFLECT, authoritative) — supersedes the stale prior-session note. Current state: phase REFLECT, closing; engineering complete + independently re-verified (workflow verdict=implemented/high). Tests 391/391 green, 0 fail (full suite); region hierarchical+config_validator 51/51. The previously-flaky ServerAdapter test is GREEN this run (reconciled in QA evidence AEV-0003; flake tracked out-of-scope). DA gates cleared this session (hook-captured authoritative): IMPLEMENT/Plan Fidelity PROCEED, QA/Coverage PROCEED, CODE_REVIEW/Sustainability PROCEED; REFLECT/Honesty being reconciled by this note. UR-001+UR-002 COVERED. SUPERSEDED: the earlier 'full suite 379 pass / 41 commits / Task left at CREATIVE pending envelope-capture infra fix' narrative is historical and no longer reflects state — the envelope-capture issue was worked around (critics emit a bare JSON envelope, verdicts hook-captured), the task advanced through IMPLEMENT->QA->CODE_REVIEW->REFLECT with authoritative gates, and the verified test total is now 391/391 (not 379).
