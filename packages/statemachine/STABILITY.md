# Stability Policy

## Tiers

- **@stable** — firm contract; SemVer major bump on breaking change.
- **@unstable** — may change between minor versions; not bound by SemVer.
- **@deprecated** — will be removed; consumer migration required.

## Current @stable surface (5 firm symbols)

- `createMachine` — primary factory; canonical consumer entry point (`src/lite.ts`)
- `StateMachine` — class form for advanced consumers (`src/state_machine.ts`)
- `StateMachineConfig` — top-level machine configuration interface (`src/types.ts`)
- `Transition` — transition descriptor used in events (`src/types.ts`)
- `State` — state node shape; consumed by States<T> map (`src/types.ts`)

## Current @unstable exports

Snapshot from `etc/statemachine.api.md` at HEAD (post-TASK-006):

**Extension-point interfaces (EP catalog):**
`IMonitor`, `ITimerScheduler`, `IErrorHandler`, `ILogger`,
`StatePersistenceAdapter`, `TransitionContext`, `MonitorMetricsSnapshot`

**Type utilities and shapes:**
`States`, `Events`, `Event`, `Adapter`, `StateMachineOptions`, `RegionsConfig`,
`StateInvocation`, `StateName`, `EventName`, `RegionName`, `EventAction`,
`ErrorHandler`, `ActionOrString`, `ErrorHandlerOrString`, `RegionStateName`,
`NestedStateName`, `DeepNestedStateName`, `StatePaths`, `SimpleStateName`,
`MethodsOf`, `PropertiesOf`, `KeysOf`, `ExtractAdaptee`, `ErrorContext`

**Public adapter classes:**
`MemoryAdapter`, `LocalStorageAdapter`, `SessionStorageAdapter`, `ServerAdapter`

**Error handling:**
`createEnhancedError`, `EnhancedStateMachineError`, `EnhancedErrorHandler`,
`ErrorAnalytics`, `ErrorCategory`, `ErrorSeverity`, `ErrorRecoveryStrategy`,
`ExtendedErrorContext`, `FallbackStateRecoveryStrategy`, `RetryRecoveryStrategy`,
`isRecoverableError`, `StateMachineError`, `isAdapter`

**Config validation:**
`validateConfig`, `validateConfigStrict`, `isValidConfig`, `ValidationResult`,
`ValidationError`, `ValidationWarning`

## Promotion path (@unstable → @stable)

1. CODE_REVIEW DA gate justification authored.
2. `etc/statemachine.api.md` snapshot updated with promoted symbol.
3. Public-surface ratchet test (`src/tests/public_surface.test.ts`) updated.
4. STABILITY.md "Current @stable surface" section edited.

## Deprecation path (@unstable → @deprecated)

1. JSDoc `@deprecated` tag added to symbol with replacement note.
2. At least one minor version cycle before symbol removal.
3. Removal counted as a non-breaking change (consumer was warned).

## Honest framing

STABILITY.md is **documentation only**. The canonical machine-checked surface
ratchet is `etc/statemachine.api.md` (api-extractor) + the runtime ratchet tests.
STABILITY.md provides human-readable guidance; consumers needing strict
machine-checkable signals should consult api.md.
