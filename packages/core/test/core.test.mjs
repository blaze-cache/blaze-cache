/**
 * Smoke tests for `@blaze-cache/core`.
 *
 * They run against the **built** artifacts — `dist/` plus the wasm binary — so they fail if
 * the Rust core or the TypeScript glue drifts. The wasm is handed to `createCache` explicitly
 * because Node cannot fetch a `file:` URL, which is the browser-only default.
 *
 *   pnpm --filter @blaze-cache/core test
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  BlazeCache,
  DEFAULT_CAPACITY,
  DEFAULT_FLUSH_DELAY_MS,
  DEFAULT_MAX_RECORDS,
  createCache,
  indexedDbPersistence,
  initBlazeWasm,
  safeStableStringify,
  stableStringify,
  wasmUrl,
} from '@blaze-cache/core';

const wasmBytes = await readFile(new URL('../pkg/blaze_cache_wasm_bg.wasm', import.meta.url));

/** A cache over the real wasm module (Node has no `fetch` for `file:` URLs). */
const makeCache = (options = {}) => createCache({ wasm: wasmBytes, persistence: false, ...options });

describe('module surface', () => {
  it('exports the documented factory, constants and wasm loader', () => {
    assert.equal(typeof createCache, 'function');
    assert.equal(typeof BlazeCache, 'function');
    assert.equal(typeof initBlazeWasm, 'function');
    assert.equal(typeof indexedDbPersistence, 'function');

    assert.equal(DEFAULT_CAPACITY, 500);
    assert.equal(DEFAULT_FLUSH_DELAY_MS, 400);
    assert.equal(DEFAULT_MAX_RECORDS, 2000);

    assert.ok(wasmUrl instanceof URL, 'wasmUrl is a URL bundlers can rewrite');
    assert.ok(
      wasmUrl.href.endsWith('/pkg/blaze_cache_wasm_bg.wasm'),
      'it points at the generated binary',
    );
  });

  it('loads the wasm once, no matter how often it is asked', async () => {
    const first = initBlazeWasm(wasmBytes);
    const second = initBlazeWasm(wasmBytes);
    assert.equal(first, second, 'every caller awaits the same instantiation');
    await first;

    // …and the cache builds on top of that very instance.
    const cache = await makeCache({ capacity: 4 });
    assert.ok(cache instanceof BlazeCache);
    cache.set('k', 1);
    assert.equal(cache.get('k'), 1);
  });
});

describe('entries', () => {
  it('round-trips values and counts hits and misses', async () => {
    const cache = await makeCache();

    cache.set('greeting', { text: 'hello' });
    assert.deepEqual(cache.get('greeting'), { text: 'hello' });
    assert.equal(cache.has('greeting'), true);
    assert.equal(cache.has('absent'), false);
    assert.equal(cache.get('absent'), undefined);

    const stats = cache.stats();
    assert.equal(stats.hits, 1);
    assert.equal(stats.misses, 1);
    assert.equal(stats.hitRate, 0.5);
    assert.equal(stats.size, 1);
    assert.equal(cache.size(), 1);
  });

  it('replaces values and refreshes TTL and tags together', async () => {
    const cache = await makeCache();

    cache.set('user:1', { name: 'Ada' }, { ttlMs: 60_000, tags: ['user:1', 'profile'] });
    assert.deepEqual(cache.tagsOf('user:1'), ['user:1', 'profile']);
    assert.equal(cache.hasTag('user:1', 'profile'), true);

    cache.set('user:1', { name: 'Ada Lovelace' }, { tags: ['user:1'] });
    assert.deepEqual(cache.get('user:1'), { name: 'Ada Lovelace' });
    assert.deepEqual(cache.tagsOf('user:1'), ['user:1'], 'rewriting replaces the tag set');
    assert.equal(cache.keysWithTag('profile').length, 0);
    assert.equal(cache.size(), 1);
  });

  it('exposes keys, tags and metadata for every live entry', async () => {
    const cache = await makeCache();
    cache.set('user:7', 'payload', { ttlMs: 60_000, tags: ['user:7', 'vip'] });
    cache.set('page:2', 'html', { tags: ['public'] });

    assert.deepEqual(cache.keys().sort(), ['page:2', 'user:7']);
    assert.deepEqual(cache.keysWithTag('vip'), ['user:7']);
    assert.deepEqual(cache.keysWithTag('public'), ['page:2']);
    assert.equal(cache.hasTag('user:7', 'vip'), true);
    assert.equal(cache.hasTag('user:7', 'missing'), false);
    assert.deepEqual(cache.tagsOf('page:2'), ['public']);
    assert.deepEqual(cache.tagsOf('absent'), [], 'an unknown key has no tags');

    const entry = cache.entry('user:7');
    assert.equal(entry.key, 'user:7');
    assert.equal(entry.value, 'payload');
    assert.ok(entry.ttlMs > 0 && entry.ttlMs <= 60_000);
    assert.equal(cache.entry('absent'), undefined);
    assert.deepEqual(
      cache.entries().map((item) => item.key),
      ['user:7', 'page:2'],
      'oldest first',
    );
  });

  it('deletes a single entry and clears everything', async () => {
    const cache = await makeCache();
    cache.set('a', 1, { tags: ['t'] });
    cache.set('b', 2, { tags: ['t'] });

    assert.equal(cache.delete('a'), true, 'the removed entry is reported');
    assert.equal(cache.delete('a'), false, 'removing twice is not an error');
    assert.equal(cache.size(), 1);
    assert.deepEqual(cache.keysWithTag('t'), ['b'], 'the tag index followed');

    cache.clear();
    assert.equal(cache.size(), 0);
    assert.deepEqual(cache.keys(), []);
    assert.equal(cache.stats().invalidations, 2, 'the successful delete plus the clear');
  });
});

