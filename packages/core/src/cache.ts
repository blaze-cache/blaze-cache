import type {
  BlazeCacheLike,
  CacheChange,
  CacheEntry,
  CacheEvent,
  CacheEventListener,
  CacheEventType,
  CacheListener,
  CacheStats,
  SetManyEntry,
  SetOptions,
  TouchOptions,
} from './types.js';
import { CacheEventBus } from './events.js';
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
  /**
   * Maximum number of entries kept in memory. The wasm binding normalises it before it is
   * ever used: below `1` clamps up, above `1_000_000` clamps down, and a non-finite value
   * (`NaN`, `Infinity`) falls back to the wasm default of 1024. Pass a value inside that
   * range to be sure of what {@link BlazeCache.capacity} reports back.
   *
   * Default {@link DEFAULT_CAPACITY}.
   */
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
 * cache.peek('user:42');           // the same value, no hit recorded
 * cache.ttl('user:42');            // ~30000 — ms until it expires
 * cache.touch('user:42', { ttlMs: 60_000 }); // renew the deadline, keep the value
 * cache.invalidateTags('user:42'); // removes it and syncs IndexedDB
 * await cache.dispose();
 * ```
 *
 * ### Value ownership
 *
 * Values are held — and handed back — **by reference**. The object you pass to
 * {@link BlazeCache.set} is the very object {@link BlazeCache.get}, {@link BlazeCache.peek},
 * {@link BlazeCache.entry} and {@link BlazeCache.entries} return later: mutating either one
 * silently rewrites the cache — and, after the next flush, the persisted row — with no error
 * and no warning. Treat values living in the cache as read-only: clone on the way *out*
 * (`structuredClone(cache.get(key))`) before editing, or clone on the way *in* if you want
 * to keep mutating your own copy. The sharing is deliberate, not an oversight — the Rust
 * core promises allocation-free `get`/`set` precisely *because* values are never cloned or
 * serialised on the hot path, and cloning on read would only close one half of the alias
 * anyway (your original reference from `set` survives either way). The contract is
 * ownership transfer, not deep-copy semantics.
 *
 * ### Events
 *
 * {@link BlazeCache.on} subscribes to one {@link CacheEventType} — `on('set', listener)` —
 * or, without a type, to **every** event; `once` fires a single time, `off` removes
 * listeners without a subscription handle, and every `on`/`once` call returns its own
 * unsubscribe function.
 *
 * Eight event types are raised here in TypeScript, describing the operation you just made.
 * `evict` and `expire` are the exception: capacity sweeps and TTL reclamation happen
 * *inside* the Rust core — mid-`set`, or lazily during a `get` — where no JavaScript
 * exists to observe them. For those the core keeps an opt-in **drop log**. The first
 * listener interested in `evict`/`expire` (a typed one, or any wildcard) switches the log
 * on through the wasm binding, and after every operation that can reclaim memory (`get`,
 * `getMany`, `set`, `setMany`) this class drains it and emits one event per dropped entry:
 * `{ type: 'evict' | 'expire', key, value }`, with `value` coming back as the cache's live
 * reference — exactly what you would have got from `get` one moment earlier. While no such
 * listener exists the log stays off and the hot path pays a single predictable branch at
 * the moment an entry dies — never per read or write.
 *
 * ```ts
 * const offEvict = cache.on('evict', ({ key, value }) => {
 *   console.log('the cache dropped', key, value);
 * });
 *
 * const offAll = cache.on((event) => {          // wildcard — every event type
 *   if (event.type === 'hit') console.log('hit', event.key);
 * });
 *
 * cache.once('clear', () => console.log('first clear, only once'));
 *
 * offEvict();                                   // unsubscribe one handle
 * cache.off('evict');                           // …or drop every `evict` listener
 * cache.off();                                  // …or every listener, period
 * ```
 *
 * Wildcard listeners receive the full {@link CacheEvent} union, so narrow on
 * `event.type` before reading fields. A listener that throws is isolated: the failure is
 * logged with `console.error`, the mutation it was told about stands, and the remaining
 * listeners still run. Listeners run synchronously, in registration order per type (typed
 * listeners first, wildcards last) — an event is never delivered to a listener that
 * unsubscribed before its turn.
 *
 * Code written against the original `on(listener)` API keeps working: that form *is* the
 * wildcard now, so such listeners additionally see `hit`/`miss`/`evict`/`expire`.
 *
 * ### Multiple tabs
 *
 * Tabs share one IndexedDB namespace but nothing else: each one holds its own WebAssembly
 * instance, hydrated once at startup, and each flushes the keys it wrote. There is no
 * coordination between them — writes are last-writer-wins per key. For ordinary use that is
 * what you want (the tab in the foreground refetches on focus and rewrites its own fresh
 * copy), but a tab that keeps working while hidden — a timer, a background sync — can flush
 * a value older than the one the focused tab just wrote, and after a reload that older
 * value is what hydration paints until revalidation corrects it. If that matters, use a
 * short `ttlMs` on records written from background tabs, or filter on a timestamp you store
 * inside the value itself.
 *
 * All reads and writes are synchronous — the wasm module is instantiated during `create`, so
 * the hot path never touches a `Promise`.
 */
export class BlazeCache<V = any> implements BlazeCacheLike<V> {
  readonly #wasm: WasmCache;
  readonly #events = new CacheEventBus<V>(() => this.#syncDropTracking());
  /**
   * Mirrors {@link CacheEventBus.wantsDrops} onto the wasm core: `true` while the Rust
   * side records evictions/expirations for us to drain. `false` costs nothing.
   */
  #dropTracking = false;
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

  /**
   * Value stored under `key`, or `undefined` when missing or expired. Counts a hit/miss.
   *
   * The value comes back as the cache's **live reference** — see *Value ownership* on the
   * class before mutating it. Emits {@link CacheEventMap.hit} / {@link CacheEventMap.miss}
   * when someone listens, and an entry whose stored value *is* `undefined` counts as a
   * miss — from the caller's side there is no way to tell it apart from absence anyway.
   */
  get(key: string): V | undefined {
    const value = this.#wasm.get(key);
    // `hears` first: the payload (and the boundary-crossing bookkeeping around it) is only
    // built when a listener of that exact type — or a wildcard — exists.
    if (value === undefined) {
      if (this.#events.hears('miss')) this.#events.emit('miss', { type: 'miss', key });
    } else if (this.#events.hears('hit')) {
      this.#events.emit('hit', { type: 'hit', key, value });
    }
    // The core may have reclaimed an expired entry during this very lookup.
    if (this.#dropTracking) this.#drainDrops();
    return value;
  }

  /**
   * Batch lookup: returns the value for each key, or `undefined` when missing/expired.
   * Crosses the wasm boundary once instead of once per key.
   *
   * Each hit marks the entry visited for SIEVE, exactly like {@link BlazeCache.get} — and
   * emits one `hit`/`miss` event per key.
   */
  getMany(keys: string[]): (V | undefined)[] {
    const values = this.#wasm.getMany(keys) as (V | undefined)[];
    const wantsHit = this.#events.hears('hit');
    const wantsMiss = this.#events.hears('miss');
    if (wantsHit || wantsMiss) {
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i]!;
        const value = values[i];
        if (value === undefined) {
          if (wantsMiss) this.#events.emit('miss', { type: 'miss', key });
        } else if (wantsHit) {
          this.#events.emit('hit', { type: 'hit', key, value });
        }
      }
    }
    if (this.#dropTracking) this.#drainDrops();
    return values;
  }

  /**
   * The same lookup as {@link BlazeCache.get}, minus every side effect: no hit or miss is
   * recorded, the entry is not marked used for eviction, and nothing is reclaimed.
   *
   * The read for "is this here?" questions — a UI check must not be able to move the hit
   * rate or decide who gets evicted next. The value is still the cache's **live reference**,
   * exactly like {@link BlazeCache.get}.
   */
  peek(key: string): V | undefined {
    return this.#wasm.peek(key) as V | undefined;
  }

  /**
   * Milliseconds until `key` expires, or `undefined` when it has no TTL or is missing.
   *
   * The two `undefined`s mean different things: an entry with no deadline lives until it is
   * evicted, a key that is not there at all will never be found again. Purely observational —
   * statistics, eviction state and storage are all left alone.
   */
  ttl(key: string): number | undefined {
    return this.#wasm.ttl(key);
  }

  /** `true` when `key` is present and not expired. Never changes eviction state. */
  has(key: string): boolean {
    return this.#wasm.has(key);
  }

  /**
   * Batch existence check: returns `true` for each key that is present and not expired.
   * Crosses the wasm boundary once instead of once per key.
   */
  hasMany(keys: string[]): boolean[] {
    const flags = this.#wasm.hasMany(keys) as unknown as Uint8Array;
    const result = new Array<boolean>(flags.length);
    for (let i = 0; i < flags.length; i += 1) result[i] = flags[i] === 1;
    return result;
  }

  /**
   * Live entry — value, remaining TTL and tags — without touching statistics. The `value`
   * field is the cache's live reference — see *Value ownership* on the class.
   */
  entry(key: string): CacheEntry<V> | undefined {
    return this.#wasm.entry(key) as CacheEntry<V> | undefined;
  }

  /**
   * Snapshot of every live entry, oldest first. The `value` fields are the cache's live
   * references — see *Value ownership* on the class.
   */
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

  /**
   * Number of stored entries that are present **and** not expired.
   *
   * Expired-but-unpruned slots are skipped, so this always agrees with `keys()` and
   * `entries()`. (`stats().size` is the raw count and may include them until `prune()`.)
   */
  size(): number {
    return this.#wasm.size();
  }

  /** Maximum number of entries — the `capacity` passed to {@link createCache}. */
  capacity(): number {
    return this.#wasm.capacity();
  }

  /** Cumulative counters plus a computed `hitRate`. */
  stats(): CacheStats {
    const base = this.#wasm.stats() as Omit<CacheStats, 'hitRate'>;
    const total = base.hits + base.misses;
    return { ...base, hitRate: total === 0 ? 0 : base.hits / total };
  }

  // ----------------------------------------------------------------- writes

  /**
   * Stores (or replaces) `key`. Replacing refreshes the TTL and replaces the tags.
   *
   * The value is stored **by reference** — the cache takes ownership for the lifetime of the
   * entry, so mutating it afterwards rewrites the cache (see *Value ownership* on the class).
   */
  set(key: string, value: V, options?: SetOptions): void {
    // No defensive copy of `tags`: the binding reads the array synchronously while building
    // the wasm call and never retains it, so the `readonly`→`string[]` cast below is safe.
    // Untagged writes share `NO_TAGS` (see its doc).
    this.#wasm.set(key, value, options?.ttlMs ?? null, (options?.tags ?? NO_TAGS) as string[]);
    if (this.#hasChangeConsumers) this.#notify({ type: 'set', key });
    // Capacity pressure is applied inside the wasm call: entries it dropped surface here.
    if (this.#dropTracking) this.#drainDrops();
  }

  /**
   * Batch write: stores every key/value pair in one wasm boundary crossing.
   *
   * Each entry's `ttlMs` and `tags` are applied independently. A negative `ttlMs` means
   * "no expiry". Crosses the boundary once instead of once per entry.
   *
   * Listeners are notified for each entry when change consumers exist.
   */
  setMany(entries: SetManyEntry<V>[]): void {
    const n = entries.length;
    const keys = new Array<string>(n);
    const values = new Array<unknown>(n);
    const ttlMs = new Float64Array(n);
    const tagsFlat: string[] = [];
    const tagOffsets = new Uint32Array(n + 1);
    tagOffsets[0] = 0;

    for (let i = 0; i < n; i += 1) {
      const entry = entries[i]!;
      keys[i] = entry.key;
      values[i] = entry.value;
      ttlMs[i] = entry.options?.ttlMs ?? -1;
      const tags = entry.options?.tags;
      if (tags) {
        for (const tag of tags) tagsFlat.push(tag);
      }
      tagOffsets[i + 1] = tagsFlat.length;
    }

    this.#wasm.setMany(
      keys,
      values as unknown as any[],
      ttlMs,
      tagsFlat,
      tagOffsets,
    );

    if (this.#hasChangeConsumers) {
      for (let i = 0; i < n; i += 1) this.#notify({ type: 'set', key: entries[i]!.key });
    }
    // One sweep can span the whole batch — drain once, after every write landed.
    if (this.#dropTracking) this.#drainDrops();
  }

  /**
   * Marks `key` as recently used for eviction and optionally renews its TTL — the stored
   * value is never changed.
   *
   * "Recently used" is SIEVE's visited bit, exactly what {@link BlazeCache.get} grants, so a
   * touched entry survives the next eviction sweep. Returns `false` when the key is missing
   * or expired: there is nothing to refresh, and an expired entry is never resurrected.
   */
  touch(key: string, options?: TouchOptions): boolean {
    const touched = this.#wasm.touch(key, options?.ttlMs ?? null);
    // A renewed deadline is what storage would have to write back, so a touch is reported
    // like any other write: listeners hear about it and the entry is marked dirty.
    if (touched && this.#hasChangeConsumers) this.#notify({ type: 'touch', key });
    return touched;
  }

  /** Removes `key`, returning whether it was there. */
  delete(key: string): boolean {
    const removed = this.#wasm.delete(key);
    if (removed && this.#hasChangeConsumers) this.#notify({ type: 'delete', key });
    return removed;
  }

  /**
   * Batch delete: removes every key, returning `true` for each key that was present.
   * Crosses the wasm boundary once instead of once per key.
   */
  deleteMany(keys: string[]): boolean[] {
    const removed = this.#wasm.deleteMany(keys) as unknown as Uint8Array;
    const result = new Array<boolean>(removed.length);
    for (let i = 0; i < removed.length; i += 1) result[i] = removed[i] === 1;
    if (this.#hasChangeConsumers) {
      for (let i = 0; i < removed.length; i += 1) {
        if (result[i]) this.#notify({ type: 'delete', key: keys[i]! });
      }
    }
    return result;
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
   * Subscribes to cache events. Returns the unsubscribe function.
   *
   * Two forms:
   *
   * * `on(type, listener)` — only events of that {@link CacheEventType}; the payload is
   *   typed to exactly that event.
   * * `on(listener)` — **wildcard**: every event, payload the full {@link CacheEvent}
   *   union (narrow on `event.type` to read per-event fields).
   *
   * Registering the same function twice for the same type is a no-op, and the returned
   * unsubscribe function is idempotent. Persistence uses listeners internally, so
   * bookkeeping runs for every change regardless of whether anyone subscribed; a listener
   * that throws is isolated — the failure is logged with `console.error`, the mutation it
   * was told about stands, and the remaining listeners are still notified.
   *
   * Subscribing to `evict`/`expire` (or to anything via the wildcard) switches on the Rust
   * core's drop log — see *Events* on the class. Unsubscribing the last such listener
   * switches it off again.
   *
   * @example
   * ```ts
   * const off = cache.on('set', ({ key }) => console.log('stored', key));
   * const offAll = cache.on((event) => console.log(event.type));
   * off();
   * ```
   */
  on<K extends CacheEventType>(type: K, listener: CacheEventListener<V, K>): () => void;
  on(listener: CacheEventListener<V>): () => void;
  /** @deprecated The pre-event-system signature — kept so old annotations still compile. */
  on(listener: CacheListener): () => void;
  on(
    typeOrListener: CacheEventType | ((event: any) => void),
    maybeListener?: (event: any) => void,
  ): () => void {
    // The bus's change hook keeps `#dropTracking` in step with the subscriber set, so
    // neither registration nor the returned unsubscribe has to remember the wasm call.
    return maybeListener === undefined
      ? this.#events.on(typeOrListener as (event: any) => void)
      : this.#events.on(
          typeOrListener as CacheEventType,
          maybeListener as (event: any) => void,
        );
  }

  /**
   * Like {@link BlazeCache.on}, but the listener fires at most once — it is removed as it
   * runs, so a re-entrant emit from inside it cannot deliver a second time. Returns the
   * unsubscribe function, which simply becomes a no-op after the fire.
   */
  once<K extends CacheEventType>(type: K, listener: CacheEventListener<V, K>): () => void;
  once(listener: CacheEventListener<V>): () => void;
  /** @deprecated The pre-event-system signature — kept so old annotations still compile. */
  once(listener: CacheListener): () => void;
  once(
    typeOrListener: CacheEventType | ((event: any) => void),
    maybeListener?: (event: any) => void,
  ): () => void {
    return maybeListener === undefined
      ? this.#events.once(typeOrListener as (event: any) => void)
      : this.#events.once(
          typeOrListener as CacheEventType,
          maybeListener as (event: any) => void,
        );
  }

  /**
   * Removes listeners without needing the unsubscribe handle:
   *
   * * `off()` — every listener of every type;
   * * `off(type)` — every listener of that type;
   * * `off(type, listener)` — that one registration;
   * * `off(listener)` — that function from the wildcard **and** every typed set.
   *
   * Calling it with something that is not registered is a no-op. Releasing the last
   * `evict`/`expire`-interested listener also switches the core's drop log off.
   */
  off(): void;
  off(type: CacheEventType): void;
  off(type: CacheEventType, listener: CacheEventListener<V>): void;
  off(listener: CacheEventListener<V> | CacheListener): void;
  off(
    typeOrListener?: CacheEventType | ((event: any) => void),
    listener?: (event: any) => void,
  ): void {
    if (typeOrListener === undefined) this.#events.off();
    else if (listener === undefined) this.#events.off(typeOrListener as any);
    else this.#events.off(typeOrListener as CacheEventType, listener);
  }

  /**
   * Writes pending changes to storage immediately.
   *
   * Resolves once the underlying transaction commits. Concurrent calls are serialised, so
   * this is safe to call from a `beforeunload` handler while a debounced flush is pending.
   *
   * When the write itself fails — quota, a blocked or transient IndexedDB error — the pass
   * rejects **and hands every record it had claimed back onto the queue**, so the next flush
   * (a later mutation's timer, an explicit call, `pagehide`, `dispose`) retries them instead
   * of losing them.
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
   * report it — but teardown happens in a `finally`, so a storage outage can never leak the
   * wasm instance, the timers or the `pagehide`/`visibilitychange` listeners behind a
   * rejected promise.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    try {
      await this.flush();
    } finally {
      this.#disposed = true;
      if (this.#timer !== null) {
        clearTimeout(this.#timer);
        this.#timer = null;
      }
      for (const unbind of this.#unbind.splice(0)) unbind();
      this.#events.clear(); // the change hook skips the wasm sync (`#disposed` is already true)
      this.#dropTracking = false;
      try {
        await this.#persist?.close?.();
      } catch (error) {
        // Closing is best-effort (the IndexedDB adapter says as much): a failing adapter
        // must neither break disposal nor mask the flush error this `finally` rethrows.
        console.error('[blaze-cache] closing the persistence adapter failed.', error);
      }
      this.#persist = null;
      this.#wasm.free();
    }
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

  /**
   * Fills the cache from storage, dropping records whose TTL elapsed while we were away —
   * and records no well-formed write could ever have produced.
   *
   * `load()` hands back whatever sits on disk: an older package version, another tab or a
   * flaky adapter may have left a row that no longer matches {@link PersistedRecord} — a
   * missing key, `tags` that are not an array, a deadline that is not a number. One such row
   * must cost exactly that row: every record is shape-checked (and its wasm `set` guarded)
   * individually, so the remaining records still hydrate. The complaint is a single
   * `console.warn` per run, not one per bad row.
   */
  async #hydrate(adapter: CachePersistence): Promise<void> {
    const records = await adapter.load();
    const now = Date.now();
    let reported = false;
    const skip = (reason: string, record: unknown, error?: unknown): void => {
      if (reported) return;
      reported = true;
      console.warn(
        `[blaze-cache] skipping malformed persisted record — ${reason}.`,
        record,
        ...(error === undefined ? [] : [error]),
      );
    };

    for (const record of records) {
      let reason: string | null = null;
      if (typeof record?.key !== 'string') {
        reason = 'key is missing or not a string';
      } else if (!Array.isArray(record.tags) || record.tags.some((tag) => typeof tag !== 'string')) {
        reason = 'tags are not an array of strings';
      } else if (
        record.ttlMs !== null &&
        (!Number.isFinite(record.ttlMs) || !Number.isFinite(record.storedAt))
      ) {
        // With a TTL present, both halves of the deadline must be real numbers — anything
        // else yields a `NaN` that would masquerade as "never expires".
        reason = 'ttl or storedAt is not a finite number';
      }
      if (reason !== null) {
        skip(reason, record);
        continue;
      }

      try {
        const remaining = record.ttlMs === null ? null : record.ttlMs - (now - record.storedAt);
        if (remaining !== null && remaining <= 0) continue;
        // Direct wasm call: hydration is not a user write, so it emits no event — nor any
        // change for persistence (the adapter it came from is already up to date).
        this.#wasm.set(record.key, record.value, remaining, record.tags);
      } catch (error) {
        skip('the wasm core refused the write', record, error);
      }
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
    // lands in the *next* pass instead of being written twice. The claimed records stay in
    // these locals for the whole pass: if the adapter rejects — quota, a transient
    // IndexedDB failure — the catch below hands every one of them back to the queues, so a
    // failed flush delays work rather than destroying it. Single-flight still holds: this
    // run is chained on `#chain`, and the next `flush()` chains onto *our* settled promise,
    // requeued work included.
    const clearAll = this.#clearAll;
    const deleted = [...this.#deleted];
    const dirty = [...this.#dirty].filter((key) => !this.#deleted.has(key));
    this.#clearAll = false;
    this.#dirty.clear();
    this.#deleted.clear();

    let toRemove = deleted;
    try {
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

      // Reconcile the rows the wasm core dropped on its own. A capacity eviction inside
      // `set` and a lapsed TTL never queue a delete for persistence — the `evict`/`expire`
      // events they emit reach subscribers only, and `prune`/`remove` callers may not have
      // persisted the key either — so without this diff their rows would outlive every
      // flush, be re-hydrated at the next startup, and eat quota until a
      // `QuotaExceededError` kills persistence outright.
      // Any key storage still holds that the wasm core no longer lists is stale. Skipped
      // after `clear()` (storage was just emptied) and for adapters without `keys()`.
      if (!clearAll && typeof persist.keys === 'function') {
        const persisted = await persist.keys();
        // Read the live set *after* the await, so a `set` landing mid-pass counts as live
        // and keeps its row — and nothing awaits before `remove`, so the diff cannot go
        // stale under our feet.
        const live = new Set(this.#wasm.keys());
        const stale = persisted.filter((key) => !live.has(key));
        if (stale.length > 0) toRemove = [...new Set([...deleted, ...stale])];
      }

      // One last synchronous guard: a key re-`set` while the pass was awaiting belongs to
      // the *next* pass's `save`, so removing its row here would only open a window where
      // memory and storage disagree.
      const targets = toRemove.filter((key) => !this.#dirty.has(key));
      if (targets.length > 0) await persist.remove(targets);
    } catch (error) {
      // Hand back exactly what this pass claimed. Concurrent work that landed during the
      // awaits is kept as-is, and the two queues stay disjoint — a key the runner may have
      // touched in the meantime belongs to whoever claimed it last.
      if (clearAll) this.#clearAll = true;
      for (const key of dirty) {
        // Deleted while we were awaiting? Its delete bookkeeping is already queued — don't
        // resurrect it on the dirty side.
        if (!this.#deleted.has(key)) this.#dirty.add(key);
      }
      for (const key of toRemove) {
        // Re-`set` while we were awaiting? Then the next pass must save it, not delete the
        // row that save would write.
        if (!this.#dirty.has(key)) this.#deleted.add(key);
      }
      throw error;
    }
  }

  /**
   * `true` when a change event would actually reach someone — persistence bookkeeping or at
   * least one event listener (wildcard or typed).
   *
   * Lets the mutation paths skip building a {@link CacheChange} object altogether when
   * nothing consumes it (memory-only cache, no subscribers). Equivalent to the conditions
   * inside {@link BlazeCache.#notify}: after `dispose` the persistence adapter is `null`, so
   * the `!#disposed` check inside `#notify` cannot change the outcome here.
   */
  get #hasChangeConsumers(): boolean {
    return this.#events.size > 0 || this.#persist !== null;
  }

  #notify(change: CacheChange): void {
    if (this.#persist && !this.#disposed) {
      switch (change.type) {
        case 'set':
        case 'touch':
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
    // Wildcard and typed listeners alike — the bus isolates a throwing listener from its
    // siblings (see `events.ts`).
    this.#events.emit(change);
  }

  /**
   * Emits `evict`/`expire` for every entry the Rust core reclaimed during the operation
   * that just ran — a capacity sweep inside `set`, or lazy TTL reclamation inside `get`.
   *
   * Callers reach this only while `#dropTracking` is on, and the core only *records* drops
   * while tracking is on, so the frequent result is an empty array: one wasm crossing that
   * emits nothing. The `value` handed to listeners is the dropped entry's live reference.
   */
  #drainDrops(): void {
    const drops = this.#wasm.drainDrops() as Array<{
      key: string;
      value: V;
      reason: 'evict' | 'expire';
    }>;
    for (let i = 0; i < drops.length; i += 1) {
      const { key, value, reason } = drops[i]!;
      if (reason === 'evict') this.#events.emit('evict', { type: 'evict', key, value });
      else this.#events.emit('expire', { type: 'expire', key, value });
    }
  }

  /**
   * Mirrors the subscriber set onto the wasm core: while *any* listener cares about
   * `evict`/`expire` — a typed one or any wildcard — the Rust core's opt-in drop log
   * collects the entries the cache drops by itself; when the last such listener goes away
   * the log is switched off (which also discards anything not yet drained).
   *
   * Driven by the event bus's change hook, so it runs after every `on`/`once`/`off` —
   * including the removal a fired `once` performs — and no call site has to remember it.
   * Skipped after `dispose`: the wasm instance is already gone.
   */
  #syncDropTracking(): void {
    if (this.#disposed) return;
    const wanted = this.#events.wantsDrops;
    if (wanted === this.#dropTracking) return;
    this.#dropTracking = wanted;
    this.#wasm.setDropTracking(wanted);
  }
}

/** Shorthand for {@link BlazeCache.create}. */
export function createCache<V = any>(options?: BlazeCacheOptions): Promise<BlazeCache<V>> {
  return BlazeCache.create<V>(options);
}
