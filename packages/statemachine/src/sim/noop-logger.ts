/**
 * @module sim/noop-logger
 * @unstable
 *
 * ADR-3(E) deterministic logger seam. A frozen singleton implementing the
 * engine's {@link ILogger} contract (types.ts:56-61) with empty,
 * side-effect-free `debug`/`info`/`warn`/`error`.
 *
 * It implements `ILogger` — it does NOT "mirror ConsoleLogger" (there is no
 * `ConsoleLogger` class; the engine's logger class is `Logger` in logger.ts).
 * The determinism property is "no side effects, no wall-clock, no console" —
 * proven by a source-grep DoD for `Date.now` / `console` (both ZERO here).
 */

import type { ILogger } from '../index'

/**
 * Frozen no-op {@link ILogger} singleton. Every method accepts the engine's
 * call shape and returns `undefined` with no observable effect. Frozen so a
 * consumer cannot accidentally monkey-patch a side-effect onto a shared seam.
 */
export const NoopLogger: ILogger = Object.freeze({
  debug(_message: string, _context?: unknown): void {},
  info(_message: string, _context?: unknown): void {},
  warn(_message: string, _context?: unknown, _error?: Error): void {},
  error(_message: string, _context?: unknown, _error?: Error): void {},
})
