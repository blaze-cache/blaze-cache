/**
 * **Live** tests for `@blaze-cache/axios`, against real public APIs.
 *
 * The offline suite in `axios.test.mjs` runs against a canned adapter, which is what lets
 * it assert exact call counts — but a stub cannot prove that *real* `Cache-Control`
 * headers are parsed, that a real `401` is refused, or that a real binary survives the
 * buffer-and-replay round-trip. This file does.
 *
 * It is skipped unless opted in, so the default suite stays deterministic and offline:
 *
 *   pnpm --filter @blaze-cache/axios test:live     # sets BLAZE_CACHE_LIVE=1 for you
 *   BLAZE_CACHE_LIVE=1 node --test test/live.test.mjs
 *
 * Endpoints (all keyless):
 *   - `GET https://api.github.com/repos/blaze-cache/blaze-cache` → 200,
 *     `cache-control: public, max-age=60`; with a bogus token → 401.
 *   - `GET https://api.github.com/rate_limit` → 200, `cache-control: no-cache`.
 *   - `GET https://raw.githubusercontent.com/.../docs/blaze-cache-logo.png` → a real PNG.
 *
 * Unauthenticated GitHub allows 60 requests/hour and this file uses well under ten.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import axios, { AxiosHeaders, getAdapter } from 'axios';

import { createCache } from '@blaze-cache/core';
import { installBlazeCache, parseCacheControl } from '@blaze-cache/axios';

const LIVE = process.env.BLAZE_CACHE_LIVE === '1';
const SKIP = LIVE
  ? false
  : 'live network tests are opt-in: run `pnpm --filter @blaze-cache/axios test:live`';

const REPO = '/repos/blaze-cache/blaze-cache';
const RATE_LIMIT = '/rate_limit';
const FILE = 'https://raw.githubusercontent.com/blaze-cache/blaze-cache/main/docs/blaze-cache-logo.png';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const wasmBytes = await readFile(
  new URL('../../core/pkg/blaze_cache_wasm_bg.wasm', import.meta.url),
);

/** A cache over the real wasm module (Node has no `fetch` for `file:` URLs). */
const makeCache = (options = {}) => createCache({ wasm: wasmBytes, persistence: false, ...options });

/**
 * A real axios instance on `api.github.com` whose adapter counts actual round-trips.
 *
 * The counting adapter is installed on the instance *first*, so `installBlazeCache` wraps
 * it — which is precisely the capture-the-previous-adapter contract that keeps the wrapper
 * from ever recursing into itself.
 */
const realApi = (cache, options = {}) => {
  let requests = 0;
  const real = getAdapter(['xhr', 'http', 'fetch']);
  const instance = axios.create({
    baseURL: 'https://api.github.com',
    adapter: async (config) => {
      requests += 1;
      return real(config);
    },
  });
  installBlazeCache(instance, { cache, ttlMs: 30_000, ...options });
  return { instance, requests: () => requests };
};

/** The single stored record — and proof that there *is* one. */
const onlyRecord = (cache) => {
  assert.equal(cache.size(), 1, 'exactly one entry is stored');
  const [key] = cache.keys();
  const record = cache.get(key);
  assert.ok(record, 'and it is readable');
  return { key, record };
};

/** The status of an axios rejection, whatever shape it arrived in. */
const statusOf = async (promise) => {
  try {
    const response = await promise;
    return response.status;
  } catch (error) {
    return error.response?.status ?? 0;
  }
};

