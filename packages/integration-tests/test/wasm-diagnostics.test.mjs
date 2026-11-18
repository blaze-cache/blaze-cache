/**
 * Tests for the wasm failure diagnostics themselves.
 *
 * A diagnostic helper that throws while reporting a wasm failure would hide the very error
 * it was meant to explain, so this file pins the reporting path with synthetic failures.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeError, instrumentCache, logWasmFailure } from './wasm-diagnostics.mjs';

/** Runs `fn` with console.error captured, restoring it even when `fn` throws. */
function captureErrorLog(fn) {
  const original = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  try {
    fn();
  } finally {
    console.error = original;
  }
  return logs;
}

describe('wasm failure diagnostics', () => {
  it('describes the whole cause chain', () => {
    const root = new TypeError('root cause');
    const wrapper = new Error('outer failure', { cause: root });
    assert.equal(
      describeError(wrapper),
      'Error: outer failure <- caused by TypeError: root cause',
    );
    assert.equal(describeError('a string'), 'Error: a string');
  });

  it('logs a structured report without throwing on a malformed error', () => {
    const logs = captureErrorLog(() => {
      logWasmFailure('unit probe', new Error('boom', { cause: new Error('inner') }), {
        stage: 'probe',
      });
      logWasmFailure('odd error', { message: 'not an Error' });
    });

    assert.equal(logs.length, 2);
    assert.match(logs[0][0], /wasm failure during unit probe/);
    assert.match(logs[0][0], /caused by Error: inner/);
    assert.equal(logs[0][1].node, process.version);
    assert.equal(logs[0][1].stage, 'probe');
    assert.equal(logs[0][1].bytes, null, 'no binary loaded by this test file');
    assert.match(logs[1][0], /wasm failure during odd error/);
  });

  it('logs the failing wasm method and rethrows the original error', () => {
    const boom = new Error('RuntimeError: unreachable');
    const target = {
      ok() {
        return 42;
      },
      trap(arg) {
        throw boom;
      },
    };
    const logs = captureErrorLog(() => {
      const cache = instrumentCache(target);
      assert.equal(cache.ok(), 42);
      assert.equal(cache.constructor, Object);
      assert.throws(() => cache.trap('a'.repeat(200)), (error) => error === boom);
    });

    assert.equal(logs.length, 1, 'successful calls stay silent');
    assert.match(logs[0][0], /wasm failure during cache\.trap/);
    assert.equal(logs[0][1].args[0], `${'a'.repeat(117)}…`, 'long arguments are truncated');
  });
});
