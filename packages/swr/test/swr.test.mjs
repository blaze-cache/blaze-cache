/**
 * Smoke tests for `@blaze-cache/swr`.
 *
 * They run against the **built** artifacts (`dist/` + the real wasm binary). Rendering
 * `useBlazeSWR` itself is deliberately not covered: running a hook needs a DOM renderer
 * (jsdom / testing-library), which this repo does not carry. Its whole data path — the
 * key serialization, the hydration read and the persisting fetcher — lives in
 * `blazeSWRMiddleware`, which is driven below exactly the way SWR's `withArgs` drives it
 * (chain a fake `useSWRNext`, call the resulting hook, inspect what it forwarded).
 *
 *   pnpm --filter @blaze-cache/swr test
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { unstable_serialize } from 'swr';

import { createCache } from '@blaze-cache/core';
import {
  blazeSWRMiddleware,
  DEFAULT_TAGS,
  DEFAULT_TTL_MS,
  invalidateBlazeSWR,
  isBlazeSWRRecord,
  readBlazeSWRRecord,
  resolveBlazeKey,
  useBlazeSWR,
} from '@blaze-cache/swr';

const wasmBytes = await readFile(
  new URL('../../core/pkg/blaze_cache_wasm_bg.wasm', import.meta.url),
);

/** A cache over the real wasm module (Node has no `fetch` for `file:` URLs). */
const makeCache = (options = {}) => createCache({ wasm: wasmBytes, persistence: false, ...options });

/** What the middleware writes — the envelope hydration recognises. */
const swrRecord = (data, storedAt = Date.now()) => ({ kind: 'swr', data, storedAt });

/**
 * Drives a middleware the way SWR's `withArgs` does — chain it over a fake `useSWRNext`,
 * call it, and hand back everything it forwarded.
 */
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

/** A `BlazeSWRCacheLike` double that counts which read it was offered. */
function spyCache(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    gets: 0,
    peeks: 0,
    get(key) {
      this.gets++;
      return map.get(key);
    },
    peek(key) {
      this.peeks++;
      return map.get(key);
    },
    set(key, value) {
      map.set(key, value);
    },
  };
}

describe('module surface', () => {
  it('exports the documented entry points', () => {
    assert.equal(typeof blazeSWRMiddleware, 'function');
    assert.equal(typeof resolveBlazeKey, 'function');
    assert.equal(typeof useBlazeSWR, 'function');
    assert.equal(typeof invalidateBlazeSWR, 'function');
    assert.equal(typeof isBlazeSWRRecord, 'function');
    assert.equal(typeof readBlazeSWRRecord, 'function');
    assert.equal(DEFAULT_TTL_MS, 86_400_000);
    assert.deepEqual([...DEFAULT_TAGS], ['swr']);
  });

  it('recognises its own envelope and rejects foreign shapes', () => {
    assert.equal(isBlazeSWRRecord(swrRecord('v')), true);
    assert.equal(isBlazeSWRRecord({ kind: 'swr', data: 'v' }), false, 'no stamp');
    assert.equal(isBlazeSWRRecord({ kind: 'axios', data: 'v', storedAt: 1 }), false);
    assert.equal(isBlazeSWRRecord({ title: 'raw value' }), false);
    assert.equal(isBlazeSWRRecord(null), false);
  });
});

describe('resolveBlazeKey', () => {
  it('files plain strings under themselves', () => {
    assert.equal(resolveBlazeKey('/api/todos'), '/api/todos');
  });

  it('matches SWR’s own serialization for every key shape', () => {
    const keys = [
      '/api/todos',
      ['todos', { page: 1, done: true }],
      { endpoint: '/settings', version: 'v1' },
      () => ['todos', 42],
    ];
    for (const key of keys) {
      assert.equal(resolveBlazeKey(key), unstable_serialize(key));
    }
  });

  it('is stable across object key order', () => {
    assert.equal(
      resolveBlazeKey(['todos', { page: 1, done: true }]),
      resolveBlazeKey(['todos', { done: true, page: 1 }]),
    );
    assert.notEqual(resolveBlazeKey(['todos', 1]), resolveBlazeKey(['todos', 2]));
  });

  it('resolves lazy keys the way SWR does — and maps every paused key to null', () => {
    assert.equal(resolveBlazeKey(() => ['todos', 42]), resolveBlazeKey(['todos', 42]));
    assert.equal(resolveBlazeKey(() => null), null);
    assert.equal(resolveBlazeKey(() => { throw new Error('deps not ready'); }), null);
    assert.equal(resolveBlazeKey(null), null);
    assert.equal(resolveBlazeKey(undefined), null);
    assert.equal(resolveBlazeKey(false), null);
    assert.equal(resolveBlazeKey(''), null);
    assert.equal(resolveBlazeKey([]), null);
  });
});

