---
"@vedmalex/statemachine": minor
---

Add a VOPR-style Deterministic Simulation Testing (DST) environment behind a new @unstable `./sim` entrypoint: seed-driven scenario generator, full 7-kind fault injection (reorder/drop/dup/overflow/clock-skew/timer-jitter/callback-throw), Safety + Liveness oracles, a delta-debugging shrinker with runnable repro, a perf-regression plane, and a mandatory capability-coverage CI gate. Core public API and bundle bytes unchanged.
