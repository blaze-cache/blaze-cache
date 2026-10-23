/**
 * `JSON.stringify` with **deterministic** key ordering.
 *
 * Two structurally equal objects always produce the same string, regardless of the order
 * their keys were inserted in — which is what makes it safe to use as a cache key for query
 * keys, request params, headers, …
 *
 * `Date` values go through `toJSON` before the replacer runs, so timestamps are preserved.
 * Circular structures throw, exactly like `JSON.stringify`.
 *
 * @example
 * ```ts
 * stableStringify({ b: 1, a: 2 }) === stableStringify({ a: 2, b: 1 }); // true
 * ```
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';

  const json = JSON.stringify(value, (_key, raw: unknown) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const source = raw as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = source[key];
    }
    return sorted;
  });

  // `JSON.stringify` only returns undefined for a top-level `undefined`, handled above;
  // this keeps the function total in the type system's eyes.
  return json ?? 'null';
}

/**
 * {@link stableStringify} that never throws.
 *
 * Used on hot paths (HTTP cache keys) where a `TypeError` from a circular structure must
 * degrade into "skip the cache", never into a failed request.
 *
 * @returns the canonical string, or `undefined` when `value` cannot be serialised.
 */
export function safeStableStringify(value: unknown): string | undefined {
  try {
    return stableStringify(value);
  } catch {
    return undefined;
  }
}
