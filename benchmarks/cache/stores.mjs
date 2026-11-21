/**
 * The caches under test, plus the wrappers that give feature-poor stores the same work to do.
 *
 * This module is shared by the Node suite (`./adapters.mjs`) and the browser workspace
 * (`../browser/`). The only environment-specific piece is *where the wasm comes from*: Node
 * reads the binary off disk, the browser lets `@blaze-cache/core` fetch its own asset. Callers
 * pass a `wasmProvider` to {@link buildRegistry}; when it yields nothing, `createCache` uses its
 * default URL path.
 *
 * Every adapter exposes the same synchronous surface — `get`, `set(key, value, options?)`,
 * `delete`, `size`, `clear`, `dispose` — as a one-call-deep class wrapper, so no store gets to
 * skip a method call the others pay. Stores without a native deadline or tag index are wrapped
 * (`TtlAdapter`, `TaggedAdapter`) rather than silently ignoring the options: a rival must do the
 * work blaze does or its number means nothing. Where a library implements a feature natively
 * (`quick-lru`/`lru-cache` `maxAge`), the native path is used and no stand-in is stacked on it.
 *
 * The persistence adapters add an async layer: `flush()`, `hydrate()`, `storeClear()`,
 * `seedRecords()` and `storeSize()`. Only the two persistence scenarios call those. blaze uses
 * its real write-through layer with a tiny in-memory `CachePersistence` adapter; the rivals get
 * an equivalent hand-rolled pending-write queue over the same backing store.
 */
import { LRUCache } from 'lru-cache';
import QuickLRU from 'quick-lru';

import { createCache } from '@blaze-cache/core';

// ------------------------------------------------------------------ stores

/** The native `Map`: the floor every other adapter is measured against. */
export class MapAdapter {
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
 * `Map` iterates in insertion order, so deleting and re-setting a key moves it to the recent
 * end. That promote-on-read is the price this adapter exists to charge: a bounded cache must do
 * it, and leaving it out of the Map stack would understate the work real application code does.
 */
export class LruAdapter {
  #map = new Map();
  #capacity;
  #evicted = [];

  constructor({ capacity }) {
    this.#capacity = capacity;
  }

  onEvicted(handler) {
    this.#evicted.push(handler);
  }

