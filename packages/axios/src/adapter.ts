import { AxiosError, getAdapter } from 'axios';
import type {
  AxiosAdapter,
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from 'axios';

import { NO_DIRECTIVES, parseAgeMs, parseCacheControl, varyIsStorable } from './cache-control.js';
import { defaultCacheKey, encodeRequestBody, resolveRequestUrl } from './key.js';
import { readHeader, toAxiosHeaders, toPlainHeaders } from './headers.js';
import type {
  AxiosCacheRecord,
  BlazeAxiosCacheLike,
  BlazeAxiosCacheOptions,
  BlazeAxiosRequestOptions,
  CachedAxiosResponse,
} from './types.js';

/** Freshness window when neither the option nor `Cache-Control` says otherwise. */
const DEFAULT_TTL_MS = 30_000;

/** Only these methods are cached unless the caller says otherwise. */
const DEFAULT_METHODS: readonly string[] = ['GET', 'HEAD'];

/** Headers whose values split the cache unless the caller says otherwise. */
const DEFAULT_VARY_HEADERS: readonly string[] = ['Authorization'];

const HIT = 'HIT';
const MISS = 'MISS';

/**
 * Shape check: is this value one **this adapter** wrote?
 *
 * `freshUntil` is the deadline the adapter stamps on every record, and `data` the body it
 * always stores — a value missing either belongs to something else sharing the cache (a
 * `FetchCacheRecord` carries `freshUntil` but no `data`; raw SWR values and react-query
 * mirrors carry neither), and a read must neither serve nor destroy it. On a
 * single-integration cache this is always true; the check exists for the shared one.
 */
function isAxiosRecord(value: AxiosCacheRecord | undefined): value is AxiosCacheRecord {
  return typeof value?.freshUntil === 'number' && 'data' in value;
}

function toUpperMethods(methods: readonly string[] | undefined): Set<string> {
  return new Set((methods ?? DEFAULT_METHODS).map((m) => m.toUpperCase()));
}

function getRequestOptions(config: InternalAxiosRequestConfig): BlazeAxiosRequestOptions | undefined {
  const raw = (config as InternalAxiosRequestConfig & { blazeCache?: BlazeAxiosRequestOptions | false }).blazeCache;
  if (raw === false) return { enabled: false };
  return raw;
}

/**
 * Wraps an axios adapter with a Blaze Cache layer.
 *
 * ```ts
 * import { blazeAdapter } from '@blaze-cache/axios';
 *
 * const api = axios.create({ adapter: blazeAdapter({ cache }) });
 * ```
 *
 * For an existing instance prefer {@link installBlazeCache}, which guarantees the wrapper
 * captures the *previous* adapter instead of itself.
 */
export function blazeAdapter(options: BlazeAxiosCacheOptions): AxiosAdapter {
  const cache: BlazeAxiosCacheLike = options.cache;
  const globalMethods = toUpperMethods(options.methods);
  const globalVaryHeaders = options.varyHeaders ?? DEFAULT_VARY_HEADERS;
  const markerHeader = options.markerHeader === undefined ? 'x-blaze-cache' : options.markerHeader;
  const honourCacheControl = options.honourCacheControl ?? options.cacheControl ?? true;
  const network = options.adapter ?? getAdapter(['xhr', 'http', 'fetch']);

  return async function blazeCacheAdapter(config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
    const reqOpts = getRequestOptions(config);
    const method = (config.method ?? 'get').toUpperCase();
    const enabled = reqOpts?.enabled ?? true;
    const methods = globalMethods;
    // Per-request `enabled: true` can opt a method in; `enabled: false` opts out entirely.
    const methodAllowed = methods.has(method) || reqOpts?.enabled === true;

    // A body that cannot be folded into the key would make every request carrying one
    // share a single entry — `POST /orders` with two payloads would occupy one entry and
    // the first response would be replayed for the second. Refusing to cache costs one
    // extra request; a wrong hit hands one caller another caller's response, so the
    // asymmetry decides it. A caller-supplied `key` owns the whole key, so it is trusted
    // to describe the body itself.
    const ownsKey =
      typeof options.key === 'function' ||
      typeof reqOpts?.key === 'string' ||
      typeof reqOpts?.key === 'function';
    const bodyKeyed =
      config.data === undefined ||
      config.data === null ||
      ownsKey ||
      encodeRequestBody(config.data) !== undefined;

    const cacheable =
      enabled && methodAllowed && config.responseType !== 'stream' && bodyKeyed;

    const varyHeaders = reqOpts?.varyHeaders ?? globalVaryHeaders;
    const keyOf = (): string => {
      if (typeof reqOpts?.key === 'string') return reqOpts.key;
      if (typeof reqOpts?.key === 'function') return reqOpts.key(config);
      return options.key ? options.key(config) : defaultCacheKey(config, varyHeaders);
    };
    const shouldCache = options.shouldCache ?? ((response) => response.status >= 200 && response.status < 300);
    const tagsFor = options.tags;

    // --- mutation/side-effect invalidation (runs after network, even if not cacheable) ---
    const invalidateTags = (tags: readonly string[] | undefined) => {
      if (!tags || tags.length === 0) return;
      if (typeof cache.invalidateTags !== 'function') return;
      try {
        cache.invalidateTags(...tags);
      } catch (error) {
        console.warn('[blaze-cache] tag invalidation failed', error);
      }
    };

    if (!cacheable) {
      const response = await network(config);
      if (markerHeader) {
        response.headers = toAxiosHeaders(response.headers).set(markerHeader, MISS);
      }
      (response as CachedAxiosResponse).fromBlazeCache = false;
      invalidateTags(reqOpts?.invalidateTags);
      return response;
    }

    const requestControl = honourCacheControl
      ? parseCacheControl(readHeader(config.headers, 'Cache-Control'))
      : NO_DIRECTIVES;
    // `no-store`: neither read nor write. `no-cache` / `max-age=0`: skip read (revalidate intent).
    const skipWrite = requestControl.noStore;
    const skipRead =
      requestControl.noStore || requestControl.noCache || requestControl.maxAgeMs === 0 || reqOpts?.forceRefresh === true;

    let key: string | undefined;
    if (!skipRead || !skipWrite) {
      try {
        key = keyOf();
      } catch (error) {
        console.warn('[blaze-cache] cache key generation failed — falling back to the network', error);
        key = undefined;
      }
    }

    if (!skipRead && key !== undefined) {
      let cached: CachedAxiosResponse | undefined;
      try {
        const record = cache.get(key);
        if (isAxiosRecord(record)) {
          if (Date.now() <= record.freshUntil) {
            cached = cachedResponse(record, config, markerHeader);
          } else {
            // Past its own deadline — drop our stale record (but never a foreign one).
            cache.delete?.(key);
          }
        }
      } catch (error) {
        console.warn('[blaze-cache] reading from the cache failed — falling back to the network', error);
      }
      if (cached) return settle(cached, config);
    }

    const response = await network(config);
    if (markerHeader) {
      response.headers = toAxiosHeaders(response.headers).set(markerHeader, MISS);
    }
    (response as CachedAxiosResponse).fromBlazeCache = false;

    // Invalidate after the network round-trip (useful on mutations / cache-busting writes).
    invalidateTags(reqOpts?.invalidateTags);

    if (!skipWrite && key !== undefined) {
      try {
        // `Vary` is always honored (variant correctness is not a freshness preference).
        const storable =
          shouldCache(response, config) &&
          varyIsStorable(readHeader(response.headers, 'Vary'), varyHeaders);
        if (storable) {
          const control = honourCacheControl
            ? parseCacheControl(readHeader(response.headers, 'Cache-Control'))
            : NO_DIRECTIVES;
          const ageMs = honourCacheControl ? parseAgeMs(readHeader(response.headers, 'Age')) : 0;
          const configuredTtl = resolveTtl(reqOpts?.ttlMs ?? options.ttlMs, response, config);
          const ttlMs = (control.maxAgeMs ?? configuredTtl) - ageMs;
          if (!(control.noStore || control.noCache) && ttlMs > 0) {
            const storedAt = Date.now();
            const headers = storedHeaders(response.headers, response.data);
            if (markerHeader) delete headers[markerHeader.toLowerCase()];
            const record: AxiosCacheRecord = {
              status: response.status,
              statusText: response.statusText,
              headers,
              data: response.data, // raw: axios runs transformResponse on replay
              storedAt,
              freshUntil: storedAt + ttlMs,
            };
            const reqTags = reqOpts?.tags;
            const globalTags = tagsFor;
            const tagList =
              (typeof reqTags === 'function' ? reqTags(response, config) : reqTags) ??
              (typeof globalTags === 'function' ? globalTags(response, config) : globalTags) ??
              ['axios', `${method.toLowerCase()} ${resolveRequestUrl(config)}`];
            cache.set(key, record, { ttlMs, tags: [...tagList] });
          }
        }
      } catch (error) {
        console.warn('[blaze-cache] storing the response failed — it is returned unstored', error);
      }
    }

    return response;
  };
}

/**
 * Installs the Blaze Cache adapter on an axios instance.
 *
 * ```ts
 * import { installBlazeCache } from '@blaze-cache/axios';
 *
 * installBlazeCache(api, { cache });                          // GET/HEAD, 30s, Cache-Control aware
 * installBlazeCache(api, { cache, ttlMs: 30_000, methods: ['GET'], varyHeaders: ['Authorization'] });
 * ```
 *
 * The adapter currently in `instance.defaults` is captured **before** it is replaced, so the
 * wrapper always delegates to a real network adapter and can never recurse into itself.
 */
export function installBlazeCache(
  instance: AxiosInstance,
  options: InstallBlazeCacheOptions,
): void {
  const { adapter, ...rest } = options;
  instance.defaults.adapter = blazeAdapter({
    ...rest,
    adapter: adapter === undefined ? resolveAdapter(instance.defaults.adapter) : resolveAdapter(adapter),
  });
}

/** {@link BlazeAxiosCacheOptions} where `adapter` may also be an axios adapter *name*. */
export type InstallBlazeCacheOptions = Omit<BlazeAxiosCacheOptions, 'adapter'> & {
  adapter?: AxiosRequestConfig['adapter'];
};

function resolveAdapter(adapter: AxiosRequestConfig['adapter']): AxiosAdapter {
  if (typeof adapter === 'function') return adapter;
  return getAdapter(adapter ?? ['xhr', 'http', 'fetch']);
}

/**
 * Response headers for the record, corrected to describe `data` instead of the wire.
 *
 * axios's adapters decode the body for you (and already drop `content-encoding`), but
 * `content-length` keeps the size of what crossed the network. `transfer-encoding` stops
 * being true the moment the body is buffered. Replaying either hands back a response that
 * contradicts itself. Bodyless responses (HEAD) keep both; a parsed object has no
 * knowable byte length, so its `content-length` is left alone rather than invented.
 */
function storedHeaders(headers: unknown, data: unknown): Record<string, unknown> {
  const record = toPlainHeaders(headers);
  if (data === null || data === undefined) return record;

  delete record['content-encoding'];
  delete record['transfer-encoding'];
  const size = byteLengthOf(data);
  if (size !== undefined && 'content-length' in record) {
    record['content-length'] = String(size);
  }
  return record;
}

/** Payload size in bytes when it is knowable — `undefined` for parsed objects. */
function byteLengthOf(data: unknown): number | undefined {
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof data === 'string') return new TextEncoder().encode(data).length;
  return undefined;
}

