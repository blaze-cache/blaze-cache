/**
 * End-to-end smoke tests, run with `pnpm smoke`.
 *
 * These exercise the **built** artifacts — each package's `dist` and the wasm binary —
 * against a real `WebAssembly` runtime, so they fail if either the Rust core or the
 * TypeScript glue drifts. They import the packages by relative path because the repo root
 * does not depend on them; consumers resolve the same files through the `exports` maps.
 */
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AxiosError, AxiosHeaders } from 'axios';

import { createCache, stableStringify } from '../packages/core/dist/index.js';
import { blazeAdapter, parseCacheControl } from '../packages/axios/dist/index.js';
import { createBlazeQueryClient, hashQueryKey } from '../packages/react-query/dist/index.js';

const wasmBytes = await readFile(
  new URL('../packages/core/pkg/blaze_cache_wasm_bg.wasm', import.meta.url),
);

/** Builds a cache over the real wasm module (Node has no `fetch` for `file:` URLs). */
const makeCache = (options = {}) => createCache({ wasm: wasmBytes, persistence: false, ...options });

describe('core cache', () => {
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
    assert.equal(cache.size, 1);
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
    assert.equal(cache.size, 1);
  });

  it('expires entries lazily and reports the expiration', async () => {
    const cache = await makeCache();

    cache.set('short', 1, { ttlMs: 20 });
    assert.equal(cache.has('short'), true);
    await delay(60);
    assert.equal(cache.has('short'), false, 'has() sees through the TTL');
    assert.equal(cache.get('short'), undefined);
    assert.equal(cache.stats().expirations, 1);
  });

  it('protects visited entries when evicting over capacity', async () => {
    const cache = await makeCache({ capacity: 3 });

    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.get('a'); // "a" becomes protected
    cache.set('d', 4); // forces an eviction

    assert.equal(cache.size, 3);
    assert.equal(cache.has('a'), true, 'the visited entry survives');
    assert.equal(cache.has('b'), false, 'the oldest unvisited entry goes');
    assert.equal(cache.has('c'), true);
    assert.equal(cache.has('d'), true);
    assert.equal(cache.stats().evictions, 1);
    assert.equal(cache.capacity, 3);
  });

  it('invalidates by tag and prunes expired entries', async () => {
    const cache = await makeCache();

    cache.set('u1', 1, { tags: ['user:1'] });
    cache.set('u2', 2, { tags: ['user:2', 'vip'] });
    cache.set('page', 3, { tags: ['public'] });
    cache.set('stale', 4, { ttlMs: 20 });
    await delay(60);

    assert.deepEqual(cache.invalidateTags('user:1'), ['u1']);
    assert.equal(cache.size, 3, 'size counts expired-but-unpruned entries too');

    assert.deepEqual(cache.prune().sort(), ['stale']);
    assert.equal(cache.size, 2, 'prune reclaims the expired one');

    const removed = cache.invalidateTags('vip', 'public');
    assert.deepEqual(removed.sort(), ['page', 'u2']);
    assert.equal(cache.size, 0, 'fully purged');
    cache.set('again', 1);
    assert.equal(cache.has('again'), true);
  });

  it('exposes entries and metadata for persistence layers', async () => {
    const cache = await makeCache();
    cache.set('user:7', 'payload', { ttlMs: 60_000, tags: ['user:7'] });

    const entry = cache.entry('user:7');
    assert.equal(entry.key, 'user:7');
    assert.equal(entry.value, 'payload');
    assert.equal(entry.tags.length, 1);
    assert.ok(entry.ttlMs > 0 && entry.ttlMs <= 60_000);

    assert.deepEqual(
      cache.entries().map((item) => item.key),
      ['user:7'],
    );
    assert.equal(cache.entry('nope'), undefined);
  });

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
  });
});

describe('key and header helpers', () => {
  it('stableStringify is order-independent', () => {
    assert.equal(
      stableStringify({ b: 1, a: { d: 2, c: 3 } }),
      stableStringify({ a: { c: 3, d: 2 }, b: 1 }),
    );
    assert.equal(stableStringify(undefined), 'undefined');
    assert.equal(stableStringify([1, 2]), '[1,2]', 'array order is preserved');
  });

  it('parses the Cache-Control directives a client cache must honour', () => {
    assert.deepEqual(parseCacheControl('max-age=30, public'), {
      noStore: false,
      noCache: false,
      maxAgeMs: 30_000,
    });
    assert.equal(parseCacheControl('no-store').noStore, true);
    assert.equal(parseCacheControl('NO-CACHE').noCache, true);
    assert.equal(parseCacheControl(undefined).maxAgeMs, undefined);
  });
});

