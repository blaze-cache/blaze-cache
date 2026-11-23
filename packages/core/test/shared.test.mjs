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
});
