import { QueryClient } from '@tanstack/react-query';
import type { QueryCacheNotifyEvent, QueryFilters } from '@tanstack/react-query';

import type { BlazeQueryClientOptions, BlazeQuerySyncOptions } from './types.js';

/** Mirrored data survives this long in the Blaze Cache (TanStack owns in-session freshness). */
export const DEFAULT_TTL_MS = 86_400_000;
/** Default tag, so `cache.invalidateTags('react-query')` purges the whole mirror. */
export const DEFAULT_TAGS: readonly string[] = ['react-query'];

/**
 * Mirrors TanStack Query's cache into a Blaze Cache.
 *
 * The two layers have different jobs, and the seam is deliberate:
 *
 * | Event | Behaviour |
 * | --- | --- |
 * | `updated` + `success`/`setState` | mirrored — a completed fetch or `setQueryData` |
 * | `updated` + `invalidate` | **kept** — stale data stays so `staleTime: 0` can still paint instantly |
 * | `updated` + `error` | ignored — TanStack owns error state in-session |
 * | `removed` after an explicit purge | deleted, so `removeQueries`/`clear` really remove it |
 * | `removed` after garbage collection | **kept** — GC is in-session housekeeping, not a purge |
 *
 * ### Telling garbage collection from an explicit purge
 *
 * TanStack emits the same `removed` event for both, carrying nothing that distinguishes
 * them: once a query has sat at zero observers for `gcTime` (5 minutes by default),
 * `optionalRemove()` calls `queryCache.remove()` and the subscriber is none the wiser.
 * Deleting the mirror there would gut the design — navigate away for a few minutes, come
 * back, and every persisted query has silently vanished, taking the "instant first paint
 * from IndexedDB" feature with it.
 *
 * Since the event offers no hook, the explicit APIs are wrapped instead: for the lifetime of
 * this subscription, `client.removeQueries` and `client.clear` raise an `explicitRemoval`
 * flag around the original call — in a `try/finally`, bound to the client so the signature
 * and return value are untouched — and the subscriber deletes the mirror only while that
 * flag is up (`skip` still applies). The returned unsubscribe function restores the
 * originals verbatim, so a long-lived client is never left permanently patched; if a second
 * sync is stacked on the same client, wrappers restore in whichever order they detach (the
 * outermost one always puts back exactly what it found).
 *
 * Returns the unsubscribe function — call it to detach. {@link createBlazeQueryClient} does
 * not need it: the listener hangs off the client's own `QueryCache`, so client, cache and
 * subscription are collected together when you drop the client. There is also nothing to
 * wire teardown into — TanStack's `QueryClient` has no `destroy()` method, and its real
 * lifecycle hooks (`mount`/`unmount`) fire on every `QueryClientProvider` mount — including
 * StrictMode's immediate re-mount — so hooking them would detach the mirror while the client
 * very much still lives.
 */
