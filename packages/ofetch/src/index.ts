import { ofetch } from 'ofetch';
import type { $Fetch, FetchOptions } from 'ofetch';

import { blazeOfetch } from './client.js';
import type {
  BlazeOfetchCacheLike,
  BlazeOfetchInstance,
  CreateBlazeOfetchOptions,
} from './types.js';

/**
 * Creates a Blaze-cached ofetch instance from scratch.
 *
 * ```ts
 * import { createBlazeOfetch } from '@blaze-cache/ofetch';
 * import { createCache } from '@blaze-cache/core';
 *
 * const cache = createCache({ maxEntries: 500 });
 * const api = createBlazeOfetch(cache, {
 *   baseURL: 'https://api.example.com',
 *   ttlMs: 30_000,
 *   tags: (res, ctx) => ['ofetch', ctx.url],
 * });
 *
 * const users = await api('/users');        // parsed JSON, cached
 * const res = await api.raw('/users');      // FetchResponse with x-blaze-cache marker
 * ```
 *
 * ofetch defaults (like `baseURL`, `headers`, `retry`, `timeout`, `query`) and Blaze Cache
 * options are passed in a single bag and split apart here. A custom `fetch` implementation
 * (if provided) is forwarded as ofetch's global fetch override.
 *
 * @param cache The Blaze Cache instance (or any {@link BlazeOfetchCacheLike}).
 * @param options ofetch defaults mixed with {@link BlazeOfetchOptions}.
 */
export function createBlazeOfetch(
  cache: BlazeOfetchCacheLike,
  options: CreateBlazeOfetchOptions & { fetch?: typeof globalThis.fetch } = {},
): BlazeOfetchInstance {
  const {
    ttlMs,
    methods,
    cacheControl,
    key,
    shouldCache,
    tags,
    varyHeaders,
    markerHeader,
    fetch: customFetch,
    ...ofetchOptions
  } = options as CreateBlazeOfetchOptions & { fetch?: typeof globalThis.fetch };

  const globalOpts = customFetch ? { fetch: customFetch } : undefined;
  const instance: $Fetch = ofetch.create(ofetchOptions as FetchOptions, globalOpts as any);
  return blazeOfetch(instance, cache, {
    ttlMs,
    methods,
    cacheControl,
    key,
    shouldCache,
    tags,
    varyHeaders,
    markerHeader,
    baseURL: (ofetchOptions as FetchOptions).baseURL ?? options.baseURL,
  });
}

export { blazeOfetch } from './client.js';
export { defaultCacheKey, fnv1a } from './key.js';
export { parseAgeMs, parseCacheControl, varyIsStorable, NO_DIRECTIVES } from './cache-control.js';
export type { CacheControl } from './cache-control.js';
export type {
  BlazeOfetchCacheLike,
  BlazeOfetchInstance,
  BlazeOfetchKeyContext,
  BlazeOfetchMarker,
  BlazeOfetchOptions,
  CreateBlazeOfetchOptions,
  OfetchCacheRecord,
} from './types.js';
