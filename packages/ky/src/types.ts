import type { BlazeCache } from '@blaze-cache/core';
import type { Hooks as KyHooks, Options as KyOptions } from 'ky';
import type { Hooks as Ky2Hooks } from 'ky2';

/**
 * Value written on the `x-blaze-cache` response header by every response the adapter
 * returns.
 *
 * * `MISS` — the response came from the network.
 * * `HIT` — served from the cache while still fresh.
 *
 * There is no `STALE`: this adapter never serves an entry past its freshness window —
 * `Cache-Control: stale-while-revalidate` belongs to `@blaze-cache/fetch`, which has a
 * stale window to serve from.
 */
export type BlazeKyMarker = 'HIT' | 'MISS';

/**
 * What the adapter stores in Blaze Cache for one response.
 *
 * The record is a plain, structured-clone-friendly object: an `ArrayBuffer` body plus
 * primitive metadata, so it survives an IndexedDB round-trip when the cache is configured
 * with persistence.
 */
export interface KyCacheRecord {
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
   * The read path checks this itself instead of trusting the store: {@link BlazeKyCacheLike}
   * is deliberately structural — a plain `Map` shim qualifies — and such a store never
   * expires anything, so without this deadline a record would be replayed forever.
   */
  freshUntil: number;
}

/** The slice of a cache the adapter needs — deliberately structural. */
export interface BlazeKyCacheLike {
  get(key: string): KyCacheRecord | undefined;
  set(key: string, value: KyCacheRecord, options?: { ttlMs?: number; tags?: readonly string[] }): void;
  /**
   * Optional, so a minimal `Map` shim still satisfies the interface.
   *
   * When present, the adapter uses it to drop a record it found past
   * {@link KyCacheRecord.freshUntil} — without it a non-expiring store would keep dead
   * weight it is never allowed to serve.
   */
  delete?(key: string): boolean | void;
}

/** Options accepted by {@link blazeKyHook}. All of them are optional. */
export interface BlazeKyCacheOptions {
  /**
   * Freshness window for a stored response, in milliseconds.
   *
   * Ignored when the response carries `Cache-Control: max-age`, which wins. A response
   * carrying `Age` has that age deducted. Default: `60_000`. A value `<= 0` means
   * "do not store".
   */
  ttlMs?: number | ((response: Response, request: Request) => number);

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
   * Builds the cache key. Receives the ky `Request` — final URL (after `prefixUrl`/
   * `baseUrl` and `searchParams`), normalized method and merged headers.
   *
   * The default is `"<method> <url>"` plus a hash of {@link varyHeaders} —
   * {@link defaultCacheKey} is that default, so you can wrap it and only change the parts
   * you care about. Replacing the key replaces **everything** the default included, so
   * include the method yourself when caching more than one method.
   */
  key?: (request: Request) => string;

  /**
   * Decide whether a response is worth storing. Default: only `2xx` responses
   * (the {@link methods} gate has already applied by then).
   *
   * A response this rejects is still returned — it is simply not cached, and still carries
   * `x-blaze-cache: MISS`. A callback that *throws* is treated exactly the same way (after
   * one console warning): a cache-layer failure never fails a response the network answered
   * well.
   */
  shouldCache?: (response: Response, request: Request) => boolean;

  /**
   * Tags attached to stored responses. Default: `['ky', '<method> <url>']`.
   *
   * The first tag lets one call drop the whole adapter's content
   * (`cache.invalidateTags('ky')`); the second drops a single resource.
   */
  tags?: (response: Response, request: Request) => readonly string[];

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
   * Response header set to `HIT` / `MISS`. Default: `'x-blaze-cache'`.
   * Pass `false` to disable the marker entirely.
   */
  markerHeader?: string | false;
}

/**
 * The call shapes ky's `beforeRequest` hook arrives in — one per major version:
 *
 * * **ky v1** — `(request, options, state)`, the {@link Request} first;
 * * **ky v2** — a single `{request, options, retryCount}` state object.
 *
 * The adapter's hooks are typed against the union so the same function satisfies
 * {@link KyHooks.BeforeRequestHook} and {@link Ky2Hooks.BeforeRequestHook} both, and pick
 * the right shape at runtime by testing the first argument (see the asserts at the bottom
 * of this file — they are checked against both ky majors at build time).
 */
export interface BlazeKyHookState {
  /** The ky `Request` — final URL, method and merged headers. */
  request: Request;
  /** ky's normalized options (v1 passes them separately, v2 bundles them here). */
  options?: unknown;
  /** ky v2 only: the response, in `afterResponse` state. */
  response?: Response;
  /** ky v2 only: retries attempted so far. */
  retryCount?: number;
}

/** A hook that may answer a request from the cache — returning a `Response` skips the network. */
export type BlazeKyBeforeRequestHook = (
  requestOrState: Request | BlazeKyHookState,
  options?: unknown,
) => Response | void | Promise<Response | void>;

/**
 * A hook that stores a network response and stamps the `MISS` marker.
 *
 * The response arrives as a **clone** (in both ky majors), so reading it here never
 * consumes the caller's body.
 */
export type BlazeKyAfterResponseHook = (
  requestOrState: Request | BlazeKyHookState,
  options?: unknown,
  responseOrState?: Response | BlazeKyHookState,
) => Response | void | Promise<Response | void>;

/** What {@link blazeKyHook} returns — spread straight into `ky.extend({hooks: …})`. */
export interface BlazeKyHooks {
  beforeRequest: BlazeKyBeforeRequestHook[];
  afterResponse: BlazeKyAfterResponseHook[];
}

/**
 * {@link blazeKyHook}'s options plus every ky option, for {@link createBlazeKy} — one bag
 * for both layers: `{prefixUrl, ttlMs, tags}`. ky's own options (including `hooks`, which
 * are preserved and run *before* the cache hooks) keep their meaning.
 *
 * Which URL options exist depends on the installed ky major — `prefixUrl` in v1,
 * `baseUrl`/`prefix` in v2 — because this type extends whatever `ky` resolves to.
 */
export interface CreateBlazeKyOptions extends KyOptions, BlazeKyCacheOptions {}

/**
 * Compile-time proofs. They resolve to types and emit no code, and {@link Assert} turns a
 * broken promise into a compile error instead of a silent `never`.
 *
 * * The hooks must stay assignable to **both** ky majors' `Hooks` — that is what makes
 *   {@link blazeKyHook} drop into either.
 * * The concrete {@link BlazeCache} returned by `createCache()` must keep satisfying
 *   {@link BlazeKyCacheLike}, so the headline examples keep compiling.
 */
type Assert<T extends true> = T;

type KyBeforeRequestHook = NonNullable<KyHooks['beforeRequest']>[number];
type KyAfterResponseHook = NonNullable<KyHooks['afterResponse']>[number];
type Ky2BeforeRequestHook = NonNullable<Ky2Hooks['beforeRequest']>[number];
type Ky2AfterResponseHook = NonNullable<Ky2Hooks['afterResponse']>[number];

type HooksFitKyV1 = Assert<
  BlazeKyBeforeRequestHook extends KyBeforeRequestHook ? true : false
> ;
type HooksFitKyV1After = Assert<
  BlazeKyAfterResponseHook extends KyAfterResponseHook ? true : false
> ;
type HooksFitKyV2 = Assert<
  BlazeKyBeforeRequestHook extends Ky2BeforeRequestHook ? true : false
> ;
type HooksFitKyV2After = Assert<
  BlazeKyAfterResponseHook extends Ky2AfterResponseHook ? true : false
> ;
type CoreCacheSatisfies = Assert<BlazeCache extends BlazeKyCacheLike ? true : false>;
