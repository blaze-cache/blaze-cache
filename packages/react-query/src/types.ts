import type { QueryCacheNotifyEvent, QueryClientConfig, QueryKey } from '@tanstack/react-query';

/**
 * What the integration stores for one query.
 *
 * `dataUpdatedAt` is TanStack's own timestamp, so a restored entry feeds its staleness
 * arithmetic exactly as if the fetch had happened in this session.
 */
export interface BlazeQueryRecord<T = unknown> {
  data: T;
  dataUpdatedAt: number;
}

/**
 * The slice of a cache the integration needs.
 *
 * The value type is `any` so that a plain `createCache()` (which stores heterogeneous values)
 * is assignable without ceremony. Pass `createCache<BlazeQueryRecord>()` if you would rather
 * have the compiler check both directions.
 */
export interface BlazeQueryCacheLike {
  get(key: string): BlazeQueryRecord | undefined;
  /**
   * The same lookup as {@link BlazeQueryCacheLike.get}, minus every side effect: no hit or miss
   * is recorded and the entry is not marked visited for eviction.
   *
   * Optional, so a cache that only implements `get` keeps typechecking — {@link useBlazeQuery}
   * falls back to the recording read for those. The concrete `BlazeCache` has it, and the hook
   * prefers it: rendering must not be able to move the hit rate or decide who gets evicted
   * next, and renders happen far more often than real reads (StrictMode double-renders,
   * discarded concurrent renders).
   */
  peek?(key: string): BlazeQueryRecord | undefined;
  set(
    key: string,
    value: BlazeQueryRecord,
    options?: { ttlMs?: number; tags?: readonly string[] },
  ): void;
  delete(key: string): boolean;
  has(key: string): boolean;
}

/** Options for {@link syncBlazeQueryCache} and {@link createBlazeQueryClient}. */
export interface BlazeQuerySyncOptions {
  cache: BlazeQueryCacheLike;

  /**
   * How long mirrored data survives in the Blaze Cache.
   *
   * Default `86_400_000` (24 h) — TanStack owns freshness in-session, Blaze Cache owns it
   * across sessions.
   */
  ttlMs?: number;

  /** Tags attached to mirrored entries, enabling `cache.invalidateTags('react-query')`. */
  tags?: readonly string[];

  /** Return `true` to keep a query out of the Blaze Cache entirely. */
  skip?: (queryKey: QueryKey, queryHash: string) => boolean;

  /** Mirror queries whose `data` is `undefined`. Default `false`. */
  includeEmpty?: boolean;
}

/** {@link BlazeQuerySyncOptions} plus options forwarded to the `QueryClient`. */
export interface BlazeQueryClientOptions extends BlazeQuerySyncOptions {
  /** Options handed to `new QueryClient(...)` — its own `queryCache` is respected. */
  client?: QueryClientConfig;
}
