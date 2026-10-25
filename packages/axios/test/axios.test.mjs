/**
 * Smoke tests for `@blaze-cache/axios`.
 *
 * They run against the **built** artifacts (`dist/` + the real wasm binary), so they fail if
 * either side drifts. The adapter is exercised both directly and through `installBlazeCache`
 * on a real axios instance — and every marker-header assertion is paired with a look *inside*
 * the store, so a green run means the payload really landed there.
 *
 *   pnpm --filter @blaze-cache/axios test
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import axios, { AxiosError, AxiosHeaders } from 'axios';

import { createCache } from '@blaze-cache/core';
import {
  blazeAdapter,
  defaultCacheKey,
  fnv1a,
  installBlazeCache,
  parseCacheControl,
} from '@blaze-cache/axios';

const wasmBytes = await readFile(
  new URL('../../core/pkg/blaze_cache_wasm_bg.wasm', import.meta.url),
);

/** A cache over the real wasm module (Node has no `fetch` for `file:` URLs). */
const makeCache = (options = {}) => createCache({ wasm: wasmBytes, persistence: false, ...options });

/** The single stored record — and proof that there *is* one. */
const onlyRecord = (cache) => {
  assert.equal(cache.size(), 1, 'exactly one entry is stored');
  const [key] = cache.keys();
  const record = cache.get(key);
  assert.ok(record, 'and it is readable');
  return { key, record };
};

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

