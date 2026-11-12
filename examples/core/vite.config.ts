import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // This example relies on the zero-config default — the package fetches the wasm binary
    // relative to its own module URL. Vite's pre-bundle would rewrite `import.meta.url` and
    // break that resolution, so `@blaze-cache/core` is left out of it here. (Prefer an
    // explicit `wasmUrl` if you do pre-bundle dependencies.)
    exclude: ['@blaze-cache/core'],
  },
  server: {
    port: 5175,
  },
});
