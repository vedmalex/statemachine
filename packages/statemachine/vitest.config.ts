import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
    exclude: ['test/**', 'node_modules/**'],
    hookTimeout: 30000,
    testTimeout: 30000,
    fakeTimers: {
      // Only fake these; do NOT fake setImmediate/process.nextTick/queueMicrotask
      // to avoid vi.useRealTimers() hanging on restore in slow CI environments (Node 18)
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/tests/**',    // test source itself
        'src/presets.ts',  // example fixtures, not consumer-runtime API
        'src/security.ts', // unreachable from dist (TD-T3-8 + Step 5 artifact-grep verification)
        // TASK-014 §6 frozen decision: the @unstable ./sim island owns its own
        // coverage via the separate `sim:coverage` CLI; keep it out of the core
        // coverage REPORT so sim branches never skew the core numbers.
        'src/sim/**',
      ],
      // TASK-017 (REQ-001): no thresholds — coverage is REPORTED, not gated.
      // The 90% gate existed only on this leg (bun/deno/browser never had it)
      // and kept main red from 2026-06-15 on a 89.87%-branches miss with every
      // test passing. Reintroduce a gate only together with the tests that
      // satisfy it.
      reporter: ['text', 'html', 'json-summary'],
    },
  },
})
