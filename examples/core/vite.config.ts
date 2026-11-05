import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // The package ships plain ESM with an explicit `?url` import for the wasm binary; leaving
    // it out of the pre-bundle keeps `import.meta.url` meaningful if you rely on the
    // zero-config default instead.
    exclude: ['@blaze-cache/core'],
  },
  server: {
    port: 5175,
  },
});
