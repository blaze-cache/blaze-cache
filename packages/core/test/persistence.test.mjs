/**
 * Persistence hardening tests for `@blaze-cache/core`.
 *
 * Where `core.test.mjs` exercises persistence through stub adapters, these run against
 * the **real built-in IndexedDB adapter** on top of `fake-indexeddb` — schema stamps,
 * generation buckets, transaction batching and all — plus the control surface
 * (`cache.persistence`) and the session-isolation guarantees:
 *
 *   pnpm --filter @blaze-cache/core test
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { IDBDatabase, IDBFactory } from 'fake-indexeddb';

import { createCache, indexedDbPersistence } from '@blaze-cache/core';

const wasmBytes = await readFile(new URL('../pkg/blaze_cache_wasm_bg.wasm', import.meta.url));

/** A cache over the real wasm module (Node has no `fetch` for `file:` URLs). */
const makeCache = (options = {}) => createCache({ wasm: wasmBytes, ...options });

/** A brand-new IndexedDB registry: every test starts with empty databases. */
const freshIndexedDb = () => {
  globalThis.indexedDB = new IDBFactory();
};

/**
 * An in-memory `CachePersistence` exposing `rows` (and the optional `keys()` method) so
 * tests can see exactly what reaches storage — and stub individual methods to fail.
 */
const memoryAdapter = () => {
  const rows = new Map();
  return {
    rows,
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
};

/** A promise with its handles hanging off the side — for gating adapter calls. */
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Opens the shared test database without going through the adapter. */
const rawOpen = (name = 'blaze-cache') =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('raw open failed'));
  });

/** Puts rows straight into the store — the way a corrupt or foreign writer would. */
const rawPut = async (rows, name = 'blaze-cache') => {
  const db = await rawOpen(name);
  await new Promise((resolve, reject) => {
    const tx = db.transaction('entries', 'readwrite');
    const store = tx.objectStore('entries');
    for (const row of rows) store.put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('raw put failed'));
  });
  db.close();
};

/** Everything one namespace currently holds, read straight through an adapter. */
const peekRows = async (namespace) => {
  const adapter = indexedDbPersistence({ namespace });
  const records = await adapter.load();
  await adapter.close();
  return Object.fromEntries(records.map((record) => [record.key, record.value]));
};

const storedRecord = (key, value, extra = {}) => ({
  key,
  value,
  tags: [],
  ttlMs: null,
  storedAt: Date.now(),
  ...extra,
});

// ---------------------------------------------------------------------------
// Hydrate
// ---------------------------------------------------------------------------

