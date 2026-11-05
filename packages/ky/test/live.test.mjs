/**
 * **Live** tests for `@blaze-cache/ky`, against a real public API.
 *
 * Everything else in this package runs against a stubbed network, which is why it can
 * assert exact call counts — but a stub can never prove that *real* response headers are
 * read correctly, or that a real body survives a buffer-and-replay round-trip. This file
 * does.
 *
 * It is deliberately separate from `ky.test.mjs` and **skipped unless opted in**, so the
 * default suite stays deterministic and works offline:
 *
 *   pnpm --filter @blaze-cache/ky test:live     # sets BLAZE_CACHE_LIVE=1 for you
 *   BLAZE_CACHE_LIVE=1 node --test test/live.test.mjs
 *
 * Endpoints (all keyless):
 *   - `GET /repos/blaze-cache/blaze-cache` → 200 with `cache-control: public, max-age=60`,
 *     so the header-honouring path is exercised against a real server.
 *   - `GET /rate_limit` → 200 with `cache-control: no-cache`, so the *rejection* path is too.
 *   - `GET raw.githubusercontent.com/blaze-cache/blaze-cache/main/docs/blaze-cache-logo.png`
 *     → a real PNG, for the binary round-trip.
 *
 * Unauthenticated GitHub allows 60 requests/hour and this file uses well under ten.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import ky from 'ky';

import { createCache } from '@blaze-cache/core';
import { blazeKyHook, parseCacheControl } from '@blaze-cache/ky';

const LIVE = process.env.BLAZE_CACHE_LIVE === '1';
const SKIP = LIVE
  ? false
  : 'live network tests are opt-in: run `pnpm --filter @blaze-cache/ky test:live`';

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
 * The real `globalThis.fetch`, counting every request that actually leaves the process.
 *
 * Counting at this level is what lets a live test still assert "the network ran exactly
 * once" — the requests are real, their number is observed rather than canned.
 */
const blazeApi = (cache, options = {}) => {
  let requests = 0;
  const counted = (input, init) => {
    requests += 1;
    return globalThis.fetch(input, init);
  };
  // GitHub answers `Vary: Accept,Accept-Encoding, X-Requested-With`. The default
  // `varyHeaders` is only `['authorization']`, and a response varying on a header we
  // don't key on is deliberately *not* stored — an unknown variant must never be
  // replayed. Naming them here is what keys the entry on them, so the round-trip
  // assertions below run against a real, storable response instead of never finding one.
  const api = ky.extend({ fetch: counted }).extend({
    hooks: blazeKyHook(cache, {
      ttlMs: 30_000,
      varyHeaders: ['authorization', 'accept', 'accept-encoding', 'x-requested-with'],
      ...options,
    }),
  });
  return { api, requests: () => requests };
};

/**
 * One awaited request with the courtesy the production adapter does not owe you.
 *
 * Buffering-and-storing a response is deliberately fire-and-forget, so the response
 * resolves while that write may still be pending. A zero-delay timer runs after *every*
 * pending microtask; use {@link whenStored}/{@link whenNotStored} when an assertion looks
 * at the store.
 */
