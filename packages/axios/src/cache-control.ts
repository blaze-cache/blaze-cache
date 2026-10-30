/** What `Cache-Control` says about a request or a response. */
export interface CacheControl {
  /** `no-store` — neither read nor write the cache. */
  noStore: boolean;
  /** `no-cache` — must not be served without revalidating. */
  noCache: boolean;
  /** `max-age=<seconds>`, converted to milliseconds. */
  maxAgeMs: number | undefined;
}

/**
 * Minimal `Cache-Control` parser — only the directives a client-side cache must honour.
 *
 * ```ts
 * parseCacheControl('max-age=30, public').maxAgeMs; // 30_000
 * ```
 */
export function parseCacheControl(value: string | undefined | null): CacheControl {
  const result: CacheControl = { noStore: false, noCache: false, maxAgeMs: undefined };
  if (!value) return result;

  for (const rawDirective of value.split(',')) {
    const directive = rawDirective.trim().toLowerCase();
    if (directive === 'no-store') {
      result.noStore = true;
    } else if (directive === 'no-cache' || directive.startsWith('no-cache=')) {
      // `no-cache="field1"` restricts *what* must be revalidated — still "never serve
      // without revalidating", and this cache has no conditional requests, so it is as
      // uncacheable here as a bare `no-cache`.
      result.noCache = true;
    } else if (directive.startsWith('max-age=')) {
      const seconds = Number(directive.slice('max-age='.length));
      if (Number.isFinite(seconds) && seconds >= 0) {
        result.maxAgeMs = seconds * 1000;
      }
    }
  }
  return result;
}

/**
 * `Age: <seconds>` — how long an intermediate cache has already been holding the response.
 *
 * The freshness window shrinks by this much: a response replayed with `max-age=60, Age: 50`
 * has ten seconds of life left, not sixty — treating it as new quietly serves it past the
 * origin's deadline. Anything unparsable, negative or absent counts as zero: never invent
 * an age we cannot measure, and never subtract one we made up.
 *
 * Mirrors `@blaze-cache/fetch`'s `parseAgeMs` on purpose — the two wrappers must agree on
 * how old a shared response is.
 */
export function parseAgeMs(value: string | undefined | null): number {
  if (!value) return 0;
  const seconds = Number(value.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 0;
}

/**
 * Whether a response carrying this `Vary` may be stored under a key built from `varyHeaders`.
 *
 * `Vary: *` is never cacheable (RFC 9111 §3): the response depends on details no stored key
 * can capture, so there is nothing to key it *by*. For any other listed name the same rule
 * applies one header at a time — if the response varies on a header that `varyHeaders` does
 * not fold into the key, two requests differing *only* in that header collapse onto one
 * entry, and the first response is replayed to the other (the classic cross-user
 * `Cookie` / cross-locale `Accept-Language` poisoning).
 *
 * "Unknown ⇒ do not store" is the only safe answer, because the failure modes are
 * asymmetric: a skipped store costs one extra request; a wrong hit hands one caller another
 * caller's data. An absent (or empty) `Vary` varies on nothing and is storable.
 *
 * Names are compared case-insensitively — `Vary: Authorization` is the same header as the
 * configured `authorization`.
 */
export function varyIsStorable(
  responseVary: string | null | undefined,
  varyHeaders: readonly string[],
): boolean {
  if (!responseVary) return true;

  const listed = responseVary
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (listed.length === 0) return true; // `Vary:` with no names asks for nothing
  if (listed.includes('*')) return false; // never cacheable, per RFC 9111 §3

  const configured = new Set(varyHeaders.map((header) => header.trim().toLowerCase()));
  return listed.every((name) => configured.has(name));
}
