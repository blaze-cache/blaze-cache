import { NO_DIRECTIVES, parseAgeMs, parseCacheControl, varyIsStorable } from './cache-control.js';
import { defaultCacheKey } from './key.js';
import type {
  BlazeKyAfterResponseHook,
  BlazeKyBeforeRequestHook,
  BlazeKyCacheLike,
  BlazeKyCacheOptions,
  BlazeKyHookState,
  BlazeKyHooks,
  BlazeKyMarker,
  KyCacheRecord,
} from './types.js';

/** Freshness window when neither the option nor `Cache-Control` says otherwise. */
const DEFAULT_TTL_MS = 60_000;

/** Only `GET` is cached unless the caller says otherwise. */
const DEFAULT_METHODS: readonly string[] = ['GET'];

/** A personalized response must never be replayed to a different user. */
const DEFAULT_VARY_HEADERS: readonly string[] = ['authorization'];

const DEFAULT_MARKER_HEADER = 'x-blaze-cache';

/** Statuses that cannot carry a body — a replay must pass `null` for them. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

/**
 * ky hooks that cache HTTP responses through Blaze Cache.
 *
 * Two hooks, matched to ky's own architecture: `beforeRequest` may answer a request from
 * the cache by returning a `Response` (ky skips the network), and `afterResponse` — which
 * receives a *clone* of every response — stores what is worth keeping and stamps the
 * `x-blaze-cache` marker.
 *
 * ```ts
 * import ky from 'ky';
 * import { blazeKyHook } from '@blaze-cache/ky';
 *
 * const api = ky.extend({
 *   hooks: {
 *     ...blazeKyHook(cache, { ttlMs: 30_000 }),
 *   },
 * });
 * ```
 *
 * Works on **ky v1 and v2**: their hooks take different shapes — `(request, options, …)` in
 * v1, a single `{request, options, …}` state object in v2 — and these hooks recognise
 * whichever they are called with, from the first argument alone.
 *
 * Ordering: `ky.extend` appends hooks, so with `blazeKyHook`'s hooks spread in last (the
 * usual `hooks: {...blazeKyHook(cache)}` spelling), *your* `beforeRequest` hooks run first
 * — any header they add is folded into the cache key — and *your* `afterResponse` hooks
 * run before the store sees the response.
 */
