# User Requests

## UR-001
- Timestamp: 2026-05-06 07:16
- Source: user
- Text (verbatim): "Normalize dispatch inputs and simplify callback contract"
- Continued from task: TASK-009
- Continuation reason: Consumer-side MB3 plugin state machines had to add a shared `resolveAdaptee` helper because callbacks currently receive adapter-shaped inputs. Investigate whether statemachine should normalize inputs once at the dispatch boundary and expose one callback contract, while keeping the surface small and Zig-port-friendly.
