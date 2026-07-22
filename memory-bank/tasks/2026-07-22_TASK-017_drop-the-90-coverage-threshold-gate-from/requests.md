# User Requests

## UR-001
- Timestamp: 2026-07-22 11:35
- Source: user
- Text (verbatim): "Drop the 90% coverage threshold gate from the node CI leg (REQ-001)"
- Superseded by: UR-002

## UR-002
- Timestamp: 2026-07-22 11:35
- Source: user
- Text (verbatim): "User directive 2026-07-22 (resolves REQ-001, assigned): the coverage threshold requirement exists ONLY on the node CI leg (`npm run test:coverage` via vitest.config.ts thresholds 90/90/90/90) — no other leg (bun/deno/browser) has it — and it has kept main's CI red since ≥2026-06-15 (branches 89.87% < 90% with all tests passing). Remove the requirement: drop the `thresholds` block from vitest.config.ts so coverage stays REPORTED (text/html/json-summary reporters kept, CI step kept) but never gates. Keep the `src/sim/**` exclude entry (tsconfig_isolation.test.ts asserts it). Verify: local `npm run test:coverage` exits 0; push must produce the first fully-green CI run on main since June 15."

## UR-003
- Timestamp: 2026-07-22 11:39
- Source: user
- Text (verbatim): "Scope growth discovered during verification (agent-found, 2026-07-22): removing the coverage gate exposed the NEXT pre-existing failure in the tier-a-node step sequence — `git diff --exit-code etc/statemachine-sim.api.md` fails because the committed sim API report is STALE (missing CoverageScenario.overflow / snapshotRestore / transitionTimeout, present in source since the TASK-014 era). The job previously always died at the coverage step and never reached this check, so it was invisible since 2026-06-22. To deliver the task's actual goal (first fully-green CI on main), regenerate etc/statemachine-sim.api.md via the api-extractor sim config (npm run build + api:check:sim --local), commit, and re-verify CI end-to-end green."
