/**
 * Types and small pure helpers for the opt-in indexed query API (0.5.0-beta.1).
 *
 * Query results are **metadata by default**. `includeValues: true` deliberately hands back
 * the cache's live, by-reference values — the same contract as `get()` — and is only legal
 * when both `maxEntries` and `maxValueBytes` caps are supplied. Devtools never exposes that
 * mode to a UI; it summarizes the metadata instead.
 */

/** Metadata for one matching entry. Values are never included unless explicitly requested. */
export interface EntrySummary {
  key: string;
  /** Remaining TTL in ms, or `null` for a permanent entry. */
  ttlMs: number | null;
  tags: string[];
  /** Approximate byte size when known; `0` for opaque externrefs without a size hint. */
  size?: number;
}

/** A result row with a live, by-reference value. */
export interface QueryValueRow<V> extends EntrySummary {
  value: V;
}

/** Tag constraints; all three lists are ANDed with the other filters. */
export interface QueryTagFilter {
  /** Keep keys carrying at least one of these tags. */
  any?: readonly string[];
  /** Keep keys carrying every one of these tags. */
  all?: readonly string[];
  /** Drop keys carrying any of these tags. */
  none?: readonly string[];
}

/**
 * Remaining-TTL window in milliseconds. Note this is the *expiry* filter — not the `ttlMs`
 * write stamp and not `cache.ttl(key)`. A lower bound alone includes permanent entries
 * (infinite TTL); an upper bound excludes them.
 */
export interface QueryTtlRange {
  min?: number;
  max?: number;
}

/** A bounded query. `limit` is required so no call can accidentally scan the whole cache. */
export interface QueryOptions {
  prefix?: string;
  tags?: QueryTagFilter;
  ttlRange?: QueryTtlRange;
  /** Optional allow-list: only these keys are considered. */
  keys?: readonly string[];
  /** Required page size (positive integer). */
  limit: number;
  /** Opaque last-key anchor from a previous page; survives deletion of the anchor key. */
  cursor?: string;
  /** Return live values. Requires `maxEntries` **and** `maxValueBytes`. Default `false`. */
  includeValues?: boolean;
  /** Hard cap on returned rows even when `limit` is larger. */
  maxEntries?: number;
  /** Hard cap on the estimated bytes of returned values. */
  maxValueBytes?: number;
  /** Post-filter over already-narrowed summaries; requires `fullScan` and no other constraint. */
  where?: (summary: EntrySummary) => boolean;
  /** Explicit, opt-in O(n) scan. Never implied: without `indexes: true`, `query()` throws. */
  fullScan?: boolean;
  /** Count all matches (a separate full pass). */
  withTotal?: boolean;
}

/** One page of query results. */
export interface QueryResult<V = unknown> {
  items: Array<EntrySummary | QueryValueRow<V>>;
  /** Last key of this page when more matches follow; pass it back as `cursor`. */
  nextCursor: string | null;
  /** Present only when `withTotal` was requested. */
  total?: number;
  /**
   * `true` when `maxEntries`/`maxValueBytes` cut this page short — matches exist beyond
   * `items` that these caps prevented from being returned. Absent when the page is whole.
   * A consumer that needs every row must raise the caps; it can never be inferred from
   * `nextCursor` alone (a page can be both cap-truncated and last).
   */
  truncated?: boolean;
}

/** The key-only counterpart of {@link QueryResult}. */
export interface QueryKeysResult {
  keys: string[];
  nextCursor: string | null;
  total?: number;
}

/** The narrow shape devtools and other bounded consumers need from a cache. */
export interface QueryableCache<V = unknown> {
  query(filter: QueryOptions): QueryResult<V>;
  queryKeys(filter: QueryOptions): QueryKeysResult;
  count(filter?: Omit<QueryOptions, 'limit' | 'cursor'>): number;
}