describe('hydration', () => {
  it('seeds a persisted entry as fallbackData', async () => {
    const cache = await makeCache();
    cache.set('/api/todos', swrRecord([{ id: 1 }]));

    const { config } = runMiddleware(cache, {}, '/api/todos', () => 'fetch');
    assert.deepEqual(config.fallbackData, [{ id: 1 }]);
  });

  it('never seeds a foreign value — another integration’s record under a shared key is a miss', async () => {
    const cache = await makeCache();
    // What an axios write looks like on a shared cache with a forced colliding key:
    // no `kind: 'swr'` envelope, so it must not reach the UI as this hook's `data`.
    cache.set('/api/todos', {
      status: 200,
      data: { source: 'axios' },
      storedAt: Date.now(),
      freshUntil: Date.now() + 60_000,
    });

    const { config } = runMiddleware(cache, {}, '/api/todos', () => 'fetch');
    assert.equal('fallbackData' in config, false, 'the foreign value was not seeded');
  });

  it('leaves the config object untouched on a miss', async () => {
    const cache = await makeCache();
    const original = { dedupingInterval: 5_000 };

    const { config } = runMiddleware(cache, {}, '/api/missing', () => 'fetch', original);
    assert.equal(config, original);
    assert.equal('fallbackData' in config, false);
  });

  it('keeps a caller-supplied fallbackData authoritative', async () => {
    const cache = await makeCache();
    cache.set('/api/todos', swrRecord([{ id: 1 }]));

    const { config } = runMiddleware(cache, {}, '/api/todos', () => 'fetch', {
      fallbackData: 'caller',
    });
    assert.equal(config.fallbackData, 'caller');
  });

  it('keeps a provider-level fallback entry for this key authoritative', async () => {
    const cache = await makeCache();
    cache.set('/api/todos', swrRecord([{ id: 1 }]));

    const { config } = runMiddleware(cache, {}, '/api/todos', () => 'fetch', {
      fallback: { '/api/todos': 'provider' },
    });
    assert.equal(config.fallbackData, undefined);
    assert.equal(config.fallback['/api/todos'], 'provider');
  });

  it('reads through peek, so renders never touch hit/miss statistics', async () => {
    const cache = await makeCache();
    cache.set('/api/todos', swrRecord([{ id: 1 }]));
    const before = cache.stats();

    runMiddleware(cache, {}, '/api/todos', () => 'fetch');

    const after = cache.stats();
    assert.equal(after.hits, before.hits);
    assert.equal(after.misses, before.misses);
    assert.equal(after.size, before.size);
  });

  it('prefers peek over get, and falls back to get when peek is absent', () => {
    const withPeek = spyCache({ k: swrRecord('v') });
    const seeded = runMiddleware(withPeek, {}, 'k', () => 'fetch');
    assert.equal(seeded.config.fallbackData, 'v');
    assert.equal(withPeek.peeks, 1);
    assert.equal(withPeek.gets, 0);

    const withoutPeek = spyCache({ k: swrRecord('v') });
    delete withoutPeek.peek;
    const seeded2 = runMiddleware(withoutPeek, {}, 'k', () => 'fetch');
    assert.equal(seeded2.config.fallbackData, 'v');
    assert.equal(withoutPeek.gets, 1);
    assert.equal(withoutPeek.peeks, 0);
  });

  it('reads under the SWR-serialized key, not the raw one', async () => {
    const cache = await makeCache();
    cache.set(resolveBlazeKey(['todos', 7]), swrRecord([7]));

    const { config } = runMiddleware(cache, {}, ['todos', 7], () => 'fetch');
    assert.deepEqual(config.fallbackData, [7]);
  });

  it('leaves SWR’s revalidation defaults alone — the fetcher still runs on mount', async () => {
    const cache = await makeCache();
    cache.set('/api/todos', swrRecord([{ id: 1 }]));

    const { config } = runMiddleware(cache, {}, '/api/todos', () => 'fetch');
    assert.equal(config.revalidateOnMount, undefined);
    assert.equal(config.revalidateIfStale, undefined);
    assert.equal(config.dedupe, undefined);
  });

  it('pauses with a paused key: no read, fetcher untouched', () => {
    const spy = spyCache();
    const fetcher = () => 'fetch';

    const captured = runMiddleware(spy, {}, null, fetcher);
    assert.equal(spy.peeks, 0);
    assert.equal(spy.gets, 0);
    assert.equal(captured.fetcher, fetcher);
    assert.equal('fallbackData' in captured.config, false);
  });

  it('hydrates without a fetcher (global-fetcher / client-state usage)', async () => {
    const cache = await makeCache();
    cache.set('/api/todos', swrRecord([{ id: 1 }]));

    const { config, fetcher } = runMiddleware(cache, {}, '/api/todos', null);
    assert.deepEqual(config.fallbackData, [{ id: 1 }]);
    assert.equal(fetcher, null);
  });
});

