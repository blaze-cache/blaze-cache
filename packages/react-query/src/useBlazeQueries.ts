import { useQueries, useQueryClient } from '@tanstack/react-query';
import type {
  QueriesOptions,
  QueriesResults,
  QueryClient,
} from '@tanstack/react-query';

import { seedBlazeQueryOptions } from './useBlazeQuery.js';
import type { BlazeQueryCacheLike } from './types.js';

/**
 * The options {@link useBlazeQueries} accepts: TanStack's own `useQueries` shape — a
 * `queries` array plus the optional `combine` — with each query seeded from the Blaze
 * Cache first.
 *
 * The generics mirror `useQueries`' so per-query inference (each `queryFn`'s result,
 * each `select`, and `combine`'s output) survives the round trip: a tuple of queries
 * destructure into individually typed results, exactly as with `useQueries`.
 */
export interface UseBlazeQueriesOptions<
  T extends Array<any>,
  TCombinedResult = QueriesResults<T>,
> {
  /** Query option objects — the same shapes `useQueries` takes, seeded from the mirror. */
  queries: readonly [...QueriesOptions<T>];
  /** Combine the results into a single value, as `useQueries` does. */
  combine?: (result: QueriesResults<T>) => TCombinedResult;
}

/**
 * The render-time data path for {@link useBlazeQueries}: seed every query's options
 * from the Blaze Cache, then hand the array to TanStack.
 *
 * Exposed as a plain function (like {@link seedBlazeQueryOptions}) so the per-query
 * seeding can be exercised without a DOM renderer. Each entry goes through
 * {@link seedBlazeQueryOptions} unchanged — the same authority rules, the same
 * `peek`-first lookup, the same custom-hasher handling — so one cold entry in the
 * mirror never blocks the others from seeding.
 */
export function seedBlazeQueriesOptions<
  T extends Array<any>,
  TCombinedResult = QueriesResults<T>,
>(
  cache: BlazeQueryCacheLike,
  client: QueryClient,
  options: UseBlazeQueriesOptions<T, TCombinedResult>,
): UseBlazeQueriesOptions<T, TCombinedResult> {
  return {
    ...options,
    // Per-entry seeding is type-preserving, but `T` is generic here so TS only sees the
    // elements' constraint and refuses the direct cast to the conditional
    // `QueriesOptions<T>` shape — the `unknown` bridge is the honest description.
    queries: options.queries.map((query) =>
      seedBlazeQueryOptions(cache, client, query),
    ) as unknown as UseBlazeQueriesOptions<T, TCombinedResult>['queries'],
  };
}

/**
 * `useQueries` where every query is seeded from the Blaze Cache.
 *
 * The parallel equivalent of {@link useBlazeQuery}: each query in the array gets the
 * instant-first-paint treatment independently — a cached entry becomes `initialData`
 * with its original `dataUpdatedAt`, an uncached one fetches cold. Results and typing
 * match `useQueries` exactly, including `combine`.
 *
 * ```tsx
 * const [profile, settings, notifications] = useBlazeQueries(cache, {
 *   queries: [
 *     { queryKey: ['profile', userId], queryFn: () => api.profile(userId) },
 *     { queryKey: ['settings'], queryFn: api.settings },
 *     { queryKey: ['notifications', userId], queryFn: () => api.notifications(userId) },
 *   ],
 * });
 * ```
 *
 * Requires a `QueryClientProvider` above it, exactly like `useQueries`.
 */
export function useBlazeQueries<T extends Array<any>, TCombinedResult = QueriesResults<T>>(
  cache: BlazeQueryCacheLike,
  options: UseBlazeQueriesOptions<T, TCombinedResult>,
): TCombinedResult {
  const client = useQueryClient();

  return useQueries<T, TCombinedResult>(seedBlazeQueriesOptions(cache, client, options), client);
}
