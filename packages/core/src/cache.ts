import type {
  BlazeCacheLike,
  CacheChange,
  CacheEntry,
  CacheListener,
  CacheStats,
  SetOptions,
} from './types.js';
import { initBlazeWasm, WasmCache } from './wasm.js';
import type { WasmInitInput } from './wasm.js';
import { indexedDbPersistence } from './persistence/indexeddb.js';
import type { CachePersistence, IndexedDbOptions, PersistedRecord } from './persistence/types.js';

/** Entries held when `capacity` is not given. */
export const DEFAULT_CAPACITY = 500;
/** Milliseconds a write waits for more writes before hitting IndexedDB. */
export const DEFAULT_FLUSH_DELAY_MS = 400;
/** Upper bound on records written by a single flush. */
export const DEFAULT_MAX_RECORDS = 2000;
/**
 * Shared stand-in for "no tags" on the write path.
 *
 * The binding copies the array into wasm memory synchronously during the call and never
 * retains it, so one module-level array can serve every untagged write instead of allocating
 * a fresh `[]` per `set`. Never mutated.
 */
const NO_TAGS: string[] = [];

/** Options for a custom {@link CachePersistence} adapter. */
export interface CachePersistenceOptions {
  adapter: CachePersistence;
  /** Debounce applied to write-through flushes. Default {@link DEFAULT_FLUSH_DELAY_MS}. */
  flushDelayMs?: number;
  /** Maximum records persisted per flush (newest win). Default {@link DEFAULT_MAX_RECORDS}. */
  maxRecords?: number;
}

/** Options for the built-in IndexedDB adapter — settings plus flush tuning. */
export interface IndexedDbPersistenceOptions extends IndexedDbOptions {
  flushDelayMs?: number;
  maxRecords?: number;
}

/** Options accepted by {@link BlazeCache.create}. */
export interface BlazeCacheOptions {
  /** Maximum number of entries kept in memory (clamped to `>= 1`). Default {@link DEFAULT_CAPACITY}. */
  capacity?: number;
  /**
   * Durable storage. `false`/omitted means memory only.
   *
   * * `{ namespace, database, store, ... }` — the built-in IndexedDB adapter.
   * * `{ adapter, ... }` — any {@link CachePersistence} implementation.
   */
  persistence?: false | CachePersistenceOptions | IndexedDbPersistenceOptions;
  /**
   * How the `.wasm` binary is fetched and instantiated.
   *
   * Defaults to the binary shipped next to this package. Override it to serve the module
   * from a CDN, or to pass pre-read bytes (as the Node smoke tests do).
   */
  wasm?: WasmInitInput;
}

/**
 * The client-side cache: WebAssembly storage and eviction, optional write-through persistence.
 *
 * ```ts
 * import { createCache } from '@blaze-cache/core';
 *
 * const cache = await createCache({ capacity: 1000, persistence: { namespace: 'app' } });
 * cache.set('user:42', { name: 'Ada' }, { ttlMs: 30_000, tags: ['user:42'] });
 * cache.get('user:42');            // { name: 'Ada' } — counted as a hit
 * cache.invalidateTags('user:42'); // removes it and syncs IndexedDB
 * await cache.dispose();
 * ```
 *
 * All reads and writes are synchronous — the wasm module is instantiated during `create`, so
 * the hot path never touches a `Promise`.
 */
export class BlazeCache<V = any> implements BlazeCacheLike<V> {
  readonly #wasm: WasmCache;
  readonly #listeners = new Set<CacheListener>();
  readonly #unbind: Array<() => void> = [];
  #persist: CachePersistence | null = null;
  #flushDelayMs = DEFAULT_FLUSH_DELAY_MS;
  #maxRecords = DEFAULT_MAX_RECORDS;
  #dirty = new Set<string>();
  #deleted = new Set<string>();
  #clearAll = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #chain: Promise<void> = Promise.resolve();
  #disposed = false;

  private constructor(wasm: WasmCache) {
    this.#wasm = wasm;
  }

  /**
   * Loads the wasm module, builds the cache and — if requested — hydrates it from storage.
   *
   * Storage failures (blocked IndexedDB, quota, private mode) degrade to memory-only with a
   * console warning instead of rejecting.
   */
  static async create<V = any>(options: BlazeCacheOptions = {}): Promise<BlazeCache<V>> {
    await initBlazeWasm(options.wasm);
    const cache = new BlazeCache<V>(new WasmCache(options.capacity ?? DEFAULT_CAPACITY));
    await cache.#setupPersistence(options.persistence);
    return cache;
  }

  // ------------------------------------------------------------------ reads