describe('persistence', () => {
  it('writes a successful fetch under the SWR-serialized key', async () => {
    const cache = await makeCache();
    const { fetcher } = runMiddleware(cache, {}, ['todos', 7], async () => [7]);

    const data = await fetcher(['todos', 7]);
    assert.deepEqual(data, [7], 'the fetcher resolves with the bare result');
    const record = cache.get(resolveBlazeKey(['todos', 7]));
    assert.deepEqual(record.data, [7], 'and the cache holds it inside the envelope');
    assert.equal(record.kind, 'swr');
    assert.equal(typeof record.storedAt, 'number');
  });

  it('stamps the entry with the resolved ttl and tags', async () => {
    const cache = await makeCache();
    const { fetcher } = runMiddleware(
      cache,
      { ttlMs: 30_000, tags: ['todos'] },
      '/api/todos',
      async () => 'data',
    );
    await fetcher('/api/todos');

    const entry = cache.entry('/api/todos');
    assert.ok(entry, 'the entry was persisted');
    assert.deepEqual(entry.tags, ['todos']);
    assert.ok(entry.ttlMs > 25_000 && entry.ttlMs <= 30_000, `ttl was ${entry.ttlMs}`);
  });

  it('falls back to the 24 h / swr defaults when nothing is given', async () => {
    const cache = await makeCache();
    const { fetcher } = runMiddleware(cache, {}, '/api/todos', async () => 'data');
    await fetcher('/api/todos');

    const entry = cache.entry('/api/todos');
    assert.deepEqual(entry.tags, ['swr']);
    assert.ok(entry.ttlMs > DEFAULT_TTL_MS - 10_000 && entry.ttlMs <= DEFAULT_TTL_MS);
  });

  it('lets per-call options override the middleware’s own stamp', async () => {
    const cache = await makeCache();
    const { fetcher } = runMiddleware(
      cache,
      { ttlMs: 1_000, tags: ['middleware'] },
      '/api/todos',
      async () => 'data',
      { ttlMs: 5_000, tags: ['call'] },
    );
    await fetcher('/api/todos');

    const entry = cache.entry('/api/todos');
    assert.deepEqual(entry.tags, ['call']);
    assert.ok(entry.ttlMs > 4_000 && entry.ttlMs <= 5_000);
  });

  it('honours an explicit empty tag list', async () => {
    const cache = await makeCache();
    const { fetcher } = runMiddleware(
      cache,
      { tags: ['middleware'] },
      '/api/todos',
      async () => 'data',
      { tags: [] },
    );
    await fetcher('/api/todos');
    assert.deepEqual(cache.entry('/api/todos').tags, []);
  });

  it('never persists a failed fetch', async () => {
    const cache = await makeCache();
    const { fetcher } = runMiddleware(cache, {}, '/api/todos', async () => {
      throw new Error('boom');
    });

    await assert.rejects(() => fetcher('/api/todos'), /boom/);
    assert.equal(cache.has('/api/todos'), false);
  });

  it('never persists an undefined result — SWR reads it as “no data”', async () => {
    const cache = await makeCache();
    const { fetcher } = runMiddleware(cache, {}, '/api/todos', async () => undefined);

    assert.equal(await fetcher('/api/todos'), undefined);
    assert.equal(cache.has('/api/todos'), false);
  });

  it('persists the value a synchronous fetcher returns', async () => {
    const cache = await makeCache();
    const { fetcher } = runMiddleware(cache, {}, '/api/todos', () => 'sync');

    assert.equal(await fetcher('/api/todos'), 'sync');
    assert.equal(cache.get('/api/todos').data, 'sync');
  });

  it('round-trips: what one hook fetches, the next mount paints from the cache', async () => {
    const cache = await makeCache();
    const first = runMiddleware(cache, {}, '/api/todos', async () => [{ id: 1 }]);
    await first.fetcher('/api/todos');

    // A fresh middleware call — a new session, as far as the cache is concerned.
    const second = runMiddleware(cache, {}, '/api/todos', async () => 'refetched');
    assert.deepEqual(second.config.fallbackData, [{ id: 1 }]);
  });

  it('exposes tag invalidation as cache.invalidateTags for the written entries', async () => {
    const cache = await makeCache();
    const { fetcher } = runMiddleware(
      cache,
      { tags: ['todos'] },
      '/api/todos',
      async () => 'data',
    );
    await fetcher('/api/todos');

    assert.deepEqual(cache.invalidateTags('todos'), ['/api/todos']);
    assert.equal(cache.has('/api/todos'), false);
  });

  it('round-trips through a persistence adapter: one session writes, the next paints', async () => {
    // A `CachePersistence` over a plain Map — the whole contract the IndexedDB adapter
    // also satisfies, with nothing but JavaScript between the two sessions.
    const rows = new Map();
    const adapter = {
      load: async () => [...rows.values()],
      save: async (records) => {
        for (const record of records) rows.set(record.key, record);
      },
      remove: async (keys) => {
        for (const key of keys) rows.delete(key);
      },
      clear: async () => rows.clear(),
      keys: async () => [...rows.keys()],
    };

    const first = await createCache({ wasm: wasmBytes, persistence: { adapter } });
    const session = runMiddleware(first, { tags: ['todos'] }, '/api/todos', async () => [{ id: 1 }]);
    await session.fetcher('/api/todos');
    await first.dispose(); // flush + teardown — the row is on its way to the adapter

    const second = await createCache({ wasm: wasmBytes, persistence: { adapter } });
    try {
      const { config } = runMiddleware(second, {}, '/api/todos', () => 'fetch');
      assert.deepEqual(config.fallbackData, [{ id: 1 }], 'the next session paints from storage');
      assert.deepEqual(second.entry('/api/todos').tags, ['todos'], 'and the stamp survived');
    } finally {
      await second.dispose();
    }
  });
});