describe('freshness', () => {
  it('expires entries lazily and reports the expiration', async () => {
    const cache = await makeCache();

    cache.set('short', 1, { ttlMs: 20 });
    assert.equal(cache.has('short'), true);
    await delay(60);
    assert.equal(cache.has('short'), false, 'has() sees through the TTL');
    assert.equal(cache.get('short'), undefined);
    assert.equal(cache.stats().expirations, 1);
  });

  it('skips expired entries when listing, and prunes them in bulk', async () => {
    const cache = await makeCache();
    cache.set('stale', 1, { ttlMs: 20 });
    cache.set('kept', 2, { ttlMs: 60_000 });
    await delay(60);

    assert.deepEqual(cache.keys(), ['kept'], 'expired entries are not listed');
    assert.equal(cache.entry('stale'), undefined);
    assert.equal(cache.size(), 1, 'size() counts only what is still alive');
    assert.equal(
      cache.stats().size,
      2,
      'stats().size is the raw slab count and still holds the unpruned one',
    );

    assert.deepEqual(cache.prune(), ['stale']);
    assert.equal(cache.stats().size, 1, 'prune() is what empties the slab');
    assert.equal(cache.size(), 1);
  });

  it('invalidates by tag', async () => {
    const cache = await makeCache();
    cache.set('u1', 1, { tags: ['user:1'] });
    cache.set('u2', 2, { tags: ['user:2', 'vip'] });
    cache.set('page', 3, { tags: ['public'] });

    assert.deepEqual(cache.invalidateTags('user:1'), ['u1']);
    assert.deepEqual(cache.invalidateTags('vip', 'public').sort(), ['page', 'u2']);
    assert.equal(cache.size(), 0);
    assert.deepEqual(cache.invalidateTags('nothing'), [], 'unknown tags remove nothing');
    assert.deepEqual(cache.invalidateTags(), [], 'no tags means no work');
  });
});

describe('eviction', () => {
  it('protects visited entries when evicting over capacity', async () => {
    const cache = await makeCache({ capacity: 3 });

    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.get('a'); // "a" becomes protected
    cache.set('d', 4); // forces an eviction

    assert.equal(cache.size(), 3);
    assert.equal(cache.has('a'), true, 'the visited entry survives');
    assert.equal(cache.has('b'), false, 'the oldest unvisited entry goes');
    assert.equal(cache.has('c'), true);
    assert.equal(cache.has('d'), true);
    assert.equal(cache.stats().evictions, 1);
    assert.equal(cache.capacity(), 3);
  });

  it('clamps a capacity below one', async () => {
    const cache = await makeCache({ capacity: 0 });
    assert.equal(cache.capacity(), 1, 'capacity is always at least one');
    cache.set('only', 1);
    cache.set('next', 2);
    assert.equal(cache.size(), 1);
    assert.equal(cache.has('only'), false);
  });
});

