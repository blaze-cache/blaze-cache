import { createCache } from '@blaze-cache/core';
import type { BlazeCache } from '@blaze-cache/core';
import { createBlazeOfetch } from '@blaze-cache/ofetch';
import wasmUrl from '@blaze-cache/core/pkg/blaze_cache_wasm_bg.wasm?url';

/** Value ownership mode: `wasm` (default, externrefs in the Rust slab) or `js` (values in a JS Map). */
export type ExampleStorage = 'wasm' | 'js';

const params = new URLSearchParams(window.location.search);

/** Set `?storage=js` in the URL to run the whole demo with `storage: 'js'`. */
export const storage: ExampleStorage = params.get('storage') === 'js' ? 'js' : 'wasm';

/** `?sync=off` disables multi-tab sync; `?persistence=off` makes the cache memory-only. */
export const multiTab = params.get('sync') !== 'off';
export const persistence = params.get('persistence') !== 'off';

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
  storage,
  persistence: persistence ? { namespace: `blaze-example-ofetch-${storage}`, writeMode: 'immediate' } : false,
  ...(multiTab ? { multiTab: { enabled: true } } : {}),
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
