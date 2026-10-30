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
  dehydrateBlazeQueryClient,
  hashQueryKey,
  hydrateBlazeQueryClient,
  invalidateBlazeQueries,
  isMirrorRecord,
  prefetchBlazeQuery,
  readBlazeRecord,
  removeBlazeQueries,
  resolveQueryHash,
  seedBlazeInfiniteQueryOptions,
  seedBlazeQueriesOptions,
  seedBlazeQueryOptions,
  setBlazeQueryData,
  syncBlazeQueryCache,
  useBlazeInfiniteQuery,
  useBlazeMutation,
  useBlazeQueries,
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
    assert.equal(typeof readBlazeRecord, 'function');
    assert.equal(typeof seedBlazeInfiniteQueryOptions, 'function');
    assert.equal(typeof useBlazeInfiniteQuery, 'function');
    assert.equal(typeof seedBlazeQueriesOptions, 'function');
    assert.equal(typeof useBlazeQueries, 'function');
    assert.equal(typeof setBlazeQueryData, 'function');
    assert.equal(typeof prefetchBlazeQuery, 'function');
    assert.equal(typeof invalidateBlazeQueries, 'function');
    assert.equal(typeof removeBlazeQueries, 'function');
    assert.equal(typeof useBlazeMutation, 'function');
    assert.equal(typeof dehydrateBlazeQueryClient, 'function');
    assert.equal(typeof hydrateBlazeQueryClient, 'function');
    assert.equal(typeof isMirrorRecord, 'function');
  });

  it('isMirrorRecord accepts only the shape TanStack writes', () => {
    assert.equal(isMirrorRecord({ data: [1], dataUpdatedAt: 1_000 }), true);
    assert.equal(isMirrorRecord({ data: [1], dataUpdatedAt: 1_000, queryKey: ['todos'] }), true);
    // Foreign shapes on a shared cache: axios/fetch records, raw SWR values, plain data.
    assert.equal(
      isMirrorRecord({ status: 200, data: {}, storedAt: 1, freshUntil: 2 }),
      false,
      'axios/fetch records carry no `dataUpdatedAt`',
    );
    assert.equal(isMirrorRecord({ kind: 'swr', data: 'v', storedAt: 1 }), false, 'SWR envelope');
    assert.equal(isMirrorRecord({ title: 'raw value' }), false, 'raw value');
    assert.equal(isMirrorRecord(null), false);
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

  it('never seeds a foreign value parked under this query’s hash (shared cache)', async () => {
    const cache = await makeCache();
    const client = new QueryClient();

    // A forced key collision: an axios record under TanStack's own hash. Seeding it would
    // hand an HTTP body to TanStack as `initialData` with no timestamp to date it — a
    // configured `staleTime` would be ignored too.
    const hash = hashQueryKey(['todos']);
    cache.set(hash, {
      status: 200,
      data: { source: 'axios' },
      storedAt: Date.now(),
      freshUntil: Date.now() + 60_000,
    });

    const seeded = seedBlazeQueryOptions(cache, client, { queryKey: ['todos'] });
    assert.equal(seeded.initialData, undefined, 'the foreign body is not query data');
    assert.equal(seeded.initialDataUpdatedAt, undefined, '…and carries no timestamp');

    // Our own record under the same hash still seeds — the gate is shape, not origin.
    cache.set(hash, { data: [1], dataUpdatedAt: 1_000, queryKey: ['todos'] });
    const ours = seedBlazeQueryOptions(cache, client, { queryKey: ['todos'] });
    assert.deepEqual(ours.initialData, [1]);
    assert.equal(ours.initialDataUpdatedAt, 1_000);
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

describe('prefetchBlazeQuery', () => {
  it('mirrors a successful prefetch under the resolved hash', async () => {
    const cache = await makeCache();
    const client = new QueryClient();

    await prefetchBlazeQuery(cache, client, {
      queryKey: ['todos', 'u1'],
      queryFn: async () => [{ id: 1 }],
    });

    const hash = hashQueryKey(['todos', 'u1']);
    assert.equal(cache.has(hash), true, 'the fetched result is mirrored');
    assert.deepEqual(cache.get(hash).data, [{ id: 1 }]);
    assert.ok(cache.get(hash).dataUpdatedAt > 0, 'with the fetch timestamp');

    await client.clear();
  });

  it('seeds initialData from the mirror instead of fetching inside staleTime', async () => {
    const cache = await makeCache();
    const client = new QueryClient();

    // An entry the caller wants served without a network round trip…
    cache.set(hashQueryKey(['todos', 'u1']), {
      data: [{ id: 1 }],
      dataUpdatedAt: Date.now() - 1_000,
      queryKey: ['todos', 'u1'],
    });

    await prefetchBlazeQuery(cache, client, {
      queryKey: ['todos', 'u1'],
      queryFn: async () => [{ id: 2 }],
      staleTime: 60_000,
    });

    // `initialData` + `staleTime` means TanStack resolves inside the window without a fetch,
    // so the query it built carries the mirror's data — not the fetch fn's.
    const query = client.getQueryCache().get(hashQueryKey(['todos', 'u1']));
    assert.ok(query, 'prefetch seeded the query');
    assert.deepEqual(query.state.data, [{ id: 1 }], 'the mirror data won over the fetch fn');
    assert.equal(query.isStale(), false, 'the staleTime window was respected');
    assert.deepEqual(cache.get(hashQueryKey(['todos', 'u1'])).data, [{ id: 1 }]);
    await client.clear();
  });

  it('swallows fetch errors without mirroring the failure', async () => {
    const cache = await makeCache();
    const client = new QueryClient();

    await prefetchBlazeQuery(cache, client, {
      queryKey: ['todos'],
      queryFn: async () => {
        throw new Error('network down');
      },
    });

    assert.equal(cache.size(), 0, 'a failed prefetch leaves no mirror entry');
    const query = client.getQueryCache().get(hashQueryKey(['todos']));
    assert.ok(query, 'TanStack records its own error state');
    assert.equal(query.state.status, 'error');
  });
});

describe('setBlazeQueryData', () => {
  it("writes through to the mirror with the caller's ttl and tags", async () => {
    const cache = await makeCache();
    const client = new QueryClient();

    const stored = setBlazeQueryData(cache, client, ['todos'], [1, 2, 3], {
      ttlMs: 60_000,
      tags: ['todos', 'session-1'],
    });

    assert.deepEqual(stored, [1, 2, 3]);
    const hash = hashQueryKey(['todos']);
    assert.equal(cache.has(hash), true, 'the mirror write landed');
    const entry = cache.entry(hash);
    assert.deepEqual(entry.value.data, [1, 2, 3]);
    assert.ok(entry.ttlMs > 59_000 && entry.ttlMs <= 60_000, 'the caller\'s ttl won');
    assert.deepEqual(entry.tags, ['todos', 'session-1'], 'the caller\'s tags won');

    await client.clear();
  });

  it('ignores undefined data instead of persisting it', async () => {
    const cache = await makeCache();
    const client = new QueryClient();

    assert.equal(setBlazeQueryData(cache, client, ['todos'], undefined), undefined);
    assert.equal(cache.size(), 0, 'nothing mirrored for undefined data');
  });
});

describe('invalidateBlazeQueries / removeBlazeQueries', () => {
  it('invalidates by queryKey in both caches and purges the mirror', async () => {
    const cache = await makeCache();
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: 60_000 } } });
    client.setQueryData(['todos', 'u1'], [{ id: 1 }]);
    const hash = hashQueryKey(['todos', 'u1']);

    await invalidateBlazeQueries(cache, client, { queryKey: ['todos', 'u1'] });

    assert.equal(cache.has(hash), false, 'the persisted entry was purged');
    const query = client.getQueryCache().find({ queryKey: ['todos', 'u1'] });
    assert.ok(query, 'the TanStack query survives to be refetched');
    assert.equal(query.isStale(), true, '…and is now stale');

    await client.clear();
  });

  it('invalidates by tags — the cross-session purge path', async () => {
    const cache = await makeCache();
    const client = new QueryClient();

    setBlazeQueryData(cache, client, ['todos'], [1], { tags: ['todos'] });

    await invalidateBlazeQueries(cache, client, { tags: ['todos'] });

    assert.equal(cache.size(), 0, 'tagged entries are purged');
    const query = client.getQueryCache().find({ queryKey: ['todos'] });
    assert.ok(query, 'the TanStack side was marked stale, not dropped');
    assert.equal(query.isStale(), true);

    await client.clear();
  });

  it('a tag purge reaches only mirror records — foreign entries with the same tag stay', async () => {
    const cache = await makeCache();
    const client = new QueryClient();

    // Caller domain tags are one namespace across integrations, so an axios entry on a
    // shared cache can carry the very tag TanStack purges with. The purge must still
    // leave it: the selection is "mirror record AND tagged", not "tagged".
    cache.set(
      'get https://api.example.com/todos?a3f9k',
      { status: 200, data: { source: 'axios' }, storedAt: 1, freshUntil: 2 },
      { tags: ['todos'] },
    );
    cache.set('https://api.example.com/profile', { name: 'Ada' }, { tags: ['todos'] });
    setBlazeQueryData(cache, client, ['todos'], [1], { tags: ['todos'] });

    await invalidateBlazeQueries(cache, client, { tags: ['todos'] });

    assert.equal(cache.has(hashQueryKey(['todos'])), false, 'the mirror record is gone');
    assert.equal(cache.size(), 2, 'the two foreign entries kept their tags and their data');
    assert.deepEqual(cache.tagsOf('https://api.example.com/profile'), ['todos']);
  });

  it('intersects a queryKey filter with a tag filter', async () => {
    const cache = await makeCache();
    const client = new QueryClient();

    setBlazeQueryData(cache, client, ['todos', 'u1'], [1], { tags: ['todos', 'user:u1'] });
    setBlazeQueryData(cache, client, ['todos', 'u2'], [2], { tags: ['todos', 'user:u2'] });

    await invalidateBlazeQueries(cache, client, {
      queryKey: ['todos', 'u1'],
      tags: ['todos', 'user:u1'],
    });

    // The key narrowed the tag purge: u1 (tags `todos`+`user:u1`) went, u2 (tag `todos` only)
    // is a different user’s list and stays — the intersection must not union.
    assert.equal(cache.size(), 1, 'only the key/tag-matching entry was purged');
    assert.equal(
      cache.has(hashQueryKey(['todos', 'u1'])),
      false,
      'the matching entry is gone',
    );
    assert.equal(cache.has(hashQueryKey(['todos', 'u2'])), true, 'the other user’s entry stays');
    await client.clear();
  });

  it('removes by tag in both caches', async () => {
    const cache = await makeCache();
    const client = new QueryClient();

    setBlazeQueryData(cache, client, ['todos'], [1], { tags: ['todos'] });
    const hash = hashQueryKey(['todos']);

    removeBlazeQueries(cache, client, { tags: ['todos'] });

    assert.equal(cache.has(hash), false, 'the mirror entry is gone');
    assert.equal(client.getQueryCache().find({ queryKey: ['todos'] }), undefined);
  });

  it('removes every mirrored entry when no filter is given', async () => {
    const cache = await makeCache();
    const client = new QueryClient();

    setBlazeQueryData(cache, client, ['todos'], [1]);
    setBlazeQueryData(cache, client, ['posts'], [2]);

    removeBlazeQueries(cache, client);

    assert.equal(cache.size(), 0, 'the whole mirror is gone');
    assert.equal(client.getQueryCache().getAll().length, 0, 'and the whole TanStack cache too');
  });

  it('leaves foreign entries alone when no filter is given (shared cache)', async () => {
    const cache = await makeCache();
    const client = new QueryClient();

    // What another integration would hold on the same store: an axios-shaped record and
    // a raw SWR value — neither carries the mirror's `dataUpdatedAt` stamp.
    cache.set('get https://api.example.com/users?a3f9k', {
      status: 200,
      data: { source: 'axios' },
      storedAt: 1,
      freshUntil: 2,
    });
    cache.set('https://api.example.com/profile', { name: 'Ada' });
    setBlazeQueryData(cache, client, ['todos'], [1]);

    removeBlazeQueries(cache, client);

    assert.equal(cache.has(hashQueryKey(['todos'])), false, 'the mirror record is gone');
    assert.equal(cache.has('get https://api.example.com/users?a3f9k'), true, 'the axios entry stays');
    assert.equal(cache.has('https://api.example.com/profile'), true, 'the SWR entry stays');
    assert.equal(cache.size(), 2, 'the unfiltered purge removed only what TanStack could have written');
  });
});

