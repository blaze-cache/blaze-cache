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

describe('query regressions and stress (0.5.0-beta.1)', () => {
  it('paginates a full scan with a cursor — with and without a where post-filter', async () => {
    const cache = await makeCache();
    for (let i = 0; i < 12; i += 1) cache.set(`k${String(i).padStart(2, '0')}`, i);

    let cursor;
    const plain = [];
    do {
      const page = cache.query({ limit: 5, fullScan: true, cursor });
      plain.push(...page.items.map((row) => row.key));
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(
      plain.join(','),
      Array.from({ length: 12 }, (_, i) => `k${String(i).padStart(2, '0')}`).join(','),
      'every key appears exactly once across the pages',
    );

    cursor = undefined;
    const filtered = [];
    let pages = 0;
    do {
      const page = cache.query({
        limit: 3,
        fullScan: true,
        cursor,
        where: (row) => Number(row.key.slice(1)) % 2 === 0,
      });
      filtered.push(...page.items.map((row) => row.key));
      cursor = page.nextCursor;
      pages += 1;
      assert.ok(pages < 10, 'cursor pagination always terminates');
    } while (cursor);
    assert.deepEqual(filtered, ['k00', 'k02', 'k04', 'k06', 'k08', 'k10']);
    await cache.dispose();
  });

  it('reports truncation when a cap cuts rows or bytes', async () => {
    const cache = await makeCache({ indexes: true });
    for (let i = 0; i < 5; i += 1) cache.set(`k${i}`, { payload: 'x'.repeat(100) });

    const byRows = cache.query({
      limit: 10,
      includeValues: true,
      maxEntries: 2,
      maxValueBytes: 10_000,
    });
    assert.equal(byRows.items.length, 2);
    assert.equal(byRows.truncated, true, 'a cap that leaves rows unseen must be reported');
    assert.equal(byRows.nextCursor, 'k1', 'the cursor re-anchors to the last row returned');

    const byBytes = cache.query({
      limit: 10,
      includeValues: true,
      maxEntries: 10,
      maxValueBytes: 1,
    });
    assert.equal(byBytes.items.length, 0, 'the byte cap is a hard cap');
    assert.equal(byBytes.truncated, true);

    const whole = cache.query({
      limit: 10,
      includeValues: true,
      maxEntries: 10,
      maxValueBytes: 10_000,
    });
    assert.equal(whole.items.length, 5);
    assert.equal(whole.truncated, undefined, 'an uncapped page carries no truncation flag');
    await cache.dispose();
  });

  it('keeps a stored undefined as a real row', async () => {
    const cache = await makeCache({ indexes: true });
    cache.set('blank', undefined);
    cache.set('present', 1);
    assert.equal(cache.peek('blank'), undefined, 'peek cannot distinguish stored undefined');
    assert.deepEqual(
      cache.query({ limit: 10 }).items.map((row) => row.key),
      ['blank', 'present'],
    );
    const withValues = cache.query({
      limit: 10,
      includeValues: true,
      maxEntries: 10,
      maxValueBytes: 10_000,
    });
    assert.deepEqual(
      withValues.items.map((row) => row.key),
      ['blank', 'present'],
      'includeValues must use entry(), not a liveness peek, to keep the row',
    );
    assert.equal(Object.hasOwn(withValues.items[0], 'value'), true);
    await cache.dispose();
  });

  it('stays bounded on 100k indexed keys with a cursor and an allow-list', async () => {
    const n = 100_000;
    const cache = await makeCache({ indexes: true, capacity: n + 10 });
    for (let i = 0; i < n; i += 1) cache.set(`key:${String(i).padStart(7, '0')}`, i);

    const t0 = performance.now();
    const page = cache.query({ prefix: 'key:', limit: 10 });
    const pageMs = performance.now() - t0;
    assert.equal(page.items.length, 10);
    assert.equal(page.items[0].key, 'key:0000000');
    const next = cache.query({ prefix: 'key:', limit: 10, cursor: page.nextCursor });
    assert.equal(next.items[0].key, 'key:0000010', 'a cursor seeks instead of rescanning');

    const allow = Array.from({ length: 20 }, (_, i) => `key:${String(i * 5_000).padStart(7, '0')}`);
    const t1 = performance.now();
    assert.equal(cache.count({ keys: allow }), 20, 'a small allow-list is walked directly');
    const allowMs = performance.now() - t1;

    // Generous ceilings: these catch a catastrophic O(n) regression (not machine noise).
    assert.ok(pageMs < 5_000, `a 10-row page took ${pageMs.toFixed(1)}ms`);
    assert.ok(allowMs < 5_000, `a 20-key allow-list took ${allowMs.toFixed(1)}ms`);
    await cache.dispose();
  });
});
