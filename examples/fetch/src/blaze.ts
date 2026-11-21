import { createCache } from '@blaze-cache/core';
import type { BlazeCache } from '@blaze-cache/core';
import { createBlazeFetch } from '@blaze-cache/fetch';
import wasmUrl from '@blaze-cache/core/pkg/blaze_cache_wasm_bg.wasm?url';

/** Value ownership mode: `wasm` (default, externrefs in the Rust slab) or `js` (values in a JS Map). */
export type ExampleStorage = 'wasm' | 'js';

/** Set `?storage=js` in the URL to run the whole demo with `storage: 'js'`. */
export const storage: ExampleStorage =
  new URLSearchParams(window.location.search).get('storage') === 'js' ? 'js' : 'wasm';

/**
 * One cache, one `fetch` replacement.
 *
 * The wasm binary is passed explicitly with `wasmUrl` (a bundler URL import) so the path
 * stays correct after dependency pre-bundling. `varyHeaders` includes `origin` because
 * Vite's dev server answers every response with `Vary: Origin`, and the wrapper won't
 * store a response varying on a header it doesn't key on.
 */
export const cache: BlazeCache = await createCache({
  capacity: 500,
  storage,
  persistence: { namespace: `blaze-example-fetch-${storage}`, debounceMs: 250 },
  wasmUrl,
});

/** Drop-in `fetch`. GET responses stay fresh for 15 seconds; POSTs are never cached. */
export const blazeFetch = createBlazeFetch(cache, {
  ttlMs: 15_000,
  varyHeaders: ['authorization', 'origin'],
});
