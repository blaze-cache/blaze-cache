/**
 * **Live** tests for the cross-integration suite, against a real public API.
 *
 * The offline suite pins the isolation contract with a canned adapter; this file proves
 * the same five integrations against the same shared cache — driven over *real* network
 * — behave the same way a development machine behaves, instead of an idealized stub.
 *
 * It is deliberately separate from `shared-cache.test.mjs` and **skipped unless opted in**,
 * so the default suite stays deterministic and works offline:
 *
 *   pnpm --filter @blaze-cache/integration-tests test:live     # sets BLAZE_CACHE_LIVE=1 for you
 *   BLAZE_CACHE_LIVE=1 node --test test/live.test.mjs
 *
 * Endpoint (keyless): `GET https://api.github.com/repos/blaze-cache/blaze-cache` — a 200
 * JSON body. Unauthenticated GitHub allows 60 requests/hour and this file uses well under
 * ten. A workspace build is assumed (`pnpm build`), exactly like the offline suite.
 *
 * Integrations under test, all on one cache: axios, fetch, ky, react-query, swr.
 * They are wired to the *same* `Vary`-keying on purpose, so `fetch` and `ky` genuinely
 * share an entry for identical request identity — the contract this suite exists to prove
 * end to end.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import axios, { getAdapter } from 'axios';

import { createCache } from '@blaze-cache/core';
import { installBlazeCache } from '@blaze-cache/axios';
import { createBlazeFetch } from '@blaze-cache/fetch';
import { createBlazeKy } from '@blaze-cache/ky';
import {
  createBlazeQueryClient,
  prefetchBlazeQuery,
} from '@blaze-cache/react-query';
import { blazeSWRMiddleware } from '@blaze-cache/swr';

const LIVE = process.env.BLAZE_CACHE_LIVE === '1';
const SKIP = LIVE
  ? false
  : 'live network tests are opt-in: run `pnpm --filter @blaze-cache/integration-tests test:live`';

/** A real GitHub repository — 200, JSON. */
const REPO = 'https://api.github.com/repos/blaze-cache/blaze-cache';
const QUERY_KEY = ['blaze-cache', 'repo'];

/**
 * GitHub answers `Vary: Accept,Accept-Encoding, X-Requested-With`. Naming those here is
 * what keys `fetch` and `ky` on them — needed for the shared-entry test, and for the
 * axios instance for the same reason.
 */
const VARY = ['authorization', 'accept', 'accept-encoding', 'x-requested-with'];

const wasmBytes = await readFile(
  new URL('../../core/pkg/blaze_cache_wasm_bg.wasm', import.meta.url),
);

/** A cache over the real wasm module (Node has no `fetch` for `file:` URLs). */
const makeCache = (options = {}) => createCache({ wasm: wasmBytes, persistence: false, ...options });

/**
 * Poll — bounded — until the background stores have written `count` entries.
 *
 * axios/fetch/ky buffer their network bodies in a detached task, so a single
 * `await` does not mean their entries exist yet; wait for the cache itself to say so.
 */
const whenStored = async (cache, count, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cache.size() >= count) return;
    await delay(25);
  }
  assert.fail(`expected ${count} entries in the cache, got ${cache.size()}`);
};

