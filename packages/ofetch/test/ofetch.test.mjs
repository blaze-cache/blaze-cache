/**
 * Smoke tests for `@blaze-cache/ofetch`.
 *
 * They run against the **built** artifacts (`dist/` + the real wasm binary). The network is
 * always a stub, so the suite is deterministic: every assertion about "the network was hit
 * exactly once" is a real assertion about the cache — and each marker-header check is paired
 * with a look *inside* the store, so a green run means the payload really landed there.
 *
 *   pnpm --filter @blaze-cache/ofetch test
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { ofetch, createFetch } from 'ofetch';

import { createCache } from '@blaze-cache/core';
import { blazeOfetch, createBlazeOfetch, defaultCacheKey } from '@blaze-cache/ofetch';

const wasmBytes = await readFile(
  new URL('../../core/pkg/blaze_cache_wasm_bg.wasm', import.meta.url),
);

/** A cache over the real wasm module (Node has no `fetch` for `file:` URLs). */
const makeCache = (options = {}) => createCache({ wasm: wasmBytes, persistence: false, ...options });

/**
 * A stand-in for the real network, handed to ofetch as its `fetch` option.
 *
 * `handler(url, callNumber, init)` returns the canned spec: `body` is JSON-encoded for
 * you, while `raw` is passed through untouched so a test can serve bytes that JSON could
 * never round-trip.
 */
const stubNetwork = (handler) => {
  const calls = [];
  const net = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = String(init?.method ?? (typeof input !== 'string' ? input.method : undefined) ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers ?? (typeof input !== 'string' ? input.headers : undefined));
    calls.push({ url, method });

    const spec = handler(url, calls.length, headers, init) ?? {};
    const { status = 200, statusText = 'OK', body, raw } = spec;
    const payload = raw !== undefined ? raw : body === undefined ? null : JSON.stringify(body);
    const response = new Response(payload, {
      status,
      statusText,
      headers: new Headers(spec.headers ?? { 'content-type': 'application/json' }),
    });
    Object.defineProperty(response, 'url', { value: url });
    Object.defineProperty(response, 'redirected', { value: false });
    return response;
  };
  return { net, calls };
};

/**
 * The single stored record — and proof that there *is* one.
 */
const onlyRecord = (cache) => {
  assert.equal(cache.size(), 1, 'exactly one entry is stored');
  const [key] = cache.keys();
  const record = cache.get(key);
  assert.ok(record, 'and it is readable');
  return { key, record };
};

const storedJson = (record) => JSON.parse(new TextDecoder().decode(record.body));
const freshFor = (record) => record.freshUntil - record.storedAt;

/** Buffering/storing is fire-and-forget; let the background write settle. */
const settle = async (value) => {
  await delay(0);
  return value;
};

const USERS = 'https://api.example.com/api/users';
const TTL_MS = 30_000;

