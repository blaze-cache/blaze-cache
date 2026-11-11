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
 *   A function is resolved at write time from the key and the fetched data:
 *   `tags: (key, data) => ['user', \`user:${data.id}\`]`.
 * * `forceRefresh` — skip the persisted entry and fetch anyway; the result is still
 *   written back, so the next mount starts from it.
 *
 * Any other middleware in `options.use` composes normally; this one is placed first so
 * it seeds the config and wraps the fetcher before they transform either.
 *
 * Invalidating by tag — `invalidateBlazeSWR` purges every entry this package wrote under
 * the tag *and* revalidates the mounted hooks in one call (`cache.invalidateTags` is the
 * raw equivalent: it reaches the whole shared tag namespace, and leaves SWR's in-memory
 * copy to you):
 *
 * ```ts
 * await invalidateBlazeSWR(cache, 'todos');
 * ```
 *
 * @param cache   The Blaze Cache (or anything {@link BlazeSWRCacheLike}-shaped).
 * @param key     The SWR key — string, tuple, object, or a lazy function; `null` pauses.
 * @param fetcher The fetcher; omit it (or pass `null`) to use a global one or for
 *                client-side state — the cache is still read, nothing is written.
 * @param options Normal SWR options plus `ttlMs`/`tags`/`forceRefresh`.
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
  const { use, ...swrOptions } = options;

  return useSWR(key, fetcher, {
    // `ttlMs`/`tags`/`forceRefresh` deliberately stay *in* the config: SWR merges an
    // `SWRConfig` provider's values into it too, and hook-level options win that merge —
    // so a per-call stamp reaches the middleware's `config.ttlMs ?? options.ttlMs ??
    // default` read as the highest precedence. Stripping them into the middleware's own
    // options would invert that: the provider's config value would then shadow the
    // per-call one.
    ...swrOptions,
    use: [
      blazeSWRMiddleware<Data>(cache, {
        ttlMs: options.ttlMs,
        tags: options.tags,
        forceRefresh: options.forceRefresh,
      }),
      ...(use ?? []),
    ],
  }) as SWRResponse<Data, Error>;
}
