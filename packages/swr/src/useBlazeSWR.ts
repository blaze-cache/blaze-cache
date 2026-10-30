import useSWR from 'swr';
import type { Fetcher, Key, SWRResponse } from 'swr';

import { blazeSWRMiddleware } from './middleware.js';
import type { BlazeSWRCacheLike, BlazeSWROptions } from './types.js';

/**
 * `useSWR` that paints from the Blaze Cache and persists what it fetches.
 *
 * The whole behaviour is {@link blazeSWRMiddleware} behind a friendlier signature: the
 * persisted entry for `key` is seeded as SWR's `fallbackData`, so the first render after
 * a reload shows real data immediately while SWR still revalidates in the background —
 * and every successful fetch lands back in the Blaze Cache under `ttlMs`/`tags`.
 *
 * ```tsx
 * const todos = useBlazeSWR(cache, '/api/todos', (url) => api.get(url), {
 *   ttlMs: 5 * 60_000,
 *   tags: ['todos'],
 * });
 * ```
 *
 * Everything `useSWR` takes keeps working — `revalidateOnMount`, `keepPreviousData`,
 * `suspense`, `use`, a global fetcher (omit `fetcher` or pass `null`) — plus the
 * Blaze-side stamp:
 *
 * * `ttlMs` — how long a successful fetch survives in the Blaze Cache (default 24 h).
 *   It governs *cross-session* freshness; SWR's own options keep governing *in-session*
 *   freshness.
 * * `tags` — attached to every write, so `cache.invalidateTags('todos')` purges them.
 *
 * Any other middleware in `options.use` composes normally; this one is placed first so
 * it seeds the config and wraps the fetcher before they transform either.
 *
 * Invalidating by tag (the fetcher runs again on the next mount; SWR's in-memory copy
 * keeps its own lifecycle, so revalidate it too when it must change on the spot):
 *
 * ```ts
 * cache.invalidateTags('todos');
 * mutate('/api/todos'); // SWR's own revalidation for the mounted hook
 * ```
 *
 * @param cache   The Blaze Cache (or anything {@link BlazeSWRCacheLike}-shaped).
 * @param key     The SWR key — string, tuple, object, or a lazy function; `null` pauses.
 * @param fetcher The fetcher; omit it (or pass `null`) to use a global one or for
 *                client-side state — the cache is still read, nothing is written.
 * @param options Normal SWR options plus `ttlMs`/`tags`.
 */
export function useBlazeSWR<
  Data = any,
  Error = any,
  SWRKey extends Key = Key,
>(
  cache: BlazeSWRCacheLike,
  key: SWRKey,
  fetcher: Fetcher<Data, SWRKey> | null = null,
  options: BlazeSWROptions<Data, Error, Fetcher<Data, SWRKey>> = {},
): SWRResponse<Data, Error> {
  const { ttlMs, tags, use, ...swrOptions } = options;

  return useSWR(key, fetcher, {
    ...swrOptions,
    use: [blazeSWRMiddleware(cache, { ttlMs, tags }), ...(use ?? [])],
  }) as SWRResponse<Data, Error>;
}
