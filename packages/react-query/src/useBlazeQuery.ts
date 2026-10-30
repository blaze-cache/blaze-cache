import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DefaultError,
  QueryClient,
  QueryKey,
  UseQueryOptions,
  UseQueryResult,
} from '@tanstack/react-query';

import { resolveQueryHash } from './hash.js';
import { isMirrorRecord } from './record.js';
import type { BlazeQueryCacheLike, BlazeQueryRecord } from './types.js';

/**
 * The options {@link useBlazeQuery} hands to `useQuery`: the caller's options with the Blaze
 * Cache mirror seeded in, or the caller's options returned untouched.
 *
 * The whole render-time data path — hash resolution, mirror read, seeding — is a plain
 * function, so it can be exercised without a DOM renderer (see the package's tests).
 *
 * The rules, in order:
 *
 * * A caller-supplied `initialData` **or** `initialDataUpdatedAt` is authoritative: the mirror
 *   stays out of it entirely. Its own timestamp belongs to whatever *it* mirrored and must
 *   never ride along with data the caller already dated — stamping it on fresh `initialData`
 *   would mark the caller's data ancient and force an immediate, unwanted refetch.
 * * With neither supplied, the mirror seeds **both** fields together: the original
 *   `dataUpdatedAt` makes the first paint instant while TanStack still treats the data as
 *   stale, so the background refetch happens exactly as it would without the cache.
 */
export function seedBlazeQueryOptions<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  cache: BlazeQueryCacheLike,
  client: QueryClient,
  options: UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
): UseQueryOptions<TQueryFnData, TError, TData, TQueryKey> {
  // `undefined` in either slot means "not supplied" — which keeps an explicit `initialData`
  // (including its function form) authoritative, exactly like a `??` chain would.
  if (options.initialData !== undefined || options.initialDataUpdatedAt !== undefined) {
    return options;
  }

  const record = readBlazeRecord(cache, client, options);
  if (record === undefined) return options;

  // `initialData` is declared against `TData` in one overload and `TQueryFnData` in another;
  // the spread makes the union unreadable to the overloads, so it is asserted once here.
  return {
    ...options,
    initialData: record.data as TQueryFnData,
    initialDataUpdatedAt: record.dataUpdatedAt,
  } as UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>;
}

/**
 * The mirror lookup every seed function shares: resolve the query's hash the way TanStack
 * will file it, then read the record back **without** touching cache statistics.
 *
 * Kept separate from the seeding rules so {@link seedBlazeQueryOptions},
 * {@link seedBlazeInfiniteQueryOptions} and {@link seedBlazeQueriesOptions} cannot drift
 * from each other — a custom `queryKeyHashFn` or a `peek`-less cache behaves identically
 * in all three.
 */
export function readBlazeRecord(
  cache: BlazeQueryCacheLike,
  client: QueryClient,
  // Deliberately `any`-typed generics: callers pass options generic in `TQueryKey`, and a
  // `readonly unknown[]`-constrained pick rejects `QueryKeyHashFunction<TQueryKey>` under
  // contravariance even though every concrete instantiation fits.
  options: Pick<
    UseQueryOptions<any, any, any, any>,
    'queryKey' | 'queryHash' | 'queryKeyHashFn'
  >,
): BlazeQueryRecord | undefined {
  // Sync writes under `query.queryHash`, which honors a configured `queryKeyHashFn`; resolve
  // the hash the same way TanStack does, or a custom hasher points the lookup at a key the
  // mirror never used.
  const hash = resolveQueryHash(client, options.queryKey, options);

  // `peek` first: `get` marks the entry used for SIEVE and counts a hit/miss, so a render
  // would mutate global cache state — StrictMode double-renders and discarded concurrent
  // renders included — and skew the stats panel. `get` stays the fallback for caches that
  // predate `peek` (it is optional on `BlazeQueryCacheLike` for their sake).
  const record = cache.peek ? cache.peek(hash) : cache.get(hash);

  // Shape gate: on a cache shared with `@blaze-cache/axios`, `@blaze-cache/fetch` or
  // `@blaze-cache/swr`, a forced key collision can park a foreign value under this query's
  // hash. Seeding it would hand an HTTP body (or a raw fetcher result) to TanStack as
  // `initialData` — with no `dataUpdatedAt` to date it, so a configured `staleTime` would
  // be ignored too. Only a record this package could have written is mirror data; anything
  // else reads as the miss it is. See {@link isMirrorRecord}.
  return isMirrorRecord(record) ? record : undefined;
}

/**
 * `useQuery` that starts from the Blaze Cache.
 *
 * A previously mirrored result is injected as `initialData` **with its original
 * `dataUpdatedAt`**, so the first render after a reload paints real data immediately and
 * TanStack still considers it stale — the background refetch happens exactly as it would
 * without the cache. Caller-supplied `initialData`/`initialDataUpdatedAt` short-circuit the
 * seeding entirely; see {@link seedBlazeQueryOptions}.
 *
 * ```tsx
 * const todos = useBlazeQuery(cache, {
 *   queryKey: ['todos', userId],
 *   queryFn: () => api.get('/todos').then((r) => r.data),
 * });
 * ```
 *
 * This requires a `QueryClientProvider` above it, exactly like `useQuery` — the client is
 * read from context to replay TanStack's own option defaults when resolving the lookup hash.
 */
export function useBlazeQuery<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  cache: BlazeQueryCacheLike,
  options: UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
): UseQueryResult<TData, TError> {
  const client = useQueryClient();

  return useQuery<TQueryFnData, TError, TData, TQueryKey>(
    seedBlazeQueryOptions(cache, client, options),
  );
}
