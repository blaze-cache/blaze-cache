import { useQuery } from '@tanstack/react-query';
import type {
  DefaultError,
  QueryKey,
  UseQueryOptions,
  UseQueryResult,
} from '@tanstack/react-query';

import { hashQueryKey } from './hash.js';
import type { BlazeQueryCacheLike } from './types.js';

/**
 * `useQuery` that starts from the Blaze Cache.
 *
 * A previously mirrored result is injected as `initialData` **with its original
 * `dataUpdatedAt`**, so the first render after a reload paints real data immediately and
 * TanStack still considers it stale — the background refetch happens exactly as it would
 * without the cache.
 *
 * ```tsx
 * const todos = useBlazeQuery(cache, {
 *   queryKey: ['todos', userId],
 *   queryFn: () => api.get('/todos').then((r) => r.data),
 * });
 * ```
 *
 * This requires a `QueryClientProvider` above it, exactly like `useQuery`.
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
  // `??` keeps an explicit `initialData` (including its function form) authoritative.
  const record = cache.get(hashQueryKey(options.queryKey));

  // `initialData` is declared against `TData` in one overload and `TQueryFnData` in another;
  // the spread makes the union unreadable to the overloads, so it is asserted once here.
  const seeded = {
    ...options,
    initialData: options.initialData ?? (record?.data as TQueryFnData | undefined),
    initialDataUpdatedAt: options.initialDataUpdatedAt ?? record?.dataUpdatedAt,
  } as UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>;

  return useQuery<TQueryFnData, TError, TData, TQueryKey>(seeded);
}
