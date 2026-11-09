import { withBase, withQuery } from 'ufo';
import type { $Fetch, FetchOptions, FetchResponse } from 'ofetch';

import { NO_DIRECTIVES, parseAgeMs, parseCacheControl, varyIsStorable } from './cache-control.js';
import { defaultCacheKey } from './key.js';
import type {
  BlazeOfetchCacheLike,
  BlazeOfetchInstance,
  BlazeOfetchKeyContext,
  BlazeOfetchMarker,
  BlazeOfetchOptions,
  OfetchCacheRecord,
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
 * all — and none can ever reach the store, since ofetch never surfaces a 101 to callers.
 */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

/** Successful responses only. The {@link BlazeOfetchOptions.methods} gate has already applied. */
function defaultShouldCache(response: FetchResponse<unknown>): boolean {
  return response.status >= 200 && response.status < 300;
}

/**
 * `['ofetch', '<method> <url>']` — one tag drops everything this adapter stored
 * (`cache.invalidateTags('ofetch')`), the other drops a single resource.
 */
function defaultTags(ctx: BlazeOfetchKeyContext): readonly string[] {
  return ['ofetch', `${ctx.method.toLowerCase()} ${ctx.url}`];
}

/**
 * Wrap an existing ofetch (`$fetch`) instance with Blaze Cache.
 *
 * ```ts
 * import { ofetch } from 'ofetch';
 * import { blazeOfetch } from '@blaze-cache/ofetch';
 * import { createCache } from '@blaze-cache/core';
 *
 * const cache = createCache({ maxEntries: 500 });
 * const api = blazeOfetch(ofetch, cache, { ttlMs: 30_000 });
 *
 * const users = await api('https://api.example.com/users');
 * // or wrap a configured instance:
 * const api2 = blazeOfetch(ofetch.create({ baseURL: 'https://api.example.com' }), cache);
 * ```
 *
 * Successful `GET` responses are cached by default. The wrapped instance keeps ofetch's
 * full API: call it directly, or use `.raw()` / `.native` / `.create()`. Instances
 * returned by `.create()` on the wrapped result are themselves cached with the same
 * settings.
 *
 * @param instance The ofetch (`$fetch`) instance to wrap.
 * @param cache The Blaze Cache instance (or any {@link BlazeOfetchCacheLike}).
 * @param options Caching behaviour — all optional.
 */
export function blazeOfetch(
  instance: $Fetch,
  cache: BlazeOfetchCacheLike,
  options: BlazeOfetchOptions = {},
): BlazeOfetchInstance {
  const markerHeader =
    options.markerHeader === undefined ? DEFAULT_MARKER_HEADER : options.markerHeader;
  const methods = new Set((options.methods ?? DEFAULT_METHODS).map((m) => m.toUpperCase()));
  const cacheControl = options.cacheControl ?? true;
  const varyHeaders = options.varyHeaders ?? DEFAULT_VARY_HEADERS;
  const shouldCache = options.shouldCache ?? defaultShouldCache;

  /**
   * Writes this wrapper started but has not finished, by key.
   *
   * A read issued straight after a MISS can reach the lookup while the entry is still
   * buffering. This gate records that in-flight write so such a reader waits for it
   * instead of racing it to the network.
   */
  const pendingWrites = new Map<string, Promise<void>>();

  /**
   * Whether a cache-layer failure has been reported already. A throwing `cache.get`/
   * `cache.set` or callback must never fail a request the network answered well.
   */
  let warned = false;
  function warnCacheFailure(error: unknown): void {
    if (warned) return;
    warned = true;
    console.warn('[blaze-cache] cache layer failed; continuing without it', error);
  }

  function read(key: string): OfetchCacheRecord | undefined {
    try {
      return cache.get(key);
    } catch (error) {
      warnCacheFailure(error);
      return undefined;
    }
  }

  function resolveRequest(request: string | Request | URL, opts: FetchOptions): BlazeOfetchKeyContext {
    let url: string;
    if (typeof request === 'string') {
      url = request;
      // Mirror ofetch's resolution order: baseURL then query/params (applied to strings only).
      const base = opts.baseURL ?? options.baseURL;
      if (base) url = withBase(url, base);
      const query = opts.query ?? opts.params;
      if (query && Object.keys(query).length > 0) {
        url = withQuery(url, query as Parameters<typeof withQuery>[1]);
      }
    } else if (request instanceof URL) {
      url = request.toString();
    } else {
      // Request (or Request-like)
      url = (request as Request).url;
    }

    const method = (opts.method ?? (typeof request !== 'string' && 'method' in request ? (request as Request).method : undefined) ?? 'GET').toUpperCase();
    const headers = mergeHeaders(
      typeof request !== 'string' && 'headers' in request ? (request as Request).headers : undefined,
      opts.headers as HeadersInit | undefined,
    );
    return { request, options: opts, method, url, headers };
  }

  function keyOf(ctx: BlazeOfetchKeyContext): string {
    return options.key ? options.key(ctx) : defaultCacheKey(ctx.method, ctx.url, ctx.headers, varyHeaders);
  }

  async function store(
    response: FetchResponse<unknown>,
    ctx: BlazeOfetchKeyContext,
    key: string,
  ): Promise<void> {
    if (response.status === 0) return;

    const control = cacheControl ? parseCacheControl(response.headers.get('Cache-Control')) : NO_DIRECTIVES;
    if (control.noStore || control.noCache) return;

    const configured = options.ttlMs;
    const ttl = typeof configured === 'function' ? configured(response, ctx) : (configured ?? DEFAULT_TTL_MS);
    const age = cacheControl ? parseAgeMs(response.headers.get('Age')) : 0;
    const freshMs = (control.maxAgeMs ?? ttl) - age;
    if (!(freshMs > 0)) return;

    // ofetch consumes the body to produce `_data`, so the network response is usually
    // already disturbed here. Reconstruct bytes from `_data` when needed.
    let body: ArrayBuffer;
    try {
      body = await readBody(response);
    } catch {
      return; // a body that fails mid-flight must not poison the cache
    }

    const storedAt = Date.now();
    const record: OfetchCacheRecord = {
      status: response.status,
      statusText: response.statusText,
      headers: storedHeaders(response.headers, body),
      body,
      url: response.url || ctx.url,
      redirected: response.redirected,
      storedAt,
      freshUntil: storedAt + freshMs,
      _data: (response as { _data?: unknown })._data,
      responseType: ctx.options.responseType as string | undefined,
    };

    try {
      cache.set(key, record, {
        ttlMs: Number.isFinite(freshMs) ? freshMs : 0,
        tags: options.tags?.(response, ctx) ?? defaultTags(ctx),
      });
    } catch (error) {
      warnCacheFailure(error);
    }
  }

  async function execute<T>(
    request: string | Request | URL,
    opts: FetchOptions | undefined,
    wantRaw: boolean,
  ): Promise<T | FetchResponse<T>> {
    const callOpts = opts ? { ...opts } : {};
    const ctx = resolveRequest(request, callOpts);

    if (!methods.has(ctx.method)) {
      if (wantRaw) return (instance.raw as Function)(request, opts) as FetchResponse<T>;
      return instance(request as string, opts as FetchOptions) as Promise<T>;
    }

    const control = cacheControl ? parseCacheControl(ctx.headers.get('Cache-Control')) : NO_DIRECTIVES;
    const bypassRead =
      control.noStore ||
      control.noCache ||
      control.maxAgeMs === 0 ||
      (callOpts as { cache?: string }).cache === 'no-store' ||
      (callOpts as { cache?: string }).cache === 'no-cache' ||
      (callOpts as { cache?: string }).cache === 'reload';
    const bypassWrite = control.noStore || (callOpts as { cache?: string }).cache === 'no-store';

    let key: string | undefined;
    if (!bypassRead || !bypassWrite) {
      try {
        key = keyOf(ctx);
      } catch (error) {
        warnCacheFailure(error);
        key = undefined;
      }
    }

    // --- read ---
    if (!bypassRead && key !== undefined) {
      let record = read(key);
      if (!canServe(record, callOpts)) {
        const pending = pendingWrites.get(key);
        if (pending && (await settleOrAbort(pending, (callOpts as { signal?: AbortSignal }).signal))) {
          record = read(key);
        }
      }
      if (isRecord(record)) {
        if ((callOpts as { cache?: string }).cache !== 'force-cache' && Date.now() > record.freshUntil) {
          try { cache.delete?.(key); } catch (error) { warnCacheFailure(error); }
        } else {
          return replay(record, 'HIT', wantRaw) as T | FetchResponse<T>;
        }
      }
    }

    // --- miss: network ---
    const response = (await instance.raw(request as string, opts as FetchOptions)) as FetchResponse<T>;

    // --- write ---
    if (!bypassWrite && key !== undefined && response) {
      if (varyIsStorable(response.headers.get('Vary'), varyHeaders)) {
        let keep = false;
        try {
          keep = shouldCache(response as FetchResponse<unknown>, ctx);
        } catch (error) {
          warnCacheFailure(error);
        }
        if (keep) {
          const gateKey = key;
          const write = store(response as FetchResponse<unknown>, ctx, gateKey).catch(warnCacheFailure);
          void write.finally(() => {
            if (pendingWrites.get(gateKey) === write) pendingWrites.delete(gateKey);
          });
          pendingWrites.set(gateKey, write);
        }
      }
    }

    const marked = await mark(response, 'MISS');
    return (wantRaw ? marked : (marked as FetchResponse<T> & { _data?: T })._data) as T | FetchResponse<T>;
  }

  function replay(record: OfetchCacheRecord, marker: BlazeOfetchMarker, wantRaw: boolean): unknown {
    const headers = headersFromRecord(record.headers);
    if (markerHeader !== false) headers.set(markerHeader, marker);

    const body = NULL_BODY_STATUSES.has(record.status) ? null : record.body;
    const response = new Response(body, {
      status: record.status,
      statusText: record.statusText,
      headers,
    }) as FetchResponse<unknown> & { _data?: unknown };
    defineOwn(response, 'url', record.url);
    defineOwn(response, 'redirected', record.redirected);
    if (record._data !== undefined) {
      response._data = record._data;
    } else if (body !== null) {
      response._data = decodeData(record.body, record.headers, record.responseType);
    }

    return wantRaw ? response : response._data;
  }

  async function mark<T>(response: FetchResponse<T>, marker: BlazeOfetchMarker): Promise<FetchResponse<T>> {
    if (markerHeader === false) return response;
    try {
      response.headers.set(markerHeader, marker);
      return response;
    } catch {
      if (response.status === 0) return response;
      const headers = new Headers(response.headers);
      headers.set(markerHeader, marker);
      let body: ArrayBuffer | null = null;
      if (response.body !== null || response.bodyUsed || (response as { _data?: unknown })._data !== undefined) {
        try {
          body = response.bodyUsed
            ? await encodeData((response as { _data?: unknown })._data, response.headers)
            : await response.clone().arrayBuffer();
        } catch {
          body = await encodeData((response as { _data?: unknown })._data, response.headers);
        }
      }
      const rebuilt = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      }) as FetchResponse<T> & { _data?: T };
      defineOwn(rebuilt, 'url', response.url);
      defineOwn(rebuilt, 'redirected', response.redirected);
      if ('_data' in response) rebuilt._data = (response as { _data?: T })._data;
      return rebuilt;
    }
  }

  function wrap(target: $Fetch): BlazeOfetchInstance {
    const wrapped = ((request: any, opts?: any) => execute(request, opts, false)) as BlazeOfetchInstance;
    wrapped.raw = ((request: any, opts?: any) => execute(request, opts, true)) as BlazeOfetchInstance['raw'];
    wrapped.native = target.native?.bind ? target.native.bind(target) : target.native;
    wrapped.create = ((defaultOptions?: any, customGlobalOptions?: any) =>
      wrap(target.create(defaultOptions, customGlobalOptions))) as BlazeOfetchInstance['create'];
    return wrapped;
  }

  return wrap(instance);
}