describe('hydrate from IndexedDB', () => {
  it('restores valid records with their values, tags and deadlines', async () => {
    freshIndexedDb();

    const writer = await makeCache({ persistence: { namespace: 'app' } });
    writer.set('user:1', { name: 'Ada' }, { ttlMs: 60_000, tags: ['user'] });
    writer.set('plain', 42);
    await writer.persistence.flush();
    await writer.dispose();

    const reader = await makeCache({ persistence: { namespace: 'app' } });
    assert.deepEqual(reader.get('user:1'), { name: 'Ada' }, 'the object round-tripped');
    assert.equal(reader.get('plain'), 42);
    assert.deepEqual(reader.tagsOf('user:1'), ['user'], 'tags came back too');
    assert.ok(reader.ttl('user:1') > 55_000, 'and its deadline survived the round trip');

    const stats = reader.persistence.stats();
    assert.equal(stats.enabled, true);
    assert.equal(stats.hydrates, 1, 'the startup hydrate is counted');
    assert.equal(stats.restored, 2, 'with both records restored');
    await reader.dispose();
  });

  it('does not restore expired records by default, and restarts their window when asked', async () => {
    freshIndexedDb();

    // Rows written "while the tab was away": the deadline is already in the past.
    const seed = indexedDbPersistence({ namespace: 'app' });
    await seed.save([
      storedRecord('gone', 'bye', { ttlMs: 50, storedAt: Date.now() - 5_000 }),
      storedRecord('stays', 'here'),
    ]);
    await seed.close();

    const strict = await makeCache({ persistence: { namespace: 'app' } });
    assert.equal(strict.get('gone'), undefined, 'restoreExpired: false keeps it dead');
    assert.equal(strict.get('stays'), 'here', 'live records hydrate as usual');
    assert.equal(strict.persistence.stats().skipped, 1, 'the expired record is counted as skipped');

    const lenient = await makeCache({
      persistence: { namespace: 'app', restoreExpired: true },
    });
    assert.equal(lenient.get('gone'), 'bye', 'restoreExpired: true brings it back');
    const left = lenient.ttl('gone');
    assert.ok(left > 40 && left <= 50, `with the original window restarted (${left}ms)`);
    assert.ok(left > 0, 'and never with the dead remainder, which would mean "never expires"');

    // Dispose the strict cache *after* the lenient one hydrated — its reconciliation
    // pass would otherwise delete the expired row before anybody could observe it.
    await lenient.dispose();
    await strict.dispose();
  });

  it('skips corrupt records individually and still restores the rest', async () => {
    freshIndexedDb();

    // The store must exist before raw rows can be injected into it.
    const seed = indexedDbPersistence({ namespace: 'app' });
    await seed.save([storedRecord('good', { ok: true }, { tags: ['t'] })]);
    await seed.close();

    await rawPut([
      { id: 'app\0no-key', ns: 'app', value: 'no key at all', tags: [], ttlMs: null, storedAt: Date.now() },
      { id: 'app\0bad-tags', ns: 'app', key: 'bad-tags', value: 1, tags: 'nope', ttlMs: null, storedAt: Date.now() },
      { id: 'app\0bad-ttl', ns: 'app', key: 'bad-ttl', value: 1, tags: [], ttlMs: 'soon', storedAt: Date.now() },
      { id: 'app\0bad-stamp', ns: 'app', key: 'bad-stamp', value: 1, tags: [], ttlMs: null, storedAt: Date.now(), v: 'not-a-version' },
      { id: 'app\0after', ns: 'app', key: 'after', value: 'still fine', tags: [], ttlMs: null, storedAt: Date.now(), v: 1 },
    ]);

    const warns = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warns.push(args.map(String).join(' '));
    let cache;
    try {
      cache = await makeCache({ persistence: { namespace: 'app' } });
    } finally {
      console.warn = originalWarn;
    }

    assert.deepEqual(cache.get('good'), { ok: true }, 'the valid record hydrated');
    assert.equal(cache.get('after'), 'still fine', 'including one stored after the corrupt rows');
    assert.equal(cache.get('no-key'), undefined);
    assert.equal(cache.get('bad-tags'), undefined);
    assert.equal(cache.get('bad-ttl'), undefined);
    assert.equal(cache.get('bad-stamp'), undefined);
    assert.equal(cache.size(), 2, 'every corrupt row cost exactly itself');

    const stats = cache.persistence.stats();
    assert.equal(stats.restored, 2);
    assert.equal(stats.skipped, 3, 'keyless + bad tags + bad ttl (the bad stamp was the adapter\u2019s)');
    assert.ok(
      warns.some((warning) => warning.includes('unreadable')),
      'the adapter reported its unreadable row',
    );
    assert.ok(
      warns.some((warning) => warning.startsWith('[blaze-cache] skipping malformed persisted record')),
      'and the cache reported the malformed ones — one warning, not one per row',
    );
    await cache.dispose();
  });
});

// ---------------------------------------------------------------------------
// Account / session isolation
// ---------------------------------------------------------------------------

