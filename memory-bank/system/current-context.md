# Current Context

Updated: 2026-05-04

## Project

**`@vedmalex/statemachine`** — standalone monorepo (forked from grainjs-prod/packages/statemachine in Phase 1).

- **Repo**: `/Users/vedmalex/work/statemachine/` (this work tree)
- **GitHub**: https://github.com/vedmalex/statemachine
- **npm**: https://www.npmjs.com/package/@vedmalex/statemachine — `1.0.0-beta.1` published
- **Docs**: https://vedmalex.github.io/statemachine/
- **HEAD**: `da884dc` (post-Phase-1 release.yml fix; tag `task-007-published-stable` at `b0492df`)

## Phase 1 (RM-001-P01 bootstrap-extraction) — CLOSED

All 6 child tasks ARCHIVED:

| Task | Tag | Closure |
|---|---|---|
| TASK-002 | `bootstrap-source-stable` (`1b2676b`) + `744326c` | core extraction + monorepo bootstrap |
| TASK-003 | `task-003-quality-baseline-stable` (`f0c8341`) | strict TS + vitest + coverage + JSDoc |
| TASK-004 | `task-004-wasm-friendly-stable` (`306e7b19`) | singleton elimination + IMonitor alignment |
| TASK-005 | `task-005-cicd-stable` (`ee26688`) | CI/CD + Changesets + tsup + multi-runtime matrix |
| TASK-006 | `task-006-docs-stable` (`2df4074`) | API docs + EP catalog + 3 examples + ABI tests |
| TASK-007 | `task-007-published-stable` (`b0492df`) | first 1.0.0-beta.1 npm publish |

## MB3 work tree migrated

Phase 1 used the MB3 work tree at `/Users/vedmalex/work/grainjs-prod/packages/statemachine/memory-bank/` (D15 repo bifurcation per orchestration packet). After Phase 1 closure, MB3 work tree is migrated to **THIS** repo at `/Users/vedmalex/work/statemachine/memory-bank/` (per TASK-008, post-roadmap operator addition).

Full Phase 1 task artifacts (creative-decisions/plan/tech_spec/implementation/qa/code-review/reflect for each TASK-002..007) remain at the legacy work tree as historical record. New tasks are authored in this work tree.

## Active Task

**TASK-009 — Phase 2 entry: zig-wasm-port (RM-001-P02)** — Phase: VAN.

Path: `memory-bank/tasks/2026-05-04_TASK-009_phase-2-zig-wasm-port-entry/`

Inputs prepared:
- `_task.md` — scope, open questions Q-T9-1..Q-T9-10, child-task hypothesis (TASK-010..016)
- `orchestration-packet.md` — Phase 2 starter packet for `mb3-smart-executor`

Next: VAN exit → CREATIVE → PLAN (locks child-task DAG) → `taskDecompose` function gate via `mb3-critic` → child dispatch.

## Active Roadmap

- **RM-001 Statemachine Standalone Evolution** — Phase 1 (P01 bootstrap-extraction) CLOSED. Phase 2 (P02 zig-wasm-port) ACTIVE via TASK-009 VAN entry.

## Known carry-forwards from Phase 1

- **KI-1 (TASK-007 post-archive)**: dist-tag `latest` → `beta` correction. Operator action: `npm dist-tag add @vedmalex/statemachine@1.0.0-beta.1 beta`.
- **TASK-005 carry-forwards**: knip Node 18 skip (engine constraint), `package-lock.json` deferred to post-1.0.0-stable.
- **TASK-004 carry-forward**: `ITimerScheduler.schedule()` uses `object` token; promotion to nominal `TimerToken` deferred to post-1.0.0.
- **TASK-006 carry-forward**: `api-extractor` surface ratchet active in CI (`etc/statemachine.api.md`); future tasks must regenerate on public-API changes.

## Next steps (operator decision)

- Run dist-tag correction (KI-1).
- Optional: trigger first 1.0.0-beta.2 publish to validate HEAD `da884dc` release.yml fix.
- Phase 2 entry: explicit operator decision on RM-001-P02 zig-wasm-port.
