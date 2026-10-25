import type { BlazeFetchEffectiveInit } from './types.js';

/**
 * FNV-1a, 32-bit.
 *
 * Folds sensitive material (bearer tokens, `vary` headers) into a short, stable token. It is
 * not a security primitive — the point is that a persisted cache key never contains a secret
 * in readable form.
 */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Default cache key: method + URL, plus a hash of the `varyHeaders` values.
 *
 * ```ts
 * defaultCacheKey('/api/users', init, ['authorization']); // "get /api/users/a3f9k"
 * ```
 *
 * The hash is appended whenever `varyHeaders` is non-empty — including when every value is
 * absent — so keys stay stable across calls. Pass `varyHeaders: []` to get the bare
 * `"<method> <url>"` form. Call it from the {@link BlazeFetchOptions.key} callback with the
 * `init` you were handed.
 */
export function defaultCacheKey(
  url: string,
  init: BlazeFetchEffectiveInit,
  varyHeaders: readonly string[],
): string {
  const base = `${init.method.toLowerCase()} ${url}`;
  if (varyHeaders.length === 0) return base;

  const headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
  const vary = varyHeaders.map((name) => headers.get(name) ?? '').join(' ');
  return `${base}?${fnv1a(vary)}`;
}
