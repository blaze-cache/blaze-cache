import { mutate as globalMutate } from 'swr';

import { isBlazeSWRRecord } from './record.js';
import type { BlazeSWRCacheLike, InvalidateBlazeSWROptions } from './types.js';

/**
 * Every live entry, or a refusal: enumerating is how this purge stays scoped to *this
 * package's* records, so a cache that cannot enumerate gets an error instead of a
 * silently partial purge — the mirror-side helpers refuse the same way.
 */
function entriesOf(
  cache: BlazeSWRCacheLike,
): Iterable<{ key: string; value: unknown; ttlMs: number | null; tags: string[] }> {
  if (typeof cache.entries !== 'function') {
    throw new Error(
      '[blaze-cache/swr] `invalidateBlazeSWR` selects this package’s records from every ' +
        'persisted entry, but the cache does not implement `entries()`. Refusing to run a ' +
        'deliberately partial purge — use the concrete `BlazeCache` from ' +
        '`@blaze-cache/core`.',
    );
  }
  return cache.entries();
}

/**
 * Purges this package's persisted entries by tag — and nothing else — then tells SWR.
 *
 * ```ts
 * await invalidateBlazeSWR(cache, 'user');           // every entry tagged 'user'
 * await invalidateBlazeSWR(cache, 'user', 'todos');  // either tag
 * await invalidateBlazeSWR(cache);                   // every entry this package wrote
 * ```
 *
 * Scoped the way the react-query integration scopes its mirror purge: every candidate is
 * checked for *this package's* `{ kind: 'swr' }` envelope before it is touched, so on a
 * cache shared with axios/fetch/react-query an entry another integration wrote — even
 * one wearing the same tag — survives. (`cache.invalidateTags(...)` is the global
 * equivalent: it reaches the whole tag namespace, all integrations included.)
 *
 * SWR's own view stays coherent: each purged key is handed to `mutate`, which
 * revalidates its mounted hooks instead of letting them keep data the cache no longer
 * holds. Unmounted hooks need nothing — their next mount hydrates from the now-empty
 * key and fetches as usual.
 *
 * @param cache   The Blaze Cache (or anything {@link BlazeSWRCacheLike}-shaped with `entries()`).
 * @param tags    Tags to purge; none given purges every entry this package wrote.
 * @param options `mutate` — how to reach SWR; defaults to `swr`'s global mutator (pass
 *                `useSWRConfig().mutate` for hooks under a custom provider).
 * @returns The purged keys, in enumeration order.
 * @throws When the cache cannot be enumerated (`entries()`) or cannot delete — a partial
 *         purge on a shared cache is exactly the accident this helper exists to prevent.
 */
export function invalidateBlazeSWR(cache: BlazeSWRCacheLike, ...tags: string[]): Promise<string[]>;
export function invalidateBlazeSWR(
  cache: BlazeSWRCacheLike,
  ...args: [...tags: string[], options: InvalidateBlazeSWROptions]
): Promise<string[]>;
export async function invalidateBlazeSWR(
  cache: BlazeSWRCacheLike,
  ...args: Array<string | InvalidateBlazeSWROptions>
): Promise<string[]> {
  // A trailing object is the options bag; everything before it — or everything, when
  // there is none — is a tag.
  const last = args[args.length - 1];
  const options = last !== null && typeof last === 'object' ? last : undefined;
  const tags = (options === undefined ? args : args.slice(0, -1)) as string[];

  // Shape-gated selection: only this package's envelope, only under a requested tag (or
  // every envelope when no tag is given) — foreign records sharing the cache survive.
  const removed: string[] = [];
  for (const entry of entriesOf(cache)) {
    if (!isBlazeSWRRecord(entry.value)) continue;
    if (tags.length > 0 && !entry.tags.some((tag) => tags.includes(tag))) continue;
    removed.push(entry.key);
  }

  if (removed.length > 0) {
    // Called through the cache, never detached — `BlazeCache.delete` touches private
    // state, so a borrowed method would lose its receiver.
    if (typeof cache.delete !== 'function') {
      throw new Error(
        '[blaze-cache/swr] `invalidateBlazeSWR` found entries to purge, but the cache ' +
          'does not implement `delete()`. Nothing was removed — use the concrete ' +
          '`BlazeCache` from `@blaze-cache/core`.',
      );
    }
    for (const key of removed) cache.delete(key);
  }

  // Revalidate what was just purged: `mutate(key)` with no data only triggers
  // revalidation (it never clears state), and with no mounted hook it is a no-op.
  const notify = options?.mutate ?? globalMutate;
  await Promise.all(removed.map((key) => notify(key)));

  return removed;
}