export function blazeKyHook(cache: BlazeKyCacheLike, options: BlazeKyCacheOptions = {}): BlazeKyHooks {
  const markerHeader =
    options.markerHeader === undefined ? DEFAULT_MARKER_HEADER : options.markerHeader;
  const methods = new Set((options.methods ?? DEFAULT_METHODS).map((method) => method.toUpperCase()));
  const cacheControl = options.cacheControl ?? true;
  const varyHeaders = options.varyHeaders ?? DEFAULT_VARY_HEADERS;
  const shouldCache = options.shouldCache ?? defaultShouldCache;
  /**
   * Requests this closure answered from the cache, by object identity.
   *
   * ky runs `afterResponse` on a `beforeRequest`-returned response too — the cache hit
   * travels back through the same pipeline as a network response. Without this set the
   * hit would be re-stored on its way out, sliding its TTL a little on every read.
   * Identity is precise here: a served hit never reaches the network, so its request can
   * never come back around a retry.
   */
  const servedFromCache = new WeakSet<Request>();
  /**
   * Whether a cache-layer failure has been reported already.
   *
   * A throwing `cache.get`/`cache.set` or callback must never fail a request the network
   * answered well — the first such failure is announced, then the adapter keeps working
   * (uncached) in silence rather than spamming the console on every call.
   */
  let warned = false;

  /** The one place a cache-layer exception is allowed to surface: a single console warning. */
  function warnCacheFailure(error: unknown): void {
    if (warned) return;
    warned = true;
    console.warn('[blaze-cache] cache layer failed; continuing without it', error);
  }

  const keyOf = (request: Request): string =>
    options.key ? options.key(request) : defaultCacheKey(request, varyHeaders);

  /**
   * `cache.get`, guarded: a cache-layer failure reads as a plain miss — the request falls
   * through to the network instead of failing over a broken cache.
   */
  function read(key: string): KyCacheRecord | undefined {
    try {
      return cache.get(key);
    } catch (error) {
      warnCacheFailure(error);
      return undefined;
    }
  }

  const beforeRequest: BlazeKyBeforeRequestHook = (requestOrState) => {
    const request = unwrapRequest(requestOrState);
    if (!request || !methods.has(request.method.toUpperCase())) return undefined;

    // The caller's instruction (`Request.cache`), the caller's headers, and the server's
    // `Cache-Control` — with `cacheControl: false` only the first two are still obeyed.
    const control = cacheControl ? parseCacheControl(request.headers.get('Cache-Control')) : NO_DIRECTIVES;
    // `max-age=0` is, per RFC 9111 §5.2.2.1, a demand to revalidate before reuse. This
    // cache has no conditional requests, so the closest honest reading is a full refetch
    // — exactly what skipping the read does — rather than replaying the entry untouched.
    const bypassRead =
      control.noStore ||
      control.noCache ||
      control.maxAgeMs === 0 ||
      request.cache === 'no-store' ||
      request.cache === 'no-cache' ||
      request.cache === 'reload';
    if (bypassRead) return undefined;

    const key = keyOf(request);
    const record = read(key);
    if (!isKyRecord(record)) return undefined;

    // `force-cache` means "use it whatever its age"; otherwise freshness decides.
    if (request.cache !== 'force-cache' && Date.now() > record.freshUntil) {
      // Past its own deadline — the store itself may never expire anything (the types
      // bless a plain `Map` shim, which drops nothing), so *our* record is dropped here.
      // Left alone it would linger as dead weight that nothing is allowed to serve.
      try {
        cache.delete?.(key);
      } catch (error) {
        warnCacheFailure(error);
      }
      return undefined;
    }

    servedFromCache.add(request);
    return replay(record, 'HIT');
  };

  const afterResponse: BlazeKyAfterResponseHook = (requestOrState, _options, responseOrState) => {
    const request = unwrapRequest(requestOrState);
    // ky v1 passes the response positionally; ky v2 bundles it into the state object.
    const response = unwrapResponse(responseOrState, requestOrState);
    if (!request || !response) return undefined;
    // A response we replayed ourselves is on its way back to the caller — never re-store
    // it, never re-mark it. See `servedFromCache`.
    if (servedFromCache.has(request)) return undefined;

    const control = cacheControl ? parseCacheControl(request.headers.get('Cache-Control')) : NO_DIRECTIVES;
    // `no-store` on the request: neither read (above) nor write. The read-only directives
    // (`no-cache`, `max-age=0`, `reload`) skip the read but still refresh the entry.
    const bypassWrite = control.noStore || request.cache === 'no-store';

    if (!bypassWrite && methods.has(request.method.toUpperCase())) {
      // The response's own `Vary` gates the store: `Vary: *` is never cacheable, and a
      // response varying on a header outside `varyHeaders` would be replayed to callers
      // who differ in exactly that header — see `varyIsStorable` for why "unknown ⇒ do
      // not store" is the only safe answer.
      if (varyIsStorable(response.headers.get('Vary'), varyHeaders)) {
        let keep = false;
        try {
          keep = shouldCache(response, request);
        } catch (error) {
          // A callback that throws must not fail the response the network just delivered.
          warnCacheFailure(error);
        }
        if (keep) {
          // Tee now: `mark` below may rebuild the response around its body stream, and a
          // body can be consumed exactly once. Deliberately fire-and-forget — the caller's
          // branch of the tee delivers bytes while `store` buffers its own, so nothing
          // about this response's latency depends on the write, and the record is complete
          // (never half-written) by the time `cache.set` runs.
          let stored: Response | undefined;
          let storeKey: string | undefined;
          try {
            stored = response.clone();
            storeKey = keyOf(request);
          } catch (error) {
            // A clone that refuses (an exotic host handing over an already-consumed body)
            // or a `key` callback that throws must not fail a response the network just
            // delivered — it simply goes back uncached. Here, unlike in `beforeRequest`,
            // the request has already been answered once: failing it over a cache-layer
            // mistake would be doubly wrong.
            warnCacheFailure(error);
          }
          if (stored !== undefined && storeKey !== undefined) {
            void store(stored, request, storeKey).catch(warnCacheFailure);
          }
        }
      }
    }

    // Marked last, so `shouldCache`/`tags`/`ttlMs` see exactly what the network sent.
    return mark(response, 'MISS');
  };

  /**
   * Buffers the body and writes the record. Returns early when nothing is worth keeping.
   *
   * The response it reads is the tee taken in `afterResponse`, so every millisecond it
   * spends buffering is invisible to the caller — and the record is complete before
   * `cache.set` runs, so a hit can never half-load.
   */
  async function store(response: Response, request: Request, key: string): Promise<void> {
    // An opaque response (`no-cors`) exposes no status, headers or body: nothing to store.
    if (response.status === 0) return;

    const control = cacheControl ? parseCacheControl(response.headers.get('Cache-Control')) : NO_DIRECTIVES;
    // `no-store` forbids storing; `no-cache` demands revalidation on every use, and this
    // cache has no conditional requests — so neither is worth an entry.
    if (control.noStore || control.noCache) return;

    const configured = options.ttlMs;
    const ttl = typeof configured === 'function' ? configured(response, request) : (configured ?? DEFAULT_TTL_MS);
    // The response's own `max-age` wins; the option is the fallback for servers that never
    // send one. `Age` spends the origin's freshness budget before it reaches us: a
    // `max-age=60, Age: 50` response has ten seconds of life left, not sixty.
    const age = cacheControl ? parseAgeMs(response.headers.get('Age')) : 0;
    const freshMs = (control.maxAgeMs ?? ttl) - age;
    // Zero, negative or `NaN` means "keep nothing": already stale, or the caller opted out.
    if (!(freshMs > 0)) return;

    let body: ArrayBuffer;
    try {
      // Fully buffered *before* `cache.set`, so a follow-up read can never race a
      // half-written entry.
      body = await response.arrayBuffer();
    } catch {
      return; // a body that fails mid-flight must not poison the cache
    }

    const storedAt = Date.now();
    const record: KyCacheRecord = {
      status: response.status,
      statusText: response.statusText,
      headers: storedHeaders(response.headers, body),
      body,
      // A real network response carries its final (post-redirect) URL. A `Response` that
      // ky or another hook rebuilt from scratch has none — and for those the URL being
      // answered is the honest metadata, never an empty string.
      url: response.url || request.url,
      redirected: response.redirected,
      storedAt,
      freshUntil: storedAt + freshMs,
    };

    cache.set(key, record, {
      // `0` is how the core spells "never expires" — reached only via `ttlMs: Infinity`.
      ttlMs: Number.isFinite(freshMs) ? freshMs : 0,
      tags: options.tags?.(response, request) ?? defaultTags(request),
    });
  }

  /** Rebuilds a `Response` from a stored record. */
  function replay(record: KyCacheRecord, marker: BlazeKyMarker): Response {
    const headers = headersFromRecord(record.headers);
    if (markerHeader !== false) headers.set(markerHeader, marker);

    const response = new Response(
      NULL_BODY_STATUSES.has(record.status) ? null : record.body,
      { status: record.status, statusText: record.statusText, headers },
    );
    // `url`/`redirected` are read-only accessors on the prototype; an own property shadows
    // them so a hit carries the metadata of the network response it stands in for.
    defineOwn(response, 'url', record.url);
    defineOwn(response, 'redirected', record.redirected);
    return response;
  }

  /** Stamps the marker on a network response, rebuilding it only if its headers refuse. */
  function mark(response: Response, marker: BlazeKyMarker): Response {
    if (markerHeader === false) return response;
    try {
      response.headers.set(markerHeader, marker);
      return response;
    } catch {
      // Immutable headers (network responses in undici, `Response.redirect()`): rebuild so
      // the marker contract holds — the marker goes on the *rebuild*, since the original
      // refused it. Status 0 cannot be rebuilt at all: pass it through unmarked.
      if (response.status === 0) return response;
      const headers = new Headers(response.headers);
      headers.set(markerHeader, marker);
      const rebuilt = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
      defineOwn(rebuilt, 'url', response.url);
      defineOwn(rebuilt, 'redirected', response.redirected);
      return rebuilt;
    }
  }

  return { beforeRequest: [beforeRequest], afterResponse: [afterResponse] };
}

