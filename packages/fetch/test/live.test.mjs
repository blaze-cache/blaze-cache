/**
 * **Live** tests for `@blaze-cache/fetch`, against a real public API.
 *
 * Everything else in this package runs against a stubbed network, which is why it can assert
 * exact call counts — but a stub can never prove that *real* response headers are read
 * correctly, or that a real body survives a buffer-and-replay round-trip. This file does.
 *
 * It is deliberately separate from `fetch.test.mjs` and **skipped unless opted in**, so the
 * default suite stays deterministic and works offline:
 *
 *   pnpm --filter @blaze-cache/fetch test:live     # sets BLAZE_CACHE_LIVE=1 for you
 *   BLAZE_CACHE_LIVE=1 node --test test/live.test.mjs
 *
 * Endpoints:
 *   - `GET /repos/blaze-cache/blaze-cache` → 200 with `cache-control: public, max-age=60`,
 *     so the header-honouring path is exercised against a real server.
 *   - `GET /rate_limit` → 200 with `cache-control: no-cache`, so the *rejection* path is too.
 *
 * Both are keyless. Unauthenticated GitHub allows 60 requests/hour and this file uses well
 * under ten per run.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createCache } from '@blaze-cache/core';
import { createBlazeFetch, parseAgeMs, parseCacheControl } from '@blaze-cache/fetch';

const LIVE = process.env.BLAZE_CACHE_LIVE === '1';
const SKIP = LIVE
  ? false
  : 'live network tests are opt-in: run `pnpm --filter @blaze-cache/fetch test:live`';

/** A real GitHub repository — 200 with `cache-control: public, max-age=60`. */
const REPO = 'https://api.github.com/repos/blaze-cache/blaze-cache';
/** Also real, but answered with `cache-control: no-cache`. */
const NO_CACHE = 'https://api.github.com/rate_limit';

const wasmBytes = await readFile(
  new URL('../../core/pkg/blaze_cache_wasm_bg.wasm', import.meta.url),
);

/** A cache over the real wasm module (Node has no `fetch` for `file:` URLs). */
const makeCache = (options = {}) => createCache({ wasm: wasmBytes, persistence: false, ...options });

/**
 * The real `globalThis.fetch`, counting every request that actually leaves the process.
 *
 * Counting at this level is what lets a live test still assert "the network ran exactly
 * once" — the requests are real, their number is observed rather than canned.
 */
const realNetwork = (cache, options = {}) => {
  let requests = 0;
  const counted = (input, init) => {
    requests += 1;
    return globalThis.fetch(input, init);
  };
  // Deliberately waits one macrotask before resolving: `store` is fire-and-forget (the
  // body it buffers comes from a `clone()`, so it costs the caller nothing), and these
  // tests inspect `cache.size()`/`onlyRecord` immediately after the first response. Without
  // the yield they would race a write that is still in flight and read an empty cache.
  // `fetch.test.mjs` does the same thing in `createTestFetch`.
  const blaze = createBlazeFetch(cache, {
    fetch: counted,
    // GitHub answers `Vary: Accept,Accept-Encoding, X-Requested-With` and jsonplaceholder
    // answers `Vary: Origin, Accept-Encoding`. A `Vary` naming a header we do not key on
    // means the response is storable only once we say we key on it — left at the
    // conservative default nothing would ever be cached, and every HIT assertion below
    // would fail (correctly, but for the wrong reason). All of these are constant for the
    // requests this file makes, so keying on them changes nothing except storability.
    varyHeaders: [
      'authorization',
      'accept',
      'accept-encoding',
      'x-requested-with',
      'origin',
    ],
    ...options,
  });
  return {
    fetch: async (input, init) => {
      const response = await blaze(input, init);
      // `store` is fire-and-forget: it buffers a *clone* of this body over the real network,
      // so the response can resolve long before the write lands. Draining our own tee of
      // the same stream waits for every byte to cross the wire; one `delay(0)` then lets
      // all the microtasks that follow — including the store's own `cache.set` — run before
      // the test looks at the cache. Without this the assertions race a body still in
      // flight, which a stubbed network never exposed.
      await response.clone().arrayBuffer().catch(() => undefined);
      await delay(0);
      return response;
    },
    requests: () => requests,
  };
};

