# @vedmalex/statemachine

Hierarchical state machine for TypeScript with monitoring, validation, and persistence.

The package ships only the DI-free lite surface. The legacy DI-aware factory from `@grainjs/statemachine` is intentionally not carried over.

## Install

```
bun add @vedmalex/statemachine
# or
npm install @vedmalex/statemachine
```

## Quick start

```ts
import { createMachine } from '@vedmalex/statemachine'

const sm = createMachine({
  name: 'door',
  initialState: 'closed',
  states: { closed: {}, open: {} },
  events: { open: { transitions: [{ from: 'closed', to: 'open' }] } },
})
```

## Status & module format

`1.0.0-beta.x`. Stability: experimental. The full API surface is currently `@unstable` per the package's STABILITY policy; per-symbol stability tagging arrives before `1.0.0` stable.

**Module format**: ESM-only in beta. CJS consumers calling `require('@vedmalex/statemachine')` will receive `ERR_REQUIRE_ESM` from Node. Use dynamic import (`await import('@vedmalex/statemachine')`) or migrate to ESM. CJS bundle arrives in a follow-up release alongside multi-runtime CI.

## Known gaps in 1.0.0-beta

- **CJS bundle**: ESM-only in this beta. CJS arrives via bundler in a follow-up task.
- **Multi-runtime CI**: Bun + Node 20 LTS verified now; Browser + Deno tracked for stable 1.0.0.

## License

MIT — see LICENSE.
