import type { BlazeCache } from '@blaze-cache/core';

/**
 * Value written on the `x-blaze-cache` response header by every response the wrapper returns.
 *
 * * `MISS` — the response came from the network.
 * * `HIT` — served from the cache while still fresh.
 * * `STALE` — served from the cache past its freshness window, only while
 *   {@link BlazeFetchOptions.staleWhileRevalidate} is enabled. A background revalidation is
 *   already under way, so the *next* request gets a `HIT`.
 */
export type BlazeFetchMarker = 'HIT' | 'MISS' | 'STALE';

/**
 * What the wrapper stores in Blaze Cache for one response.
 *
 * The record is a plain, structured-clone-friendly object: an `ArrayBuffer` body plus
 * primitive metadata, so it survives an IndexedDB round-trip when the cache is configured
 * with persistence.
 */
export interface FetchCacheRecord {
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
  /** `Date.now()` at which the entry stops being *fresh* and switches to revalidation. */
  freshUntil: number;
  /** `Date.now()` at which the entry stops being served at all (equal to `freshUntil` when stale-while-revalidate is off). */
  staleUntil: number;
}

/**
 * `RequestInit` as accepted by the wrapper, plus two non-standard escape hatches.
 *
 * Everything the platform defines keeps its meaning; {@link forceRefresh} and
 * {@link blazeCache} are additive, and the standard `cache: 'no-cache' | 'reload'`
 * spellings do the same job as `forceRefresh` if you prefer them.
 */
export interface BlazeFetchInit extends RequestInit {
  /**
   * Skip the cache **read** and go straight to the network. The fresh response still
   * replaces whatever was stored, so one forced refresh restores a `HIT` afterwards.
   *
   * Standard equivalent: `cache: 'no-cache'`; shorthand for
   * `blazeCache: { forceRefresh: true }`.
   */
  forceRefresh?: boolean;

  /**
   * Per-request cache overrides — or `false` to bypass the cache entirely for this call.
   *
   * ```ts
   * await fetch('/users/1', { blazeCache: { ttlMs: 30_000, tags: ['user', 'user:1'] } });
   * await fetch('/users/1', { blazeCache: false }); // neither read nor written
   * ```
   *
   * Non-standard, so it lives on `init` rather than on a `Request`: the network still
   * receives the caller's original `input`/`init` unchanged, and a real `fetch` ignores
   * the member it does not know.
   */
  blazeCache?: BlazeFetchRequestOptions | false;
}

/** Per-request overrides passed via `init.blazeCache`. All of them are optional. */
export interface BlazeFetchRequestOptions {
  /**
   * Enable or disable caching for this request.
   *
   * `false` bypasses the cache read/write for this request (it still performs any
   * {@link invalidateTags} after the network response). `true` opts a method *outside*
   * {@link BlazeFetchOptions.methods} into caching. Omit to follow the wrapper defaults.
   */
  enabled?: boolean;

  /**
   * Freshness window for this request's cached response, in milliseconds.
   *
   * Overrides the wrapper-level `ttlMs`. Ignored when the response carries
   * `Cache-Control: max-age` and Cache-Control honouring is on. `<= 0` means
   * "do not store".
   */
  ttlMs?: number | ((response: Response, url: string, init: BlazeFetchEffectiveInit) => number);

  /**
   * Tags attached to this request's stored response. Overrides the wrapper-level `tags`.
   * The default (`['fetch', '<method> <url>']`) applies when neither is given.
   */
  tags?: readonly string[] | ((response: Response, url: string, init: BlazeFetchEffectiveInit) => readonly string[]);

  /**
   * Cache key for this request. A string is used as-is; a function receives the resolved
   * absolute `url` and the effective `init`. Overrides the wrapper-level `key`.
   *
   * Supplying it also opts a body-carrying request into caching — an explicit key is
   * trusted to describe the body itself.
   */
  key?: string | ((url: string, init: BlazeFetchEffectiveInit) => string);

  /**
   * Request headers whose values participate in the cache key for this request.
   * Overrides the wrapper-level {@link BlazeFetchOptions.varyHeaders}.
   */
  varyHeaders?: readonly string[];

  /**
   * Force a network round-trip, bypassing the cache read (the fresh response may still
   * be stored, subject to normal rules). Shorthand for the top-level `forceRefresh`.
   */
  forceRefresh?: boolean;