describe('forceRefresh', () => {
  it('skips hydration and guarantees the fetcher runs', async () => {
    const cache = await makeCache();
    cache.set('/api/todos', swrRecord([{ id: 1 }]));

    const { config } = runMiddleware(cache, {}, '/api/todos', () => 'fetch', {
      forceRefresh: true,
    });
    assert.equal('fallbackData' in config, false, 'the persisted entry was not seeded');
    assert.equal(config.revalidateOnMount, true, 'revalidation is guaranteed');
  });

  it('wins over an explicit revalidateOnMount: false — the flag exists to fetch', async () => {
    const cache = await makeCache();

    const { config } = runMiddleware(cache, {}, '/api/todos', () => 'fetch', {
      forceRefresh: true,
      revalidateOnMount: false,
    });
    assert.equal(config.revalidateOnMount, true);
  });

  it('still writes the result back — skip the read, keep the write', async () => {
    const cache = await makeCache();
    cache.set('/api/todos', swrRecord([{ id: 1 }]));

    const { fetcher } = runMiddleware(cache, {}, '/api/todos', async () => [{ id: 2 }], {
      forceRefresh: true,
    });
    await fetcher('/api/todos');

    assert.deepEqual(cache.get('/api/todos').data, [{ id: 2 }], 'the fresh result replaced the old');
  });

  it('leaves a caller-supplied fallbackData authoritative', async () => {
    const cache = await makeCache();
    cache.set('/api/todos', swrRecord([{ id: 1 }]));

    const { config } = runMiddleware(cache, {}, '/api/todos', () => 'fetch', {
      forceRefresh: true,
      fallbackData: 'caller',
    });
    assert.equal(config.fallbackData, 'caller');
    assert.equal(config.revalidateOnMount, true, 'the fetch still runs');
  });

  it('per-call config beats the middleware’s own forceRefresh', async () => {
    const cache = await makeCache();
    cache.set('/api/todos', swrRecord([{ id: 1 }]));

    const { config } = runMiddleware(cache, { forceRefresh: true }, '/api/todos', () => 'fetch', {
      forceRefresh: false,
    });
    assert.deepEqual(config.fallbackData, [{ id: 1 }], 'an explicit false keeps hydration');
    assert.equal(config.revalidateOnMount, undefined, 'and no forced revalidation');
  });

  it('works middleware-wide, without a per-call flag', async () => {
    const cache = await makeCache();
    cache.set('/api/todos', swrRecord([{ id: 1 }]));

    const { config } = runMiddleware(cache, { forceRefresh: true }, '/api/todos', () => 'fetch');
    assert.equal('fallbackData' in config, false);
    assert.equal(config.revalidateOnMount, true);
  });

  it('leaves a paused key’s config untouched', () => {
    const spy = spyCache();
    const fetcher = () => 'fetch';
    const original = { dedupingInterval: 5_000 };

    const captured = runMiddleware(spy, { forceRefresh: true }, null, fetcher, original);
    assert.equal(captured.config, original, 'no config was rebuilt for a paused key');
    assert.equal(spy.peeks, 0);
    assert.equal(captured.fetcher, fetcher);
  });
});

