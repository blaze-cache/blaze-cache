import { createCache } from '@blaze-cache/core';
import type { BlazeCache } from '@blaze-cache/core';
import { createBlazeKy } from '@blaze-cache/ky';
import wasmUrl from '@blaze-cache/core/pkg/blaze_cache_wasm_bg.wasm?url';

/** Value ownership mode: `wasm` (default, externrefs in the Rust slab) or `js` (values in a JS Map). */
export type ExampleStorage = 'wasm' | 'js';

/** Set `?storage=js` in the URL to run the whole demo with `storage: 'js'`. */
export const storage: ExampleStorage =
  new URLSearchParams(window.location.search).get('storage') === 'js' ? 'js' : 'wasm';

/**
 * One cache, one ky instance.
 *
 * The wasm binary is passed explicitly with `wasmUrl` (a bundler URL import) — that keeps
 * the path correct after dependency pre-bundling, which is where `import.meta.url`
 * relative paths usually break. Without pre-bundling you could omit it entirely and take
 * the default load.
 */
export const cache: BlazeCache = await createCache({
  capacity: 500,
  storage,
  persistence: { namespace: `blaze-example-ky-${storage}`, debounceMs: 250 },
  wasmUrl,
});

/**
 * ky with the Blaze adapter built in — the `createBlazeKy` helper form.
 *
 * `baseUrl: '/'` keeps the demo same-origin (ky v1 spells this `prefixUrl`). GET
 * responses stay fresh for 15 seconds and carry the default tags (`ky` and
 * `get <method> <url>`), so one `cache.invalidateTags('ky')` drops every cached response
 * this instance stored.
 *
 * `varyHeaders` includes `origin` because Vite's dev server answers every response with
 * `Vary: Origin`; the adapter never stores a response varying on a header it does not key
 * on, so without it the demo would be a permanent MISS.
 */
export const api = createBlazeKy(cache, {
  baseUrl: '/',
  ttlMs: 15_000,
  varyHeaders: ['authorization', 'origin'],
});
