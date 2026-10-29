import { hydrate } from '@tanstack/react-query';
import type { DehydratedState, HydrateOptions, QueryClient } from '@tanstack/react-query';

import { DEFAULT_TAGS, DEFAULT_TTL_MS } from './sync.js';
import type {
  BlazeMirrorOptions,
  BlazeQueryCacheLike,
  BlazeQueryRecord,
} from './types.js';

/** One entry of a `DehydratedState` — TanStack declares it but does not export the name. */
type DehydratedQuery = DehydratedState['queries'][number];

/** Options for {@link dehydrateBlazeQueryClient}. */
export interface DehydrateBlazeOptions {
  /**
   * Transforms each record's `data` before it lands in the snapshot — the same escape
   * hatch as TanStack's `DehydrateOptions.serializeData`, for data that is not
   * JSON-serializable as-is (Dates, Map, class instances).
   */
  serializeData?: (data: unknown) => unknown;
  /**
   * Include only records this predicate accepts — filter by key, tag (via
   * `cache.entries()`), age (`dataUpdatedAt`), anything readable from the record.
   *
   * ```ts
   * dehydrateBlazeQueryClient(cache, {
   *   predicate: (record) => record.dataUpdatedAt > Date.now() - 60_000,
   * });
   * ```
   */
  predicate?: (record: BlazeQueryRecord, queryHash: string) => boolean;
}

/** Options for {@link hydrateBlazeQueryClient}. */
export interface HydrateBlazeOptions extends BlazeMirrorOptions {
  /** Forwarded to TanStack's `hydrate` — per-query defaults, `deserializeData`, … */
  defaultOptions?: HydrateOptions['defaultOptions'];
}

/**
 * Builds a TanStack `DehydratedState` from the persisted Blaze mirror alone — no
 * `QueryClient` involved.
 *
 * Every live record that carries a `queryKey` becomes a `DehydratedQuery` filed under its
 * mirror key (which *is* the query hash), with `dataUpdatedAt` preserved so the restored
 * session's staleness arithmetic matches the original one. Embed the result in server
 * markup and call {@link hydrateBlazeQueryClient} on the client for a first paint with
 * zero network and zero re-read of IndexedDB.
 *
 * ```ts
 * const state = dehydrateBlazeQueryClient(cache);
 * // … in the server response:
 * `<script>window.__HYDRATED__ = ${JSON.stringify(state)}</script>`;
 * ```
 *
 * Rejections follow the package's rule of never under-delivering silently: records written
 * before `queryKey` existed cannot be rebuilt and are skipped (they still seed the hooks
 * directly), and a cache without `entries()` throws rather than returning a hollow
 * snapshot.
 *
 * Infinite queries round trip too: the record's `queryType` is carried through, so
 * `hydrate` rebuilds them as infinite queries with all their pages intact.
 */
export function dehydrateBlazeQueryClient(
  cache: BlazeQueryCacheLike,
  options: DehydrateBlazeOptions = {},
): DehydratedState {
  if (!cache.entries) {
    throw new Error(
      '[blaze-cache/react-query] Dehydrating the mirror must enumerate every persisted ' +
        'entry, but the cache does not implement `entries()`. Refusing to return an ' +
        'empty snapshot.',
    );
  }

  const queries: Array<DehydratedQuery> = [];
  for (const entry of cache.entries()) {
    const record = entry.value;
    // Pre-`queryKey` records cannot be rebuilt into a TanStack query — see the doc above.
    if (record.queryKey === undefined) continue;
    if (options.predicate && !options.predicate(record, entry.key)) continue;

    queries.push({
      queryHash: entry.key,
      queryKey: record.queryKey,
      // Freshness comes from `dataUpdatedAt`; `dehydratedAt` is simply "now", as in
      // TanStack's own `dehydrateQuery`.
      dehydratedAt: Date.now(),
      ...(record.queryType ? { queryType: record.queryType } : null),
      state: {
        data: options.serializeData ? options.serializeData(record.data) : record.data,
        dataUpdateCount: 1,
        dataUpdatedAt: record.dataUpdatedAt,
        error: null,
        errorUpdateCount: 0,
        errorUpdatedAt: 0,
        fetchFailureCount: 0,
        fetchFailureReason: null,
        fetchMeta: null,
        isInvalidated: false,
        status: 'success',
        fetchStatus: 'idle',
      },
    });
  }

  return { mutations: [], queries };
}

/**
 * Restores a `DehydratedState` into a `QueryClient` **and** persists it in the Blaze
 * Cache — the counterpart to {@link dehydrateBlazeQueryClient}, and the durable half of
 * TanStack's plain `hydrate`.
 *
 * TanStack's hydration is in-session only: its result lives in the query cache and dies
 * with the tab. This writes each restored query back into the mirror as well (self-
 * describing `queryKey`/`queryType`, original `dataUpdatedAt`, per-call `ttlMs`/`tags`),
 * so the state you just hydrated is what the *next* session paints from — which is
 * exactly the server-payload flow: hydrate on arrival, persist for the reload after.
 *
 * The mirror write reads each query back from TanStack **after** hydration, so whatever
 * `deserializeData` produced and TanStack's "keep the newer data" rule are what gets
 * persisted — TanStack remains the source of truth for the values.
 *
 * ```ts
 * const state = JSON.parse(window.__HYDRATED__) as DehydratedState;
 * hydrateBlazeQueryClient(cache, client, state, { tags: ['ssr', 'user:42'] });
 * ```
 */
export function hydrateBlazeQueryClient(
  cache: BlazeQueryCacheLike,
  client: QueryClient,
  dehydratedState: Partial<DehydratedState>,
  options?: HydrateBlazeOptions,
): void {
  hydrate(
    client,
    dehydratedState,
    options?.defaultOptions ? { defaultOptions: options.defaultOptions } : undefined,
  );

  for (const dehydrated of dehydratedState.queries ?? []) {
    const query = client.getQueryCache().get(dehydrated.queryHash);
    const data = query?.state.data;
    if (!query || data === undefined) continue; // nothing landed — nothing to persist

    cache.set(
      dehydrated.queryHash,
      {
        data,
        dataUpdatedAt: query.state.dataUpdatedAt,
        queryKey: dehydrated.queryKey,
        ...(query.queryType === 'infinite' ? ({ queryType: 'infinite' } as const) : null),
      },
      { ttlMs: options?.ttlMs ?? DEFAULT_TTL_MS, tags: options?.tags ?? DEFAULT_TAGS },
    );
  }
}
