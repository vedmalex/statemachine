import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
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
