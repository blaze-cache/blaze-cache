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
   * Freshness window for a cached response, in milliseconds.
   *
   * Ignored when the response carries `Cache-Control: max-age`, which wins.
   * Default: `60_000`. A value `<= 0` means "do not store".
   */
  ttlMs?: number | ((response: AxiosResponse, config: InternalAxiosRequestConfig) => number);

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
   * Default: `GET` requests answering `2xx` without a `Cache-Control: no-store`/`no-cache`.
   */
  shouldCache?: (response: AxiosResponse, config: InternalAxiosRequestConfig) => boolean;

  /** Tags attached to stored responses. Default: `['axios', '<METHOD> <url>']`. */
  tags?: (response: AxiosResponse, config: InternalAxiosRequestConfig) => string[];

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
}

export type { AxiosAdapter, AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig };
