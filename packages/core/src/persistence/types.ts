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
 * The batch one flush wants to apply — what {@link CachePersistence.write} receives.
 *
 * The three parts are disjoint by construction (`remove` never contains a key the same
 * pass also saves), so an adapter may apply them in any order it likes as long as `clear`
 * is honoured **before** the other two.
 */
export interface PersistenceWriteOps {
  /** `true` when the namespace must be emptied before `save` lands. */
  clear?: boolean;
  /** Records to upsert (last write wins per key). */
  save: PersistedRecord[];
  /** Keys whose rows must be deleted. */
  remove: string[];
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
  /**
   * Every record key currently stored for this cache's namespace.
   *
   * Optional, and only needed for reconciliation: the wasm core drops entries on its own —
   * a capacity eviction or a lapsed TTL never produces a change event — so those rows would
   * otherwise sit in storage until quota runs out. A flush compares this list against the
   * live keys and calls {@link CachePersistence.remove} for the difference.
   *
   * Adapters that do not implement it keep working exactly as before; they simply skip the
   * diff, and any explicit `delete`/`invalidateTags`/`prune` still reaches `remove`.
   */
  keys?(): Promise<string[]>;
  /**
   * Applies a whole flush — `clear` + `save` + `remove` — as **one unit of work**.
   *
   * Optional. When present the cache hands the entire batch over instead of calling
   * `clear`/`save`/`remove` separately, which turns a flush of up to three IndexedDB
   * transactions into one. The adapter must make the batch atomic: either every part
   * lands or none does (the built-in adapter aborts its transaction on failure).
   */
  write?(ops: PersistenceWriteOps): Promise<void>;
  /**
   * Adopts a new persistence **generation** — the session/account token that isolates
   * one login from the next. Optional.
   *
   * Called by `cache.persistence.rotate(generation)` *after* the cache has already
   * invalidated every queued and in-flight operation from the previous generation.
   * Implementations must guarantee that an operation already in flight continues to
   * read and write the **previous** generation's bucket (the built-in adapter snapshots
   * its effective namespace per operation, so a late write lands there and is invisible
   * to the new generation). Rows already stored are left alone — call `clear()` before
   * `rotate()` to wipe them.
   *
   * Adapters without it still get the cache-level protection (queued and in-flight
   * flushes are dropped on rotation), but their stored rows are not namespaced by
   * generation.
   */
  rotate?(generation: string): void | Promise<void>;
  /** Releases any underlying handle. */
  close?(): void | Promise<void>;
}

/** How queued writes reach storage. */
export type PersistenceWriteMode =
  /** Coalesce writes and flush once the debounce window (`debounceMs`) elapses. */
  | 'debounce'
  /** Flush on the next task after a mutation — no debounce window. */
  | 'immediate';

/** The phase a {@link PersistenceActivity} `error` event belongs to. */
export type PersistenceErrorPhase = 'hydrate' | 'flush' | 'clear' | 'rotate';

/**
 * Persistence activity, as reported by the `onActivity` option.
 *
 * The observability channel for the write-through layer: hydrate start/finish, flush
 * start/finish, a flush invalidated by a generation change, and contained errors. It is
 * deliberately separate from the cache's event bus — persistence activity is not a cache
 * mutation, and wildcard listeners must not start waking up for it.
 */
export type PersistenceActivity =
  | { type: 'hydrate-start'; generation: string }
  | {
      type: 'hydrate-finish';
      generation: string;
      /** Records that made it into memory. */
      restored: number;
      /** Records skipped (malformed, expired, unreadable). */
      skipped: number;
      durationMs: number;
    }
  /** The generation changed while a hydrate was loading — its records were discarded. */
  | { type: 'hydrate-abort'; generation: string }
  | { type: 'flush-start'; generation: string; records: number }
  | { type: 'flush-finish'; generation: string; records: number; durationMs: number }
  /** The generation changed mid-flush — the pass' claimed work was dropped. */
  | { type: 'flush-abort'; generation: string }
  | { type: 'rotate'; generation: string }
  | { type: 'error'; phase: PersistenceErrorPhase; error: unknown };

/**
 * A snapshot of persistence's current state and cumulative counters — what
 * `cache.persistence.stats()` returns.
 *
 * The counters are cumulative for the lifetime of the cache instance; the `last*`
 * timestamps are `Date.now()` values (or `null` when the phase has not run yet).
 */
export interface PersistenceStats {
  /** `false` when persistence was never attached (or was disabled after a startup failure). */
  enabled: boolean;
  /** The configured namespace — `'default'` when none was given. */
  namespace: string;
  /** The current session generation; `''` when no generation is in use. */
  generation: string;
  /** Writes queued right now: dirty keys + pending deletes (+1 for a pending full clear). */
  pending: number;
  /** Hydrates that completed. */
  hydrates: number;
  /** Records restored into memory across all hydrates. */
  restored: number;
  /** Records skipped across all hydrates — malformed, expired or unreadable. */
  skipped: number;
  /** Flush passes that completed. */
  flushes: number;
  /** Records written across all completed flushes. */
  recordsWritten: number;
  /** Flushes/hydrates dropped because the generation changed mid-flight. */
  aborted: number;
  /** Successful {@link PersistenceControl.rotate} calls. */
  rotations: number;
  /** Failures the cache saw (they still reject the awaited call, when there is one). */
  errors: number;
  /** The most recent failure, or `null`. */
  lastError: unknown;
  /** `Date.now()` of the last completed flush, or `null`. */
  lastFlushAt: number | null;
  /** `Date.now()` of the last completed hydrate, or `null`. */
  lastHydrateAt: number | null;
}

