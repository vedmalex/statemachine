---
event_store_revision: 7
event_store_hash: bb877c95ff027414d294d71c4b5f4b7c271d4e0f57fd70692549753e26b2d6b6
materialized_at: 2026-07-22T13:43:30.158Z
materialized_by: materialize_verb
---
# Implementation — TASK-017

## Changes Made

1. `packages/statemachine/vitest.config.ts` (e50706e): `thresholds` block (90/90/90/90) REMOVED — coverage stays REPORTED (reporters + CI step untouched) but never gates; replacement comment documents the decision + reintroduction rule; `src/sim/**` exclude kept and its comment reworded to report-scope rationale (e321796).
2. `packages/statemachine/etc/statemachine-sim.api.md` (f2523bf, UR-003): report-only api-extractor refresh — the committed report predated the beta.4 surface; drift was invisible because the job always died at the coverage step first.
3. Doc consistency (e321796 + managed writes): AGENTS.md dev-commands line, ARCH.md (2 lines, via managed put), CODING_RULES.md 'Coverage threshold' section — all now state reported-not-gated with the reintroduction rule; FT-001 tracks the optional floor comeback.

## Files Modified

- `packages/statemachine/vitest.config.ts` (e50706e, e321796)
- `packages/statemachine/etc/statemachine-sim.api.md` (f2523bf)
- `AGENTS.md` (e321796; diff also carried ~55 lines of pre-existing unstaged MB3 managed-block boilerplate — disclosed, harmless)
- `memory-bank/system/ARCH.md`, `memory-bank/system/CODING_RULES.md` (managed mb3 writes, committed with the trail)

## Key Decisions

1. Remove the gate rather than chase 0.13% branch coverage — explicit user directive («больше нигде не мешается, и тут пусть не мешается совсем»); resolves REQ-001.
2. Keep the coverage step + reporters — informational visibility at ~zero cost.
3. Fix the newly-exposed stale sim api.md INSIDE this task (UR-003) — it blocked the actual deliverable (green CI); report-only, no behavior change (CD-63 not implicated).
4. Reintroduction rule: a coverage gate returns ONLY together with the tests that satisfy it (FT-001, low priority).
5. Remediation traceability for DA rounds 2-4 anchors to finding IDs (F-IMPL-*), not task URs. Mechanism correction (F-IMPL-VERIFY3-1): the flawed section text carrying an auto-captured cross-namespace ur_ref was eliminated by the store's REPLACE-mode write, which COMPACTS the per-section event history (last-write-wins — the flawed event no longer exists anywhere in the log; grep for the token returns zero matches task-wide). This is IN-PLACE REPLACEMENT, NOT event-sourcing supersession — the earlier 'replacement event supersedes' wording was inaccurate and is corrected here; the store's semantic-upsert path is not append-only-with-supersession-pointers (see also the F-IMPL-VERIFY3-2 advisory on missing event_id/OCC fields on that path).

## Commit Trail

- `e50706e` ci(TASK-017): drop the 90% coverage threshold gate — coverage is reported, not gated
- `f2523bf` chore(TASK-017): refresh stale statemachine-sim.api.md report → CI run 29916577239: ALL FOUR legs SUCCESS — first fully-green CI on main since 2026-06-15; Sim Seed-Sweep 29916577413 SUCCESS
- `e321796` docs(TASK-017): purge stale ≥90% coverage-gate claims from AGENTS.md + vitest comment (incl. disclosed ride-along of pre-existing MB3 managed-block boilerplate)

## UR Coverage

UR-002: thresholds block removed from vitest.config.ts (e50706e); reporters + CI step + src/sim/** exclude kept; CODING_RULES.md 'Coverage threshold' section updated to document the removal + reintroduction rule (DA F-IMPL-1); FT-001 files the optional reintroduction backlog item (DA F-IMPL-3).

UR-003: etc/statemachine-sim.api.md regenerated via `npm run build && npm run api:check:sim` (api-extractor --local) and committed as f2523bf (+26 lines; CoverageScenario.overflow/snapshotRestore/transitionTimeout/faults, fireMany/faultRecordsList, overflow+transitionTimeout scenarios). Report-only — no src/dist change in the commit; core statemachine.api.md untouched.

## DA remediation round 2 (F-IMPL-VERIFY)

- **F-IMPL-VERIFY-1 (HIGH):** stale ≥90% claims purged from BOTH remaining surfaces — the AGENTS.md dev-commands line (now 'reported only, NOT gated (TASK-017/REQ-001)') and ARCH.md lines 39/90 (via the managed `mb3_artifact put scope=system name=arch` path — direct Edit is hook-blocked; Updated date bumped to 2026-07-22). The PRD's historical Phase-1 coverage line (PRD.md:18, PRD-scoped numbering) deliberately left untouched as a historical record, per the original finding's own guidance.
- **F-IMPL-VERIFY-2 (LOW):** vitest.config.ts src/sim exclude comment reworded (report-scope rationale, no gate reference); tsconfig_isolation.test.ts still 4/4 pass.
- Commit e321796 (AGENTS.md + vitest.config.ts). HONESTY NOTE: the AGENTS.md diff also carried ~55 lines of PRE-EXISTING uncommitted MB3 managed-block content (installed earlier by mb3_project init/trace repair, identical to the CLAUDE.md blocks) that rode along; runtime-managed boilerplate, no functional effect.
- F-IMPL-4: advisory carry-forward (evidence-strength note only).
- Round-3/4 corrections (F-IMPL-VERIFY2-1/2, F-IMPL-VERIFY3-1): sections are written through the event path WITHOUT in-content headers (the materializer supplies them; the duplicate-header artifact and the discarded pre-event direct-markdown write are gone). The flawed text with the bare PRD UR token (auto-captured into ur_refs) was eliminated via the store's REPLACE-mode write, which COMPACTS per-section event history (last-write-wins; the flawed event no longer exists in any log — in-place replacement, NOT event-sourcing supersession; the earlier wording claiming supersession was inaccurate and is corrected). Remediation traces to DA finding IDs, not task URs.
