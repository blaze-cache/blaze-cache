import { createCache } from '@blaze-cache/core'
import type { BlazeCache } from '@blaze-cache/core'
import { installBlazeCache } from '@blaze-cache/axios'
import axios from 'axios'
import wasmUrl from '@blaze-cache/core/pkg/blaze_cache_wasm_bg.wasm?url'

/** Value ownership mode: `wasm` (default, externrefs in the Rust slab) or `js` (values in a JS Map). */
export type ExampleStorage = 'wasm' | 'js'

const params = new URLSearchParams(window.location.search)

/** Set `?storage=js` in the URL to run the whole demo with `storage: 'js'`. */
export const storage: ExampleStorage = params.get('storage') === 'js' ? 'js' : 'wasm'

/** `?sync=off` disables multi-tab sync; `?persistence=off` makes the cache memory-only. */
export const multiTab = params.get('sync') !== 'off'
export const persistence = params.get('persistence') !== 'off'

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
  storage,
  persistence: persistence
    ? { namespace: `blaze-example-axios-${storage}`, writeMode: 'immediate' }
    : false,
  ...(multiTab ? { multiTab: { enabled: true } } : {}),
  wasmUrl,
})

/** Axios with the Blaze adapter installed. GET responses stay fresh for 15 seconds. */
export const api = axios.create({ baseURL: '/' })
installBlazeCache(api, {
  cache,
  ttlMs: 15_000,
  varyHeaders: ['authorization', 'origin'],
})
