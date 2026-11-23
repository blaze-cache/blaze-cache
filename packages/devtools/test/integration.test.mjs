/** Devtools against the real wasm cache: snapshots, live events and clean teardown. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { createCache } from '@blaze-cache/core';
import { attach, detach, dispose } from '../dist/index.js';

const wasmBytes = await readFile(
  new URL('../../core/pkg/blaze_cache_wasm_bg.wasm', import.meta.url),
);

describe('integration with @blaze-cache/core', () => {
  it('snapshots a real cache that was created without indexes', async () => {
    dispose();
    const cache = await createCache({ wasm: wasmBytes, persistence: false });
    cache.set('user:1', { name: 'Ada' });
    const handle = attach(cache);
    try {
      const snapshot = handle.snapshot();
      assert.equal(snapshot.kind, 'snapshot');
      assert.equal(snapshot.payload.entries.length, 1);
      assert.equal(snapshot.payload.entries[0].key, 'user:1');
    } finally {
      handle.detach();
      await cache.dispose();
    }
  });

  it('reads a bounded snapshot through query() and follows real events', async () => {
    dispose();
    const cache = await createCache({ wasm: wasmBytes, indexes: true, capacity: 8 });
    cache.set('user:1', { name: 'Ada' }, { tags: ['user'] });
    cache.set('Authorization', 'secret-token');

    const handle = attach(cache, { label: 'live' });
    const seen = [];
    handle.onEvent((event) => seen.push(event));

    const snapshot = handle.snapshot({ maxEntries: 2 });
    assert.equal(snapshot.kind, 'snapshot');
    assert.equal(snapshot.payload.totalEntries, 2);
    const plain = snapshot.payload.entries.find((entry) => entry.key === 'user:1');
    assert.equal(plain.value.kind, 'object');
    assert.deepEqual(plain.tags, ['user']);
    const secret = snapshot.payload.entries.find((entry) => entry.key === '[redacted]');
    assert.equal(secret.value.kind, 'redacted');

    cache.set('user:2', { name: 'Grace' }, { tags: ['user'] });
    assert.ok(seen.some((event) => event.type === 'set' && event.key === 'user:2'));

    assert.equal(detach(handle), 1);
    // The core remains fully usable after the only wildcard listener is gone.
    cache.set('user:3', { name: 'Linus' });
    assert.equal(cache.get('user:3').name, 'Linus');
    await cache.dispose();
  });
});
