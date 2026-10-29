import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DefaultError,
  InfiniteData,
  QueryClient,
  QueryKey,
  UseInfiniteQueryOptions,
  UseInfiniteQueryResult,
} from '@tanstack/react-query';

import { readBlazeRecord } from './useBlazeQuery.js';
import type { BlazeQueryCacheLike } from './types.js';

/**
 * The options {@link useBlazeInfiniteQuery} hands to `useInfiniteQuery`: the caller's
 * options with the Blaze Cache mirror seeded in, or the caller's options returned
 * untouched.
 *
 * Infinite queries are mirrored as a whole — TanStack stores `InfiniteData` (every page
 * plus its page params) as one `query.state.data`, so the sync layer persists that one
 * object and this function seeds it straight back as `initialData`. The first render
 * after a reload therefore paints **all previously loaded pages at once**, while
 * `dataUpdatedAt` carries the original timestamp so TanStack still refetches in the
 * background.
 *
 * The rules are exactly {@link seedBlazeQueryOptions}'s, deliberately:
 *
 * * A caller-supplied `initialData` or `initialDataUpdatedAt` is authoritative — the
 *   mirror stays out of it entirely.
 * * With neither supplied, the mirror seeds both fields together, so the data paints
 *   instantly *and* is treated as stale.
 */
export function seedBlazeInfiniteQueryOptions<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = InfiniteData<TQueryFnData>,
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
>(
  cache: BlazeQueryCacheLike,
  client: QueryClient,
  options: UseInfiniteQueryOptions<TQueryFnData, TError, TData, TQueryKey, TPageParam>,
): UseInfiniteQueryOptions<TQueryFnData, TError, TData, TQueryKey, TPageParam> {
  // Same authority rule as the non-infinite seed: an explicit `initialData` (function
  // form included) or its timestamp short-circuits the mirror entirely.
  if (options.initialData !== undefined || options.initialDataUpdatedAt !== undefined) {
    return options;
  }

  const record = readBlazeRecord(cache, client, options);
  if (record === undefined) return options;

  // The mirror's payload *is* an `InfiniteData` object — that is what TanStack put in
  // the cache — so it slots into `initialData` without transformation. The cast exists
  // because the record type is deliberately untyped (`unknown`).
  return {
    ...options,
    initialData: record.data as InfiniteData<TQueryFnData, TPageParam>,
    initialDataUpdatedAt: record.dataUpdatedAt,
  } as UseInfiniteQueryOptions<TQueryFnData, TError, TData, TQueryKey, TPageParam>;
}

/**
 * `useInfiniteQuery` that starts from the Blaze Cache.
 *
 * A previously mirrored `InfiniteData` payload — every page and page param fetched in an
 * earlier session — is injected as `initialData` **with its original `dataUpdatedAt`**,
 * so the list paints fully populated on the first render after a reload while TanStack
 * still considers it stale and refetches in the background. Caller-supplied
 * `initialData`/`initialDataUpdatedAt` short-circuit the seeding entirely; see
 * {@link seedBlazeInfiniteQueryOptions}.
 *
 * ```tsx
 * const feed = useBlazeInfiniteQuery(cache, {
 *   queryKey: ['feed', userId],
 *   queryFn: ({ pageParam }) => fetchFeed(userId, pageParam),
 *   initialPageParam: 0,
 *   getNextPageParam: (lastPage) => lastPage.nextCursor,
 * });
 * // feed.data?.pages — the pages cached before the reload, immediately
 * ```
 *
 * Requires a `QueryClientProvider` above it, exactly like `useInfiniteQuery`.
 */
export function useBlazeInfiniteQuery<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = InfiniteData<TQueryFnData>,
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
>(
  cache: BlazeQueryCacheLike,
  options: UseInfiniteQueryOptions<TQueryFnData, TError, TData, TQueryKey, TPageParam>,
): UseInfiniteQueryResult<TData, TError> {
  const client = useQueryClient();

  return useInfiniteQuery<TQueryFnData, TError, TData, TQueryKey, TPageParam>(
    seedBlazeInfiniteQueryOptions(cache, client, options),
  );
}
