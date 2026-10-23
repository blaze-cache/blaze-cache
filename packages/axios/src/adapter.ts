import { AxiosError, getAdapter } from 'axios';
import type {
  AxiosAdapter,
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from 'axios';

import { parseCacheControl } from './cache-control.js';
import { defaultCacheKey } from './key.js';
import { readHeader, toAxiosHeaders, toPlainHeaders } from './headers.js';
import type {
  AxiosCacheRecord,
  BlazeAxiosCacheLike,
  BlazeAxiosCacheOptions,
  CachedAxiosResponse,
} from './types.js';

/** Freshness window when neither the option nor `Cache-Control` says otherwise. */
const DEFAULT_TTL_MS = 60_000;

/** Headers whose values split the cache unless the caller says otherwise. */
const DEFAULT_VARY_HEADERS: readonly string[] = ['authorization'];

const HIT = 'HIT';
const MISS = 'MISS';

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
  const varyHeaders = options.varyHeaders ?? DEFAULT_VARY_HEADERS;
  const markerHeader = options.markerHeader === undefined ? 'x-blaze-cache' : options.markerHeader;
  const network = options.adapter ?? getAdapter(['xhr', 'http', 'fetch']);
  const keyOf = (config: InternalAxiosRequestConfig): string =>
    options.key ? options.key(config) : defaultCacheKey(config, varyHeaders);
  const shouldCache = options.shouldCache ?? defaultShouldCache;

  return async function blazeCacheAdapter(config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
    const requestControl = parseCacheControl(readHeader(config.headers, 'Cache-Control'));
    // `no-store`: neither read nor write. `no-cache`: may store, but must not serve blindly.
    const skipWrite = requestControl.noStore;
    const skipRead = requestControl.noStore || requestControl.noCache;
    const key = keyOf(config);

    if (!skipRead) {
      const record = cache.get(key);
      if (record) {
        return settle(cachedResponse(record, config, markerHeader), config);
      }
    }

    const response = await network(config);
    if (markerHeader) {
      response.headers = toAxiosHeaders(response.headers).set(markerHeader, MISS);
    }

    if (!skipWrite && shouldCache(response, config)) {
      const control = parseCacheControl(readHeader(response.headers, 'Cache-Control'));
      const ttlMs = control.maxAgeMs ?? resolveTtl(options.ttlMs, response, config);
      // `max-age=0` (or a non-positive TTL) means "do not keep this".
      if (!(control.noStore || control.noCache) && ttlMs > 0) {
        const method = (config.method ?? 'get').toLowerCase();
        const record: AxiosCacheRecord = {
          status: response.status,
          statusText: response.statusText,
          headers: toPlainHeaders(response.headers),
          // Raw on purpose: axios runs `transformResponse` on replay, exactly as it would
          // for a fresh network response.
          data: response.data,
          storedAt: Date.now(),
        };
        const tags = options.tags?.(response, config) ?? ['axios', `${method} ${config.url ?? ''}`];
        cache.set(key, record, { ttlMs, tags });
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
 * installBlazeCache(api, { cache });          // GET responses stay fresh for 60s
 * installBlazeCache(api, { cache, ttlMs: 5_000 });
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

function defaultShouldCache(
  response: AxiosResponse,
  config: InternalAxiosRequestConfig,
): boolean {
  const method = (config.method ?? 'get').toLowerCase();
  return method === 'get' && response.status >= 200 && response.status < 300;
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
      response.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
      config,
      undefined,
      response,
    ),
  );
}
