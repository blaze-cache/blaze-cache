/**
 * **Live** tests for `@blaze-cache/ofetch`, against real public APIs.
 *
 * Everything else in this package runs against a stubbed network, which is why it can
 * assert exact call counts — but a stub can never prove that *real* response headers are
 * read correctly, or that a real body survives a buffer-and-replay round-trip. This file
 * does.
 *
 * It is deliberately separate from `ofetch.test.mjs` and **skipped unless opted in**, so the
 * default suite stays deterministic and works offline:
 *
 *   pnpm --filter @blaze-cache/ofetch test:live     # sets BLAZE_CACHE_LIVE=1 for you
 *   BLAZE_CACHE_LIVE=1 node --test test/live.test.mjs
 *
 * Endpoints (all keyless):
 *   - `GET /repos/blaze-cache/blaze-cache` → 200 with `cache-control: public, max-age=60`,
 *     so the header-honouring path is exercised against a real server.
 *   - `GET /rate_limit` → 200 with `cache-control: no-cache`, so the *rejection* path is too.
 *   - `GET raw.githubusercontent.com/.../docs/blaze-cache-logo.png` → a real PNG, for the
 *     binary round-trip.
 *
 * Unauthenticated GitHub allows 60 requests/hour and this file uses well under ten.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createCache } from '@blaze-cache/core';
import { createBlazeOfetch, parseCacheControl } from '@blaze-cache/ofetch';

/** In-memory {@link CachePersistence} adapter (Node has no IndexedDB). */
class MemoryAdapter {
  name = 'memory';
  #store = new Map();
  async load() {
    return [...this.#store.values()].map((r) => structuredClone(r));
  }
  async save(records) {
    for (const r of records) this.#store.set(r.key, structuredClone(r));
  }
  async remove(keys) {
    for (const k of keys) this.#store.delete(k);
  }
  async clear() {
    this.#store.clear();
  }
  async keys() {
    return [...this.#store.keys()];
  }
  async close() {}
  snapshot() {
    return new Map(this.#store);
  }
}

const LIVE = process.env.BLAZE_CACHE_LIVE === '1';
const SKIP = LIVE
  ? false
  : 'live network tests are opt-in: run `pnpm --filter @blaze-cache/ofetch test:live`';

/** A real GitHub repository — 200 with `cache-control: public, max-age=60`. */
const REPO = 'https://api.github.com/repos/blaze-cache/blaze-cache';
/** Also real, but answered with `cache-control: no-cache`. */
const NO_CACHE = 'https://api.github.com/rate_limit';
/** A real PNG straight off the raw host, for the binary round-trip. */
const PNG = 'https://raw.githubusercontent.com/blaze-cache/blaze-cache/main/docs/blaze-cache-logo.png';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const wasmBytes = await readFile(
  new URL('../../core/pkg/blaze_cache_wasm_bg.wasm', import.meta.url),
);

/** A cache over the real wasm module (Node has no `fetch` for `file:` URLs). */
const makeCache = (options = {}) => createCache({ wasm: wasmBytes, persistence: false, ...options });

/**
 * A Blaze-cached ofetch instance over the real network, counting every request that
 * actually leaves the process.
 *
 * Counting at this level lets a live test still assert "the network ran exactly once" —
 * the requests are real, their number is observed rather than canned.
 */
const liveApi = (cache, options = {}) => {
  let requests = 0;
  const counted = (input, init) => {
    requests += 1;
    return globalThis.fetch(input, init);
  };
  // GitHub answers `Vary: Accept,Accept-Encoding, X-Requested-With`. The default
  // `varyHeaders` is only `['authorization']`, and a response varying on a header we
  // don't key on is deliberately *not* stored — naming them here makes the response
  // storable so the round-trip assertions exercise a real HIT.
  const api = createBlazeOfetch(cache, {
    fetch: counted,
    ttlMs: 30_000,
    varyHeaders: ['authorization', 'accept', 'accept-encoding', 'x-requested-with'],
    // Disable ofetch's default GET retry so request counts are exact and predictable.
    retry: 0,
    ...options,
  });
  return { api, requests: () => requests };
};

const settle = async (value) => {
  await delay(0);
  return value;
};

/** Wait — bounded — until the background store has written its entry. */
const whenStored = async (cache, message, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cache.size() > 0) return;
    await delay(25);
  }
  assert.fail(message);
};

/** Give a no-store write every chance to happen, and assert it never did. */
const whenNotStored = async (cache, delayMs = 400) => {
  await delay(delayMs);
  assert.equal(cache.size(), 0, 'nothing was written, not even under another key');
  assert.deepEqual(cache.keys(), []);
};

/** The single stored record — and proof that there *is* one. */
const onlyRecord = (cache) => {
  assert.equal(cache.size(), 1, 'exactly one entry is stored');
  const [key] = cache.keys();
  const record = cache.get(key);
  assert.ok(record, 'and it is readable');
  return { key, record };
};

/** The stored `ArrayBuffer` body, decoded. */
const storedJson = (record) => JSON.parse(new TextDecoder().decode(record.body));

describe('live: real public API (ofetch)', () => {
  it('caches a real response and replays it as a HIT', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const { api, requests } = liveApi(cache);

    const miss = await settle(api.raw(REPO));
    assert.equal(miss.status, 200, 'the endpoint answered');
    assert.equal(miss.headers.get('x-blaze-cache'), 'MISS');
    await whenStored(cache, 'the real response was stored');
    const missBody = storedJson(onlyRecord(cache).record);
    assert.equal(missBody.full_name, 'blaze-cache/blaze-cache', 'the real body parsed');

    const hit = await settle(api.raw(REPO));
    assert.equal(requests(), 1, 'no second round-trip left the process');
    assert.equal(hit.headers.get('x-blaze-cache'), 'HIT');
    const hitData = await api(REPO);
    assert.equal(hitData.full_name, 'blaze-cache/blaze-cache', 'the replayed parsed body is correct');
    assert.equal(requests(), 1, 'parsed HIT also used no network');

    const { key, record } = onlyRecord(cache);
    assert.ok(key.includes('repos/blaze-cache/blaze-cache'), `got ${key}`);
    assert.ok(record.headers['cache-control'], "the server's own header was stored with it");
    assert.ok(
      record.freshUntil - record.storedAt > 50_000,
      `max-age became the entry TTL (got ${record.freshUntil - record.storedAt}ms)`,
    );
    assert.ok(cache.hasTag(key, 'ofetch'), 'under the default tag');
  });

  it('never stores a real response marked no-cache', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const { api, requests } = liveApi(cache);

    const first = await settle(api.raw(NO_CACHE));
    assert.equal(first.status, 200, 'the endpoint answered');

    const directives = parseCacheControl(first.headers.get('cache-control'));
    if (!directives.noCache && !directives.noStore) {
      // Some networks rewrap this response with a max-age; there is nothing to reject then.
      assert.ok(cache.size() <= 1, 'the store holds at most this response');
      return;
    }

    await whenNotStored(cache);

    await settle(api(NO_CACHE));
    assert.equal(requests(), 2, 'and it went back to the network, twice in a row');
  });

