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

/**
 * An in-memory `CachePersistence` exposing `rows` (and the optional `keys()` method) so
 * tests can see exactly what reaches storage — and stub individual methods to fail.
 */
const memoryAdapter = () => {
  const rows = new Map();
  return {
    rows,
    load: async () => [...rows.values()],
    save: async (records) => {
      for (const record of records) rows.set(record.key, record);
    },
    remove: async (keys) => {
      for (const key of keys) rows.delete(key);
    },
    clear: async () => rows.clear(),
    keys: async () => [...rows.keys()],
  };
};

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

  // A JS Number reaches wasm through integer truncation, so `-1` used to arrive as
  // ~4.29e9 and the core would reserve a hash map sized for it — aborting the instance.
  it('normalises a hostile capacity instead of aborting the instance', async () => {
    for (const capacity of [-1, -1e9, 0.5]) {
      const cache = await makeCache({ capacity });
      assert.equal(cache.capacity(), 1, `${capacity} clamps to the floor`);
    }
    for (const capacity of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const cache = await makeCache({ capacity });
      assert.equal(cache.capacity(), 1024, `${capacity} falls back to the default`);
    }

    const huge = await makeCache({ capacity: 1e12 });
    assert.equal(huge.capacity(), 1_000_000, 'absurd sizes clamp to a holdable ceiling');
    huge.set('k', 1);
    assert.equal(huge.get('k'), 1, 'and the cache still works');

    const honest = await makeCache({ capacity: 8 });
    assert.equal(honest.capacity(), 8, 'an honest number passes straight through');
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

  it('isolates a throwing listener so the mutation and its siblings still land', async () => {
    const cache = await makeCache();
    const seen = [];
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args);
    try {
      cache.on(() => {
        throw new Error('boom');
      });
      cache.on((change) => seen.push(`${change.type}:${change.key}`));

      cache.set('k', 1); // must not throw, despite the first listener doing so
      cache.delete('k');
    } finally {
      console.error = originalError;
    }

    assert.equal(cache.has('k'), false, 'the mutation itself completed');
    assert.deepEqual(seen, ['set:k', 'delete:k'], 'the later listener heard every change');
    assert.equal(errors.length, 2, 'each failure was logged instead of escaping');
    assert.match(errors[0][0], /^\[blaze-cache\]/, 'with the library prefix');

    await cache.dispose();
  });
});