function resolveTtl(
  ttl: BlazeAxiosCacheOptions['ttlMs'],
  response: AxiosResponse,
  config: InternalAxiosRequestConfig,
): number {
  if (typeof ttl === 'function') return ttl(response, config);
  return ttl ?? DEFAULT_TTL_MS;
}

/** Rebuilds an `AxiosResponse` from a stored record, without touching hit/miss statistics. */
function cachedResponse(
  record: AxiosCacheRecord,
  config: InternalAxiosRequestConfig,
  markerHeader: string | false,
): CachedAxiosResponse {
  const headers = toAxiosHeaders(record.headers);
  if (markerHeader) headers.set(markerHeader, HIT);
  return {
    data: record.data,
    status: record.status,
    statusText: record.statusText,
    headers,
    config,
    request: undefined,
    fromBlazeCache: true,
  };
}

/**
 * Applies the request's `validateStatus` to a replayed response.
 *
 * A cached `404` must reject exactly like a network `404` would, even if the record was
 * written under a more permissive `validateStatus`.
 */
function settle(
  response: AxiosResponse,
  config: InternalAxiosRequestConfig,
): Promise<AxiosResponse> {
  const validateStatus = config.validateStatus;
  if (!validateStatus || validateStatus(response.status)) {
    return Promise.resolve(response);
  }
  return Promise.reject(
    new AxiosError(
      `Request failed with status code ${response.status}`,
      response.status >= 400 && response.status < 500
        ? AxiosError.ERR_BAD_REQUEST
        : AxiosError.ERR_BAD_RESPONSE,
      config,
      undefined,
      response,
    ),
  );
}
