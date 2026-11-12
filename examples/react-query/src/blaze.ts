import { createCache } from '@blaze-cache/core';
import type { BlazeCache } from '@blaze-cache/core';
import { createBlazeQueryClient } from '@blaze-cache/react-query';
import wasmUrl from '@blaze-cache/core/pkg/blaze_cache_wasm_bg.wasm?url';

/**
 * One cache, one TanStack Query client whose successes are mirrored into it.
 *
 * The mirror is what paints the first render after a reload — entries under the `todos`
 * query key survive in IndexedDB and are restored with their original `dataUpdatedAt`, so
 * TanStack still refetches in the background exactly as usual.
 *
 * The wasm binary is passed explicitly with `wasmUrl` (a bundler URL import) so the path
 * survives dependency pre-bundling.
 */
export const cache: BlazeCache = await createCache({
  capacity: 500,
  persistence: { namespace: 'blaze-example-react-query', flushDelayMs: 250 },
  wasmUrl,
});

export const queryClient = createBlazeQueryClient({
  cache,
  ttlMs: 24 * 60 * 60_000,
  tags: ['react-query', 'todos'],
});

/** Plain `fetch` for the actual network call, kept out of the demo's queryFn boilerplate. */
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