describe('blazeOfetch', () => {
  it('caches GET responses and marks HIT/MISS (parsed + raw)', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ body: { users: [1, 2] } }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, { ttlMs: TTL_MS });

    const miss = await settle(api(USERS));
    const hit = await settle(api(USERS));

    assert.equal(calls.length, 1, 'the network is hit exactly once');
    assert.deepEqual(miss, { users: [1, 2] }, 'parsed MISS payload');
    assert.deepEqual(hit, { users: [1, 2] }, 'parsed HIT payload replayed');

    const missRaw = await settle(api.raw(USERS));
    assert.equal(missRaw.headers.get('x-blaze-cache'), 'HIT');
    assert.equal(missRaw.status, 200);
    assert.equal(missRaw.url, USERS);

    const { key, record } = onlyRecord(cache);
    assert.ok(key.startsWith(`get ${USERS}`), `stored under method + URL, got ${key}`);
    assert.equal(cache.hasTag(key, 'ofetch'), true, 'under the default tag');
    assert.equal(cache.hasTag(key, `get ${USERS}`), true, 'under the per-resource tag');
    assert.deepEqual(storedJson(record), { users: [1, 2] }, 'the payload is in the cache');
  });

  it('works with an ofetch.create() instance (baseURL resolved in key)', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ body: { ok: true } }));
    const base = createFetch({ fetch: net, defaults: { baseURL: 'https://api.example.com' } });
    // Pass baseURL as a key-resolution hint so the wrapper resolves keys like ofetch does.
    const api = blazeOfetch(base, cache, { ttlMs: TTL_MS, baseURL: 'https://api.example.com' });

    const miss = await settle(api('/api/users'));
    const hit = await settle(api('/api/users'));

    assert.equal(calls.length, 1);
    assert.deepEqual(miss, { ok: true });
    assert.deepEqual(hit, { ok: true });

    const { key } = onlyRecord(cache);
    assert.ok(key.includes('https://api.example.com/api/users'), `key uses resolved URL, got ${key}`);
  });

  it('never caches methods outside `methods`', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ body: { ok: true } }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, { ttlMs: TTL_MS });

    await settle(api(USERS, { method: 'POST', body: { a: 1 } }));
    await settle(api(USERS, { method: 'POST', body: { a: 1 } }));

    assert.equal(calls.length, 2, 'POST always goes to the network');
    assert.deepEqual(cache.keys(), [], 'the store is verifiably empty');
  });

  it('stores responses for ttlMs and refetches once they expire', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork((url) => ({ body: { url } }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, { ttlMs: 30 });

    await settle(api(USERS));
    await settle(api(USERS));
    assert.equal(calls.length, 1, 'served from cache within the window');

    const before = onlyRecord(cache).record;
    assert.ok(freshFor(before) <= 30, `stored for ttlMs, got ${freshFor(before)}ms`);

    await delay(80);
    await settle(api(USERS));
    assert.equal(calls.length, 2, 'expired entries fall through to the network');

    const after = onlyRecord(cache).record;
    assert.ok(after.storedAt > before.storedAt, 'the refetch rewrote the same key');
  });

  it('accepts ttlMs as a per-response function', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork((url) => ({ body: { url } }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, {
      ttlMs: (_response, ctx) => (ctx.url.endsWith('/long') ? 600_000 : 1),
    });

    const longUrl = `${USERS}/long`;
    await settle(api(longUrl));
    await settle(api(longUrl));
    assert.equal(calls.length, 1);
    const { record } = onlyRecord(cache);
    assert.ok(freshFor(record) >= 599_000, `callback's 600s became TTL, got ${freshFor(record)}ms`);
  });

  it('shouldCache decides what is stored', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork((url) => ({
      body: { url },
      status: url.endsWith('/keep') ? 200 : 203,
    }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, {
      ttlMs: TTL_MS,
      shouldCache: (response) => response.status === 200,
    });

    await settle(api(`${USERS}/keep`));
    await settle(api(`${USERS}/skip`));
    await settle(api(`${USERS}/skip`));

    assert.equal(calls.length, 3, 'the rejected response is refetched');
    const { record } = onlyRecord(cache);
    assert.ok(record.url.endsWith('/keep'), 'only the kept one is in the store');
  });

  it('accepts a custom key callback', async () => {
    const cache = await makeCache();
    const { net } = stubNetwork(() => ({ body: { ok: true } }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, {
      ttlMs: TTL_MS,
      key: ({ method, url }) => `v2:${method.toLowerCase()} ${url}`,
    });

    await settle(api(USERS));
    const { key } = onlyRecord(cache);
    assert.equal(key, `v2:get ${USERS}`);
  });

  it('invalidateTags drops the default tags', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ body: { ok: true } }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, { ttlMs: TTL_MS });
    const other = `${USERS}/other`;

    await settle(api(USERS));
    await settle(api(other));

    cache.invalidateTags(`get ${other}`);
    assert.equal(cache.size(), 1);

    cache.invalidateTags('ofetch');
    assert.deepEqual(cache.keys(), []);

    await settle(api(USERS));
    assert.equal(calls.length, 3);
  });

  it('markerHeader: false omits the marker on raw hits', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ body: { ok: true } }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, { ttlMs: TTL_MS, markerHeader: false });

    await settle(api(USERS));
    const hit = await api.raw(USERS);
    assert.equal(calls.length, 1);
    assert.equal(hit.headers.get('x-blaze-cache'), null);
  });
});

