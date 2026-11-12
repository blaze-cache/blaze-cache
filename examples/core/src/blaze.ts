import { createCache } from '@blaze-cache/core';
import type { BlazeCache } from '@blaze-cache/core';

/**
 * A standalone playground for `@blaze-cache/core`.
 *
 * No wasm URL import here: the default path fetches the binary shipped inside the package,
 * resolved relative to its own module. That works because this example excludes
 * `@blaze-cache/core` from Vite's pre-bundle (see `vite.config.ts`) — pre-bundling would
 * rewrite `import.meta.url`, which is exactly when you pass `wasmUrl` instead.
 *
 * Entries are written straight into one cache, persisted to IndexedDB under the
 * `blaze-example-core` namespace, so a reload paints them back from storage.
 */
export const cache: BlazeCache<string> = await createCache<string>({
  capacity: 100,
  persistence: { namespace: 'blaze-example-core', flushDelayMs: 250 },
});