// --- helpers (mirrored from @blaze-cache/ky for shared-cache compatibility) ---

function canServe(value: OfetchCacheRecord | undefined, opts: FetchOptions): value is OfetchCacheRecord {
  return (
    isRecord(value) &&
    ((opts as { cache?: string }).cache === 'force-cache' || Date.now() <= value.freshUntil)
  );
}

function isRecord(value: OfetchCacheRecord | undefined): value is OfetchCacheRecord {
  return typeof value?.freshUntil === 'number' && value.body instanceof ArrayBuffer;
}

function settleOrAbort(
  pending: Promise<unknown>,
  signal: AbortSignal | null | undefined,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (!signal) return pending.then(() => true, () => true);
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    };
    const opened = (): void => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(opened, opened);
  });
}

function storedHeaders(headers: Headers, body: ArrayBuffer): Record<string, string> {
  const record = headersToRecord(headers);
  delete record['transfer-encoding'];
  if (body.byteLength > 0) {
    delete record['content-encoding'];
    if ('content-length' in record) record['content-length'] = String(body.byteLength);
  }
  return record;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, name) => {
    Object.defineProperty(record, name, { value, enumerable: true, writable: true, configurable: true });
  });
  return record;
}

function headersFromRecord(record: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(record)) {
    headers.append(name, value);
  }
  return headers;
}