describe('events', () => {
  it('delivers to a typed listener only for its own event type', async () => {
    const cache = await makeCache();
    const sets = [];
    const deletes = [];
    cache.on('set', (event) => sets.push(event));
    cache.on('delete', (event) => deletes.push(event));

    cache.set('k', 1);
    cache.get('k'); // a hit is none of their business
    cache.delete('k');
    cache.get('k'); // nor a miss
    cache.clear(); // nor a clear

    assert.deepEqual(sets, [{ type: 'set', key: 'k' }]);
    assert.deepEqual(deletes, [{ type: 'delete', key: 'k' }]);
    await cache.dispose();
  });

  it('reports hits and misses with their payloads', async () => {
    const cache = await makeCache();
    const events = [];
    cache.on('hit', (event) => events.push(event));
    cache.on('miss', (event) => events.push(event));

    cache.set('k', { n: 1 });
    const value = cache.get('k');
    const missing = cache.get('nope');

    assert.equal(missing, undefined);
    assert.equal(events.length, 2, 'one event per lookup');
    assert.deepEqual(events[1], { type: 'miss', key: 'nope' });
    assert.equal(events[0].type, 'hit');
    assert.equal(events[0].key, 'k');
    assert.equal(events[0].value, value, 'the hit carries the live reference');
    await cache.dispose();
  });

  it('emits per-key events across batch reads and writes', async () => {
    const cache = await makeCache();
    cache.set('a', 1);
    cache.set('b', 2);
    const seen = [];
    cache.on((event) => seen.push(`${event.type}:${event.key ?? '*'}`));

    const values = cache.getMany(['a', 'missing', 'b']);
    assert.deepEqual(values, [1, undefined, 2]);
    assert.deepEqual(seen, ['hit:a', 'miss:missing', 'hit:b']);

    seen.length = 0;
    cache.setMany([
      { key: 'c', value: 3 },
      { key: 'd', value: 4, options: { ttlMs: 5_000 } },
    ]);
    assert.deepEqual(seen, ['set:c', 'set:d']);

    seen.length = 0;
    assert.deepEqual(cache.deleteMany(['c', 'never-there', 'd']), [true, false, true]);
    assert.deepEqual(seen, ['delete:c', 'delete:d'], 'absent keys emit nothing');
    await cache.dispose();
  });

  it('fires `once` exactly once, and a spent unsubscribe is a no-op', async () => {
    const cache = await makeCache();
    const seen = [];
    cache.once('set', (event) => seen.push(event));

    cache.set('k1', 1);
    cache.set('k2', 2);
    assert.deepEqual(seen, [{ type: 'set', key: 'k1' }]);

    const off = cache.once('set', (event) => seen.push(event));
    off();
    off(); // double-release must not throw or drift the listener counts
    cache.set('k3', 3);
    assert.equal(seen.length, 1);
    await cache.dispose();
  });

  it('removes listeners through every `off` form', async () => {
    const cache = await makeCache();
    const targeted = [];
    const sibling = [];
    const wildcard = [];
    const target = (event) => targeted.push(event);
    const shared = (event) => sibling.push(event);

    cache.on('set', target);
    cache.on('set', (event) => sibling.push(event));
    const offWildcard = cache.on((event) => wildcard.push(event));

    cache.set('k1', 1);
    assert.deepEqual(targeted.map((e) => e.key), ['k1']);

    cache.off('set', target); // one registration of one type
    cache.set('k2', 2);
    assert.deepEqual(targeted.map((e) => e.key), ['k1'], 'the removed listener stayed removed');
    assert.deepEqual(sibling.map((e) => e.key), ['k1', 'k2'], 'its sibling kept running');
    assert.deepEqual(wildcard.map((e) => e.key), ['k1', 'k2'], 'the wildcard kept running');

    cache.off('set'); // every listener of one type
    cache.set('k3', 3);
    assert.deepEqual(sibling.map((e) => e.key), ['k1', 'k2']);
    assert.deepEqual(wildcard.map((e) => e.key), ['k1', 'k2', 'k3'], 'off("set") is type-scoped');

    // The same function registered as a typed and a wildcard listener — one `off(fn)`
    // releases both, and a duplicate registration never double-counts.
    const both = [];
    const offDup = cache.on('set', shared);
    cache.on('set', shared);
    cache.on(shared);
    cache.off(shared);
    offDup();
    cache.set('k4', 4);
    assert.deepEqual(both, []);

    cache.off(); // everything
    offWildcard();
    cache.set('k5', 5);
    assert.deepEqual(
      wildcard.map((e) => e.key),
      ['k1', 'k2', 'k3', 'k4'],
      'k5 landed after the final off()',
    );
    await cache.dispose();
  });

  it('emits `evict` with the dropped value, only while someone listens', async () => {
    const cache = await makeCache({ capacity: 1 });
    const seen = [];
    const offEvict = cache.on('evict', (event) => seen.push(event));

    cache.set('a', 'first');
    cache.set('b', 'second'); // capacity pressure — the core drops 'a' by itself
    assert.deepEqual(seen, [{ type: 'evict', key: 'a', value: 'first' }]);

    offEvict(); // last drop listener out → the core's drop log switches off again
    cache.set('c', 'third'); // evicts 'b', now unrecorded
    assert.equal(seen.length, 1, 'no events once the last `evict` listener is gone');
    await cache.dispose();
  });

  it('orders the operation first and the core’s drop after it', async () => {
    const cache = await makeCache({ capacity: 1 });
    const seen = [];
    cache.on((event) => seen.push(`${event.type}:${event.key ?? '*'}`));

    cache.set('a', 1);
    cache.set('b', 2); // set:b lands, then the eviction its write caused
    assert.deepEqual(seen, ['set:a', 'set:b', 'evict:a']);
    await cache.dispose();
  });

  it('emits `expire` when a read reclaims the dead entry', async () => {
    const cache = await makeCache();
    cache.set('gone', 'bye', { ttlMs: 60 });
    await delay(150); // past the deadline — nothing has looked at the entry yet

    const seen = [];
    cache.on((event) => seen.push(event));
    assert.equal(cache.get('gone'), undefined);

    assert.deepEqual(
      seen.map((event) => event.type),
      ['miss', 'expire'],
      'the lookup misses, and the core’s lazy reclamation explains why',
    );
    assert.deepEqual(seen[1], { type: 'expire', key: 'gone', value: 'bye' });
    await cache.dispose();
  });

  it('keeps `prune` explicit: removing entries yourself emits no `expire`', async () => {
    const cache = await makeCache();
    cache.set('gone', 1, { ttlMs: 60 });
    await delay(150);

    const seen = [];
    cache.on((event) => seen.push(event));
    assert.deepEqual(cache.prune(), ['gone']);
    assert.deepEqual(
      seen.map((event) => event.type),
      ['prune'],
      'the caller asked for it, so the core records nothing on its behalf',
    );
    await cache.dispose();
  });

  it('stays silent for the reads that record nothing', async () => {
    const cache = await makeCache();
    cache.set('k', 1, { tags: ['t'] });
    const seen = [];
    cache.on((event) => seen.push(event));

    cache.peek('k');
    cache.has('k');
    cache.ttl('k');
    cache.size();
    cache.keys();
    cache.entry('k');
    assert.deepEqual(seen, [], 'observational reads emit nothing at all');
    await cache.dispose();
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

  it('still tears down when the final flush fails, then rejects with that failure', async () => {
    let closed = false;
    const adapter = {
      load: async () => [],
      save: async () => {
        throw new Error('storage is down');
      },
      remove: async () => {},
      clear: async () => {},
      close: async () => {
        closed = true;
      },
    };
    const cache = await createCache({ wasm: wasmBytes, persistence: { adapter } });
    cache.set('k', 1);

    await assert.rejects(() => cache.dispose(), /storage is down/, 'the caller still hears it');
    assert.equal(closed, true, 'the teardown ran in the `finally`, despite the rejected flush');
    await cache.dispose(); // …so the second call is a no-op
    await cache.flush(); // …and a disposed cache is inert
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

  it('re-queues the dirty keys when save() fails, and a later flush retries them', async () => {
    const adapter = memoryAdapter();
    const save = adapter.save;
    let failNextSave = true;
    adapter.save = async (records) => {
      if (failNextSave) {
        failNextSave = false;
        throw new Error('simulated QuotaExceededError');
      }
      return save(records);
    };
    const cache = await createCache({ wasm: wasmBytes, persistence: { adapter } });

    cache.set('k', 1);
    await assert.rejects(() => cache.flush(), /QuotaExceededError/);
    assert.equal(adapter.rows.size, 0, 'the failed pass wrote nothing');

    await cache.flush();
    assert.equal(adapter.rows.get('k')?.value, 1, 'the re-queued key landed on the retry');

    await cache.dispose();
  });

  it('re-queues deletes when remove() fails, and a later flush finishes the job', async () => {
    const adapter = memoryAdapter();
    let failNextRemove = true;
    adapter.remove = async (keys) => {
      if (failNextRemove) {
        failNextRemove = false;
        throw new Error('simulated IDB failure');
      }
      for (const key of keys) adapter.rows.delete(key);
    };
    const cache = await createCache({ wasm: wasmBytes, persistence: { adapter } });

    cache.set('doomed', 1);
    await cache.flush();
    assert.equal(adapter.rows.has('doomed'), true, 'it starts out persisted');

    cache.delete('doomed');
    await assert.rejects(() => cache.flush(), /IDB failure/);
    assert.equal(adapter.rows.has('doomed'), true, 'the failed remove keeps the row — nothing is lost');

    await cache.flush();
    assert.equal(adapter.rows.has('doomed'), false, 'the re-queued delete landed on the retry');

    await cache.dispose();
  });

  it('reconciles persisted rows away when the wasm core evicts under capacity pressure', async () => {
    const adapter = memoryAdapter();
    const cache = await createCache({ wasm: wasmBytes, persistence: { adapter }, capacity: 2 });

    cache.set('a', 1);
    await cache.flush();
    assert.equal(adapter.rows.has('a'), true, 'the entry starts out persisted');

    cache.set('b', 2);
    cache.set('c', 3); // capacity pressure — the eviction emits no change event at all
    assert.equal(cache.has('a'), false, 'the wasm core dropped it on its own');
    assert.equal(adapter.rows.has('a'), true, 'and storage still holds the row');

    await cache.flush();
    assert.deepEqual([...adapter.rows.keys()].sort(), ['b', 'c'], 'the stale row is reconciled away');

    await cache.dispose();
  });

  it('reconciles persisted rows away when their TTL elapses', async () => {
    const adapter = memoryAdapter();
    const cache = await createCache({ wasm: wasmBytes, persistence: { adapter } });

    cache.set('gone', 1, { ttlMs: 100 });
    cache.set('stays', 2);
    await cache.flush();
    assert.equal(adapter.rows.has('gone'), true, 'the expiring entry starts out persisted');

    await delay(200);
    assert.equal(cache.has('gone'), false, 'the deadline elapsed without any event');
    assert.equal(adapter.rows.has('gone'), true, 'so storage still holds the row');

    await cache.flush();
    assert.equal(adapter.rows.has('gone'), false, 'the expired row is reconciled away');
    assert.equal(adapter.rows.has('stays'), true, 'live rows are untouched');

    await cache.dispose();
  });

  it('skips malformed persisted rows individually and warns exactly once', async () => {
    const now = Date.now();
    const adapter = {
      load: async () => [
        { value: 'no key at all', tags: [], ttlMs: null, storedAt: now },
        { key: 42, value: 'key is not a string', tags: [], ttlMs: null, storedAt: now },
        { key: 'bad-tags', value: 1, tags: 'nope', ttlMs: null, storedAt: now },
        { key: 'bad-ttl', value: 1, tags: [], ttlMs: 'soon', storedAt: now },
        { key: 'bad-ttl-2', value: 1, tags: [], ttlMs: Infinity, storedAt: now },
        { key: 'ok', value: { fine: true }, tags: ['t'], ttlMs: null, storedAt: now },
        { key: 'ok-ttl', value: 'still coming', tags: [], ttlMs: 60_000, storedAt: now },
      ],
      save: async () => {},
      remove: async () => {},
      clear: async () => {},
    };

    const warns = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warns.push(args);
    let cache;
    try {
      cache = await createCache({ wasm: wasmBytes, persistence: { adapter } });
    } finally {
      console.warn = originalWarn;
    }

    assert.deepEqual(cache.get('ok'), { fine: true }, 'the valid rows still hydrated');
    assert.equal(cache.has('ok-ttl'), true, 'including one that comes after the bad rows');
    assert.ok(cache.ttl('ok-ttl') > 59_000, 'with its deadline intact');
    assert.equal(cache.has('bad-tags'), false);
    assert.equal(cache.has('bad-ttl'), false);
    assert.equal(cache.size(), 2, 'every malformed row was skipped, none aborted the pass');
    assert.equal(warns.length, 1, 'one complaint for the whole run, not one per row');
    assert.match(String(warns[0][0]), /^\[blaze-cache\] skipping malformed persisted record/);

    await cache.dispose();
  });
});

/**
 * Persistence × events: the two features that both sit on top of every mutation.
 *
 * Each test names the bug it exists to catch — silent failures here are the expensive
 * kind, because storage drifts away from memory with no error anywhere (the `touch`
 * regression was caught exactly this way, by watching what reached the adapter).
 */
describe('persistence with events', () => {
  it('hydrates from storage without marking anything dirty', async () => {
    // Catches: hydration accidentally routed through `set`/`#notify`. Every row would be
    // rewritten on startup (or dropped into the dirty queue) even though nothing changed.
    const base = memoryAdapter();
    base.rows.set('pre', { key: 'pre', value: 42, tags: [], ttlMs: null, storedAt: Date.now() });
    const calls = { save: 0, remove: 0, clear: 0 };
    const adapter = {
      ...base,
      save: async (records) => {
        calls.save += 1;
        return base.save(records);
      },
      remove: async (keys) => {
        calls.remove += 1;
        return base.remove(keys);
      },
      clear: async () => {
        calls.clear += 1;
        return base.clear();
      },
    };

    const cache = await createCache({ wasm: wasmBytes, persistence: { adapter } });
    assert.equal(cache.get('pre'), 42, 'the stored row hydrated');

    const seen = [];
    cache.on((event) => seen.push(event));
    await cache.flush();

    assert.deepEqual(seen, [], 'nothing happened after subscribing — hydration is past');
    assert.equal(calls.save, 0, 'no row was rewritten on startup');
    assert.equal(calls.remove, 0, 'and nothing was reconciled away');
    assert.equal(calls.clear, 0);
    await cache.dispose();
  });

  it('lets hit/miss listeners run without ever dirtying a row', async () => {
    // Catches: read events leaking into the change bookkeeping — every `get` would
    // schedule a flush and rewrite rows, turning a read workload into write amplification.
    const adapter = memoryAdapter();
    const saves = { count: 0 };
    const save = adapter.save;
    adapter.save = async (records) => {
      saves.count += 1;
      return save(records);
    };

    const cache = await createCache({ wasm: wasmBytes, persistence: { adapter } });
    cache.set('k', 1);
    await cache.flush();
    const savesBefore = saves.count;

    const events = [];
    cache.on((event) => events.push(event));
    assert.equal(cache.get('k'), 1, 'a hit…');
    assert.equal(cache.get('nope'), undefined, '…and a miss, both delivered');
    await cache.flush();

    assert.deepEqual(
      events.map((event) => event.type),
      ['hit', 'miss'],
      'the reads still reached the listeners',
    );
    assert.equal(saves.count, savesBefore, 'but not one of them wrote anything back');
    assert.deepEqual([...adapter.rows.keys()], ['k'], 'storage is exactly where it was');
    await cache.dispose();
  });

  it('reconciles a capacity eviction away while an `evict` listener watches', async () => {
    // Catches: the drop log (only enabled when someone listens) breaking flush
    // bookkeeping — with tracking on, `drainDrops` runs inside `set` right where the
    // dirty-marking happens, which is a path the tracking-off tests never enter.
    const adapter = memoryAdapter();
    const cache = await createCache({ wasm: wasmBytes, persistence: { adapter }, capacity: 2 });
    const evicted = [];
    cache.on('evict', (event) => evicted.push(event)); // → core drop log switches on

    cache.set('a', 'first');
    await cache.flush();
    assert.equal(adapter.rows.has('a'), true, 'the entry starts out persisted');

    cache.set('b', 2);
    cache.set('c', 3); // capacity pressure — the core drops 'a' by itself
    assert.deepEqual(
      evicted,
      [{ type: 'evict', key: 'a', value: 'first' }],
      'the listener saw the dropped entry, value included',
    );
    assert.equal(adapter.rows.has('a'), true, 'storage still holds the row for now');

    await cache.flush();
    assert.deepEqual(
      [...adapter.rows.keys()].sort(),
      ['b', 'c'],
      'the stale row is reconciled away — with the drop log on',
    );
    await cache.dispose();
  });

  it('reconciles an expired row away while an `expire` listener watches', async () => {
    // Same hazard as the eviction case, entered through the lazy-reclamation path in
    // `get` instead of the capacity sweep in `set`.
    const adapter = memoryAdapter();
    const cache = await createCache({ wasm: wasmBytes, persistence: { adapter } });
    cache.set('gone', 'bye', { ttlMs: 80 });
    cache.set('stays', 2);
    await cache.flush();
    assert.equal(adapter.rows.has('gone'), true, 'the expiring entry starts out persisted');

    const expired = [];
    cache.on('expire', (event) => expired.push(event)); // → drop log on before the read
    await delay(150);
    assert.equal(cache.get('gone'), undefined, 'the read reclaims it');
    assert.deepEqual(
      expired,
      [{ type: 'expire', key: 'gone', value: 'bye' }],
      'the listener got the corpse, value included',
    );

    await cache.flush();
    assert.equal(adapter.rows.has('gone'), false, 'the expired row is reconciled away');
    assert.equal(adapter.rows.has('stays'), true, 'live rows are untouched');
    await cache.dispose();
  });

  it('isolates a throwing listener without losing the flush', async () => {
    // Catches: event delivery sharing a fate with persistence — a bad subscriber must
    // not stop the dirty-marking that runs before it, nor the flush that follows.
    const adapter = memoryAdapter();
    const cache = await createCache({ wasm: wasmBytes, persistence: { adapter } });

    cache.set('k', 1);
    await cache.flush();
    assert.equal(adapter.rows.has('k'), true, 'the row starts out persisted');

    const errors = [];
    const heard = [];
    cache.on(() => {
      throw new Error('boom');
    });
    cache.on((event) => heard.push(`${event.type}:${event.key ?? '*'}`));

    const originalError = console.error;
    console.error = (...args) => errors.push(args);
    try {
      cache.set('k', 2);
      await cache.flush();
      assert.equal(adapter.rows.get('k')?.value, 2, 'the write reached storage despite the thrower');

      cache.delete('k');
      await cache.flush();
      assert.equal(adapter.rows.has('k'), false, '…and so did the delete');

      cache.set('k', 3);
      await cache.flush();
      assert.equal(adapter.rows.get('k')?.value, 3, '…and the re-write');
    } finally {
      console.error = originalError;
    }

    assert.equal(errors.length, 3, 'each failure was logged instead of escaping');
    assert.match(errors[0][0], /^\[blaze-cache\]/, 'with the library prefix');
    assert.deepEqual(heard, ['set:k', 'delete:k', 'set:k'], 'the sibling heard every event');
    await cache.dispose();
  });

  it('keeps persisting after every listener is removed', async () => {
    // Catches: persistence bookkeeping accidentally gated on the subscriber set (it must
    // be gated on the adapter's own presence) — storage would silently freeze the moment
    // the last listener unsubscribes.
    const adapter = memoryAdapter();
    const cache = await createCache({ wasm: wasmBytes, persistence: { adapter } });

    const off = cache.on('set', () => {});
    off();
    cache.off(); // the cache is now listener-free, but still persistent

    cache.set('k', 1);
    cache.touch('k', { ttlMs: 60_000 });
    await cache.flush();

    assert.equal(adapter.rows.get('k')?.value, 1, 'the write still landed');
    assert.ok(
      adapter.rows.get('k')?.ttlMs > 59_000,
      '…including the renewed deadline (the touch write-back regression)',
    );
    await cache.dispose();
  });

  it('disposes cleanly with the drop log switched on', async () => {
    // Catches: the bus's change hook reaching into the freed wasm instance — `dispose`
    // clears the listeners, which fires the hook, which must notice it is already gone.
    const adapter = memoryAdapter();
    const cache = await createCache({ wasm: wasmBytes, persistence: { adapter }, capacity: 1 });
    const evicted = [];
    cache.on('evict', (event) => evicted.push(event)); // drop log on for the whole test

    cache.set('a', 1);
    cache.set('b', 2); // evicts 'a'
    cache.set('c', 3); // evicts 'b'
    assert.deepEqual(evicted.map((event) => event.key), ['a', 'b'], 'both drops observed');

    await cache.dispose(); // flush → clear listeners (hook!) → free wasm, in that order
    assert.deepEqual([...adapter.rows.keys()], ['c'], 'the final state was persisted first');

    // Subscribing after teardown must not reach into the freed wasm either.
    const late = cache.on('evict', () => {});
    late();
    cache.off();
  });

  it('supports a restore-on-evict listener without corrupting storage', async () => {
    // The pattern listeners are actually written for — pull a hot entry back in when the
    // cache drops it — and the sharpest edge in the design: a mutation issued from *inside*
    // event delivery, which re-enters `set` while the outer `set` is still draining drops.
    const adapter = memoryAdapter();
    const cache = await createCache({ wasm: wasmBytes, persistence: { adapter }, capacity: 2 });
    const evicted = [];
    const restored = new Set();
    cache.on('evict', (event) => {
      evicted.push(event.key);
      if (event.key === 'a' && !restored.has('a')) {
        restored.add('a');
        cache.set('a', event.value); // re-entrant write from inside the listener
      }
    });

    cache.set('a', 'A');
    cache.set('b', 'B');
    await cache.flush();
    assert.deepEqual([...adapter.rows.keys()].sort(), ['a', 'b'], 'both rows start out persisted');

    cache.set('c', 'C'); // evicts 'a' → the listener writes 'a' back → which evicts 'b'
    assert.deepEqual(evicted, ['a', 'b'], 'both drops delivered, no re-entrancy lost');
    assert.equal(cache.get('a'), 'A', 'the restored entry is live again');

    await cache.flush();
    assert.deepEqual(
      [...adapter.rows.keys()].sort(),
      ['a', 'c'],
      'storage matches memory: the restored row survives, the re-evicted one is reconciled away',
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

  it('keeps an own __proto__ key instead of dropping it through the inherited setter', () => {
    // `JSON.parse` defines `__proto__` as a plain own data property — the only reliable way
    // to build the hostile shape a cache key or query object could carry in from outside.
    const hostile = JSON.parse('{"__proto__":{"polluted":true}}');
    assert.ok(Object.hasOwn(hostile, '__proto__'), 'the fixture really owns the key');

    assert.equal(
      safeStableStringify(hostile),
      '{"__proto__":{"polluted":true}}',
      'the key survives serialisation verbatim',
    );
    assert.equal(
      stableStringify(hostile),
      '{"__proto__":{"polluted":true}}',
      '…through the non-safe variant too, which it delegates to',
    );
    assert.equal({}.polluted, undefined, 'no prototype anywhere was polluted');
    assert.equal(Object.getPrototypeOf(hostile), Object.prototype, 'the input is untouched');
  });
});
