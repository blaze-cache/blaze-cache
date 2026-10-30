import { matchQuery, partialMatchKey } from '@tanstack/react-query';
import type {
  DefaultError,
  FetchQueryOptions,
  QueryClient,
  QueryFilters,
  QueryKey,
  UseQueryOptions,
} from '@tanstack/react-query';

import { isMirrorRecord } from './record.js';
import { resolveQueryHash } from './hash.js';
import { DEFAULT_TAGS, DEFAULT_TTL_MS } from './sync.js';
import { seedBlazeQueryOptions } from './useBlazeQuery.js';
import type {
  BlazeMirrorEntry,
  BlazeMirrorOptions,
  BlazeQueryCacheLike,
  BlazeQueryFilters,
} from './types.js';

/**
 * The options {@link prefetchBlazeQuery} accepts: TanStack's own `FetchQueryOptions` plus
 * how the fetched result should be stamped into the Blaze Cache.
 */
export interface BlazeFetchQueryOptions<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
> extends FetchQueryOptions<TQueryFnData, TError, TData, TQueryKey> {
  /** TTL for the mirror entry. Defaults to the same 24 h the sync layer uses. */
  ttlMs?: number;
  /** Tags for the mirror entry. Defaults to `['react-query']`. */
  tags?: readonly string[];
}

/** The `cache.set` options a helper writes with: the caller's, or the sync layer's defaults. */
function mirrorWriteOptions(options?: BlazeMirrorOptions): {
  ttlMs: number;
  tags: readonly string[];
} {
  return {
    ttlMs: options?.ttlMs ?? DEFAULT_TTL_MS,
    tags: options?.tags ?? DEFAULT_TAGS,
  };
}

/** Every live mirror entry, or a thrown error — never a silently partial operation. */
function entriesOf(cache: BlazeQueryCacheLike): readonly BlazeMirrorEntry[] {
  if (!cache.entries) {
    throw new Error(
      '[blaze-cache/react-query] This filter must be matched against every persisted ' +
        'entry, but the cache does not implement `entries()`. Refusing to run a ' +
        'deliberately partial purge — use the concrete `BlazeCache`, or narrow the ' +
        'filter to `exact` query keys, which need no enumeration.',
    );
  }
  return cache.entries();
}

/** True when `entry` carries any of `tags`. */
function hasAnyTag(entry: BlazeMirrorEntry, tags: readonly string[]): boolean {
  return entry.tags.some((tag) => tags.includes(tag));
}

/**
 * Purges every **mirror record** carrying any of `tags`, returning the removed keys.
 *
 * Deliberately *not* `cache.invalidateTags`: the core's tag index is one global namespace
 * with no per-integration scoping, so on a cache shared with `@blaze-cache/axios`,
 * `@blaze-cache/fetch` or `@blaze-cache/swr` that call would silently purge other
 * integrations' entries too. Enumerating `entries()` lets the selection be narrowed to
 * this package's own records (see {@link isMirrorRecord}) plus tag membership — a
 * `tags` purge here removes what *this* integration tagged and nothing else.
 *
 * Throws when the cache cannot enumerate: a `tags` selector that quietly matched nothing
 * is exactly the bug this package refuses to ship.
 */
function purgeMirrorByTags(cache: BlazeQueryCacheLike, tags: readonly string[]): string[] {
  return entriesOf(cache)
    .filter((entry) => isMirrorRecord(entry.value) && hasAnyTag(entry, tags))
    .map((entry) => entry.key);
}

/**
 * Resolves one {@link BlazeQueryFilters} against **both** caches: purges the matching
 * mirror entries immediately and returns the filters TanStack's side of the operation
 * should run with.
 *
 * The two sides see different data, so the selection rules are explicit:
 *
 * * **`tags`** live only in the Blaze Cache. A tags-only filter purges by tag (above) and
 *   narrows TanStack to the queries whose mirror entries were removed. Combined with a
 *   key or a state filter, `entries()` is required so the selection can be intersected
 *   rather than unioned.
 * * **`queryKey`/`exact`** match each mirror entry's stored `queryKey`, so a prefix purge
 *   also reaches entries from earlier sessions that this TanStack cache never loaded.
 *   `exact` keys are a single computable hash and need no enumeration. Entries written
 *   before records carried a `queryKey` can only be reached through their live TanStack
 *   query, which the union below covers.
 * * **`predicate`/`stale`/`type`/`fetchStatus`** read query state, which mirror entries do
 *   not carry — those select TanStack queries, and the mirror follows their hashes. A
 *   `tags` filter intersected with them therefore needs `entries()` too.
 * * **No filters** purge the whole mirror (and remove/invalidate every TanStack query).
 */