  /**
   * Tags to invalidate on the cache **after** this request completes against the
   * network (typically used on mutations: POST/PUT/PATCH/DELETE).
   *
   * Runs even when the request itself is never cached, and only after a *successful*
   * network call — a failed request invalidates nothing. Requires a cache that
   * implements `invalidateTags` (e.g. `BlazeCache` from `@blaze-cache/core`);
   * silently ignored otherwise.
   */
  invalidateTags?: readonly string[];
}

/**
 * A `Response` the wrapper returned, carrying its provenance.
 *
 * The extra field lets you branch without sniffing headers; the `x-blaze-cache` response
 * header carries the same information for the network layer. It is set on **every**
 * response the wrapper returns — cache bypasses included — so it is always a boolean.
 */
export interface CachedFetchResponse extends Response {
  /** `true` when the response came from cache instead of the network. */
  fromBlazeCache: boolean;
}

/**
 * `BlazeFetchInit` as the callbacks receive it — the *effective* request.
 *
 * `headers` is a concrete {@link Headers} (the caller's `init.headers` merged over a
 * `Request`'s own) and `method` is resolved and upper-cased, so a callback never has to
 * reproduce the three-shape `fetch` input handling:
 *
 * ```ts
 * key: (url, init) => `${init.method} ${url}?${init.headers.get('authorization') ?? ''}`,
 * ```
 */
export interface BlazeFetchEffectiveInit extends Omit<BlazeFetchInit, 'headers' | 'method'> {
  /** Resolved HTTP method, upper-cased. */
  method: string;
  /** Merged request headers, with `init.headers` winning over a `Request`'s. */
  headers: Headers;
}

/**
 * The wrapper's call signature — a drop-in replacement for the global `fetch`.
 *
 * Assignable to `typeof fetch` (proved at compile time in this file), so it drops into
 * anything that expects the platform function:
 *
 * ```ts
 * const blazeFetch = createBlazeFetch(cache);
 * const asFetch: typeof fetch = blazeFetch;
 * window.fetch = blazeFetch;
 * ```
 */
export type BlazeFetch = (
  input: RequestInfo | URL,
  init?: BlazeFetchInit,
) => Promise<CachedFetchResponse>;

/**
 * Options accepted by {@link createBlazeFetch}. All of them are optional.
 *
 * Most can also be set for a single request through `init.blazeCache` — see
 * {@link BlazeFetchRequestOptions} — which additionally offers `enabled` and
 * `invalidateTags`.
 */
export interface BlazeFetchOptions {
  /**
   * The function performing the real network call. Defaults to the global `fetch`.
   *
   * Pass a stub to test callers without a server — it receives exactly the `input`/`init`
   * the wrapper was called with, never a rewritten request.
   */
  fetch?: typeof fetch;

  /**
   * Freshness window for a stored response, in milliseconds.
   *
   * Ignored when the response carries `Cache-Control: max-age`, which wins. A response
   * carrying `Age` has that age deducted. Default: `60_000`. A value `<= 0` means
   * "do not store".
   */
  ttlMs?: number | ((response: Response, url: string, init: BlazeFetchEffectiveInit) => number);

  /**
   * HTTP methods eligible for caching. Default: `['GET']`.
   *
   * Pass `['GET', 'HEAD']` to cache `HEAD` too. Any other method always goes to the network
   * and is never stored — unless a single request opts itself in with
   * `blazeCache: { enabled: true }`. Non-cacheable methods are also never coalesced with an
   * identical in-flight request — replaying a side effect would be worse than repeating one.
   *
   * A method listed here is only stored (or coalesced) when its body can be folded into
   * the key (or a `key` callback describes it) — otherwise two different payloads to the
   * same URL would share one entry.
   */
  methods?: readonly string[];

  /**
   * Honour `Cache-Control` on both sides of the exchange. Default: `true`.
   *
   * * request `no-store` → neither read nor write the cache;
   * * request `no-cache` / `max-age=0` → skip the read, still store the response;
   * * response `no-store` → never stored;
   * * response `no-cache` (even per-field, `no-cache="field1"`) → never stored;
   * * response `max-age` → overrides {@link ttlMs}, minus the response's `Age`;
   * * response `stale-while-revalidate` → the stale window, when {@link staleWhileRevalidate} is on;
   * * response `must-revalidate` / `proxy-revalidate` → no stale window, however short the fresh one.
   *
   * Set to `false` to treat `ttlMs` as the only authority. The response's `Vary` header is
   * *always* honoured (see {@link varyHeaders}) — variant correctness is not a preference.
   *
   * {@link cacheControl} is accepted as an alias; when both are given, this one wins.
   */
  honourCacheControl?: boolean;
  /** Alias for {@link honourCacheControl}. */
  cacheControl?: boolean;