describe('axios adapter', () => {
  /** A faithful stand-in for a network adapter: settles like axios's own adapters do. */
  const stubNetwork = (responses) => {
    const calls = [];
    const adapter = async (config) => {
      calls.push(config);
      const canned = responses[config.url] ?? { status: 200, data: { ok: true } };
      const response = {
        data: canned.data,
        status: canned.status,
        statusText: String(canned.status),
        headers: canned.headers ?? { 'content-type': 'application/json' },
        config,
        request: {},
      };
      if (config.validateStatus && !config.validateStatus(canned.status)) {
        throw new AxiosError(
          `Request failed with status code ${canned.status}`,
          canned.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
          config,
          response.request,
          response,
        );
      }
      return response;
    };
    return { adapter, calls };
  };

  it('serves the second request from cache and marks it', async () => {
    const cache = await makeCache();
    const { adapter, calls } = stubNetwork({ '/users/1': { status: 200, data: { id: 1 } } });
    const blaze = blazeAdapter({ cache, adapter });

    const miss = await blaze({ method: 'get', url: '/users/1', headers: new AxiosHeaders() });
    const hit = await blaze({ method: 'get', url: '/users/1', headers: new AxiosHeaders() });

    assert.equal(calls.length, 1, 'the network is hit exactly once');
    assert.equal(miss.fromBlazeCache, undefined);
    assert.equal(miss.headers.get('x-blaze-cache'), 'MISS');
    assert.equal(hit.fromBlazeCache, true);
    assert.equal(hit.headers.get('x-blaze-cache'), 'HIT');
    assert.deepEqual(hit.data, { id: 1 });
    assert.equal(hit.status, 200);
  });

  it('keeps different Authorization headers apart', async () => {
    const cache = await makeCache();
    const { adapter, calls } = stubNetwork({ '/me': { status: 200, data: { who: 'server' } } });
    const blaze = blazeAdapter({ cache, adapter });

    const asAda = await blaze({
      method: 'get',
      url: '/me',
      headers: new AxiosHeaders({ authorization: 'Bearer ada' }),
    });
    const asGrace = await blaze({
      method: 'get',
      url: '/me',
      headers: new AxiosHeaders({ authorization: 'Bearer grace' }),
    });
    assert.equal(calls.length, 2, 'a different token must miss');

    const adaAgain = await blaze({
      method: 'get',
      url: '/me',
      headers: new AxiosHeaders({ authorization: 'Bearer ada' }),
    });
    assert.equal(calls.length, 2, 'the same token hits again');
    assert.equal(asAda.headers.get('x-blaze-cache'), 'MISS');
    assert.equal(asGrace.headers.get('x-blaze-cache'), 'MISS');
    assert.equal(adaAgain.headers.get('x-blaze-cache'), 'HIT');
    assert.equal(cache.size, 2, 'two identities occupy two keys');
  });

  it('honours Cache-Control on both sides', async () => {
    const cache = await makeCache();
    const { adapter, calls } = stubNetwork({
      '/fresh': {
        status: 200,
        data: { n: 1 },
        headers: { 'cache-control': 'max-age=60' },
      },
      '/no-store': {
        status: 200,
        data: { n: 2 },
        headers: { 'cache-control': 'no-store' },
      },
    });
    const blaze = blazeAdapter({ cache, adapter });

    await blaze({ method: 'get', url: '/fresh', headers: new AxiosHeaders() });
    await blaze({ method: 'get', url: '/fresh', headers: new AxiosHeaders() });
    assert.equal(calls.length, 1, 'max-age makes the response reusable');

    await blaze({ method: 'get', url: '/no-store', headers: new AxiosHeaders() });
    await blaze({ method: 'get', url: '/no-store', headers: new AxiosHeaders() });
    assert.equal(calls.length, 3, 'no-store responses are never cached');

    await blaze({
      method: 'get',
      url: '/fresh',
      headers: new AxiosHeaders({ 'cache-control': 'no-store' }),
    });
    assert.equal(calls.length, 4, 'a no-store request skips the read too');
  });

  it('replays a cached failure with the same validation rules', async () => {
    const cache = await makeCache();
    // Real axios adapters reject non-2xx responses, so a lenient inner adapter is what lets
    // a failure reach the cache in the first place. Replaying it must still respect the
    // *current* request's `validateStatus`.
    let calls = 0;
    const lenient = async (config) => {
      calls += 1;
      return {
        data: 'gone',
        status: 404,
        statusText: 'Not Found',
        headers: {},
        config,
        request: {},
      };
    };
    const blaze = blazeAdapter({ cache, adapter: lenient, shouldCache: () => true });

    const strict = {
      method: 'get',
      url: '/missing',
      headers: new AxiosHeaders(),
      validateStatus: (status) => status < 300,
    };

    const stored = await blaze({ ...strict, validateStatus: () => true });
    assert.equal(calls, 1);
    assert.equal(stored.status, 404);

    await assert.rejects(() => blaze(strict), /status code 404/);
    assert.equal(calls, 1, 'the failure is replayed from cache, not refetched');

    const replayed = await blaze({ ...strict, validateStatus: () => true });
    assert.equal(replayed.status, 404);
    assert.equal(replayed.fromBlazeCache, true);
  });
});

describe('react-query integration', () => {
  it('mirrors successful queries and forgets removed ones', async () => {
    const cache = await makeCache();
    const client = createBlazeQueryClient({ cache, ttlMs: 60_000 });

    const queryKey = ['todos', { page: 1 }];
    client.setQueryData(queryKey, [1, 2, 3]);

    const hash = hashQueryKey(queryKey);
    const record = cache.get(hash);
    assert.deepEqual(record.data, [1, 2, 3]);
    assert.equal(typeof record.dataUpdatedAt, 'number');

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

    assert.equal(cache.has(hashQueryKey(['private', 'user'])), false);
    assert.equal(cache.has(hashQueryKey(['public', 'todos'])), true);
    await client.clear();
  });
});
