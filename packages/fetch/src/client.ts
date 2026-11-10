import { NO_DIRECTIVES, parseAgeMs, parseCacheControl, varyIsStorable } from './cache-control.js';
import { defaultCacheKey, encodeRequestBody } from './key.js';
import { isRequest, normalizeInit, resolveMethod, resolveUrl } from './request.js';
import type {
  BlazeFetch,
  BlazeFetchCacheLike,
  BlazeFetchRequestOptions,
  BlazeFetchEffectiveInit,
  BlazeFetchInit,
  BlazeFetchMarker,
  BlazeFetchOptions,
  CachedFetchResponse,
  FetchCacheRecord,
} from './types.js';

/** Freshness window when neither the option nor `Cache-Control` says otherwise. */
const DEFAULT_TTL_MS = 60_000;

/** Only `GET` is cached unless the caller says otherwise. */
const DEFAULT_METHODS: readonly string[] = ['GET'];

/** A personalized response must never be replayed to a different user. */
const DEFAULT_VARY_HEADERS: readonly string[] = ['authorization'];

const DEFAULT_MARKER_HEADER = 'x-blaze-cache';

/**
 * Statuses that cannot carry a body — a replay must pass `null` for them.
 *
 * `101` is deliberately **not** here: the `Response` constructor rejects it outright
 * (`RangeError: init.status` must be 200–599), so a stored 101 could never be rebuilt at
 * all — and none can ever reach the store, since a real `fetch` never returns a 101 to
 * JavaScript (the handshake upgrades the connection below this layer).
 */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

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
  // `honourCacheControl` is the axios-consistent spelling; `cacheControl` is its alias.
  const honourCacheControl = options.honourCacheControl ?? options.cacheControl ?? true;
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

  const keyOf = (
    url: string,
    init: BlazeFetchEffectiveInit,
    reqOpts: BlazeFetchRequestOptions | undefined,
  ): string => {
    if (typeof reqOpts?.key === 'string') return reqOpts.key;
    if (typeof reqOpts?.key === 'function') return reqOpts.key(url, init);
    return options.key
      ? options.key(url, init)
      : defaultCacheKey(url, init, reqOpts?.varyHeaders ?? varyHeaders);
  };

  /**
   * Mutation invalidation: drops tagged entries after the network round-trip.
   *
   * Runs even when the request itself is never cacheable (a `POST` never is by default),
   * and never when the cache has no `invalidateTags` — a structural `Map` shim simply
   * does not support it. A cache that throws here is a cache-layer failure: warned once,
   * never propagated into the caller's response.
   */
  const invalidateTags = (tags: readonly string[] | undefined): void => {
    if (!tags || tags.length === 0) return;
    if (typeof cache.invalidateTags !== 'function') return;
    try {
      cache.invalidateTags(...tags);
    } catch (error) {
      warnCacheFailure(error);
    }
  };

  async function dispatch(input: RequestInfo | URL, init: BlazeFetchInit): Promise<CachedFetchResponse> {
    const reqOpts = getRequestOptions(init);
    const method = resolveMethod(input, init);
    const url = resolveUrl(input);
    const request = normalizeInit(input, init, method);

    // A body that cannot be folded into the key would make every request carrying one
    // share a single entry — a `POST` with two payloads would occupy one entry and the
    // first response would be replayed for the second. Refusing to cache costs one extra
    // request; a wrong hit hands one caller another caller's response, so the asymmetry
    // decides it. A caller-supplied `key` owns the whole key, so it is trusted to describe
    // the body itself.
    //
    // The body may sit on the `init` or on a `Request` input (`init` winning); a `Request`'s
    // own body is a `ReadableStream`, which no encoder can read — so a body-carrying
    // `Request` bypasses caching just like any other unencodable body.
    const carriedBody = request.body ?? (isRequest(input) ? input.body : undefined);
    const ownsKey =
      typeof options.key === 'function' ||
      typeof reqOpts?.key === 'string' ||
      typeof reqOpts?.key === 'function';
    const bodyKeyed =
      carriedBody === undefined ||
      carriedBody === null ||
      ownsKey ||
      encodeRequestBody(carriedBody) !== undefined;

    // Per-request `enabled: true` can opt a method in; `enabled: false` opts out entirely.
    const enabled = reqOpts?.enabled ?? true;
    const methodAllowed = methods.has(method) || reqOpts?.enabled === true;

    // The key is only built when it can be trusted and may actually be used: an
    // unencodable body never reaches `defaultCacheKey` (which would throw on it), a
    // disabled request owes the key callback nothing — and a key callback that throws
    // anyway is a cache-layer failure, costing this response its caching, never the
    // response itself.
    let cacheable = enabled && methodAllowed && bodyKeyed;
    let key = '';
    if (cacheable) {
      try {
        key = keyOf(url, request, reqOpts);
      } catch (error) {
        warnCacheFailure(error);
        cacheable = false;
      }
    }

    // `init.cache` is the caller's instruction, `Cache-Control` is the server's; with
    // `honourCacheControl: false` only the former is still obeyed.
    const control = honourCacheControl
      ? parseCacheControl(request.headers.get('Cache-Control'))
      : NO_DIRECTIVES;
    const bypassWrite = control.noStore || request.cache === 'no-store';
    // A request `max-age=0` is, per RFC 9111 §5.2.2.1, a demand to revalidate before reuse.
    // This cache has no conditional requests, so the closest honest reading is a full
    // refetch — exactly what `bypassRead` does — rather than replaying the entry untouched.
    const bypassRead =
      bypassWrite ||
      control.noCache ||
      control.maxAgeMs === 0 ||
      init.forceRefresh === true ||
      reqOpts?.forceRefresh === true ||
      request.cache === 'no-cache' ||
      request.cache === 'reload';

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
          // The wait is abortable: without it a joiner whose caller cancels (unmount, route
          // change) would hang until the *leader's* network call settles — the joiner's own
          // abort must reject it immediately, exactly as it would have mid-flight. The
          // effective signal is `init`'s, or the `Request`'s when no init overrode it.
          const signal = request.signal ?? (isRequest(input) ? input.signal : null);
          await raceWithAbort(pending, signal);
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
    // Every network response admits where it came from from the moment it arrives, so even
    // the `shouldCache`/`tags`/`ttlMs` callbacks see `fromBlazeCache: false`.
    defineOwn(response, 'fromBlazeCache', false);

    // Mutation invalidation: after the round-trip (a failed call invalidates nothing — the
    // caller's data is unchanged), and before anything is stored, so a fresh entry written
    // under the same tags survives the invalidation it triggered.
    invalidateTags(reqOpts?.invalidateTags);

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
      void store(response, key, url, request, reqOpts)
        .catch(warnCacheFailure)
        .finally(done);
    } else {
      // Nothing will be stored for this call: wake any joiners so they can lead in turn.
      done();
    }

    // Marked last, so `shouldCache`/`tags`/`ttlMs` see exactly what the network sent
    // (bar `fromBlazeCache`, which describes provenance and is set on arrival).
    return mark(response, 'MISS');
  }

  /** Fetches a fresh copy of a stale entry so the next read is a `HIT` again. */
  function revalidate(input: RequestInfo | URL, init: BlazeFetchInit, key: string): void {
    if (revalidating.has(key)) return;
    revalidating.add(key);
    // The caller's `signal` is deliberately replaced. It belongs to the request that merely
    // *happened* to notice the staleness — and such callers usually abort right after being
    // served (an unmount, a route change), which would abort the refresh and leave the
    // entry stale forever. A background refresh is the wrapper's own work and runs on the
    // wrapper's own terms; `forceRefresh` keeps it from re-serving the stale entry to itself.
    //
    // `undefined` suffices for a string/URL input — with no `Request` in play it simply
    // means "no signal". It does **not** suffice when `input` is a `Request`: WebIDL treats
    // an `init` member whose value is `undefined` as absent, so `fetch` falls back to the
    // Request's own signal and the caller's abort still kills the refresh. An actual
    // signal object — fresh, never aborted, controller discarded — is the only thing that
    // overrides it.
    void dispatch(input, {
      ...init,
      signal: isRequest(input) ? new AbortController().signal : undefined,
      forceRefresh: true,
    })
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
    reqOpts: BlazeFetchRequestOptions | undefined,
  ): Promise<void> {
    // An opaque response exposes no status, headers or body: there is nothing to store.
    if (response.status === 0) return;

    const control = honourCacheControl
      ? parseCacheControl(response.headers.get('Cache-Control'))
      : NO_DIRECTIVES;
    // `no-store` forbids storing; `no-cache` demands revalidation on every use, and this
    // cache has no conditional requests — so neither is worth an entry.
    if (control.noStore || control.noCache) return;

    // `Vary` decides which *request* headers this response's identity hangs on. Only a
    // response whose every named header is already folded into the cache key may be stored;
    // anything else would be keyed wrongly, and a wrong key replays the wrong variant —
    // another user's `Cookie`, another locale's `Accept-Language`. When we cannot key on a
    // header, the safe answer is not to cache at all. (Checked unconditionally, not only
    // under `honourCacheControl`: variant correctness is not a freshness preference.)
    // A per-request `varyHeaders` overrides the wrapper's for this entry.
    if (!varyIsStorable(response.headers.get('Vary'), reqOpts?.varyHeaders ?? varyHeaders)) return;

    const ttl = resolveTtl(reqOpts?.ttlMs ?? options.ttlMs, response, url, request);
    const maxAge = control.maxAgeMs ?? ttl;
    const age = honourCacheControl ? parseAgeMs(response.headers.get('Age')) : 0;
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
      : honourCacheControl && control.staleWhileRevalidateMs !== undefined
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
    // Per-request tags win over the wrapper's, and both over the default pair.
    const reqTags = reqOpts?.tags;
    const tagList =
      (typeof reqTags === 'function' ? reqTags(response, url, request) : reqTags) ??
      options.tags?.(response, url, request) ??
      defaultTags(request.method, url);
    cache.set(key, record, {
      // `0` is how the core spells "never expires" — reached only via `ttlMs: Infinity`.
      ttlMs: Number.isFinite(totalMs) ? totalMs : 0,
      tags: tagList,
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
  function replay(record: FetchCacheRecord, marker: BlazeFetchMarker): CachedFetchResponse {
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
    // Both `HIT` and `STALE` came out of the store — `STALE` merely also started a refresh.
    defineOwn(response, 'fromBlazeCache', true);
    return response as CachedFetchResponse;
  }

  /**
   * Stamps the marker on a network response, rebuilding it only if its headers refuse.
   *
   * Also stamps `fromBlazeCache`: `MISS` for anything that crossed the wire, `true` for a
   * replay (which goes through {@link replay} instead).
   */
  function mark(response: Response, marker: BlazeFetchMarker): CachedFetchResponse {
    const fromCache = marker !== 'MISS';
    defineOwn(response, 'fromBlazeCache', fromCache);
    if (markerHeader === false) return response as CachedFetchResponse;
    try {
      response.headers.set(markerHeader, marker);
      return response as CachedFetchResponse;
    } catch {
      // Immutable headers (network responses in undici, `Response.redirect()`): rebuild so
      // the marker contract holds — the marker goes on the *rebuild*, since the original
      // refused it. Status 0 cannot be rebuilt at all: pass it through unmarked.
      if (response.status === 0) return response as CachedFetchResponse;
      const headers = new Headers(response.headers);
      headers.set(markerHeader, marker);
      const rebuilt = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
      defineOwn(rebuilt, 'url', response.url);
      defineOwn(rebuilt, 'redirected', response.redirected);
      defineOwn(rebuilt, 'fromBlazeCache', fromCache);
      return rebuilt as CachedFetchResponse;
    }
  }

  return (input, init = {}) => dispatch(input, init);
}

/**
 * `init.blazeCache` read once, at the top of `dispatch`.
 *
 * `false` collapses to "disabled for this request" — the shape a caller writes when they
 * only mean *not this one* — so the rest of the dispatch reads a single type.
 */
function getRequestOptions(init: BlazeFetchInit): BlazeFetchRequestOptions | undefined {
  return init.blazeCache === false ? { enabled: false } : init.blazeCache;
}

/**
 * The configured freshness window for this response.
 *
 * `ttlMs` may be a callback, so it resolves per response; `Cache-Control: max-age` still
 * wins afterwards when honouring is on (see `store`).
 */
function resolveTtl(
  ttl: number | ((response: Response, url: string, init: BlazeFetchEffectiveInit) => number) | undefined,
  response: Response,
  url: string,
  init: BlazeFetchEffectiveInit,
): number {
  if (typeof ttl === 'function') return ttl(response, url, init);
  return ttl ?? DEFAULT_TTL_MS;
}

/** Successful responses only. The {@link BlazeFetchOptions.methods} gate has already applied. */
function defaultShouldCache(response: Response): boolean {
  return response.status >= 200 && response.status < 300;
}

/**
 * Waits for `pending`, but rejects as soon as `signal` aborts — the abort reason (or a
 * standard `AbortError`) propagates, exactly as a mid-flight `fetch` would.
 *
 * Used by the in-flight join path: a joiner waiting on another caller's network call must
 * still honour *its own* caller's cancellation, instead of hanging for as long as the
 * leader takes.
 */
function raceWithAbort(pending: Promise<void>, signal: AbortSignal | null | undefined): Promise<void> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** `signal.reason` when set, else the standard `AbortError` DOMException. */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
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
