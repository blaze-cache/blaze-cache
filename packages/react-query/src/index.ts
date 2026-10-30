/**
 * TanStack Query (v5) integration backed by Blaze Cache.
 *
 * Three independent pieces:
 *
 * * {@link syncBlazeQueryCache} / {@link createBlazeQueryClient} — mirror successful queries
 *   so they survive a reload.
 * * Hooks that seed from that mirror: {@link useBlazeQuery}, {@link useBlazeInfiniteQuery}
 *   and {@link useBlazeQueries} paint instantly from persisted data while TanStack still
 *   refetches in the background; {@link useBlazeMutation} invalidates both caches after a
 *   successful mutation.
 * * Imperative helpers that keep both caches in step without a hook:
 *   {@link prefetchBlazeQuery}, {@link setBlazeQueryData}, {@link invalidateBlazeQueries},
 *   {@link removeBlazeQueries}, and the persistence round trip
 *   {@link dehydrateBlazeQueryClient} / {@link hydrateBlazeQueryClient}.
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
export { isMirrorRecord } from './record.js';
export { hashQueryKey, resolveQueryHash } from './hash.js';
export { readBlazeRecord, seedBlazeQueryOptions, useBlazeQuery } from './useBlazeQuery.js';
export {
  seedBlazeInfiniteQueryOptions,
  useBlazeInfiniteQuery,
} from './useBlazeInfiniteQuery.js';
export { seedBlazeQueriesOptions, useBlazeQueries } from './useBlazeQueries.js';
export type { UseBlazeQueriesOptions } from './useBlazeQueries.js';
export {
  invalidateBlazeQueries,
  prefetchBlazeQuery,
  removeBlazeQueries,
  setBlazeQueryData,
} from './imperative.js';
export type { BlazeFetchQueryOptions } from './imperative.js';
export { useBlazeMutation } from './useBlazeMutation.js';
export type { BlazeMutationOptions } from './useBlazeMutation.js';
export { dehydrateBlazeQueryClient, hydrateBlazeQueryClient } from './hydration.js';
export type { DehydrateBlazeOptions, HydrateBlazeOptions } from './hydration.js';

export type {
  BlazeMirrorEntry,
  BlazeMirrorOptions,
  BlazeQueryCacheLike,
  BlazeQueryClientOptions,
  BlazeQueryFilters,
  BlazeQueryRecord,
  BlazeQuerySyncOptions,
} from './types.js';
