import { defineConfig } from 'tsup'

export default defineConfig({
  // Two entries: the byte-frozen core ('.') and the additive @unstable ./sim
  // island. splitting STAYS false so dist/index.{js,cjs} regenerate
  // byte-identically (the engine is duplicated into dist/sim, ADR-7 accepted);
  // empirically verified zero-diff on the core bytes before/after adding the 2nd
  // entry (Step-10 AC-9 one-time comparison + standing dist-byte guard).
  entry: ['src/index.ts', 'src/sim/index.ts'],
  format: ['esm', 'cjs'],
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  target: 'node18',
  minify: false,
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
})