describe('tags resolvers', () => {
  it('resolves at write time with the key and data the fetcher received', async () => {
    const cache = await makeCache();
    const seen = [];
    const { fetcher } = runMiddleware(
      cache,
      {
        tags: (key, data) => {
          seen.push([key, data]);
          return ['user', `user:${data.id}`];
        },
      },
      '/api/users/7',
      async () => ({ id: 7 }),
    );

    await fetcher('/api/users/7');

    assert.deepEqual(seen, [['/api/users/7', { id: 7 }]], 'the resolver saw the fetcher’s arguments');
    assert.deepEqual(cache.entry('/api/users/7').tags, ['user', 'user:7']);
  });

  it('per-call tags beat the middleware’s resolver', async () => {
    const cache = await makeCache();
    const middlewareResolver = () => ['middleware'];
    const { fetcher } = runMiddleware(
      cache,
      { tags: middlewareResolver },
      '/api/todos',
      async () => 'data',
      { tags: ['call'] },
    );

    await fetcher('/api/todos');
    assert.deepEqual(cache.entry('/api/todos').tags, ['call']);
  });

  it('a throwing resolver skips the write but never the data', async () => {
    const cache = await makeCache();
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
      const { fetcher } = runMiddleware(
        cache,
        {
          tags: () => {
            throw new Error('resolver exploded');
          },
        },
        '/api/todos',
        async () => 'data',
      );

      assert.equal(await fetcher('/api/todos'), 'data', 'the fetched data resolved untouched');
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(cache.has('/api/todos'), false, 'nothing was written');
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /storing the response failed/);
  });
});

describe('cache-layer failures', () => {
  it('a throwing read hydrates nothing — one warning for the life of the module', () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
      const cache = {
        get() {
          throw new Error('read failed');
        },
        peek() {
          throw new Error('read failed');
        },
        set() {},
      };

      const first = runMiddleware(cache, {}, '/api/todos', () => 'fetch');
      const second = runMiddleware(cache, {}, '/api/todos', () => 'fetch');
      assert.equal('fallbackData' in first.config, false, 'the first render fetches instead');
      assert.equal('fallbackData' in second.config, false, 'and so does every later one');
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 1, 'a warning per render would drown the console');
    assert.match(String(warnings[0][0]), /reading from the cache failed/);
  });

  it('a throwing write returns the fetched data unstored', async () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
      const cache = {
        get() {},
        peek() {},
        set() {
          throw new Error('quota exceeded');
        },
      };
      const { fetcher } = runMiddleware(cache, {}, '/api/todos', async () => 'data');

      assert.equal(await fetcher('/api/todos'), 'data', 'the cache failure never reached SWR');
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /storing the response failed/);
  });
});