describe('generation rotation', () => {
  it('drops every write queued by the previous session', async () => {
    const adapter = memoryAdapter();
    const saves = [];
    const save = adapter.save;
    adapter.save = async (records) => {
      saves.push(records.map((record) => record.key));
      return save(records);
    };

    const cache = await makeCache({ persistence: { adapter } });
    cache.set('session-secret', 'A');
    await cache.persistence.rotate('user-b');
    assert.equal(cache.persistence.generation, 'user-b');

    await cache.persistence.flush();
    assert.deepEqual(saves, [], 'the queued write of the old session never reached storage');
    assert.equal(adapter.rows.has('session-secret'), false);

    cache.set('fresh', 'B');
    await cache.persistence.flush();
    assert.deepEqual(saves, [['fresh']], 'only the new session writes');
    await cache.dispose();
  });

  it('blocks a stale in-flight write from leaking into the next session', async () => {
    const adapter = memoryAdapter();
    const saves = [];
    let gate = null;
    adapter.save = async (records) => {
      saves.push(records.map((record) => record.key));
      if (gate) {
        const held = gate;
        gate = null;
        await held.promise; // the write hangs mid-flight…
      }
      for (const record of records) adapter.rows.set(record.key, record);
    };

    const cache = await makeCache({ persistence: { adapter } });
    cache.set('secret', 'A');

    gate = deferred();
    const heldGate = gate; // save() nulls the shared `gate` when it consumes it
    const flushing = cache.flush();
    await delay(10); // …long enough for the pass to claim the queue and call save()
    await cache.persistence.rotate('user-b');
    heldGate.reject(new Error('stale write failed')); // …and then the old session's write fails

    await assert.doesNotReject(
      () => flushing,
      'the invalidated flush resolves instead of surfacing the dead session\u2019s error',
    );
    const stats = cache.persistence.stats();
    assert.equal(stats.aborted, 1, 'the pass is counted as aborted, not failed');
    assert.equal(stats.errors, 0, "the new session inherits no errors");

    cache.set('fresh', 'B');
    await cache.persistence.flush();
    assert.deepEqual(
      saves,
      [['secret'], ['fresh']],
      'the stale records were dropped — never requeued and rewritten under the new session',
    );
    assert.equal(adapter.rows.has('secret'), false);
    assert.equal(adapter.rows.get('fresh')?.value, 'B');
    await cache.dispose();
  });

  it('discards a hydrate that was in flight when the session changed', async () => {
    const rows = [];
    let gate = null;
    const adapter = {
      ...memoryAdapter(),
      load: async () => {
        if (gate) {
          const held = gate;
          gate = null;
          await held.promise;
        }
        return [...rows];
      },
    };
    Object.assign(adapter, { rows });

    const cache = await makeCache({ persistence: { adapter } }); // storage starts empty
    rows.push(storedRecord('old-user', 'secret')); // the previous account's data appears

    gate = deferred();
    const heldGate = gate; // load() nulls the shared `gate` when it consumes it
    const hydrating = cache.persistence.hydrate();
    await delay(10); // the load is now hanging mid-flight
    await cache.persistence.rotate('user-b');
    heldGate.resolve();

    await hydrating;
    assert.equal(cache.get('old-user'), undefined, 'stale records never reached memory');
    assert.equal(cache.persistence.stats().aborted, 1, 'and the discard is counted');
    await cache.dispose();
  });

  it('keeps each generation\u2019s rows isolated across a full logout/login cycle', async () => {
    freshIndexedDb();

    const first = await makeCache({
      persistence: { namespace: 'app', generation: 'user-a' },
    });
    first.set('account', 'A');
    await first.persistence.flush();

    await first.persistence.rotate('user-b'); // logout of A / login of B
    first.clear(); // the app drops the old session's memory
    first.set('account', 'B');
    await first.persistence.flush();
    await first.dispose();

    const againA = await makeCache({ persistence: { namespace: 'app', generation: 'user-a' } });
    assert.equal(againA.get('account'), 'A', 'user A finds exactly what they stored');
    await againA.dispose();

    const againB = await makeCache({ persistence: { namespace: 'app', generation: 'user-b' } });
    assert.equal(againB.get('account'), 'B', 'and so does user B');
    await againB.dispose();
  });

  it('makes a write that started before rotate() land in the previous generation\u2019s bucket', async () => {
    freshIndexedDb();

    const adapter = indexedDbPersistence({ namespace: 'app' });
    await adapter.save([storedRecord('kept', 'old-session')]);

    // The race itself: `save` snapshots its bucket on entry, `rotate` switches after.
    const pending = adapter.save([storedRecord('late', 'stale-value')]);
    adapter.rotate('user-b');
    await pending;

    assert.deepEqual(await adapter.keys(), [], 'the new generation sees nothing of the old one');
    assert.deepEqual(await adapter.load(), []);

    adapter.rotate(''); // back to the previous generation
    const keys = (await adapter.keys()).sort();
    assert.deepEqual(keys, ['kept', 'late'], 'the old rows — late write included — are intact');
    await adapter.close();
  });

  it('rejects a malformed rotation without changing anything', async () => {
    const cache = await makeCache({ persistence: { adapter: memoryAdapter() } });
    await assert.rejects(() => cache.persistence.rotate('bad\0generation'), RangeError);
    await assert.rejects(() => cache.persistence.rotate(42), TypeError);
    assert.equal(cache.persistence.generation, '', 'a rejected rotation changes nothing');
    assert.equal(cache.persistence.stats().rotations, 0);
    await cache.dispose();
  });
});

