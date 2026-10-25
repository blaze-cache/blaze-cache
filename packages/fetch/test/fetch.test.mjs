/**
 * Smoke tests for `@blaze-cache/fetch`.
 *
 * They run against the **built** artifacts (`dist/` + the real wasm binary). The network is
 * always a stub, so the suite is deterministic: every assertion about "the network was hit
 * exactly once" is a real assertion about the cache — and each marker-header check is paired
 * with a look *inside* the store, so a green run means the payload really landed there.
 *
 *   pnpm --filter @blaze-cache/fetch test
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createCache } from '@blaze-cache/core';
import {
  createBlazeFetch,
  defaultCacheKey,
  fnv1a,
  parseAgeMs,
  parseCacheControl,
} from '@blaze-cache/fetch';

const wasmBytes = await readFile(
  new URL('../../core/pkg/blaze_cache_wasm_bg.wasm', import.meta.url),
);

/** A cache over the real wasm module (Node has no `fetch` for `file:` URLs). */
const makeCache = (options = {}) => createCache({ wasm: wasmBytes, persistence: false, ...options });

/**
 * A stand-in for the global `fetch`, keyed by URL.
 *
 * `handler(url, callNumber, headers)` returns the canned spec: `body` is JSON-encoded for
 * you, while `raw` is passed through untouched so a test can serve bytes or a stream that
 * JSON could never round-trip.
 */
const stubNetwork = (handler) => {
  const calls = [];
  const net = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = new Headers(init?.headers);
    calls.push({ url, method });

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

describe('caching', () => {
  it('caches GET responses and marks HIT/MISS', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ body: { users: [1, 2] } }));
    const fetch = createBlazeFetch(cache, { fetch: net });

    const miss = await fetch('/api/users');
    const hit = await fetch('/api/users');

    assert.equal(calls.length, 1, 'the network is hit exactly once');
    assert.equal(miss.headers.get('x-blaze-cache'), 'MISS');
    assert.equal(hit.headers.get('x-blaze-cache'), 'HIT');
    assert.equal(hit.status, 200);
    assert.equal(hit.statusText, 'OK');
    assert.equal(hit.headers.get('content-type'), 'application/json');
    assert.equal(hit.url, '/api/users', 'a hit carries the stored response URL');
    assert.deepEqual(await miss.json(), { users: [1, 2] }, 'the teed body still reads');
    assert.deepEqual(await hit.json(), { users: [1, 2] }, 'the replayed body reads too');

    // …and the store really holds it, under the default key.
    const { key, record } = onlyRecord(cache);
    assert.ok(key.startsWith('get /api/users'), `stored under method + URL, got ${key}`);
    assert.equal(cache.hasTag(key, 'fetch'), true, 'under the default tag');
    assert.equal(record.status, 200);
    assert.equal(record.statusText, 'OK');
    assert.equal(record.headers['content-type'], 'application/json');
    assert.equal(record.url, '/api/users');
    assert.deepEqual(storedJson(record), { users: [1, 2] }, 'the payload is in the cache');
    assert.ok(
      record.storedAt <= record.freshUntil && record.freshUntil <= record.staleUntil,
      'storedAt ≤ freshUntil ≤ staleUntil',
    );
  });

  it('never caches methods outside `methods`', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ body: { ok: true } }));
    const fetch = createBlazeFetch(cache, { fetch: net });

    const first = await fetch('/api/notes', { method: 'POST', body: '{}' });
    const second = await fetch('/api/notes', { method: 'POST', body: '{}' });

    assert.equal(calls.length, 2, 'POST always goes to the network');
    assert.equal(first.headers.get('x-blaze-cache'), 'MISS');
    assert.equal(second.headers.get('x-blaze-cache'), 'MISS');
    assert.equal(cache.size(), 0, 'nothing was stored');
    assert.deepEqual(cache.keys(), [], 'the store is verifiably empty');
  });

  it('caches HEAD when it is opted in', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({ headers: { 'content-length': '12' } }));
    const fetch = createBlazeFetch(cache, { fetch: net, methods: ['GET', 'HEAD'] });

    await fetch('/api/users', { method: 'HEAD' });
    const hit = await fetch('/api/users', { method: 'HEAD' });

    assert.equal(calls.length, 1);
    assert.equal(hit.headers.get('x-blaze-cache'), 'HIT');
    assert.equal(await hit.text(), '', 'a HEAD replay carries no body');

    const { key, record } = onlyRecord(cache);
    assert.ok(key.startsWith('head /api/users'), `stored under the HEAD method, got ${key}`);
    assert.equal(record.status, 200);
    assert.equal(record.headers['content-length'], '12', 'the headers are in the store');
    assert.equal(
      new TextDecoder().decode(record.body),
      '',
      '…and the body was stored empty, as HEAD sent it',
    );
  });

  it('stores responses for ttlMs and refetches once they expire', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork((url) => ({ body: { url } }));
    const fetch = createBlazeFetch(cache, { fetch: net, ttlMs: 30 });

    await fetch('/ttl');
    await fetch('/ttl');
    assert.equal(calls.length, 1, 'served from cache within the window');

    const before = onlyRecord(cache).record;
    assert.deepEqual(storedJson(before), { url: '/ttl' });
    assert.ok(freshFor(before) <= 30, `stored for ttlMs, got ${freshFor(before)}ms`);

    await delay(80);
    await fetch('/ttl');
    assert.equal(calls.length, 2, 'expired entries fall through to the network');

    const after = onlyRecord(cache).record;
    assert.ok(after.storedAt > before.storedAt, 'the refetch rewrote the same key');
    assert.deepEqual(storedJson(after), { url: '/ttl' }, 'with a fresh payload inside');
  });

  it('accepts ttlMs as a per-response function', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork((url) => ({ body: { url } }));
    const seen = [];
    const fetch = createBlazeFetch(cache, {
      fetch: net,
      ttlMs: (response, url, init) => {
        seen.push([response.status, url, init.method]);
        return url === '/long-lived' ? 600_000 : 1;
      },
    });

    await fetch('/long-lived');
    await fetch('/long-lived');
    assert.equal(calls.length, 1, 'the longer window was applied');
    assert.deepEqual(seen, [[200, '/long-lived', 'GET']]);

    const { record } = onlyRecord(cache);
    assert.ok(
      freshFor(record) >= 599_000,
      `the callback’s 600s became the entry TTL, got ${freshFor(record)}ms`,
    );
  });
});

