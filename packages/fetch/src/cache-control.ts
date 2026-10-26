/**
 * What `Cache-Control` (and the related `Age`) say about a request or a response — plus the
 * one `Vary` question a keying client must answer before storing anything.
 *
 * Package-local on purpose: this wrapper needs the `stale-while-revalidate` directive, which
 * `@blaze-cache/axios` does not, and each package is free to grow its own directives without
 * dragging the others along.
 */

export interface CacheControl {
  /** `no-store` — neither read nor write the cache. */
  noStore: boolean;
  /** `no-cache` — must not be served without revalidating, per-field spellings (`no-cache="…"`) included. */
  noCache: boolean;
  /** `must-revalidate` (or the shared-cache spelling `proxy-revalidate`) — never serve a stale response. */
  mustRevalidate: boolean;
  /** `max-age=<seconds>`, converted to milliseconds. */
  maxAgeMs: number | undefined;
  /** `stale-while-revalidate=<seconds>`, converted to milliseconds. */
  staleWhileRevalidateMs: number | undefined;
}

/** The value used when parsing is switched off (`cacheControl: false`) or a header is absent. */
export const NO_DIRECTIVES: CacheControl = Object.freeze({
  noStore: false,
  noCache: false,
  mustRevalidate: false,
  maxAgeMs: undefined,
  staleWhileRevalidateMs: undefined,
});

/**
 * Minimal `Cache-Control` parser — only the directives a client-side cache acts on.
 *
 * ```ts
 * parseCacheControl('max-age=30, stale-while-revalidate=120').maxAgeMs; // 30_000
 * ```
 */
export function parseCacheControl(value: string | undefined | null): CacheControl {
  const result: CacheControl = {
    noStore: false,
    noCache: false,
    mustRevalidate: false,
    maxAgeMs: undefined,
    staleWhileRevalidateMs: undefined,
  };
  if (!value) return result;

  for (const rawDirective of value.split(',')) {
    const directive = rawDirective.trim().toLowerCase();
    if (directive === 'no-store') {
      result.noStore = true;
    } else if (directive === 'no-cache') {
      result.noCache = true;
    } else if (directive.startsWith('no-cache=')) {
      // `no-cache="set-cookie, field2"` — reuse is forbidden until *those fields* have been
      // revalidated, and this cache cannot revalidate individual fields, so it must read as
      // the whole-response spelling. Matching only the bare directive would silently turn
      // this opt-out back into "cacheable".
      result.noCache = true;
    } else if (directive === 'must-revalidate' || directive === 'proxy-revalidate') {
      // Two spellings of one rule — never serve a stale response. `proxy-revalidate` is the
      // shared-cache name; a browser cache ignoring it would be just as wrong.
      result.mustRevalidate = true;
    } else if (directive.startsWith('max-age=')) {
      result.maxAgeMs = seconds(directive.slice('max-age='.length));
    } else if (directive.startsWith('stale-while-revalidate=')) {
      result.staleWhileRevalidateMs = seconds(directive.slice('stale-while-revalidate='.length));
    }
  }
  return result;
}

/**
 * Whether a response carrying `Vary: <responseVary>` may be stored under a key that already
 * folds in `varyHeaders`.
 *
 * `Vary` names the *request* headers the response's identity depends on — `Cookie`,
 * `Accept-Language`, `Origin`. A cache may only replay a stored response to a request whose
 * keyed headers match, so a response varying on anything **not** folded into the key cannot
 * be keyed correctly, and the only safe verdict is "store nothing": storing anyway would
 * replay one caller's variant — another user's private payload, another locale's page — to
 * the next caller whose unkeyed header happens to differ. `Vary: *` advertises variants
 * that are unknowable by construction and is never cacheable (RFC 9111 §3).
 *
 * An absent, empty or unparsable header varies on nothing and is always storable; a listed
 * name that *is* folded in (case-insensitively, as header names are) makes the response
 * storable.
 */
export function varyIsStorable(responseVary: string | null, varyHeaders: readonly string[]): boolean {
  if (responseVary === null) return true;

  const names = responseVary
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
  if (names.length === 0) return true; // `Vary:` with no names varies on nothing
  if (names.includes('*')) return false; // RFC 9111 §3: never usable from a cache

  const keyed = new Set(varyHeaders.map((name) => name.toLowerCase()));
  return names.every((name) => keyed.has(name));
}

/**
 * `Age: <seconds>` — how long an intermediate cache has been holding the response.
 *
 * The freshness window shrinks by this much: a response that is already halfway to its
 * `max-age` deadline must not look brand new to us. Anything unparsable counts as zero.
 */
export function parseAgeMs(value: string | undefined | null): number {
  if (!value) return 0;
  const secondsValue = Number(value.trim());
  return Number.isFinite(secondsValue) && secondsValue >= 0 ? secondsValue * 1000 : 0;
}

/** Seconds → milliseconds, or `undefined` when the value is not a usable non-negative number. */
function seconds(raw: string): number | undefined {
  const value = Number(raw.trim());
  return Number.isFinite(value) && value >= 0 ? value * 1000 : undefined;
}