describe('Cache-Control (ofetch)', () => {
  it('response max-age overrides ttlMs', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({
      body: { ok: true },
      headers: { 'cache-control': 'max-age=60' },
    }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, { ttlMs: 1 });

    await settle(api(USERS));
    const stored = onlyRecord(cache).record;
    assert.ok(freshFor(stored) >= 59_000, `max-age became window, got ${freshFor(stored)}ms`);

    await delay(50);
    await settle(api(USERS));
    assert.equal(calls.length, 1, 'max-age overrides ttlMs');
  });

  it('deducts the response Age from the freshness window', async () => {
    const cache = await makeCache();
    const { net } = stubNetwork(() => ({
      body: { ok: true },
      headers: { 'cache-control': 'max-age=60', age: '55' },
    }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, { ttlMs: 600_000 });

    await settle(api(USERS));
    const stored = onlyRecord(cache).record;
    assert.ok(freshFor(stored) <= 5_000 && freshFor(stored) >= 4_000, `got ${freshFor(stored)}ms`);
  });

  it('never stores a response declaring no-store or no-cache', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork((url) => ({
      body: { url },
      headers: url.includes('store') ? { 'cache-control': 'no-store' } : { 'cache-control': 'no-cache' },
    }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, { ttlMs: TTL_MS });

    await settle(api(`${USERS}/store`));
    await settle(api(`${USERS}/store`));
    await settle(api(`${USERS}/cache`));
    await settle(api(`${USERS}/cache`));

    assert.equal(calls.length, 4);
    assert.deepEqual(cache.keys(), []);
  });

  it('cacheControl: false treats ttlMs as the only authority', async () => {
    const cache = await makeCache();
    const { net } = stubNetwork(() => ({
      body: { ok: true },
      headers: { 'cache-control': 'no-store, max-age=600' },
    }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, { ttlMs: 30, cacheControl: false });

    await settle(api(USERS));
    const stored = onlyRecord(cache).record;
    assert.ok(freshFor(stored) <= 30, `server directives ignored, got ${freshFor(stored)}ms`);
  });
});

describe('keys and vary (ofetch)', () => {
  it('folds Authorization into the default key (hashed)', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ body: { ok: true } }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, { ttlMs: TTL_MS });

    await settle(api(USERS, { headers: { authorization: 'Bearer alice' } }));
    await settle(api(USERS, { headers: { authorization: 'Bearer bob' } }));

    assert.equal(calls.length, 2, 'different user never replays another’s response');
    assert.equal(cache.size(), 2);
    for (const key of cache.keys()) assert.ok(!key.includes('Bearer'));
  });

  it('leaves a response varying outside varyHeaders uncached', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ body: { ok: true }, headers: { vary: 'accept-language' } }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, { ttlMs: TTL_MS });

    await settle(api(USERS));
    await settle(api(USERS));

    assert.equal(calls.length, 2);
    assert.deepEqual(cache.keys(), []);
  });
});

describe('createBlazeOfetch', () => {
  it('creates an instance with baseURL and caches', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ body: { users: [1] } }));
    const api = createBlazeOfetch(cache, {
      baseURL: 'https://api.example.com',
      fetch: net,
      ttlMs: TTL_MS,
    });

    const miss = await settle(api('/api/users'));
    const hit = await api('/api/users');

    assert.equal(calls.length, 1);
    assert.deepEqual(miss, { users: [1] });
    assert.deepEqual(hit, { users: [1] });

    const raw = await api.raw('/api/users');
    assert.equal(raw.headers.get('x-blaze-cache'), 'HIT');
    const { key } = onlyRecord(cache);
    assert.ok(key.includes('https://api.example.com/api/users'), `keyed on resolved URL, got ${key}`);
  });
});