describe('dehydrateBlazeQueryClient / hydrateBlazeQueryClient', () => {
  it('dehydrates every live record into a TanStack DehydratedState', async () => {
    const cache = await makeCache();
    const client = createBlazeQueryClient({ cache, ttlMs: 60_000 });
    client.setQueryData(['todos', 'u1'], [{ id: 1 }]);
    client.setQueryData(['settings'], { theme: 'dark' });

    const state = dehydrateBlazeQueryClient(cache);

    assert.equal(state.mutations.length, 0);
    assert.equal(state.queries.length, 2);

    const todos = state.queries.find((q) => hashQueryKey(q.queryKey) === hashQueryKey(['todos', 'u1']));
    assert.ok(todos, 'the todos entry made it into the snapshot');
    assert.equal(todos.queryHash, hashQueryKey(['todos', 'u1']));
    assert.deepEqual(todos.queryKey, ['todos', 'u1']);
    assert.equal(todos.state.status, 'success');
    assert.deepEqual(todos.state.data, [{ id: 1 }]);
    assert.ok(todos.state.dataUpdatedAt > 0);
    assert.equal(typeof todos.dehydratedAt, 'number');

    const settings = state.queries.find((q) => hashQueryKey(q.queryKey) === hashQueryKey(['settings']));
    assert.ok(settings, 'the settings entry made it into the snapshot');
    assert.deepEqual(settings.state.data, { theme: 'dark' });

    await client.clear();
  });

  it('skips records written before queryKey existed and honours the predicate', async () => {
    const cache = await makeCache();
    const client = new QueryClient();
    client.setQueryData(['todos'], [1]);

    const state = dehydrateBlazeQueryClient(cache, {
      predicate: (record) => record.dataUpdatedAt > Date.now() - 60_000,
    });
    assert.equal(state.queries.length, 0, 'the freshly written record is outside the window');

    // A legacy record — no `queryKey`, as written by older versions — cannot be rebuilt.
    cache.set(hashQueryKey(['legacy']), { data: 'old', dataUpdatedAt: 123 });
    const legacy = dehydrateBlazeQueryClient(cache);
    assert.equal(legacy.queries.length, 0, 'records without a queryKey cannot be dehydrated');

    // A record inside the window dehydrates.
    cache.set(hashQueryKey(['fresh']), { data: 'new', dataUpdatedAt: Date.now(), queryKey: ['fresh'] });
    const fresh = dehydrateBlazeQueryClient(cache, { predicate: () => true });
    assert.equal(fresh.queries.length, 1, 'the predicate picked the fresh entry');

    await client.clear();
  });

  it('throws when the cache cannot enumerate the mirror', () => {
    const bare = {
      get: () => undefined,
      set: () => {},
      delete: () => false,
      has: () => false,
    };
    assert.throws(() => dehydrateBlazeQueryClient(bare), /entries\(\)/);
  });

  it('round trips through hydrateBlazeQueryClient into a fresh client', async () => {
    const cache = await makeCache();
    const source = createBlazeQueryClient({ cache, ttlMs: 60_000 });
    source.setQueryData(['todos', 'u1'], [{ id: 1 }]);

    const state = dehydrateBlazeQueryClient(cache);
    const target = new QueryClient();
    hydrateBlazeQueryClient(cache, target, state, { ttlMs: 60_000, tags: ['ssr'] });

    const restored = target.getQueryCache().find({ queryKey: ['todos', 'u1'] });
    assert.ok(restored, 'the hydrated client knows the query');
    assert.equal(restored.state.status, 'success');
    assert.deepEqual(restored.state.data, [{ id: 1 }]);

    const hash = hashQueryKey(['todos', 'u1']);
    assert.equal(cache.has(hash), true, 'hydration persists the mirror entry back');
    const entry = cache.entry(hash);
    assert.deepEqual(entry.value.data, [{ id: 1 }]);
    assert.deepEqual(entry.value.queryKey, ['todos', 'u1'], 'the restored entry is self-describing');
    assert.ok(entry.ttlMs > 59_000 && entry.ttlMs <= 60_000, 'the hydrate-time ttl was used');
    assert.deepEqual(entry.tags, ['ssr'], 'the hydrate-time tags were used');
  });

  it('restores infinite queries with their whole payload', async () => {
    const cache = await makeCache();
    cache.set(hashQueryKey(['feed']), {
      data: { pages: [[1], [2]], pageParams: [null, 1] },
      dataUpdatedAt: 1_700_000_000_000,
      queryKey: ['feed'],
      queryType: 'infinite',
    });

    const state = dehydrateBlazeQueryClient(cache);
    const restored = state.queries[0];
    assert.equal(restored.queryType, 'infinite');
    assert.deepEqual(restored.state.data, { pages: [[1], [2]], pageParams: [null, 1] });

    const target = new QueryClient();
    hydrateBlazeQueryClient(cache, target, state);
    const query = target.getQueryCache().find({ queryKey: ['feed'] });
    assert.ok(query);
    assert.equal(query.queryType, 'infinite', 'the rebuilt query is an infinite query');

    await target.clear();
  });
});
