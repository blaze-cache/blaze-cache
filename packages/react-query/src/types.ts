import type { QueryClientConfig, QueryFilters, QueryKey } from '@tanstack/react-query';

/**
 * What the integration stores for one query.
 *
 * `dataUpdatedAt` is TanStack's own timestamp, so a restored entry feeds its staleness
 * arithmetic exactly as if the fetch had happened in this session.
 *
 * `queryKey` is written by {@link syncBlazeQueryCache} and the imperative helpers so a
 * mirror entry is self-describing: {@link dehydrateBlazeQueryClient} needs it to rebuild
 * a TanStack query from the mirror alone. Optional because entries written by older
 * versions of this package do not carry it — those still hydrate the hooks, they just
 * cannot be dehydrated back into TanStack.
 */
export interface BlazeQueryRecord<T = unknown> {
  data: T;
  dataUpdatedAt: number;
  queryKey?: QueryKey;
  /**
   * `'infinite'` for infinite queries, absent for plain ones — the same `_type` TanStack
   * stamps on the query itself, so {@link dehydrateBlazeQueryClient} can rebuild an infinite
   * query as one. Written by the sync layer and the imperative helpers for records that
   * carry `queryKey`; absent (meaning: plain) on older records.
   */
  queryType?: 'infinite';
}

/**
 * One live mirror entry as {@link BlazeQueryCacheLike.entries} reports it.
 *
 * Structurally a subset of the concrete cache's `CacheEntry`, so `cache.entries()` is
 * assignable without ceremony.
 */
export interface BlazeMirrorEntry {
  /** The query hash the record is filed under — a `DehydratedQuery.queryHash`. */
  key: string;
  value: BlazeQueryRecord;
  /** Tags attached to this entry, for tag-filtered purges and dehydration. */
  readonly tags: readonly string[];
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
  /**
   * Removes every entry carrying any of `tags`, returning the removed keys.
   *
   * Not called by this package: the purge helpers enumerate {@link BlazeQueryCacheLike.entries}
   * instead (or throw when it is absent), so a purge on a cache shared with another
   * integration stays on mirror records — `invalidateTags` reaches the whole tag namespace,
   * all integrations included. It remains part of the cache contract for callers who want
   * exactly that.
   */
  invalidateTags?(...tags: string[]): string[];
  /**
   * Every live entry — key, record and tags — without touching statistics.
   *
   * Optional, like {@link BlazeQueryCacheLike.peek} and
   * {@link BlazeQueryCacheLike.invalidateTags}: enumerating the mirror is what lets the
   * filter-aware helpers ({@link invalidateBlazeQueries}, {@link removeBlazeQueries},
   * {@link dehydrateBlazeQueryClient}) match entries the current session's TanStack cache
   * never touched — a prefix purge after a user switch, a full-mirror wipe, a dehydration
   * of everything persisted. When a filter needs enumeration and it is absent, those
   * helpers **throw** instead of silently purging only what TanStack happens to know right
   * now. The concrete `BlazeCache` has it as `entries()`.
   */
  entries?(): BlazeMirrorEntry[];
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

/** How an imperative helper writes into the Blaze Cache alongside TanStack Query. */
export interface BlazeMirrorOptions {
  /** TTL for the mirror entry. Defaults to the same 24 h the sync layer uses. */
  ttlMs?: number;
  /** Tags for the mirror entry. Defaults to `['react-query']`. */
  tags?: readonly string[];
}

/**
 * A `QueryFilters` with an extra Blaze tag selector.
 *
 * `tags` matches mirror entries through {@link BlazeQueryCacheLike}-style tag lookup on
 * the concrete cache (`cache.invalidateTags` / `cache.keysWithTag`). When both a
 * `queryKey`/`predicate` and `tags` are given, a query must match **both**.
 */
export interface BlazeQueryFilters extends QueryFilters {
  /** Invalidate/remove mirror entries carrying any of these tags. */
  tags?: readonly string[];
  /**
   * Which queries to refetch when invalidating — forwarded to TanStack's
   * `invalidateQueries`, ignored by `removeQueries` (removed queries refetch only when a
   * hook asks for them again).
   */
  refetchType?: 'active' | 'inactive' | 'all' | 'none';
}