describe('request semantics (ofetch)', () => {
  it('a read issued straight after a MISS waits for the write and hits', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ body: { ok: true } }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, { ttlMs: TTL_MS });

    // No settle between calls: the pending-write gate must make the second read wait.
    const miss = await api(USERS);
    const hit = await api(USERS);

    assert.equal(calls.length, 1, 'the second read found the in-flight write');
    assert.deepEqual(miss, { ok: true });
    assert.deepEqual(hit, { ok: true });
  });

  it('request cache: "no-store" bypasses read and write', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ body: { ok: true } }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, { ttlMs: TTL_MS });

    await settle(api(USERS, { cache: 'no-store' }));
    await settle(api(USERS, { cache: 'no-store' }));

    assert.equal(calls.length, 2, 'neither call touched the cache');
    assert.deepEqual(cache.keys(), [], 'nothing was stored');
  });

  it('request Cache-Control: no-store bypasses read and write', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ body: { ok: true } }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, { ttlMs: TTL_MS });

    await settle(api(USERS, { headers: { 'Cache-Control': 'no-store' } }));
    await settle(api(USERS, { headers: { 'Cache-Control': 'no-store' } }));

    assert.equal(calls.length, 2);
    assert.deepEqual(cache.keys(), []);
  });

  it('request Cache-Control: no-cache skips the read but still stores', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ body: { ok: true } }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, { ttlMs: TTL_MS });

    await settle(api(USERS, { headers: { 'Cache-Control': 'no-cache' } }));
    assert.equal(calls.length, 1);

    const hit = await settle(api(USERS));
    assert.equal(calls.length, 1, 'the no-cache call stored a readable entry');
    assert.deepEqual(hit, { ok: true });

    await settle(api(USERS, { headers: { 'Cache-Control': 'no-cache' } }));
    assert.equal(calls.length, 2, 'a repeat no-cache goes back to the network');
  });

  it('resolves per-call query params into the cache key (no collisions)', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork((url) => ({ body: { url } }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, { ttlMs: TTL_MS });

    await settle(api(USERS, { query: { page: '1' } }));
    await settle(api(USERS, { query: { page: '2' } }));
    await settle(api(USERS, { query: { page: '1' } }));

    assert.equal(calls.length, 2, 'different query → different key; same query → HIT');
    assert.equal(cache.size(), 2);
  });

  it('wrapped .create() returns a cached instance', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ body: { ok: true } }));
    const base = blazeOfetch(
      createFetch({ fetch: net, defaults: { baseURL: 'https://api.example.com' } }),
      cache,
      { ttlMs: TTL_MS, baseURL: 'https://api.example.com' },
    );
    const derived = base.create({ retry: 0 });

    await settle(derived('/api/users'));
    await settle(derived('/api/users'));

    assert.equal(calls.length, 1, 'derived instance is also cached');
  });
});

describe('response handling (ofetch)', () => {
  it('replays a 204 with no body', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ status: 204, statusText: 'No Content', body: undefined, headers: {} }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, { ttlMs: TTL_MS });

    // ofetch may return null/undefined for 204 _data; the key behavior is "served from cache".
    await settle(api(USERS));
    const raw = await api.raw(USERS);

    assert.equal(calls.length, 1);
    assert.equal(raw.headers.get('x-blaze-cache'), 'HIT');
    assert.equal(raw.status, 204);
  });

  it('does not cache non-2xx by default when ignoreResponseError is set', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ status: 404, statusText: 'Not Found', body: { error: 'nope' } }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, { ttlMs: TTL_MS });

    await settle(api(USERS, { ignoreResponseError: true }));
    await settle(api(USERS, { ignoreResponseError: true }));

    assert.equal(calls.length, 2, '404 not stored by default');
    assert.deepEqual(cache.keys(), []);
  });

  it('4xx throws by default and is not cached', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ status: 404, statusText: 'Not Found', body: { error: 'nope' } }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, { ttlMs: TTL_MS });

    await assert.rejects(() => api(USERS));
    await assert.rejects(() => api(USERS));

    assert.equal(calls.length, 2, 'errors are not cached');
    assert.deepEqual(cache.keys(), []);
  });

  it('preserves response url metadata on HIT', async () => {
    const cache = await makeCache();
    const { net } = stubNetwork(() => ({ body: { ok: true } }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, { ttlMs: TTL_MS });

    await settle(api(USERS));
    const hit = await api.raw(USERS);

    assert.equal(hit.url, USERS);
  });
});