describe('invalidateBlazeSWR', () => {
  it('purges this package’s records under the tag — foreign entries survive', async () => {
    const cache = await makeCache();
    const todos = runMiddleware(cache, { tags: ['todos'] }, '/api/todos', async () => 'mine');
    await todos.fetcher('/api/todos');
    const profile = runMiddleware(cache, { tags: ['profile'] }, '/api/profile', async () => 'p');
    await profile.fetcher('/api/profile');
    // Another integration's record wearing the *same* tag: not this package's to delete.
    cache.set(
      '/api/foreign',
      { status: 200, data: { source: 'axios' }, storedAt: Date.now() },
      { tags: ['todos'] },
    );

    const removed = await invalidateBlazeSWR(cache, 'todos');

    assert.deepEqual(removed, ['/api/todos']);
    assert.equal(cache.has('/api/todos'), false);
    assert.equal(cache.has('/api/foreign'), true, 'the foreign record was left alone');
    assert.equal(cache.has('/api/profile'), true, 'a record without the tag was left alone');
  });

  it('purges every SWR record — and only those — when no tag is given', async () => {
    const cache = await makeCache();
    const a = runMiddleware(cache, {}, '/api/a', async () => 1);
    await a.fetcher('/api/a');
    const b = runMiddleware(cache, {}, '/api/b', async () => 2);
    await b.fetcher('/api/b');
    cache.set('/api/foreign', { raw: true }, { tags: ['swr'] });

    const removed = await invalidateBlazeSWR(cache);

    assert.deepEqual([...removed].sort(), ['/api/a', '/api/b']);
    assert.equal(cache.has('/api/foreign'), true, 'the foreign value was left alone');
  });

  it('notifies SWR about exactly the purged keys', async () => {
    const cache = await makeCache();
    const a = runMiddleware(cache, { tags: ['todos'] }, '/api/a', async () => 1);
    await a.fetcher('/api/a');
    const b = runMiddleware(cache, { tags: ['todos'] }, '/api/b', async () => 2);
    await b.fetcher('/api/b');
    const other = runMiddleware(cache, { tags: ['profile'] }, '/api/profile', async () => 3);
    await other.fetcher('/api/profile');

    const notified = [];
    const removed = await invalidateBlazeSWR(cache, 'todos', {
      mutate: async (key) => {
        notified.push(key);
      },
    });

    assert.equal(removed.length, 2);
    assert.deepEqual(notified, removed, 'the same keys, in the same order — nothing else');
    assert.ok(!notified.includes('/api/profile'));
  });

  it('accepts options without tags — purge all, custom mutate', async () => {
    const cache = await makeCache();
    const a = runMiddleware(cache, {}, '/api/a', async () => 1);
    await a.fetcher('/api/a');

    const notified = [];
    const removed = await invalidateBlazeSWR(cache, {
      mutate: async (key) => {
        notified.push(key);
      },
    });

    assert.deepEqual(removed, ['/api/a']);
    assert.deepEqual(notified, ['/api/a']);
    assert.equal(cache.has('/api/a'), false);
  });

  it('refuses to run when the cache cannot be enumerated', async () => {
    const cache = { get() {}, peek() {}, set() {}, delete() {} };

    await assert.rejects(() => invalidateBlazeSWR(cache, 'todos'), /entries\(\)/);
  });

  it('refuses — before deleting anything — when the cache cannot delete', async () => {
    const cache = {
      get() {},
      peek() {},
      set() {},
      entries() {
        return [{ key: 'k', value: swrRecord('v'), ttlMs: null, tags: ['todos'] }];
      },
      // no `delete`
    };

    await assert.rejects(() => invalidateBlazeSWR(cache, 'todos'), /delete\(\)/);
  });

  it('the default mutate path is safe with no hooks mounted', async () => {
    const cache = await makeCache();
    const a = runMiddleware(cache, {}, '/api/a', async () => 1);
    await a.fetcher('/api/a');

    // No options: the real `swr` global mutate runs against a key nothing subscribes to.
    assert.deepEqual(await invalidateBlazeSWR(cache, 'swr'), ['/api/a']);
  });
});
