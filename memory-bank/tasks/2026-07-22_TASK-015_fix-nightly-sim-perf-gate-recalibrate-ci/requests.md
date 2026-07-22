# User Requests

## UR-001
- Timestamp: 2026-07-22 10:33
- Source: user
- Text (verbatim): "Fix nightly sim perf gate: recalibrate CI baseline + single perf job"
- Superseded by: UR-002

## UR-002
- Timestamp: 2026-07-22 10:33
- Source: user
- Text (verbatim): "Nightly workflow 'Sim Nightly Seed-Sweep' has failed every night since 2026-06-23 (first run after TASK-014 shipped) — user receives daily failure emails and initially read them as publish failures (Release workflow is in fact healthy, last success 2026-06-22). Root cause: sim:perf gate baseline (etc/sim-perf.baseline.json) was captured on a local machine (node v24.9.0, heapPeakBytes=21282048); on GitHub ubuntu runners heap peak is bimodal (~22.45MB vs ~27.0MB) so the 25% memory band trips whenever a shard lands in the high cluster; with the perf gate duplicated across all 8 matrix shards at least one shard fails nearly every night. Throughput margin is also thin (floor 10648.7 ev/s vs observed low 10917). Fix: (1) recalibrate the committed baseline to CI-observed values (heapPeakBytes to the high cluster ~27.03MB, eventsPerSec to a conservative CI median ~12000); (2) move the sim:perf step out of the 8-shard matrix into a single dedicated perf-gate job in sim-nightly.yml so the gate runs once per night; verify by dispatching the workflow after the fix."
