import { createCache } from '@blaze-cache/core';
import type { BlazeCache } from '@blaze-cache/core';
import wasmUrl from '@blaze-cache/core/pkg/blaze_cache_wasm_bg.wasm?url';

/**
 * One cache, one `useBlazeSWR` hook in the app.
 *
 * The hook hands the persisted value to SWR as `fallbackData`, so the first paint after a
 * reload comes from IndexedDB while SWR revalidates in the background like plain `useSWR`.
 */
export const cache: BlazeCache = await createCache({
  capacity: 500,
  persistence: { namespace: 'blaze-example-swr', flushDelayMs: 250 },
  wasm: wasmUrl,
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