// ---------------------------------------------------------------------------
// Control API
// ---------------------------------------------------------------------------

describe('persistence control API', () => {
  it('flush() writes pending changes through the control surface', async () => {
    const adapter = memoryAdapter();
    const cache = await makeCache({ persistence: { adapter } });

    cache.set('k', 1);
    assert.equal(adapter.rows.size, 0, 'nothing is written before the flush');
    await cache.persistence.flush();
    assert.equal(adapter.rows.get('k')?.value, 1);
    await cache.dispose();
  });

  it('clear() empties storage and the queue without touching memory', async () => {
    const adapter = memoryAdapter();
    const cache = await makeCache({ persistence: { adapter } });

    cache.set('a', 1);
    cache.set('b', 2);
    await cache.persistence.flush();
    assert.equal(adapter.rows.size, 2, 'both start out persisted');

    cache.set('c', 3); // queued, never flushed
    await cache.persistence.clear();
    assert.equal(adapter.rows.size, 0, 'storage is empty');
    assert.equal(cache.persistence.stats().pending, 0, 'and so is the write queue');

    assert.equal(cache.get('a'), 1, 'memory keeps every entry');
    assert.equal(cache.get('c'), 3, 'even the one whose write was dropped');

    await cache.persistence.flush();
    assert.equal(adapter.rows.size, 0, 'the dropped queue never repopulates storage');

    cache.set('d', 4);
    await cache.persistence.flush();
    assert.deepEqual([...adapter.rows.keys()], ['d'], 'only post-clear writes are stored');
    await cache.dispose();
  });

  it('hydrate() reloads storage into memory without marking anything dirty', async () => {
    const adapter = memoryAdapter();
    adapter.rows.set('seeded', storedRecord('seeded', 'from storage'));
    const cache = await makeCache({ persistence: { adapter } });
    assert.equal(cache.get('seeded'), 'from storage', 'hydrated at create');

    cache.clear(); // memory only — storage keeps the row
    assert.equal(cache.get('seeded'), undefined);

    await cache.persistence.hydrate();
    assert.equal(cache.get('seeded'), 'from storage', 'the explicit hydrate restored it');
    assert.equal(cache.persistence.stats().hydrates, 2, 'create + one explicit run');

    const writtenBefore = cache.persistence.stats().recordsWritten;
    await cache.persistence.flush();
    assert.equal(
      cache.persistence.stats().recordsWritten,
      writtenBefore,
      'hydration is not a write: nothing was queued or rewritten',
    );
    assert.equal(adapter.rows.has('seeded'), true);
    await cache.dispose();
  });

  it('is inert on a cache created without persistence', async () => {
    const cache = await makeCache({ persistence: false });
    assert.equal(cache.persistence.enabled, false);
    assert.equal(cache.persistence.stats().enabled, false);
    await cache.persistence.flush();
    await cache.persistence.clear();
    await cache.persistence.hydrate();
    await cache.persistence.rotate('anyone');
    const stats = cache.persistence.stats();
    assert.equal(stats.rotations, 1, 'the calls are no-ops, not crashes');
    assert.equal(stats.generation, 'anyone');
    await cache.dispose();
  });
});

// ---------------------------------------------------------------------------
// Namespace isolation
// ---------------------------------------------------------------------------

describe('namespace isolation', () => {
  it('two caches in one database never see — or clear — each other\u2019s rows', async () => {
    freshIndexedDb();

    const a = await makeCache({ persistence: { namespace: 'ns-a' } });
    const b = await makeCache({ persistence: { namespace: 'ns-b' } });
    a.set('shared', 'A');
    b.set('shared', 'B');
    await a.persistence.flush();
    await b.persistence.flush();

    await a.persistence.clear();
    assert.deepEqual(await peekRows('ns-a'), {}, 'A wiped its own namespace');
    assert.deepEqual(await peekRows('ns-b'), { shared: 'B' }, "B's rows are untouched");
    assert.equal(b.get('shared'), 'B', "and B's memory too");

    const c = await makeCache({ persistence: { namespace: 'ns-a' } });
    assert.equal(c.get('shared'), undefined, 'a new cache in A starts empty');
    await c.dispose();
    await a.dispose();
    await b.dispose();
  });
});

