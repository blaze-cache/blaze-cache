import type {
  BlazeCacheLike,
  CacheChange,
  CacheEntry,
  CacheEvent,
  CacheEventListener,
  CacheEventType,
  CacheKeySubscriber,
  CacheListener,
  CacheManySubscriber,
  CacheStats,
  CacheSubscribeOptions,
  CacheTagSubscriber,
  SetManyEntry,
  SetOptions,
  TouchOptions,
} from './types.js';
import { CacheEventBus } from './events.js';
import { MultiTabSync } from './multitab.js';
import type { MultiTabOptions, Version } from './multitab.js';
import { CacheSubscriptions } from './reactivity.js';
import { loadBlazeWasm, keyScratch, tagScratch, wasmLinearMemory, WasmCache } from './wasm.js';
import type { WasmLoadOptions } from './wasm.js';
import { indexedDbPersistence } from './persistence/indexeddb.js';
import type {
  CachePersistence,
  PersistedRecord,
  PersistenceActivity,
  PersistenceControl,
  PersistenceErrorPhase,
  PersistenceOptions,
  PersistenceStats,
  PersistenceWriteMode,
} from './persistence/types.js';

/** Entries held when `capacity` is not given. */
export const DEFAULT_CAPACITY = 500;
/** Milliseconds a write waits for more writes before hitting IndexedDB. */
export const DEFAULT_FLUSH_DELAY_MS = 400;
/** Upper bound on records written by a single flush. */
export const DEFAULT_MAX_RECORDS = 2000;
/**
 * Consecutive failed flushes a single key may accumulate before it is dropped from the
 * persistence queue (kept in memory, warned about) instead of blocking every later flush.
 */
const MAX_FAILED_FLUSHES = 3;
/**
 * Shared stand-in for "no tags" on the write path.
 *
 * The binding copies the array into wasm memory synchronously during the call and never
 * retains it, so one module-level array can serve every untagged write instead of allocating
 * a fresh `[]` per `set`. Never mutated.
 */
const NO_TAGS: string[] = [];

/**
 * Reads one persistence option that exists under a new name **and** a legacy alias
 * (`debounceMs`/`flushDelayMs`, `maxEntries`/`maxRecords`).
 *
 * Either spelling works on its own; given both, they must agree — a silent "new name
 * wins" would leave the old one rotting in a caller's config with no hint that it stopped
 * having an effect. Returns the value to validate, or `undefined` when neither was given.
 */
function pickPaired<T>(
  primary: T | undefined,
  legacy: T | undefined,
  primaryName: string,
  legacyName: string,
): T | undefined {
  if (primary !== undefined && legacy !== undefined && primary !== legacy) {
    throw new RangeError(
      `[blaze-cache] persistence.${primaryName} (${String(primary)}) and persistence.${legacyName} (${String(legacy)}) were both given and disagree — keep one spelling.`,
    );
  }
  return primary ?? legacy;
}

/** Options for a custom {@link CachePersistence} adapter — settings, tuning and observers. */
export interface CachePersistenceOptions extends PersistenceOptions {
  adapter: CachePersistence;
}

/**
 * Options for the built-in IndexedDB adapter — connection settings plus flush tuning,
 * session isolation and observers. An alias of {@link PersistenceOptions}: the full set
 * of persistence options is identical for both flavours.
 */
export type IndexedDbPersistenceOptions = PersistenceOptions;

/** Options accepted by {@link BlazeCache.create}. */
export interface BlazeCacheOptions extends WasmLoadOptions {
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
   *
   * Both flavours accept the same tuning, session and observer options — see
   * {@link PersistenceOptions} — and expose the same control surface at
   * {@link BlazeCache.persistence}.
   */
  persistence?: false | CachePersistenceOptions | IndexedDbPersistenceOptions;
  /**
   * Opt-in cross-tab synchronization over `BroadcastChannel`. Off by default; a cache created
   * without it behaves exactly as before. See {@link MultiTabOptions}.
   */
  multiTab?: MultiTabOptions;
  /**
   * Where values live. `wasm` (default) keeps the current by-reference externref contract:
   * the value is stored in the Rust slab and every read crosses the Wasm boundary.
   *
   * `js` is an **opt-in** hybrid: wasm keeps keys, TTL, tags, SIEVE and stable entry ids, while
   * values live in a JS `Map<id, V>`. Hot reads call wasm by id (no key string marshalled) and
   * then look the value up locally. By-reference semantics, tag invalidation, events,
   * persistence and `entry()`/`entries()` behave identically; only the ownership of values
   * moves from the slab to JS. Feature is off unless you ask for it.
   */
  storage?: 'wasm' | 'js';
}

