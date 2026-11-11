import type { Arguments, BareFetcher, ScopedMutator, SWRConfiguration } from 'swr';

/**
 * What this package writes to the cache: the fetcher's result wrapped in a self-describing
 * envelope.
 *
 * The `kind: 'swr'` discriminator exists for the **shared-cache** case: on a store also
 * written by `@blaze-cache/axios`, `@blaze-cache/fetch` or `@blaze-cache/react-query`, a
 * forced key collision can park a foreign value under an SWR key — an axios response
 * record, a react-query mirror record, a raw app entry. Hydration only seeds the UI from
 * values that carry this envelope (see {@link readBlazeSWRRecord}); anything else reads as
 * the miss it is, instead of being handed to the component as `data`.
 *
 * `storedAt` is recorded for introspection and debugging; freshness is SWR's own concern
 * (it revalidates per its normal rules), so the middleware never reads it.
 */
export interface BlazeSWRRecord<T = unknown> {
  /** Discriminator — the literal this envelope is recognised by. */
  kind: 'swr';
  /** The fetcher's result, exactly as returned. */
  data: T;
  /** Wall-clock time of the write. */
  storedAt: number;
}

/**
 * The `tags` option: a fixed list, or a resolver applied **at write time** from the key
 * and the fetched result — for tags only a successful fetch can be responsible for
 * (`(key, data) => ['user', \`user:${data.id}\`]`).
 *
 * The resolver runs inside the write's guard: one that throws skips the write (with a
 * warning), exactly like a `cache.set` that throws — the fetched data itself always
 * resolves untouched. `key` is what the fetcher receives (a lazy `() => key` already
 * evaluated), never the serialized hash the entry is filed under.
 */
export type BlazeSWRTags<Data = unknown> =
  | readonly string[]
  | ((key: Arguments, data: Data) => readonly string[]);

/**
 * The slice of a cache the SWR integration needs.
 *
 * The concrete `BlazeCache` from `@blaze-cache/core` fits it directly
 * (`createCache()` returns `BlazeCache<any>`), and so does anything else with the same
 * `get`/`set` — a `Map`-backed shim, a test double, a wrapper of your own. Pass
 * `createCache<YourRecord>()` if you would rather have the compiler check both directions.
 *
 * `peek` and `invalidateTags` are optional on purpose:
 *
 * * `peek` is the render-time read (see {@link BlazeSWRCacheLike.peek}); caches that
 *   predate it fall back to `get`.
 * * `invalidateTags` is only *documented* as the invalidation entry point — this package
 *   never calls it, so a cache without tags still works; tag invalidation then simply
 *   needs `cache.invalidateTags` (or a manual `cache.delete`) on your side.
 */
export interface BlazeSWRCacheLike<V = any> {
  get(key: string): V | undefined;
  /**
   * The same lookup as {@link BlazeSWRCacheLike.get}, minus every side effect: no hit or
   * miss is recorded and the entry is not marked visited for eviction.
   *
   * The middleware prefers it on every render — rendering must not be able to move the
   * hit rate or decide who gets evicted next, and renders happen far more often than
   * real reads (StrictMode double-renders, discarded concurrent renders). The concrete
   * `BlazeCache` has it.
   */
  peek?(key: string): V | undefined;
  set(key: string, value: V, options?: { ttlMs?: number; tags?: readonly string[] }): void;
  delete?(key: string): boolean;
  /**
   * Every live entry — key, value, TTL and tags — without touching statistics.
   *
   * Optional, like {@link BlazeSWRCacheLike.peek}: only {@link invalidateBlazeSWR} needs
   * it, to select *this package's* records on a cache that may be shared — an SWR key can
   * point at another integration's record, and a purge must never delete that. A cache
   * without it makes that helper **throw** rather than run a deliberately partial purge;
   * the concrete `BlazeCache` has it as `entries()`.
   */
  entries?(): Iterable<{ key: string; value: V; ttlMs: number | null; tags: string[] }>;
  /** Removes every entry carrying any of `tags`, returning the removed keys. */
  invalidateTags?(...tags: string[]): string[];
}

/**
 * How long a written entry survives in the Blaze Cache, under which tags, and whether a
 * mount may read it at all — the `cache.set` stamp plus the hydration switch, all optional.
 *
 * Read from three places, in order of precedence: the options passed to the current
 * `useSWR`/`useBlazeSWR` call, the options given to {@link blazeSWRMiddleware}, then the
 * package defaults (24 h, tag `'swr'`, no forced refresh).
 */
export interface BlazeSWRStampOptions<Data = unknown> {
  /** TTL for the entry in milliseconds. Defaults to 24 h. */
  ttlMs?: number;
  /** Tags attached to the entry — enables `cache.invalidateTags('todos')`. See {@link BlazeSWRTags}. */
  tags?: BlazeSWRTags<Data>;
  /**
   * Skip the persisted entry for this key and fetch anyway: no Blaze hydration, and
   * `revalidateOnMount` forced to `true` — winning over an explicit `false`, because the
   * flag's whole job is to guarantee the fetcher runs. The result is still written back,
   * same as axios/fetch's `forceRefresh`: skip the read, keep the write.
   *
   * Hook-level beats middleware-level. Caller `fallbackData`/provider `fallback` keep
   * their own precedence — they are never overridden; they only stop *Blaze* from seeding.
   */
  forceRefresh?: boolean;
}

/** Options {@link blazeSWRMiddleware} accepts — the Blaze-side stamp plus `forceRefresh`. */
export type BlazeSWRMiddlewareOptions<Data = unknown> = BlazeSWRStampOptions<Data>;

/**
 * Options for {@link invalidateBlazeSWR} — just how to reach SWR's own cache.
 */
export interface InvalidateBlazeSWROptions {
  /**
   * The `mutate` that revalidates each purged key's mounted hooks, so the UI stops
   * showing data the cache no longer holds.
   *
   * Defaults to `swr`'s global `mutate`, which reaches hooks under the default provider.
   * Hooks under a *custom* `SWRConfig` provider need that provider's mutate — take it
   * from `useSWRConfig()`.
   */
  mutate?: ScopedMutator;
}

/**
 * Normal SWR options plus the Blaze Cache stamp (`ttlMs`/`tags`/`forceRefresh`) — everything
 * `useSWR` accepts keeps working; the extra fields only shape how successful fetches are
 * written to the Blaze Cache and whether a mount may read one.
 *
 * They may also be set once for every hook under an `SWRConfig` provider (cast to
 * `BlazeSWRStampOptions` — SWR merges unknown options into the config the middleware
 * receives), or passed straight to {@link blazeSWRMiddleware} when you wire it up by hand.
 */
export interface BlazeSWROptions<
  Data = any,
  Error = any,
  SWRFetcher extends BareFetcher<any> = BareFetcher<Data>,
> extends SWRConfiguration<Data, Error, SWRFetcher>,
    BlazeSWRStampOptions<Data> {}