// ---------------------------------------------------------------------------
// Schema versioning
// ---------------------------------------------------------------------------

describe('schema versioning', () => {
  it('adopts unversioned rows from before the schema stamp existed', async () => {
    freshIndexedDb();

    const seed = indexedDbPersistence({ namespace: 'legacy' });
    await seed.save([storedRecord('stamped', 'new')]);
    await seed.close();
    await rawPut([
      // No `v` field: written by a release that predates schema stamping.
      { id: 'legacy\0old', ns: 'legacy', key: 'old', value: 'from v0', tags: ['t'], ttlMs: null, storedAt: Date.now() },
    ]);

    const cache = await makeCache({ persistence: { namespace: 'legacy' } });
    assert.equal(cache.get('old'), 'from v0', 'the unversioned row was migrated, not dropped');
    assert.equal(cache.get('stamped'), 'new');
    assert.deepEqual(cache.tagsOf('old'), ['t'], 'with its payload intact');
    await cache.dispose();
  });

  it('resets the namespace — safely, loudly — when rows carry a newer schema', async () => {
    freshIndexedDb();

    const seed = indexedDbPersistence({ namespace: 'future' });
    await seed.save([storedRecord('current', 1)]);
    await seed.close();
    await rawPut([
      { id: 'future\0next', ns: 'future', key: 'next', value: 2, tags: [], ttlMs: null, storedAt: Date.now(), v: 99 },
    ]);

    const warns = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warns.push(args.map(String).join(' '));
    let cache;
    try {
      cache = await makeCache({ persistence: { namespace: 'future' } });
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(cache.get('current'), undefined, 'nothing is hydrated from an unknown schema');
    assert.equal(cache.get('next'), undefined);
    assert.ok(warns.some((warning) => warning.includes('newer schema')), 'and the reset is announced');
    assert.deepEqual(await peekRows('future'), {}, 'storage matches: the namespace is empty');
    await cache.dispose();
  });
});

// ---------------------------------------------------------------------------
// Write coalescing, write modes, batching
// ---------------------------------------------------------------------------

describe('write coalescing and batching', () => {
  it('coalesces repeated writes to one key inside the debounce window', async () => {
    const adapter = memoryAdapter();
    const saves = [];
    const save = adapter.save;
    adapter.save = async (records) => {
      saves.push(records.map((record) => [record.key, record.value]));
      return save(records);
    };

    const cache = await makeCache({ persistence: { adapter, debounceMs: 40 } });
    cache.set('k', 1);
    cache.set('k', 2);
    cache.set('k', 3);
    await delay(150); // one debounce window elapses

    assert.deepEqual(saves, [[['k', 3]]], 'one flush, one row, the final value');
    assert.equal(cache.persistence.stats().flushes, 1, 'and a single pass wrote it');
    await cache.dispose();
  });

  it('writeMode: "immediate" writes on the next task, ignoring the debounce window', async () => {
    const adapter = memoryAdapter();
    const cache = await makeCache({
      persistence: { adapter, writeMode: 'immediate', debounceMs: 60_000 },
    });

    cache.set('now', 1);
    await delay(40); // far below the 60 s window
    assert.equal(adapter.rows.has('now'), true, 'it did not wait out the debounce');
    await cache.dispose();
  });

  it('uses a combined write() as one batch, and clear+save as one transaction', async () => {
    // (a) an adapter that implements write() never sees save()/remove() directly.
    const adapter = memoryAdapter();
    const ops = [];
    let saveCalls = 0;
    const save = adapter.save;
    adapter.save = async (records) => {
      saveCalls += 1;
      return save(records);
    };
    adapter.write = async ({ clear = false, save: toSave = [], remove: toRemove = [] }) => {
      ops.push({ clear, save: toSave.map((record) => record.key), remove: toRemove });
      if (clear) adapter.rows.clear();
      for (const record of toSave) adapter.rows.set(record.key, record);
      for (const key of toRemove) adapter.rows.delete(key);
    };

    const cache = await makeCache({ persistence: { adapter } });
    cache.set('a', 1);
    await cache.persistence.flush();
    cache.delete('a');
    cache.set('b', 2);
    await cache.persistence.flush();

    assert.deepEqual(
      ops,
      [
        { clear: false, save: ['a'], remove: [] },
        { clear: false, save: ['b'], remove: ['a'] },
      ],
      'each flush is one batched call',
    );
    assert.equal(saveCalls, 0, 'the batched path replaced save() entirely');
    await cache.dispose();

    // (b) on the real adapter, a clear+save flush commits in a single transaction.
    freshIndexedDb();
    const originalTransaction = IDBDatabase.prototype.transaction;
    let transactions = 0;
    IDBDatabase.prototype.transaction = function patched(...args) {
      transactions += 1;
      return originalTransaction.apply(this, args);
    };
    try {
      const idbCache = await makeCache({ persistence: { namespace: 'batch' } });
      const afterCreate = transactions;

      idbCache.set('a', 1);
      await idbCache.persistence.flush();
      assert.equal(
        transactions - afterCreate,
        2, // one readonly reconciliation read + one readwrite batch
        'an ordinary flush costs two transactions',
      );

      const afterFirst = transactions;
      idbCache.clear(); // memory clear → the next flush must wipe storage…
      idbCache.set('b', 2); // …and write what came after it
      await idbCache.persistence.flush();
      assert.equal(
        transactions - afterFirst,
        1, // no reconciliation read after clear, and clear+save share one transaction
        'clear + save commit together instead of serialising',
      );
      assert.deepEqual((await peekRows('batch')), { b: 2 });
      await idbCache.dispose();
    } finally {
      IDBDatabase.prototype.transaction = originalTransaction;
    }
  });

  it('reuses one IndexedDB connection across every operation', async () => {
    freshIndexedDb();

    const factory = globalThis.indexedDB;
    const originalOpen = factory.open.bind(factory);
    let opens = 0;
    factory.open = (...args) => {
      opens += 1;
      return originalOpen(...args);
    };

    try {
      const cache = await makeCache({ persistence: { namespace: 'reuse' } });
      const afterCreate = opens;
      assert.ok(afterCreate >= 1, 'create opened the database');

      cache.set('k', 1);
      await cache.persistence.flush();
      cache.set('k', 2);
      await cache.persistence.flush();
      await cache.persistence.hydrate();
      await cache.persistence.clear();

      assert.equal(opens, afterCreate, 'every operation reused the single connection');
      await cache.dispose();
    } finally {
      factory.open = originalOpen;
    }
  });
});

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

describe('persistence observability', () => {
  it('onActivity sees hydrate, flush and rotate in order', async () => {
    const adapter = memoryAdapter();
    adapter.rows.set('pre', storedRecord('pre', 1));

    const activity = [];
    const cache = await makeCache({
      persistence: { adapter, onActivity: (event) => activity.push(event) },
    });
    cache.set('k', 2);
    await cache.persistence.flush();
    await cache.persistence.rotate('user-2');

    assert.deepEqual(
      activity.map((event) => event.type),
      ['hydrate-start', 'hydrate-finish', 'flush-start', 'flush-finish', 'rotate'],
    );
    assert.equal(activity[1].restored, 1, 'the hydrate reports what it restored');
    assert.equal(activity[1].skipped, 0);
    assert.equal(activity[3].records, 1, 'the flush reports what it wrote');
    assert.equal(activity[4].generation, 'user-2');
    await cache.dispose();
  });

  it('an onActivity observer that throws cannot break persistence', async () => {
    const adapter = memoryAdapter();
    const originalError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args);
    let cache;
    try {
      cache = await makeCache({
        persistence: { adapter, onActivity: () => { throw new Error('bad observer'); } },
      });
      cache.set('k', 1);
      await cache.persistence.flush();
      await cache.dispose(); // teardown flushes once more — keep that noise captured too
    } finally {
      console.error = originalError;
    }

    assert.equal(adapter.rows.get('k')?.value, 1, 'the write landed despite the observer');
    assert.ok(
      logged.some((args) => String(args[0]).includes('onActivity')),
      'the observer failure was logged, not swallowed silently',
    );
  });

  it('onError receives background flush failures instead of console.error', async () => {
    const adapter = memoryAdapter();
    let failures = 1;
    const save = adapter.save;
    adapter.save = async (records) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('disk full');
      }
      return save(records);
    };

    const received = [];
    const consoleErrors = [];
    const originalError = console.error;
    console.error = (...args) => consoleErrors.push(args);
    let cache;
    try {
      cache = await makeCache({ persistence: { adapter, debounceMs: 15, onError: (e) => received.push(e) } });
      cache.set('k', 1);
      await delay(80); // the debounced flush fails with nobody awaiting it
    } finally {
      console.error = originalError;
    }

    assert.equal(received.length, 1, 'onError heard the failure exactly once');
    assert.match(String(received[0]), /disk full/);
    assert.equal(consoleErrors.length, 0, 'onError replaced the default console reporting');

    const stats = cache.persistence.stats();
    assert.ok(stats.errors >= 1, 'and the failure is in the counters');
    assert.match(String(stats.lastError), /disk full/);

    await cache.persistence.flush(); // the queue survived: retry lands
    assert.equal(adapter.rows.get('k')?.value, 1, 'records were requeued, not lost');
    await cache.dispose();
  });

  it('stats() reflects pending work, counters and session state', async () => {
    const cache = await makeCache({ persistence: { adapter: memoryAdapter(), namespace: 'app' } });

    let stats = cache.persistence.stats();
    assert.equal(stats.enabled, true);
    assert.equal(stats.namespace, 'app');
    assert.equal(stats.generation, '');
    assert.equal(stats.pending, 0);

    cache.set('a', 1);
    cache.set('b', 2);
    stats = cache.persistence.stats();
    assert.equal(stats.pending, 2, 'queued writes are visible before they flush');

    await cache.persistence.flush();
    stats = cache.persistence.stats();
    assert.equal(stats.pending, 0);
    assert.equal(stats.flushes, 1);
    assert.equal(stats.recordsWritten, 2, 'the flush reports how many rows it wrote');

    cache.clear(); // supersedes any queued writes: storage will be emptied, not updated
    assert.equal(cache.persistence.stats().pending, 1, 'a pending full-clear counts as one');
    await cache.persistence.flush();
    assert.equal(cache.persistence.stats().pending, 0, 'and it is gone once flushed');

    await cache.persistence.rotate('user-1');
    stats = cache.persistence.stats();
    assert.equal(stats.flushes, 2, 'the clear counted as a flush too');
    assert.equal(stats.recordsWritten, 2, 'but wrote nothing of its own');
    assert.equal(stats.rotations, 1);
    assert.equal(stats.generation, 'user-1');
    assert.equal(stats.lastFlushAt !== null, true);
    assert.equal(stats.lastError, null);
    await cache.dispose();
  });
});

