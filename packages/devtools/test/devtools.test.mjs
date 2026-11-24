/** 0.5.0-beta.1 devtools unit tests: registry, protocol, summarizer, snapshot, zero cost. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEVTOOLS_PROTOCOL,
  EventFeed,
  attach,
  buildSnapshot,
  createEnvelope,
  detach,
  dispose,
  isBlazeRecord,
  isDevtoolsEnvelope,
  isSupportedEnvelope,
  list,
  onEvent,
  summarize,
} from '../dist/index.js';

/** Minimal structural cache double: no wasm, no IndexedDB, observable listener count. */
function fakeCache(overrides = {}) {
  const values = new Map();
  for (const [key, value] of Object.entries(overrides.values ?? {})) {
    const meta = overrides.meta?.[key] ?? {};
    values.set(key, { key, value, ttlMs: meta.ttlMs ?? null, tags: meta.tags ?? [] });
  }
  const listeners = new Set();
  let onCalls = 0;
  let offCalls = 0;
  const cache = {
    listenerCount: () => listeners.size,
    onCalls: () => onCalls,
    offCalls: () => offCalls,
    on(listener) {
      onCalls += 1;
      listeners.add(listener);
      return () => {
        offCalls += 1;
        listeners.delete(listener);
      };
    },
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    set(key, value, meta = {}) {
      values.set(key, { key, value, ttlMs: meta.ttlMs ?? null, tags: meta.tags ?? [] });
    },
    stats: () => ({
      hits: 3,
      misses: 1,
      evictions: 0,
      expirations: 0,
      invalidations: 0,
      size: values.size,
      capacity: 100,
      hitRate: 0.75,
    }),
    size: () => values.size,
    capacity: () => 100,
    keys: () => [...values.keys()],
    entry: (key) => values.get(key),
    entries: () => [...values.values()],
    ttl: (key) => values.get(key)?.ttlMs,
    tagsOf: (key) => values.get(key)?.tags ?? [],
    peek: (key) => values.get(key)?.value,
    persistence: { stats: () => ({ enabled: true, pending: 2, flushes: 4 }) },
    ...overrides.extra,
  };
  return cache;
}

describe('protocol', () => {
  it('stamps version, ids and time, and ignores unknown messages', () => {
    const envelope = createEnvelope('client-1', 'cache-1', 'event', { type: 'set' }, 'tab-1', 42);
    assert.deepEqual(envelope, {
      protocol: DEVTOOLS_PROTOCOL,
      tabId: 'tab-1',
      clientId: 'client-1',
      cacheId: 'cache-1',
      ts: 42,
      kind: 'event',
      payload: { type: 'set' },
    });
    assert.equal(isDevtoolsEnvelope(envelope), true);
    assert.equal(isSupportedEnvelope(envelope), true);
    assert.equal(isSupportedEnvelope({ ...envelope, protocol: 999 }), false);
    assert.equal(isSupportedEnvelope({ ...envelope, kind: 'future-kind' }), false);
    assert.equal(isDevtoolsEnvelope(null), false);
  });
});

