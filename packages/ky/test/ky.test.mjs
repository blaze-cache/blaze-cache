/**
 * Smoke tests for `@blaze-cache/ky`.
 *
 * They run against the **built** artifacts (`dist/` + the real wasm binary). The network is
 * always a stub, so the suite is deterministic: every assertion about "the network was hit
 * exactly once" is a real assertion about the cache — and each marker-header check is paired
 * with a look *inside* the store, so a green run means the payload really landed there.
 *
 * The whole suite runs **twice**: once on ky v1 and once on ky v2 (installed under the
 * `ky2` alias), whose hook signatures differ completely. `createBlazeKy` runs once more —
 * it is bound to whatever `ky` resolves to in the consumer's app.
 *
 *   pnpm --filter @blaze-cache/ky test
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import kyV1 from 'ky';
import kyV2 from 'ky2';

import { createCache } from '@blaze-cache/core';
import { blazeKyHook, createBlazeKy, defaultCacheKey } from '@blaze-cache/ky';

const wasmBytes = await readFile(
  new URL('../../core/pkg/blaze_cache_wasm_bg.wasm', import.meta.url),
);

/** A cache over the real wasm module (Node has no `fetch` for `file:` URLs). */
const makeCache = (options = {}) => createCache({ wasm: wasmBytes, persistence: false, ...options });

/**
 * A stand-in for the real network, handed to ky as its `fetch` option.
 *
 * ky always calls it with a `Request`. `handler(url, callNumber, headers)` returns the
 * canned spec: `body` is JSON-encoded for you, while `raw` is passed through untouched so
 * a test can serve bytes that JSON could never round-trip.
 */
