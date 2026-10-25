/**
 * What `Cache-Control` (and the related `Age`) say about a request or a response.
 *
 * Package-local on purpose: this wrapper needs the `stale-while-revalidate` directive, which
 * `@blaze-cache/axios` does not, and each package is free to grow its own directives without
 * dragging the others along.
 */

export interface CacheControl {
  /** `no-store` — neither read nor write the cache. */
  noStore: boolean;
  /** `no-cache` — must not be served without revalidating. */
  noCache: boolean;
  /** `max-age=<seconds>`, converted to milliseconds. */
  maxAgeMs: number | undefined;
  /** `stale-while-revalidate=<seconds>`, converted to milliseconds. */
  staleWhileRevalidateMs: number | undefined;
}

/** The value used when parsing is switched off (`cacheControl: false`) or a header is absent. */
export const NO_DIRECTIVES: CacheControl = Object.freeze({
  noStore: false,
  noCache: false,
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
    } else if (directive.startsWith('max-age=')) {
      result.maxAgeMs = seconds(directive.slice('max-age='.length));
    } else if (directive.startsWith('stale-while-revalidate=')) {
      result.staleWhileRevalidateMs = seconds(directive.slice('stale-while-revalidate='.length));
    }
  }
  return result;
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
