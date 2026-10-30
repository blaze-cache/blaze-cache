import { unstable_serialize } from 'swr';
import type { Key } from 'swr';

/**
 * The key an SWR `key` is filed under in the Blaze Cache — SWR's **own** serialization
 * (`unstable_serialize`), so an entry always lines up with the key SWR uses for its
 * in-memory cache, and imperative reads/writes (`cache.set(resolveBlazeKey(key), …)`)
 * address exactly what the middleware writes.
 *
 * Delegating to SWR rather than re-implementing the hashing means the lookup cannot
 * drift from the key the middleware writes, even across library upgrades: plain strings
 * stay themselves, array/object keys go through SWR's stable hash (object key order
 * never matters), and lazy `() => key` functions are resolved the way SWR resolves them.
 *
 * Returns `null` for every key SWR itself treats as paused — `null`, `undefined`,
 * `false`, `''`, an empty array, or a lazy key that throws or returns nothing — so a
 * disabled hook never touches the Blaze Cache in either direction.
 *
 * ```ts
 * resolveBlazeKey('/api/todos');            // '/api/todos'
 * resolveBlazeKey(['todos', { page: 1 }]);  // SWR's stable hash of the array
 * resolveBlazeKey(() => null);              // null — paused, nothing to read or write
 * ```
 */
export function resolveBlazeKey(key: Key): string | null {
  const serialized = unstable_serialize(key);
  return serialized === '' ? null : serialized;
}