  /** Value stored under `key`, or `undefined` when missing or expired. Counts a hit/miss. */
  get(key: string): V | undefined {
    return this.#wasm.get(key) as V | undefined;
  }

  /** `true` when `key` is present and not expired. Never changes eviction state. */
  has(key: string): boolean {
    return this.#wasm.has(key);
  }

  /** Live entry — value, remaining TTL and tags — without touching statistics. */
  entry(key: string): CacheEntry<V> | undefined {
    return this.#wasm.entry(key) as CacheEntry<V> | undefined;
  }

  /** Snapshot of every live entry, oldest first. */
  entries(): CacheEntry<V>[] {
    return this.#wasm.entries() as CacheEntry<V>[];
  }

  /** Live keys, oldest first. */
  keys(): string[] {
    return this.#wasm.keys();
  }

  /** Live keys carrying `tag`. */
  keysWithTag(tag: string): string[] {
    return this.#wasm.keysWithTag(tag);
  }

  /** Tags attached to `key` (empty when the key is unknown). */
  tagsOf(key: string): string[] {
    return this.#wasm.tagsOf(key);
  }

  /** `true` when `key` carries `tag`. */
  hasTag(key: string, tag: string): boolean {
    return this.#wasm.hasTag(key, tag);
  }

  /** Number of stored entries (may include not-yet-pruned expired ones). */
  get size(): number {
    return this.#wasm.size;
  }

  /** Maximum number of entries. */
  get capacity(): number {
    return this.#wasm.capacity;
  }

  /** Cumulative counters plus a computed `hitRate`. */
  stats(): CacheStats {
    const base = this.#wasm.stats() as Omit<CacheStats, 'hitRate'>;
    const total = base.hits + base.misses;
    return { ...base, hitRate: total === 0 ? 0 : base.hits / total };
  }

  // ----------------------------------------------------------------- writes