describe('Cache-Control', () => {
  it('honours it on both sides', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork((url) => ({
      body: { url },
      headers: url.startsWith('/long') ? { 'cache-control': 'max-age=60' } : undefined,
    }));
    const fetch = createBlazeFetch(cache, { fetch: net, ttlMs: 1 });

    await fetch('/long');
    const stored = onlyRecord(cache).record;
    assert.deepEqual(storedJson(stored), { url: '/long' }, 'the response is in the cache');
    assert.ok(
      freshFor(stored) >= 59_000,
      `max-age=60 became the entry window, not ttlMs: 1 (got ${freshFor(stored)}ms)`,
    );

    await delay(50); // `ttlMs: 1` would have expired long before this
    const hit = await fetch('/long');
    assert.equal(hit.headers.get('x-blaze-cache'), 'HIT', 'max-age overrides ttlMs');
    assert.equal(calls.length, 1);

    // `no-store` on the request: neither read nor write.
    await fetch('/long', { cache: 'no-store' });
    assert.equal(calls.length, 2, 'a no-store request skips the read');
    const after = await fetch('/long');
    assert.equal(after.headers.get('x-blaze-cache'), 'HIT', 'and it did not overwrite the entry');
    assert.equal(calls.length, 2);

    // `no-store` on the response: never stored.
    const { net: strictNet, calls: strictCalls } = stubNetwork((url) => ({
      body: { url },
      headers: { 'cache-control': 'no-store' },
    }));
    const strict = createBlazeFetch(cache, { fetch: strictNet });
    await strict('/private');
    await strict('/private');
    assert.equal(strictCalls.length, 2, 'no-store responses are never cached');
    assert.equal(cache.size(), 1, '…and the store still holds only the /long entry');
    assert.equal(cache.keys()[0].includes('/private'), false, 'with nothing private inside it');
  });

  it('deducts the response Age from its freshness', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({
      body: { n: 1 },
      // `max-age=1` minus `Age: 0.5` leaves half a second of life, not a full one.
      headers: { 'cache-control': 'max-age=1', age: '0.5' },
    }));
    const fetch = createBlazeFetch(cache, { fetch: net });

    await fetch('/aged');
    assert.equal(calls.length, 1, 'fresh on arrival');

    const { record } = onlyRecord(cache);
    assert.deepEqual(storedJson(record), { n: 1 });
    assert.ok(
      freshFor(record) < 1000,
      `the Age was deducted from max-age (stored ${freshFor(record)}ms, not 1000ms)`,
    );
    assert.ok(freshFor(record) >= 400, '…and roughly half a second remains');

    await delay(750);
    await fetch('/aged');
    assert.equal(calls.length, 2, 'the age had been deducted, so it expired early');
  });

  it('can be switched off entirely', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({
      body: { n: 1 },
      headers: { 'cache-control': 'max-age=600, no-store' },
    }));
    const fetch = createBlazeFetch(cache, { fetch: net, ttlMs: 30, cacheControl: false });

    await fetch('/ignored');
    await fetch('/ignored');
    assert.equal(calls.length, 1, 'the header is ignored: ttlMs decides');

    const { record } = onlyRecord(cache);
    assert.deepEqual(storedJson(record), { n: 1 });
    assert.ok(
      freshFor(record) <= 30,
      `stored for ttlMs, not max-age=600 (got ${freshFor(record)}ms)`,
    );
    assert.equal(cache.size(), 1, '…and even `no-store` in the header was ignored');

    await delay(80);
    await fetch('/ignored');
    assert.equal(calls.length, 2, 'and it expires with ttlMs, not max-age');
  });

  it('parses the directives and Age it acts on', () => {
    assert.deepEqual(parseCacheControl('max-age=30, stale-while-revalidate=120, public'), {
      noStore: false,
      noCache: false,
      maxAgeMs: 30_000,
      staleWhileRevalidateMs: 120_000,
    });
    assert.equal(parseCacheControl('NO-STORE').noStore, true);
    assert.equal(parseCacheControl('no-cache').noCache, true);
    assert.equal(parseCacheControl(undefined).maxAgeMs, undefined);
    assert.equal(parseCacheControl('max-age=abc').maxAgeMs, undefined, 'junk is ignored');

    assert.equal(parseAgeMs('42'), 42_000);
    assert.equal(parseAgeMs(' -1 '), 0, 'negative ages are meaningless');
    assert.equal(parseAgeMs('later'), 0, '…and so are unparsable ones');
    assert.equal(parseAgeMs(undefined), 0);
  });
});

