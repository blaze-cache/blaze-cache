import type { BlazeFetchEffectiveInit } from './types.js';

/**
 * FNV-1a, 32-bit.
 *
 * Folds sensitive material (bearer tokens, `vary` headers) into a short, stable token. It
 * is not a security primitive — the point is that a persisted cache key never contains a
 * secret in readable form.
 */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** Whether a request actually carries a body — `null`/`undefined` mean it does not. */
export function hasRequestBody(body: unknown): boolean {
  return body !== undefined && body !== null;
}

/**
 * The request body as a stable, injective string for the cache key — or `undefined` when
 * the body **cannot** be encoded and the request must therefore stay uncached.
 *
 * A body that reaches the key wrong is worse than no cached body at all: two different
 * payloads would hash onto one entry and the first response would be replayed for the
 * second. So anything whose content this function cannot actually read is refused rather
 * than approximated:
 *
 * * a stream, a `Blob`/`File` or raw bytes have no readable own properties — the canonical
 *   serialisation renders each as the bare `'{}'`, which would collapse *every* such body
 *   onto *one* key;
 * * an object that serialises to `'{}'` for any other reason (a class instance keeping its
 *   data in private fields, an empty object) carries nothing to tell bodies apart by;
 * * a circular structure throws out of `JSON.stringify`.
 *
 * Key order is left as the caller wrote it. Two structurally equal bodies spelled in a
 * different order then produce different keys — which costs a cache miss and nothing
 * worse, because the error points at "did not reuse" rather than "reused the wrong
 * response". Sorting instead would mean copying caller data into a fresh object, which is
 * where `__proto__` handling goes wrong.
 */
export function encodeRequestBody(body: unknown): string | undefined {
  if (!hasRequestBody(body)) return '';

  if (typeof body === 'string') return JSON.stringify(body);
  if (typeof body === 'number' || typeof body === 'boolean' || typeof body === 'bigint') {
    return String(body);
  }
  if (typeof body !== 'object') return undefined; // function, symbol, ...

  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    // Order-preserving: the search string goes on the wire verbatim, so two differently
    // ordered ones are genuinely different requests.
    return `URLSearchParams(${body.toString()})`;
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    // Multipart part order carries no semantics, so entries are sorted — same fields in a
    // different order are the same request. Files are described by identity attributes;
    // their bytes are not read (they may be huge or not yet loaded).
    const parts: string[] = [];
    for (const [key, item] of body.entries()) {
      parts.push(
        typeof item === 'string'
          ? `${JSON.stringify(key)}=${JSON.stringify(item)}`
          : `${JSON.stringify(key)}#file(${item.name},${item.size},${item.type})`,
      );
    }
    return `FormData(${parts.sort().join('&')})`;
  }
  // Raw bytes: refused rather than hashed, because a 32-bit digest over caller-supplied
  // bytes is a collision surface this key does not need to open.
  if (typeof ArrayBuffer !== 'undefined' && (body instanceof ArrayBuffer || ArrayBuffer.isView(body))) {
    return undefined;
  }

  let json: string | undefined;
  try {
    json = JSON.stringify(body);
  } catch {
    return undefined; // circular
  }
  if (json === undefined) return undefined;
  if (json === '{}') return undefined; // no enumerable content — see the doc comment above
  return json;
}

/**
 * Separator between the two hashed key components: a raw NUL, which `JSON.stringify` never
 * emits unescaped (it writes a six-character escape instead), so no `vary` value or body
 * can be crafted to straddle the boundary and impersonate the other component.
 */
const COMPONENT_SEPARATOR = String.fromCharCode(0);

/**
 * Default cache key: method + resolved URL, plus a hash of the `varyHeaders` values and of
 * the request body.
 *
 * ```ts
 * defaultCacheKey('/api/users', init, ['authorization']); // "get /api/users?a3f9k"
 * ```
 *
 * The hash is appended whenever `varyHeaders` is non-empty — including when every value is
 * absent — so keys stay stable across calls. Pass `varyHeaders: []` to get the bare
 * `"<method> <url>"` form. Call it from the {@link BlazeFetchOptions.key} callback with
 * the `init` you were handed.
 *
 * A request that carries a body folds that body into the hash, so a `POST` with two
 * different payloads occupies two entries instead of replaying one for the other.
 *
 * @throws when a body is present but {@link encodeRequestBody} cannot read it — callers
 * that must not throw should check first and skip caching instead.
 */
export function defaultCacheKey(
  url: string,
  init: BlazeFetchEffectiveInit,
  varyHeaders: readonly string[],
): string {
  const base = `${init.method.toLowerCase()} ${url}`;

  const carriesBody = hasRequestBody(init.body);
  const encodedBody = carriesBody ? encodeRequestBody(init.body) : undefined;
  if (carriesBody && encodedBody === undefined) {
    throw new Error('[blaze-cache] this request body cannot be encoded into a cache key');
  }

  if (varyHeaders.length === 0 && encodedBody === undefined) return base;

  const headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
  // JSON, never a plain join: the encoding must stay *injective*, because a collision here
  // would replay one identity's payload to another. Joining with a space lets a value
  // containing the separator impersonate the boundary — `['x y', '']` and `['x', 'y']` are
  // two different identities, and only a length-delimited encoding (JSON being the simplest)
  // keeps them apart.
  const vary =
    varyHeaders.length === 0 ? '' : JSON.stringify(varyHeaders.map((name) => headers.get(name) ?? ''));

  const payload = encodedBody === undefined ? vary : `${vary}${COMPONENT_SEPARATOR}${encodedBody}`;
  return `${base}?${fnv1a(payload)}`;
}
