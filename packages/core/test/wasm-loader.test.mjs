/**
 * Loader tests for `@blaze-cache/core`: where the `.wasm` comes from, and what happens
 * when it does not arrive.
 *
 * Node cannot `fetch()` a `file:` URL, so the default path and `wasmUrl` are exercised
 * against a local HTTP server serving the real binary — which also lets these tests count
 * requests and prove the singleton really is *one* load. The wasm initialises once per
 * process, so the failure cases come first (each one resets the loader) and the successful
 * load comes last; this file runs in its own process, alongside `wasm-module` and
 * `wasm-instantiate`, which cover the other two sources.
 *
 *   pnpm --filter @blaze-cache/core test
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, describe, it } from 'node:test';

import { BlazeCache, createCache } from '@blaze-cache/core';

const wasmBytes = await readFile(new URL('../pkg/blaze_cache_wasm_bg.wasm', import.meta.url));

/** A wasm module with no imports, for the one instance the loader must refuse to adopt. */
const emptyModule = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));

/** Requests answered with the real binary — the only ones that count as a load. */
let served = 0;

const server = createServer((req, res) => {
  switch (req.url) {
    case '/wasm.wasm':
      served += 1;
      res.writeHead(200, { 'content-type': 'application/wasm' });
      res.end(wasmBytes);
      break;
    case '/corrupt.wasm':
      res.writeHead(200, { 'content-type': 'application/wasm' });
      res.end('this is not a wasm module');
      break;
    case '/missing.wasm':
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not here');
      break;
    default:
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

describe('wasm loading', () => {
  it('refuses to guess when two sources are given', async () => {
    await assert.rejects(
      () => createCache({ wasmUrl: `${origin}/wasm.wasm`, module: emptyModule }),
      (error) => {
        assert.ok(error instanceof TypeError, 'a bad option list is a programming error');
        assert.match(error.message, /pass at most one wasm source/);
        assert.match(error.message, /`wasmUrl` and `module`/);
        assert.match(error.message, /`instantiate`/, 'the message lists the alternatives');
        return true;
      },
    );
  });

  it('rejects an instance handed back by `instantiate`', async () => {
    await assert.rejects(
      () =>
        createCache({
          instantiate: async () => new WebAssembly.Instance(emptyModule, {}),
        }),
      (error) => {
        assert.match(error.message, /must resolve to a \*source\*/);
        assert.match(error.message, /WebAssembly\.Instance/);
        assert.match(error.message, /import object/, 'it says why, not just what');
        return true;
      },
    );
  });

  it('rejects an exports object handed back by `instantiate`', async () => {
    await assert.rejects(
      () => createCache({ instantiate: async () => ({ blazecache_new() {} }) }),
      /must resolve to a \*source\*/,
    );
  });

  it('fails with the URL and the status when the asset is missing', async () => {
    await assert.rejects(
      () => createCache({ wasmUrl: `${origin}/missing.wasm` }),
      (error) => {
        assert.match(error.message, /HTTP 404 Not Found/);
        assert.match(error.message, /missing\.wasm/, 'the message names the URL');
        assert.match(error.message, /`wasmUrl`/, 'and what to try instead');
        return true;
      },
    );
  });

  it('fails with the reason when the server cannot be reached', async () => {
    await assert.rejects(
      () => createCache({ wasmUrl: 'http://127.0.0.1:1/wasm.wasm' }),
      (error) => {
        assert.match(error.message, /could not fetch the WebAssembly binary/);
        assert.match(error.message, /`wasmUrl`/);
        assert.ok(error.cause, 'the original fetch error stays on `cause`');
        return true;
      },
    );
  });

  it('fails when the bytes are not a wasm module', async () => {
    await assert.rejects(
      () => createCache({ wasmUrl: `${origin}/corrupt.wasm` }),
      (error) => {
        assert.match(error.message, /failed to instantiate the WebAssembly binary/);
        assert.ok(error.cause, 'the compile error stays on `cause`');
        return true;
      },
    );
  });

  it('fails clearly on the default path outside a browser', async () => {
    // The default resolves `../pkg/*.wasm` relative to this module — a `file:` URL, which
    // Node's `fetch` refuses. The point is that it says so instead of hanging.
    await assert.rejects(
      () => createCache(),
      (error) => {
        assert.match(error.message, /could not fetch the WebAssembly binary/);
        assert.match(error.message, /blaze_cache_wasm_bg\.wasm/);
        return true;
      },
    );
  });

  it('loads once from a custom wasmUrl, whatever the concurrency', async () => {
    const before = served;
    const caches = await Promise.all([
      createCache({ wasmUrl: `${origin}/wasm.wasm`, capacity: 4 }),
      createCache({ wasmUrl: `${origin}/wasm.wasm`, capacity: 4 }),
      createCache({ wasmUrl: `${origin}/wasm.wasm`, capacity: 4 }),
    ]);

    assert.equal(served - before, 1, 'three concurrent creates share one download');

    for (const cache of caches) {
      assert.ok(cache instanceof BlazeCache);
      cache.set('k', 1);
      assert.equal(cache.get('k'), 1);
      await cache.dispose();
    }
  });

  it('keeps the first source: later creates neither fetch nor fail', async () => {
    const before = served;
    const cache = await createCache({ wasmUrl: `${origin}/missing.wasm`, capacity: 4 });

    assert.equal(served, before, 'the first load already won');
    cache.set('later', true);
    assert.equal(cache.get('later'), true);
    await cache.dispose();
  });
});
