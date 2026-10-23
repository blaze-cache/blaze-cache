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
    } else if (directive === 'no-cache') {
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