describe('adapter', () => {
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

    // The entry sits under exactly the key `defaultCacheKey` would produce for it.
    const expectedKey = defaultCacheKey(
      { method: 'get', url: '/users/1', headers: {} },
      ['authorization'],
    );
    const { key, record } = onlyRecord(cache);
    assert.equal(key, expectedKey, 'the storage key is the documented default key');
    assert.equal(cache.get(expectedKey).data.id, 1, 'the payload is in the cache');
    assert.equal(record.status, 200);
    assert.equal(record.statusText, '200');
    assert.equal(record.headers['content-type'], 'application/json', 'headers are stored too');
    assert.ok(record.storedAt > 0, 'and it records when');
  });

  it('keeps different Authorization headers apart', async () => {
    const cache = await makeCache();
    const { adapter, calls } = stubNetwork({ '/me': { status: 200, data: { who: 'server' } } });
    const blaze = blazeAdapter({ cache, adapter });

    await blaze({
      method: 'get',
      url: '/me',
      headers: new AxiosHeaders({ authorization: 'Bearer ada' }),
    });
    await blaze({
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
    assert.equal(adaAgain.headers.get('x-blaze-cache'), 'HIT');
    assert.equal(cache.size(), 2, 'two identities occupy two keys');

    const keys = cache.keys();
    assert.ok(keys.every((key) => key.startsWith('get /me?')), 'both under method + URL + hash');
    assert.ok(
      keys.every((key) => !key.includes('ada') && !key.includes('grace')),
      'no readable token ends up in a key',
    );
    assert.deepEqual(cache.entries().map((entry) => entry.value.status), [200, 200]);
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
    const freshKey = onlyRecord(cache).key;
    assert.ok(freshKey.includes('/fresh'), 'the /fresh response is the one stored');
    assert.equal(cache.get(freshKey).data.n, 1, 'with its payload inside');
    assert.ok(
      cache.entry(freshKey).ttlMs > 50_000,
      `max-age=60 became the entry TTL, got ${cache.entry(freshKey).ttlMs}ms`,
    );

    await blaze({ method: 'get', url: '/fresh', headers: new AxiosHeaders() });
    assert.equal(calls.length, 1, 'max-age makes the response reusable');

    await blaze({ method: 'get', url: '/no-store', headers: new AxiosHeaders() });
    await blaze({ method: 'get', url: '/no-store', headers: new AxiosHeaders() });
    assert.equal(calls.length, 3, 'no-store responses are never cached');
    assert.equal(cache.size(), 1, '…so the store still holds only /fresh');
    assert.equal(cache.keys()[0].includes('/no-store'), false);

    await blaze({
      method: 'get',
      url: '/fresh',
      headers: new AxiosHeaders({ 'cache-control': 'no-store' }),
    });
    assert.equal(calls.length, 4, 'a no-store request skips the read too');
    assert.equal(cache.get(freshKey).data.n, 1, 'and leaves the stored entry untouched');
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

    const { key, record } = onlyRecord(cache);
    assert.equal(record.status, 404, 'the failure itself is what got stored');
    assert.equal(record.statusText, 'Not Found');
    assert.equal(record.data, 'gone', 'with its body inside');
    assert.ok(key.includes('/missing'), 'under the documented key');

    await assert.rejects(() => blaze(strict), /status code 404/);
    assert.equal(calls, 1, 'the failure is replayed from cache, not refetched');

    const replayed = await blaze({ ...strict, validateStatus: () => true });
    assert.equal(replayed.status, 404);
    assert.equal(replayed.fromBlazeCache, true);
  });

  it('only stores GET 2xx unless told otherwise', async () => {
    const cache = await makeCache();
    const { adapter, calls } = stubNetwork({
      '/post-it': { status: 200, data: { ok: true } },
      '/broken': { status: 500, data: { ok: false } },
    });
    const blaze = blazeAdapter({ cache, adapter });

    await blaze({ method: 'post', url: '/post-it', data: 1, headers: new AxiosHeaders() });
    await blaze({ method: 'post', url: '/post-it', data: 1, headers: new AxiosHeaders() });
    assert.equal(calls.length, 2, 'POST is never cached by default');

    await blaze({ method: 'get', url: '/broken', headers: new AxiosHeaders() });
    await blaze({ method: 'get', url: '/broken', headers: new AxiosHeaders() });
    assert.equal(calls.length, 4, 'a 500 is never cached by default');
    assert.equal(cache.size(), 0);
    assert.deepEqual(cache.keys(), [], 'the store is verifiably empty');
  });

  it('stores headers that describe the bytes it kept, not the wire', async () => {
    const cache = await makeCache();
    // Exactly what an adapter hands back after decoding: a payload whose real size differs
    // from the length the server declared on the (compressed) wire.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    const { adapter, calls } = stubNetwork({
      '/image.png': {
        status: 200,
        data: png,
        headers: {
          'content-type': 'image/png',
          'content-encoding': 'gzip',
          'content-length': '1425', // the compressed size — not what axios decoded
        },
      },
    });
    const blaze = blazeAdapter({ cache, adapter });

    await blaze({ method: 'get', url: '/image.png', headers: new AxiosHeaders() });
    const hit = await blaze({ method: 'get', url: '/image.png', headers: new AxiosHeaders() });
    assert.equal(calls.length, 1);

    const { record } = onlyRecord(cache);
    assert.deepEqual(record.data, png, 'the decoded bytes are what got stored');
    assert.equal(record.headers['content-encoding'], undefined, 'they are no longer gzipped');
    assert.equal(
      record.headers['content-length'],
      String(png.byteLength),
      `content-length now matches them (${png.byteLength}B, not 1425)`,
    );
    assert.equal(
      record.headers['content-type'],
      'image/png',
      'everything else is replayed untouched',
    );

    assert.equal(hit.headers.get('content-length'), String(png.byteLength), 'so does the replay');
    assert.equal(hit.headers.get('content-encoding'), undefined, 'and no encoding claim either');
    assert.equal(hit.headers.get('x-blaze-cache'), 'HIT');
  });

  it('keeps the declared length on a bodyless response', async () => {
    const cache = await makeCache();
    const { adapter } = stubNetwork({
      '/thing': {
        status: 200,
        data: null,
        headers: { 'content-type': 'application/json', 'content-length': '12' },
      },
    });
    // The adapter stores GET by default; widen it here so the bodyless path is reachable.
    const blaze = blazeAdapter({ cache, adapter, shouldCache: () => true });

    await blaze({ method: 'head', url: '/thing', headers: new AxiosHeaders() });
    const { record } = onlyRecord(cache);
    assert.equal(
      record.headers['content-length'],
      '12',
      "a HEAD's length describes the body a GET would return, so it stays",
    );
    assert.equal(record.data, null, 'with no body stored alongside it');
  });
});

