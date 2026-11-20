/**
 * The browser page imports the cache suite's harness and stores verbatim. A stray `node:`
 * import in any of those shared modules would make Vite fail at build time — loudly here,
 * instead of halfway through a published benchmark run.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const SHARED = [
  '../../cache/harness.mjs',
  '../../cache/payloads.mjs',
  '../../cache/runner.mjs',
  '../../cache/scenarios.mjs',
  '../../cache/stores.mjs',
  '../../cache/adapters.browser.mjs',
];

describe('browser benchmark shared modules', () => {
  for (const file of SHARED) {
    it(`${file} has no Node-only imports`, async () => {
      const source = await readFile(new URL(file, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /from ['"]node:/, `${file} must run in a browser too`);
    });
  }
});
