import { createCache } from '@blaze-cache/core';
import type { BlazeCache } from '@blaze-cache/core';
import { installBlazeCache } from '@blaze-cache/axios';
import axios from 'axios';
import wasmUrl from '@blaze-cache/core/pkg/blaze_cache_wasm_bg.wasm?url';

/**
 * One cache, one axios instance with the Blaze adapter installed.
 *
 * The wasm binary is passed explicitly with `wasmUrl` (a bundler URL import) — that keeps
 * the path correct after dependency pre-bundling, which would otherwise rewrite
 * `import.meta.url` and break the default relative resolution. `varyHeaders` includes
 * `origin` because Vite's dev server answers every response with `Vary: Origin`, and the
 * adapter won't store a response varying on a header it doesn't key on.
 */
export const cache: BlazeCache = await createCache({
  capacity: 500,
  persistence: { namespace: 'blaze-example-axios', flushDelayMs: 250 },
  wasmUrl,
});

/** Axios with the Blaze adapter installed. GET responses stay fresh for 15 seconds. */
export const api = axios.create({ baseURL: '/' });
installBlazeCache(api, {
  cache,
  ttlMs: 15_000,
  varyHeaders: ['authorization', 'origin'],
});