describe('live: real public API', () => {
  it('caches a real response and replays it as a HIT', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const { instance, requests } = realApi(cache);

    const miss = await instance.get(REPO);
    assert.equal(miss.status, 200, 'the endpoint answered');
    assert.equal(miss.headers.get('x-blaze-cache'), 'MISS');
    assert.equal(miss.fromBlazeCache, undefined, 'the first one came off the wire');
    assert.equal(miss.data.full_name, 'blaze-cache/blaze-cache', 'the real body parsed');

    const hit = await instance.get(REPO);
    assert.equal(requests(), 1, 'no second round-trip left the process');
    assert.equal(hit.headers.get('x-blaze-cache'), 'HIT');
    assert.equal(hit.fromBlazeCache, true, 'and it is flagged for the caller');
    assert.equal(hit.status, 200);
    assert.deepEqual(hit.data, miss.data, 'the replayed body is identical');

    const { key, record } = onlyRecord(cache);
    assert.ok(key.includes('api.github.com/repos/blaze-cache/blaze-cache'), `got ${key}`);
    // The adapter stores the wire payload *before* `transformResponse` runs (the replay
    // gets the same parsing a network response would) — so what is sitting in the store is
    // the raw JSON text, not the object the caller ends up with.
    const stored = typeof record.data === 'string' ? JSON.parse(record.data) : record.data;
    assert.equal(stored.full_name, 'blaze-cache/blaze-cache', 'the payload is in the cache');
    assert.ok(record.headers['cache-control'], "the server's own header was stored with it");
    assert.ok(
      cache.entry(key).ttlMs > 50_000,
      `max-age=60 became the entry TTL (got ${cache.entry(key).ttlMs}ms)`,
    );
    assert.ok(cache.hasTag(key, 'axios'), 'under the default tag');
  });

  it('never stores a real response marked no-cache', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const { instance, requests } = realApi(cache);

    const first = await instance.get(RATE_LIMIT);
    assert.equal(first.status, 200, 'the endpoint answered');

    const directives = parseCacheControl(first.headers['cache-control']);
    if (!directives.noCache && !directives.noStore) {
      // Some networks rewrap this response with a max-age; there is nothing to reject then.
      assert.ok(cache.size() <= 1, 'the store holds at most this response');
      return;
    }

    assert.equal(cache.size(), 0, "the real `no-cache` header beat ttlMs: 30_000");
    assert.deepEqual(cache.keys(), [], 'nothing was written, not even under another key');

    await instance.get(RATE_LIMIT);
    assert.equal(requests(), 2, 'and it went back to the network, twice in a row');
  });

  it('keeps an authorized request from poisoning the anonymous entry', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const { instance, requests } = realApi(cache);

    const anonymous = await instance.get(REPO);
    assert.equal(anonymous.status, 200, 'anonymous access works');
    assert.equal(anonymous.headers.get('x-blaze-cache'), 'MISS');
    assert.equal(cache.size(), 1, 'and it is stored');

    // The token is part of the default key, so this reads a *different* slot — and the API
    // rejects it, so the default `shouldCache` (2xx GET) must not store the failure.
    const status = await statusOf(
      instance.get(REPO, { headers: { Authorization: 'Bearer not-a-real-token' } }),
    );
    assert.equal(status, 401, 'the real API rejected the bogus token');
    assert.equal(requests(), 2, 'that one really went out on the wire');
    assert.equal(cache.size(), 1, 'a failed auth neither overwrote nor joined the good entry');

    const again = await instance.get(REPO);
    assert.equal(again.headers.get('x-blaze-cache'), 'HIT', 'the anonymous entry survived');
    assert.equal(requests(), 2, '…and needed no third request');
    assert.deepEqual(again.data, anonymous.data, 'with its payload intact');

    const keys = cache.keys();
    assert.equal(keys.length, 1, 'exactly one entry, for the identity that succeeded');
    assert.ok(
      keys.every((key) => !key.includes('not-a-real-token')),
      'the token never appears in a key',
    );
  });

  it('downloads a real binary file as an arraybuffer and replays it', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const { instance, requests } = realApi(cache);

    const miss = await instance.get(FILE, { responseType: 'arraybuffer' });
    assert.equal(miss.status, 200, 'the file is served');
    assert.equal(miss.headers['content-type'], 'image/png');
    assert.equal(miss.headers.get('x-blaze-cache'), 'MISS');

    const fromNetwork = new Uint8Array(miss.data);
    assert.ok(fromNetwork.byteLength > 1_000, `a real payload (${fromNetwork.byteLength} bytes)`);
    assert.deepEqual([...fromNetwork.slice(0, 8)], PNG_SIGNATURE, 'the PNG signature is intact');

    const hit = await instance.get(FILE, { responseType: 'arraybuffer' });
    assert.equal(requests(), 1, 'the file was not downloaded twice');
    assert.equal(hit.headers.get('x-blaze-cache'), 'HIT');

    const fromCache = new Uint8Array(hit.data);
    assert.equal(fromCache.byteLength, fromNetwork.byteLength, 'same length');
    assert.deepEqual([...fromCache], [...fromNetwork], 'every byte identical');

    const { record } = onlyRecord(cache);
    assert.equal(record.data.byteLength, fromNetwork.byteLength, 'the raw bytes are what got stored');
    assert.equal(record.headers['content-encoding'], undefined, 'no encoding claim on decoded bytes');
    if (record.headers['content-length'] !== undefined) {
      assert.equal(
        record.headers['content-length'],
        String(fromCache.byteLength),
        'content-length was corrected to the stored size, not the compressed one',
      );
    }
    assert.equal(
      hit.headers.get('content-length'),
      String(fromCache.byteLength),
      '…and the replay carries it',
    );
  });
});