const stubNetwork = (handler) => {
  const calls = [];
  const net = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    calls.push({ url, method: (input instanceof Request ? input.method : 'GET').toUpperCase() });

    const spec = handler(url, calls.length, headers) ?? {};
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
 *
 * Pairing every marker-header assertion with this keeps the suite honest: a green run means
 * the payload reached the store, not merely that the right branch was taken.
 */
const onlyRecord = (cache) => {
  assert.equal(cache.size(), 1, 'exactly one entry is stored');
  const [key] = cache.keys();
  const record = cache.get(key);
  assert.ok(record, 'and it is readable');
  return { key, record };
};

/** The stored `ArrayBuffer` body, decoded — so assertions can compare the cached payload. */
const storedJson = (record) => JSON.parse(new TextDecoder().decode(record.body));

/** How long the stored entry is *fresh* for, in milliseconds. */
const freshFor = (record) => record.freshUntil - record.storedAt;

/**
 * One awaited request with the courtesy the production adapter does not owe you.
 *
 * Buffering-and-storing a response is deliberately fire-and-forget, so the request resolves
 * while that write may still be pending. A zero-delay timer runs after *every* pending
 * microtask, which is exactly when the background store has settled — without it, a test
 * asserting on the store (or expecting the very next call to be a HIT) would race the write
 * it means to observe.
 */
const settle = async (response) => {
  await delay(0);
  return response;
};

const USERS = 'https://api.example.com/api/users';
const TTL_MS = 30_000;

const versions = [
  { label: 'ky v1', ky: kyV1, prefix: (base) => ({ prefixUrl: base }) },
  { label: 'ky v2', ky: kyV2, prefix: (base) => ({ baseUrl: base }) },
];

for (const { label, ky, prefix } of versions) {
  /** The wiring the README leads with: cache hooks appended after any earlier hooks. */
  const hookApi = (cache, net, blazeOptions = {}, kyOptions = {}) =>
    ky.extend({ fetch: net, ...kyOptions }).extend({ hooks: blazeKyHook(cache, blazeOptions) });

  describe(`caching (${label})`, () => {
    it('caches GET responses and marks HIT/MISS', async () => {
      const cache = await makeCache();
      const { net, calls } = stubNetwork(() => ({ body: { users: [1, 2] } }));
      const api = hookApi(cache, net, { ttlMs: TTL_MS });

      const miss = await settle(api.get(USERS));
      const hit = await settle(api.get(USERS));

      assert.equal(calls.length, 1, 'the network is hit exactly once');
      assert.equal(miss.headers.get('x-blaze-cache'), 'MISS');
      assert.equal(hit.headers.get('x-blaze-cache'), 'HIT');
      assert.equal(hit.status, 200);
      assert.equal(hit.statusText, 'OK');
      assert.equal(hit.headers.get('content-type'), 'application/json');
      assert.equal(hit.url, USERS, 'a hit carries the stored response URL');
      assert.deepEqual(await miss.json(), { users: [1, 2] }, 'the teed body still reads');
      assert.deepEqual(await hit.json(), { users: [1, 2] }, 'the replayed body reads too');

      // …and the store really holds it, under the default key and default tags.
      const { key, record } = onlyRecord(cache);
      assert.ok(key.startsWith(`get ${USERS}`), `stored under method + URL, got ${key}`);
      assert.equal(cache.hasTag(key, 'ky'), true, 'under the default tag');
      assert.equal(cache.hasTag(key, `get ${USERS}`), true, 'under the per-resource tag');
      assert.equal(record.status, 200);
      assert.equal(record.statusText, 'OK');
      assert.equal(record.headers['content-type'], 'application/json');
      assert.equal(record.url, USERS);
      assert.deepEqual(storedJson(record), { users: [1, 2] }, 'the payload is in the cache');
      assert.ok(record.storedAt <= record.freshUntil, 'storedAt ≤ freshUntil');
    });

    it('never caches methods outside `methods`', async () => {
      const cache = await makeCache();
      const { net, calls } = stubNetwork(() => ({ body: { ok: true } }));
      const api = hookApi(cache, net, { ttlMs: TTL_MS });

      const first = await settle(api.post(USERS, { json: { a: 1 } }));
      const second = await settle(api.post(USERS, { json: { a: 1 } }));

      assert.equal(calls.length, 2, 'POST always goes to the network');
      assert.equal(first.headers.get('x-blaze-cache'), 'MISS');
      assert.equal(second.headers.get('x-blaze-cache'), 'MISS');
      assert.deepEqual(cache.keys(), [], 'the store is verifiably empty');
    });

    it('caches HEAD when it is opted in', async () => {
      const cache = await makeCache();
      const { net, calls } = stubNetwork(() => ({ headers: { 'content-length': '12' } }));
      const api = hookApi(cache, net, { ttlMs: TTL_MS, methods: ['GET', 'HEAD'] });

      await settle(api.head(USERS));
      const hit = await settle(api.head(USERS));

      assert.equal(calls.length, 1);
      assert.equal(hit.headers.get('x-blaze-cache'), 'HIT');
      assert.equal(await hit.text(), '', 'a HEAD replay carries no body');

      const { key, record } = onlyRecord(cache);
      assert.ok(key.startsWith(`head ${USERS}`), `stored under the HEAD method, got ${key}`);
      assert.equal(record.headers['content-length'], '12', 'the headers are in the store');
      assert.equal(new TextDecoder().decode(record.body), '', '…and the body was stored empty, as HEAD sent it');
    });

    it('stores responses for ttlMs and refetches once they expire', async () => {
      const cache = await makeCache();
      const { net, calls } = stubNetwork((url) => ({ body: { url } }));
      const api = hookApi(cache, net, { ttlMs: 30 });

      await settle(api.get(USERS));
      await settle(api.get(USERS));
      assert.equal(calls.length, 1, 'served from cache within the window');

      const before = onlyRecord(cache).record;
      assert.deepEqual(storedJson(before), { url: USERS });
      assert.ok(freshFor(before) <= 30, `stored for ttlMs, got ${freshFor(before)}ms`);

      await delay(80);
      await settle(api.get(USERS));
      assert.equal(calls.length, 2, 'expired entries fall through to the network');

      const after = onlyRecord(cache).record;
      assert.ok(after.storedAt > before.storedAt, 'the refetch rewrote the same key');
      assert.deepEqual(storedJson(after), { url: USERS }, 'with a fresh payload inside');
    });

    it('accepts ttlMs as a per-response function', async () => {
      const cache = await makeCache();
      const { net, calls } = stubNetwork((url) => ({ body: { url } }));
      const seen = [];
      const api = hookApi(cache, net, {
        ttlMs: (response, request) => {
          seen.push([response.status, request.url, request.method]);
          return request.url.endsWith('/long-lived') ? 600_000 : 1;
        },
      });

      const longLived = `${USERS}/long-lived`;
      await settle(api.get(longLived));
      await settle(api.get(longLived));
      assert.equal(calls.length, 1, 'the longer window was applied');
      assert.deepEqual(seen, [[200, longLived, 'GET']], 'the callback saw the response and the final request');

      const { record } = onlyRecord(cache);
      assert.ok(freshFor(record) >= 599_000, `the callback's 600s became the entry TTL, got ${freshFor(record)}ms`);
    });

    it('replays a 204 with no body', async () => {
      const cache = await makeCache();
      const { net, calls } = stubNetwork(() => ({ status: 204, statusText: 'No Content' }));
      const api = hookApi(cache, net, { ttlMs: TTL_MS });

      const miss = await settle(api.get(USERS));
      const hit = await settle(api.get(USERS));

      assert.equal(calls.length, 1);
      assert.equal(miss.headers.get('x-blaze-cache'), 'MISS');
      assert.equal(hit.headers.get('x-blaze-cache'), 'HIT');
      assert.equal(hit.status, 204);
      assert.equal(await hit.text(), '', 'a 204 replay carries no body');

      const { record } = onlyRecord(cache);
      assert.equal(record.body.byteLength, 0, 'stored with an empty body, as the network sent it');
    });

    it('replays binary bodies byte-for-byte', async () => {
      const cache = await makeCache();
      const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
      const { net, calls } = stubNetwork(() => ({
        raw: bytes,
        headers: { 'content-type': 'application/octet-stream' },
      }));
      const api = hookApi(cache, net, { ttlMs: TTL_MS });

      const miss = await settle(api.get(USERS));
      const hit = await settle(api.get(USERS));

      assert.equal(calls.length, 1);
      const missBlob = await miss.blob();
      const hitBlob = await hit.blob();
      assert.equal(missBlob.type, 'application/octet-stream');
      assert.equal(hitBlob.type, missBlob.type, 'the hit keeps its content-type');
      assert.equal(hitBlob.size, bytes.byteLength, 'and its size');
      assert.deepEqual(new Uint8Array(await hitBlob.arrayBuffer()), bytes, 'and every byte');
    });
  });

  describe(`Cache-Control (${label})`, () => {
    it('response max-age overrides ttlMs', async () => {
      const cache = await makeCache();
      const { net, calls } = stubNetwork(() => ({
        body: { ok: true },
        headers: { 'cache-control': 'max-age=60' },
      }));
      const api = hookApi(cache, net, { ttlMs: 1 });

      await settle(api.get(USERS));
      const stored = onlyRecord(cache).record;
      assert.ok(freshFor(stored) >= 59_000, `max-age=60 became the entry window, not ttlMs: 1 (got ${freshFor(stored)}ms)`);

      await delay(50); // `ttlMs: 1` would have expired long before this
      const hit = await settle(api.get(USERS));
      assert.equal(hit.headers.get('x-blaze-cache'), 'HIT', 'max-age overrides ttlMs');
      assert.equal(calls.length, 1);
    });

    it('deducts the response Age from the freshness window', async () => {
      const cache = await makeCache();
      const { net } = stubNetwork(() => ({
        body: { ok: true },
        headers: { 'cache-control': 'max-age=60', age: '55' },
      }));
      const api = hookApi(cache, net, { ttlMs: 600_000 });

      await settle(api.get(USERS));
      const stored = onlyRecord(cache).record;
      // `max-age=60, Age: 55` has five seconds of life left — not sixty, and not the
      // adapter's own 600s fallback either.
      assert.ok(freshFor(stored) <= 5_000 && freshFor(stored) >= 4_000, `got ${freshFor(stored)}ms`);
    });

    it('request no-store bypasses the read and the write', async () => {
      const cache = await makeCache();
      const { net, calls } = stubNetwork(() => ({ body: { ok: true } }));
      const api = hookApi(cache, net, { ttlMs: TTL_MS });

      await settle(api.get(USERS, { headers: { 'Cache-Control': 'no-store' } }));
      await settle(api.get(USERS, { headers: { 'Cache-Control': 'no-store' } }));

      assert.equal(calls.length, 2, 'neither call touched the cache');
      assert.deepEqual(cache.keys(), [], 'nothing was stored');
    });

    it('request no-cache skips the read but still stores', async () => {
      const cache = await makeCache();
      const { net, calls } = stubNetwork(() => ({ body: { ok: true } }));
      const api = hookApi(cache, net, { ttlMs: TTL_MS });

      const fresh = await settle(api.get(USERS, { headers: { 'Cache-Control': 'no-cache' } }));
      assert.equal(calls.length, 1);
      assert.equal(fresh.headers.get('x-blaze-cache'), 'MISS');

      const hit = await settle(api.get(USERS));
      assert.equal(calls.length, 1, 'the entry the no-cache call stored is still readable');
      assert.equal(hit.headers.get('x-blaze-cache'), 'HIT');

      const again = await settle(api.get(USERS, { headers: { 'Cache-Control': 'no-cache' } }));
      assert.equal(calls.length, 2, 'a repeat no-cache call goes back to the network');
      assert.equal(again.headers.get('x-blaze-cache'), 'MISS');
    });

    it('never stores a response declaring no-store or no-cache', async () => {
      const cache = await makeCache();
      const { net, calls } = stubNetwork((url) => ({
        body: { url },
        headers: url.includes('store') ? { 'cache-control': 'no-store' } : { 'cache-control': 'no-cache' },
      }));
      const api = hookApi(cache, net, { ttlMs: TTL_MS });

      await settle(api.get(`${USERS}/store`));
      await settle(api.get(`${USERS}/store`));
      await settle(api.get(`${USERS}/cache`));
      await settle(api.get(`${USERS}/cache`));

      assert.equal(calls.length, 4, 'both spellings keep going to the network');
      assert.deepEqual(cache.keys(), [], 'and nothing was stored');
    });

    it('cacheControl: false treats ttlMs as the only authority', async () => {
      const cache = await makeCache();
      const { net } = stubNetwork(() => ({
        body: { ok: true },
        headers: { 'cache-control': 'no-store, max-age=600' },
      }));
      const api = hookApi(cache, net, { ttlMs: 30, cacheControl: false });

      await settle(api.get(USERS));
      const stored = onlyRecord(cache).record;
      assert.ok(freshFor(stored) <= 30, `the server's directives were ignored, got ${freshFor(stored)}ms`);
    });
  });

  describe(`keys and tags (${label})`, () => {
    it('folds Authorization into the default key', async () => {
      const cache = await makeCache();
      const { net, calls } = stubNetwork(() => ({ body: { ok: true } }));
      const api = hookApi(cache, net, { ttlMs: TTL_MS });

      const first = await settle(api.get(USERS, { headers: { authorization: 'Bearer alice' } }));
      const second = await settle(api.get(USERS, { headers: { authorization: 'Bearer bob' } }));

      assert.equal(calls.length, 2, 'a different user never replays another one’s response');
      assert.equal(first.headers.get('x-blaze-cache'), 'MISS');
      assert.equal(second.headers.get('x-blaze-cache'), 'MISS');
      assert.equal(cache.size(), 2, 'two identities, two entries');
      for (const key of cache.keys()) {
        assert.ok(!key.includes('Bearer'), 'tokens are hashed, never stored verbatim');
      }
    });

    it('varyHeaders: [] drops the vary hash', async () => {
      const cache = await makeCache();
      const { net, calls } = stubNetwork(() => ({ body: { ok: true } }));
      const api = hookApi(cache, net, { ttlMs: TTL_MS, varyHeaders: [] });

      await settle(api.get(USERS, { headers: { authorization: 'Bearer alice' } }));
      const hit = await settle(api.get(USERS, { headers: { authorization: 'Bearer bob' } }));

      assert.equal(calls.length, 1, 'one URL, one entry — the caller asked for it');
      assert.equal(hit.headers.get('x-blaze-cache'), 'HIT');
      const { key } = onlyRecord(cache);
      assert.equal(key, `get ${USERS}`, 'the bare "<method> <url>" form');
    });

    it('leaves a response varying outside varyHeaders uncached', async () => {
      const cache = await makeCache();
      const { net, calls } = stubNetwork(() => ({
        body: { ok: true },
        headers: { vary: 'accept-language' },
      }));
      const api = hookApi(cache, net, { ttlMs: TTL_MS });

      await settle(api.get(USERS));
      await settle(api.get(USERS));

      assert.equal(calls.length, 2, 'it cannot be keyed correctly, so it always refetches');
      assert.deepEqual(cache.keys(), [], 'and nothing was stored');
    });

    it('never stores Vary: *', async () => {
      const cache = await makeCache();
      const { net } = stubNetwork(() => ({ body: { ok: true }, headers: { vary: '*' } }));
      const api = hookApi(cache, net, { ttlMs: TTL_MS });

      await settle(api.get(USERS));
      assert.deepEqual(cache.keys(), [], 'RFC 9111 §3: never usable from a cache');
    });

    it('stores a response varying on a keyed header', async () => {
      const cache = await makeCache();
      const { net, calls } = stubNetwork(() => ({
        body: { ok: true },
        headers: { vary: 'authorization' },
      }));
      const api = hookApi(cache, net, { ttlMs: TTL_MS });

      await settle(api.get(USERS, { headers: { authorization: 'Bearer alice' } }));
      const hit = await settle(api.get(USERS, { headers: { authorization: 'Bearer alice' } }));

      assert.equal(calls.length, 1, 'the same identity hits the cache');
      assert.equal(hit.headers.get('x-blaze-cache'), 'HIT');
    });

    it('accepts a custom key callback', async () => {
      const cache = await makeCache();
      const { net } = stubNetwork(() => ({ body: { ok: true } }));
      const api = hookApi(cache, net, {
        ttlMs: TTL_MS,
        // Keep the default (method + URL) and add a version prefix — the README's pattern.
        key: (request) => `v2:${defaultCacheKey(request, [])}`,
      });

      await settle(api.get(USERS));
      const { key } = onlyRecord(cache);
      assert.equal(key, `v2:get ${USERS}`);
    });

    it('invalidateTags drops the default tags', async () => {
      const cache = await makeCache();
      const { net, calls } = stubNetwork(() => ({ body: { ok: true } }));
      const api = hookApi(cache, net, { ttlMs: TTL_MS });
      const other = `${USERS}/other`;

      await settle(api.get(USERS));
      await settle(api.get(other));

      cache.invalidateTags(`get ${other}`);
      assert.equal(cache.size(), 1, 'one resource dropped, the other kept');

      cache.invalidateTags('ky');
      assert.deepEqual(cache.keys(), [], 'everything this adapter stored dropped');

      await settle(api.get(USERS));
      assert.equal(calls.length, 3, 'and the next call is a MISS again');
    });
  });

  describe(`options (${label})`, () => {
    it('shouldCache decides what is stored', async () => {
      const cache = await makeCache();
      const { net, calls } = stubNetwork((url) => ({
        body: { url },
        status: url.endsWith('/keep') ? 200 : 203,
      }));
      const api = hookApi(cache, net, {
        ttlMs: TTL_MS,
        shouldCache: (response) => response.status === 200,
      });

      const kept = await settle(api.get(`${USERS}/keep`));
      const skipped = await settle(api.get(`${USERS}/skip`));
      await settle(api.get(`${USERS}/skip`));

      assert.equal(calls.length, 3, 'the rejected response is refetched every time');
      assert.equal(kept.headers.get('x-blaze-cache'), 'MISS');
      assert.equal(skipped.headers.get('x-blaze-cache'), 'MISS', 'a rejected response is still returned');
      const { record } = onlyRecord(cache);
      assert.ok(record.url.endsWith('/keep'), 'and only the kept one is in the store');
    });

    it('markerHeader: false serves hits without the header, and never re-stores them', async () => {
      const cache = await makeCache();
      const { net, calls } = stubNetwork(() => ({ body: { ok: true } }));
      const api = hookApi(cache, net, { ttlMs: 40, markerHeader: false });

      const miss = await settle(api.get(USERS));
      const first = onlyRecord(cache).record;
      assert.equal(miss.headers.get('x-blaze-cache'), null, 'no marker on a miss');
      assert.equal(cache.size(), 1, 'the payload really landed in the store');

      await delay(10);
      const hit = await settle(api.get(USERS));
      assert.equal(hit.headers.get('x-blaze-cache'), null, 'no marker on a hit');
      assert.equal(calls.length, 1, '…and it still came from the cache');

      // A replayed hit must never be re-stored — that would slide the TTL a little on
      // every read. The adapter tracks its own replays by request identity, *not* by the
      // marker, so this has to hold with the marker switched off.
      const afterHit = onlyRecord(cache).record;
      assert.equal(afterHit.storedAt, first.storedAt, 'the hit left the record untouched');
      assert.equal(afterHit.freshUntil, first.freshUntil, 'the freshness deadline did not move');

      await delay(60);
      const fresh = await settle(api.get(USERS));
      assert.equal(calls.length, 2, 'once the entry expires, the network is back');
      assert.equal(fresh.headers.get('x-blaze-cache'), null, 'marked only by absence — it is a plain response');
      const rewritten = onlyRecord(cache).record;
      assert.ok(rewritten.storedAt > first.storedAt, 'the rewrite came from the fresh network response');
    });

    it('does not slide the TTL of a replayed hit', async () => {
      const cache = await makeCache();
      const { net, calls } = stubNetwork(() => ({ body: { ok: true } }));
      const api = hookApi(cache, net, { ttlMs: TTL_MS });

      await settle(api.get(USERS));
      const before = onlyRecord(cache).record;

      await delay(10);
      await settle(api.get(USERS));
      await settle(api.get(USERS));

      assert.equal(calls.length, 1);
      const after = onlyRecord(cache).record;
      assert.equal(after.storedAt, before.storedAt, 'hits left the record untouched');
      assert.equal(after.freshUntil, before.freshUntil, 'the freshness deadline did not move');
    });
  });

  describe(`hook composition (${label})`, () => {
    it('preserves the caller hooks and runs them around the cache', async () => {
      const cache = await makeCache();
      const { net, calls } = stubNetwork(() => ({ body: { ok: true } }));
      const order = [];
      let token = 'alice';

      // The documented way to combine: user hooks first, cache hooks appended after.
      const api = ky
        .extend({
          fetch: net,
          hooks: {
            beforeRequest: [
              (requestOrState) => {
                const request = requestOrState instanceof Request ? requestOrState : requestOrState.request;
                request.headers.set('authorization', `Bearer ${token}`);
                order.push('user-before');
              },
            ],
            afterResponse: [() => order.push('user-after')],
          },
        })
        .extend({ hooks: blazeKyHook(cache, { ttlMs: TTL_MS }) });

      await settle(api.get(USERS));
      assert.deepEqual(order, ['user-before', 'user-after'], 'both user hooks ran');

      // The user's `beforeRequest` set the header *before* the cache computed its key —
      // a second identity must therefore miss.
      token = 'bob';
      const second = await settle(api.get(USERS));

      assert.equal(calls.length, 2, 'a new token is a new identity');
      assert.equal(second.headers.get('x-blaze-cache'), 'MISS');
      assert.equal(cache.size(), 2, 'the auth header the user hook added was folded into the key');
    });
  });
}

/** `createBlazeKy` is bound to whatever `ky` resolves to — tested once, on the default (v1). */
describe('createBlazeKy', () => {
  it('passes ky options through and caches (with prefixUrl)', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ body: { users: [1] } }));
    const api = createBlazeKy(cache, {
      prefixUrl: 'https://api.example.com',
      fetch: net,
      ttlMs: TTL_MS,
    });

    const miss = await settle(api.get('api/users'));
    const users = await api.get('api/users').json();

    assert.equal(calls.length, 1);
    assert.equal(miss.headers.get('x-blaze-cache'), 'MISS');
    assert.deepEqual(users, { users: [1] }, 'the body method shortcut reads a hit');

    const { key } = onlyRecord(cache);
    assert.ok(key.startsWith(`get ${USERS}`), `keyed on the final, prefixed URL — got ${key}`);
  });

  it('preserves the hooks it is given', async () => {
    const cache = await makeCache();
    const { net } = stubNetwork(() => ({ body: { ok: true } }));
    const seen = [];
    const api = createBlazeKy(cache, {
      fetch: net,
      ttlMs: TTL_MS,
      hooks: { afterResponse: [() => seen.push('user')] },
    });

    await settle(api.get(USERS));
    assert.deepEqual(seen, ['user'], 'the user afterResponse still runs');
  });

  it('a cached error rejects exactly like a network one', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ status: 404, statusText: 'Not Found', body: { error: 'nope' } }));
    const api = createBlazeKy(cache, {
      fetch: net,
      ttlMs: TTL_MS,
      // Widen the net deliberately: even a stored 404 must throw `HTTPError` on replay.
      shouldCache: () => true,
    });

    const isHttp404 = (error) => error.name === 'HTTPError' && error.response?.status === 404;
    await assert.rejects(() => api.get(USERS), isHttp404, 'the network 404 throws');
    await assert.rejects(() => api.get(USERS), isHttp404, 'the cached 404 throws the same way');
    assert.equal(calls.length, 1, '…and it was served from the store');
  });
});

