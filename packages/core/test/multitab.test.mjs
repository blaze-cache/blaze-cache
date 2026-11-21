/**
 * Stage 3: opt-in multi-tab synchronization.
 *
 * Node's global `BroadcastChannel` lets two real `BlazeCache` instances behave like two tabs —
 * same channel, separate wasm instances and value stores — without a browser. Every test uses a
 * unique channel name so parallel tests cannot hear one another.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createCache } from '@blaze-cache/core';

const wasmBytes = await readFile(new URL('../pkg/blaze_cache_wasm_bg.wasm', import.meta.url));
let channelSeq = 0;
const nextChannel = () => `blaze-test:${process.pid}:${++channelSeq}`;

const makeTab = (channel, options = {}) =>
  createCache({
    wasm: wasmBytes,
    capacity: 100,
    ...options,
    multiTab: { enabled: true, channel, ...(options.multiTab ?? {}) },
  });

/** Waits longer than a BroadcastChannel task turn so delivery is observable. */
const settle = () => delay(40);

const sharedStore = () => {
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

describe('multi-tab synchronization', () => {
  it('propagates set / delete / clear without echoing back', async () => {
    const channel = nextChannel();
    const a = await makeTab(channel);
    const b = await makeTab(channel);
    const aRemote = [];
    const bRemote = [];
    a.on((event) => {
      if (event.type.startsWith('remote-')) aRemote.push(event);
    });
    b.on((event) => {
      if (event.type.startsWith('remote-')) bRemote.push(event);
    });

    a.set('greeting', 'hello', { tags: ['demo'] });
    await settle();
    assert.equal(b.get('greeting'), 'hello', 'b received a');
    assert.deepEqual(b.tagsOf('greeting'), ['demo'], 'tags travelled too');
    assert.deepEqual(bRemote.map((e) => e.type), ['remote-set'], 'b saw one remote event');
    assert.deepEqual(aRemote, [], 'a did not echo its own write');

    a.delete('greeting');
    await settle();
    assert.equal(b.get('greeting'), undefined, 'delete propagated');
    assert.equal(bRemote.at(-1).type, 'remote-delete');

    a.set('one', 1);
    await settle();
    a.clear();
    await settle();
    assert.equal(b.size(), 0, 'clear propagated');
    assert.equal(bRemote.at(-1).type, 'remote-clear');

    await Promise.all([a.dispose(), b.dispose()]);
  });

  it('rejects a stale message and an old set after a newer clear', async () => {
    const channel = nextChannel();
    const a = await makeTab(channel);
    const b = await makeTab(channel);
    const stranger = new BroadcastChannel(channel);

    b.set('key', 'newest');
    await settle();
    stranger.postMessage({
      kind: 'set',
      key: 'key',
      value: 'stale',
      ttlMs: null,
      tags: [],
      clientId: 'stranger',
      seq: 1,
      version: { p: 1, l: 0, c: 'stranger', s: 1 },
    });
    await settle();
    assert.equal(b.get('key'), 'newest', 'an older version never overwrites a newer local value');

    // A clear from a peer establishes a newer epoch; a still-older set must be ignored.
    stranger.postMessage({
      kind: 'clear',
      clientId: 'stranger',
      seq: 2,
      version: { p: 2, l: 0, c: 'stranger', s: 2 },
    });
    await settle();
    stranger.postMessage({
      kind: 'set',
      key: 'key',
      value: 'ancient',
      ttlMs: null,
      tags: [],
      clientId: 'stranger',
      seq: 3,
      version: { p: 1, l: 9, c: 'stranger', s: 3 },
    });
    await settle();
    assert.equal(b.get('key'), undefined, 'a set older than the clear epoch is ignored');

    stranger.close();
    await Promise.all([a.dispose(), b.dispose()]);
  });

  it('propagates tag invalidation and generation rotation', async () => {
    const channel = nextChannel();
    const store = sharedStore();
    const a = await makeTab(channel, {
      persistence: { adapter: store, debounceMs: 0 },
    });
    const b = await makeTab(channel, {
      persistence: { adapter: store, debounceMs: 0 },
    });
    a.set('x', 1, { tags: ['drop'] });
    b.set('y', 2, { tags: ['drop'] });
    await settle();

    a.invalidateTags('drop');
    await settle();
    assert.equal(b.get('y'), undefined, 'b invalidated its own tagged entry');
    assert.equal(a.get('x'), undefined);

    await a.persistence.rotate('user-2');
    await settle();
    assert.equal(b.persistence.stats().generation, 'user-2', 'rotate reached b');
    b.on('remote-rotate', () => {}); // listener registration remains harmless after the fact

    await Promise.all([a.dispose(), b.dispose()]);
  });

  it('fixes the hidden-tab stale write: the hidden tab flushes the newest value', async () => {
    const channel = nextChannel();
    const store = sharedStore();
    const hidden = await makeTab(channel, {
      persistence: { adapter: store, debounceMs: 10_000 },
    });
    const focused = await makeTab(channel, {
      persistence: { adapter: store, debounceMs: 10_000 },
    });

    // Hidden tab writes first (queued but not flushed). Focused tab writes later; the
    // channel updates the hidden tab's queued record before its debounce fires.
    hidden.set('todo', { text: 'old', from: 'hidden' });
    await delay(10);
    focused.set('todo', { text: 'new', from: 'focused' });
    await settle();

    assert.deepEqual(hidden.get('todo'), { text: 'new', from: 'focused' });
    await hidden.flush(); // simulates the hidden-tab pagehide flush
    assert.deepEqual(store.rows.get('todo').value, { text: 'new', from: 'focused' });

    await Promise.all([hidden.dispose(), focused.dispose()]);
  });

  it('supports the invalidate strategy and non-cloneable fallbacks', async () => {
    const channel = nextChannel();
    const a = await makeTab(channel, { multiTab: { strategy: 'invalidate' } });
    const b = await makeTab(channel);
    a.set('refetch-me', { value: 1 });
    await settle();
    assert.equal(b.get('refetch-me'), undefined, 'invalidate sends only a tombstone');

    // With the default strategy a function cannot be structured-cloned; it must degrade to
    // an invalidate instead of throwing out of the local write.
    const channel2 = nextChannel();
    const c = await makeTab(channel2);
    const d = await makeTab(channel2);
    d.set('fn', () => 'not cloneable');
    await settle();
    assert.equal(d.size(), 1, 'the local write still succeeded');
    assert.equal(c.get('fn'), undefined, 'the peer treated it as a tombstone');

    await Promise.all([a.dispose(), b.dispose(), c.dispose(), d.dispose()]);
  });

  it('stops listening after dispose and leaves the default mode untouched', async () => {
    const channel = nextChannel();
    const a = await makeTab(channel);
    const b = await makeTab(channel);
    const seen = [];
    a.on((event) => {
      if (event.type.startsWith('remote-')) seen.push(event);
    });
    await a.dispose();

    b.set('after-dispose', 1);
    await settle();
    assert.deepEqual(seen, [], 'a disposed tab cannot be written to');

    // No multiTab option at all: no channel, no remote events, identical behaviour.
    const plain = await createCache({ wasm: wasmBytes, capacity: 4 });
    const events = [];
    plain.on((event) => events.push(event.type));
    plain.set('k', 1);
    assert.equal(plain.get('k'), 1);
    assert.deepEqual(events.filter((type) => type !== 'hit'), ['set'], 'no remote event without multiTab');
    await plain.dispose();
    await b.dispose();
  });
});
