---
"@vedmalex/statemachine": patch
---

Initial 1.0.0-beta.0 publish — Phase 1 baseline of @vedmalex/statemachine standalone monorepo.

This release establishes the public-surface contract of the lite-only DI-free state machine library. Includes:

- Strict TypeScript public API (5 firm @stable symbols: createMachine, StateMachine, StateMachineConfig, Transition, State)
- 7 extension-point interfaces (@unstable): IMonitor, ITimerScheduler, IErrorHandler, ILogger, StatePersistenceAdapter, TransitionContext, MonitorMetricsSnapshot
- ESM + CJS dual emission via tsup; api-extractor surface ratchet at etc/statemachine.api.md
- Comprehensive vitest test suite with ≥90% coverage across all 4 metrics
- TypeDoc HTML docs published to GitHub Pages
- 3 integration examples (custom-adapter, observability-injection, persistence-adapter)
- Multi-runtime CI: Bun + Node 18 + Node 20 (Tier A blocking) + Deno + Browser (Tier B allowed-fail)
- Changesets release flow with manual workflow_dispatch trigger
- This package is a standalone fork of an internal state-machine module, refactored to remove framework-coupling. It ships only the dependency-free public surface.

See CHANGELOG.md and STABILITY.md for the full surface contract.
