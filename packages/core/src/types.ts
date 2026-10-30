/**
 * Options applied to a single write.
 */
export interface SetOptions {
  /**
   * Milliseconds until the entry expires.
   *
   * `undefined`, `0`, negatives and `NaN` all mean **"never expires"** — matching the Rust
   * core, where a `Duration::ZERO` TTL would otherwise create an instantly-dead entry.
   * Callers that mean "do not cache this" should simply not call `set`.
   */
  ttlMs?: number;
  /** Tag names, used for bulk removal through `invalidateTags`. */
  tags?: readonly string[];
}

/**
 * One entry in a {@link BlazeCache.setMany} batch.
 */
export interface SetManyEntry<V = any> {
  key: string;
  value: V;
  options?: SetOptions;
}

/**
 * Options applied to a single {@link BlazeCache.touch}.
 */
export interface TouchOptions {
  /**
   * Milliseconds until the entry expires, counted **from this moment**.
   *
   * Omit it (or pass `undefined`) to leave the existing deadline exactly as it is. `0`,
   * negatives and `NaN` drop the deadline altogether — the entry then lives until evicted,
   * which is how {@link SetOptions.ttlMs} reads those same values.
   */
  ttlMs?: number;
}

/**
 * A snapshot of the cache's counters.
 *
 * `hits`/`misses`/`evictions`/`expirations`/`invalidations` are cumulative since the last
 * reset; `size`/`capacity` describe the current moment.
 */
export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
  invalidations: number;
  size: number;
  capacity: number;
  /** `hits / (hits + misses)`, or `0` when nothing has been read yet. */
  hitRate: number;
}

/**
 * A live entry as returned by {@link BlazeCache.entry} and {@link BlazeCache.entries}.
 */
export interface CacheEntry<V = unknown> {
  key: string;
  value: V;
  /** Milliseconds of TTL left, or `null` when the entry never expires. */
  ttlMs: number | null;
  tags: string[];
}

/**
 * Emitted by every mutating operation — this is what drives write-through persistence and
 * lets you keep other layers (React state, devtools, IndexedDB) in sync.
 *
 * @deprecated The mutation-only subset of {@link CacheEventMap}. Kept for code written
 * against the original `on(listener)` API; new code should discriminate on
 * {@link CacheEvent}, which adds `hit`/`miss`/`evict`/`expire`.
 */
export type CacheChange =
  | { type: 'set'; key: string }
  | { type: 'touch'; key: string }
  | { type: 'delete'; key: string }
  | { type: 'clear' }
  | { type: 'invalidate'; keys: string[] }
  | { type: 'prune'; keys: string[] };

/**
 * Every event type the cache emits.
 *
 * | Event | Emitted when |
 * | --- | --- |
 * | `set` | a key was stored (insert **or** replace) |
 * | `delete` | a key was removed and was present |
 * | `clear` | the cache was emptied |
 * | `invalidate` | {@link BlazeCache.invalidateTags} removed entries |
 * | `prune` | {@link BlazeCache.prune} removed expired entries |
 * | `touch` | {@link BlazeCache.touch} renewed a live entry's deadline |
 * | `evict` | **the core** dropped an entry to stay within capacity |
 * | `expire` | **the core** reclaimed an entry whose TTL elapsed |
 * | `hit` | {@link BlazeCache.get} / {@link BlazeCache.getMany} found a live entry |
 * | `miss` | a lookup found nothing (absent **or** expired) |
 *
 * `evict` and `expire` are produced by the Rust/Wasm core itself — see *Events* on
 * {@link BlazeCache}.
 */
export type CacheEventType =
  | 'set'
  | 'delete'
  | 'clear'
  | 'invalidate'
  | 'prune'
  | 'touch'
  | 'evict'
  | 'expire'
  | 'hit'
  | 'miss';

/**
 * Per-event payload shapes, keyed by {@link CacheEventType}.
 *
 * The `type` field is a literal, so a listener that switches on it narrows the event
 * automatically:
 *
 * ```ts
 * cache.on((event) => {
 *   if (event.type === 'evict') console.log(event.key, event.value);
 * });
 * ```
 */
export interface CacheEventMap<V = any> {
  set: { type: 'set'; key: string };
  delete: { type: 'delete'; key: string };
  clear: { type: 'clear' };
  invalidate: { type: 'invalidate'; keys: string[] };
  prune: { type: 'prune'; keys: string[] };
  touch: { type: 'touch'; key: string };
  /** The cache reclaimed this entry by itself: capacity pressure picked it. */
  evict: { type: 'evict'; key: string; value: V };
  /** The cache reclaimed this entry by itself: its TTL elapsed. */
  expire: { type: 'expire'; key: string; value: V };
  /** A lookup found the entry. `value` is the cache's live reference. */
  hit: { type: 'hit'; key: string; value: V };
  /** A lookup found nothing — the key was absent or expired. */
  miss: { type: 'miss'; key: string };
}

/** One event of any type — what a wildcard listener receives. */
export type CacheEvent<V = any> = CacheEventMap<V>[CacheEventType];

/**
 * A listener for one event type — or, with `K` left at its default, for **every** event.
 *
 * ```ts
 * cache.on('evict', (event) => console.log(event.key, event.value)); // typed to `evict`
 * cache.on((event) => console.log(event.type));                      // wildcard union
 * ```
 */
export type CacheEventListener<V = any, K extends CacheEventType = CacheEventType> = (
  event: CacheEventMap<V>[K],
) => void;

/**
 * @deprecated The original `on(listener)` signature — a function taking one
 * {@link CacheChange}. Kept verbatim so existing annotations keep compiling; note that at
 * runtime a bare `on(listener)` is now a **wildcard** and also receives `hit`/`miss`/
 * `evict`/`expire`, so discriminate on `event.type` (or widen the annotation to
 * {@link CacheEventListener}) before reading fields shared by mutation events only.
 */
export type CacheListener = (change: CacheChange) => void;

/**
 * The structural contract the Axios adapter and the React Query integration program against.
 *
 * They accept any object with these methods — the concrete {@link BlazeCache}, or a wrapper
 * of your own (a `Map` shim, a test double, …).
 *
 * The value type defaults to `any` on purpose: adapters store their own record shapes in a
 * cache that may be shared. Type it explicitly (`BlazeCacheLike<AxiosCacheRecord>`) when you
 * want the compiler to check both sides.
 */
export interface BlazeCacheLike<V = any> {
  get(key: string): V | undefined;
  set(key: string, value: V, options?: SetOptions): void;
  has(key: string): boolean;
  delete(key: string): boolean;
  /** Number of entries that are present **and** not expired. */
  size(): number;

  // ---------------------------------------------------------------- batch operations

  /**
   * Batch lookup: returns the value for each key, or `undefined` when missing/expired.
   * Crosses the wasm boundary once instead of once per key.
   */
  getMany(keys: string[]): (V | undefined)[];

  /**
   * Batch existence check: returns `true` for each key that is present and not expired.
   * Crosses the wasm boundary once instead of once per key.
   */
  hasMany(keys: string[]): boolean[];

  /**
   * Batch write: stores every key/value pair in one wasm boundary crossing.
   */
  setMany(entries: SetManyEntry<V>[]): void;

  /**
   * Batch delete: removes every key, returning `true` for each key that was present.
   * Crosses the wasm boundary once instead of once per key.
   */
  deleteMany(keys: string[]): boolean[];
}
