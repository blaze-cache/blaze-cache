/**
 * A drop-in `fetch()` replacement backed by Blaze Cache.
 *
 * `createBlazeFetch` returns a function with the platform signature, so it slots into any
 * code that expects `typeof fetch` — and gets caching underneath: per-entry TTLs,
 * `Cache-Control` on both sides of the exchange, tag-based invalidation, SIEVE eviction and
 * optional IndexedDB persistence, all inherited from {@link createCache | `@blaze-cache/core`}.
 *
 * ```ts
 * import { createCache } from '@blaze-cache/core';
 * import { createBlazeFetch } from '@blaze-cache/fetch';
 *
 * const cache = await createCache({ capacity: 1000 });
 * const fetch = createBlazeFetch(cache, { ttlMs: 30_000 });
 *
 * const response = await fetch('/api/users');
 * response.headers.get('x-blaze-cache'); // 'MISS', then 'HIT'
 * response.fromBlazeCache;               // false, then true
 * ```
 *
 * @packageDocumentation
 */

export { createBlazeFetch } from './client.js';

export { parseCacheControl, parseAgeMs, varyIsStorable } from './cache-control.js';
export type { CacheControl } from './cache-control.js';

export { defaultCacheKey, fnv1a } from './key.js';

export type {
  BlazeFetch,
  BlazeFetchCacheLike,
  BlazeFetchEffectiveInit,
  BlazeFetchRequestOptions,
  BlazeFetchInit,
  BlazeFetchMarker,
  BlazeFetchOptions,
  CachedFetchResponse,
  FetchCacheRecord,
} from './types.js';

/**
 * Invalidate tags on a cache that supports it (e.g. `BlazeCache` from
 * `@blaze-cache/core`). A no-op when the cache has no `invalidateTags` method.
 *
 * ```ts
 * invalidateCacheTags(cache, 'todos'); // after a mutation, from outside a request
 * ```
 */
export function invalidateCacheTags(
  cache: { invalidateTags?(...tags: string[]): unknown } | undefined | null,
  ...tags: string[]
): void {
  if (!cache || tags.length === 0) return;
  if (typeof cache.invalidateTags === 'function') cache.invalidateTags(...tags);
}
