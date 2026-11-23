/**
 * 0.5.0-beta.1 query API: bounded indexed reads, cursors, caps and the additive
 * `invalidate.tags` event. Runs against built dist + the real wasm binary.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { createCache } from '@blaze-cache/core';

const wasmBytes = await readFile(new URL('../pkg/blaze_cache_wasm_bg.wasm', import.meta.url));
const makeCache = (options = {}) =>
  createCache({ wasm: wasmBytes, persistence: false, ...options });

describe('indexed query setup guard', () => {
  it('throws clearly with indexes off and allows an explicit fullScan', async () => {
    const cache = await makeCache();
    cache.set('b', 2);
    cache.set('a', 1);
    assert.throws(() => cache.query({ limit: 10 }), /indexes: true/);
    assert.throws(() => cache.queryKeys({ limit: 10 }), /indexes: true/);
    assert.throws(() => cache.count(), /indexes: true/);

    const scan = cache.query({ limit: 10, fullScan: true });
    assert.deepEqual(
      scan.items.map((row) => row.key),
      ['a', 'b'],
    );
    assert.equal(scan.nextCursor, null);
  });

  it('requires a positive limit and caps when values are included', async () => {
    const cache = await makeCache({ indexes: true });
    cache.set('a', 1);
    assert.throws(() => cache.query({}), /positive integer/);
    assert.throws(() => cache.query({ limit: 0 }), /positive integer/);
    assert.throws(
      () => cache.query({ limit: 1, includeValues: true, maxValueBytes: 100 }),
      /maxEntries.*maxValueBytes/,
    );
  });
});

describe('indexed queries', () => {
  it('paginates in ascending key order with a last-key cursor that survives anchor deletion', async () => {
    const cache = await makeCache({ indexes: true });
    for (const key of ['app:a', 'app:b', 'app:c', 'other:x']) cache.set(key, key);

    const page1 = cache.queryKeys({ prefix: 'app:', limit: 2 });
    assert.deepEqual(page1.keys, ['app:a', 'app:b']);
    assert.equal(page1.nextCursor, 'app:b');

    assert.equal(cache.delete('app:b'), true);
    const page2 = cache.queryKeys({ prefix: 'app:', limit: 2, cursor: page1.nextCursor });
    assert.deepEqual(page2.keys, ['app:c']);
    assert.equal(page2.nextCursor, null);

    // A stable view restarts from page one simply by dropping the cursor.
    assert.deepEqual(cache.queryKeys({ prefix: 'app:', limit: 2 }).keys, ['app:a', 'app:c']);
  });

  it('combines tag any/all/none constraints', async () => {
    const cache = await makeCache({ indexes: true });
    cache.set('a', 1, { tags: ['red', 'round'] });
    cache.set('b', 2, { tags: ['red', 'square'] });
    cache.set('c', 3, { tags: ['blue', 'round'] });

    assert.deepEqual(cache.queryKeys({ limit: 10, tags: { any: ['red'] } }).keys, ['a', 'b']);
    assert.deepEqual(
      cache.queryKeys({ limit: 10, tags: { any: ['red', 'blue'], all: ['round'] } }).keys,
      ['a', 'c'],
    );
    assert.deepEqual(cache.queryKeys({ limit: 10, tags: { none: ['square'] } }).keys, ['a', 'c']);
  });

  it('filters on remaining TTL (ttlRange) and a keys allow-list', async () => {
    const cache = await makeCache({ indexes: true });
    cache.set('short', 1, { ttlMs: 250 });
    cache.set('long', 2, { ttlMs: 60_000 });
    cache.set('permanent', 3);

    const bounded = cache.queryKeys({ limit: 10, ttlRange: { max: 5_000 } });
    assert.deepEqual(bounded.keys, ['short']);

    const lower = cache.queryKeys({ limit: 10, ttlRange: { min: 10_000 } });
    assert.deepEqual(lower.keys, ['long', 'permanent']);

    const allowed = cache.queryKeys({ limit: 10, keys: ['permanent', 'long'] });
    assert.deepEqual(allowed.keys, ['long', 'permanent']);
  });

  it('enforces includeValues caps and returns live references', async () => {
    const cache = await makeCache({ indexes: true });
    const shared = { id: 1 };
    cache.set('a', shared);
    cache.set('b', { id: 2 });
    cache.set('c', { id: 3 });

    const result = cache.query({
      limit: 10,
      includeValues: true,
      maxEntries: 2,
      maxValueBytes: 10_000,
    });
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].value, shared, 'values must be the live by-reference object');
    assert.equal(result.nextCursor, 'b');

    const tight = cache.query({ limit: 10, includeValues: true, maxEntries: 10, maxValueBytes: 1 });
    assert.equal(tight.items.length, 0, 'maxValueBytes is a hard cap');

    const metadata = cache.query({ limit: 1 });
    assert.equal(Object.hasOwn(metadata.items[0], 'value'), false);
  });

  it('guards the fullScan post-filter and counts matches', async () => {
    const cache = await makeCache({ indexes: true });
    cache.set('a', 1);
    cache.set('b', 2);

    assert.throws(() => cache.query({ limit: 10, where: () => true }), /fullScan/);
    assert.throws(
      () => cache.query({ limit: 10, fullScan: true, prefix: 'a' }),
      /cannot be combined/,
    );
    assert.deepEqual(
      cache
        .query({ limit: 10, fullScan: true, where: (row) => row.key === 'b' })
        .items.map((r) => r.key),
      ['b'],
    );
    assert.equal(cache.count(), 2);
    assert.equal(cache.count({ prefix: 'a' }), 1);
    assert.equal(cache.query({ limit: 1, withTotal: true }).total, 2);
  });

  it('adds tags to the invalidate event and counts no extra listeners after dispose', async () => {
    const cache = await makeCache();
    cache.set('a', 1, { tags: ['team'] });
    cache.set('b', 2, { tags: ['team'] });
    const events = [];
    const off = cache.on((event) => events.push(event));
    cache.invalidateTags('team');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].type, 'invalidate');
    assert.deepEqual(events[0].tags, ['team']);
    assert.deepEqual(events[0].keys.sort(), ['a', 'b']);
    off();
    cache.set('c', 3);
    assert.equal(events.length, 1, 'detaching must restore the prior state');
    await cache.dispose();
  });
});
