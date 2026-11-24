/** Devtools against the real wasm cache: snapshots, live events and clean teardown. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { createCache } from '@blaze-cache/core';
import { attach, detach, dispose, list } from '../dist/index.js';

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

  // Regression: the registry once held the unsub that `on()` returns, and that closure
  // retains the event bus — which retains the cache. An attached-but-undropped cache was
  // therefore pinned forever by `list()`'s module-level Map. Detach now goes through
  // `cache.off(listener)` instead, so nothing strongly reaches the cache from the registry.
  it(
    'does not pin a cache the caller has dropped',
    { skip: typeof globalThis.gc !== 'function' ? 'needs --expose-gc' : false },
    async () => {
      dispose();
      let finalized = false;
      const tracker = new FinalizationRegistry(() => {
        finalized = true;
      });
      // The cache lives only inside this scope: afterwards the sole paths to it are the
      // registry's WeakRef and the FinalizationRegistry's own weak registration.
      const handle = await (async () => {
        const cache = await createCache({ wasm: wasmBytes, persistence: false });
        cache.set('user:1', { name: 'Ada' });
        tracker.register(cache, 'dropped-cache');
        const attached = attach(cache, { label: 'leak' });
        assert.equal(attached.snapshot().payload.entries.length, 1, 'the attachment is live');
        return attached;
      })();
      assert.equal(handle.active, true);

      for (let i = 0; i < 20 && !finalized; i += 1) {
        globalThis.gc();
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(finalized, true, 'attach() must not retain a dropped cache');
      // The handle notices its cache is gone and prunes itself on the next sweep.
      assert.equal(list().length, 0);
      assert.equal(handle.active, false);
      dispose();
    },
  );
});