describe('vary and key edge cases (ofetch)', () => {
  it('never stores Vary: *', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ body: { ok: true }, headers: { vary: '*' } }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, { ttlMs: TTL_MS });

    await settle(api(USERS));
    await settle(api(USERS));

    assert.equal(calls.length, 2);
    assert.deepEqual(cache.keys(), []);
  });

  it('stores a response varying on a keyed header', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ body: { ok: true }, headers: { vary: 'authorization' } }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, { ttlMs: TTL_MS });

    await settle(api(USERS, { headers: { authorization: 'Bearer alice' } }));
    await settle(api(USERS, { headers: { authorization: 'Bearer alice' } }));

    assert.equal(calls.length, 1);
  });

  it('varyHeaders: [] uses the bare method+url key form', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ body: { ok: true } }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, { ttlMs: TTL_MS, varyHeaders: [] });

    await settle(api(USERS, { headers: { authorization: 'Bearer alice' } }));
    await settle(api(USERS, { headers: { authorization: 'Bearer bob' } }));

    assert.equal(calls.length, 1, 'one URL, one entry when vary is disabled');
    const { key } = onlyRecord(cache);
    assert.equal(key, `get ${USERS}`);
  });

  it('defaultCacheKey is exported and stable', () => {
    const headers = new Headers({ authorization: 'Bearer x' });
    const a = defaultCacheKey('GET', USERS, headers, ['authorization']);
    const b = defaultCacheKey('GET', USERS, headers, ['authorization']);
    assert.equal(a, b);
    assert.ok(a.startsWith(`get ${USERS}?`));
    assert.ok(!a.includes('Bearer'));
  });
});

describe('resilience (ofetch)', () => {
  it('a throwing cache.get falls through to the network, never failing the response', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ body: { ok: true } }));
    const broken = { get() { throw new Error('cache is down'); }, set: (...args) => cache.set(...args) };
    const api = blazeOfetch(createFetch({ fetch: net }), broken, { ttlMs: TTL_MS });

    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
      const first = await settle(api(USERS));
      const second = await settle(api(USERS));
      assert.deepEqual(first, { ok: true });
      assert.deepEqual(second, { ok: true });
      assert.equal(calls.length, 2);
    } finally {
      console.warn = original;
    }
    assert.equal(warnings.length, 1, 'announced once');
  });

  it('a throwing shouldCache is treated as "do not store"', async () => {
    const cache = await makeCache();
    const { net } = stubNetwork(() => ({ body: { ok: true } }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, {
      ttlMs: TTL_MS,
      shouldCache: () => { throw new Error('boom'); },
    });

    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
      const response = await settle(api(USERS));
      assert.deepEqual(response, { ok: true }, 'the network response is still returned');
    } finally {
      console.warn = original;
    }
    assert.deepEqual(cache.keys(), [], 'nothing was stored');
    assert.equal(warnings.length, 1);
  });

  it('a throwing cache.set does not fail the response', async () => {
    const cache = await makeCache();
    const { net } = stubNetwork(() => ({ body: { ok: true } }));
    const broken = { get: (k) => cache.get(k), set() { throw new Error('set failed'); } };
    const api = blazeOfetch(createFetch({ fetch: net }), broken, { ttlMs: TTL_MS });

    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
      const response = await settle(api(USERS));
      await delay(20); // let background store attempt
      assert.deepEqual(response, { ok: true });
    } finally {
      console.warn = original;
    }
    assert.equal(warnings.length, 1);
  });
});