/** Validates the shared query contract. Throws synchronously so callers can catch setup errors. */
export function assertQueryOptions(filter: QueryOptions): void {
  if (!Number.isInteger(filter.limit) || filter.limit < 1) {
    throw new RangeError('[blaze-cache] query() requires a positive integer `limit`.');
  }
  if (
    filter.maxEntries !== undefined &&
    (!Number.isInteger(filter.maxEntries) || filter.maxEntries < 1)
  ) {
    throw new RangeError(
      '[blaze-cache] `maxEntries` must be a positive integer when supplied (it bounds a page, so 0 would never make progress).',
    );
  }
  if (
    filter.maxValueBytes !== undefined &&
    (!Number.isFinite(filter.maxValueBytes) || filter.maxValueBytes < 0)
  ) {
    throw new RangeError('[blaze-cache] `maxValueBytes` must be a finite, non-negative number.');
  }
  if (filter.includeValues) {
    if (
      !Number.isFinite(filter.maxEntries) ||
      (filter.maxEntries as number) < 1 ||
      !Number.isFinite(filter.maxValueBytes) ||
      (filter.maxValueBytes as number) < 0
    ) {
      throw new TypeError(
        '[blaze-cache] includeValues: true requires finite `maxEntries` and `maxValueBytes` caps.',
      );
    }
  }
  if (filter.where && !filter.fullScan) {
    throw new TypeError(
      '[blaze-cache] `where` requires `fullScan: true` with no indexed constraint.',
    );
  }
  // `cursor` is deliberately absent: a full scan *can* resume from an anchor (it just
  // costs O(n) per page, which `fullScan: true` already declared). The constraints below
  // are the ones a full scan would silently *ignore* — those are what makes it a guard.
  if (filter.fullScan && hasIndexedConstraint({ ...filter, cursor: undefined })) {
    throw new TypeError(
      '[blaze-cache] `fullScan: true` cannot be combined with prefix/tags/ttlRange/keys.',
    );
  }
}

/** `true` when at least one index-backed constraint was supplied. */
export function hasIndexedConstraint(filter: QueryOptions): boolean {
  return (
    filter.prefix !== undefined ||
    filter.tags?.any !== undefined ||
    filter.tags?.all !== undefined ||
    filter.tags?.none !== undefined ||
    filter.ttlRange !== undefined ||
    filter.keys !== undefined ||
    filter.cursor !== undefined
  );
}

/** Walk ceiling for an object/array estimate — the value is a cheap hint, not an audit. */
const HARD_BYTE_CAP = 64 * 1024;

/**
 * Cheap, best-effort byte estimate used only for the `maxValueBytes` cap. JS object sizes
 * are not observable; opaque externrefs report `0` here (tiered mode will require an
 * explicit `sizeHint` for them). Never guesses at a cloned representation, and never
 * throws: every object walk is fenced so a hostile stored value cannot break `query()`.
 */
export function estimateValueBytes(value: unknown, depth = 0): number {
  if (depth > 4) return 0;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value === 'number') return 8;
  if (typeof value === 'boolean') return 4;
  if (typeof value === 'bigint') return 8;
  if (value === null || value === undefined) return 0;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return value.byteLength;
  }
  // Every object walk below is fenced: a stored Proxy with a throwing `ownKeys`/`get`
  // trap must not be able to throw out of `query()`. The estimate is best-effort by
  // contract, so an unmeasurable value simply counts as 0.
  if (Array.isArray(value)) {
    let bytes = 0;
    for (let i = 0; i < value.length && bytes < HARD_BYTE_CAP; i += 1) {
      let item: unknown;
      try {
        item = value[i];
      } catch {
        continue;
      }
      bytes += estimateValueBytes(item, depth + 1);
    }
    return bytes;
  }
  if (typeof value === 'object') {
    let keys: string[];
    try {
      keys = Object.keys(value as object);
    } catch {
      return 0;
    }
    let bytes = 0;
    for (const key of keys) {
      if (bytes > HARD_BYTE_CAP) break;
      let property: unknown;
      try {
        property = (value as Record<string, unknown>)[key];
      } catch {
        continue;
      }
      bytes += key.length * 2 + estimateValueBytes(property, depth + 1);
    }
    return bytes;
  }
  return 0;
}
