import { defineConfig } from 'tsdown'

/**
 * Self-contained build for the published entries. `prepare` runs this after a
 * git install, so it must not depend on any monorepo context: the plugin
 * entry plus the PDF worker (spawned by path, never imported), ESM for Node,
 * declarations emitted beside them, every dependency and peer left external
 * so the dsh installation supplies its own copies at runtime.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/pdf-worker.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
  sourcemap: false,
})
