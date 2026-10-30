import type { BlazeQueryRecord } from './types.js';

/**
 * Shape check: is this value a record **this package** could have written?
 *
 * Every record the sync layer and the imperative helpers write carries `dataUpdatedAt`,
 * TanStack's own timestamp — and nothing the *other* integrations store on a shared cache
 * does. Axios and fetch records are stamped `storedAt`/`freshUntil`, SWR persists raw
 * fetcher results, and manual entries are whatever the app put there.
 *
 * The check exists for the shared-cache reality a single-package type cannot see: it
 * keeps a mirror read from handing a foreign value to TanStack as query data, and the
 * unfiltered purge from reading foreign entries as its own. The one unavoidable false
 * positive is an app value that happens to carry a numeric `dataUpdatedAt`.
 */
export function isMirrorRecord(value: unknown): value is BlazeQueryRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { dataUpdatedAt?: unknown }).dataUpdatedAt === 'number'
  );
}
