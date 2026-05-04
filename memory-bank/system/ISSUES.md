# Issues & Known Knowledge — @vedmalex/statemachine

Updated: 2026-05-04

## Open carry-forwards from Phase 1

### KI-1: dist-tag = `latest` (TASK-007 deviation)

- **Severity**: Low
- **Owner**: operator post-archive action
- **Action**:
  ```bash
  npm dist-tag add @vedmalex/statemachine@1.0.0-beta.1 beta
  npm view @vedmalex/statemachine dist-tags  # verify
  ```
- **Why**: First publish (CI run 25321190954) used release.yml without `--tag beta`; package routed to `latest` dist-tag instead of `beta`.
- **Future fix**: HEAD `da884dc` release.yml includes `--tag beta`; subsequent 1.0.0-beta.x publishes route correctly.

### KI-2: knip Node 18 skip

- **Severity**: Low
- **Owner**: future maintenance (when knip downgraded OR Node 18 sunset)
- **Why**: knip@6 requires Node ≥20.19; Tier A Node 18 CI job skips knip step.

### KI-3: package-lock.json deferred

- **Severity**: Low
- **Owner**: post-1.0.0 stable
- **Why**: Bun-managed repo (bun.lock authoritative); generating npm package-lock.json creates dual-lockfile maintenance burden. CI uses `npm install` (drift-tolerant) until stable lockfile makes sense.

### KI-4: ITimerScheduler `object` token typing

- **Severity**: Low
- **Owner**: post-1.0.0 task
- **Why**: TD-T6-10 — `ITimerScheduler.schedule()` returns `object`; nominal `TimerToken` branded type promotion deferred. Internal WeakSet membership currently provides safety.

### KI-5: api-extractor `etc/statemachine.api.md` ratchet

- **Severity**: Maintenance
- **Owner**: every future task touching public surface
- **Action**: regenerate via `bunx api-extractor run --local` and commit; CI fails on uncommitted drift.

## Closed (Phase 1)

- ISS-001/US-010 — TimerScheduler singleton elimination → CLOSED in TASK-004
- ISS-002 — zig-port-considerations.md → CLOSED in TASK-004
- ISS-003 — license URL / repo metadata → CLOSED in TASK-005
- ISS-004 — prepublish bun consistency → CLOSED in TASK-005 (runtime-agnostic prepublishOnly)
- ISS-005/010/011 — DI removal closures → CLOSED in TASK-002
- ISS-006 — Tier B convergence → tracked at RM-001 program level (allowed-fail under beta)
- ISS-007 — IMonitor signature alignment → CLOSED in TASK-004
- ISS-008 — globalStateMachineMonitor removal → CLOSED in TASK-004
- ISS-009 — dead-export removal → CLOSED in TASK-003 via knip
- ISS-012/013/014 — type cleanup → CLOSED in TASK-003 strict-TS pass
- ISS-015 — prototype-enumeration invariant → CLOSED in TASK-004 (singleton_elimination.test.ts)
- ISS-041 — moduleResolution `bundler` vs `node16` → CONDITIONALLY CLOSED in TASK-003 TD-T3-5
- F-CR-4..F-CR-7 — TASK-002 CODE_REVIEW carry-forwards → CLOSED in TASK-003/005/006
- F-CR3-1..F-CR3-9 — TASK-003 CODE_REVIEW carry-forwards → CLOSED in TASK-005/006
- F-CR4-1..F-CR4-3 — TASK-004 CODE_REVIEW carry-forwards → CLOSED in TASK-005/006
- F-CR5-S-1..F-CR5-S-3 — TASK-005 CODE_REVIEW carry-forwards → CLOSED in TASK-006

## Knowledge — durable lessons

### DA gate cycles catch real factual errors

Multiple Phase 1 tasks (TASK-006 TECH_SPEC BLOCK; TASK-005 CREATIVE/PLAN multi-cycle) demonstrated that mb3-critic gates catch factual mismatches between spec and source code BEFORE IMPLEMENT lands broken artifacts. Time-cost of REVISE cycles >> time-cost of IMPLEMENT-then-fix.

### Working-tree separation matters

D15 repo bifurcation (MB3 work tree at grainjs-prod, code at standalone repo) caused TECH_SPEC BLOCK on TASK-006 when critic read wrong tree. Future DA gate prompts MUST include absolute paths for both artifacts AND code.

### bun publish quirks

- Bun supports `workspace:*` natively (npm install does NOT — `EUNSUPPORTEDPROTOCOL`).
- Bun publish auto-strips workspace protocol from package.json before publish.
- Bun does NOT env-var-substitute `~/.npmrc` placeholders; write resolved token literally.
- Bun publish needs `--tag beta` even with `.changeset/pre.json` mode=pre+tag=beta active.

### Local rehearsal under Bun/macOS doesn't certify multi-runtime CI

TASK-005 lesson: Step 13 local rehearsal recorded all PASS but Node 18 fakeTimers + knip@6 engine constraint surfaced only on remote runner. Future tasks should run Node-version containers locally OR accept remote CI as the rehearsal surface.

### Tag-after-publish discipline

TASK-006/007: tagging at feat-commit then doing CI/QA fixes leaves tag pointing at unverified state. Defer tagging until CI green AND QA confirmed; OR re-tag after fixes with explicit force-push and identity-stitching note in qa.md.
