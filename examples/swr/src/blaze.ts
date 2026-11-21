import { createCache } from '@blaze-cache/core';
import type { BlazeCache } from '@blaze-cache/core';
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
 * One cache, one `useBlazeSWR` hook in the app.
 *
 * The hook hands the persisted value to SWR as `fallbackData`, so the first paint after a
 * reload comes from IndexedDB while SWR revalidates in the background like plain `useSWR`.
 *
 * The wasm binary is passed explicitly with `wasmUrl` (a bundler URL import) so the path
 * survives dependency pre-bundling.
 */
export const cache: BlazeCache = await createCache({
  capacity: 500,
  storage,
  persistence: persistence ? { namespace: `blaze-example-swr-${storage}`, writeMode: 'immediate' } : false,
  ...(multiTab ? { multiTab: { enabled: true } } : {}),
  wasmUrl,
});

export async function fetchTodosPayload(): Promise<{
  items: string[];
  serverHits: number;
  fetchedAt: number;
}> {
  const response = await fetch('/api/todos');
  if (!response.ok) throw new Error(`GET /api/todos failed with ${response.status}`);
  return (await response.json()) as {
    items: string[];
    serverHits: number;
    fetchedAt: number;
  };
}