function purgeMirrorAndBuildFilters(
  cache: BlazeQueryCacheLike,
  client: QueryClient,
  filters: BlazeQueryFilters,
): QueryFilters {
  const { tags, ...queryFilters } = filters;
  const { queryKey, exact, predicate, stale, type = 'all', fetchStatus } = queryFilters;
  const stateful =
    predicate !== undefined || stale !== undefined || type !== 'all' || fetchStatus !== undefined;

  // Hashes of the queries TanStack currently knows and that match the query-side filters —
  // the only mirror entries reachable when the selection leans on live query state.
  const knownHashes = (): Set<string> =>
    new Set(client.getQueryCache().findAll(queryFilters).map((query) => query.queryHash));

  let removed: string[];

  if (stateful) {
    const hashes = knownHashes();
    if (tags) {
      // Intersect: the entry must carry the tag *and* belong to a query TanStack matched.
      removed = entriesOf(cache)
        .filter((entry) => hasAnyTag(entry, tags) && hashes.has(entry.key))
        .map((entry) => entry.key);
    } else {
      removed = [...hashes];
    }
  } else if (queryKey) {
    const exactHash = exact ? resolveQueryHash(client, queryKey) : undefined;
    removed = entriesOf(cache)
      .filter((entry) => {
        if (tags && !hasAnyTag(entry, tags)) return false;
        if (exactHash !== undefined) {
          // An exact key is a single candidate hash — no enumeration needed for the
          // key match itself, and the tag test above already narrowed it.
          return entry.key === exactHash;
        }
        const entryKey = entry.value.queryKey;
        // Legacy records (no `queryKey`) predate the self-describing format; they are only
        // reachable through a live TanStack query, which the invalidate/remove side covers.
        if (entryKey === undefined) return false;
        return partialMatchKey(entryKey, queryKey);
      })
      .map((entry) => entry.key);
  } else if (tags) {
    removed = purgeMirrorByTags(cache, tags);
  } else {
    // No filters at all: every *mirror record* goes — and nothing else. On a shared
    // cache the store holds other integrations' entries too (see `isMirrorRecord`), so
    // "everything persisted for queries" must not read as "everything in the cache".
    removed = entriesOf(cache)
      .filter((entry) => isMirrorRecord(entry.value))
      .map((entry) => entry.key);
  }

  for (const key of removed) cache.delete(key);

  // TanStack's side. With `tags` in play, tag membership is what the mirror knew and
  // TanStack cannot see, so it becomes a predicate composed with the original filters —
  // every other selector still applies through `matchQuery`.
  if (tags) {
    const removedSet = new Set(removed);
    return {
      ...queryFilters,
      predicate: (query) => removedSet.has(query.queryHash) && matchQuery(queryFilters, query),
    };
  }
  return queryFilters;
}

/**
 * `prefetchQuery` that starts from the Blaze Cache.
 *
 * Mirrors {@link useBlazeQuery} imperatively: the persisted record is seeded as
 * `initialData` with its original `dataUpdatedAt` before prefetching, so a `staleTime`
 * window can be satisfied from disk without touching the network at all. When a fetch
 * does run, its result is written back to the mirror under the same record (tags, TTL and
 * self-describing `queryKey` included) — even on a client with no sync layer attached.
 *
 * Errors are swallowed exactly like TanStack's `prefetchQuery`.
 *
 * ```ts
 * await prefetchBlazeQuery(cache, client, {
 *   queryKey: ['todos', userId],
 *   queryFn: () => fetchTodos(userId),
 *   staleTime: 5 * 60_000,
 *   tags: ['todos', `user:${userId}`],
 * });
 * ```
 */
export async function prefetchBlazeQuery<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  cache: BlazeQueryCacheLike,
  client: QueryClient,
  options: BlazeFetchQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
): Promise<void> {
  // Seed first, so freshness is judged against the persisted record — a mirror hit inside
  // `staleTime` completes without a network round trip.
  const seeded = seedBlazeQueryOptions(
    cache,
    client,
    options as UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
  );
  await client.prefetchQuery(seeded);

  const hash = resolveQueryHash(client, options.queryKey, options);
  const query = client.getQueryCache().get(hash);
  const data = query?.state.data;
  if (!query || data === undefined) return; // failed fetch — nothing to persist

  cache.set(
    hash,
    { data, dataUpdatedAt: query.state.dataUpdatedAt, queryKey: options.queryKey },
    mirrorWriteOptions(options),
  );
}

