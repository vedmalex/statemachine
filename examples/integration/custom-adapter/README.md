# custom-adapter example

Demonstrates EP-4 (`Adapter<T>`) by binding a `MapAdapter` to the state machine.

## What it demonstrates

- Implementing the `Adapter<T>` interface with a `Map` backend
- Wiring a custom adapter via `createMachine(config, adapter)` (2nd arg)
- The `adaptee` getter contract used internally by the StateMachine

## How to run

```sh
bun run index.ts
```

## How to type-check

```sh
bunx tsc --noEmit
```
