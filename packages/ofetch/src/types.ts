import type { BlazeCache } from '@blaze-cache/core';
import type { $Fetch, FetchOptions, FetchResponse } from 'ofetch';

/**
 * Value written on the `x-blaze-cache` response header by every response the adapter
 * returns (when the marker is enabled and headers are mutable).
 *
 * * `MISS` — the response came from the network.
 * * `HIT` — served from the cache while still fresh.
 *
 * There is no `STALE`: this adapter never serves an entry past its freshness window —
 * `Cache-Control: stale-while-revalidate` belongs to `@blaze-cache/fetch`, which has a
 * stale window to serve from.
 */
export type BlazeOfetchMarker = 'HIT' | 'MISS';

/**
 * What the adapter stores in Blaze Cache for one response.
 *
 * The record is a plain, structured-clone-friendly object: an `ArrayBuffer` body plus
 * primitive metadata, so it survives an IndexedDB round-trip when the cache is configured
 * with persistence. The shape is intentionally compatible with the records other
 * `@blaze-cache/*` adapters store (`ArrayBuffer` body, `freshUntil`, `storedAt`, `headers`)
 * so a single cache instance can be shared across integrations.
 */
export interface OfetchCacheRecord {
  status: number;
  statusText: string;
  /** Response headers as a plain record, names lower-cased (as `Headers` reports them). */
  headers: Record<string, string>;
  /**
   * Raw response body.
   *
   * Empty for statuses that cannot carry one (`204`, `205`, `304`) — those are replayed with
   * a `null` body, exactly like the network sent them.
   */
  body: ArrayBuffer;
  /** Final URL after redirects — replayed as [`Response.url`](https://developer.mozilla.org/en-US/docs/Web/API/Response/url). */
  url: string;
  /** Whether the stored response followed a redirect. */
  redirected: boolean;
  /** `Date.now()` when the response was received. */
  storedAt: number;
  /**
   * `Date.now()` at which the entry stops being fresh.
   *
   * The read path checks this itself instead of trusting the store: {@link BlazeOfetchCacheLike}
   * is deliberately structural — a plain `Map` shim qualifies — and such a store never
   * expires anything, so without this deadline a record would be replayed forever.
   */
  freshUntil: number;
  /**
   * The parsed payload (`_data`) ofetch produced, stored so a cache hit can return the
   * same value as a network call without re-parsing the body. Omitted for non-JSON /
   * stream responses where only the raw body is meaningful.
   */
  _data?: unknown;
  /** ofetch `responseType` used for this response, so a raw replay can honour it. */
  responseType?: string;
}

/** The slice of a cache the adapter needs — deliberately structural. */
export interface BlazeOfetchCacheLike {
  get(key: string): OfetchCacheRecord | undefined;
  set(key: string, value: OfetchCacheRecord, options?: { ttlMs?: number; tags?: readonly string[] }): void;
  /**
   * Optional, so a minimal `Map` shim still satisfies the interface.
   *
   * When present, the adapter uses it to drop a record it found past
   * {@link OfetchCacheRecord.freshUntil} — without it a non-expiring store would keep dead
   * weight it is never allowed to serve.
   */
  delete?(key: string): boolean | void;
}

/** Resolved request identity passed to {@link BlazeOfetchOptions.key}. */
export interface BlazeOfetchKeyContext {
  /** Original request argument. */
  request: string | Request | URL;
  /** Options as resolved for this call (defaults merged). */
  options: FetchOptions;
  /** Upper-cased HTTP method. */
  method: string;
  /** Final URL after `baseURL` and `query`/`params` resolution. */
  url: string;
  /** Request headers (a `Headers` instance). */
  headers: Headers;
}

/** Options accepted by {@link blazeOfetch} and {@link createBlazeOfetch}. All optional. */
export interface BlazeOfetchOptions {
  /**
   * Freshness window for a stored response, in milliseconds.
   *
   * Ignored when the response carries `Cache-Control: max-age`, which wins. A response
   * carrying `Age` has that age deducted. Default: `60_000`. A value `<= 0` means
   * "do not store".
   */
  ttlMs?: number | ((response: FetchResponse<unknown>, request: BlazeOfetchKeyContext) => number);

  /**
   * HTTP methods eligible for caching. Default: `['GET']`.
   *
   * Pass `['GET', 'HEAD']` to cache `HEAD` too. Any other method always goes to the network
   * and is never stored.
   */
  methods?: readonly string[];

