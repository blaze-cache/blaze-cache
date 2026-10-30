import { hashKey } from '@tanstack/react-query';
import type { QueryClient, QueryKey, QueryOptions } from '@tanstack/react-query';

/**
 * Canonical hash for a query key — the very hash TanStack Query stores in
 * `query.queryHash`, *when the default hasher is in play*.
 *
 * Delegating to TanStack's own `hashKey` rather than re-implementing it means the lookup
 * never drifts from the key the sync layer writes, even across library upgrades. When a
 * custom `queryKeyHashFn` configures the hashing, that is {@link resolveQueryHash}'s job —
 * the raw default hash would land on a key the mirror never used.
 *
 * ```ts
 * hashQueryKey(['todos', { page: 1, done: true }]);
 * // '["todos",{"done":true,"page":1}]' — object keys are sorted, so order never matters
 * ```
 */
export function hashQueryKey(queryKey: QueryKey): string {
  return hashKey(queryKey);
}

/**
 * The hash TanStack will file this query under — the exact string `queryCache.build` computes
 * for `query.queryHash`, and therefore the exact key {@link syncBlazeQueryCache} writes to.
 *
 * TanStack only reaches the default {@link hashQueryKey} after a chain of overrides, replayed
 * here from `defaultQueryOptions` exactly as TanStack orders it: an explicit `queryHash` on
 * the options wins outright, then a per-query `queryKeyHashFn`, then one registered through
 * `setQueryDefaults`, then the client's `defaultOptions.queries`. Looking up the mirror with
 * plain `hashQueryKey` while any of those are configured is a silent no-op — sync writes under
 * the custom hash and the lookup never finds it, so the "instant first paint" feature quietly
 * stops working for everyone who configured a hasher.
 *
 * ```ts
 * const client = new QueryClient({
 *   defaultOptions: { queries: { queryKeyHashFn: (key) => myHash(key) } },
 * });
 * resolveQueryHash(client, ['todos']); // myHash(['todos']) — what sync wrote
 * ```
 */
export function resolveQueryHash<TQueryKey extends QueryKey = QueryKey>(
  client: QueryClient,
  queryKey: TQueryKey,
  options?: Pick<
    QueryOptions<unknown, unknown, unknown, TQueryKey>,
    'queryHash' | 'queryKeyHashFn'
  >,
): string {
  const queryKeyHashFn =
    options?.queryKeyHashFn ??
    client.getQueryDefaults(queryKey).queryKeyHashFn ??
    client.getDefaultOptions().queries?.queryKeyHashFn;

  return options?.queryHash ?? (queryKeyHashFn ?? hashKey)(queryKey);
}