/**
 * `setQueryData` that also writes the Blaze Cache mirror.
 *
 * The TanStack write goes through first (so its exact `dataUpdatedAt` — and structural
 * sharing, which may keep the previous object — is what both caches record), then the
 * mirror is written synchronously under the resolved query hash, tagged per `options`.
 * With a sync layer attached, its batched write sees this identical record and leaves the
 * helper's `ttlMs`/`tags` in place.
 *
 * `data` is a plain value, not an updater — pass a function to TanStack's own
 * `client.setQueryData` when you need to read the previous value first. `undefined` is
 * ignored on both sides, exactly as TanStack ignores it.
 *
 * ```ts
 * setBlazeQueryData(cache, client, ['settings', userId], settings, {
 *   tags: ['settings', `user:${userId}`],
 * });
 * ```
 *
 * @returns The stored data, or `undefined` when `data` was `undefined`.
 */
export function setBlazeQueryData<TData = unknown, TQueryKey extends QueryKey = QueryKey>(
  cache: BlazeQueryCacheLike,
  client: QueryClient,
  queryKey: TQueryKey,
  data: TData,
  options?: BlazeMirrorOptions,
): TData | undefined {
  // Explicit `QueryKey` (rather than the caller's `TQueryKey`) for the key type argument:
  // a generic key keeps `InferDataFromTag` a deferred conditional the data would not
  // assign to, while the widened key resolves it to `TData` — and tag inference does not
  // matter here, since this function *supplies* the data instead of reading it.
  const stored = client.setQueryData<TData, QueryKey>(queryKey, data);
  if (stored === undefined) return undefined;

  const hash = resolveQueryHash(client, queryKey);
  const dataUpdatedAt =
    client.getQueryCache().get(hash)?.state.dataUpdatedAt ?? Date.now() /* always set */;
  cache.set(hash, { data: stored, dataUpdatedAt, queryKey }, mirrorWriteOptions(options));
  return stored;
}

/**
 * `invalidateQueries` for both caches at once: TanStack marks the matching queries stale
 * (active ones refetch, as usual), and the matching **persisted** records are purged so a
 * reload cannot paint pre-invalidation data.
 *
 * Keeping the mirror entry instead would defeat the call — `dataUpdatedAt` is TanStack's
 * staleness clock, and a persisted record would come back as `initialData` on the next
 * session regardless of when it was invalidated. In-session behaviour is untouched:
 * the refetched results re-mirror themselves through the sync layer, stale-while-revalidate
 * included. This mirrors the sync layer's own contract that *explicit* purges remove
 * mirror entries (see {@link syncBlazeQueryCache}).
 *
 * Filters work on both sides; see {@link BlazeQueryFilters} for how `tags`, keys and
 * query-state selectors combine. Purging by tag or by non-exact key needs
 * `cache.entries` — both **throw** when it is absent rather than under-delivering.
 * (Tag purges deliberately enumerate rather than call `cache.invalidateTags`: the core's
 * tag index is one global namespace, so that call would reach other integrations' entries
 * on a shared cache. Enumeration keeps the purge on mirror records — see
 * {@link isMirrorRecord}.)
 *
 * ```ts
 * await invalidateBlazeQueries(cache, client, { queryKey: ['todos', userId] });
 * await invalidateBlazeQueries(cache, client, { tags: [`user:${userId}`] });
 * ```
 *
 * @returns Resolves like TanStack's `invalidateQueries` — once the triggered refetches settle.
 */
export function invalidateBlazeQueries(
  cache: BlazeQueryCacheLike,
  client: QueryClient,
  filters: BlazeQueryFilters = {},
): Promise<void> {
  const tanstackFilters = purgeMirrorAndBuildFilters(cache, client, filters);
  return client.invalidateQueries(tanstackFilters);
}

/**
 * `removeQueries` for both caches at once: TanStack drops the matching queries outright,
 * and the matching persisted records are purged — the explicit-purge half of the sync
 * layer's contract (see {@link syncBlazeQueryCache}).
 *
 * The same mirror-side rules and rejections as {@link invalidateBlazeQueries} apply; the
 * difference between the two helpers is what happens on TanStack's side (dropped vs.
 * marked stale), not what happens in the mirror.
 *
 * ```ts
 * // After a logout — including queries from earlier sessions TanStack never loaded:
 * removeBlazeQueries(cache, client, { tags: [`user:${userId}`] });
 * // Every mirror record — and only those, so foreign entries on a shared cache stay:
 * removeBlazeQueries(cache, client);
 * ```
 */
export function removeBlazeQueries(
  cache: BlazeQueryCacheLike,
  client: QueryClient,
  filters: BlazeQueryFilters = {},
): void {
  const tanstackFilters = purgeMirrorAndBuildFilters(cache, client, filters);
  client.removeQueries(tanstackFilters);
}
