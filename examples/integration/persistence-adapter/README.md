# persistence-adapter example

Demonstrates EP-6 (`StatePersistenceAdapter`) by saving machine state to a JSON file.

## What it demonstrates

- Implementing the `StatePersistenceAdapter` interface with JSON file backend
- The required shape: `{ currentState, history, stateEntryTimes }`
- async `save`/`restore` methods (note: method is `restore`, NOT `load`)

## How to run

```sh
bun run index.ts
```

## How to type-check

```sh
bunx tsc --noEmit
```
