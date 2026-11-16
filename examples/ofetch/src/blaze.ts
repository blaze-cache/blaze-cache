import { createCache } from '@blaze-cache/core';
import type { BlazeCache } from '@blaze-cache/core';
import { createBlazeOfetch } from '@blaze-cache/ofetch';
import wasmUrl from '@blaze-cache/core/pkg/blaze_cache_wasm_bg.wasm?url';

/**
 * One cache, one ofetch ($fetch) instance.
 *
 * The wasm binary is passed explicitly with `wasmUrl` (a bundler URL import) — that keeps
 * the path correct after dependency pre-bundling, which is where `import.meta.url`
 * relative paths usually break. Without pre-bundling you could omit it entirely and take
 * the default load.
 */
export const cache: BlazeCache = await createCache({
  capacity: 500,
  persistence: { namespace: 'blaze-example-ofetch', debounceMs: 250 },
  wasmUrl,
});

/**
 * ofetch with the Blaze adapter built in — the `createBlazeOfetch` helper form.
 *
 * `baseURL` is the current origin so every request is keyed on an absolute URL; the adapter
 * only caches requests whose URL names its host. GET responses stay fresh for 15 seconds and
 * carry the default tags (`ofetch` and `get <url>`), so one `cache.invalidateTags('ofetch')`
 * drops every cached response this instance stored.
 *
 * `varyHeaders` includes `origin` because Vite's dev server answers every response with
 * `Vary: Origin`; the adapter never stores a response varying on a header it does not key
 * on, so without it the demo would be a permanent MISS.
 */
export const api = createBlazeOfetch(cache, {
  baseURL: window.location.origin,
  ttlMs: 15_000,
  varyHeaders: ['authorization', 'origin'],
});
