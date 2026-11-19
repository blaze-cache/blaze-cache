/**
 * Regression guard for a CI-only race.
 *
 * This package's `test` script used to rebuild `@blaze-cache/core` unconditionally. Under
 * `pnpm -r test` that rewrote the shared `packages/core/dist/cache.js` while other packages'
 * `node --test` processes were importing it, so a reader could observe a half-written file
 * and fail with `does not provide an export named 'BlazeCache'`. The rebuild must stay
 * guarded by the dist's presence: core's own test script already builds it first.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('benchmark cache test script', () => {
  it('only rebuilds core when its dist is missing', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    assert.match(
      pkg.scripts.test,
      /test -f \.\.\/\.\.\/packages\/core\/dist\/index\.js \|\| pnpm --filter @blaze-cache\/core build/,
      'an unconditional core rebuild races with other pnpm -r test consumers of that dist',
    );
  });
});