  /**
   * Serve responses past their freshness window while refreshing them in the background.
   * Default: `false` (a stale entry simply falls through to the network).
   *
   * * `true` — honour the response's `Cache-Control: stale-while-revalidate=<seconds>`.
   * * a number — that, **plus** the same many milliseconds as a fallback when the response
   *   omits the directive, so opting in works against servers that never send it.
   *
   * Such responses are marked `x-blaze-cache: STALE` and revalidated once per key: the
   * refresh is a forced refresh, so it can never re-serve the stale entry to itself. A
   * response carrying `must-revalidate`/`proxy-revalidate` never opens the stale window,
   * and the refresh never inherits the caller's `signal` — it is the wrapper's own work.
   */
  staleWhileRevalidate?: boolean | number;

  /**
   * Builds the cache key. Receives the resolved absolute `url` and the effective `init`
   * (see {@link BlazeFetchEffectiveInit}).
   *
   * The default is `"<method> <url>"` plus a hash of {@link varyHeaders} and of the request
   * body — {@link defaultCacheKey} is that default, so you can wrap it and only change the
   * parts you care about. Replacing the key replaces **everything** the default included,
   * so include `init.method` yourself when caching more than one method — and the body too,
   * if you cache a method that carries one. Supplying `key` also opts a body-carrying
   * request into caching that would otherwise be skipped as unkeyable.
   */
  key?: (url: string, init: BlazeFetchEffectiveInit) => string;

  /**
   * Decide whether a response is worth storing. Default: only `2xx` responses
   * (the {@link methods} gate has already applied by then).
   *
   * A response this rejects is still returned — it is simply not cached, and still carries
   * `x-blaze-cache: MISS`. A callback that *throws* is treated exactly the same way (after
   * one console warning): a cache-layer failure never fails a response the network answered
   * well.
   */
  shouldCache?: (response: Response, url: string, init: BlazeFetchEffectiveInit) => boolean;

  /**
   * Tags attached to stored responses. Default: `['fetch', '<method> <url>']`.
   *
   * The first tag lets one call drop the whole wrapper's content
   * (`cache.invalidateTags('fetch')`); the second drops a single resource.
   */
  tags?: (response: Response, url: string, init: BlazeFetchEffectiveInit) => readonly string[];

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
   * Response header set to `HIT` / `MISS` / `STALE`. Default: `'x-blaze-cache'`.
   * Pass `false` to disable the marker entirely.
   */
  markerHeader?: string | false;
}

/** The slice of a cache the wrapper needs — deliberately structural. */
export interface BlazeFetchCacheLike {
  get(key: string): FetchCacheRecord | undefined;
  set(key: string, value: FetchCacheRecord, options?: { ttlMs?: number; tags?: readonly string[] }): void;
  /**
   * Optional tag-based invalidation (e.g. `BlazeCache` from `@blaze-cache/core`).
   *
   * Optional so a minimal `Map` shim still satisfies the interface; used by per-request
   * `blazeCache.invalidateTags` on mutations, and by the exported
   * `invalidateCacheTags(cache, ...tags)` helper.
   */
  invalidateTags?(...tags: string[]): string[] | void;
}

/**
 * Compile-time proofs. They resolve to types and emit no code, and {@link Assert} turns a
 * broken promise into a compile error instead of a silent `never`.
 *
 * * {@link BlazeFetch} must stay assignable to the global `fetch` — that is what makes the
 *   wrapper drop-in rather than merely similar.
 * * The concrete {@link BlazeCache} returned by `createCache()` must keep satisfying
 *   {@link BlazeFetchCacheLike}, so the headline example keeps compiling.
 */
type Assert<T extends true> = T;

type IsDropInFetch = Assert<BlazeFetch extends typeof fetch ? true : false>;
type CoreCacheSatisfies = Assert<BlazeCache extends BlazeFetchCacheLike ? true : false>;