describe('resilience', () => {
  /** Runs `body` with `console.warn` captured, so warn-once contracts can be asserted. */
  const withWarnings = async (body) => {
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
      await body();
    } finally {
      console.warn = original;
    }
    return warnings;
  };

  for (const { label, ky } of versions) {
    it(`a throwing cache.get costs one extra request, never a failed response (${label})`, async () => {
      const cache = await makeCache();
      const { net, calls } = stubNetwork(() => ({ body: { ok: true } }));
      const broken = { get() { throw new Error('cache is down'); }, set: (...args) => cache.set(...args) };
      const api = ky.extend({ fetch: net }).extend({ hooks: blazeKyHook(broken, { ttlMs: TTL_MS }) });

      const warnings = await withWarnings(async () => {
        const first = await settle(api.get(USERS));
        const second = await settle(api.get(USERS));
        assert.equal(first.status, 200, 'the first response is fine');
        assert.equal(second.status, 200, 'so is the second');
        assert.equal(calls.length, 2, 'each call fell through to the network');
      });

      assert.equal(warnings.length, 1, 'the failure was announced exactly once');
    });

    it(`a throwing shouldCache is treated as "do not store" (${label})`, async () => {
      const cache = await makeCache();
      const { net } = stubNetwork(() => ({ body: { ok: true } }));
      const api = ky.extend({ fetch: net }).extend({
        hooks: blazeKyHook(cache, {
          ttlMs: TTL_MS,
          shouldCache: () => {
            throw new Error('callback is broken');
          },
        }),
      });

      const warnings = await withWarnings(async () => {
        const response = await settle(api.get(USERS));
        assert.equal(response.status, 200, 'the response the network delivered is returned');
        assert.equal(response.headers.get('x-blaze-cache'), 'MISS', 'marked, just not stored');
      });

      assert.deepEqual(cache.keys(), [], 'nothing was stored');
      assert.equal(warnings.length, 1, 'the failure was announced exactly once');
    });

    it(`a foreign record under the key is neither served nor fatal (${label})`, async () => {
      const cache = await makeCache();
      const { net, calls } = stubNetwork(() => ({ body: { ok: true } }));
      // Something else shares this cache and wrote a value this adapter cannot replay —
      // under the exact key this request will compute, so the read really meets it.
      const foreignKey = defaultCacheKey(new Request(USERS), ['authorization']);
      cache.set(foreignKey, { data: 'not a blaze-ky record' });
      const api = ky.extend({ fetch: net }).extend({ hooks: blazeKyHook(cache, { ttlMs: TTL_MS }) });

      const response = await settle(api.get(USERS));

      assert.equal(response.status, 200, 'the request still succeeds');
      assert.equal(calls.length, 1, 'falling through to the network');
      assert.equal(response.headers.get('x-blaze-cache'), 'MISS');
    });
  }
});