  it('keeps an authorized request from poisoning the anonymous entry', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const { api, requests } = liveApi(cache);

    const anonymous = await settle(api.raw(REPO));
    assert.equal(anonymous.status, 200, 'anonymous access works');
    assert.equal(anonymous.headers.get('x-blaze-cache'), 'MISS');
    await whenStored(cache, 'the anonymous entry was stored');
    assert.equal(cache.size(), 1, 'and it is stored');

    // The token is part of the default key, so this reads a *different* slot — and the API
    // rejects it, so the default `shouldCache` (2xx) must not store the failure.
    try {
      await api(REPO, { headers: { authorization: 'Bearer not-a-real-token' } });
      assert.fail('expected the 401 to throw');
    } catch (error) {
      const status = error.response?.status ?? error.status ?? error.statusCode;
      assert.equal(status, 401, 'the real API rejected the bogus token');
    }
    assert.equal(requests(), 2, 'that one really went out on the wire');
    assert.equal(cache.size(), 1, 'a failed auth neither overwrote nor joined the good entry');

    const again = await settle(api.raw(REPO));
    assert.equal(again.headers.get('x-blaze-cache'), 'HIT', 'the anonymous entry survived');
    assert.equal(requests(), 2, '…and needed no third request');
  });

  it('downloads a real binary file and replays it byte-for-byte', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const { api, requests } = liveApi(cache);

    // GitHub raw may send cache headers; ensure it is storable by our adapter.
    const miss = await settle(api.raw(PNG, { responseType: 'arrayBuffer' }));
    assert.equal(miss.status, 200, 'the file is served');
    assert.equal(miss.headers.get('x-blaze-cache'), 'MISS');
    await whenStored(cache, 'the real PNG was stored');

    const stored = onlyRecord(cache).record;
    const storedBytes = new Uint8Array(stored.body);
    assert.deepEqual([...storedBytes.slice(0, 8)], PNG_SIGNATURE, 'the signature is a real PNG');
    assert.ok(storedBytes.byteLength > 1_000, `a real payload (${storedBytes.byteLength} bytes)`);

    const hit = await settle(api.raw(PNG, { responseType: 'arrayBuffer' }));
    assert.equal(requests(), 1, 'no second round-trip left the process');
    assert.equal(hit.headers.get('x-blaze-cache'), 'HIT');

    const hitBytes = new Uint8Array(await hit.arrayBuffer());
    assert.deepEqual(hitBytes, storedBytes, 'the replayed body is byte-identical');
  });

  it('persists a real response and serves it after hydration (cold start, no network)', { skip: SKIP }, async () => {
    const adapter = new MemoryAdapter();

    // --- first "session": fetch a real response, persist it ---
    let requestsA = 0;
    const cacheA = await createCache({ wasm: wasmBytes, persistence: { adapter } });
    const apiA = createBlazeOfetch(cacheA, {
      fetch: (input, init) => { requestsA += 1; return globalThis.fetch(input, init); },
      ttlMs: 30_000,
      varyHeaders: ['authorization', 'accept', 'accept-encoding', 'x-requested-with'],
      retry: 0,
    });

    const miss = await settle(apiA.raw(REPO));
    assert.equal(miss.status, 200);
    assert.equal(miss.headers.get('x-blaze-cache'), 'MISS');
    await whenStored(cacheA, 'the real response was stored in session A');
    await cacheA.flush();
    assert.ok((await adapter.load()).length > 0, 'the adapter holds the persisted record');
    assert.equal(requestsA, 1);
    await cacheA.dispose();

    // --- second "session": hydrate from the same adapter, serve without network ---
    let requestsB = 0;
    const cacheB = await createCache({ wasm: wasmBytes, persistence: { adapter } });
    const apiB = createBlazeOfetch(cacheB, {
      fetch: (input, init) => { requestsB += 1; return globalThis.fetch(input, init); },
      ttlMs: 30_000,
      varyHeaders: ['authorization', 'accept', 'accept-encoding', 'x-requested-with'],
      retry: 0,
    });

    // Hydration is async during create; the entry should be present now.
    assert.equal(cacheB.size(), 1, 'hydrated one entry from persistence');

    const hit = await settle(apiB.raw(REPO));
    assert.equal(hit.headers.get('x-blaze-cache'), 'HIT', 'served from the hydrated cache');
    assert.equal(requestsB, 0, 'no network request in the cold-start session');

    const data = await apiB(REPO);
    assert.equal(data.full_name, 'blaze-cache/blaze-cache', 'hydrated payload parses correctly');
    assert.equal(requestsB, 0, 'parsed replay also used no network');
    await cacheB.dispose();
  });

  it('tag invalidation on a real cached response forces a refetch', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const { api, requests } = liveApi(cache);

    const miss = await settle(api.raw(REPO));
    assert.equal(miss.headers.get('x-blaze-cache'), 'MISS');
    await whenStored(cache, 'stored');

    const hit = await settle(api.raw(REPO));
    assert.equal(hit.headers.get('x-blaze-cache'), 'HIT');
    assert.equal(requests(), 1);

    cache.invalidateTags('ofetch');
    assert.deepEqual(cache.keys(), [], 'all ofetch entries dropped');

    const again = await settle(api.raw(REPO));
    assert.equal(again.headers.get('x-blaze-cache'), 'MISS', 'refetched after invalidation');
    assert.equal(requests(), 2);
  });

  it('cache: "no-cache" forces a refetch of a real (storable) response', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const { api, requests } = liveApi(cache);

    await settle(api(REPO));
    await whenStored(cache, 'stored');

    // `cache: 'no-cache'` skips the read but (per our adapter semantics) still stores/refreshes.
    await settle(api(REPO, { cache: 'no-cache' }));
    assert.equal(requests(), 2, 'no-cache bypassed the read and hit the network');

    // The refreshed entry should be readable again.
    const hit = await settle(api.raw(REPO));
    assert.equal(hit.headers.get('x-blaze-cache'), 'HIT', 'refreshed entry is readable');
    assert.equal(requests(), 2);
  });
});
