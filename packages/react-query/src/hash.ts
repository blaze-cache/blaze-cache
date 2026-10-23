import { hashKey } from '@tanstack/react-query';
import type { QueryKey } from '@tanstack/react-query';

/**
 * Canonical hash for a query key — the very hash TanStack Query stores in
 * `query.queryHash`.
 *
 * Delegating to TanStack's own `hashKey` rather than re-implementing it means the pre-fetch
 * lookup in {@link useBlazeQuery} can never drift from the key the sync layer writes, even
 * across library upgrades.
 *
 * ```ts
 * hashQueryKey(['todos', { page: 1, done: true }]);
 * // '["todos",{"done":true,"page":1}]' — object keys are sorted, so order never matters
 * ```
 */
export function hashQueryKey(queryKey: QueryKey): string {
  return hashKey(queryKey);
}