  /**
   * Honour `Cache-Control` on both sides of the exchange. Default: `true`.
   *
   * * request `no-store` → neither read nor write the cache;
   * * request `no-cache` / `max-age=0` → skip the read, still store the response;
   * * response `no-store` → never stored;
   * * response `no-cache` (even per-field, `no-cache="field1"`) → never stored;
   * * response `max-age` → overrides {@link ttlMs}, minus the response's `Age`.
   *
   * Set to `false` to treat `ttlMs` as the only authority. The response's `Vary` header is
   * *always* honoured (see {@link varyHeaders}) — variant correctness is not a preference.
   */
  cacheControl?: boolean;

  /**
   * Builds the cache key. Receives the resolved request identity (final URL after `baseURL`/
   * `query` resolution, normalized method and merged headers).
   *
   * The default is `"<method> <url>"` plus a hash of {@link varyHeaders} —
   * {@link defaultCacheKey} implements that default. Replacing the key replaces **everything**
   * the default included, so include the method yourself when caching more than one method.
   */
  key?: (context: BlazeOfetchKeyContext) => string;

  /**
   * Decide whether a response is worth storing. Default: only `2xx` responses
   * (the {@link methods} gate has already applied by then).
   *
   * A response this rejects is still returned — it is simply not cached. A callback that
   * *throws* is treated the same way (after one console warning): a cache-layer failure
   * never fails a response the network answered well.
   */
  shouldCache?: (response: FetchResponse<unknown>, request: BlazeOfetchKeyContext) => boolean;

  /**
   * Tags attached to stored responses. Default: `['ofetch', '<method> <url>']`.
   *
   * The first tag lets one call drop the whole adapter's content
   * (`cache.invalidateTags('ofetch')`); the second drops a single resource.
   */
  tags?: (response: FetchResponse<unknown>, request: BlazeOfetchKeyContext) => readonly string[];

  /**
   * Request headers whose values participate in the cache key. Default: `['authorization']`.
   *
   * A personalized response must never be served to a different user just because the URL
   * matched. Values are hashed, never stored verbatim.
   *
   * A response's own `Vary` header is checked against this list before it is stored: a
   * response varying on anything *not* listed cannot be keyed correctly, so it is left
   * uncached — and `Vary: *` is never stored at all (RFC 9111 §3).
   */
  varyHeaders?: readonly string[];

  /**
   * Response header set to `HIT` / `MISS` on replayed and rebuilt responses. Default:
   * `'x-blaze-cache'`. Pass `false` to disable the marker entirely.
   *
   * The marker is stamped on the `Response` headers (visible via `$fetch.raw()` and on the
   * underlying `FetchResponse`). The parsed value returned by `$fetch()` is unchanged.
   */
  markerHeader?: string | false;

  /**
   * `baseURL` for cache-key resolution when wrapping a pre-configured ofetch instance.
   *
   * ofetch keeps an instance's `defaults` in a closure it does not expose, so a wrapper
   * cannot read them. Passing it here makes the key describe the same URL the request will
   * actually go to — and the value is forced onto the request as well, so key and wire can
   * never disagree. {@link createBlazeOfetch} forwards its `baseURL` automatically.
   *
   * When it is *not* passed and the instance has its own `baseURL`, the adapter recovers
   * the origin from the first response's `Response.url` and keys from then on. Until that
   * happens the request URL is still relative, so nothing is read or written — a relative
   * URL is exactly what two different origins have in common.
   */
  baseURL?: string;
}

/**
 * {@link blazeOfetch}'s cache options plus every ofetch option, for {@link createBlazeOfetch}
 * — one bag for both layers: `{baseURL, ttlMs, tags, ...}`. ofetch's own options keep their
 * meaning and become the instance defaults.
 */
export interface CreateBlazeOfetchOptions extends FetchOptions, BlazeOfetchOptions {}

/** The wrapped ofetch instance returned by {@link blazeOfetch} / {@link createBlazeOfetch}. */
export type BlazeOfetchInstance = $Fetch;

/**
 * Compile-time proof: the concrete {@link BlazeCache} returned by `createCache()` satisfies
 * {@link BlazeOfetchCacheLike}, so the headline examples keep compiling.
 */
type Assert<T extends true> = T;
type CoreCacheSatisfies = Assert<BlazeCache extends BlazeOfetchCacheLike ? true : false>;
