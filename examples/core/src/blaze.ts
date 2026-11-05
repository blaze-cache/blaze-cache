import { createCache } from '@blaze-cache/core';
import type { BlazeCache } from '@blaze-cache/core';
import wasmUrl from '@blaze-cache/core/pkg/blaze_cache_wasm_bg.wasm?url';

/**
 * A standalone playground for `@blaze-cache/core`.
 *
 * Entries are written straight into one cache, persisted to IndexedDB under the
 * `blaze-example-core` namespace, so a reload paints them back from storage.
 */
export const cache: BlazeCache<string> = await createCache<string>({
  capacity: 100,
  persistence: { namespace: 'blaze-example-core', flushDelayMs: 250 },
  wasm: wasmUrl,
});
