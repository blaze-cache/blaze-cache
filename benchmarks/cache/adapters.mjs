/**
 * The caches under test.
 *
 * Every adapter exposes the same synchronous surface — `get`, `set(key, value, options?)`,
 * `delete`, `size`, `clear`, `dispose` (plus `invalidateTags`, where the scenario needs it)
 * — as a class whose methods delegate to the backing store. Giving *all three* the same
 * one-call-deep wrapper keeps the comparison honest: none of them gets to skip the method
 * call the others pay, and what is left over in the timings is the store itself.
 *
 * `set` accepts blaze's `{ ttlMs, tags }` options throughout. A store with no native notion
 * of a deadline or a tag is wrapped (`withTtl`, `withTags`) rather than silently ignoring
 * them — otherwise the benchmark would credit blaze with work its rivals never attempted.
 * Where a library *does* implement the feature natively (QuickLRU's `maxAge`), it uses that
 * native path: no hand-rolled stand-in is ever put up against a built-in.
 *
 * The labels are what the results table prints, so they carry the caveats that matter:
 * `Map` has no eviction policy and no TTL, and `QuickLRU` holds between `maxSize` and
 * `2 × maxSize` by design (see its README).
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import QuickLRU from 'quick-lru';

import { createCache } from '@blaze-cache/core';

const require = createRequire(import.meta.url);

/**
 * Bytes of the `.wasm` binary, read once.
 *
 * Node cannot `fetch()` a `file:` URL — which is the browser-only default baked into
 * `wasmUrl` — so the bytes are resolved through the package's own `./pkg/*` export and
 * handed to `createCache` explicitly, exactly as the core smoke tests do.
 */
let wasmBytesPromise = null;
function wasmBytes() {
  wasmBytesPromise ??= readFile(
    require.resolve('@blaze-cache/core/pkg/blaze_cache_wasm_bg.wasm'),
  );
  return wasmBytesPromise;
}

// ------------------------------------------------------------------ stores

/** The native `Map`: the floor every other adapter is measured against. */
class MapAdapter {
  #map = new Map();

  get(key) {
    return this.#map.get(key);
  }

  set(key, value) {
    this.#map.set(key, value);
  }

  delete(key) {
    return this.#map.delete(key);
  }

  size() {
    return this.#map.size;
  }

  clear() {
    this.#map.clear();
  }

  dispose() {}

  // ---------------------------------------------------------------- batch

