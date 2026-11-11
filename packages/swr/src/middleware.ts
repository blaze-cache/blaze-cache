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
  BlazeSWRTags,
} from './types.js';

/** How long written entries survive in the Blaze Cache (SWR owns in-session freshness). */
export const DEFAULT_TTL_MS = 86_400_000;
/** Default tag, so `cache.invalidateTags('swr')` purges everything this package wrote. */
export const DEFAULT_TAGS: readonly string[] = ['swr'];

/**
 * The `cache.set` stamp one write goes out with: the resolved `ttlMs`, and the `tags`
 * option — a resolver among them, still pending until the fetched data exists to be
 * handed to it. `any` on the resolver's data, the same erasure `Middleware` applies to
 * the fetcher's: the hook's declared `Data` and SWR's own never meet at this layer.
 */
interface ResolvedStamp {
  ttlMs: number;
  tags: BlazeSWRTags<any>;
}

/**
 * Wraps a fetcher so every successful result is written to the Blaze Cache before SWR
 * sees it.
 *
 * Kept module-level (rather than an inline closure) so the narrowing of `fetcher` and
 * the key happens at the call site: inside a captured closure TypeScript would have to
 * assume the parameter changed since the null check.
 *
 * Fetch failures propagate untouched — SWR keeps its own error state, and the cache only
 * ever holds data that a fetcher actually returned. `undefined` is skipped: SWR reads it
 * as "no data", so there is nothing worth stamping a TTL onto. The raw result goes into a
 * {@link BlazeSWRRecord} envelope, so hydration can tell this package's writes apart from
 * foreign values on a shared cache (see {@link readBlazeSWRRecord}); the fetcher itself
 * still resolves with the bare result, exactly as the caller's fetcher would.
 *
 * Cache-side failures are guarded the other way round: a `tags` resolver or a `cache.set`
 * that throws cannot take the fetched data with it — the write is skipped, one warning
 * says so, and the result resolves as if the cache were never there.
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
      try {
        // A `tags` resolver gets the same argument the fetcher just received — the
        // resolved key, never the hash it is filed under.
        const tags = typeof stamp.tags === 'function' ? stamp.tags(args[0], data) : stamp.tags;
        const record: BlazeSWRRecord<Data> = { kind: 'swr', data, storedAt: Date.now() };
        cache.set(key, record, { ttlMs: stamp.ttlMs, tags });
      } catch (error) {
        console.warn('[blaze-cache] storing the response failed — it is returned unstored', error);
      }
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
 * | cache failure | never fatal — a read that throws seeds nothing (warned once), a write that throws returns the data unwritten (warned per write) |
 *
 * The seeded entry is deliberately **not** treated as fresh: SWR's `fallbackData` carries
 * no timestamp, so `revalidateIfStale` (on by default) still revalidates on mount. Set
 * `revalidateOnMount: false` or `revalidateIfStale: false` when a cache hit should skip
 * the network entirely.
 *
 * `forceRefresh: true` (per call, or once on the middleware) inverts the first row: the
 * persisted entry is not read at all, and `revalidateOnMount` is forced to `true` so the
 * fetcher runs regardless of what this call or the provider would otherwise decide —
 * while the write still happens, so the next mount starts from the fresh result.
 *
 * Precedence for what wins the first paint: a caller-supplied `fallbackData`, then an
 * entry in a provider-level `fallback` map, then the Blaze Cache. Precedence for the
 * write stamp and `forceRefresh`: the current call's options, then the middleware's own
 * options, then {@link DEFAULT_TTL_MS}/{@link DEFAULT_TAGS}/no forced refresh.
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
export function blazeSWRMiddleware<Data = unknown>(
  cache: BlazeSWRCacheLike,
  options: BlazeSWRMiddlewareOptions<Data> = {},
): Middleware {
  return (useSWRNext) => (key, fetcher, config) => {
    const blazeKey = resolveBlazeKey(key);

    // Per-call `ttlMs`/`tags`/`forceRefresh` ride in the SWR config (SWR merges unknown
    // options through), then the middleware's own options, then the package defaults.
    const callOptions = config as SWRConfiguration & BlazeSWRMiddlewareOptions<Data>;
    const stamp: ResolvedStamp = {
      ttlMs: callOptions.ttlMs ?? options.ttlMs ?? DEFAULT_TTL_MS,
      tags: callOptions.tags ?? options.tags ?? DEFAULT_TAGS,
    };
    const forceRefresh = callOptions.forceRefresh ?? options.forceRefresh ?? false;

    // Hydration: `peek` first so renders never move the hit rate or nudge eviction —
    // a recording `get` stays the fallback for caches that predate it. Only this
    // package's own envelope seeds the UI; a foreign value under a colliding key reads
    // as a miss rather than being handed to the component as `data`. `forceRefresh`
    // skips the read entirely — the persisted entry must not quiet this mount.
    const data =
      blazeKey === null || forceRefresh ? undefined : readBlazeSWRRecord(cache, blazeKey);

    // Caller-supplied fallbacks stay authoritative: `fallbackData` directly, or a
    // provider-level `fallback` entry for this exact key. Blaze only fills the gap.
    const callerFallback =
      config.fallbackData !== undefined ||
      (blazeKey !== null && config.fallback?.[blazeKey] !== undefined);

    // A forced refresh has to actually fetch: with nothing seeded, SWR needs
    // `revalidateOnMount` — and it must win even over an explicit `false` (from this call
    // or the provider), because skipping the read is only honest if the network runs. The
    // branches cannot overlap: `data` is undefined whenever `forceRefresh` is set.
    const nextConfig =
      data !== undefined && !callerFallback
        ? ({ ...config, fallbackData: data } as SWRConfiguration)
        : forceRefresh && blazeKey !== null
          ? ({ ...config, revalidateOnMount: true } as SWRConfiguration)
          : config;

    const nextFetcher =
      fetcher !== null && blazeKey !== null
        ? persistingFetcher(fetcher, cache, blazeKey, stamp)
        : fetcher;

    return useSWRNext(key, nextFetcher, nextConfig) as SWRResponse;
  };
}
