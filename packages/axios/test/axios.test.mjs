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
  parseAgeMs,
  parseCacheControl,
  varyIsStorable,
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

  it('spends the response Age against the freshness window', async () => {
    const cache = await makeCache();
    const { adapter, calls } = stubNetwork({
      '/aged': {
        status: 200,
        data: { n: 1 },
        // Replayed by an intermediary halfway to its deadline — the remaining ten seconds,
        // not the full sixty, are what we may keep.
        headers: { 'cache-control': 'max-age=60', age: '50' },
      },
      '/ancient': {
        status: 200,
        data: { n: 2 },
        headers: { 'cache-control': 'max-age=60', age: '60' },
      },
    });
    const blaze = blazeAdapter({ cache, adapter });

    await blaze({ method: 'get', url: '/aged', headers: new AxiosHeaders() });
    const { key, record } = onlyRecord(cache);
    assert.equal(
      record.freshUntil - record.storedAt,
      10_000,
      'max-age=60 minus Age=50 leaves exactly 10s of freshness',
    );
    assert.ok(
      cache.entry(key).ttlMs <= 10_000 && cache.entry(key).ttlMs > 9_000,
      `the store agrees, got ${cache.entry(key).ttlMs}ms`,
    );

    await blaze({ method: 'get', url: '/aged', headers: new AxiosHeaders() });
    assert.equal(calls.length, 1, 'the shortened window still serves a hit');

    // Age ≥ max-age: the response arrived already past its freshness lifetime.
    await blaze({ method: 'get', url: '/ancient', headers: new AxiosHeaders() });
    await blaze({ method: 'get', url: '/ancient', headers: new AxiosHeaders() });
    assert.equal(calls.length, 3, 'a response with no freshness left is never stored');
    assert.equal(cache.size(), 1, 'the store still holds only /aged');
  });

  it('refuses to store a response whose Vary it cannot honour', async () => {
    const cache = await makeCache();
    const { adapter, calls } = stubNetwork({
      '/star': { status: 200, data: { n: 1 }, headers: { vary: '*' } },
      // Not among the configured varyHeaders (`['authorization']`) — we cannot tell two
      // requests apart by a header the key never sees.
      '/unconfigured': { status: 200, data: { n: 2 }, headers: { vary: 'accept-encoding' } },
      // Configured, and matched case-insensitively: `Authorization` ≡ `authorization`.
      '/configured': { status: 200, data: { n: 3 }, headers: { vary: 'Authorization' } },
    });
    const blaze = blazeAdapter({ cache, adapter });

    await blaze({ method: 'get', url: '/star', headers: new AxiosHeaders() });
    await blaze({ method: 'get', url: '/star', headers: new AxiosHeaders() });
    await blaze({ method: 'get', url: '/unconfigured', headers: new AxiosHeaders() });
    await blaze({ method: 'get', url: '/unconfigured', headers: new AxiosHeaders() });
    await blaze({ method: 'get', url: '/configured', headers: new AxiosHeaders() });
    await blaze({ method: 'get', url: '/configured', headers: new AxiosHeaders() });

    assert.equal(
      calls.length,
      5,
      'Vary: * and an unconfigured vary always bounce to the network; the configured one hits',
    );
    assert.equal(cache.size(), 1, 'only the response we can key correctly is stored');
    assert.ok(onlyRecord(cache).key.includes('/configured'));
  });

  it('honours freshUntil even when the cache itself never expires anything', async () => {
    // The documented interface allows a plain `Map` shim — which drops nothing, ever. Only
    // the record's own clock can stop it from replaying stale responses.
    const store = new Map();
    const shim = {
      get: (key) => store.get(key),
      set: (key, value) => store.set(key, value),
      delete: (key) => store.delete(key),
    };
    let allowStore = true;
    const { adapter, calls } = stubNetwork({ '/shim': { status: 200, data: { n: 1 } } });
    const blaze = blazeAdapter({ cache: shim, adapter, shouldCache: () => allowStore });

    await blaze({ method: 'get', url: '/shim', headers: new AxiosHeaders() });
    const hit = await blaze({ method: 'get', url: '/shim', headers: new AxiosHeaders() });
    assert.equal(calls.length, 1, 'while fresh, the shim-served record is a hit');
    assert.equal(hit.fromBlazeCache, true);

    const [key] = [...store.keys()];
    store.get(key).freshUntil = Date.now() - 1;
    allowStore = false;
    const miss = await blaze({ method: 'get', url: '/shim', headers: new AxiosHeaders() });
    assert.equal(calls.length, 2, 'past freshUntil it is a miss, shim or no shim');
    assert.equal(miss.fromBlazeCache, undefined);
    assert.equal(store.size, 0, 'and the expired record was deleted, not left to linger');
  });

  it('lets a request Cache-Control: max-age=0 bypass the read', async () => {
    const cache = await makeCache();
    const { adapter, calls } = stubNetwork({
      '/m0': { status: 200, data: { n: 1 }, headers: { 'cache-control': 'max-age=60' } },
    });
    const blaze = blazeAdapter({ cache, adapter });

    await blaze({ method: 'get', url: '/m0', headers: new AxiosHeaders() });
    await blaze({ method: 'get', url: '/m0', headers: new AxiosHeaders() });
    assert.equal(calls.length, 1, 'by itself the stored response is fresh enough');

    // RFC 9111 §5.2.2.1: max-age=0 means "nothing stored counts as fresh" — and with no
    // conditional requests available here, skipping the read is the only honest answer.
    const fresh = await blaze({
      method: 'get',
      url: '/m0',
      headers: new AxiosHeaders({ 'cache-control': 'max-age=0' }),
    });
    assert.equal(calls.length, 2, 'the read was bypassed');
    assert.equal(fresh.headers.get('x-blaze-cache'), 'MISS');
    assert.equal(fresh.fromBlazeCache, undefined);
  });

  it('never lets a throwing cache layer fail a good response', async () => {
    const cache = await makeCache();
    const { adapter, calls } = stubNetwork({ '/boom': { status: 200, data: { ok: true } } });
    const blaze = blazeAdapter({
      cache,
      adapter,
      shouldCache: () => {
        throw new Error('shouldCache exploded');
      },
    });

    const response = await blaze({ method: 'get', url: '/boom', headers: new AxiosHeaders() });
    assert.equal(response.status, 200, 'the network response reaches the caller untouched');
    assert.equal(cache.size(), 0, 'nothing was stored');
    assert.equal(calls.length, 1);

    const noRead = blazeAdapter({
      cache: {
        get() {
          throw new Error('cache.get exploded');
        },
        set() {},
      },
      adapter,
    });
    const fellThrough = await noRead({ method: 'get', url: '/boom', headers: new AxiosHeaders() });
    assert.equal(fellThrough.status, 200, 'a throwing read falls through to the network');
    assert.equal(calls.length, 2);
  });

  it('stores and replays a literal __proto__ header as an own property', async () => {
    const cache = await makeCache();
    // A legal header name that plain assignment cannot carry — `Object.defineProperty`, not
    // `headers.__proto__ = …`, is what makes this an own key in the first place.
    const headers = { 'content-type': 'application/json' };
    Object.defineProperty(headers, '__proto__', {
      value: 'still-here',
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const { adapter } = stubNetwork({ '/proto': { status: 200, data: { ok: true }, headers } });
    const blaze = blazeAdapter({ cache, adapter });

    await blaze({ method: 'get', url: '/proto', headers: new AxiosHeaders() });
    const { record } = onlyRecord(cache);
    assert.ok(
      Object.keys(record.headers).includes('__proto__'),
      'the legal header survived into the store',
    );
    assert.equal(record.headers['__proto__'], 'still-here', 'with its value intact');
    assert.equal(
      Object.getPrototypeOf(record.headers),
      Object.prototype,
      'as a plain own key, not a re-targeted prototype',
    );

    const hit = await blaze({ method: 'get', url: '/proto', headers: new AxiosHeaders() });
    assert.equal(hit.headers.get('__proto__'), 'still-here', 'and it comes back on replay');
    assert.equal(hit.headers.get('x-blaze-cache'), 'HIT');
    assert.equal(
      Object.getPrototypeOf(hit.headers),
      AxiosHeaders.prototype,
      'without disturbing the AxiosHeaders prototype chain',
    );
    assert.ok(!('still-here' in {}), 'and nothing leaked onto Object.prototype');
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

  it('resolves baseURL + url instead of concatenating them', () => {
    // The concatenation bug: `…/v1` + `s/users` and `…/v` + `1s/users` used to produce one
    // identical key for two different endpoints — a cross-endpoint replay waiting to happen.
    const one = defaultCacheKey(
      { baseURL: 'https://api.test/v1', url: 's/users', headers: {} },
      [],
    );
    const two = defaultCacheKey({ baseURL: 'https://api.test/v', url: '1s/users', headers: {} }, []);
    assert.notEqual(one, two, 'two endpoints must not share a key');

    // …and the mirror image: axios requests `https://api.test/v1/users` for *both* of these
    // (`buildFullPath` collapses the slashes), so both must land on one key too.
    const trailing = defaultCacheKey(
      { baseURL: 'https://api.test/v1/', url: '/users', headers: {} },
      [],
    );
    const bare = defaultCacheKey({ baseURL: 'https://api.test/v1', url: '/users', headers: {} }, []);
    assert.equal(trailing, bare, 'the same request must find the same entry');
    assert.ok(
      trailing.startsWith('get https://api.test/v1/users?'),
      `the key names the URL axios builds, got ${trailing}`,
    );

    // An absolute url ignores the base entirely — `baseURL + url` used to glue them into
    // `https://api.testhttps://…`.
    const elsewhere = defaultCacheKey(
      { baseURL: 'https://api.test', url: 'https://other.test/u', headers: {} },
      [],
    );
    assert.ok(elsewhere.startsWith('get https://other.test/u?'), `got ${elsewhere}`);

    // Not absolute-able? Fall back to the join, which is still the string axios requests.
    const relative = defaultCacheKey({ baseURL: '/api', url: 'users', headers: {} }, []);
    assert.ok(relative.startsWith('get /api/users?'), `relative bases stay relative: ${relative}`);
    const noBase = defaultCacheKey({ url: 'users', headers: {} }, []);
    assert.ok(noBase.startsWith('get users?'), `no base means the raw url: ${noBase}`);
  });

  it('keeps vary values apart without a shared delimiter', () => {
    // A space join makes these two hash alike, although they describe different requests:
    // the values' own spaces cannot be told apart from the separator between names.
    const spaced = defaultCacheKey({ url: '/u', headers: { a: 'x', b: 'y z' } }, ['a', 'b']);
    const shifted = defaultCacheKey({ url: '/u', headers: { a: 'x y', b: 'z' } }, ['a', 'b']);
    assert.notEqual(spaced, shifted, '[a="x", b="y z"] is not [a="x y", b="z"]');
    assert.equal(
      defaultCacheKey({ url: '/u', headers: { a: 'x', b: 'y z' } }, ['a', 'b']),
      spaced,
      'while the same values still map to the same key',
    );
  });

  it('keeps an own __proto__ param from merging two different keys', () => {
    // `defineProperty`, not `__proto__: value` literal syntax — that would re-target the
    // object's prototype instead of creating the own property we need to test.
    const params = Object.defineProperty({}, '__proto__', {
      value: 'x',
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const withProto = { url: '/u', params, headers: {} };
    const without = { url: '/u', params: {}, headers: {} };

    assert.notEqual(
      defaultCacheKey(withProto, []),
      defaultCacheKey(without, []),
      'a param the stringify must not be allowed to lose',
    );
    assert.equal(
      defaultCacheKey(withProto, []),
      defaultCacheKey(withProto, []),
      '…and it is still stable',
    );
    assert.equal(Object.prototype.x, undefined, 'nothing leaked onto Object.prototype');
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

  it('treats no-cache="field1" as no-cache', () => {
    // The field-names parameter only narrows *what* must be revalidated — it never turns
    // the directive into something a cache without conditional requests may serve blindly.
    assert.deepEqual(parseCacheControl('no-cache="field1"'), {
      noStore: false,
      noCache: true,
      maxAgeMs: undefined,
    });
    assert.deepEqual(parseCacheControl('max-age=60, no-cache="set-cookie"'), {
      noStore: false,
      noCache: true,
      maxAgeMs: 60_000,
    });
    assert.equal(parseCacheControl('no-cache-field').noCache, false, 'unrelated names stay out');
  });
});

describe('parseAgeMs', () => {
  it('parses usable ages and treats everything else as zero', () => {
    assert.equal(parseAgeMs('42'), 42_000);
    assert.equal(parseAgeMs(' 5 '), 5_000, 'surrounding whitespace is not a number');
    assert.equal(parseAgeMs('-1'), 0, 'a negative age is meaningless');
    assert.equal(parseAgeMs('later'), 0, 'and so is an unparsable one');
    assert.equal(parseAgeMs('Infinity'), 0, '…as is one without a bound');
    assert.equal(parseAgeMs(undefined), 0, 'absent means "we know nothing"');
    assert.equal(parseAgeMs(null), 0);
  });
});

describe('varyIsStorable', () => {
  it('refuses Vary: * and any vary it cannot fold into the key', () => {
    assert.equal(varyIsStorable(null, ['authorization']), true, 'no Vary asks for nothing');
    assert.equal(varyIsStorable(undefined, ['authorization']), true);
    assert.equal(varyIsStorable('', ['authorization']), true, 'an empty one either');
    assert.equal(varyIsStorable('  ', ['authorization']), true);
    assert.equal(
      varyIsStorable('Authorization', ['authorization']),
      true,
      'field names are case-insensitive',
    );
    assert.equal(
      varyIsStorable('authorization, accept-encoding', ['authorization']),
      false,
      'one unconfigured name is enough to refuse the store',
    );
    assert.equal(
      varyIsStorable('*', ['authorization']),
      false,
      'Vary: * is never cacheable (RFC 9111 §3)',
    );
  });
});