  get(key) {
    if (!this.#map.has(key)) return undefined;
    const value = this.#map.get(key);
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

/** `quick-lru`: native LRU and `maxAge`, no tag index. */
export class QuickLruAdapter {
  #lru;

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

  getMany(keys) {
    return keys.map((key) => this.#lru.get(key));
  }

  setMany(entries) {
    for (const { key, value, options } of entries) {
      const maxAge = options?.ttlMs;
      if (maxAge === undefined) this.#lru.set(key, value);
      else this.#lru.set(key, value, { maxAge });
    }
  }

  hasMany(keys) {
    return keys.map((key) => this.#lru.has(key));
  }
}

/**
 * `lru-cache` v11 — the peer named in the original 0.4.0 proposal. Native LRU, native `maxAge`,
 * and an eviction callback so a tag index layered above can stay in step.
 */
export class LruCacheAdapter {
  #lru;

  constructor({ capacity, onEvicted } = {}) {
    this.#lru = new LRUCache({
      max: capacity,
      // v11 calls this `dispose(value, key, reason)` and fires it for evictions, expiry,
      // deletes and overwrites alike — all harmless to an idempotent tag unlink.
      ...(onEvicted === undefined ? {} : { dispose: (_value, key) => onEvicted(key) }),
    });
  }

  get(key) {
    return this.#lru.get(key);
  }

  set(key, value, options) {
    const maxAge = options?.ttlMs;
    if (maxAge === undefined) this.#lru.set(key, value);
    else this.#lru.set(key, value, { ttl: maxAge });
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
}

/** `@blaze-cache/core` in opt-in JS-authoritative mode (`storage: 'js'`). */
export class BlazeJsAdapter {
  #cache;

  constructor(cache) {
    this.#cache = cache;
  }

  static async create({ capacity, wasm } = {}) {
    const cache = await createCache({
      ...(wasm === undefined ? {} : { wasm }),
      persistence: false,
      capacity,
      storage: 'js',
    });
    return new BlazeJsAdapter(cache);
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
}

/** `@blaze-cache/core` using the optional zero-copy byte value path. */
export class BlazeBytesAdapter {
  #cache;

  constructor(cache) {
    this.#cache = cache;
  }

  static async create({ capacity, wasm } = {}) {
    const cache = await createCache({
      ...(wasm === undefined ? {} : { wasm }),
      persistence: false,
      capacity,
    });
    return new BlazeBytesAdapter(cache);
  }

  get(key) {
    // The headline is the genuinely zero-copy read; the harness only consumes a boolean.
    return this.#cache.getBytes(key);
  }

  set(key, value, options) {
    this.#cache.setBytes(key, value, options);
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
}

/** `@blaze-cache/core` over the real wasm module. */
export class BlazeAdapter {
  #cache;

  constructor(cache) {
    this.#cache = cache;
  }

  static async create({ capacity, wasm } = {}) {
    const cache = await createCache({
      ...(wasm === undefined ? {} : { wasm }),
      persistence: false,
      capacity,
    });
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
 * Bolt a deadline onto a store that has none. The entry is wrapped at write time so a read
 * stays a single lookup; expiry is lazy, the only shape a synchronous cache can have.
 */
export class TtlAdapter {
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
    return this.#inner.size();
  }

  clear() {
    this.#inner.clear();
  }

  dispose() {}
}

/**
 * Bolt tag invalidation onto a store that has none: key→tags to unlink on removal, tag→keys
 * so invalidation is proportional to matches. Both sides of blaze's wasm index are maintained,
 * including on eviction (wired by the registry, where each store's API differs).
 */
export class TaggedAdapter {
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
}

// --------------------------------------------------------------- persistence

/** A `Map`-backed `CachePersistence` — IndexedDB's semantics without a browser. */
export class MemoryPersistence {
  #rows = new Map();

  get size() {
    return this.#rows.size;
  }

  async load() {
    return [...this.#rows.values()];
  }

  async save(records) {
    for (const record of records) this.#rows.set(record.key, record);
  }

  async remove(keys) {
    for (const key of keys) this.#rows.delete(key);
  }

  async clear() {
    this.#rows.clear();
  }

  async keys() {
    return [...this.#rows.keys()];
  }

  async write({ clear, save, remove }) {
    if (clear) this.#rows.clear();
    await this.save(save ?? []);
    await this.remove(remove ?? []);
  }
}

/** Common persistence-scenario surface shared by the blaze and hand-rolled adapters. */
class PersistenceSurface {
  #store;
  #pending = new Map();
  #clearAll = false;

  constructor(inner, store) {
    this.inner = inner;
    this.#store = store;
  }

  get(key) {
    return this.inner.get(key);
  }

  set(key, value, options) {
    this.inner.set(key, value, options);
    this.#pending.set(key, { key, value, options });
  }

  delete(key) {
    const removed = this.inner.delete(key);
    if (removed) this.#pending.set(key, { key, remove: true });
    return removed;
  }

  size() {
    return this.inner.size();
  }

  clear() {
    this.inner.clear();
    this.#pending.clear();
    this.#clearAll = true;
  }

  dispose() {}

  async storeClear() {
    await this.#store.clear();
  }

  seedRecords(records) {
    return this.#store.save(records);
  }

  storeSize() {
    return this.#store.size;
  }

  async flush() {
    const clear = this.#clearAll;
    this.#clearAll = false;
    const operations = [...this.#pending.values()];
    this.#pending.clear();
    const save = [];
    const remove = [];
    for (const operation of operations) {
      if (operation.remove) {
        remove.push(operation.key);
        continue;
      }
      save.push({
        key: operation.key,
        value: operation.value,
        tags: operation.options?.tags ?? [],
        ttlMs: operation.options?.ttlMs ?? null,
        storedAt: Date.now(),
      });
    }
    await this.#store.write({ clear, save, remove });
  }

  async hydrate() {
    const records = await this.#store.load();
    for (const record of records) {
      this.inner.set(record.key, record.value, {
        ttlMs: record.ttlMs ?? undefined,
        tags: record.tags,
      });
    }
  }
}

/** Blaze's real write-through persistence, backed by `MemoryPersistence`. */
export class BlazePersistAdapter {
  #cache;
  #store;

  constructor(cache, store) {
    this.#cache = cache;
    this.#store = store;
  }

  static async create({ capacity, wasm } = {}) {
    const store = new MemoryPersistence();
    const cache = await createCache({
      ...(wasm === undefined ? {} : { wasm }),
      capacity,
      persistence: {
        adapter: store,
        debounceMs: 0,
        // The default caps a flush at 2 000 records; a capacity-sized flush must not be
        // silently truncated or the rival stacks would be timed doing more work.
        maxEntries: capacity,
      },
    });
    return new BlazePersistAdapter(cache, store);
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

  size() {
    return this.#cache.size();
  }

  clear() {
    this.#cache.clear();
  }

  dispose() {
    return this.#cache.dispose();
  }

  storeClear() {
    return this.#cache.persistence.clear();
  }

  seedRecords(records) {
    return this.#store.save(records);
  }

  storeSize() {
    return this.#store.size;
  }

  flush() {
    return this.#cache.flush();
  }

  hydrate() {
    return this.#cache.persistence.hydrate();
  }
}

// --------------------------------------------------------------- registry

/**
 * Builds the adapter registry. Each factory asks the caller's `wasmProvider` for the binary
 * once per blaze instance; Node supplies bytes read from disk, the browser supplies nothing
 * and falls back to the package's own asset URL.
 *
 * @param {{wasmProvider?: () => Promise<Uint8Array | undefined>}} [options]
 */
export function buildRegistry({ wasmProvider } = {}) {
  const wasm = async () => (wasmProvider ? wasmProvider() : undefined);
  const blaze = async ({ capacity }) => BlazeAdapter.create({ capacity, wasm: await wasm() });

  const ADAPTERS = {
    map: { label: 'Map', create: async () => new MapAdapter() },
    quicklru: {
      label: 'QuickLRU',
      create: async ({ capacity }) => new QuickLruAdapter({ capacity }),
    },
    lrucache: {
      label: 'lru-cache',
      create: async ({ capacity }) => new LruCacheAdapter({ capacity }),
    },
    blaze: { label: 'blaze-cache', create: blaze },
    'blaze-js': {
      label: 'blaze-cache (js storage)',
      create: async ({ capacity }) => BlazeJsAdapter.create({ capacity, wasm: await wasm() }),
    },
    'blaze-bytes': {
      label: 'blaze-cache (bytes)',
      create: async ({ capacity }) => BlazeBytesAdapter.create({ capacity, wasm: await wasm() }),
    },
    'map-lru': {
      label: 'Map + LRU',
      create: async ({ capacity }) => new LruAdapter({ capacity }),
    },
    'map-full': {
      label: 'Map + LRU + TTL + tags',
      create: async ({ capacity }) => {
        const lru = new LruAdapter({ capacity });
        const tagged = new TaggedAdapter(new TtlAdapter(lru));
        lru.onEvicted((key) => tagged.unlink(key));
        return tagged;
      },
    },
    'quicklru-full': {
      label: 'QuickLRU + tag index',
      create: async ({ capacity }) => {
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
    'lrucache-full': {
      label: 'lru-cache + tag index',
      create: async ({ capacity }) => {
        const cell = { unlink: null };
        const lru = new LruCacheAdapter({
          capacity,
          onEvicted: (key) => cell.unlink?.(key),
        });
        const tagged = new TaggedAdapter(lru);
        cell.unlink = (key) => tagged.unlink(key);
        return tagged;
      },
    },
    'blaze-persist': {
      label: 'blaze-cache + persistence',
      create: async ({ capacity }) => BlazePersistAdapter.create({ capacity, wasm: await wasm() }),
    },
    'map-persist': {
      label: 'Map + written queue',
      create: async ({ capacity }) => {
        const store = new MemoryPersistence();
        return new PersistenceSurface(new MapAdapter(), store);
      },
    },
    'quicklru-persist': {
      label: 'QuickLRU + written queue',
      create: async ({ capacity }) => {
        const store = new MemoryPersistence();
        return new PersistenceSurface(new QuickLruAdapter({ capacity }), store);
      },
    },
  };

  return {
    ADAPTERS,
    createAdapter(name, options) {
      const entry = ADAPTERS[name];
      if (entry === undefined) throw new Error(`unknown adapter: ${name}`);
      return entry.create(options);
    },
    adapterLabel(name) {
      const entry = ADAPTERS[name];
      if (entry === undefined) throw new Error(`unknown adapter: ${name}`);
      return entry.label;
    },
  };
}
