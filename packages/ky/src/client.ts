import ky from 'ky';
import type { KyInstance } from 'ky';

import { blazeKyHook } from './hook.js';
import type { BlazeKyCacheLike, CreateBlazeKyOptions } from './types.js';

/**
 * A ky instance with Blaze Cache built in — the helper form of {@link blazeKyHook}.
 *
 * ```ts
 * import { createBlazeKy } from '@blaze-cache/ky';
 *
 * const api = createBlazeKy(cache, {
 *   prefixUrl: 'https://api.example.com',   // any ky option, as usual
 *   ttlMs: 30_000,                          // …plus the cache options
 * });
 *
 * const users = await api.get('users').json();
 * ```
 *
 * Every option ky accepts is passed through untouched (`prefixUrl`/`baseUrl`, `headers`,
 * `retry`, `timeout`, `fetch`, …). Hooks you add are preserved and run **before** the
 * cache's own: a header your `beforeRequest` sets is folded into the cache key, and an
 * `afterResponse` of yours sees the response before it is stored.
 *
 * @param cache The Blaze Cache instance (or any {@link BlazeKyCacheLike}).
 * @param options ky options mixed with {@link BlazeKyCacheOptions} — split apart here.
 */
export function createBlazeKy(
  cache: BlazeKyCacheLike,
  options: CreateBlazeKyOptions = {},
): KyInstance {
  const {
    ttlMs,
    methods,
    cacheControl,
    key,
    shouldCache,
    tags,
    varyHeaders,
    markerHeader,
    ...kyOptions
  } = options;

  // `extend` merges hooks by appending, so chaining gives exactly the documented order:
  // the user's hooks from the first call run before the cache's hooks from the second.
  return ky.extend(kyOptions).extend({
    hooks: blazeKyHook(cache, {
      ttlMs,
      methods,
      cacheControl,
      key,
      shouldCache,
      tags,
      varyHeaders,
      markerHeader,
    }),
  });
}