describe('regressions (ofetch)', () => {
  it('never replays one origin\'s response for another (undisclosed instance baseURL)', async () => {
    const cache = await makeCache();
    const alpha = stubNetwork(() => ({ body: { servedBy: 'ALPHA' } }));
    const beta = stubNetwork(() => ({ body: { servedBy: 'BETA' } }));
    // The `baseURL` lives in each ofetch instance's `defaults`, which ofetch keeps in a
    // closure it never exposes — blazeOfetch receives no `baseURL` hint, exactly the shape
    // that used to key both origins onto the one relative URL they have in common.
    const apiA = blazeOfetch(
      createFetch({ fetch: alpha.net, defaults: { baseURL: 'https://alpha.example.com' } }),
      cache,
      { ttlMs: TTL_MS },
    );
    const apiB = blazeOfetch(
      createFetch({ fetch: beta.net, defaults: { baseURL: 'https://beta.example.com' } }),
      cache,
      { ttlMs: TTL_MS },
    );

    const first = await settle(apiA('/users'));
    const second = await settle(apiB('/users'));

    assert.deepEqual(first, { servedBy: 'ALPHA' }, 'alpha is served by alpha');
    assert.deepEqual(second, { servedBy: 'BETA' }, 'the beta call must reach beta, not replay alpha');
    assert.equal(alpha.calls.length, 1, 'alpha hit its own network once');
    assert.equal(beta.calls.length, 1, 'beta hit its own network once');

    const third = await settle(apiA('/users'));
    assert.deepEqual(third, { servedBy: 'ALPHA' }, 'alpha still serves its own cached response');
    assert.equal(alpha.calls.length, 1, 'and the repeat is a HIT');

    await delay(20); // both fire-and-forget writes settle
    assert.equal(cache.size(), 2, 'each origin occupies its own entry');
    const keys = cache.keys();
    assert.ok(
      keys.some((key) => key.includes('https://alpha.example.com/users')),
      `alpha stored under its own origin, got ${JSON.stringify(keys)}`,
    );
    assert.ok(
      keys.some((key) => key.includes('https://beta.example.com/users')),
      `beta stored under its own origin, got ${JSON.stringify(keys)}`,
    );
  });

  it('applies a derived .create({ baseURL }) to both the request and the key', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork((url) => ({ body: { url } }));
    const base = blazeOfetch(createFetch({ fetch: net }), cache, { ttlMs: TTL_MS });
    const derived = base.create({ baseURL: 'https://derived.example.com' });

    const out = await settle(derived('/things'));

    assert.equal(calls.length, 1, 'one network call');
    assert.equal(
      calls[0].url,
      'https://derived.example.com/things',
      'the derived baseURL goes on the wire',
    );
    assert.deepEqual(out, { url: 'https://derived.example.com/things' });

    await delay(20);
    const [key] = cache.keys();
    assert.ok(
      key.includes('https://derived.example.com/things'),
      `the key uses the derived baseURL too, got ${key}`,
    );
  });

  it('folds a derived .create({ headers }) identity into the vary key', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork((url, n, headers) => ({
      body: { auth: headers.get('authorization') ?? null },
      headers: { 'content-type': 'application/json', vary: 'authorization' },
    }));
    const base = blazeOfetch(createFetch({ fetch: net }), cache, {
      ttlMs: TTL_MS,
      baseURL: 'https://api.example.com',
    });
    const asAda = base.create({ headers: { authorization: 'Bearer ada' } });
    const asGrace = base.create({ headers: { authorization: 'Bearer grace' } });

    const ada = await settle(asAda('/me'));
    const grace = await settle(asGrace('/me'));

    assert.deepEqual(ada, { auth: 'Bearer ada' }, 'ada sees ada');
    assert.deepEqual(grace, { auth: 'Bearer grace' }, 'grace must never be served ada');
    assert.equal(calls.length, 2, 'the second identity reaches the network');

    await delay(20);
    assert.equal(cache.size(), 2, 'two identities occupy two entries');
  });

  it('keys an opted-in POST by its body: two payloads, two entries', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork((url, callNumber) => ({ body: { served: callNumber } }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, {
      ttlMs: TTL_MS,
      methods: ['GET', 'POST'],
    });

    const first = await settle(api(USERS, { method: 'POST', body: { id: 1 } }));
    const second = await settle(api(USERS, { method: 'POST', body: { id: 2 } }));
    const repeat = await settle(api(USERS, { method: 'POST', body: { id: 1 } }));

    assert.deepEqual(first, { served: 1 }, 'the first payload is served');
    assert.deepEqual(second, { served: 2 }, 'a different payload must never replay the first response');
    assert.equal(calls.length, 2, 'the second payload went to the network');
    assert.deepEqual(repeat, { served: 1 }, 'the same payload still hits');
    assert.equal(calls.length, 2, 'the repeat did not');

    await delay(20);
    assert.equal(cache.size(), 2, 'two payloads occupy two entries');
  });

  it('never stores an opted-in POST whose body cannot be folded into the key', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ body: { ok: true } }));
    const api = blazeOfetch(createFetch({ fetch: net }), cache, {
      ttlMs: TTL_MS,
      methods: ['GET', 'POST'],
    });
    // Raw bytes: `JSON.stringify` renders them as the bare `'{}'`, which would collapse
    // every byte body onto one key — so nothing at all may be stored for them.
    const bytes = new Uint8Array([1, 2, 3, 4]);

    await settle(api(USERS, { method: 'POST', body: bytes }));
    await settle(api(USERS, { method: 'POST', body: bytes }));

    assert.equal(calls.length, 2, 'an unkeyable body always reaches the network');
    await delay(20);
    assert.deepEqual(cache.keys(), [], 'and nothing that cannot be keyed is ever stored');
  });
});
