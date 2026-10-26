/**
 * Smoke tests for `@blaze-cache/react-query`.
 *
 * They run against the **built** artifacts (`dist/` + the real wasm binary) and drive a real
 * `QueryClient`, so the mirror is exercised exactly as TanStack drives it — including
 * TanStack's own garbage collector, which fires on a real (shortened) `gcTime` timer.
 *
 * Rendering `useBlazeQuery` itself is deliberately not covered here: running a hook needs a
 * DOM renderer (jsdom / testing-library), which this repo does not carry. Its whole data
 * path — the hash resolution, the mirror read and the seeding — lives in the pure
 * `seedBlazeQueryOptions`, which is tested below alongside the sync layer.
 *
 *   pnpm --filter @blaze-cache/react-query test
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { QueryClient, hashKey } from '@tanstack/react-query';

import { createCache } from '@blaze-cache/core';
import {
  createBlazeQueryClient,
  hashQueryKey,
  resolveQueryHash,
  seedBlazeQueryOptions,
  syncBlazeQueryCache,
  useBlazeQuery,
} from '@blaze-cache/react-query';

const wasmBytes = await readFile(
  new URL('../../core/pkg/blaze_cache_wasm_bg.wasm', import.meta.url),
);

/** A cache over the real wasm module (Node has no `fetch` for `file:` URLs). */
const makeCache = (options = {}) => createCache({ wasm: wasmBytes, persistence: false, ...options });

describe('module surface', () => {
  it('exports the documented entry points', () => {
    assert.equal(typeof createBlazeQueryClient, 'function');
    assert.equal(typeof syncBlazeQueryCache, 'function');
    assert.equal(typeof hashQueryKey, 'function');
    assert.equal(typeof resolveQueryHash, 'function');
    assert.equal(typeof seedBlazeQueryOptions, 'function');
    assert.equal(typeof useBlazeQuery, 'function');
  });
});

describe('createBlazeQueryClient', () => {
  it('mirrors successful queries and forgets removed ones', async () => {
    const cache = await makeCache();
    const client = createBlazeQueryClient({ cache, ttlMs: 60_000 });

    const queryKey = ['todos', { page: 1 }];
    client.setQueryData(queryKey, [1, 2, 3]);

    const hash = hashQueryKey(queryKey);
    const record = cache.get(hash);
    assert.deepEqual(record.data, [1, 2, 3], 'the query payload is in the cache');
    assert.equal(typeof record.dataUpdatedAt, 'number');
    assert.equal(cache.size(), 1, 'exactly one mirrored entry');
    assert.equal(cache.keys()[0], hash, 'stored under TanStack’s own query hash');

    const entry = cache.entry(hash);
    assert.deepEqual(entry.value.data, [1, 2, 3], 'read back through the entry accessor');
    assert.ok(
      entry.ttlMs > 59_000 && entry.ttlMs <= 60_000,
      `stored for the configured ttlMs, got ${entry.ttlMs}ms`,
    );

    // Our hash must be byte-identical to the one TanStack assigned.
    const query = client.getQueryCache().find({ queryKey });
    assert.equal(query.queryHash, hash, 'hashQueryKey matches TanStack');

    client.removeQueries({ queryKey });
    assert.equal(cache.has(hash), false, 'removal propagates to Blaze Cache');
    await client.clear();
  });

  it('can be skipped per query key', async () => {
    const cache = await makeCache();
    const client = createBlazeQueryClient({
      cache,
      skip: (queryKey) => queryKey[0] === 'private',
    });

    client.setQueryData(['private', 'user'], 'secret');
    client.setQueryData(['public', 'todos'], [1]);

    assert.equal(cache.has(hashQueryKey(['private', 'user'])), false, 'the private key never landed');
    assert.equal(cache.has(hashQueryKey(['public', 'todos'])), true, 'the public one did');
    assert.equal(cache.size(), 1, 'and it is the only entry in the cache');
    assert.deepEqual(
      cache.get(hashQueryKey(['public', 'todos'])).data,
      [1],
      'with its payload inside',
    );
    await client.clear();
  });

  it('tags mirrored entries so they can be dropped in bulk', async () => {
    const cache = await makeCache();
    const client = createBlazeQueryClient({ cache, ttlMs: 60_000 });
    client.setQueryData(['todos'], [1]);

    assert.deepEqual(cache.keysWithTag('react-query'), [hashQueryKey(['todos'])]);
    assert.deepEqual(cache.invalidateTags('react-query'), [hashQueryKey(['todos'])]);
    assert.equal(cache.size(), 0);
    await client.clear();
  });

  it('forwards client options to the QueryClient it builds', async () => {
    const cache = await makeCache();
    const client = createBlazeQueryClient({
      cache,
      client: { defaultOptions: { queries: { staleTime: 5_000 } } },
    });

    assert.equal(client.getDefaultOptions().queries.staleTime, 5_000);
    await client.clear();
  });
});

