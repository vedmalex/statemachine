# observability-injection example

Demonstrates EP-1 (`IMonitor`) by injecting a custom monitor into the state machine.

## What it demonstrates

- Implementing the `IMonitor` interface with metrics collection
- Injecting via `createMachine(config, undefined, { monitor })` (3rd arg form)
- Retrieving metrics via `getMetrics()`

## How to run

```sh
bun run index.ts
```

## How to type-check

```sh
bunx tsc --noEmit
```
