/**
 * Stage 2: binary value mode and the opt-in JS-authoritative store.
 *
 * Both run against the real built wasm, so the tests fail if the Rust/Wasm side drifts from
 * the TypeScript glue. Node cannot `fetch()` a `file:` URL, so the binary is handed to
 * `createCache` explicitly — exactly like the rest of the core suite.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createCache } from '@blaze-cache/core';

const wasmBytes = await readFile(new URL('../pkg/blaze_cache_wasm_bg.wasm', import.meta.url));
const makeCache = (options = {}) =>
  createCache({ wasm: wasmBytes, persistence: false, ...options });

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

describe('binary value mode', () => {
  it('round-trips bytes as a zero-copy view and a long-lived copy', async () => {
    const cache = await makeCache({ capacity: 4 });
    const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

    assert.equal(cache.setBytes('bin', source, { ttlMs: 60_000, tags: ['data'] }), true);
    const view = cache.getBytes('bin');
    assert.ok(view instanceof Uint8Array);
    assert.deepEqual([...view], [...source], 'the view sees the reserved bytes');

    // Mutating the view rewrites the stored payload — by-reference semantics for bytes too.
    view[0] = 99;
    assert.equal(cache.getBytes('bin')[0], 99);

    const copy = cache.getBytesCopy('bin');
    assert.deepEqual([...copy], [...view]);
    assert.notEqual(copy.buffer, view.buffer, 'the copy is outside the Wasm arena');
    copy[0] = 0;
    assert.equal(cache.getBytes('bin')[0], 99, 'the copy is independent');

    assert.deepEqual(cache.tagsOf('bin'), ['data']);
    assert.ok((cache.ttl('bin') ?? 0) > 0);
    assert.deepEqual(cache.invalidateTags('data'), ['bin']);
    assert.equal(cache.getBytes('bin'), undefined);

    await cache.dispose();
  });

  it('accepts ArrayBuffer and views with offsets', async () => {
    const cache = await makeCache({ capacity: 4 });
    const buffer = new Uint8Array([9, 9, 1, 2, 3]).buffer;
    assert.equal(cache.setBytes('full', buffer), true);
    assert.deepEqual([...cache.getBytes('full')], [9, 9, 1, 2, 3]);

    const backing = new Uint8Array([0, 7, 7, 7, 0]);
    assert.equal(cache.setBytes('slice', backing.subarray(1, 4)), true);
    assert.deepEqual([...cache.getBytes('slice')], [7, 7, 7]);

    await cache.dispose();
  });

  it('keeps externrefs and byte values in their own lanes', async () => {
    const cache = await makeCache({ capacity: 8 });
    const object = { id: 'object' };
    cache.set('object', object);
    cache.setBytes('bytes', new Uint8Array([42]));

    assert.equal(cache.getBytes('object'), undefined, 'an externref is not a byte value');
    assert.equal(cache.get('bytes'), undefined, 'a byte value is not an externref');
    assert.equal(cache.get('object'), object, 'by-reference identity is unchanged');

    const events = [];
    cache.on('hit', (event) => events.push(`hit:${event.key}`));
    cache.on('miss', (event) => events.push(`miss:${event.key}`));
    cache.getBytes('bytes');
    cache.getBytes('missing');
    cache.getBytesCopy('bytes');
    assert.deepEqual(events, ['hit:bytes', 'miss:missing', 'hit:bytes']);

    await cache.dispose();
  });

  it('frees evicted byte regions without trapping', async () => {
    const cache = await makeCache({ capacity: 1 });
    for (let i = 0; i < 64; i += 1) {
      assert.equal(cache.setBytes(`k${i}`, new Uint8Array([i & 0xff])), true);
    }
    // The last write is live; every earlier region went back to the arena free list.
    assert.deepEqual([...cache.getBytes('k63')], [63]);
    assert.equal(cache.size(), 1);
    assert.equal(cache.getBytes('k0'), undefined);

    await cache.dispose();
  });

  it('is opt-in — js mode rejects it with a clear message', async () => {
    const cache = await makeCache({ storage: 'js' });
    assert.throws(
      () => cache.setBytes('x', new Uint8Array([1])),
      /storage: "wasm"/,
    );
    await cache.dispose();
  });
});

describe('JS-authoritative storage (opt-in)', () => {
  it('round-trips values by reference across every point operation', async () => {
    const cache = await makeCache({ storage: 'js', capacity: 8 });
    const a = { id: 1 };
    const b = { id: 2 };

    cache.set('a', a, { ttlMs: 60_000, tags: ['x'] });
    cache.set('b', b);
    assert.equal(cache.get('a'), a, 'the very same object comes back');
    assert.equal(cache.peek('a'), a);
    assert.equal(cache.has('a'), true);
    assert.deepEqual(cache.hasMany(['a', 'b', 'missing']), [true, true, false]);
    assert.deepEqual(cache.getMany(['a', 'b', 'missing']), [a, b, undefined]);
    assert.deepEqual(cache.keys(), ['a', 'b']);
    assert.deepEqual(cache.tagsOf('a'), ['x']);

    assert.equal(cache.set('a', b), undefined);
    assert.equal(cache.get('a'), b, 'an overwrite keeps the id and swaps the value');
    assert.equal(cache.size(), 2);
    assert.equal(cache.stats().size, 2);

    assert.equal(cache.delete('b'), true);
    assert.equal(cache.get('b'), undefined);
    assert.deepEqual(cache.deleteMany(['a', 'b']), [true, false]);

    cache.set('c', a, { tags: ['z'] });
    assert.deepEqual(cache.invalidateTags('z'), ['c']);
    cache.set('d', a);
    cache.clear();
    assert.equal(cache.size(), 0);

    await cache.dispose();
  });

  it('preserves entry()/entries() values and hit/miss statistics', async () => {
    const cache = await makeCache({ storage: 'js', capacity: 8 });
    const value = { name: 'Ada' };
    cache.set('user', value, { ttlMs: 60_000, tags: ['user'] });

    const entry = cache.entry('user');
    assert.equal(entry.key, 'user');
    assert.equal(entry.value, value);
    assert.deepEqual(entry.tags, ['user']);
    assert.ok(entry.ttlMs > 0);

    const entries = cache.entries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].value, value);

    assert.equal(cache.get('user'), value);
    assert.equal(cache.get('missing'), undefined);
    assert.deepEqual(
      [cache.stats().hits, cache.stats().misses],
      [1, 1],
      'wasm still owns the counters',
    );

    await cache.dispose();
  });

  it('reports real values on evict/expire and forgets their ids', async () => {
    const cache = await makeCache({ storage: 'js', capacity: 1 });
    const seen = [];
    cache.on('evict', (event) => seen.push([event.type, event.key, event.value]));
    cache.on('expire', (event) => seen.push([event.type, event.key, event.value]));

    const first = { id: 'first' };
    cache.set('first', first);
    cache.set('second', { id: 'second' });
    assert.deepEqual(seen, [['evict', 'first', first]], 'the drop carries the JS-owned value');
    assert.equal(cache.get('first'), undefined);
    assert.equal(cache.entry('first'), undefined);

    const dying = { id: 'dying' };
    cache.set('dying', dying, { ttlMs: 5 });
    await delay(15);
    assert.equal(cache.get('dying'), undefined);
    assert.deepEqual(seen.at(-1), ['expire', 'dying', dying]);

    await cache.dispose();
  });

  it('flush and hydrate read and write the JS-owned values', async () => {
    const adapter = memoryAdapter();
    const cache = await makeCache({
      storage: 'js',
      persistence: { adapter, debounceMs: 0, maxEntries: 64 },
    });
    const value = { name: 'Ada' };
    cache.set('user', value, { ttlMs: 60_000, tags: ['user'] });
    await cache.flush();
    assert.equal(adapter.rows.get('user').value, value, 'persistence sees the real value');

    cache.clear();
    await cache.persistence.hydrate();
    assert.equal(cache.get('user'), value, 'the value is back in the JS Map');
    assert.deepEqual(cache.tagsOf('user'), ['user']);

    await cache.dispose();
  });

  it('rejects an unknown storage value', async () => {
    await assert.rejects(
      () => makeCache({ storage: 'redis' }),
      /storage must be "wasm" or "js"/,
    );
  });

  it('leaves the default mode byte-for-byte unchanged', async () => {
    const cache = await makeCache({ capacity: 4 });
    const value = { id: 7 };
    cache.set('k', value, { tags: ['t'] });
    assert.equal(cache.get('k'), value);
    assert.equal(cache.getBytes('k'), undefined);
    assert.deepEqual(await cache.invalidateTags('t') instanceof Array, true);
    await cache.dispose();
  });
});