/** Successful responses only. The {@link BlazeKyCacheOptions.methods} gate has already applied. */
function defaultShouldCache(response: Response): boolean {
  return response.status >= 200 && response.status < 300;
}

/**
 * Shape check: is this value one **this adapter** wrote?
 *
 * `freshUntil` is the deadline every record carries and `body` the payload it always
 * stores — a value missing either belongs to something else sharing the cache (a
 * `FetchCacheRecord` has a `freshUntil` but no `ArrayBuffer` body; raw SWR and react-query
 * values carry neither), and a read must neither serve nor destroy it. On a
 * single-integration cache this is always true; the check exists for the shared one, and
 * keeps a foreign value from throwing inside `replay` — where ky would treat the error as
 * fatal and fail the request over a cache entry that was never ours.
 */
function isKyRecord(value: KyCacheRecord | undefined): value is KyCacheRecord {
  return typeof value?.freshUntil === 'number' && value.body instanceof ArrayBuffer;
}

/**
 * `['ky', '<method> <url>']` — one tag drops everything this adapter stored
 * (`cache.invalidateTags('ky')`), the other drops a single resource. The second tag uses
 * the same `<method> <url>` spelling as `@blaze-cache/fetch` and `@blaze-cache/axios`, so
 * integrations pointed at one shared cache invalidate together.
 */
