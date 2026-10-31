/**
 * Cross-integration tests: **five integrations, one shared cache instance**.
 *
 * Every `@blaze-cache/*` package advertises the same story — create one cache, pass it
 * to whichever integrations you use — but each package's own suite can only ever prove
 * its own behaviour. This file is the only place that runs axios + fetch + ky +
 * react-query + SWR against the *same* store, and it pins both halves of that contract:
 *
 * * **Isolation that must hold** — default keys are disjoint, each integration reads
 *   back its own value shape, default tags purge only their own integration, and no
 *   integration serves, deletes or seeds a value it did not write.
 *
 * Six conflicts were found by this suite and fixed: the unfiltered purge helpers and the
 * tag purge reaching every integration's entries, axios deleting foreign values on read,
 * and axios/fetch/react-query/SWR misreading or destroying each other's values under a
 * forced key collision. Every one now has a positive assertion here, so a regression —
 * a reintroduced cross-purge or shape-blind seed — fails this suite immediately.
 *
 * They run against the **built** artifacts of every package plus the real wasm binary:
 *
 *   pnpm build:wasm && pnpm build
 *   pnpm --filter @blaze-cache/integration-tests test
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { AxiosHeaders } from 'axios';

import { createCache } from '@blaze-cache/core';
import { blazeAdapter, defaultCacheKey as axiosCacheKey } from '@blaze-cache/axios';
import { createBlazeFetch, defaultCacheKey as fetchCacheKey } from '@blaze-cache/fetch';
import { createBlazeKy, defaultCacheKey as kyCacheKey } from '@blaze-cache/ky';
import {
  createBlazeQueryClient,
  hashQueryKey,
  invalidateBlazeQueries,
  removeBlazeQueries,
  seedBlazeQueryOptions,
  setBlazeQueryData,
} from '@blaze-cache/react-query';
import { blazeSWRMiddleware, resolveBlazeKey } from '@blaze-cache/swr';

const wasmBytes = await readFile(
  new URL('../../core/pkg/blaze_cache_wasm_bg.wasm', import.meta.url),
);

/** A cache over the real wasm module (Node has no `fetch` for `file:` URLs). */
const makeCache = (options = {}) => createCache({ wasm: wasmBytes, persistence: false, ...options });

/** One URL, used by axios, fetch **and** SWR, so key-format tests mean something. */
const RESOURCE_URL = 'https://api.example.com/users';

// ---------------------------------------------------------------- small stubs

/** A faithful axios network stand-in: settles like axios's own adapters do. */
const stubAxiosNetwork = (responses) => {
  const calls = [];
  const adapter = async (config) => {
    calls.push(config);
    const canned = responses[config.url] ?? { status: 200, data: { ok: true } };
    return {
      data: canned.data,
      status: canned.status,
      statusText: String(canned.status),
      headers: canned.headers ?? { 'content-type': 'application/json' },
      config,
      request: {},
    };
  };
  return { adapter, calls };
};