/** The `useSWRNext`-shaped chain — copies the offline suite's driver. */
function runSwrMiddleware(cache, middlewareOptions, key, fetcher, config = {}) {
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

/**
 * One shared counter across every integration in a test — so a HIT is provable by the
 * counter *not* moving, not by trusting any one wrapper's bookkeeping.
 */
const realNetwork = () => {
  const state = { requests: 0 };
  const fetchCounting = (input, init) => {
    state.requests += 1;
    return globalThis.fetch(input, init);
  };
  const real = getAdapter(['xhr', 'http', 'fetch']);
  const httpAdapter = async (config) => {
    state.requests += 1;
    return real(config);
  };
  const jsonQueryFn = async () => {
    const response = await fetchCounting(REPO);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  return { state, fetchCounting, httpAdapter, jsonQueryFn };
};

/**
 * All five integrations on one cache, with real network underneath them.
 *
 * Every integration gets its own counter increment — axios via its adapter, the rest via
 * the wrapped `fetch` — so the count stays truthful no matter which layer replays.
 */
const fiveIntegrations = (cache, network) => {
  const axiosApi = axios.create({ adapter: network.httpAdapter });
  installBlazeCache(axiosApi, { cache, varyHeaders: VARY });

  const fetchWrap = createBlazeFetch(cache, { fetch: network.fetchCounting, varyHeaders: VARY });

  // An anonymous ky read would share fetch's entry for this identity — keep the
  // integrations distinct so the "five entries" assertions mean something.
  const kyApi = createBlazeKy(cache, {
    fetch: network.fetchCounting,
    varyHeaders: VARY,
    key: () => 'ky live repo entry',
  });

  const rqClient = createBlazeQueryClient({ cache });

  const swrFetcher = async () => {
    const response = await network.fetchCounting(REPO);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  const swr = () => runSwrMiddleware(cache, {}, REPO, swrFetcher);

  const prefetch = (options = {}) =>
    prefetchBlazeQuery(cache, rqClient, {
      queryKey: QUERY_KEY,
      queryFn: network.jsonQueryFn,
      ...options,
    });

  return { axiosApi, fetchWrap, kyApi, rqClient, prefetch, swr };
};

describe('live: five integrations, one shared cache', () => {
  it('each integration reached the real API exactly once, and the cache holds all five', {
    skip: SKIP,
  }, async () => {
    const cache = await makeCache();
    const network = realNetwork();
    const { axiosApi, fetchWrap, kyApi, prefetch, swr } = fiveIntegrations(cache, network);

    const ax = await axiosApi.get(REPO);
    assert.equal(ax.status, 200, 'the endpoint answered');
    assert.equal(ax.headers.get('x-blaze-cache'), 'MISS');

    const ft = await fetchWrap(REPO);
    assert.equal(ft.status, 200);
    assert.equal(ft.headers.get('x-blaze-cache'), 'MISS');

    const ky = await kyApi.get(REPO);
    assert.equal(ky.status, 200);
    assert.equal(ky.headers.get('x-blaze-cache'), 'MISS');

    await prefetch();

    const run = swr();
    await run.fetcher(REPO);

    await whenStored(cache, 5);
    assert.equal(network.state.requests, 5, 'each integration made exactly one round-trip');
    assert.equal(cache.size(), 5, 'one entry per integration on the shared cache');
  });

  it('every integration’s second read is served from the store — the counter does not move', {
    skip: SKIP,
  }, async () => {
    const cache = await makeCache();
    const network = realNetwork();
    const { axiosApi, fetchWrap, kyApi, prefetch, swr } = fiveIntegrations(cache, network);

    await axiosApi.get(REPO);
    await fetchWrap(REPO);
    await kyApi.get(REPO);
    await prefetch();
    await swr().fetcher(REPO);
    await whenStored(cache, 5);
    const afterWarm = network.state.requests;
    assert.equal(afterWarm, 5);

    assert.equal((await axiosApi.get(REPO)).headers.get('x-blaze-cache'), 'HIT');
    assert.equal((await fetchWrap(REPO)).headers.get('x-blaze-cache'), 'HIT');
    assert.equal((await kyApi.get(REPO)).headers.get('x-blaze-cache'), 'HIT');

    await prefetch({ staleTime: 60_000 });

    const fresh = swr();
    assert.equal(fresh.config.fallbackData?.full_name, 'blaze-cache/blaze-cache');

    assert.equal(
      network.state.requests,
      afterWarm,
      'not one of those reads left the process',
    );
  });

  it('fetch stores, ky replays the same entry for identical request identity', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const network = realNetwork();

    const fetchWrap = createBlazeFetch(cache, { fetch: network.fetchCounting, varyHeaders: VARY });
    const kyApi = createBlazeKy(cache, { fetch: network.fetchCounting, varyHeaders: VARY });

    const f = await fetchWrap(REPO);
    assert.equal(f.headers.get('x-blaze-cache'), 'MISS');
    const fBytes = new Uint8Array(await f.arrayBuffer());
    await whenStored(cache, 1);

    const k = await kyApi.get(REPO);
    assert.equal(k.headers.get('x-blaze-cache'), 'HIT', 'ky replayed the entry fetch stored');
    assert.equal(network.state.requests, 1, 'and made no round-trip of its own');
    assert.equal(cache.size(), 1, 'one shared entry, not two');

    const kBytes = new Uint8Array(await k.arrayBuffer());
    assert.deepEqual(kBytes, fBytes, 'byte-identical bodies cross the integration boundary');
  });

  it('a default-tag purge removes exactly that integration’s entry', { skip: SKIP }, async () => {
    const cache = await makeCache();
    const network = realNetwork();

    // Anonymous fetch keyed by the default algorithm; ky pinned to its own key — two
    // distinct entries, two distinct default tags.
    const fetchWrap = createBlazeFetch(cache, { fetch: network.fetchCounting, varyHeaders: VARY });
    const kyApi = createBlazeKy(cache, {
      fetch: network.fetchCounting,
      varyHeaders: VARY,
      key: () => 'ky live repo entry',
    });

    const f = await fetchWrap(REPO);
    assert.equal(f.headers.get('x-blaze-cache'), 'MISS');
    const k = await kyApi.get(REPO);
    assert.equal(k.status, 200, 'the anonymous request went out');
    await whenStored(cache, 2);
    assert.equal(cache.size(), 2, 'one entry per integration');

    assert.equal(cache.keysWithTag('fetch').length, 1, 'fetch owns exactly one tagged entry');
    assert.equal(cache.keysWithTag('ky').length, 1, 'ky owns exactly one tagged entry');

    cache.invalidateTags('fetch');
    assert.equal(cache.size(), 1, 'only fetch’s entry was purged');

    const f2 = await fetchWrap(REPO);
    assert.equal(f2.headers.get('x-blaze-cache'), 'MISS', 'fetch pays the network again');

    const k2 = await kyApi.get(REPO);
    assert.equal(k2.headers.get('x-blaze-cache'), 'HIT', 'ky’s entry survived the purge');
    assert.equal(
      network.state.requests,
      3,
      'fetch went out twice, ky went out once — its re-read replayed from the store',
    );
  });
});