const settle = async (response) => {
  await delay(0);
  return response;
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

/** The stored `ArrayBuffer` body, decoded — so assertions can compare the cached payload. */
const storedJson = (record) => JSON.parse(new TextDecoder().decode(record.body));

describe('live: real public API', () => {
  it('caches a real response and replays it as a HIT', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const { api, requests } = blazeApi(cache);

    const miss = await settle(api.get(REPO));
    assert.equal(miss.status, 200, 'the endpoint answered');
    assert.equal(miss.headers.get('x-blaze-cache'), 'MISS');
    await whenStored(cache, 'the real response was stored');
    const missBody = storedJson(onlyRecord(cache).record);
    assert.equal(missBody.full_name, 'blaze-cache/blaze-cache', 'the real body parsed');

    const hit = await settle(api.get(REPO));
    assert.equal(requests(), 1, 'no second round-trip left the process');
    assert.equal(hit.headers.get('x-blaze-cache'), 'HIT');
    assert.equal((await hit.json()).full_name, 'blaze-cache/blaze-cache', 'the replayed body parsed');

    const { key, record } = onlyRecord(cache);
    assert.ok(key.includes('repos/blaze-cache/blaze-cache'), `got ${key}`);
    assert.ok(record.headers['cache-control'], "the server's own header was stored with it");
    assert.ok(
      record.freshUntil - record.storedAt > 50_000,
      `max-age=60 became the entry TTL (got ${record.freshUntil - record.storedAt}ms)`,
    );
    assert.ok(cache.hasTag(key, 'ky'), 'under the default tag');
    assert.equal(storedJson(record).full_name, 'blaze-cache/blaze-cache');
  });

  it('never stores a real response marked no-cache', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const { api, requests } = blazeApi(cache);

    const first = await settle(api.get(NO_CACHE));
    assert.equal(first.status, 200, 'the endpoint answered');

    const directives = parseCacheControl(first.headers.get('cache-control'));
    if (!directives.noCache && !directives.noStore) {
      // Some networks rewrap this response with a max-age; there is nothing to reject then.
      assert.ok(cache.size() <= 1, 'the store holds at most this response');
      return;
    }

    await whenNotStored(cache);

    await settle(api.get(NO_CACHE));
    assert.equal(requests(), 2, 'and it went back to the network, twice in a row');
  });

  it('keeps an authorized request from poisoning the anonymous entry', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const { api, requests } = blazeApi(cache);

    const anonymous = await settle(api.get(REPO));
    assert.equal(anonymous.status, 200, 'anonymous access works');
    assert.equal(anonymous.headers.get('x-blaze-cache'), 'MISS');
    await whenStored(cache, 'the anonymous entry was stored');
    assert.equal(cache.size(), 1, 'and it is stored');

    // The token is part of the default key, so this reads a *different* slot — and the API
    // rejects it, so the default `shouldCache` (2xx GET) must not store the failure.
    try {
      await api.get(REPO, { headers: { authorization: 'Bearer not-a-real-token' } });
      assert.fail('expected the 401 to throw');
    } catch (error) {
      assert.equal(error.response?.status, 401, 'the real API rejected the bogus token');
    }
    assert.equal(requests(), 2, 'that one really went out on the wire');
    assert.equal(cache.size(), 1, 'a failed auth neither overwrote nor joined the good entry');

    const again = await settle(api.get(REPO));
    assert.equal(again.headers.get('x-blaze-cache'), 'HIT', 'the anonymous entry survived');
    assert.equal(requests(), 2, '…and needed no third request');
  });

  it('downloads a real binary file and replays it byte-for-byte', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const { api, requests } = blazeApi(cache);

    const miss = await settle(api.get(PNG));
    assert.equal(miss.status, 200, 'the file is served');
    assert.match(miss.headers.get('content-type') ?? '', /image\/png/);
    assert.equal(miss.headers.get('x-blaze-cache'), 'MISS');
    await whenStored(cache, 'the real PNG was stored');

    // The MISS body is a shared, fire-and-forget stream here — the store is the durable
    // copy. Assert against it instead.
    const { record } = onlyRecord(cache);
    const storedBytes = new Uint8Array(record.body);
    assert.deepEqual([...storedBytes.slice(0, 8)], PNG_SIGNATURE, 'the signature is a real PNG');

    const hit = await settle(api.get(PNG));
    assert.equal(requests(), 1, 'no second round-trip left the process');
    assert.equal(hit.headers.get('x-blaze-cache'), 'HIT');

    const hitBytes = new Uint8Array(await hit.arrayBuffer());
    assert.deepEqual(hitBytes, storedBytes, 'the replayed body is byte-identical');
  });
});