/** A `fetch` stand-in returning JSON. */
const stubFetchNetwork = (body = { ok: true }) => {
  const calls = [];
  const net = async (input) => {
    const url = String(input);
    calls.push(url);
    const response = new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    // A Response built without a request reports `url === ''`; a real fetch fills it in,
    // and the cache record stores it. Shadow the prototype getter with the real URL.
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  return { net, calls };
};

/**
 * Drives the SWR middleware exactly the way SWR's `withArgs` does — chain it over a fake
 * `useSWRNext`, call the resulting hook, inspect what it forwarded.
 */
function runSwrMiddleware(cache, middlewareOptions, key, fetcher, config = {}) {
  const captured = { key, fetcher, config };
  const hook = blazeSWRMiddleware(cache, middlewareOptions)((k, f, c) => {
    captured.key = k;
    captured.fetcher = f;
    captured.config = c;
    return { data: undefined, error: undefined, isValidating: false, isLoading: false, mutate: () => {} };
  });
  captured.response = hook(key, fetcher, config);
  return captured;
}

// ---------------------------------------------------------------- shared populate

/**
 * Writes **one entry per integration** into the same cache, through each integration's
 * real write path, and returns everything a test needs to check them: the exact keys,
 * the handles that produced them, and the client/middleware for reading them back.
 */
async function populateAll(cache, options = {}) {
  // axios — MISS then HIT, so its read path has actually run against the store.
  const axStub = stubAxiosNetwork({ [RESOURCE_URL]: { status: 200, data: { source: 'axios' } } });
  const blaze = blazeAdapter({
    cache,
    adapter: axStub.adapter,
    ...(options.axiosTags ? { tags: () => options.axiosTags } : null),
    ...(options.axiosKey ? { key: options.axiosKey } : null),
  });
  const axConfig = () => ({ method: 'get', url: RESOURCE_URL, headers: new AxiosHeaders() });
  const axMiss = await blaze(axConfig());
  const axHit = await blaze(axConfig());

  // fetch — MISS then HIT, same resource.
  const fStub = stubFetchNetwork({ source: 'fetch' });
  const blazeFetch = createBlazeFetch(cache, {
    fetch: fStub.net,
    ...(options.fetchTags ? { tags: () => options.fetchTags } : null),
  });
  const fetchMiss = await blazeFetch(RESOURCE_URL, { headers: { authorization: 'Bearer t' } });
  const fetchHit = await blazeFetch(RESOURCE_URL, { headers: { authorization: 'Bearer t' } });

  // ky — MISS then HIT, same resource. Its own token keeps ky's entry distinct from
  // fetch's here, but note the two deliberately share a key *format*: for identical
  // request identity (same URL, same headers) they would share one entry, which is the
  // point — both store the same wire bytes as a compatible `ArrayBuffer` record.
  const kyStub = stubFetchNetwork({ source: 'ky' });
  const blazeKy = createBlazeKy(cache, {
    fetch: kyStub.net,
    headers: { authorization: 'Bearer k' },
    ...(options.kyTags ? { tags: () => options.kyTags } : null),
  });
  const kyMiss = await blazeKy.get(RESOURCE_URL);
  const kyHit = await blazeKy.get(RESOURCE_URL);

  // react-query — one mirrored query (TanStack state + mirror record, synchronously).
  const client = createBlazeQueryClient({ cache });
  setBlazeQueryData(cache, client, ['users'], [1, 2, 3], options.rqTags ? { tags: options.rqTags } : {});

  // SWR — one persisted entry, written by the middleware's persisting fetcher.
  const swrFetch = async () => ({ source: 'swr' });
  const swr = runSwrMiddleware(
    cache,
    options.swrTags ? { tags: options.swrTags } : {},
    RESOURCE_URL,
    swrFetch,
  );
  await swr.fetcher(RESOURCE_URL);

  return {
    keys: {
      axios: axiosCacheKey({ method: 'get', url: RESOURCE_URL, headers: {} }, ['authorization']),
      fetch: fetchCacheKey(RESOURCE_URL, { method: 'GET', headers: { authorization: 'Bearer t' } }, ['authorization']),
      ky: kyCacheKey(new Request(`${RESOURCE_URL}`, { headers: { authorization: 'Bearer k' } }), ['authorization']),
      reactQuery: hashQueryKey(['users']),
      swr: resolveBlazeKey(RESOURCE_URL),
    },
    client,
    stubs: { axStub, fStub, kyStub },
    responses: { axMiss, axHit, fetchMiss, fetchHit, kyMiss, kyHit },
    swr,
  };
}

// ================================================================ key isolation

describe('key isolation', () => {
  it('axios and fetch file the same URL under different keys', () => {
    const axKey = axiosCacheKey({ method: 'get', url: RESOURCE_URL, headers: {} }, ['authorization']);
    const ftKey = fetchCacheKey(RESOURCE_URL, { method: 'GET', headers: { authorization: 'Bearer t' } }, ['authorization']);
    // Same format (`get <url>?<fnv1a>`), but axios folds `params` into the hash input
    // ("undefined <vary>") and fetch does not — the suffixes cannot line up.
    assert.notEqual(axKey, ftKey);
    assert.ok(axKey.startsWith('get https://api.example.com/users?'));
    assert.ok(ftKey.startsWith('get https://api.example.com/users?'));
  });

  it('every integration’s default key format is pairwise disjoint', async () => {
    const cache = await makeCache();
    const { keys } = await populateAll(cache);

    assert.equal(
      new Set(Object.values(keys)).size,
      5,
      `five integrations, five distinct keys — got ${JSON.stringify(keys)}`,
    );

    // The formats themselves: HTTP keys are method-prefixed, SWR strings pass through
    // raw, TanStack keys are JSON — nothing overlaps structurally. ky and fetch share a
    // format on purpose (same wire identity → same entry); here their hashed
    // `authorization` inputs differ, so the suffixes keep them apart.
    assert.ok(keys.axios.startsWith('get '));
    assert.ok(keys.fetch.startsWith('get '));
    assert.ok(keys.ky.startsWith('get '));
    assert.equal(keys.swr, RESOURCE_URL);
    assert.equal(keys.reactQuery, '["users"]');
    assert.notEqual(resolveBlazeKey(['users']), hashQueryKey(['users']), 'SWR array hashes vs TanStack JSON');
  });
});

// ================================================================ round trip

describe('round trip on one cache', () => {
  it('all five integrations coexist, and each reads back its own value shape', async () => {
    const cache = await makeCache();
    const { keys, client, stubs, swr, responses } = await populateAll(cache);

    assert.equal(cache.size(), 5, 'one entry per integration, none overwritten');

    // axios: second request served from its own record.
    assert.equal(stubs.axStub.calls.length, 1, 'axios hit the network exactly once');
    assert.equal(responses.axHit.fromBlazeCache, true);
    assert.deepEqual(responses.axHit.data, { source: 'axios' });
    const axRecord = cache.get(keys.axios);
    assert.equal(axRecord.status, 200, 'axios sees an AxiosCacheRecord');
    assert.equal(typeof axRecord.freshUntil, 'number');

    // fetch: second request served from its own record.
    assert.equal(stubs.fStub.calls.length, 1, 'fetch hit the network exactly once');
    assert.equal(responses.fetchHit.headers.get('x-blaze-cache'), 'HIT');
    const ftRecord = cache.get(keys.fetch);
    assert.equal(ftRecord.url, RESOURCE_URL, 'fetch sees a FetchCacheRecord');
    assert.ok(ftRecord.body instanceof ArrayBuffer, 'with a byte body');

    // ky: second request served from its own record.
    assert.equal(stubs.kyStub.calls.length, 1, 'ky hit the network exactly once');
    assert.equal(responses.kyMiss.headers.get('x-blaze-cache'), 'MISS');
    assert.equal(responses.kyHit.headers.get('x-blaze-cache'), 'HIT');
    const kyRecord = cache.get(keys.ky);
    assert.equal(kyRecord.url, RESOURCE_URL, 'ky sees a KyCacheRecord');
    assert.ok(kyRecord.body instanceof ArrayBuffer, 'with a byte body');
    assert.equal(typeof kyRecord.freshUntil, 'number', 'and its own freshness deadline');

    // react-query: the mirror seeds query data, not a foreign shape.
    const seeded = seedBlazeQueryOptions(cache, client, { queryKey: ['users'] });
    assert.deepEqual(seeded.initialData, [1, 2, 3]);
    assert.equal(typeof seeded.initialDataUpdatedAt, 'number', 'with its own timestamp');

    // SWR: the envelope is unwrapped, so the hook sees the raw fetcher result.
    const seededSwr = runSwrMiddleware(cache, {}, RESOURCE_URL, async () => 'fetch');
    assert.deepEqual(seededSwr.config.fallbackData, { source: 'swr' });
    assert.equal(cache.get(keys.swr).kind, 'swr', 'persisted as its own envelope shape');

    // And nobody else's key moved: re-running every reader still sees five entries.
    assert.equal(cache.size(), 5);
  });
});

// ================================================================ shared tag index

describe('shared tag index', () => {
  it('default tags keep each integration’s purge to itself', async () => {
    const cache = await makeCache();
    const { keys } = await populateAll(cache);

    assert.equal(cache.keysWithTag('axios').length, 1);
    assert.equal(cache.keysWithTag('fetch').length, 1);
    assert.equal(cache.keysWithTag('ky').length, 1);
    assert.equal(cache.keysWithTag('react-query').length, 1);
    assert.equal(cache.keysWithTag('swr').length, 1);

    cache.invalidateTags('axios');
    assert.equal(cache.size(), 4, 'purging axios leaves the other four');
    assert.equal(cache.has(keys.axios), false);
    assert.equal(cache.has(keys.fetch), true);
    assert.equal(cache.has(keys.ky), true);
    assert.equal(cache.has(keys.reactQuery), true);
    assert.equal(cache.has(keys.swr), true);

    cache.invalidateTags('react-query');
    assert.equal(cache.has(keys.reactQuery), false);
    assert.equal(cache.size(), 3, 'each namespace tag only ever removes its own');
  });

  it('a per-resource tag spans axios, fetch and ky for the same URL', async () => {
    const cache = await makeCache();
    await populateAll(cache);

    // All three adapters tag their entry `<method> <url>`; for the same absolute URL the
    // strings match, so one purge serves all three — desirable for a shared resource, but
    // it is coupling, not isolation.
    const removed = cache.invalidateTags(`get ${RESOURCE_URL}`);
    assert.equal(removed.length, 3, 'axios, fetch and ky entries share the resource tag');
    assert.equal(cache.size(), 2, 'react-query and SWR entries are untouched');
  });

  it('caller domain tags are one namespace across every integration', async () => {
    const cache = await makeCache();
    await populateAll(cache, {
      axiosTags: ['todos'],
      fetchTags: ['todos'],
      kyTags: ['todos'],
      rqTags: ['todos'],
      swrTags: ['todos'],
    });

    assert.equal(cache.size(), 5);
    const removed = cache.invalidateTags('todos');
    assert.equal(removed.length, 5, "a single 'todos' purge clears all five integrations");
    assert.equal(cache.size(), 0);
  });

  it('a react-query tag purge stays on mirror records even when others share the tag', async () => {
    const cache = await makeCache();
    const { keys, client } = await populateAll(cache, {
      axiosTags: ['todos'],
      swrTags: ['todos'],
      rqTags: ['todos'],
    });

    await invalidateBlazeQueries(cache, client, { tags: ['todos'] });

    // Caller domain tags are one namespace — axios and SWR here carry the very tag TanStack
    // purged with — but the purge selects "mirror record AND tagged", so foreign entries
    // keep both their tags and their data.
    assert.equal(cache.has(keys.reactQuery), false, 'the react-query entry is purged, as asked');
    assert.equal(cache.has(keys.axios), true, 'the axios entry survives');
    assert.equal(cache.has(keys.swr), true, 'the SWR entry survives');
    assert.equal(cache.has(keys.fetch), true, 'the untagged fetch entry survives');
    assert.equal(cache.has(keys.ky), true, 'the untagged ky entry survives');
    assert.deepEqual(cache.tagsOf(keys.axios), ['todos'], 'its tag is intact too');
  });
});

// ================================================================ purge scoping

describe('purge scoping', () => {
  it('removeBlazeQueries() with no filters purges only mirror records', async () => {
    const cache = await makeCache();
    const { keys, client } = await populateAll(cache);

    removeBlazeQueries(cache, client);

    // "Everything persisted for queries" is enforced by record shape (`dataUpdatedAt`),
    // so the unfiltered purge reaches TanStack's own records and nothing else — the
    // other integrations' entries on the shared store survive.
    assert.equal(cache.has(keys.reactQuery), false, 'the mirror record is gone');
    assert.equal(cache.has(keys.axios), true, 'axios survives');
    assert.equal(cache.has(keys.fetch), true, 'fetch survives');
    assert.equal(cache.has(keys.ky), true, 'ky survives');
    assert.equal(cache.has(keys.swr), true, 'SWR survives');
    assert.equal(cache.size(), 4);
  });

  it('invalidateBlazeQueries() with no filters purges only mirror records', async () => {
    const cache = await makeCache();
    const { keys, client } = await populateAll(cache);

    await invalidateBlazeQueries(cache, client);

    assert.equal(cache.has(keys.reactQuery), false, 'the mirror record is gone');
    assert.equal(cache.size(), 4, 'the four foreign entries were left in place');
  });

  it('scoped purges leave foreign entries alone', async () => {
    const cache = await makeCache();
    const { keys, client } = await populateAll(cache);

    removeBlazeQueries(cache, client, { queryKey: ['users'] });

    assert.equal(cache.has(keys.reactQuery), false, 'the matching mirror entry is gone');
    assert.equal(cache.has(keys.axios), true, 'axios untouched');
    assert.equal(cache.has(keys.fetch), true, 'fetch untouched');
    assert.equal(cache.has(keys.ky), true, 'ky untouched');
    assert.equal(cache.has(keys.swr), true, 'SWR untouched');
    assert.equal(cache.size(), 4);
  });
});

// ================================================================ forced collisions

describe('forced key collisions (custom keys)', () => {
  it('a foreign-shaped value under a colliding key is a miss for axios, never deleted', async () => {
    const cache = await makeCache();
    const foreign = { title: 'an SWR-ish value' };
    cache.set('shared-key', foreign);

    const { adapter, calls } = stubAxiosNetwork({ [RESOURCE_URL]: { status: 200, data: { source: 'axios' } } });
    // `shouldCache: () => false` means axios writes nothing back — anything still in the
    // store after this request was *left alone* by the read path.
    const blaze = blazeAdapter({ cache, adapter, key: () => 'shared-key', shouldCache: () => false });

    const miss = await blaze({ method: 'get', url: RESOURCE_URL, headers: new AxiosHeaders() });

    assert.equal(calls.length, 1, 'the foreign value is not served');
    assert.equal(miss.fromBlazeCache, undefined);
    assert.deepEqual(cache.get('shared-key'), foreign, 'a read never destroys another integration’s entry');
  });

  it('a foreign-shaped value under a colliding key is a miss for ky, never deleted', async () => {
    const cache = await makeCache();
    const foreign = { title: 'an SWR-ish value' };
    cache.set('shared-key', foreign);

    const { net, calls } = stubFetchNetwork({ source: 'ky' });
    // Nothing is written back, so anything still in the store after this request was
    // *left alone* by ky's read path — the shape gate fired instead of a serve or a delete.
    const api = createBlazeKy(cache, {
      fetch: net,
      key: () => 'shared-key',
      shouldCache: () => false,
    });

    const miss = await api.get(RESOURCE_URL);

    assert.equal(calls.length, 1, 'the foreign value is not served');
    assert.equal(miss.headers.get('x-blaze-cache'), 'MISS');
    assert.deepEqual(cache.get('shared-key'), foreign, 'a read never destroys another integration’s entry');
  });

  it('SWR never hands an axios record to the UI as fallbackData', async () => {
    const cache = await makeCache();
    const axiosRecord = {
      status: 200,
      statusText: '200',
      headers: { 'content-type': 'application/json' },
      data: { source: 'axios' },
      storedAt: 1,
      freshUntil: 2,
    };
    cache.set('shared-key', axiosRecord);

    const captured = runSwrMiddleware(cache, {}, 'shared-key', async () => 'fetch');
    // SWR persists an envelope, so a value without it is another integration's: a miss,
    // not data. The hook still fetches; the UI is never shown axios metadata.
    assert.equal('fallbackData' in captured.config, false, 'the foreign record is not seeded');
  });

  it('react-query never seeds an axios body as initialData', async () => {
    const cache = await makeCache();
    const client = createBlazeQueryClient({ cache });
    const axiosRecord = {
      status: 200,
      statusText: '200',
      headers: {},
      data: { source: 'axios' },
      storedAt: 1,
      freshUntil: 2,
    };
    const mirrorKey = hashQueryKey(['users']);
    cache.set(mirrorKey, axiosRecord);

    const seeded = seedBlazeQueryOptions(cache, client, { queryKey: ['users'] });
    // The shape gate rejects it: an axios record has a `data` body but no `dataUpdatedAt`,
    // so seeding it would hand the HTTP body to TanStack as query data dated "now" — a
    // configured `staleTime` silently suppressed.
    assert.equal(seeded.initialData, undefined, 'the HTTP body is not query data');
    assert.equal(seeded.initialDataUpdatedAt, undefined, 'and no timestamp rides along');
  });
});

// ================================================================ shared pools

describe('shared capacity and stats', () => {
  it('one eviction pool: one integration’s write flood evicts another’s entries', async () => {
    const cache = await makeCache({ capacity: 5 });
    const { keys, client } = await populateAll(cache);
    assert.equal(cache.has(keys.reactQuery), true, 'the mirror starts in the cache');

    // Flood from "another integration" until the older entry is gone — capacity is a
    // single shared budget, nothing shields one integration's entries from another's
    // write volume (size your cache for the total, not per integration).
    let writes = 0;
    while (cache.has(keys.reactQuery) && writes < 50) {
      cache.set(`flood-${writes}`, { n: writes });
      writes++;
    }
    assert.equal(cache.has(keys.reactQuery), false, 'the mirror was evicted by foreign writes');
    assert.ok(cache.size() <= 5, `size stayed within capacity (${cache.size()})`);
    assert.ok(client, 'the client itself is fine — only the persisted copy went');
  });

  it('stats aggregate: SWR/react-query renders do not move them, axios reads do', async () => {
    const cache = await makeCache();

    // Seed-reads — what react-query and SWR do on every render, via `peek`: no hit/miss,
    // no eviction visit. Plant both entries under each integration's *real* key so the
    // reads below are genuine hits, not misses that could hide behind "nothing found".
    cache.set('seeded', { v: 1 });
    cache.set(hashQueryKey(['seeded']), { data: { v: 1 }, dataUpdatedAt: Date.now() });
    const rqClient = createBlazeQueryClient({ cache });
    const before = cache.stats();
    runSwrMiddleware(cache, {}, 'seeded', async () => 'fetch');
    seedBlazeQueryOptions(cache, rqClient, { queryKey: ['seeded'] });
    const afterSeeds = cache.stats();
    assert.equal(afterSeeds.hits, before.hits, 'peek-based seeding never scores a hit');
    assert.equal(afterSeeds.misses, before.misses, 'nor a miss');

    // An axios read (get) — a real request: its miss and hit are the shared counters'.
    const { adapter, calls } = stubAxiosNetwork({ '/x': { status: 200, data: { ok: true } } });
    const blaze = blazeAdapter({ cache, adapter });
    await blaze({ method: 'get', url: '/x', headers: new AxiosHeaders() }); // miss-read, then write
    await blaze({ method: 'get', url: '/x', headers: new AxiosHeaders() }); // hit-read
    assert.equal(calls.length, 1);
    const afterAxios = cache.stats();
    assert.equal(afterAxios.misses, afterSeeds.misses + 1, 'the axios miss is on the shared ledger');
    assert.equal(afterAxios.hits, afterSeeds.hits + 1, 'and so is its hit');
  });
});
