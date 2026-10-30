import { NO_DIRECTIVES, parseAgeMs, parseCacheControl, varyIsStorable } from './cache-control.js';
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
  /**
   * Identical requests currently on the wire, keyed by cache key — one promise per key that
   * opens only when the leader's store attempt has fully *settled*, so a joiner can trust
   * whatever it then finds in the cache. See {@link dispatch}.
   */
  const inFlight = new Map<string, Promise<void>>();
  /**
   * Whether a cache-layer failure has been reported already.
   *
   * A throwing `cache.get`/`cache.set` or callback must never fail a request the network
   * answered well — the first such failure is announced, then the wrapper keeps working
   * (uncached) in silence rather than spamming the console on every call.
   */
  let warned = false;

  /** The one place a cache-layer exception is allowed to surface: a single console warning. */
  function warnCacheFailure(error: unknown): void {
    if (warned) return;
    warned = true;
    console.warn('[blaze-cache] cache layer failed; continuing without it', error);
  }

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
    // A request `max-age=0` is, per RFC 9111 §5.2.2.1, a demand to revalidate before reuse.
    // This cache has no conditional requests, so the closest honest reading is a full
    // refetch — exactly what `bypassRead` does — rather than replaying the entry untouched.
    const bypassRead =
      bypassWrite ||
      control.noCache ||
      control.maxAgeMs === 0 ||
      init.forceRefresh === true ||
      request.cache === 'no-cache' ||
      request.cache === 'reload';
    const cacheable = methods.has(method);

    if (cacheable) {
      if (!bypassRead) {
        const record = read(key);
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
      // An identical request is already on the wire. Its `Response` cannot be handed over —
      // a body stream can be consumed exactly once, and the leader's own caller is reading
      // it — but the *stored record* is the replayable form of the very same bytes, so the
      // cache doubles as the rendezvous: wait for the leader's write to settle, then replay
      // what it landed. A leader that stored nothing (an unstorable response, a failed
      // write) opens its gate over an empty cache, and the joiner falls through to the
      // network itself — never an unstored response, never a deadlock: gates only ever wait
      // on leaders, and no leader waits on a joiner.
      //
      // Joined only when this call would itself have accepted a cached read. A caller that
      // explicitly demanded the network (`forceRefresh`, `cache: 'reload'`, request
      // `no-cache`/`max-age=0`) is joined *out*: answering it from the cache — however
      // recently written — breaks the promise it made, and it leads below instead.
      if (!bypassRead) {
        const pending = inFlight.get(key);
        if (pending) {
          await pending;
          const shared = read(key);
          // Freshly written, but a pathologically short TTL may have aged it out already.
          if (shared && Date.now() <= shared.freshUntil) return replay(shared, 'HIT');
        }
      }
    }

    // From here on this call *leads* its key. The gate is registered before the network is
    // touched — otherwise two callers could both miss and both fetch before either
    // registers — and only cacheable, storable requests lead: a `POST` must never be
    // silently coalesced with an identical one, side effects and all.
    const leader = cacheable && !bypassWrite;
    let settle: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    if (leader) inFlight.set(key, settled);
    /**
     * Opens the gate and retires the leadership — every exit passes through it.
     *
     * Identity-checked: a caller that demanded the network (`forceRefresh`, `reload`) leads
     * too and may have replaced our gate with its own. Deleting whatever sits under `key`
     * would retire *their* leadership while ours still stands, silently dropping the joiners
     * waiting on them.
     */
    const done = (): void => {
      if (leader && inFlight.get(key) === settled) inFlight.delete(key);
      settle();
    };

    let response: Response;
    try {
      response = await network(input, init);
    } catch (error) {
      // A failed leader still opens its gate — over an empty cache, so joiners wake and
      // retry the network themselves instead of waiting on a promise that never settles.
      done();
      throw error;
    }

    let keep = false;
    if (leader) {
      try {
        keep = shouldCache(response, url, request);
      } catch (error) {
        // A callback that throws must not fail the response the network just delivered.
        warnCacheFailure(error);
      }
    }
    if (keep) {
      // Deliberately fire-and-forget. `store` tees the body with `clone()` — the caller's
      // copy of the stream is untouched — and fully buffers *its* copy before `cache.set`,
      // so nothing about this call's latency depends on the write, and a later read can
      // never race a half-written entry. The gate above, however, opens only once that
      // write has settled: that is what lets a joiner trust the cache it finds.
      void store(response, key, url, request)
        .catch(warnCacheFailure)
        .finally(done);
    } else {
      // Nothing will be stored for this call: wake any joiners so they can lead in turn.
      done();
    }

    // Marked last, so `shouldCache`/`tags`/`ttlMs` see exactly what the network sent.
    return mark(response, 'MISS');
  }

  /** Fetches a fresh copy of a stale entry so the next read is a `HIT` again. */
  function revalidate(input: RequestInfo | URL, init: BlazeFetchInit, key: string): void {
    if (revalidating.has(key)) return;
    revalidating.add(key);
    // The caller's `signal` is deliberately stripped. It belongs to the request that merely
    // *happened* to notice the staleness — and such callers usually abort right after being
    // served (an unmount, a route change), which would abort the refresh and leave the
    // entry stale forever. A background refresh is the wrapper's own work and runs on the
    // wrapper's own terms; `forceRefresh` keeps it from re-serving the stale entry to itself.
    void dispatch(input, { ...init, signal: undefined, forceRefresh: true })
      // A background refresh must never reject into a caller: the stale entry simply stays
      // until the next attempt.
      .catch(() => undefined)
      .finally(() => revalidating.delete(key));
  }

  /**
   * Buffers the body and writes the record. Returns early when nothing is worth keeping.
   *
   * Deliberately fire-and-forget at the call site: the body it reads comes from a `clone()`
   * of the caller's response, so every millisecond it spends buffering is invisible to the
   * caller — and the record is complete (never half-written) by the time `cache.set` runs.
   */
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

    // `Vary` decides which *request* headers this response's identity hangs on. Only a
    // response whose every named header is already folded into the cache key may be stored;
    // anything else would be keyed wrongly, and a wrong key replays the wrong variant —
    // another user's `Cookie`, another locale's `Accept-Language`. When we cannot key on a
    // header, the safe answer is not to cache at all. (Checked unconditionally, not only
    // under `cacheControl`: variant correctness is not a freshness preference.)
    if (!varyIsStorable(response.headers.get('Vary'), varyHeaders)) return;

    const configured = options.ttlMs;
    const ttl = typeof configured === 'function' ? configured(response, url, request) : (configured ?? DEFAULT_TTL_MS);
    const maxAge = control.maxAgeMs ?? ttl;
    const age = cacheControl ? parseAgeMs(response.headers.get('Age')) : 0;
    const freshMs = maxAge - age;
    // Zero, negative or `NaN` means "keep nothing": already stale, or the caller opted out.
    if (!(freshMs > 0)) return;

    // The response's own directive wins; the numeric option is the fallback for servers that
    // never send one. When the whole feature is off there is no stale window at all — and
    // `must-revalidate` (or its shared-cache spelling `proxy-revalidate`) closes the window
    // even when the feature is on: such a response must never be replayed past its
    // freshness, so there is nothing it may serve "while revalidating".
    const staleMs = !swrEnabled || control.mustRevalidate
      ? 0
      : cacheControl && control.staleWhileRevalidateMs !== undefined
        ? control.staleWhileRevalidateMs
        : swrFallbackMs;

    let body: ArrayBuffer;
    try {
      // `clone()` tees the stream: the caller's response still delivers every byte, while
      // this copy is buffered in the background — and fully buffered *before* `cache.set`,
      // so a follow-up read can never race a half-written entry.
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

  /**
   * `cache.get`, guarded: a cache-layer failure reads as a plain miss — the caller falls
   * through to the network instead of having its request fail over a broken cache.
   */
  function read(key: string): FetchCacheRecord | undefined {
    try {
      return cache.get(key);
    } catch (error) {
      warnCacheFailure(error);
      return undefined;
    }
  }

  /** Rebuilds a `Response` from a stored record, without touching cache statistics. */
  function replay(record: FetchCacheRecord, marker: BlazeFetchMarker): Response {
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
  // `Headers.forEach` reports names already lower-cased. Defined, never assigned: a plain
  // `record[name] = value` hands a literal `__proto__` to the inherited setter, which
  // ignores primitives — silently dropping a perfectly legal header instead of storing it.
  headers.forEach((value, name) => {
    Object.defineProperty(record, name, { value, enumerable: true, writable: true, configurable: true });
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