describe('stale-while-revalidate', () => {
  it('serves stale entries and revalidates in the background', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork((url, index) => ({ body: { version: index } }));
    const fetch = createBlazeFetch(cache, { fetch: net, ttlMs: 150, staleWhileRevalidate: 500 });

    const first = await fetch('/swr');
    assert.deepEqual(await first.json(), { version: 1 });
    assert.ok(onlyRecord(cache).record.freshUntil > Date.now(), 'the first body is stored fresh');

    await delay(250); // fresh window (150ms) elapsed, stale window still open
    const stale = await fetch('/swr');
    assert.equal(stale.headers.get('x-blaze-cache'), 'STALE');
    assert.deepEqual(await stale.json(), { version: 1 }, 'the stale body is served at once');
    assert.equal(calls.length, 2, 'the refresh started in the background');

    await delay(50); // …and landed
    const fresh = await fetch('/swr');
    assert.equal(fresh.headers.get('x-blaze-cache'), 'HIT');
    assert.equal(calls.length, 2, 'exactly one refresh per key');
    assert.deepEqual(await fresh.json(), { version: 2 }, 'the entry was rewritten');

    const { key, record } = onlyRecord(cache);
    assert.deepEqual(storedJson(record), { version: 2 }, 'the store holds the refreshed body');
    assert.ok(record.freshUntil > Date.now(), 'with a fresh window open again');
    assert.ok(record.staleUntil > record.freshUntil, 'and a new stale window reserved');
    assert.equal(cache.hasTag(key, 'fetch'), true, 'still under the default tag');
  });

  it('takes the window from the response header when it has one', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork((url, index) => ({
      body: { version: index },
      // 200ms of freshness, 10s of stale-but-servable — all of it from the directive.
      headers: { 'cache-control': 'max-age=0.2, stale-while-revalidate=10' },
    }));
    const fetch = createBlazeFetch(cache, { fetch: net, staleWhileRevalidate: true });

    await fetch('/directed');
    const initial = onlyRecord(cache).record;
    assert.ok(freshFor(initial) >= 190 && freshFor(initial) <= 220, 'fresh for max-age');
    assert.ok(
      initial.staleUntil - initial.freshUntil >= 9_000,
      '…then stale for the directive’s 10s',
    );

    await delay(300); // past max-age, well inside the 10s directive
    const stale = await fetch('/directed');
    assert.equal(stale.headers.get('x-blaze-cache'), 'STALE', 'the directive opened the window');

    await delay(100); // …refreshed, and still inside its own fresh window
    assert.equal(calls.length, 2, 'one background refresh');
    assert.equal((await fetch('/directed')).headers.get('x-blaze-cache'), 'HIT');
    assert.deepEqual(
      storedJson(onlyRecord(cache).record),
      { version: 2 },
      'the refreshed payload replaced the stale one',
    );
  });

  it('is off by default: a stale entry just goes to the network', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork((url, index) => ({ body: { version: index } }));
    const fetch = createBlazeFetch(cache, { fetch: net, ttlMs: 20 });

    await fetch('/plain-stale');
    const initial = onlyRecord(cache).record;
    assert.equal(
      initial.staleUntil,
      initial.freshUntil,
      'no stale window is reserved when SWR is off',
    );

    await delay(60);
    const fresh = await fetch('/plain-stale');

    assert.equal(fresh.headers.get('x-blaze-cache'), 'MISS');
    assert.equal(calls.length, 2, 'no background work was started');
    assert.deepEqual(await fresh.json(), { version: 2 });
    assert.ok(onlyRecord(cache).record.storedAt > initial.storedAt, 'the entry was replaced');
  });
});

