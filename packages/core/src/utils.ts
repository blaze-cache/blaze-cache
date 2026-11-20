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

// FNV-1a's 128-bit parameters. The 32-bit variant used to build HTTP cache keys had a
// ~2^16 birthday bound, which let two different `Authorization` values land on one key —
// i.e. one identity received another's cached response. 128 bits push the birthday bound
// to 2^64, which is not reachable, while keeping the function synchronous and dependency-
// free (Web Crypto's SHA-256 is Promise-based and would make every key call async).
const FNV128_OFFSET = 0x6c62272e07bb014262b821756295c58dn;
const FNV128_PRIME = 0x0000000001000000000000000000013bn;
const FNV128_MASK = (1n << 128n) - 1n;

/**
 * Collision-resistant 128-bit hash for cache keys.
 *
 * Use this — **not** the adapters' deprecated `fnv1a` — whenever a value that separates
 * identities (a `vary` header, a request body, a session token) is folded into a cache key.
 * The output is a fixed 32-character lowercase hex string, so keys are stable across page
 * loads and can be persisted. BigInt keeps the whole computation in one accumulator; the
 * cost is ~10 µs for a 200-character input, paid once per request rather than per lookup.
 *
 * FNV-1a is not a cryptographic MAC: it is unkeyed and its structure is public. That is
 * fine here because collision resistance comes from the 128-bit output (birthday bound
 * 2^64), and inverting a multiply step yields a 128-bit value that cannot be forced back
 * into the 16-bit code units the input is built from. Do not use it for password storage,
 * signatures, or anywhere an adversary needs preimage resistance against a *known* target.
 */
export function cacheKeyHash(input: string): string {
  let hash = FNV128_OFFSET;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV128_PRIME) & FNV128_MASK;
  }
  return hash.toString(16).padStart(32, '0');
}