  getMany(keys) {
    return keys.map((key) => this.#map.get(key));
  }

  setMany(entries) {
    for (const { key, value } of entries) this.#map.set(key, value);
  }

  hasMany(keys) {
    return keys.map((key) => this.#map.has(key));
  }

  deleteMany(keys) {
    return keys.map((key) => this.#map.delete(key));
  }
}

/**
 * A least-recently-used cache written by hand on top of a `Map`.
 *
 * `Map` iterates in insertion order, so deleting a key and re-setting it moves it to the
 * most-recent end — which makes an LRU two lines of bookkeeping, and turns a read into four
 * `Map` operations instead of one. That delete-and-reinsert is the price this adapter
 * exists to charge: `full-featured` asks what a *bounded, expiring, tag-invalidatable*
 * cache costs, and leaving the LRU out of the Map stack would understate the work real
 * application code has to do to match blaze.
 *
 * Keys it drops of its own accord are reported through `onEvicted`, so a tag index layered
 * on top can unlink them. blaze removes an entry's tag membership when it evicts it, and a
 * rival allowed to skip that would be timed doing less than a correct implementation.
 */
class LruAdapter {
  #map = new Map();
  #capacity;
  #evicted = [];

  constructor({ capacity }) {
    this.#capacity = capacity;
  }

  /** Registers a callback for keys this cache drops to stay within `capacity`. */
  onEvicted(handler) {
    this.#evicted.push(handler);
  }

  get(key) {
    if (!this.#map.has(key)) return undefined;
    const value = this.#map.get(key);
    // Promote: Map preserves insertion order, so re-inserting puts it at the recent end.
    this.#map.delete(key);
    this.#map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.#map.has(key)) {
      this.#map.delete(key);
    } else if (this.#map.size >= this.#capacity) {
      const oldest = this.#map.keys().next().value;
      this.#map.delete(oldest);
      this.#report(oldest);
    }
    this.#map.set(key, value);
  }

  /**
   * Removes a key and reports it, so a tag index above stays in step.
   *
   * `TaggedAdapter.unlink` upstream is idempotent — a second call finds no `#byKey` row —
   * so the wrapper may unlink defensively as well for stores that report nothing. That
   * redundancy is what lets one `TaggedAdapter` sit over a `Map`, a `LruAdapter` or a
   * QuickLRU without special-casing how each of them drops keys.
   */
  delete(key) {
    const removed = this.#map.delete(key);
    if (removed) this.#report(key);
    return removed;
  }

  #report(key) {
    for (const handler of this.#evicted) handler(key);
  }

  size() {
    return this.#map.size;
  }

  clear() {
    this.#map.clear();
  }

  dispose() {}
}

/**
 * `quick-lru`. Its `get` promotes the entry in the recency order and its `set` may evict —
 * bookkeeping a plain `Map` does not — and that cost is part of what is being measured,
 * not something to be optimised away by reaching for `peek()` instead.
 *
 * Per-item deadlines go through QuickLRU's own `{ maxAge }`, so in the headline two native
 * implementations are compared against each other rather than one native against a shim.
 */
class QuickLruAdapter {
  #lru;

  /**
   * @param {object} options
   * @param {number} options.capacity entries before eviction starts
   * @param {(key: unknown) => void} [options.onEvicted] eviction notification, passed
   *   straight through to QuickLRU, which takes it as a **constructor** option — there is
   *   no way to subscribe afterwards. That asymmetry is why `quicklru-full` in the
   *   registry is built in two steps rather than composed in one expression.
   */
  constructor({ capacity, onEvicted } = {}) {
    this.#lru =
      onEvicted === undefined
        ? new QuickLRU({ maxSize: capacity })
        : new QuickLRU({ maxSize: capacity, onEvicted });
  }

  get(key) {
    return this.#lru.get(key);
  }

  set(key, value, options) {
    const maxAge = options?.ttlMs;
    if (maxAge === undefined) this.#lru.set(key, value);
    else this.#lru.set(key, value, { maxAge });
  }

  delete(key) {
    return this.#lru.delete(key);
  }

  size() {
    return this.#lru.size;
  }

  clear() {
    this.#lru.clear();
  }

  dispose() {}

  /** Batch get — one `Map.get` per key. */
  getMany(keys) {
    return keys.map((key) => this.#lru.get(key));
  }

  /** Batch set — one `Map.set` per key, forwarding `options.ttlMs` as `maxAge`. */
  setMany(entries) {
    for (const { key, value, options } of entries) {
      const maxAge = options?.ttlMs;
      if (maxAge === undefined) this.#lru.set(key, value);
      else this.#lru.set(key, value, { maxAge });
    }
  }

  /** Batch has — one `Map.has` per key. */
  hasMany(keys) {
    return keys.map((key) => this.#lru.has(key));
  }
}

/** `@blaze-cache/core` over the real wasm module. */
class BlazeAdapter {
  #cache;

  constructor(cache) {
    this.#cache = cache;
  }

  /** The only adapter whose construction is asynchronous — the wasm has to instantiate. */
  static async create({ capacity }) {
    const cache = await createCache({ wasm: await wasmBytes(), persistence: false, capacity });
    return new BlazeAdapter(cache);
  }

  get(key) {
    return this.#cache.get(key);
  }

  set(key, value, options) {
    this.#cache.set(key, value, options);
  }

  delete(key) {
    return this.#cache.delete(key);
  }

  invalidateTags(...tags) {
    return this.#cache.invalidateTags(...tags);
  }

  size() {
    return this.#cache.size();
  }

  clear() {
    this.#cache.clear();
  }

  dispose() {
    return this.#cache.dispose();
  }

  // ---------------------------------------------------------------- batch

  getMany(keys) {
    return this.#cache.getMany(keys);
  }

  setMany(entries) {
    const n = entries.length;
    const keys = new Array(n);
    const values = new Array(n);
    const ttlMs = new Float64Array(n);
    const tagsFlat = [];
    const tagOffsets = new Uint32Array(n + 1);
    tagOffsets[0] = 0;
    for (let i = 0; i < n; i += 1) {
      const entry = entries[i];
      keys[i] = entry.key;
      values[i] = entry.value;
      ttlMs[i] = entry.options?.ttlMs ?? -1;
      const tags = entry.options?.tags ?? [];
      for (const tag of tags) tagsFlat.push(tag);
      tagOffsets[i + 1] = tagsFlat.length;
    }
    this.#cache.setMany(keys, values, ttlMs, tagsFlat, tagOffsets);
  }

  hasMany(keys) {
    return this.#cache.hasMany(keys).map((v) => v === 1);
  }

  deleteMany(keys) {
    return this.#cache.deleteMany(keys).map((v) => v === 1);
  }
}

// ---------------------------------------------------------------- wrappers

/**
 * Bolt a deadline onto a store that has none.
 *
 * The entry is wrapped at write time (`{ value, expiresAt }`) so a read stays a single
 * lookup: two maps keyed by the same string would charge the shim for a second hash probe
 * it would not actually need. Expiry is lazy and checked on read, which is the only shape
 * a synchronous cache can have — and `Date.now()` on every read is precisely the cost a
 * plain `Map` leaves you to pay yourself.
 */
class TtlAdapter {
  #inner;
  #now;

  constructor(inner, now = Date.now) {
    this.#inner = inner;
    this.#now = now;
  }

  get(key) {
    const entry = this.#inner.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#inner.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, options) {
    const ttlMs = options?.ttlMs;
    const expiresAt = ttlMs === undefined ? Infinity : this.#now() + ttlMs;
    this.#inner.set(key, { value, expiresAt });
  }

  delete(key) {
    return this.#inner.delete(key);
  }

  size() {
    // `#inner` is an adapter, so `size` is a method — reading it as a property would hand
    // back the function itself, and `function >= capacity` is `NaN >= n`: quietly false.
    return this.#inner.size();
  }

  clear() {
    this.#inner.clear();
  }

  dispose() {}
}

/**
 * Bolt tag invalidation onto a store that has none, using the two-index shape you would
 * actually write in application code: key → tags, to know what to unlink when a key goes
 * away, and tag → keys, so invalidating is proportional to the matches instead of a scan.
 *
 * Both sides of blaze's wasm-side index are maintained here, including on `delete`, so the
 * comparison is index against index rather than index against nothing.
 *
 * A store that evicts keys *on its own* — an LRU, or a lazy TTL sweep — must also be told
 * to call {@link TaggedAdapter.unlink}, or this index would outlive the keys it describes
 * and `invalidateTags` would report entries that are already gone. That wiring is left to
 * the registry because the API is genuinely different per store: a hand-written LRU can
 * take a listener after the fact, QuickLRU only accepts one as a constructor option, and
 * blaze needs none at all. Hiding that difference here would mean pretending the three
 * stores behave alike when they do not.
 */
class TaggedAdapter {
  #inner;
  #byTag = new Map();
  #byKey = new Map();

  constructor(inner) {
    this.#inner = inner;
  }

  get(key) {
    return this.#inner.get(key);
  }

  set(key, value, options) {
    this.unlink(key);
    // `options` is forwarded, not swallowed, so this layer can sit outside a TTL shim that
    // still needs to read `ttlMs`.
    this.#inner.set(key, value, options);

    const tags = options?.tags;
    if (tags === undefined || tags.length === 0) return;
    this.#byKey.set(key, tags);
    for (const tag of tags) {
      let bucket = this.#byTag.get(tag);
      if (bucket === undefined) {
        bucket = new Set();
        this.#byTag.set(tag, bucket);
      }
      bucket.add(key);
    }
  }

  delete(key) {
    const removed = this.#inner.delete(key);
    // Unlink here too: a store that reports its removals has already done it, but a plain
    // `Map` reports nothing, and this method must not leak an index row either way. Idempotent.
    this.unlink(key);
    return removed;
  }

  invalidateTags(...tags) {
    const doomed = new Set();
    for (const tag of tags) {
      const bucket = this.#byTag.get(tag);
      if (bucket === undefined) continue;
      for (const key of bucket) doomed.add(key);
    }
    for (const key of doomed) this.delete(key);
    return [...doomed];
  }

  /**
   * Drop `key` from the reverse index, leaving an emptied bucket behind it.
   *
   * Idempotent: a second call finds no `#byKey` row and returns. That is what lets a store
   * report a removal it has already made *and* let `delete` unlink defensively, without
   * either path needing to know whether the other ran.
   */
  unlink(key) {
    const tags = this.#byKey.get(key);
    if (tags === undefined) return;
    this.#byKey.delete(key);
    for (const tag of tags) {
      const bucket = this.#byTag.get(tag);
      if (bucket === undefined) continue;
      bucket.delete(key);
      if (bucket.size === 0) this.#byTag.delete(tag);
    }
  }

  size() {
    return this.#inner.size();
  }

  clear() {
    this.#inner.clear();
    this.#byTag.clear();
    this.#byKey.clear();
  }

  dispose() {}

  // ---------------------------------------------------------------- batch

  getMany(keys) {
    return keys.map((key) => this.#inner.get(key));
  }

  setMany(entries) {
    for (const { key, value, options } of entries) {
      this.unlink(key);
      this.#inner.set(key, value, options);
      const tags = options?.tags;
      if (tags === undefined || tags.length === 0) continue;
      this.#byKey.set(key, tags);
      for (const tag of tags) {
        let bucket = this.#byTag.get(tag);
        if (bucket === undefined) {
          bucket = new Set();
          this.#byTag.set(tag, bucket);
        }
        bucket.add(key);
      }
    }
  }

  hasMany(keys) {
    return keys.map((key) => this.#inner.get(key) !== undefined);
  }

  deleteMany(keys) {
    return keys.map((key) => {
      const removed = this.#inner.delete(key);
      if (removed) this.unlink(key);
      return removed;
    });
  }
}

// --------------------------------------------------------------- registry

/**
 * Factories keyed by the names the scenarios select. Each entry's `label` is what the
 * results table prints, so it says out loud when a store is doing *less* than it looks.
 *
 * `map-full` and `quicklru-full` are the rivals `full-featured` is answered by. Both are
 * **stacked from the wrappers above** rather than special-cased: QuickLRU gets its LRU and
 * its deadline natively and is wrapped only for tags, whereas a `Map` has to be handed a
 * hand-written LRU, deadline *and* tag index — which is the point of the row.
 *
 * Layer order in the Map stack is tags outside TTL outside the LRU. Tag lookup costs nothing
 * on a read (the index is only touched on the write path and on invalidation), so putting it
 * outermost adds no work to the read half while letting it forward `options` down to the TTL
 * shim. `quicklru-full` skips that middle layer entirely — see its entry below.
 *
 * @type {Record<string, {label: string, create: (options: {capacity: number}) => Promise<unknown>}>}
 */
export const ADAPTERS = {
  map: {
    label: 'Map',
    create: async () => new MapAdapter(),
  },
  quicklru: {
    label: 'QuickLRU',
    create: async ({ capacity }) => new QuickLruAdapter({ capacity }),
  },
  blaze: {
    label: 'blaze-cache',
    create: async ({ capacity }) => BlazeAdapter.create({ capacity }),
  },
  'map-full': {
    label: 'Map + LRU + TTL + tags',
    create: async ({ capacity }) => {
      const lru = new LruAdapter({ capacity });
      const tagged = new TaggedAdapter(new TtlAdapter(lru));
      // blaze drops tag membership when it evicts; the hand-rolled LRU must too, so the
      // index above it hears about every key it removes on its own.
      lru.onEvicted((key) => tagged.unlink(key));
      return tagged;
    },
  },
  'quicklru-full': {
    label: 'QuickLRU + tag index',
    // No `TtlAdapter` here, unlike `map-full`: QuickLRU implements `maxAge` itself and
    // `QuickLruAdapter` forwards `ttlMs` straight into it. Wrapping it in the shim would
    // charge a library for work it does not have to do — a stand-in must never be put up
    // against a built-in.
    create: async ({ capacity }) => {
      // QuickLRU takes `onEvicted` as a *constructor* option; there is no way to subscribe
      // afterwards. The handler must therefore exist before the instance does — and before
      // the wrapper that owns the index it feeds. A one-slot cell breaks the circle: the
      // LRU closes over the cell, and the cell is pointed at the index once it exists.
      const cell = { unlink: null };
      const lru = new QuickLruAdapter({
        capacity,
        onEvicted: (key) => cell.unlink?.(key),
      });
      const tagged = new TaggedAdapter(lru);
      cell.unlink = (key) => tagged.unlink(key);
      return tagged;
    },
  },
};

/** Builds one adapter by registry name. */
export function createAdapter(name, options) {
  const entry = ADAPTERS[name];
  if (entry === undefined) throw new Error(`unknown adapter: ${name}`);
  return entry.create(options);
}

/** The label a registry name prints as. */
export function adapterLabel(name) {
  const entry = ADAPTERS[name];
  if (entry === undefined) throw new Error(`unknown adapter: ${name}`);
  return entry.label;
}