describe('introspection', () => {
  it('answers the documented example exactly', async () => {
    const cache = await makeCache({ capacity: 1000 });
    for (const method of ['size', 'capacity', 'peek', 'touch', 'ttl']) {
      assert.equal(typeof cache[method], 'function', `${method}() is exposed`);
    }

    cache.set('user', { name: 'Ada' }, { ttlMs: 30_000 });

    assert.equal(cache.size(), 1);
    assert.equal(cache.capacity(), 1000);

    assert.deepEqual(cache.peek('user'), { name: 'Ada' }, 'data, no hit recorded');
    assert.equal(cache.stats().hits, 0, 'peek recorded nothing at all');

    assert.deepEqual(cache.get('user'), { name: 'Ada' }, 'data, hit recorded');
    assert.equal(cache.stats().hits, 1, 'get did');

    const remaining = cache.ttl('user');
    assert.ok(
      remaining <= 30_000 && remaining > 29_000,
      `ttl is a live countdown (got ${remaining}ms of 30000)`,
    );

    assert.equal(cache.touch('user', { ttlMs: 60_000 }), true);
    assert.ok(cache.ttl('user') > 59_000, 'refreshed to 60s from now');
    assert.deepEqual(cache.get('user'), { name: 'Ada' }, 'the value never changed');
    assert.equal(cache.size(), 1, 'still exactly one entry');
  });

  it('size() skips expired slots that stats().size still holds', async () => {
    const cache = await makeCache();
    cache.set('short', 1, { ttlMs: 20 });
    cache.set('kept', 2, { ttlMs: 60_000 });
    await delay(60);

    assert.equal(cache.stats().size, 2, 'the slab keeps both');
    assert.equal(cache.size(), 1, 'only the live one is counted');
    assert.equal(cache.size(), cache.keys().length, 'size() agrees with keys()');
  });

  it('peek reads without counting and without protecting', async () => {
    const cache = await makeCache({ capacity: 2 });
    cache.set('a', 1);
    cache.set('b', 2);

    assert.deepEqual(cache.peek('a'), 1);
    assert.equal(cache.peek('missing'), undefined, 'a miss reports nothing');
    const stats = cache.stats();
    assert.equal(stats.hits, 0, 'no hit');
    assert.equal(stats.misses, 0, 'no miss either');

    // SIEVE only protects what `get` marked — a peek must not.
    cache.set('c', 3);
    assert.equal(cache.has('a'), false, 'the peeked entry was still evictable');
    assert.equal(cache.has('b'), true);
  });

  it('ttl reports the window left, or undefined when there is none', async () => {
    const cache = await makeCache();
    cache.set('short', 1, { ttlMs: 30_000 });
    cache.set('forever', 2);
    cache.set('dying', 3, { ttlMs: 20 });

    const left = cache.ttl('short');
    assert.ok(left <= 30_000 && left > 29_000, `counting down (got ${left})`);
    assert.equal(cache.ttl('forever'), undefined, 'no deadline set');
    assert.equal(cache.ttl('absent'), undefined, 'no such key');

    await delay(60);
    assert.equal(cache.ttl('dying'), undefined, 'expired reads as absent, like get()');
    assert.equal(cache.ttl('short') <= 30_000, true, 'unaffected by the others');

    const stats = cache.stats();
    assert.equal(stats.hits, 0, 'ttl() observes nothing');
    assert.equal(stats.size, 3, 'and reclaims nothing');
  });

  it('touch renews the deadline, protects the entry and keeps the value', async () => {
    const cache = await makeCache();
    cache.set('user', { name: 'Ada' }, { ttlMs: 1_000 });

    assert.equal(cache.touch('user'), true, 'no options: the deadline stays put');
    assert.ok(cache.ttl('user') <= 1_000, 'it was not pushed out');

    assert.equal(cache.touch('user', { ttlMs: 60_000 }), true);
    assert.ok(cache.ttl('user') > 59_000, 'renewed from this moment');
    assert.deepEqual(cache.get('user'), { name: 'Ada' }, 'the value never changed');
    assert.equal(cache.stats().invalidations, 0, 'touch removes nothing');

    assert.equal(cache.touch('user', { ttlMs: 0 }), true, '0 reads as "never expires"');
    assert.equal(cache.ttl('user'), undefined, 'the deadline was dropped');

    assert.equal(cache.touch('absent'), false, 'nothing to touch');
    cache.set('dying', 1, { ttlMs: 20 });
    await delay(60);
    assert.equal(cache.touch('dying', { ttlMs: 60_000 }), false, 'expired is never revived');
    assert.equal(cache.has('dying'), false, '…and stays gone');
  });

  it('touch is what protects the entry SIEVE would otherwise take', async () => {
    const cache = await makeCache({ capacity: 2 });
    cache.set('a', 1); // oldest — the entry eviction would reach first
    cache.set('b', 2);

    assert.equal(cache.touch('a'), true);
    cache.set('c', 3); // capacity pressure

    assert.equal(cache.get('a'), 1, 'the touched entry survived');
    assert.equal(cache.has('b'), false, 'the untouched one went instead');
    assert.equal(cache.stats().evictions, 1);
  });
});

