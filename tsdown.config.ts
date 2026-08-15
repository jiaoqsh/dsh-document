import { defineConfig } from 'tsdown'

/**
 * Self-contained build for the published entry. `prepare` runs this after a
 * git install, so it must not depend on any monorepo context: one entry,
 * ESM for Node, declarations emitted beside it, every dependency and peer
 * left external so the dsh installation supplies its own copies at runtime.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
  sourcemap: false,
})