describe('force refresh', () => {
  it('bypasses the cache and rewrites it', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork((url, index) => ({ body: { version: index } }));
    const fetch = createBlazeFetch(cache, { fetch: net });

    await fetch('/refresh');
    await fetch('/refresh');
    assert.equal(calls.length, 1);
    assert.deepEqual(storedJson(onlyRecord(cache).record), { version: 1 }, 'stored on the miss');

    const forced = await fetch('/refresh', { forceRefresh: true });
    assert.equal(forced.headers.get('x-blaze-cache'), 'MISS');
    assert.equal(calls.length, 2);
    assert.deepEqual(await forced.json(), { version: 2 });
    assert.deepEqual(
      storedJson(onlyRecord(cache).record),
      { version: 2 },
      'the forced response replaced what was stored',
    );

    const standard = await fetch('/refresh', { cache: 'no-cache' }); // platform spelling
    assert.equal(standard.headers.get('x-blaze-cache'), 'MISS');
    assert.equal(calls.length, 3);

    const after = await fetch('/refresh');
    assert.equal(after.headers.get('x-blaze-cache'), 'HIT', 'the fresh entry is cached again');
    assert.deepEqual(await after.json(), { version: 3 });
    assert.deepEqual(storedJson(onlyRecord(cache).record), { version: 3 }, 'and that is stored');
  });
});

