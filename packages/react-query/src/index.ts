/**
 * TanStack Query (v5) integration backed by Blaze Cache.
 *
 * Two independent pieces:
 *
 * * {@link syncBlazeQueryCache} / {@link createBlazeQueryClient} — mirror successful queries
 *   so they survive a reload.
 * * {@link useBlazeQuery} — a `useQuery` that seeds `initialData` from that mirror, giving
 *   an instant first paint while TanStack still refetches in the background.
 *
 * ```tsx
 * const cache = await createCache();
 * const queryClient = createBlazeQueryClient({ cache });
 *
 * function Todos({ userId }: { userId: string }) {
 *   const todos = useBlazeQuery(cache, {
 *     queryKey: ['todos', userId],
 *     queryFn: () => fetchTodos(userId),
 *   });
 *   // …
 * }
 * ```
 *
 * @packageDocumentation
 */

export { createBlazeQueryClient, syncBlazeQueryCache } from './sync.js';
export { hashQueryKey } from './hash.js';
export { useBlazeQuery } from './useBlazeQuery.js';

export type {
  BlazeQueryCacheLike,
  BlazeQueryClientOptions,
  BlazeQueryRecord,
  BlazeQuerySyncOptions,
} from './types.js';