// ---------------------------------------------------------------------------
// Option validation
// ---------------------------------------------------------------------------

describe('persistence option validation', () => {
  it('rejects malformed options at create instead of misbehaving later', async () => {
    const adapter = memoryAdapter();

    await assert.rejects(
      () => makeCache({ persistence: { adapter, writeMode: 'later' } }),
      RangeError,
      'an unknown writeMode fails loudly',
    );
    await assert.rejects(
      () => makeCache({ persistence: { adapter, restoreExpired: 'yes' } }),
      RangeError,
      'a non-boolean restoreExpired fails loudly',
    );
    await assert.rejects(
      () => makeCache({ persistence: { adapter, debounceMs: Number.NaN } }),
      RangeError,
      'a NaN debounce fails loudly',
    );
    await assert.rejects(
      () => makeCache({ persistence: { adapter, maxEntries: 0 } }),
      RangeError,
      'maxEntries: 0 would persist everything (slice(-0) is the whole array)',
    );
    await assert.rejects(
      () => makeCache({ persistence: { adapter, debounceMs: 10, flushDelayMs: 20 } }),
      RangeError,
      'the two spellings of the debounce must agree',
    );
    await assert.rejects(
      () => makeCache({ persistence: { adapter, maxEntries: 5, maxRecords: 6 } }),
      RangeError,
      'the two spellings of the cap must agree',
    );
    await assert.rejects(
      () => makeCache({ persistence: { namespace: 'bad\0name' } }),
      RangeError,
      'a NUL in the namespace would make the key space unparseable',
    );
    await assert.rejects(
      () => makeCache({ persistence: { generation: 'bad\0generation' } }),
      RangeError,
      'same for a generation',
    );

    // Both spellings of the *same* value remain accepted — old configs keep working.
    const legacy = await makeCache({
      persistence: { adapter, flushDelayMs: 5, maxRecords: 10 },
    });
    await legacy.dispose();
    const modern = await makeCache({
      persistence: { adapter, debounceMs: 5, maxEntries: 10 },
    });
    await modern.dispose();
  });
});