function mergeHeaders(...sources: (HeadersInit | Request['headers'] | undefined | null)[]): Headers {
  const out = new Headers();
  for (const src of sources) {
    if (!src) continue;
    if (src instanceof Headers) {
      src.forEach((v, k) => out.set(k, v));
    } else if (Array.isArray(src)) {
      for (const [k, v] of src) out.set(k, v);
    } else {
      for (const [k, v] of Object.entries(src)) {
        if (v !== undefined) out.set(k, String(v as string));
      }
    }
  }
  return out;
}

function defineOwn(target: object, key: string, value: unknown): void {
  try {
    Object.defineProperty(target, key, { value, writable: true, enumerable: false, configurable: true });
  } catch {
    // Frozen: cosmetic, never worth failing a hit over.
  }
}

async function readBody(response: FetchResponse<unknown>): Promise<ArrayBuffer> {
  if (!response.bodyUsed) {
    try {
      return await response.clone().arrayBuffer();
    } catch {
      // fall through to reconstruct from _data
    }
  }
  return encodeData((response as { _data?: unknown })._data, response.headers);
}

async function encodeData(
  data: unknown,
  headers?: Headers | Record<string, string>,
): Promise<ArrayBuffer> {
  if (data === undefined) return new ArrayBuffer(0);
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return data.arrayBuffer();
  }
  if (typeof data === 'string') {
    // If the content is JSON-typed, the body must be valid JSON. A parsed JSON string
    // value (e.g. response body `"hello"` → _data `hello`) must round-trip as the JSON
    // encoding; a text/* response keeps the raw string.
    const ct = getHeader(headers, 'content-type') ?? '';
    if (/^\s*application\/(?:[\w!#$%&*.^`~-]*\+)?json/i.test(ct)) {
      return new TextEncoder().encode(JSON.stringify(data)).buffer as ArrayBuffer;
    }
    return new TextEncoder().encode(data).buffer as ArrayBuffer;
  }
  // JSON-like value: serialize so raw .json() readers of a rebuilt response work.
  return new TextEncoder().encode(JSON.stringify(data)).buffer as ArrayBuffer;
}

function getHeader(
  headers: Headers | Record<string, string> | undefined,
  name: string,
): string | null | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name);
  return (headers as Record<string, string>)[name] ?? (headers as Record<string, string>)[name.toLowerCase()];
}

function decodeData(body: ArrayBuffer, headers: Record<string, string>, responseType?: string): unknown {
  if (responseType === 'arrayBuffer') return body;
  if (responseType === 'blob') return new Blob([body]);
  const text = new TextDecoder().decode(body);
  const ct = headers['content-type'] ?? '';
  const type = responseType ?? (ct.includes('json') || /^\s*application\/(?:[\w!#$%&*.^`~-]*\+)?json/i.test(ct) ? 'json' : 'text');
  if (type === 'json' || type === undefined) {
    try { return JSON.parse(text); } catch { return text; }
  }
  return text;
}