describe('statistics', () => {
  it('resets the counters without touching the entries', async () => {
    const cache = await makeCache();
    cache.set('k', 1);
    cache.get('k');
    cache.get('nope');
    assert.equal(cache.stats().hits, 1);
    assert.equal(cache.stats().misses, 1);

    cache.resetStats();
    const stats = cache.stats();
    assert.equal(stats.hits, 0);
    assert.equal(stats.misses, 0);
    assert.equal(stats.size, 1, 'stored entries survive a stats reset');
    assert.equal(cache.size(), 1);
  });

  it('keeps hitRate at zero before anything is read', async () => {
    const cache = await makeCache();
    assert.equal(cache.stats().hitRate, 0);
    assert.equal(cache.stats().capacity, DEFAULT_CAPACITY);
  });
});

describe('change listeners', () => {
  it('notifies listeners of every mutation', async () => {
    const cache = await makeCache();
    const seen = [];
    const unsubscribe = cache.on((change) => seen.push(change));

    cache.set('k', 1, { tags: ['t'] });
    cache.invalidateTags('t');
    cache.delete('k');
    cache.set('z', 1);
    cache.clear();
    unsubscribe();
    cache.set('after-unsubscribe', 1);

    // `delete('k')` is a no-op — the tag invalidation already removed it — so no event.
    assert.deepEqual(
      seen.map((change) => change.type),
      ['set', 'invalidate', 'set', 'clear'],
    );
    assert.equal(cache.size(), 1);
  });

  it('reports a successful touch, and nothing for a failed one', async () => {
    const cache = await makeCache();
    const seen = [];
    const unsubscribe = cache.on((change) => seen.push(change));

    cache.set('k', 1);
    cache.touch('k', { ttlMs: 5_000 });
    assert.equal(cache.touch('gone'), false, 'a rejected touch changes nothing');
    unsubscribe();
    cache.touch('k', { ttlMs: 7_000 });

    assert.deepEqual(
      seen.map((change) => `${change.type}:${change.key}`),
      ['set:k', 'touch:k'],
    );
  });
});

describe('lifecycle', () => {
  it('flushes without persistence and disposes cleanly', async () => {
    const cache = await makeCache();
    cache.set('k', 1);
    await cache.flush(); // no adapter configured: resolves without writing
    assert.equal(cache.get('k'), 1);
    await cache.dispose();
    await cache.dispose(); // idempotent
  });
});

describe('persistence adapter', () => {
  it('builds a CachePersistence without touching IndexedDB', () => {
    const adapter = indexedDbPersistence({ namespace: 'tests' });
    assert.equal(typeof adapter.load, 'function');
    assert.equal(typeof adapter.save, 'function');
    assert.equal(typeof adapter.remove, 'function');
    assert.equal(typeof adapter.clear, 'function');
  });

  it('rejects with a clear error when IndexedDB is unavailable', async () => {
    const adapter = indexedDbPersistence();
    await assert.rejects(() => adapter.load(), 'Node has no IndexedDB, and it says so');
  });

  it('writes a renewed deadline back, because touch marks the key dirty', async () => {
    const written = [];
    const adapter = {
      load: async () => [],
      save: async (records) => written.push(...records),
      remove: async () => {},
      clear: async () => {},
    };
    const cache = await createCache({ wasm: wasmBytes, persistence: { adapter } });

    cache.set('k', 1);
    await cache.flush();
    assert.deepEqual(
      written.map((record) => [record.key, record.ttlMs]),
      [['k', null]],
      'first write: no deadline yet',
    );

    cache.touch('k', { ttlMs: 60_000 });
    await cache.flush();
    assert.equal(written.length, 2, 'the touch produced a second write');
    assert.equal(written[1].key, 'k');
    assert.ok(
      written[1].ttlMs > 59_000,
      `storage now holds the renewed window (${written[1].ttlMs}ms)`,
    );

    await cache.dispose();
  });
});

describe('string helpers', () => {
  it('stableStringify is order-independent', () => {
    assert.equal(
      stableStringify({ b: 1, a: { d: 2, c: 3 } }),
      stableStringify({ a: { c: 3, d: 2 }, b: 1 }),
    );
    assert.equal(stableStringify(undefined), 'undefined');
    assert.equal(stableStringify([1, 2]), '[1,2]', 'array order is preserved');
  });

  it('safeStableStringify never throws on hostile input', () => {
    const cyclic = {};
    cyclic.self = cyclic;
    assert.equal(safeStableStringify(cyclic), undefined, 'cycles give up instead of throwing');
    assert.equal(safeStableStringify({ a: 1 }), stableStringify({ a: 1 }), 'plain input is identical');
  });
});