describe('summarizer', () => {
  it('never throws on hostile, cyclic and exotic values', () => {
    const cyclic = { name: 'root' };
    cyclic.self = cyclic;
    const hostile = {
      get bomb() {
        throw new Error('boom');
      },
      safe: 1,
    };
    const values = [
      undefined,
      null,
      42,
      'text',
      10n,
      Symbol('s'),
      () => 1,
      new Map([['a', 1]]),
      new Set([1, 2]),
      new ArrayBuffer(8),
      new Uint8Array([1, 2, 3]),
      cyclic,
      hostile,
      new Date('2020-01-01T00:00:00.000Z'),
      new Error('oops'),
    ];
    for (const value of values) {
      const summary = summarize(value);
      assert.ok(summary && typeof summary.kind === 'string');
    }
    assert.equal(summarize(cyclic).kind, 'object');
    assert.equal(summarize(cyclic).entries.find(([key]) => key === 'self')[1].kind, 'cycle');
    assert.equal(summarize(new Map([['a', 1]])).kind, 'map');
    assert.equal(summarize(new Uint8Array([1])).kind, 'view');
    assert.equal(summarize(10n).kind, 'bigint');
    assert.equal(summarize(new Date()).kind, 'date');
  });

  it('displays BlazeRecord envelopes without expanding data', () => {
    const record = { kind: 'next:route', v: 2, data: { nested: { secret: true } }, storedAt: 1 };
    assert.equal(isBlazeRecord(record), true);
    const summary = summarize(record);
    assert.equal(summary.kind, 'blaze-record');
    assert.equal(summary.framework, 'next');
    assert.equal(summary.recordKind, 'next:route');
    assert.ok(!JSON.stringify(summary).includes('secret'));
  });

  it('honours value modes and caps', () => {
    assert.equal(summarize({ a: 1 }, { valueMode: 'none' }).kind, 'redacted');
    const full = summarize({ a: 1 }, { valueMode: 'full' });
    assert.equal(full.kind, 'full');
    assert.deepEqual(full.value, { a: 1 });
    const deep = summarize({ a: { b: { c: { d: { e: 1 } } } } }, { maxDepth: 1 });
    assert.equal(deep.entries[0][1].kind, 'truncated');
    const wide = summarize(
      Array.from({ length: 100 }, (_, i) => i),
      { maxEntries: 3 },
    );
    assert.equal(wide.items.length, 3);
    assert.equal(wide.truncated, 'entries');
  });

  it('redacts nested credential keys in objects and Maps', () => {
    const nested = summarize({
      user: 'ada',
      password: 'hunter2',
      config: { api_key: 'sk-live-123', endpoint: 'https://example.test' },
    });
    const json = JSON.stringify(nested);
    assert.ok(!json.includes('hunter2'), 'a nested secret value must not appear');
    assert.ok(!json.includes('sk-live-123'), 'a nested api key must not appear');
    assert.equal(nested.entries.find(([key]) => key === 'user')[1].kind, 'string');
    const redacted = nested.entries.filter(([key]) => key === '[redacted]');
    assert.equal(redacted.length, 1, 'the credential property itself is hidden');
    assert.equal(redacted[0][1].kind, 'redacted');
    assert.equal(
      nested.entries
        .find(([key]) => key === 'config')[1]
        .entries.find(([key]) => key === '[redacted]')[1].kind,
      'redacted',
      'redaction applies at every depth',
    );

    const map = summarize(
      new Map([
        ['password', 'hunter2'],
        ['theme', 'dark'],
      ]),
    );
    assert.ok(!JSON.stringify(map).includes('hunter2'), 'a Map keyed by a secret leaks nothing');
    assert.equal(map.entries[0][0].kind, 'redacted');
    assert.equal(map.entries[0][1].kind, 'redacted');
    assert.equal(map.entries[1][1].kind, 'string', 'innocent entries stay visible');
  });

  it('never throws on Proxy traps, getters or hostile redaction patterns', () => {
    const hostile = [
      new Proxy(
        {},
        {
          get() {
            throw new Error('get-bomb');
          },
        },
      ),
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('keys-bomb');
          },
        },
      ),
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error('proto-bomb');
          },
        },
      ),
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw new Error('desc-bomb');
          },
        },
      ),
      new Proxy(
        {},
        {
          get(target, key) {
            if (key === 'bomb') throw new Error('getter-bomb');
            return 1;
          },
        },
      ),
      Object.create(null, {
        constructor: {
          get() {
            throw new Error('ctor-bomb');
          },
        },
      }),
    ];
    for (const value of hostile) {
      for (const valueMode of ['summary', 'full', 'none']) {
        const summary = summarize(value, { valueMode });
        assert.ok(summary && typeof summary.kind === 'string');
        assert.ok(!JSON.stringify(summary).includes('bomb'), `${valueMode} mode trapped a value`);
      }
    }

    // A hostile pattern list must degrade to an opaque summary, not a thrown TypeError.
    const patterns = new Proxy([], {
      get() {
        throw new Error('patterns-bomb');
      },
    });
    const summary = summarize({ plain: 1 }, { redactKeys: patterns });
    assert.equal(summary.kind, 'unsupported');
  });
});

describe('event feed', () => {
  it('caps the ring buffer and isolates throwing subscribers', () => {
    const feed = new EventFeed('client-x', 3);
    const seen = [];
    feed.onEvent((event) => seen.push(event.type));
    feed.onEvent(() => {
      throw new Error('bad UI listener');
    });
    for (const type of ['set', 'get', 'delete', 'clear']) feed.push(type, 'k');
    assert.deepEqual(
      feed.events().map((event) => event.type),
      ['get', 'delete', 'clear'],
    );
    assert.deepEqual(seen, ['set', 'get', 'delete', 'clear']);
    assert.equal(feed.events()[0].clientId, 'client-x');
  });
});

