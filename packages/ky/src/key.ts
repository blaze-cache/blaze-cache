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
 * defaultCacheKey(request, ['authorization']); // "get https://api.example.com/users?a3f9k"
 * ```
 *
 * By the time ky's hooks run, the `Request` is already the *final* request: `prefixUrl`
 * (ky v1) / `baseUrl` (ky v2) and `searchParams` applied, method normalized and headers
 * merged — so its `url` is exactly what will go on the wire, and one endpoint occupies one
 * entry instead of every spelling of it.
 *
 * The hash is appended whenever `varyHeaders` is non-empty — including when every value is
 * absent — so keys stay stable across calls. Pass `varyHeaders: []` to get the bare
 * `"<method> <url>"` form. Call it from the {@link BlazeKyCacheOptions.key} callback with
 * the `request` you were handed.
 */
export function defaultCacheKey(request: Request, varyHeaders: readonly string[]): string {
  const base = `${request.method.toLowerCase()} ${request.url}`;
  if (varyHeaders.length === 0) return base;

  // JSON, never a plain join: the encoding must stay *injective*, because a collision here
  // would replay one identity's payload to another. Joining with a space lets a value
  // containing the separator impersonate the boundary — `['x y', '']` and `['x', 'y']` are
  // two different identities, and only a length-delimited encoding (JSON being the simplest)
  // keeps them apart.
  const vary = JSON.stringify(varyHeaders.map((name) => request.headers.get(name) ?? ''));
  return `${base}?${fnv1a(vary)}`;
}