/** The options {@link createCache} takes — an alias for {@link BlazeCacheOptions}. */
export type CreateCacheOptions = BlazeCacheOptions;

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
  /**
   * Whether the instantiated module supports the raw-key fast path (pre-encoded keys that
   * skip the per-call string allocation). Probed once during {@link create}; `false` for a
   * caller-supplied `.wasm` binary that predates the `*Raw` bindings, which then keeps the
   * ordinary string path.
   */
  readonly #raw: boolean;
  /** Opt-in cross-tab sync. `null` unless `multiTab.enabled` is set. */
  #multiTab: MultiTabSync<V> | null = null;
  /** Last version seen for each key — the stale-message guard. */
  readonly #versions = new Map<string, Version>();
  /** Where values live. See {@link BlazeCacheOptions.storage}. */
  readonly #storage: 'wasm' | 'js';
  /** `key → stable id`, only populated in `storage: 'js'` mode. */
  readonly #ids = new Map<string, number>();
  /** `id → value`, only populated in `storage: 'js'` mode. */
  readonly #values = new Map<number, V>();
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
  /** The configured namespace, for {@link BlazeCache.persistence.stats}. */
  #namespace = '';
  /**
   * The current session generation — the token rotated on logout/login. `''` means "no
   * generation", i.e. the plain namespace.
   */
  #generation = '';
  /**
   * Monotonic session counter, bumped by {@link PersistenceControl.rotate}.
   *
   * Every asynchronous persistence pass (flush, hydrate) snapshots it before its first
   * `await` and re-checks it after each one: a mismatch means the session changed
   * underneath the pass, which then **drops its claimed work** instead of writing the
   * previous account's records into the next account's storage — or requeueing them,
   * where they would surface one flush later. Clearing memory alone never did this; a
   * save already handed to the adapter cannot be un-handed, which is why the adapter
   * snapshots its bucket too (see `indexedDbPersistence`).
   */
  #epoch = 0;
  #restoreExpired = false;
  #writeMode: PersistenceWriteMode = 'debounce';
  /** Observer for contained failures — replaces the default `console.error` reporting. */
  #onError: ((error: unknown) => void) | undefined;
  /** Observer for persistence activity (hydrate/flush/rotate/error). */
  #onActivity: ((activity: PersistenceActivity) => void) | undefined;
  // --- persistence counters behind `persistence.stats()` ---
  #statHydrates = 0;
  #statRestored = 0;
  #statSkipped = 0;
  #statFlushes = 0;
  #statRecordsWritten = 0;
  #statAborted = 0;
  #statRotations = 0;
  #statErrors = 0;
  #statLastError: unknown = null;
  #statLastFlushAt: number | null = null;
  #statLastHydrateAt: number | null = null;
  /** The single in-flight teardown — overlapping {@link BlazeCache.dispose} calls share it. */
  #disposePromise: Promise<void> | null = null;
  /** Consecutive failed flushes per dirty key; a key that keeps failing is dropped, not queued forever. */
  #failedFlushes = new Map<string, number>();
  /**
   * The reactivity layer behind {@link BlazeCache.subscribe} and friends — `null` until the
   * first subscription, so a cache nobody subscribes to never allocates it and never pays
   * for it. Created once and reused: an empty layer is a detached layer.
   */
  #subs: CacheSubscriptions<V> | null = null;
  /**
   * The {@link PersistenceControl} handed out by {@link BlazeCache.persistence} — built
   * once, because every method is a closure over this instance and the state it reads
   * (adapter presence, generation, counters) is only known at call time. That is also
   * what lets the surface exist on a memory-only cache: the methods simply resolve as
   * no-ops instead of forcing callers to branch on an option they may not remember.
   */
  readonly #control: PersistenceControl;

  private constructor(wasm: WasmCache, storage: 'wasm' | 'js' = 'wasm') {
    this.#wasm = wasm;
    this.#raw = keyScratch.enabled;
    this.#storage = storage;
    // JS-authoritative mode needs the drop log permanently on: self-initiated evictions and
    // expirations are how JS learns which ids to delete from its value Map.
    if (storage === 'js') {
      // Both indexes are opt-in in the Rust core: the default path pays nothing for them.
      this.#wasm.enableIds();
      this.#wasm.setDropTracking(true);
      this.#dropTracking = true;
    }
    // The getters below need *the instance* for private-field access: inside an object
    // literal `this` would be the control object itself.
    const self = this;
    this.#control = {
      get enabled(): boolean {
        return self.#persist !== null;
      },
      get generation(): string {
        return self.#generation;
      },
      flush: () => this.flush(),
      clear: () => this.#controlClear(),
      hydrate: () => this.#controlHydrate(),
      rotate: (generation: string) => this.#rotate(generation),
      stats: () => this.#persistenceStats(),
    };
  }

  /**
   * Loads the wasm module, builds the cache and — if requested — hydrates it from storage.
   *
   * The binary comes from the one source option given ({@link WasmLoadOptions.wasmUrl},
   * {@link WasmLoadOptions.module} or {@link WasmLoadOptions.instantiate}), or from the
   * asset shipped with this package when none is. Loading happens once per page: concurrent
   * `create()` calls share one download and one instantiation.
   *
   * Storage failures (blocked IndexedDB, quota, private mode) degrade to memory-only with a
   * console warning instead of rejecting.
   */
  static async create<V = any>(options: BlazeCacheOptions = {}): Promise<BlazeCache<V>> {
    await loadBlazeWasm(options);
    const storage = options.storage ?? 'wasm';
    if (storage !== 'wasm' && storage !== 'js') {
      throw new TypeError(`[blaze-cache] storage must be "wasm" or "js", got ${String(storage)}.`);
    }
    const cache = new BlazeCache<V>(new WasmCache(options.capacity ?? DEFAULT_CAPACITY), storage);
    await cache.#setupPersistence(options.persistence);
    cache.#setupMultiTab(options.multiTab);
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
    let value: V | undefined;
    if (this.#storage === 'js') {
      const id = this.#ids.get(key);
      // Hot path: no key string crosses the boundary — wasm only answers "is this id alive?".
      if (id === undefined) {
        this.#wasm.recordMiss();
      } else {
        const alive = this.#wasm.getById(id);
        value = alive ? this.#values.get(id) : undefined;
        // An expired id is reclaimed inside wasm; #drainDrops releases its value and hands
        // listeners the real reference, so do not delete it here first.
      }
    } else if (this.#raw) {
      // Pre-encode into the shared scratch: a repeated key costs one identity check instead
      // of a wasm-side malloc + copy + free (see `KeyScratch`).
      keyScratch.encode(key);
      value = this.#wasm.getRaw(keyScratch.ptr, keyScratch.len) as V | undefined;
    } else {
      value = this.#wasm.get(key);
    }
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
    const values: (V | undefined)[] =
      this.#storage === 'js'
        ? keys.map((key) => {
            const id = this.#ids.get(key);
            if (id === undefined) {
              this.#wasm.recordMiss();
              return undefined;
            }
            return this.#wasm.getById(id) ? this.#values.get(id) : undefined;
          })
        : (this.#wasm.getMany(keys) as (V | undefined)[]);
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
    if (this.#storage === 'js') {
      const id = this.#ids.get(key);
      return id !== undefined && this.#wasm.peekById(id) ? this.#values.get(id) : undefined;
    }
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
    if (this.#storage === 'js') {
      const id = this.#ids.get(key);
      return id !== undefined && this.#wasm.hasById(id);
    }
    return this.#wasm.has(key);
  }

  /**
   * Batch existence check: returns `true` for each key that is present and not expired.
   * Crosses the wasm boundary once instead of once per key.
   */
  hasMany(keys: string[]): boolean[] {
    if (this.#storage === 'js') {
      return keys.map((key) => {
        const id = this.#ids.get(key);
        return id !== undefined && this.#wasm.hasById(id);
      });
    }
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
    return this.#entryFor(key);
  }

  /**
   * Snapshot of every live entry, oldest first. The `value` fields are the cache's live
   * references — see *Value ownership* on the class.
   */
  entries(): CacheEntry<V>[] {
    if (this.#storage === 'js') {
      const metas = this.#wasm.entriesMeta() as Array<{
        key: string;
        id: number;
        ttlMs: number | null;
        tags: string[];
      }>;
      return metas.map(({ key, id, ttlMs, tags }) => ({
        key,
        value: this.#values.get(id) as V,
        ttlMs,
        tags,
      }));
    }
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
    const tags = (options?.tags ?? NO_TAGS) as string[];
    const ttlMs = options?.ttlMs ?? null;
    if (this.#storage === 'js') {
      // wasm keeps metadata and hands back a stable id; the value itself never crosses the
      // boundary. An overwrite keeps its id, so this is one Map.set rather than two.
      const id = this.#wasm.setMeta(key, ttlMs, tags);
      this.#values.set(id, value);
      this.#ids.set(key, id);
    } else if (this.#raw && tagScratch.enabled && tags.length === 1) {
      // Single-tag fast path: no offset table and no cache-key allocation on the host.
      keyScratch.encode(key);
      const encoded = tagScratch.encodeOne(tags[0]!);
      this.#wasm.setRawWithOneTag(
        keyScratch.ptr,
        keyScratch.len,
        value,
        ttlMs,
        encoded.ptr,
        encoded.len,
      );
    } else if (this.#raw && tagScratch.enabled && tags.length > 0) {
      // Tagged raw path: key and tag bytes are already in Wasm memory, so neither is
      // marshalled per write. Offsets are validated again inside the binding.
      keyScratch.encode(key);
      const encoded = tagScratch.encode(tags);
      this.#wasm.setRawWithTags(
        keyScratch.ptr,
        keyScratch.len,
        value,
        ttlMs,
        encoded.ptr,
        encoded.len,
        encoded.offsetsView,
      );
    } else if (this.#raw && tags.length === 0) {
      // Untagged write via the pre-encoded-key path: skips both the key allocation and the
      // empty-tags array crossing — the two avoidable costs of the string `set`.
      keyScratch.encode(key);
      this.#wasm.setRaw(keyScratch.ptr, keyScratch.len, value, ttlMs);
    } else {
      this.#wasm.set(key, value, ttlMs, tags);
    }
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

    if (this.#storage === 'js') {
      const ids = this.#wasm.setManyMeta(keys, ttlMs as unknown as Float64Array, tagsFlat, tagOffsets);
      for (let i = 0; i < n; i += 1) {
        const id = ids[i]!;
        this.#values.set(id, entries[i]!.value);
        this.#ids.set(entries[i]!.key, id);
      }
    } else if (this.#raw && tagScratch.enabled) {
      // Keys and tags are encoded into the two scratch buffers; only the values array crosses
      // the boundary. This is the batched counterpart of the tagged raw write path.
      const encodedKeys = keyScratch.encodeMany(keys);
      const groups = entries.map((entry) => entry.options?.tags ?? []);
      const encodedTags = tagScratch.encodeRanges(groups);
      this.#wasm.setManyRaw(
        encodedKeys.ptr,
        encodedKeys.offsets,
        encodedKeys.lengths,
        values as unknown as any[],
        ttlMs,
        encodedTags.ptr,
        encodedTags.len,
        encodedTags.offsetsView,
      );
    } else {
      this.#wasm.setMany(
        keys,
        values as unknown as any[],
        ttlMs,
        tagsFlat,
        tagOffsets,
      );
    }

    if (this.#hasChangeConsumers) {
      for (let i = 0; i < n; i += 1) this.#notify({ type: 'set', key: entries[i]!.key });
    }
    // One sweep can span the whole batch — drain once, after every write landed.
    if (this.#dropTracking) this.#drainDrops();
  }

  // ------------------------------------------------------------- binary value mode (opt-in)

  /**
   * Stores raw bytes **directly in Wasm linear memory** and reads them back as a zero-copy
   * `Uint8Array` view. Only available in the default `storage: 'wasm'` mode.
   *
   * The payload is copied once into a reserved arena region (a raw byte copy, not JS object
   * serialisation); `getBytes` then returns a view onto that region with no copy at all. This
   * is the only genuine zero-copy value path, because arbitrary JS objects cannot live in
   * linear memory. Prefer `getBytesCopy` when a view must outlive the next write or eviction.
   */
  setBytes(
    key: string,
    value: ArrayBufferView | ArrayBuffer,
    options?: SetOptions,
  ): boolean {
    if (this.#storage !== 'wasm') {
      throw new Error('[blaze-cache] setBytes requires storage: "wasm" (the default).');
    }
    const source = ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : new Uint8Array(value);
    const length = source.byteLength;
    const ptr = WasmCache.bytesReserve(length);
    const memory = wasmLinearMemory();
    new Uint8Array(memory.buffer, ptr, length).set(source);

    const tags = (options?.tags ?? NO_TAGS) as string[];
    const ttlMs = options?.ttlMs ?? null;
    const stored = this.#wasm.setBytes(key, ptr, length, ttlMs, tags);
    if (stored && this.#hasChangeConsumers) this.#notify({ type: 'set', key });
    if (this.#dropTracking) this.#drainDrops();
    return stored;
  }

  /**
   * A zero-copy view of a byte value, or `undefined` when the key is missing or was written
   * with `set`. Counts a hit/miss exactly like {@link BlazeCache.get}.
   *
   * The view is valid until the next Wasm allocation: `memory.grow` detaches the old
   * `ArrayBuffer`, and an evicted region may be reused. Read it promptly, or use
   * {@link BlazeCache.getBytesCopy} for a long-lived snapshot.
   */
  getBytes(key: string): Uint8Array | undefined {
    const coordinates = this.#wasm.getBytes(key) as [number, number] | undefined;
    if (!coordinates) {
      if (this.#events.hears('miss')) this.#events.emit('miss', { type: 'miss', key });
      if (this.#dropTracking) this.#drainDrops();
      return undefined;
    }
    const value = new Uint8Array(
      wasmLinearMemory().buffer,
      coordinates[0],
      coordinates[1],
    );
    if (this.#events.hears('hit')) this.#events.emit('hit', { type: 'hit', key, value: value as V });
    if (this.#dropTracking) this.#drainDrops();
    return value;
  }

  /**
   * Advanced bytes-producer path: stores an already-reserved arena region by its `(ptr, len)`
   * coordinates, with no JS→Wasm copy. Obtain `ptr` from `WasmCache.bytesReserve(len)` and write
   * the payload into `new Uint8Array(wasmLinearMemory().buffer, ptr, len)` first — a decoder can
   * therefore write straight into Wasm memory and hand the region to the cache. A rejected or
   * stale pointer stores nothing and returns `false`. The public `setBytes` remains the safe
   * default; this entry point is opt-in and shares its view-lifetime contract.
   */
  setBytesReserved(
    key: string,
    ptr: number,
    length: number,
    options?: SetOptions,
  ): boolean {
    if (this.#storage !== 'wasm') {
      throw new Error('[blaze-cache] setBytesReserved requires storage: "wasm" (the default).');
    }
    const tags = (options?.tags ?? NO_TAGS) as string[];
    const ttlMs = options?.ttlMs ?? null;
    const stored = this.#wasm.setBytes(key, ptr, length, ttlMs, tags);
    if (stored && this.#hasChangeConsumers) this.#notify({ type: 'set', key });
    if (this.#dropTracking) this.#drainDrops();
    return stored;
  }

  /** An owned copy of a byte value — safe to retain across writes, eviction and `memory.grow`. */
  getBytesCopy(key: string): Uint8Array | undefined {
    const value = this.#wasm.getBytesCopy(key);
    if (value === undefined) {
      if (this.#events.hears('miss')) this.#events.emit('miss', { type: 'miss', key });
    } else if (this.#events.hears('hit')) {
      this.#events.emit('hit', { type: 'hit', key, value: value as V });
    }
    if (this.#dropTracking) this.#drainDrops();
    return value;
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
    const removed = this.#deleteLocal(key);
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
    for (let i = 0; i < removed.length; i += 1) {
      result[i] = removed[i] === 1;
      if (result[i] && this.#storage === 'js') {
        const id = this.#ids.get(keys[i]!);
        if (id !== undefined) this.#values.delete(id);
        this.#ids.delete(keys[i]!);
      }
    }
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
    if (this.#storage === 'js') this.#forgetKeys(removed);
    if (removed.length > 0 && this.#hasChangeConsumers) {
      this.#notify({ type: 'invalidate', keys: removed });
      this.#multiTab?.publishInvalidateTags(tags);
      this.#multiTab?.markEpoch();
    }
    return removed;
  }

  /** Removes every expired entry, returning the removed keys. */
  prune(): string[] {
    const removed = this.#wasm.prune();
    if (this.#storage === 'js') this.#forgetKeys(removed);
    if (removed.length > 0 && this.#hasChangeConsumers) {
      this.#notify({ type: 'prune', keys: removed });
    }
    return removed;
  }

  /** Empties the cache. */
  clear(): void {
    this.#wasm.clear();
    if (this.#storage === 'js') {
      this.#ids.clear();
      this.#values.clear();
    }
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
   *
   * It clears **event** listeners only: any live {@link BlazeCache.subscribe} /
   * `subscribeTag` / `subscribeMany` registration re-binds its own internal listeners
   * immediately afterwards, so a sledgehammer `off()` cannot silently kill a subscription.
   * Releasing a subscription still goes through the handle `subscribe` returned.
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
    // `off()` can only ever reach the layer's listeners *through* the bus, so this is the
    // one place that has to put them back. A no-op with nothing subscribed.
    this.#subs?.rebind();
  }

  /**
   * Watches one key and runs `listener` with its **current value** every time the cache
   * changes it. Returns the unsubscribe function — idempotent, and safe to call from
   * inside the listener itself.
   *
   * This is the value-oriented front end of the event system: no `hit`/`miss`, no wildcard,
   * just the key you asked for. `value` is what the cache holds *now* — the new value after
   * `set`, the unchanged one after `touch`, and `undefined` after `delete`, `evict`,
   * `expire`, `invalidate`, `prune` or `clear` (for `evict`/`expire` the dropped reference
   * is still on `change.value`). The second argument is the mutation itself, so a listener
   * can tell a renewal from a replacement without a second lookup.
   *
   * Everything is opt-in: with no subscription the layer does not exist and `get`/`set`
   * are untouched. The first call attaches eight typed listeners to the event bus and
   * snapshots the live keys; while a subscription lives, a write crosses the boundary once
   * more to re-read that key's tags — and only when a {@link BlazeCache.subscribeTag}
   * subscription exists. A listener that throws is isolated: the failure is logged with
   * `console.error`, the mutation stands, and the other subscribers still run.
   *
   * @example
   * ```ts
   * const stop = cache.subscribe('user:42', (user, change) => {
   *   if (change.type === 'delete') console.log('gone');
   *   else console.log(change.type, user);
   * });
   *
   * const stopOnce = cache.subscribe('ready', (v) => console.log('first change', v), { once: true });
   *
   * stop();
   * stopOnce(); // already fired — a no-op
   * ```
   */
  subscribe(
    key: string,
    listener: CacheKeySubscriber<V>,
    options?: CacheSubscribeOptions,
  ): () => void {
    return (this.#subs ??= new CacheSubscriptions<V>(this)).subscribe(key, listener, options);
  }

  /**
   * Watches several keys with one listener, which is told **which** key changed:
   * `(key, value, change)`. Duplicates collapse, an empty list subscribes to nothing (it
   * never attaches and returns a no-op handle), and everything else — opt-in cost, error
   * isolation, the `once` option — matches {@link BlazeCache.subscribe}.
   *
   * @example
   * ```ts
   * const stop = cache.subscribeMany(['a', 'b'], (key, value, change) => {
   *   console.log(`${key} is now`, value, `after a ${change.type}`);
   * });
   * ```
   */
  subscribeMany(
    keys: string[],
    listener: CacheManySubscriber<V>,
    options?: CacheSubscribeOptions,
  ): () => void {
    return (this.#subs ??= new CacheSubscriptions<V>(this)).subscribeMany(
      keys,
      listener,
      options,
    );
  }

  /**
   * Watches one tag and runs `listener` whenever an entry carrying it changes — including
   * entries removed by an unrelated `invalidateTags` call, an eviction or a TTL that ran
   * out, which is the part the raw events cannot tell you on their own.
   *
   * The listener receives `{ tag, keys, change }`: the tag that woke it, the keys of *that
   * tag* the mutation touched (a write reports the key that entered or stayed in the tag,
   * a removal reports the keys that left it), and the mutation itself. Keys are attributed
   * from a per-tag mirror the layer keeps while anybody watches, so removals need no extra
   * lookup. Opt-in cost, error isolation and `once` match {@link BlazeCache.subscribe}.
   *
   * @example
   * ```ts
   * const stop = cache.subscribeTag('user', ({ keys, change }) => {
   *   console.log(change.type, keys);   // 'invalidate', ['user:42', 'user:43']
   * });
   * ```
   */
  subscribeTag(
    tag: string,
    listener: CacheTagSubscriber<V>,
    options?: CacheSubscribeOptions,
  ): () => void {
    return (this.#subs ??= new CacheSubscriptions<V>(this)).subscribeTag(
      tag,
      listener,
      options,
    );
  }

  /**
   * The persistence control surface: `flush()`, `clear()`, `hydrate()`, `stats()` and
   * `rotate()` — see {@link PersistenceControl}.
   *
   * Always present, even on a memory-only cache (the methods resolve as no-ops and
   * `stats().enabled` is `false`), so callers never have to remember which flavour of
   * `create` they are holding.
   *
   * ```ts
   * await cache.persistence.flush();     // same as cache.flush()
   * await cache.persistence.clear();     // wipe this namespace in storage (memory stays)
   * await cache.persistence.hydrate();   // reload stored records into memory
   * cache.persistence.stats();           // counters: hydrates, flushes, errors, pending…
   *
   * // logout → login:
   * await cache.persistence.rotate('user-43');  // invalidate the previous session
   * cache.clear();                              // drop its entries from memory
   * await cache.persistence.hydrate();          // load the new session's records
   * ```
   */
  get persistence(): PersistenceControl {
    return this.#control;
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
   * of losing them. A pass invalidated by {@link PersistenceControl.rotate} is the
   * exception: its claimed work belongs to a session that no longer exists, so it is
   * dropped and the flush resolves without writing.
   */
  flush(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    // With sync on, IndexedDB writes are serialised across tabs by a Web Lock. A tab that is
    // still hidden cannot commit a stale snapshot over a peer's newer row: remote mutations
    // update this tab's queues first, and only the lock holder writes.
    const locks = (globalThis as { navigator?: { locks?: { request(name: string, fn: () => Promise<void>): Promise<void> } } }).navigator?.locks;
    if (this.#multiTab?.active && locks) {
      return locks.request(this.#multiTab.channelName, () => this.#flushChain());
    }
    return this.#flushChain();
  }

  /** The serialised flush chain, without the optional cross-tab Web Lock. */
  #flushChain(): Promise<void> {
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
    // Memoised, not guarded: the `#disposed` flag only lands after the awaited flush settles,
    // so two overlapping `dispose()` calls (a `pagehide` handler plus application code, or
    // simply two un-awaited calls) would both pass a flag check and both run teardown —
    // the second `#wasm.free()` a null-pointer call into the Rust core. Everyone now awaits
    // the one teardown that exists; a rejection is shared by every caller, exactly like the
    // single failing flush it wraps.
    if (this.#disposePromise === null) this.#disposePromise = this.#teardown();
    await this.#disposePromise;
  }

  /** The one teardown pass: flush, unbind, close storage, free wasm. See {@link BlazeCache.dispose}. */
  async #teardown(): Promise<void> {
    // Stop listening first: a dispose handshake must not be mistaken for a live peer.
    this.#multiTab?.close();
    try {
      await this.flush();
    } finally {
      this.#disposed = true;
      if (this.#timer !== null) {
        clearTimeout(this.#timer);
        this.#timer = null;
      }
      for (const unbind of this.#unbind.splice(0)) unbind();
      this.#subs?.dispose(); // drops the subscription layer's listeners and mirrors
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

  // -------------------------------------------------------------- multi-tab (opt-in)

  /**
   * Attaches the optional cross-tab channel. Runs *after* persistence hydration so a tab that
   * woke up from IndexedDB can answer a peer's `hello` with its real state.
   */
  #setupMultiTab(spec: MultiTabOptions | undefined): void {
    if (!spec?.enabled) return;
    if (typeof spec.channel === 'string' && (spec.channel.length === 0 || spec.channel.includes('\0'))) {
      throw new RangeError('[blaze-cache] multiTab.channel must be a non-empty string without NUL.');
    }
    const strategy = spec.strategy ?? 'value';
    if (strategy !== 'value' && strategy !== 'invalidate') {
      throw new TypeError(`[blaze-cache] multiTab.strategy must be "value" or "invalidate", got ${String(strategy)}.`);
    }
    const self = this;
    this.#multiTab = new MultiTabSync<V>({
      channel: spec.channel ?? `blaze-cache:${this.#namespace}\0${this.#generation}`,
      generation: this.#generation,
      strategy,
      bridge: {
        applySet(key, value, ttlMs, tags) {
          self.#writeDirect(key, value as V, ttlMs, tags);
          if (self.#hasChangeConsumers) self.#notify({ type: 'set', key }, false);
        },
        applyDelete(key) {
          if (self.#deleteLocal(key) && self.#hasChangeConsumers) {
            self.#notify({ type: 'delete', key }, false);
          }
        },
        applyClear() {
          self.#wasm.clear();
          self.#ids.clear();
          self.#values.clear();
          self.#versions.clear();
          if (self.#hasChangeConsumers) self.#notify({ type: 'clear' }, false);
        },
        applyInvalidateTags(tags) {
          const removed = self.#wasm.invalidateTags(tags);
          self.#forgetKeys(removed);
          if (removed.length > 0 && self.#hasChangeConsumers) {
            self.#notify({ type: 'invalidate', keys: removed }, false);
          }
        },
        applyRotate(generation) {
          void self.#rotate(generation, false).catch((error: unknown) => {
            self.#notifyError(error, '[blaze-cache] remote rotate failed.');
          });
        },
        emitRemote(type, key, value) {
          self.#emitRemote(type, key, value);
        },
        snapshot() {
          return (self.#wasm.entries() as Array<{
            key: string;
            value: V;
            ttlMs: number | null;
            tags: string[];
          }>).map((entry) => ({
            key: entry.key,
            value: entry.value,
            ttlMs: entry.ttlMs,
            tags: entry.tags,
            version: self.#versions.get(entry.key),
          }));
        },
        versionOf(key) {
          return self.#versions.get(key);
        },
        setVersion(key, version) {
          self.#versions.set(key, version);
        },
        resetVersions() {
          self.#versions.clear();
        },
      },
    });
  }

  /** Emits a `remote-*` event, isolated by the bus exactly like every other listener. */
  #emitRemote(type: CacheEventType, key: string | null, value: V | undefined): void {
    if (!this.#events.hears(type)) return;
    switch (type) {
      case 'remote-set':
        this.#events.emit('remote-set', { type: 'remote-set', key: key!, value: value as V });
        break;
      case 'remote-delete':
        this.#events.emit('remote-delete', { type: 'remote-delete', key: key! });
        break;
      case 'remote-clear':
        this.#events.emit('remote-clear', { type: 'remote-clear' });
        break;
      case 'remote-invalidate':
        this.#events.emit('remote-invalidate', { type: 'remote-invalidate' });
        break;
      case 'remote-rotate':
        this.#events.emit('remote-rotate', { type: 'remote-rotate' });
        break;
    }
  }

  /** The un-notified half of `delete()`, shared with the remote-apply path. */
  #deleteLocal(key: string): boolean {
    let removed: boolean;
    if (this.#storage === 'js') {
      removed = this.#wasm.delete(key);
      if (removed) {
        const id = this.#ids.get(key);
        if (id !== undefined) this.#values.delete(id);
        this.#ids.delete(key);
      }
    } else if (this.#raw) {
      keyScratch.encode(key);
      removed = this.#wasm.deleteRaw(keyScratch.ptr, keyScratch.len);
    } else {
      removed = this.#wasm.delete(key);
    }
    return removed;
  }

  // ----------------------------------------------------------- persistence

  async #setupPersistence(spec: BlazeCacheOptions['persistence']): Promise<void> {
    if (!spec) return;

    // ---- validate everything before touching storage or the adapter ----------
    // Validated, not defaulted silently: a `debounceMs` of NaN would make every debounce
    // fire immediately, and `maxEntries: 0` would persist *everything* — `slice(-0)` is
    // the whole array, not the empty one. A caller who passes a bad number gets a loud
    // failure at `create` rather than a mysterious persistence behaviour later.
    const debounceMs = pickPaired(
      spec.debounceMs,
      spec.flushDelayMs,
      'debounceMs',
      'flushDelayMs',
    );
    if (debounceMs !== undefined && (!Number.isFinite(debounceMs) || debounceMs < 0)) {
      throw new RangeError(
        `[blaze-cache] persistence.debounceMs must be a finite number >= 0, got ${String(debounceMs)}.`,
      );
    }
    const maxEntries = pickPaired(spec.maxEntries, spec.maxRecords, 'maxEntries', 'maxRecords');
    if (maxEntries !== undefined && (!Number.isInteger(maxEntries) || maxEntries < 1)) {
      throw new RangeError(
        `[blaze-cache] persistence.maxEntries must be an integer >= 1, got ${String(maxEntries)}.`,
      );
    }
    const writeMode = spec.writeMode ?? 'debounce';
    if (writeMode !== 'debounce' && writeMode !== 'immediate') {
      throw new RangeError(
        `[blaze-cache] persistence.writeMode must be "debounce" or "immediate", got ${String(writeMode)}.`,
      );
    }
    if (spec.restoreExpired !== undefined && typeof spec.restoreExpired !== 'boolean') {
      throw new RangeError(
        `[blaze-cache] persistence.restoreExpired must be a boolean, got ${String(spec.restoreExpired)}.`,
      );
    }

    // ---- attach --------------------------------------------------------------
    // A custom adapter takes precedence; otherwise the built-in IndexedDB one — which
    // validates `namespace`/`generation` (no NUL characters) and throws from here, so a
    // bad isolation setup fails `create` loudly instead of misbehaving later.
    const adapter = spec.adapter ?? indexedDbPersistence(spec);
    this.#persist = adapter;
    this.#namespace = spec.namespace ?? 'default';
    this.#generation = spec.generation ?? '';
    this.#flushDelayMs = debounceMs ?? DEFAULT_FLUSH_DELAY_MS;
    this.#maxRecords = maxEntries ?? DEFAULT_MAX_RECORDS;
    this.#restoreExpired = spec.restoreExpired ?? false;
    this.#writeMode = writeMode;
    this.#onError = spec.onError;
    this.#onActivity = spec.onActivity;

    try {
      await this.#hydrate(adapter);
    } catch (error) {
      // Contained: an adapter that cannot open at all (private mode, enterprise policy)
      // degrades to memory-only instead of breaking `create`. The failure is still
      // recorded and handed to `onError`, so an operator watching persistence hears it.
      this.#persist = null;
      this.#recordError('hydrate', error);
      console.warn('[blaze-cache] persistence unavailable — running memory-only.', error);
      // The console.warn above already announced the degrade; `onError` only fires when
      // somebody asked to hear about failures, so the two never double-report.
      if (this.#onError) this.#notifyError(error);
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
   *
   * Two further guards make an explicit re-hydrate (`cache.persistence.hydrate()`, the
   * login half of an account switch) safe:
   *
   * * **Generation** — the pass snapshots the session before `load()` and discards the
   *   whole result if it changed while the read was in flight, so the previous account's
   *   records can never land in the next account's memory.
   * * **`restoreExpired: false`** (the default) keeps records that expired while the tab
   *   was away out of memory; `true` restores them with their original TTL window
   *   restarted from now — never with the non-positive remainder, which the wasm core
   *   would read as "never expires".
   *
   * A full-clear queued *before* this hydrate would erase exactly what was just loaded,
   * so it is dropped once the records land.
   */
  async #hydrate(adapter: CachePersistence): Promise<void> {
    const epoch = this.#epoch;
    const generation = this.#generation;
    const startedAt = Date.now();
    this.#activity({ type: 'hydrate-start', generation });

    const records = await adapter.load();
    if (epoch !== this.#epoch) {
      // The session changed under the read: these rows belong to a generation that no
      // longer exists. Discard them — storage still holds them for their own owner.
      this.#statAborted += 1;
      this.#activity({ type: 'hydrate-abort', generation });
      return;
    }

    const now = Date.now();
    let restored = 0;
    let skipped = 0;
    let reported = false;
    const skip = (reason: string, record: unknown, error?: unknown): void => {
      skipped += 1;
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
      // A delete queued before this hydrate is still an intent to remove the key. Loading
      // the row back into memory here would undo that delete, while the queued delete
      // would then erase the row from storage on the next flush — leaving memory and
      // storage disagreeing. Storage is the source being adopted, but a pending delete
      // wins over it; the delete stays queued so storage is cleaned as well.
      if (this.#deleted.has(record.key)) {
        skipped += 1;
        continue;
      }

      try {
        const remaining = record.ttlMs === null ? null : record.ttlMs - (now - record.storedAt);
        if (remaining !== null && remaining <= 0) {
          if (!this.#restoreExpired) {
            skipped += 1; // expired on purpose — not a malformed record, so no warning
            continue;
          }
          // Opt-in resurrection: the original TTL window, restarted from now. Fresh but
          // not forever — and never the dead remainder, which reads as "never expires".
          this.#writeDirect(record.key, record.value as V, record.ttlMs, record.tags);
          restored += 1;
          continue;
        }
        // Direct wasm call: hydration is not a user write, so it emits no event — nor any
        // change for persistence (the adapter it came from is already up to date).
        this.#writeDirect(record.key, record.value as V, remaining, record.tags);
        restored += 1;
      } catch (error) {
        skip('the wasm core refused the write', record, error);
      }
    }

    this.#clearAll = false;
    this.#statHydrates += 1;
    this.#statRestored += restored;
    this.#statSkipped += skipped;
    this.#statLastHydrateAt = Date.now();
    this.#activity({
      type: 'hydrate-finish',
      generation,
      restored,
      skipped,
      durationMs: Date.now() - startedAt,
    });
  }

  #bindPageLifecycle(): void {
    if (typeof window === 'undefined') return;
    const flush = () => {
      void this.flush().catch((error: unknown) => {
        this.#notifyError(error, '[blaze-cache] flush on page hide failed.');
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
    if (this.#disposed || this.#timer !== null) return;
    // `immediate` collapses the current task into one pass (a `setMany` of 100 entries
    // still writes once) instead of chaining one flush per mutation; `debounce` waits
    // out the window so a burst of writes coalesces by key.
    const delay = this.#writeMode === 'immediate' ? 0 : this.#flushDelayMs;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush().catch((error: unknown) => {
        this.#notifyError(error, '[blaze-cache] background flush failed.');
      });
    }, delay);
  }

  async #runFlush(): Promise<void> {
    const persist = this.#persist;
    if (!persist || this.#disposed) return;
    // Snapshot the session *now*: work claimed under an older generation than the one
    // currently active is dropped at every checkpoint below instead of being written,
    // requeued or reconciled (see `#epoch`).
    const epoch = this.#epoch;
    const generation = this.#generation;
    const startedAt = Date.now();

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

    this.#activity({
      type: 'flush-start',
      generation,
      records: dirty.length + deleted.length,
    });

    let toRemove = deleted;
    try {
      // Reconcile the rows the wasm core dropped on its own. A capacity eviction inside
      // `set` and a lapsed TTL never queue a delete for persistence — the `evict`/`expire`
      // events they emit reach subscribers only, and `prune`/`remove` callers may not have
      // persisted the key either — so without this diff their rows would outlive every
      // flush, be re-hydrated at the next startup, and eat quota until a
      // `QuotaExceededError` kills persistence outright.
      // Any key storage still holds that the wasm core no longer lists is stale. Skipped
      // after `clear()` (storage was just emptied) and for adapters without `keys()`.
      // It runs *before* the write: a row the upcoming `save` would add belongs to a live
      // key (that is why it is dirty), so it can never come back stale here.
      if (!clearAll && typeof persist.keys === 'function') {
        const persisted = await persist.keys();
        if (epoch !== this.#epoch) return this.#abortPass(generation);
        // Read the live set *after* the await, so a `set` landing mid-pass counts as live
        // and keeps its row — and nothing awaits before the write, so the diff cannot go
        // stale under our feet.
        const live = new Set(this.#wasm.keys());
        const stale = persisted.filter((key) => !live.has(key));
        if (stale.length > 0) toRemove = [...new Set([...deleted, ...stale])];
      }

      const records: PersistedRecord[] = [];
      for (const key of dirty.slice(-this.#maxRecords)) {
        const entry = this.#entryFor(key);
        if (!entry) continue;
        records.push({
          key,
          value: entry.value,
          tags: entry.tags,
          ttlMs: entry.ttlMs,
          storedAt: Date.now(),
        });
      }

      // One last synchronous guard: a key re-`set` while the pass was awaiting belongs to
      // the *next* pass's `save`, so removing its row here would only open a window where
      // memory and storage disagree.
      const targets = toRemove.filter((key) => !this.#dirty.has(key));

      if (clearAll || records.length > 0 || targets.length > 0) {
        if (typeof persist.write === 'function') {
          // One batch, one transaction: `clear` + upserts + deletes commit together
          // instead of serialising as up to three separate round trips.
          await persist.write({ clear: clearAll, save: records, remove: targets });
        } else {
          if (clearAll) await persist.clear();
          if (records.length > 0) await persist.save(records);
          if (targets.length > 0) await persist.remove(targets);
        }
      }
      if (epoch !== this.#epoch) return this.#abortPass(generation);

      // The pass completed — every strike from earlier failures is forgiven (a temporary
      // quota pinch must not accumulate toward dropping a key).
      this.#failedFlushes.clear();
      this.#statFlushes += 1;
      this.#statRecordsWritten += records.length;
      this.#statLastFlushAt = Date.now();
      this.#activity({
        type: 'flush-finish',
        generation,
        records: records.length,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      // The session changed while the adapter was failing: the error belongs to a
      // generation that no longer exists, and so does the work it was doing. Drop both —
      // requeueing would write the previous account's records into the next account's
      // storage on some later flush.
      if (epoch !== this.#epoch) return this.#abortPass(generation);

      // Recorded for `stats()`/`onActivity`; the rejection below still reaches whoever
      // awaited this flush (background passes route it to `onError` in their `catch`).
      this.#recordError('flush', error);

      // Hand back exactly what this pass claimed. Concurrent work that landed during the
      // awaits is kept as-is, and the two queues stay disjoint — a key the runner may have
      // touched in the meantime belongs to whoever claimed it last.
      if (clearAll) this.#clearAll = true;
      // Quarantine: a batch that rejects blames no single key, but a *persistently* failing
      // key (an unserializable value, an adapter that rejects one specific record) would
      // otherwise requeue forever — every flush rejects, every flush requeues, and no later
      // write ever reaches storage. Each claimed key earns one strike per failed pass; a key
      // with `MAX_FAILED_FLUSHES` consecutive strikes is dropped from the queues with a
      // warning instead of requeued. Any successful pass clears all strikes, so a
      // temporarily full quota never permanently loses data.
      for (const key of dirty) {
        // Deleted while we were awaiting? Its delete bookkeeping is already queued — don't
        // resurrect it on the dirty side.
        if (this.#deleted.has(key)) continue;
        const strikes = (this.#failedFlushes.get(key) ?? 0) + 1;
        if (strikes >= MAX_FAILED_FLUSHES) {
          this.#failedFlushes.delete(key);
          console.warn(
            `[blaze-cache] dropping "${key}" from persistence after ${strikes} failed flushes — the entry stays in memory only.`,
            error,
          );
        } else {
          this.#failedFlushes.set(key, strikes);
          this.#dirty.add(key);
        }
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
   * Ends a pass whose session disappeared mid-flight: the claimed work is discarded (it
   * was never requeued), nothing else runs, and the flush resolves — a stale write must
   * not surface as an error to whoever awaited it, nor as one to the new session.
   */
  #abortPass(generation: string): void {
    this.#statAborted += 1;
    this.#activity({ type: 'flush-abort', generation });
  }

  // ------------------------------------------------------- persistence control

  /**
   * `persistence.clear()` — empties this namespace in storage and drops every queued
   * write, without touching the cache's memory.
   *
   * Queues are dropped twice: once synchronously (so work nobody claimed yet never
   * reaches storage) and again inside the serialised pass (because an in-flight flush
   * that *fails* hands its claimed records back after our first drop). The storage wipe
   * runs on the same chain, so it always lands after writes already in flight — the
   * final state of storage is empty, not "empty, then rewritten by the pass that was
   * already running".
   */
  async #controlClear(): Promise<void> {
    const persist = this.#persist;
    if (!persist || this.#disposed) return;

    const dropQueued = (): void => {
      this.#dirty.clear();
      this.#deleted.clear();
      this.#clearAll = false;
      this.#failedFlushes.clear();
      if (this.#timer !== null) {
        clearTimeout(this.#timer);
        this.#timer = null;
      }
    };
    dropQueued();

    const run = async (): Promise<void> => {
      dropQueued();
      try {
        await persist.clear();
      } catch (error) {
        this.#recordError('clear', error);
        throw error;
      }
    };
    // Chain instead of guarding: clearing while a flush is in flight must serialise
    // behind it, exactly like two `flush()` calls do. A rejection leaves the chain
    // rejected, which the next `flush()` recovers from (it attaches both handlers).
    this.#chain = this.#chain.then(run, run);
    return this.#chain;
  }

  /**
   * `persistence.hydrate()` — reloads stored records into memory, serialised behind any
   * write already in flight. Merge, not replace: memory-only entries survive, which is
   * what makes it usable as a "storage caught up, pull it in" call. A failure rejects
   * *this* promise (the caller asked for the read) while leaving persistence attached
   * and the chain healthy — core reads and writes are never affected.
   */
  #controlHydrate(): Promise<void> {
    const persist = this.#persist;
    if (!persist || this.#disposed) return Promise.resolve();

    const run = async (): Promise<void> => {
      try {
        await this.#hydrate(persist);
      } catch (error) {
        this.#recordError('hydrate', error);
        throw error;
      }
    };
    const result = this.#chain.then(run, run);
    // The chain must outlive a rejected hydrate: swallow the failure *there* while the
    // caller still receives the original rejection from `result`.
    this.#chain = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /**
   * `persistence.rotate(generation)` — the logout/login switch.
   *
   * The epoch bump, the queue drop and the timer cancel all happen **synchronously**,
   * before the first `await`: from this instant every pass still in flight fails its
   * next epoch check and drops its claimed work, and every queued write belongs to a
   * session that no longer exists. The adapter then adopts the new generation — its
   * already-running operations keep the bucket they snapshotted, so a save that lands
   * after this call writes into the *previous* generation's rows, which the new
   * generation can never load.
   *
   * Memory is deliberately untouched: entries left behind by the old session are the
   * caller's to drop (`cache.clear()`), and a full-clear queued by that call is already
   * neutralised here — the queues it would have set are gone.
   */
  async #rotate(generation: string, publish = true): Promise<void> {
    if (typeof generation !== 'string') {
      throw new TypeError(
        `[blaze-cache] persistence.rotate expects a string generation, got ${typeof generation}.`,
      );
    }
    if (generation.includes('\0')) {
      throw new RangeError(
        '[blaze-cache] persistence.rotate: a generation must not contain a NUL character ("\\0").',
      );
    }
    if (this.#disposed) return;

    // --- synchronous invalidation: everything below runs before any await ---
    this.#epoch += 1;
    this.#generation = generation;
    this.#dirty.clear();
    this.#deleted.clear();
    this.#clearAll = false;
    this.#failedFlushes.clear();
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }

    const persist = this.#persist;
    if (persist?.rotate) {
      try {
        await persist.rotate(generation);
      } catch (error) {
        // The cache-side isolation is already active (epoch + dropped queues); only the
        // adapter's bucket switch failed, so report it and let the caller decide.
        this.#recordError('rotate', error);
        throw error;
      }
    }
    this.#statRotations += 1;
    this.#activity({ type: 'rotate', generation });
    if (publish) {
      this.#multiTab?.publishRotate(generation);
      this.#multiTab?.markEpoch();
    }
  }

  /** A fresh snapshot of the counters behind `persistence.stats()`. */
  #persistenceStats(): PersistenceStats {
    return {
      enabled: this.#persist !== null,
      namespace: this.#namespace,
      generation: this.#generation,
      pending: this.#dirty.size + this.#deleted.size + (this.#clearAll ? 1 : 0),
      hydrates: this.#statHydrates,
      restored: this.#statRestored,
      skipped: this.#statSkipped,
      flushes: this.#statFlushes,
      recordsWritten: this.#statRecordsWritten,
      aborted: this.#statAborted,
      rotations: this.#statRotations,
      errors: this.#statErrors,
      lastError: this.#statLastError,
      lastFlushAt: this.#statLastFlushAt,
      lastHydrateAt: this.#statLastHydrateAt,
    };
  }

  /**
   * Hands one failure to the `onActivity` observer. Never throws: a broken observer must
   * not be able to take down the persistence layer it is observing.
   */
  #activity(activity: PersistenceActivity): void {
    const onActivity = this.#onActivity;
    if (!onActivity) return;
    try {
      onActivity(activity);
    } catch (error) {
      console.error('[blaze-cache] persistence onActivity observer failed.', error);
    }
  }

  /** Counts one failure for `stats()` and the activity stream. */
  #recordError(phase: PersistenceErrorPhase, error: unknown): void {
    this.#statErrors += 1;
    this.#statLastError = error;
    this.#activity({ type: 'error', phase, error });
  }

  /**
   * Routes a failure **nobody awaited** — the debounced timer's flush, the pagehide
   * flush, the startup degrade — to `onError`, falling back to `console.error` when no
   * observer was given. Awaited calls (`flush()`, `hydrate()`, `clear()`, `rotate()`)
   * reject instead and never come through here; they are already recorded for
   * `stats()`/`onActivity` by whoever failed.
   */
  #notifyError(error: unknown, message = '[blaze-cache] persistence failed.'): void {
    const onError = this.#onError;
    if (!onError) {
      console.error(message, error);
      return;
    }
    try {
      onError(error);
    } catch (observerError) {
      console.error('[blaze-cache] persistence onError observer failed.', observerError);
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
    return this.#events.size > 0 || this.#persist !== null || this.#multiTab?.active === true;
  }

  /**
   * Bookkeeping + event delivery for a mutation.
   *
   * `publish` is `false` only for mutations applied *from* another tab: those still wake local
   * listeners and the persistence queue, but are never sent back to the channel. That single
   * flag is what makes echo storms impossible.
   */
  #notify(change: CacheChange, publish = true): void {
    const sync = this.#multiTab;
    if (publish && sync?.active) {
      switch (change.type) {
        case 'set': {
          const entry = this.#entryFor(change.key);
          sync.publishSet(
            change.key,
            entry?.value,
            entry?.ttlMs ?? null,
            entry?.tags ?? [],
          );
          const version = sync.lastVersion;
          if (version) this.#versions.set(change.key, version);
          break;
        }
        case 'touch': {
          const entry = this.#entryFor(change.key);
          sync.publishSet(change.key, entry?.value, entry?.ttlMs ?? null, entry?.tags ?? []);
          const version = sync.lastVersion;
          if (version) this.#versions.set(change.key, version);
          break;
        }
        case 'delete': {
          sync.publishDelete(change.key);
          const version = sync.lastVersion;
          if (version) this.#versions.set(change.key, version);
          break;
        }
        case 'clear':
          sync.publishClear();
          sync.markEpoch();
          this.#versions.clear();
          break;
        case 'invalidate':
        case 'prune':
          // Invalidation publishes the original tag list from `invalidateTags()` itself (the
          // change only carries keys). `prune` is a local reclamation — no peer needs it.
          break;
      }
    }

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

  // ------------------------------------------------- JS-authoritative internals (storage: 'js')

  /** Drops a key/id pair from the local value store. Idempotent. */
  #forget(key: string, id: number): void {
    this.#values.delete(id);
    this.#ids.delete(key);
  }

  /** Same, for a batch of keys returned by wasm. */
  #forgetKeys(keys: string[]): void {
    for (const key of keys) {
      const id = this.#ids.get(key);
      if (id !== undefined) this.#values.delete(id);
      this.#ids.delete(key);
    }
  }

  /** Full entry with the value from the right store — used by `entry()` and persistence. */
  #entryFor(key: string): CacheEntry<V> | undefined {
    if (this.#storage === 'js') {
      const meta = this.#wasm.entryMeta(key) as
        | { key: string; id: number; ttlMs: number | null; tags: string[] }
        | undefined;
      if (!meta) return undefined;
      return {
        key: meta.key,
        value: this.#values.get(meta.id) as V,
        ttlMs: meta.ttlMs,
        tags: meta.tags,
      };
    }
    return this.#wasm.entry(key) as CacheEntry<V> | undefined;
  }

  /** A write from hydrate: metadata + value, with no event or persistence bookkeeping. */
  #writeDirect(key: string, value: V, ttlMs: number | null, tags: readonly string[]): void {
    if (this.#storage === 'js') {
      const id = this.#wasm.setMeta(key, ttlMs, tags as string[]);
      this.#values.set(id, value);
      this.#ids.set(key, id);
    } else {
      this.#wasm.set(key, value, ttlMs, tags as string[]);
    }
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
      id: number;
      key: string;
      value: V;
      reason: 'evict' | 'expire';
    }>;
    for (let i = 0; i < drops.length; i += 1) {
      const { id, key, reason } = drops[i]!;
      // The wasm drop's `value` is a sentinel in JS-authoritative mode; the real value lives
      // in `#values` under the id the core now reports. Release it and deliver it to listeners
      // exactly as in wasm mode, so `evict`/`expire` stay indistinguishable to callers.
      const value = (this.#storage === 'js' ? this.#values.get(id) : drops[i]!.value) as V;
      if (this.#storage === 'js') this.#forget(key, id);
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
    // In JS-authoritative mode the drop log is structural (it drives Map cleanup), not just
    // an observer convenience — it must stay on even with zero event listeners.
    const wanted = this.#storage === 'js' || this.#events.wantsDrops;
    if (wanted === this.#dropTracking) return;
    this.#dropTracking = wanted;
    this.#wasm.setDropTracking(wanted);
  }
}

/** Shorthand for {@link BlazeCache.create}. */
export function createCache<V = any>(options?: BlazeCacheOptions): Promise<BlazeCache<V>> {
  return BlazeCache.create<V>(options);
}