describe('syncBlazeQueryCache', () => {
  it('can be attached and detached by hand', async () => {
    const cache = await makeCache();
    const client = new QueryClient();
    const stop = syncBlazeQueryCache(client, { cache, ttlMs: 60_000 });

    client.setQueryData(['a'], 1);
    const hash = hashQueryKey(['a']);
    assert.equal(cache.has(hash), true, 'writes are mirrored while attached');
    assert.deepEqual(cache.get(hash).data, 1, 'the mirrored value is in the cache');
    assert.ok(cache.get(hash).dataUpdatedAt > 0, 'with its timestamp');
    assert.equal(cache.size(), 1, 'and it is the only entry');

    client.removeQueries({ queryKey: ['a'] });
    assert.equal(cache.has(hash), false, 'removal propagates while attached');
    assert.equal(cache.size(), 0, '…and leaves the store empty');

    stop();
    client.setQueryData(['b'], 2);
    assert.equal(cache.has(hashQueryKey(['b'])), false, 'detaching stops the mirror');
    assert.equal(cache.size(), 0, 'the detached write never reaches the cache');

    await client.clear();
  });

  it('mirrors a query only when it reaches a settled state', async () => {
    const cache = await makeCache();
    const client = new QueryClient();
    const stop = syncBlazeQueryCache(client, { cache, ttlMs: 60_000 });

    // `includeEmpty` defaults to off: data-less queries are not worth persisting.
    client.getQueryCache().build(client, { queryKey: ['empty'] });
    assert.equal(cache.size(), 0, 'an idle query with no data is not mirrored');

    stop();
    await client.clear();
  });

  it('keeps the mirror through garbage collection but deletes it on an explicit purge', async () => {
    const cache = await makeCache();
    // A tiny `gcTime` reproduces the audit's scenario in milliseconds: zero observers,
    // `gcTime` elapsed → `optionalRemove()` → `queryCache.remove()` → the very same
    // `removed` event an explicit purge produces, with nothing in the event to tell them
    // apart. Waiting it out on a real timer also proves TanStack really does this.
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: 10 } } });
    const stop = syncBlazeQueryCache(client, { cache, ttlMs: 60_000 });

    const queryKey = ['todos'];
    client.setQueryData(queryKey, [1, 2, 3]);
    const hash = hashQueryKey(queryKey);
    assert.equal(cache.has(hash), true, 'the query is mirrored while it lives');

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      client.getQueryCache().find({ queryKey }),
      undefined,
      'TanStack garbage-collected the query — the audit premise holds',
    );
    assert.equal(cache.has(hash), true, 'GC must NOT destroy the persisted mirror');

    // Explicit purges still propagate — through both wrapped APIs.
    client.setQueryData(queryKey, [1, 2, 3]);
    assert.equal(cache.has(hash), true, 're-mirrored after the GC removal');
    client.removeQueries({ queryKey });
    assert.equal(cache.has(hash), false, 'removeQueries still deletes the mirror');

    client.setQueryData(['other'], 42);
    assert.equal(cache.has(hashQueryKey(['other'])), true, 'another query is mirrored');
    await client.clear();
    assert.equal(cache.size(), 0, 'clear still deletes the mirror');

    stop();
  });

  it('patches removeQueries/clear while attached and restores them on unsubscribe', async () => {
    const cache = await makeCache();
    const client = new QueryClient();
    const originalRemoveQueries = client.removeQueries;
    const originalClear = client.clear;

    const stop = syncBlazeQueryCache(client, { cache });
    assert.notEqual(client.removeQueries, originalRemoveQueries, 'removeQueries is wrapped');
    assert.notEqual(client.clear, originalClear, 'clear is wrapped');

    stop();
    assert.equal(client.removeQueries, originalRemoveQueries, 'the original removeQueries is back');
    assert.equal(client.clear, originalClear, 'the original clear is back');
    assert.equal(
      Object.hasOwn(client, 'removeQueries'),
      false,
      'no wrapper is left behind on the client',
    );
    assert.equal(Object.hasOwn(client, 'clear'), false, '…for either method');

    // The restored originals are intact — still TanStack's own behaviour.
    client.setQueryData(['x'], 1);
    client.removeQueries({ queryKey: ['x'] });
    assert.equal(
      client.getQueryCache().find({ queryKey: ['x'] }),
      undefined,
      'the original removeQueries still removes queries',
    );

    // A detached sync mirrors nothing anymore.
    client.setQueryData(['y'], 2);
    assert.equal(cache.size(), 0, 'detaching stops the mirror');

    await client.clear();
  });
});