describe('keys', () => {
  it('uses a custom cache key when given one', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork((url) => ({ body: { url } }));
    let seen;
    const fetch = createBlazeFetch(cache, {
      fetch: net,
      key: (url, init) => {
        seen = init;
        return `custom:${init.method}:${url}`;
      },
    });

    await fetch('/api/users?page=1', { headers: { accept: 'application/json' } });
    await fetch('/api/users?page=1', { headers: { accept: 'application/json' } });

    assert.equal(calls.length, 1, 'the custom key de-duplicates');
    assert.equal(cache.has('custom:GET:/api/users?page=1'), true, 'used verbatim');
    assert.equal(cache.size(), 1);
    assert.deepEqual(
      storedJson(cache.get('custom:GET:/api/users?page=1')),
      { url: '/api/users?page=1' },
      'the payload sits under the custom key',
    );
    assert.equal(seen.method, 'GET', 'the callback gets the resolved method');
    assert.ok(seen.headers instanceof Headers, 'the callback gets concrete headers');
    assert.equal(seen.headers.get('accept'), 'application/json');
  });

  it('defaults to method + URL + a vary hash', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork((url, index, headers) => ({
      body: { token: headers.get('authorization') },
    }));
    const fetch = createBlazeFetch(cache, { fetch: net });

    await fetch('/me', { headers: { authorization: 'Bearer ada' } });
    await fetch('/me', { headers: { authorization: 'Bearer grace' } });
    assert.equal(calls.length, 2, 'a different token must miss');

    const replayed = await fetch('/me', { headers: { authorization: 'Bearer ada' } });
    assert.equal(calls.length, 2, 'the same token hits again');
    assert.equal(replayed.headers.get('x-blaze-cache'), 'HIT');
    assert.deepEqual(
      await replayed.json(),
      { token: 'Bearer ada' },
      'a replay belongs to the identity that fetched it',
    );
    assert.equal(cache.size(), 2, 'two identities occupy two keys');

    const keys = cache.keys();
    assert.ok(keys.every((key) => key.startsWith('get /me?')), 'both under method + URL + hash');
    const storedTokens = cache
      .entries()
      .map((entry) => storedJson(entry.value).token)
      .sort();
    assert.deepEqual(
      storedTokens,
      ['Bearer ada', 'Bearer grace'],
      'each identity’s payload is stored under its own key',
    );
    assert.ok(
      !keys.some((key) => key.includes('ada') || key.includes('grace')),
      'and neither token is readable in a key',
    );
  });

  it('builds bare keys when nothing is varied on', () => {
    const init = { method: 'GET', headers: new Headers() };
    assert.equal(defaultCacheKey('/plain', init, []), 'get /plain');
    assert.equal(defaultCacheKey('/plain', init, ['authorization']), 'get /plain?ztntfp');

    const withAuth = {
      method: 'POST',
      headers: new Headers({ authorization: 'Bearer ada' }),
    };
    const varied = defaultCacheKey('/plain', withAuth, ['authorization']);
    assert.ok(!varied.includes('ada'), 'vary values are hashed, never stored verbatim');
    assert.notEqual(
      varied,
      defaultCacheKey('/plain', { ...withAuth, headers: new Headers() }, ['authorization']),
    );
  });
});

describe('storage decisions', () => {
  it('stores only successful responses unless shouldCache says otherwise', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({
      status: 500,
      statusText: 'Internal Server Error',
      body: { error: 'boom' },
    }));
    const fetch = createBlazeFetch(cache, { fetch: net });

    const failing = await fetch('/boom');
    await fetch('/boom');
    assert.equal(calls.length, 2, 'a 500 is not cached by default');
    assert.equal(failing.headers.get('x-blaze-cache'), 'MISS');
    assert.equal(cache.size(), 0, 'nothing was stored');
    assert.deepEqual(cache.keys(), [], 'the store is verifiably empty');

    const seen = [];
    const lenient = createBlazeFetch(cache, {
      fetch: net,
      shouldCache: (response, url, init) => {
        seen.push([response.status, url, init.method]);
        return true;
      },
    });
    await lenient('/boom');
    const replayed = await lenient('/boom');

    assert.equal(calls.length, 3, 'one network call, then a hit');
    assert.equal(replayed.headers.get('x-blaze-cache'), 'HIT');
    assert.equal(replayed.status, 500, 'the status is replayed, not hidden');
    assert.deepEqual(seen, [[500, '/boom', 'GET']], 'shouldCache only runs on a miss');

    const { record } = onlyRecord(cache);
    assert.equal(record.status, 500, 'the failure itself is what got stored');
    assert.equal(record.statusText, 'Internal Server Error');
    assert.deepEqual(storedJson(record), { error: 'boom' }, 'with its body inside');
  });

  it('tags entries so they can be invalidated in bulk', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork((url) => ({ body: { url } }));
    const fetch = createBlazeFetch(cache, { fetch: net });

    await fetch('/tags-a');
    await fetch('/tags-b');
    await fetch('/tags-a');
    assert.equal(calls.length, 2, 'the third call hit');
    assert.equal(cache.size(), 2, 'both responses are in the cache');
    assert.equal(cache.keysWithTag('fetch').length, 2, 'and both carry the default tag');

    const removed = cache.invalidateTags('fetch');
    assert.equal(removed.length, 2, "the default 'fetch' tag drops everything it stored");
    assert.equal(cache.size(), 0);
    assert.deepEqual(cache.keys(), [], 'nothing is left behind');

    assert.equal((await fetch('/tags-a')).headers.get('x-blaze-cache'), 'MISS');
    assert.equal(calls.length, 3);
    assert.equal(cache.size(), 1, 'and the refetched one is stored again');
  });

  it('accepts a custom tag function', async () => {
    const cache = await makeCache();
    const { net } = stubNetwork(() => ({ body: {} }));
    const fetch = createBlazeFetch(cache, {
      fetch: net,
      tags: (response, url, init) => [`http-${init.method}`, url],
    });

    await fetch('/tagged');

    assert.deepEqual(cache.keysWithTag('http-GET'), ['get /tagged?ztntfp'], 'the custom tag landed');
    assert.equal(cache.keysWithTag('/tagged').length, 1, 'and so did the URL tag');
    assert.equal(cache.keysWithTag('fetch').length, 0, 'the default tag was replaced');
    assert.equal(cache.size(), 1, 'the response itself is stored as usual');
  });
});