/** The single stored record — and proof that there *is* one. */
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

/** A real background revalidation takes a real round-trip; wait for it instead of guessing. */
const eventually = async (predicate, message, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  assert.fail(message);
};

describe('live: real public API', () => {
  it('stores a real response and replays it as a HIT', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const { fetch, requests } = realNetwork(cache, { ttlMs: 30_000 });

    const miss = await fetch(REPO);
    assert.equal(miss.status, 200, 'the endpoint answered');
    assert.equal(miss.headers.get('x-blaze-cache'), 'MISS');
    const payload = await miss.json();
    assert.equal(payload.full_name, 'blaze-cache/blaze-cache', 'the real body parses');

    const hit = await fetch(REPO);
    assert.equal(hit.headers.get('x-blaze-cache'), 'HIT');
    assert.equal(requests(), 1, 'no second round-trip left the process');
    assert.equal(hit.status, 200);
    assert.equal(
      hit.headers.get('content-type'),
      miss.headers.get('content-type'),
      'real headers are replayed too',
    );
    assert.deepEqual(await hit.json(), payload, 'the replayed body is byte-identical');

    const { key, record } = onlyRecord(cache);
    assert.ok(key.startsWith('get https://api.github.com/'), `stored under the URL, got ${key}`);
    assert.equal(record.status, 200);
    assert.deepEqual(storedJson(record), payload, 'the payload is in the cache');
    assert.ok(record.headers['cache-control'], 'the server’s own header was stored with it');
    assert.ok(
      record.freshUntil - record.storedAt > 0,
      'and it opened a fresh window on the stored record',
    );
  });

  it("lets the API's max-age drive the window, not ttlMs", { skip: SKIP }, async () => {
    const cache = await makeCache();
    // One millisecond of our own — only the server's header can keep the entry alive.
    const { fetch, requests } = realNetwork(cache, { ttlMs: 1 });

    const response = await fetch(REPO);
    assert.equal(response.headers.get('x-blaze-cache'), 'MISS');

    const directives = parseCacheControl(response.headers.get('cache-control'));
    const ageMs = parseAgeMs(response.headers.get('age'));

    if (directives.noStore || directives.noCache || directives.maxAgeMs === 0) {
      // The server forbade reuse — the wrapper must obey, ttlMs notwithstanding.
      assert.equal(cache.size(), 0, 'a no-store/no-cache response was never stored');
      return;
    }

    const { record } = onlyRecord(cache);
    const window = freshFor(record);
    assert.deepEqual(storedJson(record), await response.clone().json(), 'the body is stored');

    if (directives.maxAgeMs !== undefined) {
      assert.ok(
        window >= directives.maxAgeMs - ageMs - 2_000,
        `max-age=${directives.maxAgeMs} drove the window, not ttlMs: 1 (stored ${window}ms)`,
      );
      assert.ok(window <= directives.maxAgeMs, '…and never exceeds what the server allowed');
    } else {
      assert.ok(window >= 1, 'no max-age: our own ttlMs kept it (barely)');
    }

    if (directives.maxAgeMs !== undefined && directives.maxAgeMs > ageMs) {
      const hit = await fetch(REPO);
      assert.equal(hit.headers.get('x-blaze-cache'), 'HIT', 'served from the stored entry');
      assert.equal(requests(), 1, 'still no second round-trip');
    }
  });

  it('never stores a response the server marked no-cache', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const { fetch, requests } = realNetwork(cache, { ttlMs: 60_000 });

    const response = await fetch(NO_CACHE);
    assert.equal(response.status, 200, 'the endpoint answered');
    assert.equal(response.headers.get('x-blaze-cache'), 'MISS');

    const directives = parseCacheControl(response.headers.get('cache-control'));
    if (!directives.noCache && !directives.noStore) {
      // Some networks rewrap this response with a max-age; there is nothing to reject then.
      assert.ok(cache.size() <= 1, 'the store holds at most this response');
      return;
    }

    assert.equal(cache.size(), 0, "the real `no-cache` header beat our ttlMs: 60_000");
    assert.deepEqual(cache.keys(), [], 'nothing was written, not even under another key');

    await fetch(NO_CACHE);
    assert.equal(requests(), 2, 'and it went back to the network, twice in a row');
  });

  it('force refresh goes back to the network and rewrites the entry', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const { fetch, requests } = realNetwork(cache, { ttlMs: 30_000 });

    await fetch(REPO);
    await fetch(REPO);
    assert.equal(requests(), 1, 'the second one hit');

    const forced = await fetch(REPO, { forceRefresh: true });
    assert.equal(forced.headers.get('x-blaze-cache'), 'MISS');
    assert.equal(requests(), 2, 'the forced request really left the process');
    assert.equal((await forced.json()).full_name, 'blaze-cache/blaze-cache');
    assert.equal(cache.size(), 1, 'it rewrote the same key rather than adding one');

    const after = await fetch(REPO);
    assert.equal(after.headers.get('x-blaze-cache'), 'HIT', 'the fresh entry serves again');
    assert.equal(requests(), 2, '…and no further traffic was needed');
  });

  it('serves a stale real entry and revalidates it in the background', { skip: SKIP }, async () => {
    const cache = await makeCache();
    // The response carries `max-age=60`, so ignore headers here and run on our own clock:
    // 1.5s of freshness, then a long stale-but-servable window.
    const { fetch, requests } = realNetwork(cache, {
      cacheControl: false,
      ttlMs: 1_500,
      staleWhileRevalidate: 60_000,
    });

    await fetch(REPO);
    await delay(1_700); // past our window (the server's would still be fresh)

    const stale = await fetch(REPO);
    assert.equal(stale.headers.get('x-blaze-cache'), 'STALE', 'the stale body is served');
    assert.deepEqual((await stale.json()).full_name, 'blaze-cache/blaze-cache');
    assert.equal(requests(), 2, '…and the refresh started in the background');

    const [key] = cache.keys();
    await eventually(
      () => {
        const record = cache.get(key);
        return Boolean(record) && record.freshUntil > Date.now();
      },
      'the background refresh never rewrote the entry',
    );

    const fresh = await fetch(REPO);
    assert.equal(fresh.headers.get('x-blaze-cache'), 'HIT', 'the rewritten entry is fresh again');
    assert.equal(requests(), 2, 'exactly one refresh per key');
    assert.equal(cache.size(), 1, 'still a single entry, now holding the new response');
  });

  it('keeps an authorized request from poisoning the anonymous entry', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const { fetch, requests } = realNetwork(cache, { ttlMs: 30_000 });

    const anonymous = await fetch(REPO);
    assert.equal(anonymous.status, 200, 'anonymous access works');
    assert.equal(anonymous.headers.get('x-blaze-cache'), 'MISS');
    assert.equal(cache.size(), 1, 'and it is stored');

    // A token is part of the default key, so this reads a *different* slot — and the API
    // rejects it, so the default `shouldCache` (2xx only) must not store the failure.
    const authorized = await fetch(REPO, {
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    assert.equal(authorized.status, 401, 'the real API rejected the bogus token');
    assert.equal(authorized.headers.get('x-blaze-cache'), 'MISS');
    assert.equal(requests(), 2, 'that one really went out on the wire');
    assert.equal(cache.size(), 1, 'a failed auth neither overwrote nor joined the good entry');

    const again = await fetch(REPO);
    assert.equal(again.headers.get('x-blaze-cache'), 'HIT', 'the anonymous entry survived');
    assert.equal(requests(), 2, '…and needed no third request');
    assert.equal((await again.json()).full_name, 'blaze-cache/blaze-cache', 'with its payload intact');

    const keys = cache.keys();
    assert.equal(keys.length, 1, 'exactly one entry, for the one identity that succeeded');
    assert.ok(
      keys.every((key) => !key.includes('not-a-real-token')),
      'the token never appears in a key',
    );
  });

  it('caches two authorized identities separately', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const { fetch, requests } = realNetwork(cache, { ttlMs: 30_000 });
    // Answers 200 with a real body for any token, and allows caching — so two identities
    // can be shown occupying two slots on a real server.
    const ECHO = 'https://jsonplaceholder.typicode.com/posts/1';

    const anonymous = await fetch(ECHO);
    assert.equal(anonymous.status, 200);
    await fetch(ECHO, { headers: { authorization: 'Bearer ada' } });
    await fetch(ECHO, { headers: { authorization: 'Bearer grace' } });
    assert.equal(requests(), 3, 'three identities, three round-trips');
    assert.equal(cache.size(), 3, 'three entries — the Authorization header changed the key');

    const adaAgain = await fetch(ECHO, { headers: { authorization: 'Bearer ada' } });
    assert.equal(adaAgain.headers.get('x-blaze-cache'), 'HIT', 'the same identity hits again');
    assert.equal(requests(), 3, 'without touching the network');
    assert.equal((await adaAgain.json()).id, 1, 'with the right payload');

    const keys = cache.keys();
    assert.equal(keys.length, 3);
    assert.ok(
      keys.every((key) => !key.includes('ada') && !key.includes('grace')),
      'tokens are hashed, never stored verbatim',
    );
    assert.deepEqual(
      cache.entries().map((entry) => entry.value.status),
      [200, 200, 200],
      'every identity stored its own response',
    );
  });

  it('downloads a real binary file and replays it byte-for-byte', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const { fetch, requests } = realNetwork(cache, { ttlMs: 30_000 });
    const FILE =
      'https://raw.githubusercontent.com/blaze-cache/blaze-cache/main/docs/blaze-cache-logo.png';

    const miss = await fetch(FILE);
    assert.equal(miss.status, 200, 'the file is served');
    assert.equal(miss.headers.get('content-type'), 'image/png');
    assert.equal(miss.headers.get('x-blaze-cache'), 'MISS');

    const fromNetwork = new Uint8Array(await miss.arrayBuffer());
    assert.ok(fromNetwork.byteLength > 1_000, `a real payload (${fromNetwork.byteLength} bytes)`);
    assert.deepEqual(
      [...fromNetwork.slice(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      'the PNG signature is intact',
    );

    const hit = await fetch(FILE);
    assert.equal(hit.headers.get('x-blaze-cache'), 'HIT');
    assert.equal(requests(), 1, 'the file was not downloaded twice');

    const fromCache = new Uint8Array(await hit.arrayBuffer());
    assert.equal(fromCache.byteLength, fromNetwork.byteLength, 'same length');
    assert.deepEqual([...fromCache], [...fromNetwork], 'every byte identical');

    // The headers must describe the bytes we hold, not the wire encoding that carried them.
    const blobHit = await fetch(FILE);
    assert.equal(blobHit.headers.get('x-blaze-cache'), 'HIT');
    assert.equal(requests(), 1, 'the blob view needs no network either');
    const blob = await blobHit.blob();
    assert.equal(blob.type, 'image/png', 'blob() keeps the MIME type');
    assert.equal(blob.size, fromCache.byteLength, '…and the exact size');
    assert.equal(hit.headers.get('content-encoding'), null, 'no encoding claim on decoded bytes');

    const { record } = onlyRecord(cache);
    assert.equal(record.body.byteLength, fromCache.byteLength, 'the raw bytes are what got stored');
    if (record.headers['content-length'] !== undefined) {
      assert.equal(
        record.headers['content-length'],
        String(fromCache.byteLength),
        'content-length was corrected to the stored size, not the compressed one',
      );
    }
  });
});