export function syncBlazeQueryCache(
  client: QueryClient,
  options: BlazeQuerySyncOptions,
): () => void {
  const { cache } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const tags = options.tags ?? DEFAULT_TAGS;

  // Raised only while a wrapped explicit purge is on the stack — see the doc comment above.
  let explicitRemoval = false;

  // Whatever sits on the client's own properties right now — usually nothing, since the
  // methods live on `QueryClient.prototype`, but another sync stacked on this client would
  // have left its wrapper here, and we must put that back untouched.
  const previousRemoveQueries = Object.getOwnPropertyDescriptor(client, 'removeQueries');
  const previousClear = Object.getOwnPropertyDescriptor(client, 'clear');

  // Bound to the client, so the wrappers below are transparent: same signature, same return
  // value, same private-field access as the methods they stand in for.
  const originalRemoveQueries = client.removeQueries.bind(client) as (
    filters?: QueryFilters,
  ) => void;
  const originalClear = client.clear.bind(client);

  const patchedRemoveQueries: typeof client.removeQueries = (filters?: QueryFilters) => {
    explicitRemoval = true;
    try {
      return originalRemoveQueries(filters);
    } finally {
      explicitRemoval = false;
    }
  };
  const patchedClear: typeof client.clear = () => {
    explicitRemoval = true;
    try {
      return originalClear();
    } finally {
      explicitRemoval = false;
    }
  };

  client.removeQueries = patchedRemoveQueries;
  client.clear = patchedClear;

  /**
   * Puts back exactly what was on the client before this sync patched it — normally removing
   * our own property so the prototype method shows through again. Only while our wrapper is
   * still the outermost one: a sync attached later stacked its wrapper on top of ours, and
   * it will restore us itself when *it* detaches, so unwinding out of order must not rip it
   * away mid-flight.
   */
  const restore = (
    name: 'removeQueries' | 'clear',
    wrapper: unknown,
    previous: PropertyDescriptor | undefined,
  ): void => {
    if (client[name] !== wrapper) return;
    if (previous) Object.defineProperty(client, name, previous);
    else Reflect.deleteProperty(client, name);
  };

  const unsubscribe = client.getQueryCache().subscribe((event: QueryCacheNotifyEvent) => {
    const { query } = event;
    const hash = query.queryHash;

    if (event.type === 'removed') {
      // GC and explicit purges are indistinguishable in the event — the wrapper flag above
      // is the only difference. Keep the mirror through GC: the persisted copy exists for
      // the next session's first paint, not for this one's housekeeping.
      if (explicitRemoval && !options.skip?.(query.queryKey, hash)) cache.delete(hash);
      return;
    }

    if (event.type !== 'updated') return;
    // `success` covers fetches and `setQueryData`; `setState` covers `hydrate()`/manual writes.
    if (event.action.type !== 'success' && event.action.type !== 'setState') return;

    const data = query.state.data;
    if (data === undefined && !options.includeEmpty) return;
    if (options.skip?.(query.queryKey, hash)) return;

    // An identical record is already in the mirror — the imperative helpers
    // (`setBlazeQueryData`, `prefetchBlazeQuery`, `hydrateBlazeQueryClient`) write theirs
    // synchronously, ahead of this batched flush. Skip so *their* `ttlMs`/`tags` survive:
    // re-writing here would re-stamp the entry with the sync's defaults and silently strip
    // a per-query tag. Same data reference and same timestamp means nothing actually
    // changed, so skipping loses nothing but the redundant write.
    const existing = cache.peek ? cache.peek(hash) : undefined;
    if (
      existing &&
      existing.data === data &&
      existing.dataUpdatedAt === query.state.dataUpdatedAt
    ) {
      return;
    }

    // `queryKey` (and `queryType` for infinite queries) make the record self-describing:
    // dehydrate needs them to rebuild a TanStack query from the mirror alone.
    cache.set(
      hash,
      {
        data,
        dataUpdatedAt: query.state.dataUpdatedAt,
        queryKey: query.queryKey,
        ...(query.queryType === 'infinite' ? ({ queryType: 'infinite' } as const) : null),
      },
      { ttlMs, tags },
    );
  });

  return () => {
    unsubscribe();
    restore('removeQueries', patchedRemoveQueries, previousRemoveQueries);
    restore('clear', patchedClear, previousClear);
  };
}

/**
 * A `QueryClient` that mirrors every successful query into a Blaze Cache.
 *
 * ```ts
 * const cache = await createCache({ persistence: { namespace: 'queries' } });
 * const queryClient = createBlazeQueryClient({ cache });
 *
 * <QueryClientProvider client={queryClient}> … </QueryClientProvider>
 * ```
 *
 * The subscription lives exactly as long as the client: the `QueryCache` holds the listener,
 * and the client holds the cache, so they are collected together once you drop the client —
 * there is no `destroy()` on TanStack's `QueryClient` to wire teardown into, and none is
 * needed. The method wrappers {@link syncBlazeQueryCache} installs live just as long and go
 * with the client; attach by hand via {@link syncBlazeQueryCache} if you want an unsubscribe
 * that releases them earlier.
 */
export function createBlazeQueryClient(options: BlazeQueryClientOptions): QueryClient {
  const { client: clientOptions, ...syncOptions } = options;
  const client = new QueryClient(clientOptions);
  syncBlazeQueryCache(client, syncOptions);
  return client;
}
