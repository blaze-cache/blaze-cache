import { defineConfig } from 'vite';

/**
 * The benchmark page imports the shared harness from `../cache/`, and `@blaze-cache/core`
 * resolves its wasm asset through `new URL('../pkg/…', import.meta.url)`. Excluding core from
 * dependency pre-bundling keeps that URL intact so Vite emits the binary as an asset instead
 * of trying to inline it into a pre-bundle. `server.fs.allow` opens the repo root to the
 * `../cache/` imports; `build` uses a relative base so the output can be hosted anywhere.
 */
export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    fs: { allow: ['..', '../..'] },
    port: 0,
    strictPort: false,
  },
  optimizeDeps: { exclude: ['@blaze-cache/core'] },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
