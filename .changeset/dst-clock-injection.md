---
"@vedmalex/statemachine": minor
---

Add deterministic-testing (DST) support: an injectable `clock` and a virtual scheduler so consumers can drive invoke/after timers and replay state machines under virtual time, with zero impact on default behavior.

- `StateMachineOptions.clock?: () => number` (default `Date.now`) — threads an injectable clock through `stateEntryTimes`, `resumeTimers`, and queued-event age math.
- `createVirtualScheduler(clock)` — a new exported `ITimerScheduler` whose `isActive()` is always true (routes all invoke/after/`transitionTimeout` timers, never touching real `setTimeout`) and whose `process(now?)` drains due timers under virtual time.
- `ITimerScheduler.process?(now?: number)` — optional manual-drain member.
- An explicitly-provided scheduler is always used; the default path (no `clock`, no `scheduler`) stays byte-identical to prior releases.

See the new "Deterministic testing (DST)" section in the README for the virtual-clock pattern.
