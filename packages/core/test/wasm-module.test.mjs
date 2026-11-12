/**
 * The `module` source: a precompiled `WebAssembly.Module` handed straight to the loader.
 *
 * There is no server in this file — if the loader tried to fetch anything it would fail —
 * which is exactly the point of the option: no network, no compile, instant start.
 *
 *   pnpm --filter @blaze-cache/core test
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { BlazeCache, createCache } from '@blaze-cache/core';

const wasmBytes = await readFile(new URL('../pkg/blaze_cache_wasm_bg.wasm', import.meta.url));

describe('a precompiled module', () => {
  it('instantiates without touching the network', async () => {
    const module = await WebAssembly.compile(wasmBytes);

    const cache = await createCache({ module, capacity: 4 });
    assert.ok(cache instanceof BlazeCache);
    cache.set('k', 'v');
    assert.equal(cache.get('k'), 'v');
    await cache.dispose();
  });

  it('builds a second, independent cache on the same module', async () => {
    const module = await WebAssembly.compile(wasmBytes);
    const first = await createCache({ module, capacity: 3 });
    const second = await createCache({ module, capacity: 3 });

    assert.equal(first.capacity(), 3, 'each create still builds its own cache');
    assert.equal(second.capacity(), 3);

    first.set('only-mine', true);
    assert.equal(second.get('only-mine'), undefined, 'caches do not share entries');

    await first.dispose();
    await second.dispose();
  });
});
