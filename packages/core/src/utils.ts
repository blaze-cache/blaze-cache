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
      // Plain `sorted[key] = …` would *not* create an own property for a literal `__proto__`
      // key: the inherited setter would swap `sorted`'s prototype instead, dropping the key
      // from the output and mutating the fresh object we just allocated. `defineProperty`
      // always defines an own data property, so hostile keys serialise normally — and only
      // ever inside this throwaway `sorted`, never on `Object.prototype`.
      Object.defineProperty(sorted, key, {
        value: source[key],
        enumerable: true,
        writable: true,
        configurable: true,
      });
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
