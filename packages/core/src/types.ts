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
 */
export type CacheChange =
  | { type: 'set'; key: string }
  | { type: 'touch'; key: string }
  | { type: 'delete'; key: string }
  | { type: 'clear' }
  | { type: 'invalidate'; keys: string[] }
  | { type: 'prune'; keys: string[] };

/** Subscriber registered through {@link BlazeCache.on}. */
export type CacheListener = (change: CacheChange) => void;

/**
 * The structural contract the Axios adapter and the React Query integration program against.
 *
 * They accept any object with these methods — the concrete {@link BlazeCache}, or a wrapper
 * of your own (a `Map` shim, a test double, …).
 *
 * The value type defaults to `any` on purpose: adapters store their own record shapes in a
 * cache that may be shared. Type it explicitly (`BlazeCacheLike<AxiosCacheRecord>`) when you
 * want the compiler to check both directions.
 */
export interface BlazeCacheLike<V = any> {
  get(key: string): V | undefined;
  set(key: string, value: V, options?: SetOptions): void;
  has(key: string): boolean;
  delete(key: string): boolean;
  /** Number of entries that are present **and** not expired. */
  size(): number;
}
