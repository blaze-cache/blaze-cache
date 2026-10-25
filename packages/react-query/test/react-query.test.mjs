/**
 * Smoke tests for `@blaze-cache/react-query`.
 *
 * They run against the **built** artifacts (`dist/` + the real wasm binary) and drive a real
 * `QueryClient`, so the mirror is exercised exactly as TanStack drives it.
 *
 * `useBlazeQuery` is deliberately not covered here: rendering a hook needs a DOM renderer
 * (jsdom / testing-library), which this repo does not carry. Its data path — the pre-fetch
 * lookup and the seeding — is the sync layer tested below.
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
