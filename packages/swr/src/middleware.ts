import type {
  BareFetcher,
  Middleware,
  SWRConfiguration,
  SWRResponse,
} from 'swr';

import { resolveBlazeKey } from './key.js';
import { readBlazeSWRRecord } from './record.js';
import type {
  BlazeSWRCacheLike,
  BlazeSWRMiddlewareOptions,
  BlazeSWRRecord,
} from './types.js';

/** How long written entries survive in the Blaze Cache (SWR owns in-session freshness). */
export const DEFAULT_TTL_MS = 86_400_000;
/** Default tag, so `cache.invalidateTags('swr')` purges everything this package wrote. */
export const DEFAULT_TAGS: readonly string[] = ['swr'];

/** The `cache.set` stamp one write goes out with: resolved options, never partial. */
interface ResolvedStamp {
  ttlMs: number;
  tags: readonly string[];
}

/**
 * Wraps a fetcher so every successful result is written to the Blaze Cache before SWR
 * sees it.
 *
 * Kept module-level (rather than an inline closure) so the narrowing of `fetcher` and
 * the key happens at the call site: inside a captured closure TypeScript would have to
 * assume the parameter changed since the null check.
 *
 * Failures propagate untouched — SWR keeps its own error state, and the cache only ever
 * holds data that a fetcher actually returned. `undefined` is skipped: SWR reads it as
 * "no data", so there is nothing worth stamping a TTL onto. The raw result goes into a
 * {@link BlazeSWRRecord} envelope, so hydration can tell this package's writes apart from
 * foreign values on a shared cache (see {@link readBlazeSWRRecord}); the fetcher itself
 * still resolves with the bare result, exactly as the caller's fetcher would.
 */
function persistingFetcher<Data>(
  fetcher: BareFetcher<Data>,
  cache: BlazeSWRCacheLike,
  key: string,
  stamp: ResolvedStamp,
): BareFetcher<Data> {
  return async (...args: any[]) => {
    const data = await fetcher(...args);
    if (data !== undefined) {
      const record: BlazeSWRRecord<Data> = { kind: 'swr', data, storedAt: Date.now() };
      cache.set(key, record, stamp);
    }
    return data;
  };
}

/**
 * SWR middleware that keeps SWR and the Blaze Cache in step — stale-while-revalidate
 * that also survives a reload.
 *
 * | Moment | Behaviour |
 * | --- | --- |
 * | render | a persisted entry is read **without side effects** (`peek` first) and handed to SWR as `fallbackData` — the first paint is instant, from disk |
 * | mount / revalidate | SWR runs its own revalidation as usual (`revalidateIfStale` still applies), so the fetcher runs in the background exactly like plain `useSWR` |
 * | fetch success | the result is written to the Blaze Cache under the SWR-serialized key, stamped with `ttlMs`/`tags` |
 * | fetch failure | ignored by the cache — errors live in SWR, data lives in Blaze |
 *
 * The seeded entry is deliberately **not** treated as fresh: SWR's `fallbackData` carries
 * no timestamp, so `revalidateIfStale` (on by default) still revalidates on mount. Set
 * `revalidateOnMount: false` or `revalidateIfStale: false` when a cache hit should skip
 * the network entirely.
 *
 * Precedence for what wins the first paint: a caller-supplied `fallbackData`, then an
 * entry in a provider-level `fallback` map, then the Blaze Cache. Precedence for the
 * write stamp: `ttlMs`/`tags` on the current options, then the middleware's own
 * options, then {@link DEFAULT_TTL_MS}/{@link DEFAULT_TAGS}.
 *
 * A paused key (`null`/`undefined`/`false`, or a lazy key resolving to one) reads and
 * writes nothing — {@link resolveBlazeKey} maps those to `null` and the middleware passes
 * the original arguments through untouched.
 *
 * ### Wiring it up
 *
 * `useBlazeSWR` builds it for you. By hand, add it to any `useSWR` call's `use` array —
 * it is a plain SWR middleware, so it composes with yours:
 *
 * ```ts
 * const { data } = useSWR('/api/todos', fetcher, {
 *   use: [blazeSWRMiddleware(cache, { ttlMs: 60_000 }), loggerMiddleware],
 * });
 * ```
 *
 * …or to a whole tree through `SWRConfig`:
 *
 * ```tsx
 * <SWRConfig value={{ use: [blazeSWRMiddleware(cache), loggerMiddleware] }}>
 * ```
 *
 * It must be the **first** entry of `use` to see the key, config and fetcher before any
 * other middleware transforms them — {@link useBlazeSWR} puts it there for you.
 *
 * @param cache   The Blaze Cache (or anything {@link BlazeSWRCacheLike}-shaped).
 * @param options The Blaze-side stamp for writes; per-call options still override it.
 */
export function blazeSWRMiddleware(
  cache: BlazeSWRCacheLike,
  options: BlazeSWRMiddlewareOptions = {},
): Middleware {
  return (useSWRNext) => (key, fetcher, config) => {
    const blazeKey = resolveBlazeKey(key);

    // Per-call `ttlMs`/`tags` ride in the SWR config (SWR merges unknown options through),
    // then the middleware's own options, then the package defaults.
    const stamp: ResolvedStamp = {
      ttlMs:
        (config as SWRConfiguration & BlazeSWRMiddlewareOptions).ttlMs ??
        options.ttlMs ??
        DEFAULT_TTL_MS,
      tags:
        (config as SWRConfiguration & BlazeSWRMiddlewareOptions).tags ??
        options.tags ??
        DEFAULT_TAGS,
    };

    // Hydration: `peek` first so renders never move the hit rate or nudge eviction —
    // a recording `get` stays the fallback for caches that predate it. Only this
    // package's own envelope seeds the UI; a foreign value under a colliding key reads
    // as a miss rather than being handed to the component as `data`.
    const data = blazeKey === null ? undefined : readBlazeSWRRecord(cache, blazeKey);

    // Caller-supplied fallbacks stay authoritative: `fallbackData` directly, or a
    // provider-level `fallback` entry for this exact key. Blaze only fills the gap.
    const callerFallback =
      config.fallbackData !== undefined ||
      (blazeKey !== null && config.fallback?.[blazeKey] !== undefined);

    const nextConfig =
      data !== undefined && !callerFallback
        ? ({ ...config, fallbackData: data } as SWRConfiguration)
        : config;

    const nextFetcher =
      fetcher !== null && blazeKey !== null
        ? persistingFetcher(fetcher, cache, blazeKey, stamp)
        : fetcher;

    return useSWRNext(key, nextFetcher, nextConfig) as SWRResponse;
  };
}
