import type { InternalAxiosRequestConfig } from 'axios';
import { readHeader } from './headers.js';

/**
 * FNV-1a, 32-bit.
 *
 * Folds sensitive material (bearer tokens, query parameters) into a short, stable token. It
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

/** axios' own `isAbsoluteURL` test — a scheme or `//` makes the url absolute, ignoring `baseURL`. */
const ABSOLUTE_URL = /^([a-z][a-z\d+\-.]*:)?\/\//i;

/**
 * The URL axios will actually request — this is the endpoint identity of the key.
 *
 * The historical `baseURL + url` concatenation was wrong twice over. It never matched
 * axios' `buildFullPath`: `…/v1/` + `/users` keyed `…/v1//users`, a string no adapter ever
 * requests — and a *different* key than `…/v1` + `/users`, which requests the very same
 * resource, so one endpoint occupied two entries. Worse, the concatenation collides across
 * endpoints: `…/v1` + `s/users` and `…/v` + `1s/users` produce one identical key for two
 * different resources — a cross-endpoint replay.
 *
 * So the join mirrors `buildFullPath`/`combineURLs`: an already-absolute url ignores the
 * base, and trailing slashes on the base plus leading slashes on the url collapse into
 * exactly one `/`. The result is then canonicalised through `new URL` whenever it can be
 * made absolute (host case, dot-segments, encoding). A candidate that is not absolute-able
 * — a relative url with no base, a relative `baseURL` — falls back to that plain join,
 * which is still precisely the string axios would request; only the no-base case reduces
 * to the raw url itself.
 */
export function resolveRequestUrl(config: InternalAxiosRequestConfig): string {
  const baseURL = config.baseURL;
  const url = config.url ?? '';
  const joined =
    baseURL && !ABSOLUTE_URL.test(url)
      ? url
        ? `${baseURL.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`
        : baseURL
      : url;

  try {
    return new URL(joined).href;
  } catch {
    return joined;
  }
}

/**
 * `safeStableStringify` from `@blaze-cache/core`, re-implemented for one reason: sorted keys
 * are copied with `defineProperty` instead of plain assignment.
 *
 * On a literal `{}`, `sorted[key] = value` with `key === '__proto__'` walks into
 * `Object.prototype.__proto__`'s accessor instead of creating a property — the key silently
 * vanishes, and `params: { ['__proto__']: … }` would hash to the same entry as `params: {}`,
 * replaying one query's response for the other. `defineProperty` defines an own key on the
 * fresh `sorted` object and touches nothing else, so no prototype — least of all a global
 * one — is polluted. Everything else mirrors the core original: canonical key order, values
 * through `toJSON`, circular structures still throw, and a throw still degrades into
 * "no params in the key" instead of a failed request.
 */
/**
 * A canonical stand-in for a container `JSON.stringify` cannot see into — or `undefined`
 * when `value` is not one of them.
 *
 * `URLSearchParams`, `FormData` and `Map` carry their entries in internal slots, not own
 * enumerable properties: `JSON.stringify` renders each of them as `'{}'`. Keying on that
 * result collided every pair of requests that used them — `params: new URLSearchParams('q=a')`
 * and `params: new URLSearchParams('q=b')` hashed to one key and replayed one response for
 * the other. Each container is therefore flattened into a stable string describing its
 * actual contents.
 */
function canonicalContainer(value: unknown): string | undefined {
  if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) {
    // Order-preserving: axios sends `.toString()` verbatim, so two differently-ordered
    // search strings are genuinely different requests on the wire and must key apart.
    return `URLSearchParams(${value.toString()})`;
  }
  if (typeof FormData !== 'undefined' && value instanceof FormData) {
    // Multipart part order carries no semantics, so entries are sorted — same fields in a
    // different order are the same request. Files are described by identity attributes;
    // their bytes are not read (they may be huge or not yet loaded).
    const parts: string[] = [];
    for (const [key, item] of value.entries()) {
      parts.push(
        typeof item === 'string'
          ? `${JSON.stringify(key)}=${JSON.stringify(item)}`
          : `${JSON.stringify(key)}#file(${item.name},${item.size},${item.type})`,
      );
    }
    return `FormData(${parts.sort().join('&')})`;
  }
  if (typeof Map !== 'undefined' && value instanceof Map) {
    // Like a plain-object literal: sorted keys, values recursively canonicalised.
    const entries = [...value.entries()]
      .map(
        ([key, item]) =>
          [typeof key === 'string' ? JSON.stringify(key) : (stringifyParams(key) ?? 'null'), item] as const,
      )
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return `Map({${entries.map(([key, item]) => `${key}:${stringifyParams(item) ?? 'null'}`).join(',')}})`;
  }
  return undefined;
}

function stringifyParams(value: unknown): string | undefined {
  if (value === undefined) return 'undefined';

  try {
    const json = JSON.stringify(value, (_key, raw: unknown) => {
      const container = canonicalContainer(raw);
      if (container !== undefined) return container;
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
      const source = raw as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) {
        Object.defineProperty(sorted, key, {
          value: source[key],
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return sorted;
    });
    return json ?? 'null';
  } catch {
    return undefined;
  }
}

/** Default cache key: method + URL, plus a hash of the params and the `vary` headers. */
export function defaultCacheKey(
  config: InternalAxiosRequestConfig,
  varyHeaders: readonly string[],
): string {
  const method = (config.method ?? 'get').toLowerCase();
  const url = resolveRequestUrl(config);

  // `params` is stringified canonically, so `?a=1&b=2` and `?b=2&a=1` share one key.
  const params = stringifyParams(config.params) ?? 'undefined';

  // JSON-quoted, never `' '`-joined: a space join would let `[a='x', b='y z']` and
  // `[a='x y', b='z']` hash alike although they describe different requests.
  const vary = JSON.stringify(
    varyHeaders.map((header) => readHeader(config.headers, header) ?? ''),
  );

  return `${method} ${url}?${fnv1a(`${params} ${vary}`)}`;
}
