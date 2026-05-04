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
      ],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
      reporter: ['text', 'html', 'json-summary'],
    },
  },
})