describe('installBlazeCache', () => {
  /** An axios instance with a counting stub adapter — the real "network" for these tests. */
  const makeInstance = () => {
    const calls = [];
    const instance = axios.create({
      baseURL: 'https://api.test',
      adapter: async (config) => {
        calls.push(config);
        return {
          data: { n: calls.length },
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
          config,
          request: {},
        };
      },
    });
    return { instance, calls };
  };

  it('captures the previous adapter instead of wrapping itself', async () => {
    const cache = await makeCache();
    const { instance, calls } = makeInstance();
    installBlazeCache(instance, { cache, ttlMs: 60_000 });

    const first = await instance.get('/users');
    const second = await instance.get('/users');

    // If the wrapper had captured *itself* as the inner adapter this would recurse forever.
    assert.equal(calls.length, 1, 'the network runs once for two identical GETs');
    assert.equal(second.headers.get('x-blaze-cache'), 'HIT');
    assert.deepEqual(second.data, { n: 1 }, 'the cached body is replayed');
    assert.equal(first.headers.get('x-blaze-cache'), 'MISS');

    const { key, record } = onlyRecord(cache);
    assert.ok(key.includes('api.test/users'), `stored under the resolved URL, got ${key}`);
    assert.deepEqual(record.data, { n: 1 }, 'the payload is in the cache');
    assert.equal(record.status, 200);
    assert.ok(
      cache.entry(key).ttlMs > 59_000,
      `stored for the configured ttlMs, got ${cache.entry(key).ttlMs}ms`,
    );
  });

  it('respects a caller-supplied adapter', async () => {
    const cache = await makeCache();
    const { instance } = makeInstance();
    let custom = 0;
    installBlazeCache(instance, {
      cache,
      adapter: async (config) => {
        custom += 1;
        return { data: 'custom', status: 200, statusText: 'OK', headers: {}, config, request: {} };
      },
    });

    await instance.get('/custom');
    await instance.get('/custom');
    assert.equal(custom, 1, 'the supplied adapter is the one being wrapped');

    const { record } = onlyRecord(cache);
    assert.equal(record.data, 'custom', 'and it is what got stored');
  });
});

describe('defaultCacheKey', () => {
  it('is canonical: parameter order does not matter', () => {
    const first = defaultCacheKey({ url: '/u', params: { b: 2, a: 1 }, headers: {} }, []);
    const second = defaultCacheKey({ url: '/u', params: { a: 1, b: 2 }, headers: {} }, []);
    assert.equal(first, second, 'params are stringified in a stable order');
    assert.ok(first.startsWith('get /u?'), `got ${first}`);
  });

  it('folds vary headers into a hash and never stores them verbatim', () => {
    const asAda = defaultCacheKey(
      { url: '/u', headers: { authorization: 'Bearer ada' } },
      ['authorization'],
    );
    const asGrace = defaultCacheKey(
      { url: '/u', headers: { authorization: 'Bearer grace' } },
      ['authorization'],
    );

    assert.notEqual(asAda, asGrace, 'a different token is a different entry');
    assert.equal(
      defaultCacheKey({ url: '/u', headers: { authorization: 'Bearer ada' } }, ['authorization']),
      asAda,
      'the same token maps to the same entry',
    );
    assert.ok(!asAda.includes('Bearer'), 'no readable secret ends up in the key');
    assert.ok(!asAda.includes('ada'), '…in any form');
  });

  it('prefixes the method and keeps the baseURL when there is nothing to vary on', () => {
    // axios always appends a hash — its key also covers `params`, unlike the fetch wrapper's.
    const bare = defaultCacheKey({ url: '/u', headers: {} }, []);
    assert.match(bare, /^get \/u\?/);
    assert.equal(bare, defaultCacheKey({ url: '/u', headers: {} }, []), 'and it is stable');

    assert.match(
      defaultCacheKey({ baseURL: 'https://api.test', url: '/u', headers: {} }, []),
      /^get https:\/\/api\.test\/u\?/,
      'the baseURL is part of the URL',
    );
    assert.match(
      defaultCacheKey({ method: 'post', url: '/u', headers: {} }, []),
      /^post \/u\?/,
      'non-GET methods key differently too',
    );
  });
});

describe('fnv1a', () => {
  it('produces the documented, stable tokens', () => {
    assert.equal(fnv1a(''), 'ztntfp');
    assert.equal(fnv1a('a'), '1r9wi7g');
    assert.equal(fnv1a('Hello, world!'), '1twzd04');
  });
});

describe('parseCacheControl', () => {
  it('parses the directives a client cache must honour', () => {
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
