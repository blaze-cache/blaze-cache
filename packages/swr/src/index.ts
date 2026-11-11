/**
 * SWR integration backed by Blaze Cache — stale-while-revalidate that survives a reload.
 *
 * Three entry points:
 *
 * * {@link useBlazeSWR} — `useSWR` that paints the persisted entry on the first render
 *   and writes successful fetches back, with `ttlMs`/`tags`/`forceRefresh` on top of
 *   normal SWR options.
 * * {@link blazeSWRMiddleware} — the same behaviour as a plain SWR middleware, for
 *   wiring into `SWRConfig` or an existing `useSWR` call.
 * * {@link invalidateBlazeSWR} — purge this package's entries by tag (without touching
 *   records another integration wrote under the same cache) and revalidate the hooks
 *   that showed them.
 *
 * {@link resolveBlazeKey} exposes the key an SWR `key` is filed under, for imperative
 * reads and writes (`cache.get(resolveBlazeKey(key))`).
 *
 * ```tsx
 * const cache = await createCache({ persistence: { namespace: 'app' } });
 *
 * function Todos() {
 *   const { data } = useBlazeSWR(cache, '/api/todos', (url) => fetch(url).then((r) => r.json()), {
 *     ttlMs: 5 * 60_000,
 *     tags: ['todos'],
 *   });
 *   // first render: the persisted todos, instantly — background revalidation included
 * }
 * ```
 *
 * @packageDocumentation
 */

export { blazeSWRMiddleware, DEFAULT_TAGS, DEFAULT_TTL_MS } from './middleware.js';
export { invalidateBlazeSWR } from './invalidate.js';
export { resolveBlazeKey } from './key.js';
export { isBlazeSWRRecord, readBlazeSWRRecord } from './record.js';
export { useBlazeSWR } from './useBlazeSWR.js';
export type {
  BlazeSWRCacheLike,
  BlazeSWRRecord,
  BlazeSWROptions,
  BlazeSWRMiddlewareOptions,
  BlazeSWRStampOptions,
  BlazeSWRTags,
  InvalidateBlazeSWROptions,
} from './types.js';
