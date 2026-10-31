/**
 * ky hooks that cache HTTP responses through a WebAssembly cache.
 *
 * ky is built on `fetch` and designed around hooks, so caching is two of them: one that
 * answers a request from the cache by returning a `Response` (ky skips the network
 * entirely), and one that stores the response worth keeping. Per-entry TTLs, tag-based
 * invalidation, `Cache-Control` on both sides of the exchange and SIEVE eviction all come
 * from {@link createCache | `@blaze-cache/core`} — and both ky majors are supported:
 * v1's `(request, options, response, state)` hooks and v2's single-state-object hooks are
 * recognised at runtime, from one implementation.
 *
 * ```ts
 * import ky from 'ky';
 * import { blazeKyHook, createBlazeKy } from '@blaze-cache/ky';
 * import { createCache } from '@blaze-cache/core';
 *
 * const cache = await createCache({ capacity: 1000 });
 *
 * // Hook style (preferred, fits ky):
 * const api = ky.extend({
 *   hooks: {
 *     ...blazeKyHook(cache, { ttlMs: 30_000, methods: ['GET'] }),
 *   },
 * });
 *
 * // Helper style:
 * const api = createBlazeKy(cache, { prefixUrl: 'https://api.example.com', ttlMs: 30_000 });
 *
 * const users = await api.get('users').json();
 * ```
 *
 * @packageDocumentation
 */

export { blazeKyHook } from './hook.js';
export { createBlazeKy } from './client.js';

export { parseCacheControl, parseAgeMs, varyIsStorable } from './cache-control.js';
export type { CacheControl } from './cache-control.js';

export { defaultCacheKey, fnv1a } from './key.js';

export type {
  BlazeKyAfterResponseHook,
  BlazeKyBeforeRequestHook,
  BlazeKyCacheLike,
  BlazeKyCacheOptions,
  BlazeKyHookState,
  BlazeKyHooks,
  BlazeKyMarker,
  CreateBlazeKyOptions,
  KyCacheRecord,
} from './types.js';
