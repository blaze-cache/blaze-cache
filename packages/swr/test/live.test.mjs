/**
 * **Live** tests for `@blaze-cache/swr`, against a real public API.
 *
 * The offline suite drives the middleware with stubbed fetchers, which is what lets it
 * assert exact call counts — but a stub can never prove that a *real* response body round
 * trips through the Blaze Cache intact. This file does.
 *
 * It is deliberately separate from `swr.test.mjs` and **skipped unless opted in**, so the
 * default suite stays deterministic and works offline:
 *
 *   pnpm --filter @blaze-cache/swr test:live     # sets BLAZE_CACHE_LIVE=1 for you
 *   BLAZE_CACHE_LIVE=1 node --test test/live.test.mjs
 *
 * Endpoint (keyless): `GET https://api.github.com/repos/blaze-cache/blaze-cache` — a 200
 * JSON body. Unauthenticated GitHub allows 60 requests/hour and this file uses well under
 * ten.
 *
 * The middleware is driven exactly the way the offline suite drives it — chained over a
 * fake `useSWRNext`, calling the resulting hook and inspecting what it forwarded — except
 * the fetcher here is the real `globalThis.fetch`, so what persists is a real response.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { createCache } from '@blaze-cache/core';
import {
  blazeSWRMiddleware,
  DEFAULT_TAGS,
  DEFAULT_TTL_MS,
  isBlazeSWRRecord,
  resolveBlazeKey,
} from '@blaze-cache/swr';

const LIVE = process.env.BLAZE_CACHE_LIVE === '1';
const SKIP = LIVE
  ? false
  : 'live network tests are opt-in: run `pnpm --filter @blaze-cache/swr test:live`';

/** A real GitHub repository — 200, JSON. */
const REPO = 'https://api.github.com/repos/blaze-cache/blaze-cache';

const wasmBytes = await readFile(
  new URL('../../core/pkg/blaze_cache_wasm_bg.wasm', import.meta.url),
);

/** A cache over the real wasm module (Node has no `fetch` for `file:` URLs). */
const makeCache = (options = {}) => createCache({ wasm: wasmBytes, persistence: false, ...options });

/** The `useSWRNext`-shaped chain — copies the offline suite's driver. */
function runMiddleware(cache, middlewareOptions, key, fetcher, config = {}) {
  const captured = { key, fetcher, config };
  const response = {
    data: undefined,
    error: undefined,
    isValidating: false,
    isLoading: false,
    mutate: () => {},
  };
  const hook = blazeSWRMiddleware(cache, middlewareOptions)((k, f, c) => {
    captured.key = k;
    captured.fetcher = f;
    captured.config = c;
    return response;
  });
  captured.response = hook(key, fetcher, config);
  return captured;
}

/** A fetcher over the real network, counting every call that leaves the process. */
const realFetcher = () => {
  let requests = 0;
  const fetcher = async (url) => {
    requests += 1;
    const response = await globalThis.fetch(String(url));
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  };
  return { fetcher, requests: () => requests };
};

describe('live: real public API', () => {
  it('persists a real response as the SWR envelope', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const { fetcher, requests } = realFetcher();
    const swr = runMiddleware(cache, {}, REPO, fetcher);

    const data = await swr.fetcher(REPO);
    assert.equal(requests(), 1, 'the fetcher hit the network exactly once');
    assert.equal(data.full_name, 'blaze-cache/blaze-cache', 'the real body parsed');

    const key = resolveBlazeKey(REPO);
    const record = cache.get(key);
    assert.ok(record, 'the mirror holds the envelope');
    assert.equal(record.kind, 'swr');
    assert.ok(isBlazeSWRRecord(record));
    assert.equal(record.data.full_name, 'blaze-cache/blaze-cache');
    assert.ok(record.storedAt > 0, 'stamped when the fetch resolved');
    assert.ok(
      cache.entry(key).ttlMs > DEFAULT_TTL_MS - 5_000,
      `the default TTL (${DEFAULT_TTL_MS}ms) became the entry TTL`,
    );
    for (const tag of DEFAULT_TAGS) {
      assert.ok(cache.hasTag(key, tag), `under the default tag '${tag}'`);
    }
  });

  it('seeds a fresh middleware run from the mirror — without any network', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const { fetcher, requests } = realFetcher();
    const first = runMiddleware(cache, {}, REPO, fetcher);
    const data = await first.fetcher(REPO);
    assert.equal(requests(), 1);

    // A "new session": fresh chain, same cache. The hydration read must come off the
    // mirror alone — no fetcher call, no network.
    const second = runMiddleware(cache, {}, REPO, fetcher);
    assert.equal(requests(), 1, 'seeding the fresh run made no network call');
    assert.deepEqual(second.config.fallbackData, data, 'the payload came off the mirror');
  });

  it('a failing fetcher persists nothing', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const aborted = new AbortController();
    aborted.abort();
    const failing = () =>
      globalThis.fetch(REPO, { signal: aborted.signal }).then((res) => res.json());
    const swr = runMiddleware(cache, {}, REPO, failing);

    await assert.rejects(() => swr.fetcher(REPO));
    assert.equal(cache.size(), 0, 'a rejected fetcher left nothing behind');
  });

  it('rewrites the same single entry on revalidation', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const { fetcher, requests } = realFetcher();
    const swr = runMiddleware(cache, {}, REPO, fetcher);
    const key = resolveBlazeKey(REPO);

    await swr.fetcher(REPO);
    const first = cache.get(key);
    assert.ok(first);

    await swr.fetcher(REPO);
    assert.equal(requests(), 2, 'the revalidation really went out');
    assert.equal(cache.size(), 1, 'in place — still exactly one binding for the key');
    const second = cache.get(key);
    assert.ok(second.storedAt >= first.storedAt, 'the write is fresher or equal');
    assert.deepEqual(second.data, first.data, 'same payload on the wire');
  });
});
