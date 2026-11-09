import type { AxiosAdapter, AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios';

/**
 * What the adapter stores in Blaze Cache for one response.
 *
 * `data` is the **raw** payload returned by the underlying adapter — before axios runs
 * `transformResponse`. Replaying it therefore goes through exactly the same transformation
 * pipeline as a network response, so a hit is indistinguishable from a miss.
 */
export interface AxiosCacheRecord {
  status: number;
  statusText: string;
  /** Normalised (lower-cased) response headers. */
  headers: Record<string, unknown>;
  /** Raw, untransformed response body. */
  data: unknown;
  /** `Date.now()` when the response was stored. */
  storedAt: number;
  /**
   * `Date.now()` at which this record stops being fresh.
   *
   * The read path checks this itself instead of trusting the store: {@link BlazeAxiosCacheLike}
   * is deliberately structural — a plain `Map` shim qualifies — and such a store never
   * expires anything, so without this deadline a record would be replayed forever.
   */
  freshUntil: number;
}

/**
 * An {@link AxiosResponse} served by the cache.
 *
 * The extra field lets you branch without sniffing headers; the `x-blaze-cache` response
 * header carries the same information for the network layer.
 */
export interface CachedAxiosResponse<T = unknown, D = unknown> extends AxiosResponse<T, D> {
  /** `true` when the response came from cache instead of the network. */
  fromBlazeCache: boolean;
}

/** Per-request overrides passed via `config.blazeCache`. */
export interface BlazeAxiosRequestOptions {
  /**
   * Enable or disable caching for this request.
   *
   * `false` bypasses the cache read/write for this request (it still performs any
   * {@link invalidateTags} after the network response). Omit/`true` to follow the
   * adapter defaults.
   */
  enabled?: boolean;

  /**
   * Freshness window for this request's cached response, in milliseconds.
   *
   * Overrides the adapter-level `ttlMs`. Ignored when the response carries
   * `Cache-Control: max-age` and `honourCacheControl` is on. `<= 0` means "do not store".
   */
  ttlMs?: number | ((response: AxiosResponse, config: InternalAxiosRequestConfig) => number);

  /** Tags attached to this request's stored response. Overrides the adapter-level `tags`. */
  tags?: readonly string[] | ((response: AxiosResponse, config: InternalAxiosRequestConfig) => readonly string[]);

  /**
   * Cache key for this request. A string is used as-is; a function receives the
   * (post-interceptor) config. Overrides the adapter-level key.
   */
  key?: string | ((config: InternalAxiosRequestConfig) => string);

  /**
   * Request headers whose values participate in the cache key for this request.
   * Overrides the adapter-level `varyHeaders`.
   */
  varyHeaders?: readonly string[];

  /**
   * Tags to invalidate on the cache **after** this request completes against the
   * network (typically used on mutations: POST/PUT/PATCH/DELETE).
   *
   * Requires a cache that implements `invalidateTags` (e.g. `BlazeCache` from
   * `@blaze-cache/core`); silently ignored otherwise.
   */
  invalidateTags?: readonly string[];

  /**
   * Force a network round-trip, bypassing the cache read (the fresh response may still
   * be stored, subject to normal rules). Equivalent to a "reload".
   */
  forceRefresh?: boolean;
}

/** Options for {@link blazeAdapter}. */
export interface BlazeAxiosCacheOptions {
  /** Cache instance (or any {@link BlazeCacheLike} implementation). */
  cache: BlazeAxiosCacheLike;

  /**
   * Adapter performing the real network call.
   *
   * `installBlazeCache` fills this in from the instance's current defaults *before*
   * replacing them, which is what prevents the adapter from calling itself.
   */
  adapter?: AxiosAdapter;

  /**
   * HTTP methods eligible for caching. Default: `['GET', 'HEAD']`.
   *
   * Applied before {@link shouldCache}. Per-request `blazeCache.enabled = true` can
   * still cache a method outside this list when paired with a permissive `shouldCache`.
   */
  methods?: readonly string[];

  /**
   * Freshness window for a cached response, in milliseconds.
   *
   * Ignored when the response carries `Cache-Control: max-age` and Cache-Control
   * honouring is enabled. Default: `30_000`. A value `<= 0` means "do not store".
   */
  ttlMs?: number | ((response: AxiosResponse, config: InternalAxiosRequestConfig) => number);

  /**
   * Honour `Cache-Control` (and `Age`) on both the request and the response.
   * Default: `true`.
   *
   * - request `no-store` → neither read nor write
   * - request `no-cache` / `max-age=0` → skip read (revalidate intent)
   * - response `max-age` → overrides `ttlMs` (minus `Age`)
   * - response `no-store` / `no-cache` → never stored
   *
   * `cacheControl` is accepted as an alias.
   */
  honourCacheControl?: boolean;
  /** Alias for {@link honourCacheControl}. */
  cacheControl?: boolean;

  /**
   * Builds the cache key. Receives the final (post-interceptor) config.
   *
   * The default hashes the method, URL, params and the {@link varyHeaders} values, keeping
   * secrets such as bearer tokens out of stored keys.
   */
  key?: (config: InternalAxiosRequestConfig) => string;

  /**
   * Decide whether a response is worth storing.
   *
   * Default: methods in {@link methods} answering `2xx`.
   */
  shouldCache?: (response: AxiosResponse, config: InternalAxiosRequestConfig) => boolean;

  /** Tags attached to stored responses. Default: `['axios', '<method> <resolved url>']`. */
  tags?: readonly string[] | ((response: AxiosResponse, config: InternalAxiosRequestConfig) => readonly string[]);

  /**
   * Request headers whose values participate in the cache key.
   *
   * Default `['Authorization']`: a personalized response must never be served to a different
   * user just because the URL matched. Values are hashed, never stored verbatim.
   */
  varyHeaders?: readonly string[];

  /** Response header set to `HIT`/`MISS`. Default `'x-blaze-cache'`; pass `false` to disable. */
  markerHeader?: string | false;
}

/** The slice of a Blaze Cache the adapter needs — deliberately structural. */
export interface BlazeAxiosCacheLike {
  get(key: string): AxiosCacheRecord | undefined;
  set(key: string, value: AxiosCacheRecord, options?: { ttlMs?: number; tags?: readonly string[] }): void;
  /**
   * Optional, so a minimal `Map` shim still satisfies the interface.
   *
   * When present, the adapter uses it to drop a record it found past {@link AxiosCacheRecord.freshUntil} —
   * without it a non-expiring store would keep dead weight it is never allowed to serve.
   */
  delete?(key: string): boolean | void;
  /**
   * Optional tag-based invalidation (e.g. `BlazeCache` from `@blaze-cache/core`).
   * Used by per-request `blazeCache.invalidateTags` on mutations.
   */
  invalidateTags?(...tags: string[]): string[] | void;
}

export type { AxiosAdapter, AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig };

// Augment axios so `config.blazeCache` and `response.fromBlazeCache` are typed for consumers.
declare module 'axios' {
  interface AxiosRequestConfig {
    /** Per-request Blaze Cache options (or `false` to disable caching for this request). */
    blazeCache?: BlazeAxiosRequestOptions | false;
  }
  interface AxiosResponse {
    /** `true` when the response came from cache instead of the network. */
    fromBlazeCache?: boolean;
  }
}
