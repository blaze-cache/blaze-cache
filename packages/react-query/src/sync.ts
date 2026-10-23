import { QueryClient } from '@tanstack/react-query';
import type { QueryCacheNotifyEvent } from '@tanstack/react-query';

import type { BlazeQueryClientOptions, BlazeQuerySyncOptions } from './types.js';

/** Mirrored data survives this long in the Blaze Cache (TanStack owns in-session freshness). */
const DEFAULT_TTL_MS = 86_400_000;
/** Default tag, so `cache.invalidateTags('react-query')` purges the whole mirror. */
const DEFAULT_TAGS: readonly string[] = ['react-query'];

/**
 * Mirrors TanStack Query's cache into a Blaze Cache.
 *
 * The two layers have different jobs, and the seam is deliberate:
 *
 * | Event | Behaviour |
 * | --- | --- |
 * | `updated` + `success`/`setState` | mirrored — a completed fetch or `setQueryData` |
 * | `updated` + `invalidate` | **kept** — stale data stays so `staleTime: 0` can still paint instantly |
 * | `updated` + `error` | ignored — TanStack owns error state in-session |
 * | `removed` | deleted, so `removeQueries` really removes it |
 *
 * Returns the unsubscribe function; {@link createBlazeQueryClient} wires it into
 * `client.destroy()`.
 */
export function syncBlazeQueryCache(
  client: QueryClient,
  options: BlazeQuerySyncOptions,
): () => void {
  const { cache } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const tags = options.tags ?? DEFAULT_TAGS;

  return client.getQueryCache().subscribe((event: QueryCacheNotifyEvent) => {
    const { query } = event;
    const hash = query.queryHash;

    if (event.type === 'removed') {
      if (!options.skip?.(query.queryKey, hash)) cache.delete(hash);
      return;
    }

    if (event.type !== 'updated') return;
    // `success` covers fetches and `setQueryData`; `setState` covers `hydrate()`/manual writes.
    if (event.action.type !== 'success' && event.action.type !== 'setState') return;

    const data = query.state.data;
    if (data === undefined && !options.includeEmpty) return;
    if (options.skip?.(query.queryKey, hash)) return;

    cache.set(hash, { data, dataUpdatedAt: query.state.dataUpdatedAt }, { ttlMs, tags });
  });
}

/**
 * A `QueryClient` that mirrors every successful query into a Blaze Cache.
 *
 * ```ts
 * const cache = await createCache({ persistence: { namespace: 'queries' } });
 * const queryClient = createBlazeQueryClient({ cache });
 *
 * <QueryClientProvider client={queryClient}> … </QueryClientProvider>
 * ```
 *
 * The subscription lives exactly as long as the client: the `QueryCache` holds the listener,
 * and the client holds the cache, so they are collected together once you drop the client.
 * Need an explicit handle? Use {@link syncBlazeQueryCache} instead.
 */
export function createBlazeQueryClient(options: BlazeQueryClientOptions): QueryClient {
  const { client: clientOptions, ...syncOptions } = options;
  const client = new QueryClient(clientOptions);
  syncBlazeQueryCache(client, syncOptions);
  return client;
}
