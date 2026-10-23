/**
 * A row as written to durable storage.
 *
 * TTLs are stored **relative** (`ttlMs` left at write time) together with `storedAt`, so
 * restoring never depends on the two machines' clocks being in sync — only on elapsed time.
 */
export interface PersistedRecord<V = unknown> {
  key: string;
  value: V;
  tags: string[];
  /** TTL that was left when the record was written; `null` means "never expires". */
  ttlMs: number | null;
  /** `Date.now()` at the moment the record was written. */
  storedAt: number;
}

/**
 * Pluggable storage backend used for write-through persistence.
 *
 * {@link indexedDbPersistence} ships with the package, but the interface is deliberately
 * tiny: a `localStorage` adapter is ~40 lines.
 */
export interface CachePersistence {
  /** Reads every record for this cache's namespace. Called once, during startup. */
  load(): Promise<PersistedRecord[]>;
  /** Upserts records. Called on each (debounced) flush. */
  save(records: PersistedRecord[]): Promise<void>;
  /** Deletes records by key. */
  remove(keys: string[]): Promise<void>;
  /** Deletes every record belonging to this cache (other namespaces are left alone). */
  clear(): Promise<void>;
  /** Releases any underlying handle. */
  close?(): void | Promise<void>;
}

/** IndexedDB connection settings. */
export interface IndexedDbOptions {
  /** Database name. Default `'blaze-cache'`. */
  database?: string;
  /** Object store name. Default `'entries'`. */
  store?: string;
  /**
   * Key prefix isolating this cache from other caches in the same store.
   * Default `'default'`.
   */
  namespace?: string;
}