describe('registry and zero-cost lifecycle', () => {
  it('attaches one listener and restores prior state on detach', () => {
    dispose();
    const cache = fakeCache();
    cache.set('a', { x: 1 }, { tags: ['t'] });
    const handle = attach(cache, { label: 'test' });
    assert.equal(cache.onCalls(), 1);
    assert.equal(cache.listenerCount(), 1);
    assert.equal(list().length, 1);
    assert.equal(attach(cache), handle, 'attaching twice is idempotent');
    assert.equal(cache.onCalls(), 1);

    const seen = [];
    handle.onEvent((event) => seen.push(event));
    cache.emit({ type: 'set', key: 'a' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].key, 'a');
    // 'key' in event guard: no key field means no ghost attribution.
    cache.emit({ type: 'clear' });
    assert.equal(seen[1].key, undefined);

    handle.detach();
    assert.equal(cache.offCalls(), 1);
    assert.equal(cache.listenerCount(), 0);
    assert.equal(list().length, 0);
    cache.emit({ type: 'set', key: 'a' });
    assert.equal(seen.length, 2, 'no events after detach');
    assert.equal(handle.active, false);
    handle.detach(); // idempotent
    assert.equal(cache.offCalls(), 1);
  });

  it('supports cache-based detach, dispose and global subscriptions', () => {
    dispose();
    const a = fakeCache();
    const b = fakeCache();
    attach(a);
    attach(b);
    const global = [];
    const off = onEvent((event) => global.push(event));
    a.emit({ type: 'hit', key: 'a' });
    assert.equal(global.length, 1);
    off();
    assert.equal(detach(a), 1);
    assert.equal(a.listenerCount(), 0);
    assert.equal(b.listenerCount(), 1);
    assert.equal(list().length, 1);
    dispose();
    assert.equal(b.listenerCount(), 0);
    assert.equal(list().length, 0);
  });

  it('importing and querying the registry creates no listeners or snapshots', () => {
    dispose();
    assert.equal(list().length, 0);
    const cache = fakeCache();
    assert.equal(cache.onCalls(), 0);
    assert.equal(cache.listenerCount(), 0);
  });

  it('rejects conflicting options on a live re-attach', () => {
    dispose();
    const cache = fakeCache();
    const handle = attach(cache, { label: 'one' });
    assert.equal(attach(cache, { label: 'one' }), handle, 'identical options stay idempotent');
    assert.equal(attach(cache), handle, 'an empty re-attach keeps the live options');
    assert.equal(
      attach(cache, { maxEvents: 500 }),
      handle,
      'restating a default is not a conflict',
    );
    assert.throws(() => attach(cache, { label: 'two' }), /detach\(\) first/);
    assert.throws(() => attach(cache, { valueMode: 'full' }), /detach\(\) first/);
    assert.throws(() => attach(cache, { redactKeys: [] }), /detach\(\) first/);
    assert.equal(cache.onCalls(), 1, 'a rejected re-attach registers no listener');

    handle.detach();
    const fresh = attach(cache, { label: 'two' });
    assert.equal(fresh.label, 'two', 'options apply again after detach');
    fresh.detach();
  });
});

describe('snapshot builder', () => {
  it('summarizes, redacts, caps and reports truncation', () => {
    dispose();
    const cache = fakeCache({
      values: {
        authorization: 'supersecret',
        plain: { nested: [1, 2, 3] },
      },
    });
    const handle = attach(cache, { label: 'snap' });
    const snapshot = handle.snapshot({ maxEntries: 1, maxValueBytes: 10_000 });
    assert.equal(snapshot.kind, 'snapshot');
    assert.equal(snapshot.protocol, 1);
    assert.equal(snapshot.payload.label, 'snap');
    assert.equal(snapshot.payload.stats.hits, 3);
    assert.equal(snapshot.payload.size, 2);
    assert.equal(snapshot.payload.entries.length, 1);
    assert.equal(snapshot.payload.entries[0].key, '[redacted]');
    assert.equal(snapshot.payload.entries[0].value.kind, 'redacted');
    assert.equal(snapshot.payload.truncated.entries, true);
    assert.equal(snapshot.payload.persistence.pending, 2);

    const tiny = handle.snapshot({ maxValueBytes: 1 });
    assert.equal(tiny.payload.entries.length, 0);
    assert.equal(tiny.payload.truncated.bytes, true);
    handle.detach();
  });

  it('redacts the persistence generation and last error', () => {
    dispose();
    const cache = fakeCache({
      extra: {
        persistence: {
          stats: () => ({
            enabled: true,
            namespace: 'app',
            generation: 'user-42',
            pending: 1,
            errors: 2,
            lastError: new Error('flush failed: /db?token=abc'),
          }),
        },
      },
    });
    const snapshot = buildSnapshot(cache, { cacheId: 'c', clientId: 'cl' });
    assert.equal(snapshot.payload.persistence.generation, '[redacted]');
    assert.equal(snapshot.payload.persistence.lastError, '[redacted]');
    assert.equal(snapshot.payload.persistence.pending, 1, 'the rest of the stats survive');
    const json = JSON.stringify(snapshot);
    assert.ok(!json.includes('user-42'), 'the session generation must not be exported');
    assert.ok(!json.includes('token=abc'), 'the error text must not be exported');
  });

  it('uses the indexed query API when the cache provides it', () => {
    const queried = [];
    const cache = fakeCache({
      extra: {
        query(filter) {
          queried.push(filter);
          return { items: [{ key: 'a', ttlMs: null, tags: [] }], nextCursor: null, total: 1 };
        },
      },
    });
    const snapshot = buildSnapshot(cache, { cacheId: 'c', clientId: 'cl' });
    assert.equal(queried.length, 1);
    assert.equal(snapshot.payload.totalEntries, 1);
    assert.deepEqual(snapshot.payload.entries[0].key, 'a');
  });
});
