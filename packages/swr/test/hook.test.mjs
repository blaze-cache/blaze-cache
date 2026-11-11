/**
 * Regression guards for `useBlazeSWR`'s option plumbing — the hook itself, which the
 * main suite deliberately does not render (a hook needs a DOM renderer this repo does
 * not carry). `swr`'s `useSWR` is replaced with a capture stub via a module mock
 * (`--experimental-test-module-mocks`, wired into the package's `test` script), so the
 * exact config the hook hands to SWR can be asserted without React at all.
 *
 * The mock matters because of how SWR composes: an `SWRConfig` provider's values are
 * merged into this very config object (hook-level options win the merge), and only then
 * does the middleware read `config.ttlMs ?? options.ttlMs ?? default`. A stamp stripped
 * out of the config on its way in would therefore be shadowed by any provider-level
 * `ttlMs`/`tags` before the middleware ever sees it.
 *
 *   pnpm --filter @blaze-cache/swr test
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it, mock } from 'node:test';

import { unstable_serialize } from 'swr'; // the real module — loaded before any mock

import { createCache } from '@blaze-cache/core';

const wasmBytes = await readFile(
  new URL('../../core/pkg/blaze_cache_wasm_bg.wasm', import.meta.url),
);

/** What the mocked `useSWR` was last called with — filled by every hook call below. */
const captured = {};

describe('useBlazeSWR option plumbing', () => {
  it('passes the per-call stamp into the config SWR merges provider values into', async () => {
    mock.module('swr', {
      defaultExport: (key, fetcher, config) => {
        captured.key = key;
        captured.fetcher = fetcher;
        captured.config = config;
        return {
          data: undefined,
          error: undefined,
          isValidating: false,
          isLoading: false,
          mutate: () => {},
        };
      },
      // `unstable_serialize` for the key module, `mutate` for `invalidateBlazeSWR` —
      // both are value imports of the package under test.
      namedExports: { unstable_serialize, mutate: async () => undefined },
    });

    // First import in this process — its `swr` links resolve against the mock above.
    const { useBlazeSWR } = await import('@blaze-cache/swr');
    const cache = await createCache({ wasm: wasmBytes, persistence: false });
    const fetcher = async () => 'data';

    useBlazeSWR(cache, '/api/todos', fetcher, {
      ttlMs: 5_000,
      tags: ['call'],
      revalidateOnFocus: false,
    });

    assert.ok(captured.config, 'the hook reached useSWR');
    assert.equal(captured.config.ttlMs, 5_000, 'the per-call ttlMs is in the SWR config');
    assert.deepEqual(captured.config.tags, ['call'], 'the per-call tags are in the SWR config');
    assert.equal(captured.config.revalidateOnFocus, false, 'ordinary SWR options pass through');
    assert.equal(typeof captured.config.use[0], 'function', 'the Blaze middleware is installed');

    await cache.dispose();
  });

  it('carries forceRefresh and a tags resolver into that same config', async () => {
    // Same module instance as above — already linked against the mock — so a second
    // import is enough; no new mock, no real `swr` anywhere in this process.
    const { useBlazeSWR } = await import('@blaze-cache/swr');
    const cache = await createCache({ wasm: wasmBytes, persistence: false });
    const tags = (key, data) => ['user', `user:${data.id}`];

    useBlazeSWR(cache, '/api/users/7', async () => ({ id: 7 }), {
      forceRefresh: true,
      tags,
    });

    assert.equal(captured.config.forceRefresh, true, 'forceRefresh is in the SWR config');
    assert.equal(captured.config.tags, tags, 'a tags resolver passes through untouched');
    assert.equal(typeof captured.config.use[0], 'function', 'the Blaze middleware is installed');

    await cache.dispose();
  });
});
