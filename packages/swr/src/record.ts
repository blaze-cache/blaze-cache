import type { BlazeSWRCacheLike, BlazeSWRRecord } from './types.js';

/**
 * Reads `key` and returns the record's data **only when the value is one this package
 * wrote** — the hydration gate.
 *
 * Every write from {@link blazeSWRMiddleware} carries the `{ kind: 'swr' }` envelope, so
 * a value without it belongs to something else sharing the cache: an axios/fetch response
 * record, a react-query mirror record, a manual `cache.set` of the app's own. On a
 * single-integration cache every value passes; the check exists for the shared one, where
 * seeding a foreign shape would hand an HTTP body (or a whole response record) to a
 * component as `data`.
 *
 * Read with `peek` when the cache has one — a render must not move the hit rate or nudge
 * eviction — falling back to `get` for caches that predate it.
 */
export function readBlazeSWRRecord<Data = unknown>(
  cache: BlazeSWRCacheLike,
  key: string,
): Data | undefined {
  const value = cache.peek ? cache.peek(key) : cache.get(key);
  return isBlazeSWRRecord<Data>(value) ? value.data : undefined;
}

/** True when `value` is the envelope this package writes. */
export function isBlazeSWRRecord<T = unknown>(value: unknown): value is BlazeSWRRecord<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'swr' &&
    typeof (value as { storedAt?: unknown }).storedAt === 'number'
  );
}
