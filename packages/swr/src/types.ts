import type { BareFetcher, SWRConfiguration } from 'swr';

/**
 * What this package writes to the cache: the fetcher's result wrapped in a self-describing
 * envelope.
 *
 * The `kind: 'swr'` discriminator exists for the **shared-cache** case: on a store also
 * written by `@blaze-cache/axios`, `@blaze-cache/fetch` or `@blaze-cache/react-query`, a
 * forced key collision can park a foreign value under an SWR key — an axios response
 * record, a react-query mirror record, a raw app entry. Hydration only seeds the UI from
 * values that carry this envelope (see {@link readBlazeSWRRecord}); anything else reads as
 * the miss it is, instead of being handed to the component as `data`.
 *
 * `storedAt` is recorded for introspection and debugging; freshness is SWR's own concern
 * (it revalidates per its normal rules), so the middleware never reads it.
 */
export interface BlazeSWRRecord<T = unknown> {
  /** Discriminator — the literal this envelope is recognised by. */
  kind: 'swr';
  /** The fetcher's result, exactly as returned. */
  data: T;
  /** Wall-clock time of the write. */
  storedAt: number;
}

/**
 * The slice of a cache the SWR integration needs.
 *
 * The concrete `BlazeCache` from `@blaze-cache/core` fits it directly
 * (`createCache()` returns `BlazeCache<any>`), and so does anything else with the same
 * `get`/`set` — a `Map`-backed shim, a test double, a wrapper of your own. Pass
 * `createCache<YourRecord>()` if you would rather have the compiler check both directions.
 *
 * `peek` and `invalidateTags` are optional on purpose:
 *
 * * `peek` is the render-time read (see {@link BlazeSWRCacheLike.peek}); caches that
 *   predate it fall back to `get`.
 * * `invalidateTags` is only *documented* as the invalidation entry point — this package
 *   never calls it, so a cache without tags still works; tag invalidation then simply
 *   needs `cache.invalidateTags` (or a manual `cache.delete`) on your side.
 */
export interface BlazeSWRCacheLike<V = any> {
  get(key: string): V | undefined;
  /**
   * The same lookup as {@link BlazeSWRCacheLike.get}, minus every side effect: no hit or
   * miss is recorded and the entry is not marked visited for eviction.
   *
   * The middleware prefers it on every render — rendering must not be able to move the
   * hit rate or decide who gets evicted next, and renders happen far more often than
   * real reads (StrictMode double-renders, discarded concurrent renders). The concrete
   * `BlazeCache` has it.
   */
  peek?(key: string): V | undefined;
  set(key: string, value: V, options?: { ttlMs?: number; tags?: readonly string[] }): void;
  delete?(key: string): boolean;
  /** Removes every entry carrying any of `tags`, returning the removed keys. */
  invalidateTags?(...tags: string[]): string[];
}

/**
 * How long a written entry survives in the Blaze Cache, and under which tags — the
 * `cache.set` stamp, both optional.
 *
 * Read from three places, in order of precedence: the options passed to the current
 * `useSWR`/`useBlazeSWR` call, the options given to {@link blazeSWRMiddleware}, then the
 * package defaults (24 h, tag `'swr'`).
 */
export interface BlazeSWRStampOptions {
  /** TTL for the entry in milliseconds. Defaults to 24 h. */
  ttlMs?: number;
  /** Tags attached to the entry — enables `cache.invalidateTags('todos')`. */
  tags?: readonly string[];
}

/** Options {@link blazeSWRMiddleware} accepts — just the Blaze-side stamp. */
export type BlazeSWRMiddlewareOptions = BlazeSWRStampOptions;

/**
 * Normal SWR options plus the Blaze Cache stamp (`ttlMs`/`tags`) — everything
 * `useSWR` accepts keeps working; the two extra fields only shape how successful
 * fetches are written to the Blaze Cache.
 *
 * They may also be set once for every hook under an `SWRConfig` provider (cast to
 * `BlazeSWRStampOptions` — SWR merges unknown options into the config the middleware
 * receives), or passed straight to {@link blazeSWRMiddleware} when you wire it up by hand.
 */
export interface BlazeSWROptions<
  Data = any,
  Error = any,
  SWRFetcher extends BareFetcher<any> = BareFetcher<Data>,
> extends SWRConfiguration<Data, Error, SWRFetcher>,
    BlazeSWRStampOptions {}
