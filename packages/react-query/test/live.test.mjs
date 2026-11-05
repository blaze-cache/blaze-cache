/**
 * **Live** tests for `@blaze-cache/react-query`, against a real public API.
 *
 * The offline suite drives real `QueryClient`s against stubbed fetchers, which is what
 * lets it assert exact call counts — but a stub can never prove that *real* response
 * bytes are mirrored under TanStack's own hash, or that the dehydrate → hydrate round
 * trip survives contact with an actual network. This file does.
 *
 * It is deliberately separate from `react-query.test.mjs` and **skipped unless opted in**,
 * so the default suite stays deterministic and works offline:
 *
 *   pnpm --filter @blaze-cache/react-query test:live     # sets BLAZE_CACHE_LIVE=1 for you
 *   BLAZE_CACHE_LIVE=1 node --test test/live.test.mjs
 *
 * Endpoint (keyless): `GET https://api.github.com/repos/blaze-cache/blaze-cache` — a 200
 * JSON body. Unauthenticated GitHub allows 60 requests/hour and this file uses well under
 * ten.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { createCache } from '@blaze-cache/core';
import {
  createBlazeQueryClient,
  dehydrateBlazeQueryClient,
  hashQueryKey,
  hydrateBlazeQueryClient,
  prefetchBlazeQuery,
  readBlazeRecord,
  resolveQueryHash,
} from '@blaze-cache/react-query';

const LIVE = process.env.BLAZE_CACHE_LIVE === '1';
const SKIP = LIVE
  ? false
  : 'live network tests are opt-in: run `pnpm --filter @blaze-cache/react-query test:live`';

/** A real GitHub repository — 200, JSON. */
const REPO = 'https://api.github.com/repos/blaze-cache/blaze-cache';
/** The query key every test in this file uses. */
const QUERY_KEY = ['blaze-cache', 'repo'];

const wasmBytes = await readFile(
  new URL('../../core/pkg/blaze_cache_wasm_bg.wasm', import.meta.url),
);

/** A cache over the real wasm module (Node has no `fetch` for `file:` URLs). */
const makeCache = (options = {}) => createCache({ wasm: wasmBytes, persistence: false, ...options });

/** A `queryFn` over the real network, counting every call that leaves the process. */
const realQueryFn = (counter) => async () => {
  counter.calls += 1;
  const response = await globalThis.fetch(REPO);
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
};

describe('live: real public API', () => {
  it('mirrors a real queryFn result under TanStack’s own hash', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const client = createBlazeQueryClient({ cache });
    const counter = { calls: 0 };

    await prefetchBlazeQuery(cache, client, {
      queryKey: QUERY_KEY,
      queryFn: realQueryFn(counter),
    });
    assert.equal(counter.calls, 1, 'the queryFn ran exactly once');

    const hash = resolveQueryHash(client, QUERY_KEY);
    assert.equal(hash, hashQueryKey(QUERY_KEY), 'the default hasher is TanStack’s own');
    const query = client.getQueryCache().get(hash);
    assert.ok(query, 'TanStack holds the query');
    assert.equal(query.state.data?.full_name, 'blaze-cache/blaze-cache');

    const record = readBlazeRecord(cache, client, { queryKey: QUERY_KEY });
    assert.ok(record, 'the mirror holds it too');
    assert.equal(record.data?.full_name, 'blaze-cache/blaze-cache');
    assert.deepEqual([...record.queryKey], QUERY_KEY);
    assert.ok(cache.hasTag(hash, 'react-query'), 'under the default tag');
    assert.ok(cache.entry(hash).ttlMs > 86_400_000 - 5_000, 'with the default 24h TTL');
  });

  it('a second prefetch inside staleTime never reaches the network', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const client = createBlazeQueryClient({ cache });
    const counter = { calls: 0 };

    await prefetchBlazeQuery(cache, client, {
      queryKey: QUERY_KEY,
      queryFn: realQueryFn(counter),
    });
    assert.equal(counter.calls, 1);

    await prefetchBlazeQuery(cache, client, {
      queryKey: QUERY_KEY,
      queryFn: realQueryFn(counter),
      staleTime: 60_000,
    });
    assert.equal(counter.calls, 1, 'the mirror seeded it — no second round-trip');

    const query = client.getQueryCache().get(hashQueryKey(QUERY_KEY));
    assert.equal(query.state.data?.full_name, 'blaze-cache/blaze-cache');
  });

  it('a dehydrate → hydrate round trip restores the mirror with zero network', {
    skip: SKIP,
  }, async () => {
    const cache = await makeCache();
    const client = createBlazeQueryClient({ cache });
    const counter = { calls: 0 };

    await prefetchBlazeQuery(cache, client, {
      queryKey: QUERY_KEY,
      queryFn: realQueryFn(counter),
    });
    assert.equal(counter.calls, 1);

    const state = dehydrateBlazeQueryClient(cache);
    assert.equal(state.queries.length, 1, 'the mirror is dehydratable');
    assert.equal(state.queries[0].state.data?.full_name, 'blaze-cache/blaze-cache');

    // A fresh session: empty cache, empty client — hydration alone must rebuild both.
    const freshCache = await makeCache();
    const freshClient = createBlazeQueryClient({ cache: freshCache });

    hydrateBlazeQueryClient(freshCache, freshClient, state, { tags: ['ssr'] });

    const restored = readBlazeRecord(freshCache, freshClient, { queryKey: QUERY_KEY });
    assert.ok(restored, 'the mirror was restored');
    assert.equal(restored.data?.full_name, 'blaze-cache/blaze-cache');
    assert.equal(
      restored.dataUpdatedAt,
      state.queries[0].state.dataUpdatedAt,
      'with the original freshness timestamp',
    );
    assert.equal(freshCache.size(), 1, 'exactly the one persisted query');
    assert.ok(
      freshCache.hasTag(resolveQueryHash(freshClient, QUERY_KEY), 'ssr'),
      'hydrated with the caller’s tags',
    );
    assert.equal(counter.calls, 1, 'hydration made no network call — the fetcher never ran');
  });

  it('an aborted fetch leaves the mirror empty', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const client = createBlazeQueryClient({ cache });
    const aborted = new AbortController();
    aborted.abort();

    await prefetchBlazeQuery(cache, client, {
      queryKey: QUERY_KEY,
      queryFn: async () => {
        const response = await globalThis.fetch(REPO, { signal: aborted.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      },
    });

    assert.equal(cache.size(), 0, 'a failed prefetch leaves no mirror entry');
  });
});