/**
 * The persistence control surface — `cache.persistence`.
 *
 * Every method is safe to call on a cache created without persistence: they resolve as
 * no-ops and `stats()` reports `enabled: false`, so application code never has to branch.
 */
export interface PersistenceControl {
  /** `true` while a storage adapter is attached. */
  readonly enabled: boolean;
  /** The current session generation; `''` when none is in use. */
  readonly generation: string;
  /** Writes pending changes to storage now — same as `cache.flush()`. */
  flush(): Promise<void>;
  /**
   * Empties this namespace in storage **and** drops every queued write, without touching
   * the cache's memory. Rows written by other namespaces are left alone.
   */
  clear(): Promise<void>;
  /**
   * Reloads stored records into memory (merge, not replace: memory-only entries survive).
   * A queued full-clear that predates the call is dropped — storage was just adopted
   * as-is, and clearing it again would contradict that.
   */
  hydrate(): Promise<void>;
  /** A snapshot of persistence's state and counters. */
  stats(): PersistenceStats;
  /**
   * Rotates the persistence generation — call this on logout/login.
   *
   * Invalidates every write queued by the previous session **and** every operation still
   * in flight (a late save can no longer repopulate the next session's storage), then
   * hands the new generation to the adapter. Memory is left alone: pair it with
   * `cache.clear()` for a full account switch.
   */
  rotate(generation: string): Promise<void>;
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
   *
   * Must not contain a NUL character (`\0`) — it is the separator the composite primary
   * key is built from. For per-account isolation prefer {@link generation}, which can be
   * rotated in place; baking the account into the namespace also works but orphans the
   * previous account's rows instead of keeping them one rotation away.
   */
  namespace?: string;
  /**
   * Session/account token folded into the stored key space, isolating one login from the
   * next. Default `''` (the plain namespace, exactly as before generations existed).
   *
   * Rows written under one generation are invisible to every other: `load`, `keys`,
   * `clear` and a late in-flight write all stay inside the bucket they started in.
   * Change it through `cache.persistence.rotate()` rather than by hand.
   */
  generation?: string;
}

/**
 * Every option `createCache({ persistence })` accepts — one shape for the built-in
 * IndexedDB adapter and for custom {@link CachePersistence} adapters alike.
 *
 * ```ts
 * const cache = await createCache({
 *   persistence: {
 *     namespace: 'app:v1',        // isolate this cache from others in the database
 *     debounceMs: 50,             // coalesce writes for 50 ms before hitting storage
 *     maxEntries: 2000,           // cap on records written by a single flush
 *     restoreExpired: false,      // never resurrect records that expired while away
 *     writeMode: 'debounce',      // or 'immediate' — flush on the next task
 *     onError: (err) => report(err),       // failures nobody awaited
 *     onActivity: (a) => debug(a),         // hydrate/flush/rotate lifecycle
 *   },
 * });
 * ```
 */
export interface PersistenceOptions extends IndexedDbOptions {
  /**
   * Custom storage implementation. Omit it (keeping `namespace`/`database`/…) to use the
   * built-in IndexedDB adapter.
   */
  adapter?: CachePersistence;
  /**
   * How long a write waits for more writes before reaching storage. Default `400`.
   * Must be a finite number `>= 0`.
   *
   * The window is where write coalescing happens: repeated writes to the same key inside
   * it produce **one** row, with the final value.
   */
  debounceMs?: number;
  /**
   * Legacy spelling of {@link debounceMs}. Keep one of the two — passing both with
   * different values throws a `RangeError` from `create`.
   *
   * @deprecated Rename to `debounceMs`; this alias still works and will keep working.
   */
  flushDelayMs?: number;
  /**
   * Upper bound on the records a single flush writes (the newest `maxEntries` dirty keys
   * win). Default `2000`. Must be an integer `>= 1`.
   */
  maxEntries?: number;
  /**
   * Legacy spelling of {@link maxEntries}. Keep one of the two — passing both with
   * different values throws a `RangeError` from `create`.
   *
   * @deprecated Rename to `maxEntries`; this alias still works and will keep working.
   */
  maxRecords?: number;
  /**
   * Whether records whose TTL elapsed while the tab was away are restored on hydrate.
   * Default `false` — an expired record stays gone.
   *
   * `true` restores them with their **original TTL window restarted from now** (fresh,
   * but not forever). It is never restored with the expired remainder: a non-positive
   * TTL reads as "never expires" to the wasm core, which would turn a dead record into
   * an immortal one.
   */
  restoreExpired?: boolean;
  /**
   * `'debounce'` (default) waits {@link debounceMs} before writing;
   * `'immediate'` flushes on the next task after a mutation — no debounce window, while
   * still coalescing everything written within the current task into one pass.
   */
  writeMode?: PersistenceWriteMode;
  /**
   * Called for persistence failures **nobody awaited** — the debounced timer's flush, the
   * pagehide flush, and a startup that had to fall back to memory-only. Awaited calls
   * (`flush()`, `clear()`, `hydrate()`, `rotate()`) still reject with the same error, so
   * treat this as an observability hook rather than the only error path.
   *
   * When absent, those failures go to `console.error` as before.
   */
  onError?: (error: unknown) => void;
  /**
   * Called for persistence activity: hydrate start/finish, flush start/finish, passes
   * aborted by a {@link PersistenceControl.rotate}, rotations and errors. See
   * {@link PersistenceActivity} for the exact shapes.
   *
   * This channel is separate from the cache's event bus on purpose: persistence activity
   * is not a cache mutation, and a wildcard `cache.on(listener)` must not start waking
   * up for it. An observer that throws is isolated (logged, never propagated).
   */
  onActivity?: (activity: PersistenceActivity) => void;
}
