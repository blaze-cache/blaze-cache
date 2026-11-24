/** The wasm-free, server-safe `@blaze-cache/core/shared` contract (0.5.0-beta.1). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  REDACT_KEY_PATTERNS,
  bindingFromKind,
  featureFromKind,
  isBlazeRecord,
  isRedactedKey,
  makeBlazeKind,
} from '@blaze-cache/core/shared';

describe('@blaze-cache/core/shared', () => {
  it('holds the frozen, wasm-free redaction + envelope contract', () => {
    assert.ok(isRedactedKey('Authorization-Token'));
    assert.ok(REDACT_KEY_PATTERNS.length > 0);
    assert.equal(isRedactedKey('user:42'), false);

    const record = { kind: 'next:route', v: 7, data: { x: 1 }, storedAt: 123 };
    assert.equal(isBlazeRecord(record), true);
    assert.equal(isBlazeRecord({ kind: 'x', v: 1, storedAt: 1 }), false); // no data field
    assert.equal(makeBlazeKind('next', 'route'), 'next:route');
    assert.equal(bindingFromKind('next:route'), 'next');
    assert.equal(featureFromKind('next:route'), 'route');
  });

  it('never throws on frozen, stateful or hostile patterns — and fails closed', () => {
    // A frozen non-stateful pattern must keep working: only `lastIndex` is unwritable and
    // a non-global `test` never reads it.
    const frozen = Object.freeze(/password/i);
    assert.equal(isRedactedKey('user-password', [frozen]), true);
    assert.equal(isRedactedKey('user:42', [frozen]), false);

    // A frozen *global* pattern cannot even run (`test` rewrites the frozen `lastIndex`):
    // deny by default instead of throwing or silently skipping redaction.
    assert.equal(isRedactedKey('user:42', [Object.freeze(/token/g)]), true);

    // Junk entries and hostile `test` implementations take the same never-throw path.
    assert.equal(isRedactedKey('user:42', [null]), true);
    const hostile = {
      lastIndex: 0,
      test() {
        throw new Error('boom');
      },
    };
    assert.equal(isRedactedKey('user:42', [hostile]), true);

    // A stateful (global) pattern is reset between calls, so it cannot alternate between
    // matching and not matching the same key.
    const global = /token/g;
    assert.equal(isRedactedKey('my-token', [global]), true);
    assert.equal(isRedactedKey('my-token', [global]), true);
  });
});