  /** Stores (or replaces) `key`. Replacing refreshes the TTL and replaces the tags. */
  set(key: string, value: V, options?: SetOptions): void {
    // No defensive copy of `tags`: the binding reads the array synchronously while building
    // the wasm call and never retains it, so the `readonly`→`string[]` cast below is safe.
    // Untagged writes share `NO_TAGS` (see its doc).
    this.#wasm.set(key, value, options?.ttlMs ?? null, (options?.tags ?? NO_TAGS) as string[]);
    if (this.#hasChangeConsumers) this.#notify({ type: 'set', key });
  }

  /** Removes `key`, returning whether it was there. */
  delete(key: string): boolean {
    const removed = this.#wasm.delete(key);
    if (removed && this.#hasChangeConsumers) this.#notify({ type: 'delete', key });
    return removed;
  }

  /** Removes every entry carrying any of `tags`, returning the removed keys. */
  invalidateTags(...tags: string[]): string[] {
    if (tags.length === 0) return [];
    const removed = this.#wasm.invalidateTags(tags);
    if (removed.length > 0 && this.#hasChangeConsumers) {
      this.#notify({ type: 'invalidate', keys: removed });
    }
    return removed;
  }

  /** Removes every expired entry, returning the removed keys. */
  prune(): string[] {
    const removed = this.#wasm.prune();
    if (removed.length > 0 && this.#hasChangeConsumers) {
      this.#notify({ type: 'prune', keys: removed });
    }
    return removed;
  }

  /** Empties the cache. */
  clear(): void {
    this.#wasm.clear();
    if (this.#hasChangeConsumers) this.#notify({ type: 'clear' });
  }

  /** Zeroes the cumulative counters without touching stored entries. */
  resetStats(): void {
    this.#wasm.resetStats();
  }

  // ------------------------------------------------------------- observers

  /**
   * Subscribes to mutations. Returns the unsubscribe function.
   *
   * Persistence uses this internally, so listeners fire for every change regardless of
   * whether storage is enabled.
   */
  on(listener: CacheListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Writes pending changes to storage immediately.
   *
   * Resolves once the underlying transaction commits. Concurrent calls are serialised, so
   * this is safe to call from a `beforeunload` handler while a debounced flush is pending.
   */
  flush(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    // Chain instead of guarding: a change landing *during* a flush starts a follow-up pass.
    this.#chain = this.#chain.then(
      () => this.#runFlush(),
      () => this.#runFlush(),
    );
    return this.#chain;
  }

  /**
   * Flushes, unbinds page-lifecycle listeners and frees the wasm memory.
   *
   * The cache is unusable afterwards. A failed flush still rejects — the caller may retry or
   * report it.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    await this.flush();
    this.#disposed = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    for (const unbind of this.#unbind.splice(0)) unbind();
    this.#listeners.clear();
    await this.#persist?.close?.();
    this.#persist = null;
    this.#wasm.free();
  }

  // ----------------------------------------------------------- persistence

  async #setupPersistence(spec: BlazeCacheOptions['persistence']): Promise<void> {
    if (!spec) return;

    let adapter: CachePersistence;
    let flushDelayMs: number | undefined;
    let maxRecords: number | undefined;
    if ('adapter' in spec) {
      adapter = spec.adapter;
      flushDelayMs = spec.flushDelayMs;
      maxRecords = spec.maxRecords;
    } else {
      adapter = indexedDbPersistence(spec);
      flushDelayMs = spec.flushDelayMs;
      maxRecords = spec.maxRecords;
    }

    this.#persist = adapter;
    this.#flushDelayMs = flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
    this.#maxRecords = maxRecords ?? DEFAULT_MAX_RECORDS;

    try {
      await this.#hydrate(adapter);
    } catch (error) {
      this.#persist = null;
      console.warn('[blaze-cache] persistence unavailable — running memory-only.', error);
      return;
    }
    this.#bindPageLifecycle();
  }

  /** Fills the cache from storage, dropping records whose TTL elapsed while we were away. */
  async #hydrate(adapter: CachePersistence): Promise<void> {
    const records = await adapter.load();
    const now = Date.now();
    for (const record of records) {
      const remaining = record.ttlMs === null ? null : record.ttlMs - (now - record.storedAt);
      if (remaining !== null && remaining <= 0) continue;
      // Direct wasm call: hydration is not a user write, so it emits no change event.
      this.#wasm.set(record.key, record.value, remaining, record.tags);
    }
  }

  #bindPageLifecycle(): void {
    if (typeof window === 'undefined') return;
    const flush = () => {
      void this.flush().catch((error: unknown) => {
        console.error('[blaze-cache] flush on page hide failed.', error);
      });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    this.#unbind.push(() => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    });
  }

  #scheduleFlush(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush().catch((error: unknown) => {
        console.error('[blaze-cache] background flush failed.', error);
      });
    }, this.#flushDelayMs);
  }

  async #runFlush(): Promise<void> {
    const persist = this.#persist;
    if (!persist || this.#disposed) return;

    // Take ownership of the pending work up front, so a `set` racing with the awaits below
    // lands in the *next* pass instead of being written twice.
    const clearAll = this.#clearAll;
    const deleted = [...this.#deleted];
    const dirty = [...this.#dirty].filter((key) => !this.#deleted.has(key));
    this.#clearAll = false;
    this.#dirty.clear();
    this.#deleted.clear();

    if (clearAll) await persist.clear();

    if (dirty.length > 0) {
      const records: PersistedRecord[] = [];
      for (const key of dirty.slice(-this.#maxRecords)) {
        const entry = this.#wasm.entry(key);
        if (!entry) continue;
        records.push({
          key,
          value: entry.value,
          tags: entry.tags,
          ttlMs: entry.ttlMs,
          storedAt: Date.now(),
        });
      }
      if (records.length > 0) await persist.save(records);
    }

    if (deleted.length > 0) await persist.remove(deleted);
  }

  /**
   * `true` when a change event would actually reach someone — persistence bookkeeping or at
   * least one listener.
   *
   * Lets the mutation paths skip building a {@link CacheChange} object altogether when
   * nothing consumes it (memory-only cache, no subscribers). Equivalent to the conditions
   * inside {@link BlazeCache.#notify}: after `dispose` the persistence adapter is `null`, so
   * the `!#disposed` check inside `#notify` cannot change the outcome here.
   */
  get #hasChangeConsumers(): boolean {
    return this.#listeners.size > 0 || this.#persist !== null;
  }

  #notify(change: CacheChange): void {
    if (this.#persist && !this.#disposed) {
      switch (change.type) {
        case 'set':
          this.#deleted.delete(change.key);
          this.#dirty.add(change.key);
          break;
        case 'delete':
          this.#dirty.delete(change.key);
          this.#deleted.add(change.key);
          break;
        case 'clear':
          this.#dirty.clear();
          this.#deleted.clear();
          this.#clearAll = true;
          break;
        case 'invalidate':
        case 'prune':
          for (const key of change.keys) {
            this.#dirty.delete(key);
            this.#deleted.add(key);
          }
          break;
      }
      this.#scheduleFlush();
    }
    for (const listener of this.#listeners) listener(change);
  }
}

/** Shorthand for {@link BlazeCache.create}. */
export function createCache<V = any>(options?: BlazeCacheOptions): Promise<BlazeCache<V>> {
  return BlazeCache.create<V>(options);
}