describe('binary, encoded and chunked bodies', () => {
  it('replays a binary payload byte-for-byte', async () => {
    const cache = await makeCache();
    // A PNG signature followed by bytes JSON cannot round-trip: NUL, 0xff, a lone surrogate-ish 0x80.
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f, 0x80, 0x01,
    ]);
    const { net, calls } = stubNetwork(() => ({
      raw: png,
      headers: { 'content-type': 'image/png', 'content-length': String(png.byteLength) },
    }));
    const fetch = createBlazeFetch(cache, { fetch: net });

    const miss = await fetch('/logo.png');
    assert.equal(miss.headers.get('content-type'), 'image/png');
    assert.deepEqual([...new Uint8Array(await miss.arrayBuffer())], [...png], 'as delivered');

    const hit = await fetch('/logo.png');
    assert.equal(hit.headers.get('x-blaze-cache'), 'HIT');
    assert.equal(calls.length, 1);

    // A body can only be read once, so take the two views from two (equally cached) hits.
    const bytes = await hit.arrayBuffer();
    assert.deepEqual([...new Uint8Array(bytes)], [...png], 'byte-for-byte, never re-encoded');

    const blobHit = await fetch('/logo.png');
    assert.equal(blobHit.headers.get('x-blaze-cache'), 'HIT', 'still a hit, still no network');
    assert.equal(calls.length, 1);
    const blob = await blobHit.blob();
    assert.equal(blob.type, 'image/png', 'blob() keeps the MIME type');
    assert.equal(blob.size, png.byteLength, '…and the exact size');
    assert.equal(hit.headers.get('content-length'), String(png.byteLength), 'so does content-length');

    const { record } = onlyRecord(cache);
    assert.equal(record.body.byteLength, png.byteLength, 'the raw bytes are what got stored');
  });

  it('drops a content-encoding that no longer describes the stored bytes', async () => {
    const cache = await makeCache();
    // Exactly what a real API hands `fetch`: a decoded body wearing the *wire* headers.
    const plain = new TextEncoder().encode(JSON.stringify({ ok: true })).length;
    const { net, calls } = stubNetwork(() => ({
      raw: JSON.stringify({ ok: true }),
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': '1425', // the compressed size — not what we hold
      },
    }));
    const fetch = createBlazeFetch(cache, { fetch: net });

    await fetch('/gzipped');
    const hit = await fetch('/gzipped');
    assert.equal(calls.length, 1);
    assert.equal(hit.headers.get('x-blaze-cache'), 'HIT');

    assert.equal(hit.headers.get('content-encoding'), null, 'no longer gzipped bytes');
    assert.equal(
      hit.headers.get('content-length'),
      String(plain),
      `content-length now matches the stored body (${plain}B, not 1425)`,
    );
    assert.deepEqual(await hit.json(), { ok: true }, 'and the payload still parses');

    const { record } = onlyRecord(cache);
    assert.equal(record.headers['content-encoding'], undefined, 'the record never held it');
    assert.equal(record.headers['content-length'], String(plain));
  });

  it('buffers a chunked stream and replays it whole', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork(() => ({
      raw: new ReadableStream({
        start(controller) {
          for (const chunk of ['chunk-', 'one-', 'two']) {
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          controller.close();
        },
      }),
      headers: { 'content-type': 'text/plain; charset=utf-8', 'transfer-encoding': 'chunked' },
    }));
    const fetch = createBlazeFetch(cache, { fetch: net });

    const miss = await fetch('/stream');
    assert.equal(await miss.text(), 'chunk-one-two', 'the streamed body arrives complete');

    const hit = await fetch('/stream');
    assert.equal(calls.length, 1, 'the stream was buffered before the response was returned');
    assert.equal(hit.headers.get('x-blaze-cache'), 'HIT');
    assert.equal(await hit.text(), 'chunk-one-two', 'replayed as one assembled body');
    assert.equal(
      hit.headers.get('transfer-encoding'),
      null,
      'hop-by-hop headers are not carried into the cache',
    );

    const { record } = onlyRecord(cache);
    assert.equal(new TextDecoder().decode(record.body), 'chunk-one-two', 'all three chunks stored');
  });
});

