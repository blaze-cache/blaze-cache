/**
 * The `instantiate` source: a custom loader that decides for itself what the wasm comes
 * from, while the package still does the linking and registers the instance.
 *
 * The hook resolves to bytes here — the shape the docs recommend (`(await fetch(url,
 * { headers })).arrayBuffer()`). A `Response` is covered by the default path in
 * `wasm-loader.test.mjs`, which fetches and hands one to the same pipeline; a
 * `WebAssembly.Instance` is rejected there too, because wasm-bindgen's glue has to create
 * the instance itself.
 *
 *   pnpm --filter @blaze-cache/core test
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { BlazeCache, createCache } from '@blaze-cache/core';

const wasmBytes = await readFile(new URL('../pkg/blaze_cache_wasm_bg.wasm', import.meta.url));

describe('a custom `instantiate` loader', () => {
  it('runs once for concurrent creates and produces a working cache', async () => {
    let calls = 0;
    const makeCache = () =>
      createCache({
        capacity: 4,
        instantiate: async () => {
          calls += 1;
          await new Promise((resolve) => setTimeout(resolve, 5)); // a deliberately slow loader
          return wasmBytes;
        },
      });

    const [a, b] = await Promise.all([makeCache(), makeCache()]);
    assert.equal(calls, 1, 'the hook is one load, not one per cache');

    for (const cache of [a, b]) {
      assert.ok(cache instanceof BlazeCache);
      cache.set('k', 1);
      assert.equal(cache.get('k'), 1);
      await cache.dispose();
    }
  });

  it('never runs again once the module is loaded', async () => {
    let calls = 0;
    await createCache({
      instantiate: async () => {
        calls += 1;
        return wasmBytes;
      },
    });
    assert.equal(calls, 0, 'the first load already won');
  });
});
