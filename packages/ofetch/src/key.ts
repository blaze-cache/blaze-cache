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

/** axios' own `isAbsoluteURL` test — a scheme or `//` makes the url absolute. */
const ABSOLUTE_URL = /^([a-z][a-z\d+\-.]*:)?\/\//i;

/**
 * Whether a url already names its own origin, so no `baseURL` has to be applied to it.
 *
 * A relative url is the dangerous one: it is what a request looks like *before* the
 * instance's `baseURL` is applied, and two wrappers over different origins produce the
 * same relative url for two entirely different resources.
 */
export function isAbsoluteUrl(url: string): boolean {
  return ABSOLUTE_URL.test(url);
}

/**
 * Default cache key: method + resolved URL, plus a hash of the `varyHeaders` values.
 *
 * ```ts
 * defaultCacheKey(request, ['authorization']); // "get https://api.example.com/users?a3f9k"
 * ```
 *
 * The URL must be the *resolved* one (after `baseURL` and `query`/`params`), so one
 * endpoint occupies one entry regardless of how it was spelled at the call site — and so
 * two wrappers pointing at different origins can never share an entry. The adapter only
 * calls this once it knows the full URL (see `isAbsoluteUrl`).
 *
 * The hash is appended whenever `varyHeaders` is non-empty — including when every value is
 * absent — so keys stay stable across calls. Pass `varyHeaders: []` to get the bare
 * `"<method> <url>"` form.
 */
export function defaultCacheKey(
  method: string,
  url: string,
  headers: Headers,
  varyHeaders: readonly string[],
): string {
  const base = `${method.toLowerCase()} ${url}`;
  if (varyHeaders.length === 0) return base;

  // JSON, never a plain join: the encoding must stay *injective*, because a collision here
  // would replay one identity's payload to another. Joining with a space lets a value
  // containing the separator impersonate the boundary — `['x y', '']` and `['x', 'y']` are
  // two different identities, and only a length-delimited encoding (JSON being the simplest)
  // keeps them apart.
  const vary = JSON.stringify(varyHeaders.map((name) => headers.get(name) ?? ''));
  return `${base}?${fnv1a(vary)}`;
}