function defaultTags(request: Request): readonly string[] {
  return ['ky', `${request.method.toLowerCase()} ${request.url}`];
}

/**
 * ky v1 calls hooks as `(request, options, state)`; ky v2 as a single `{request, options,
 * …}` state object. A real `Request` as the first argument means v1 — otherwise the state
 * object's `request` is taken. The guard keeps a future third spelling from throwing here:
 * an unrecognised call simply bypasses the cache, which is the safe direction.
 */
function unwrapRequest(value: Request | BlazeKyHookState | undefined): Request | undefined {
  if (value instanceof Request) return value;
  const request = (value as BlazeKyHookState | undefined)?.request;
  return request instanceof Request ? request : undefined;
}

/**
 * The `afterResponse` response, in whichever shape the ky major hands it over: a
 * positional third argument (ky v1) or `state.response` on the first (ky v2).
 */
function unwrapResponse(
  responseOrState: Response | BlazeKyHookState | undefined,
  requestOrState: Request | BlazeKyHookState | undefined,
): Response | undefined {
  if (responseOrState instanceof Response) return responseOrState;
  const bundled = (requestOrState as BlazeKyHookState | undefined)?.response;
  if (bundled instanceof Response) return bundled;
  const nested = (responseOrState as BlazeKyHookState | undefined)?.response;
  return nested instanceof Response ? nested : undefined;
}

/**
 * Response headers as a plain record, corrected to describe the bytes we actually hold.
 *
 * `fetch` decodes `content-encoding` for us, so a stored body is always the plain payload
 * while the headers still describe the *wire* format — `gzip` plus the compressed
 * `content-length` (on a real API: 1425 bytes claimed for 6504 stored). Replaying those
 * would hand back a response that contradicts itself, breaking anything that reads
 * `content-length` — a file downloader, `blob().size`, a progress bar — or that trusts the
 * encoding and tries to inflate plain bytes. `transfer-encoding` is hop-by-hop and stops
 * being true the moment the body is buffered.
 *
 * HEAD is the one exception: no body was ever sent, so its `content-length` and
 * `content-encoding` describe what a GET *would* return and stay as metadata.
 */
function storedHeaders(headers: Headers, body: ArrayBuffer): Record<string, string> {
  const record = headersToRecord(headers);
  delete record['transfer-encoding'];
  if (body.byteLength > 0) {
    delete record['content-encoding'];
    if ('content-length' in record) record['content-length'] = String(body.byteLength);
  }
  return record;
}

/** Copies headers into a plain, structured-clone-friendly record. */
function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  // `Headers.forEach` reports names already lower-cased. Defined, never assigned: a plain
  // `record[name] = value` hands a literal `__proto__` to the inherited setter, which
  // ignores primitives — silently dropping a perfectly legal header instead of storing it.
  headers.forEach((value, name) => {
    Object.defineProperty(record, name, { value, enumerable: true, writable: true, configurable: true });
  });
  return record;
}

/**
 * Rebuilds a `Headers` from a stored record, name by name.
 *
 * Never `new Headers(record)`: the platform's plain-object conversion drops a literal
 * `__proto__` key on its way through the inherited setter, losing a legal header between
 * the store and the replay. `append` accepts every name the store can hold.
 */
function headersFromRecord(record: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(record)) {
    headers.append(name, value);
  }
  return headers;
}

/** Shadows a read-only prototype accessor with an own property; never throws. */
function defineOwn(target: object, key: string, value: unknown): void {
  try {
    Object.defineProperty(target, key, { value, writable: true, enumerable: false, configurable: true });
  } catch {
    // A frozen response: the missing metadata is cosmetic, never worth failing a hit over.
  }
}