describe('seedBlazeQueryOptions', () => {
  it('seeds both timestamps from the mirror — but never touches caller-supplied data', async () => {
    const cache = await makeCache();
    const client = new QueryClient();
    const stop = syncBlazeQueryCache(client, { cache, ttlMs: 60_000 });

    client.setQueryData(['todos'], [1, 2]);
    const mirror = cache.get(hashQueryKey(['todos']));

    // Caller supplies neither → both fields are seeded together, in sync with the mirror.
    const seeded = seedBlazeQueryOptions(cache, client, { queryKey: ['todos'] });
    assert.deepEqual(seeded.initialData, [1, 2], 'the mirrored payload is seeded');
    assert.equal(seeded.initialDataUpdatedAt, mirror.dataUpdatedAt, 'with the mirror timestamp');

    // Caller supplies data *and* a timestamp → the mirror keeps its fields to itself.
    const supplied = seedBlazeQueryOptions(cache, client, {
      queryKey: ['todos'],
      initialData: [9],
      initialDataUpdatedAt: 1_000,
    });
    assert.deepEqual(supplied.initialData, [9], "the caller's data survives");
    assert.equal(supplied.initialDataUpdatedAt, 1_000, "the caller's timestamp survives");

    // Caller supplies data without a timestamp → the mirror must not stamp its own,
    // unrelated, old timestamp onto it: TanStack would read that as ancient data and
    // refetch immediately, defeating the caller's fresh `initialData`.
    const dataOnly = seedBlazeQueryOptions(cache, client, {
      queryKey: ['todos'],
      initialData: [9],
    });
    assert.deepEqual(dataOnly.initialData, [9], "the caller's data survives");
    assert.equal(
      dataOnly.initialDataUpdatedAt,
      undefined,
      'the mirror timestamp no longer rides along',
    );

    // No mirror record at all → options pass through untouched.
    const cold = seedBlazeQueryOptions(cache, client, { queryKey: ['missing'] });
    assert.equal(cold.initialData, undefined, 'nothing seeded without a mirror');
    assert.equal(cold.initialDataUpdatedAt, undefined);

    stop();
  });

  it('reads what sync wrote when a custom queryKeyHashFn is configured', async () => {
    const cache = await makeCache();
    const clientHash = (queryKey) => `client:${hashKey(queryKey)}`;
    const client = new QueryClient({
      defaultOptions: { queries: { queryKeyHashFn: clientHash } },
    });
    const stop = syncBlazeQueryCache(client, { cache, ttlMs: 60_000 });

    // Client-level default: sync writes under TanStack's custom hash…
    client.setQueryData(['todos'], [1]);
    assert.equal(cache.has(clientHash(['todos'])), true, 'sync honored the custom hasher');
    assert.equal(cache.has(hashKey(['todos'])), false, 'nothing landed under the default hash');
    assert.equal(
      resolveQueryHash(client, ['todos']),
      clientHash(['todos']),
      'the resolver replays TanStack’s option chain',
    );

    // …and the lookup lands on it instead of silently missing the mirror.
    const seeded = seedBlazeQueryOptions(cache, client, { queryKey: ['todos'] });
    assert.deepEqual(seeded.initialData, [1], 'the custom-hash path reads what sync wrote');
    assert.equal(seeded.initialDataUpdatedAt, cache.get(clientHash(['todos'])).dataUpdatedAt);

    // Per-query `queryKeyHashFn` beats the client default on both sides of the fence.
    const perQueryHash = (queryKey) => `per:${hashKey(queryKey)}`;
    await client.fetchQuery({
      queryKey: ['posts'],
      queryKeyHashFn: perQueryHash,
      queryFn: async () => ['p'],
    });
    assert.equal(cache.has(perQueryHash(['posts'])), true, 'mirrored under the per-query hash');
    const seededPer = seedBlazeQueryOptions(cache, client, {
      queryKey: ['posts'],
      queryKeyHashFn: perQueryHash,
    });
    assert.deepEqual(seededPer.initialData, ['p'], 'the per-query hasher reads its own entry');

    // `setQueryDefaults` sits between the two and wins over the client default.
    client.setQueryDefaults(['settings'], {
      queryKeyHashFn: (queryKey) => `defaults:${hashKey(queryKey)}`,
    });
    client.setQueryData(['settings'], { theme: 'dark' });
    assert.equal(
      cache.has(`defaults:${hashKey(['settings'])}`),
      true,
      'mirrored under the per-key default hash',
    );
    const seededDefaults = seedBlazeQueryOptions(cache, client, { queryKey: ['settings'] });
    assert.deepEqual(
      seededDefaults.initialData,
      { theme: 'dark' },
      'setQueryDefaults hashing is replayed too',
    );

    stop();
  });

  it('reads the mirror with peek so renders never move the stats', async () => {
    const cache = await makeCache();
    const client = new QueryClient();
    const stop = syncBlazeQueryCache(client, { cache, ttlMs: 60_000 });

    client.setQueryData(['todos'], [1]);
    assert.equal(typeof cache.peek, 'function', 'the concrete cache offers the pure read');

    let gets = 0;
    const counting = {
      get: (key) => {
        gets += 1;
        return cache.get(key);
      },
      peek: (key) => cache.peek(key),
      set: (key, value, options) => cache.set(key, value, options),
      delete: (key) => cache.delete(key),
      has: (key) => cache.has(key),
    };

    const seeded = seedBlazeQueryOptions(counting, client, { queryKey: ['todos'] });
    assert.equal(gets, 0, 'peek is preferred — the side-effecting get never runs');
    assert.deepEqual(seeded.initialData, [1], 'and the lookup still finds the mirror');

    // A cache predating `peek` (optional on the interface) still works via `get`.
    const getOnly = {
      get: counting.get,
      set: counting.set,
      delete: counting.delete,
      has: counting.has,
    };
    const fallback = seedBlazeQueryOptions(getOnly, client, { queryKey: ['todos'] });
    assert.equal(gets, 1, 'falls back to the recording read when peek is absent');
    assert.deepEqual(fallback.initialData, [1], 'with the same seeded payload');

    stop();
  });
});

describe('hashQueryKey', () => {
  it('is canonical: key order never changes the hash', () => {
    assert.equal(
      hashQueryKey(['todos', { page: 1, done: true }]),
      hashQueryKey(['todos', { done: true, page: 1 }]),
    );
    assert.equal(hashQueryKey([{ b: 1, a: 2 }]), '[{"a":2,"b":1}]');
    assert.notEqual(hashQueryKey(['a']), hashQueryKey(['b']));
    assert.notEqual(hashQueryKey(['a', 'b']), hashQueryKey(['b', 'a']), 'array order matters');
  });

  it('delegates to TanStack, so it can never drift', () => {
    assert.equal(hashQueryKey(['todos', { page: 1 }]), hashKey(['todos', { page: 1 }]));
    assert.equal(hashQueryKey([]), hashKey([]));
  });
});
