# KICKOFF — regions-entry-bugfix (v2, standards-first)

Paste the block below to start (or resume) execution. The executor dynamic-workflow runs **T0–T16** (code + gates + changeset); **T17 (docs)** and **T18 (llm-wiki)** are **MAIN-SESSION** terminal steps. `progress.jsonl` is the resumable source of truth — a crash/stop is recovered by re-pasting the same prompt.

---

## Kickoff prompt (copy from here)

> Execute the **regions-entry-bugfix v2** plan (standards-first SCXML/UML; no back-compat constraint), ultracode mode.
>
> 1. Read `/Users/vedmalex/work/statemachine/.plan/regions-entry-bugfix/PLAN.md`, `progress.jsonl`, and `state.json` to see what's already `done`.
> 2. Launch the executor with the **Workflow** tool:
>    - **First run:** `Workflow({ scriptPath: "/Users/vedmalex/work/statemachine/.plan/regions-entry-bugfix/execute-workflow.js" })`
>    - **Resume after crash/stop:** read `state.json.executionWorkflowRunId`; if present, `Workflow({ scriptPath: ".../execute-workflow.js", resumeFromRunId: "<that runId>" })`. (Each agent also self-skips `done` tasks via `progress.jsonl`.)
>    - Record the launched **Run ID** into `state.json.executionWorkflowRunId` immediately.
> 3. The executor runs `T0 → T1 → T2 → T5 → T6 → T7 → T3 → T4 → T9 → T8 → T10 → T11 → T13 → T12 → T14 → T15 → T16` **sequentially** (all touch `state_machine.ts`). Each task: implement per PLAN.md → run its vitest/npm **checkpoint** → on green update `progress.jsonl` + commit on branch `fix/regions-ancestor-entry-and-final-join` → on red halt (no fake green).
> 4. When the executor completes, reconcile `progress.jsonl` and report done/halt/next.
> 5. If it **halts** on a task, diagnose that checkpoint failure, fix in-scope, then resume from step 2.
> 6. After **T16** is green, run **T17 (DOCUMENTATION)** and **T18 (LLM-WIKI)** in THIS main session:
>    - T17: edit `packages/statemachine/README.md` + add `packages/statemachine/docs/regions-and-parallel.md` per the PLAN.md T17 spec (runnable examples mirroring passing tests).
>    - T18: invoke `Skill(llm-wiki-router)` — the wiki does not exist yet, so init/create it via the router first, then ingest the region/composite/parallel/join semantics from the new docs + tests, then run the wiki lint/maintain check.
> 7. Obtain authoritative DA clearance via `Agent(subagent_type="mb3-critic")` before declaring done (repo MB3 policy). Propose the commit range / PR.

---

## Guardrails
- **Standards-first:** SCXML/UML correctness over compatibility. Non-standard existing tests get **rewritten to spec**, not preserved. No opt-out flags.
- **Never commit to `main`** — branch `fix/regions-ancestor-entry-and-final-join`.
- **vitest, not bun.** Checkpoints in PLAN.md are normalized (`npx vitest run`, `npm run check/api:check/knip`, `npx changeset status`).
- **Baseline:** T0 records the pre-fix suite count; the one pre-existing **ServerAdapter** failure is **expected** and must not be read as a regression at T14.
- **Order-insensitive assertions only** — `|` composite order is map-insertion dependent.
- **Reviewer-found hazards (do not regress):** gate `done.state` emission on `events.has(...)` (avoid fatal Invalid-event crash); exclude `done.state.*` from `*` wildcard; all-final detection by atomic-leaf scan over the static regions tree (never `configMap.get`); wrap the early `updateState` so a `validateCompositeState` throw aborts cleanly.

## Config surface (LOCKED) & public API impact
- `State.final?: boolean` marks a region's final leaf. Join authored as a transition on the engine event **`done.state.<C>`** (recommended; only enqueued at all-final) OR guarded by **`isDone('C')`**. Disambiguation is by **trigger**: plain `from:'C'` on a user event = ANY-leaf parallel-exit; `done.state.<C>` fires only at all-final.
- `State.final` + public `isDone()` widen the **@stable** surface → `etc/statemachine.api.md` regen + `public_surface.test.ts` ratchet update + **MINOR** changeset.

## Resume protocol
- `progress.jsonl` = per-task status (`pending|in_progress|done|blocked`) + `commit` + `evidence` + `updatedAt`; `runner` ∈ executor|main-session.
- `state.json` = run-level pointer: `branch`, `executionWorkflowRunId`, `baseline`, `completed`, config surface.
- Next actionable = lowest-id `pending` whose `dependsOn` are all `done`. Re-pasting the kickoff is always safe.

## Open questions (defaults locked in PLAN.md; flag if you disagree)
1. done.state cascade: single-pass innermost-first with a per-config emitted-id Set (assumed).
2. `isInState` strict every-expected-part ancestor-or-equal (assumed).
3. `done.state.<C>` uses the fully-qualified dotted id (e.g. `done.state.robot.mode.auto`) — acceptable as an event key?
4. `REGION_MISSING_INITIAL` advisory fires for every region lacking explicit initial (noise vs signal).
5. Add a public `isFinal(stateId)` leaf predicate alongside `isDone(compositeId)`?
6. Degenerate all-final **initial** config — raise `done.state` at construction, or treat as no-op?
