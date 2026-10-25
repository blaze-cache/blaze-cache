import { NO_DIRECTIVES, parseAgeMs, parseCacheControl } from './cache-control.js';
import { defaultCacheKey } from './key.js';
import { normalizeInit, resolveMethod, resolveUrl } from './request.js';
import type {
  BlazeFetch,
  BlazeFetchCacheLike,
  BlazeFetchEffectiveInit,
  BlazeFetchInit,
  BlazeFetchMarker,
  BlazeFetchOptions,
  FetchCacheRecord,
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
 * Wraps the platform `fetch` with a Blaze Cache layer.
 *
 * ```ts
 * import { createCache } from '@blaze-cache/core';
 * import { createBlazeFetch } from '@blaze-cache/fetch';
 *
 * const cache = await createCache({ capacity: 1000 });
 * const fetch = createBlazeFetch(cache, { ttlMs: 30_000 });
 *
 * const response = await fetch('/api/users');
 * response.headers.get('x-blaze-cache'); // 'MISS', then 'HIT' on the next call
 * ```
 *
 * The returned function keeps the platform signature — hand it to anything expecting
 * `typeof fetch`. Requests outside {@link BlazeFetchOptions.methods} pass through untouched,
 * and a failing network call rejects exactly as it would have without the wrapper.
 */
export function createBlazeFetch(
  cache: BlazeFetchCacheLike,
  options: BlazeFetchOptions = {},
): BlazeFetch {
  // Called as a member of `globalThis`, so the receiver stays correct in browsers, where an
  // unbound `fetch` throws "Illegal invocation".
  const network: typeof fetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  const markerHeader =
    options.markerHeader === undefined ? DEFAULT_MARKER_HEADER : options.markerHeader;
  const methods = new Set((options.methods ?? DEFAULT_METHODS).map((method) => method.toUpperCase()));
  const cacheControl = options.cacheControl ?? true;
  const varyHeaders = options.varyHeaders ?? DEFAULT_VARY_HEADERS;
  const shouldCache = options.shouldCache ?? defaultShouldCache;
  const swr = options.staleWhileRevalidate ?? false;
  /** Whether stale entries may be served at all, and for how long when the header is absent. */
  const swrEnabled = swr !== false;
  const swrFallbackMs = typeof swr === 'number' && swr > 0 ? swr : 0;
  /** Keys with a background refresh already running — one network call per key at a time. */
  const revalidating = new Set<string>();

  const keyOf = (url: string, init: BlazeFetchEffectiveInit): string =>
    options.key ? options.key(url, init) : defaultCacheKey(url, init, varyHeaders);

  async function dispatch(input: RequestInfo | URL, init: BlazeFetchInit): Promise<Response> {
    const method = resolveMethod(input, init);
    const url = resolveUrl(input);
    const request = normalizeInit(input, init, method);
    const key = keyOf(url, request);

    // `init.cache` is the caller's instruction, `Cache-Control` is the server's; with
    // `cacheControl: false` only the former is still obeyed.
    const control = cacheControl ? parseCacheControl(request.headers.get('Cache-Control')) : NO_DIRECTIVES;
    const bypassWrite = control.noStore || request.cache === 'no-store';
    const bypassRead =
      bypassWrite ||
      control.noCache ||
      init.forceRefresh === true ||
      request.cache === 'no-cache' ||
      request.cache === 'reload';
    const cacheable = methods.has(method);

    if (cacheable && !bypassRead) {
      const record = cache.get(key);
      if (record) {
        const now = Date.now();
        // `force-cache` means "use it whatever its age"; otherwise freshness decides.
        if (request.cache === 'force-cache' || now <= record.freshUntil) {
          return replay(record, 'HIT');
        }
        if (swrEnabled && now <= record.staleUntil) {
          // Refreshed in the background: the caller is served *now*, the next call a `HIT`.
          revalidate(input, init, key);
          return replay(record, 'STALE');
        }
      }
    }

    const response = await network(input, init);

    if (cacheable && !bypassWrite && shouldCache(response, url, request)) {
      await store(response, key, url, request);
    }

    // Marked last, so `shouldCache`/`tags`/`ttlMs` see exactly what the network sent.
    return mark(response, 'MISS');
  }

  /** Fetches a fresh copy of a stale entry so the next read is a `HIT` again. */
  function revalidate(input: RequestInfo | URL, init: BlazeFetchInit, key: string): void {
    if (revalidating.has(key)) return;
    revalidating.add(key);
    void dispatch(input, { ...init, forceRefresh: true })
      // A background refresh must never reject into a caller: the stale entry simply stays
      // until the next attempt.
      .catch(() => undefined)
      .finally(() => revalidating.delete(key));
  }

  /** Buffers the body and writes the record. Returns early when nothing is worth keeping. */
  async function store(
    response: Response,
    key: string,
    url: string,
    request: BlazeFetchEffectiveInit,
  ): Promise<void> {
    // An opaque response exposes no status, headers or body: there is nothing to store.
    if (response.status === 0) return;

    const control = cacheControl ? parseCacheControl(response.headers.get('Cache-Control')) : NO_DIRECTIVES;
    // `no-store` forbids storing; `no-cache` demands revalidation on every use, and this
    // cache has no conditional requests — so neither is worth an entry.
    if (control.noStore || control.noCache) return;

    const configured = options.ttlMs;
    const ttl = typeof configured === 'function' ? configured(response, url, request) : (configured ?? DEFAULT_TTL_MS);
    const maxAge = control.maxAgeMs ?? ttl;
    const age = cacheControl ? parseAgeMs(response.headers.get('Age')) : 0;
    const freshMs = maxAge - age;
    // Zero, negative or `NaN` means "keep nothing": already stale, or the caller opted out.
    if (!(freshMs > 0)) return;

    // The response's own directive wins; the numeric option is the fallback for servers that
    // never send one. When the whole feature is off there is no stale window at all.
    const staleMs = !swrEnabled
      ? 0
      : cacheControl && control.staleWhileRevalidateMs !== undefined
        ? control.staleWhileRevalidateMs
        : swrFallbackMs;

    let body: ArrayBuffer;
    try {
      // `clone()` tees the stream: the caller's response still delivers every byte, while
      // this copy is buffered *before* `dispatch` resolves — so a follow-up read can never
      // race an in-flight write.
      body = await response.clone().arrayBuffer();
    } catch {
      return; // a body that fails mid-flight must not poison the cache
    }

    const storedAt = Date.now();
    const freshUntil = storedAt + freshMs;
    const record: FetchCacheRecord = {
      status: response.status,
      statusText: response.statusText,
      headers: storedHeaders(response.headers, body),
      body,
      url: response.url,
      redirected: response.redirected,
      storedAt,
      freshUntil,
      staleUntil: freshUntil + staleMs,
    };

    const totalMs = freshMs + staleMs;
    cache.set(key, record, {
      // `0` is how the core spells "never expires" — reached only via `ttlMs: Infinity`.
      ttlMs: Number.isFinite(totalMs) ? totalMs : 0,
      tags: options.tags?.(response, url, request) ?? defaultTags(request.method, url),
    });
  }

  /** Rebuilds a `Response` from a stored record, without touching cache statistics. */
  function replay(record: FetchCacheRecord, marker: BlazeFetchMarker): Response {
    const headers = new Headers(record.headers);
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
  function mark(response: Response, marker: BlazeFetchMarker): Response {
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

  return (input, init = {}) => dispatch(input, init);
}

/** Successful responses only. The {@link BlazeFetchOptions.methods} gate has already applied. */
function defaultShouldCache(response: Response): boolean {
  return response.status >= 200 && response.status < 300;
}

/**
 * `['fetch', '<method> <url>']` — one tag drops everything this wrapper stored
 * (`cache.invalidateTags('fetch')`), the other drops a single resource.
 */
function defaultTags(method: string, url: string): readonly string[] {
  return ['fetch', `${method.toLowerCase()} ${url}`];
}

/** Copies headers into a plain, structured-clone-friendly record. */
function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  // `Headers.forEach` reports names already lower-cased.
  headers.forEach((value, name) => {
    record[name] = value;
  });
  return record;
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

/** Shadows a read-only prototype accessor with an own property; never throws. */
function defineOwn(target: object, key: string, value: unknown): void {
  try {
    Object.defineProperty(target, key, { value, writable: true, enumerable: false, configurable: true });
  } catch {
    // A frozen response: the missing metadata is cosmetic, never worth failing a hit over.
  }
}