describe('marker header', () => {
  it('supports a custom name and disabling it', async () => {
    const cache = await makeCache();
    const { net, calls } = stubNetwork((url) => ({ body: { url } }));

    const custom = createBlazeFetch(cache, { fetch: net, markerHeader: 'x-my-cache' });
    assert.equal((await custom('/a')).headers.get('x-my-cache'), 'MISS');
    assert.equal((await custom('/a')).headers.get('x-my-cache'), 'HIT');
    assert.equal((await custom('/a')).headers.get('x-blaze-cache'), null, 'the default is off');
    assert.equal(cache.size(), 1, 'renaming the marker changes nothing about storage');
    assert.deepEqual(storedJson(onlyRecord(cache).record), { url: '/a' });

    const quiet = createBlazeFetch(cache, { fetch: net, markerHeader: false, varyHeaders: [] });
    assert.equal((await quiet('/plain')).headers.get('x-my-cache'), null);
    assert.equal(cache.has('get /plain'), true, 'without vary headers the key is bare');
    assert.deepEqual(storedJson(cache.get('get /plain')), { url: '/plain' }, 'and it is stored');
    assert.equal(cache.size(), 2, 'two URLs, two entries');
    assert.equal(calls.length, 2, '…and /plain went to the network once');
  });

  it('stamps the marker even when the network response refuses to be written to', async () => {
    // A real (undici) network response has an *immutable* header guard — constructed ones
    // do not, which is how this path once shipped without its marker. `Response.redirect`
    // reproduces it deterministically, offline.
    const cache = await makeCache();
    let calls = 0;
    const net = async () => {
      calls += 1;
      return Response.redirect('https://example.com/moved', 302);
    };
    const fetch = createBlazeFetch(cache, { fetch: net });

    const first = await fetch('/moved');
    assert.equal(first.status, 302, 'the response passes through untouched');
    assert.equal(first.headers.get('x-blaze-cache'), 'MISS', 'the marker survived the rebuild');
    assert.equal(calls, 1);
    assert.equal(cache.size(), 0, 'a 302 is not a cacheable status, so nothing was stored');

    const second = await fetch('/moved');
    assert.equal(second.headers.get('x-blaze-cache'), 'MISS');
    assert.equal(calls, 2, 'a non-cacheable status never becomes a HIT');
    assert.equal(cache.size(), 0);
  });

  it('exports every documented helper', async () => {
    assert.equal(typeof createBlazeFetch, 'function');
    assert.equal(typeof parseAgeMs, 'function');
    assert.equal(typeof parseCacheControl, 'function');
    assert.equal(typeof defaultCacheKey, 'function');
    assert.equal(typeof fnv1a, 'function');
  });
});

describe('hashing helper', () => {
  it('produces stable, distinct tokens', () => {
    assert.equal(fnv1a(''), 'ztntfp');
    assert.equal(fnv1a('a'), '1r9wi7g');
    assert.equal(fnv1a('a'), fnv1a('a'));
    assert.notEqual(fnv1a('a'), fnv1a('b'));
  });
});
