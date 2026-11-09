/**
 * Axios adapter backed by Blaze Cache.
 *
 * ```ts
 * import { createCache } from '@blaze-cache/core';
 * import { installBlazeCache } from '@blaze-cache/axios';
 *
 * const cache = await createCache({ persistence: { namespace: 'api' } });
 * installBlazeCache(api, { cache, ttlMs: 30_000 });
 *
 * const response = await api.get('/users/42');
 * response.fromBlazeCache; // true on a hit
 * ```
 *
 * @packageDocumentation
 */

export { blazeAdapter, installBlazeCache } from './adapter.js';
export type { InstallBlazeCacheOptions } from './adapter.js';

export { NO_DIRECTIVES, parseAgeMs, parseCacheControl, varyIsStorable } from './cache-control.js';
export type { CacheControl } from './cache-control.js';

export { defaultCacheKey, fnv1a } from './key.js';

export type {
  AxiosCacheRecord,
  BlazeAxiosCacheLike,
  BlazeAxiosCacheOptions,
  BlazeAxiosRequestOptions,
  CachedAxiosResponse,
} from './types.js';

/**
 * Invalidate tags on a cache that supports it (e.g. `BlazeCache` from
 * `@blaze-cache/core`). A no-op when the cache has no `invalidateTags` method.
 */
export function invalidateCacheTags(
  cache: { invalidateTags?(...tags: string[]): unknown } | undefined | null,
  ...tags: string[]
): void {
  if (!cache || tags.length === 0) return;
  if (typeof cache.invalidateTags === 'function') cache.invalidateTags(...tags);
}
