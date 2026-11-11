/**
 * Tests for the opt-in subscription layer — `subscribe`, `subscribeMany` and `subscribeTag`.
 *
 * They run against the **built** artifacts (`dist/` plus the wasm binary), exactly like the
 * rest of the core suite, so they fail if the layer and the events it rides on drift apart:
 *
 *   pnpm --filter @blaze-cache/core test
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createCache } from '@blaze-cache/core';

const wasmBytes = await readFile(new URL('../pkg/blaze_cache_wasm_bg.wasm', import.meta.url));

/** A cache over the real wasm module (Node has no `fetch` for `file:` URLs). */
const makeCache = (options = {}) => createCache({ wasm: wasmBytes, persistence: false, ...options });

describe('subscription surface', () => {
  it('offers the three subscribe flavours and nothing else new', async () => {
    const cache = await makeCache();
    assert.equal(typeof cache.subscribe, 'function');
    assert.equal(typeof cache.subscribeMany, 'function');
    assert.equal(typeof cache.subscribeTag, 'function');

    // Every subscribe returns a stop function, and the cache is otherwise untouched.
    for (const stop of [
      cache.subscribe('k', () => {}),
      cache.subscribeMany(['k'], () => {}),
      cache.subscribeTag('t', () => {}),
    ]) {
      assert.equal(typeof stop, 'function');
      stop();
    }
    cache.set('k', 1);
    assert.equal(cache.get('k'), 1, 'a cache with no live subscription behaves normally');
    await cache.dispose();
  });

  it('treats an empty `subscribeMany` list as no subscription at all', async () => {
    const cache = await makeCache();
    const stop = cache.subscribeMany([], () => assert.fail('must never fire'));
    cache.set('a', 1);
    cache.clear();
    stop();
    stop(); // still idempotent
    await cache.dispose();
  });
});

describe('key subscriptions', () => {
  it('hands the subscriber the current value and the mutation that woke it', async () => {
    const cache = await makeCache();
    const seen = [];
    const stop = cache.subscribe('k', (value, change) => seen.push([value, change.type]));

    cache.set('k', 1);
    cache.set('k', 2);
    cache.touch('k', { ttlMs: 60_000 });
    cache.delete('k');

    assert.deepEqual(seen, [
      [1, 'set'],
      [2, 'set'],
      [2, 'touch'], // a renewal reports the unchanged value…
      [undefined, 'delete'], // …a removal reports nothing left
    ]);

    stop();
    await cache.dispose();
  });

  it('stays silent through reads — `hit`/`miss` never reach a subscription', async () => {
    const cache = await makeCache();
    const seen = [];
    const stop = cache.subscribe('k', (value) => seen.push(value));
    cache.set('k', 1);
    seen.length = 0;

    cache.get('k'); // hit
    cache.peek('k');
    cache.get('absent'); // miss
    cache.has('k');
    cache.ttl('k');
    cache.keys();

    assert.deepEqual(seen, [], 'a lookup is not a change');
    stop();
    await cache.dispose();
  });

  it('reports an eviction with an undefined value and the dropped entry on the change', async () => {
    const cache = await makeCache({ capacity: 1 });
    cache.set('a', 'first');
    const seen = [];
    // Subscribing switches the core's drop log on, so the eviction is recorded at all.
    const stop = cache.subscribe('a', (value, change) =>
      seen.push({ value, type: change.type, dropped: change.value }),
    );

    cache.set('b', 'second'); // capacity pressure — the core drops 'a' by itself
    assert.deepEqual(seen, [{ value: undefined, type: 'evict', dropped: 'first' }]);

    stop();
    await cache.dispose();
  });

  it('reports an expiry with an undefined value', async () => {
    const cache = await makeCache();
    cache.set('gone', 'bye', { ttlMs: 60 });
    const seen = [];
    const stop = cache.subscribe('gone', (value, change) => seen.push([value, change.type]));

    await delay(150); // past the deadline, nothing has looked at the entry yet
    assert.equal(cache.get('gone'), undefined); // the lazy reclamation emits `expire`

    assert.deepEqual(seen, [[undefined, 'expire']]);
    stop();
    await cache.dispose();
  });

  it('wakes key subscribers for bulk removals too', async () => {
    const cache = await makeCache();
    cache.set('a', 1, { tags: ['t'] });
    cache.set('b', 2, { tags: ['t'] });
    const seen = [];
    const stopA = cache.subscribe('a', (value, change) => seen.push(`a:${value}:${change.type}`));
    const stopB = cache.subscribe('b', (value, change) => seen.push(`b:${value}:${change.type}`));

    // `invalidateTags` reports its keys in hash order, so compare as a set.
    cache.invalidateTags('t');
    assert.deepEqual([...seen].sort(), ['a:undefined:invalidate', 'b:undefined:invalidate']);

    cache.set('a', 1, { ttlMs: 60 });
    seen.length = 0;
    await delay(150);
    assert.deepEqual(cache.prune(), ['a']);
    assert.deepEqual(seen, ['a:undefined:prune']);

    stopA();
    stopB();
    await cache.dispose();
  });

  it('reports `clear` only to the keys the cache actually held', async () => {
    const cache = await makeCache();
    cache.set('live', 1);
    const seen = [];
    const stopLive = cache.subscribe('live', (value) => seen.push(`live:${value}`));
    const stopAbsent = cache.subscribe('absent', (value) => seen.push(`absent:${value}`));

    cache.clear();
    assert.deepEqual(seen, ['live:undefined'], 'a key that was never there stays silent');

    stopLive();
    stopAbsent();
    await cache.dispose();
  });
});

describe('subscribeMany', () => {
  it('routes every watched key to the same listener, and ignores the rest', async () => {
    const cache = await makeCache();
    const seen = [];
    const stop = cache.subscribeMany(['a', 'b'], (key, value, change) =>
      seen.push(`${key}=${value}:${change.type}`),
    );

    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3); // not watched
    cache.delete('a');
    cache.setMany([
      { key: 'a', value: 4 },
      { key: 'c', value: 5 }, // not watched
    ]);

    assert.deepEqual(seen, ['a=1:set', 'b=2:set', 'a=undefined:delete', 'a=4:set']);
    stop();
    await cache.dispose();
  });
});

describe('tag subscriptions', () => {
  it('tells the subscriber which of its keys a mutation touched', async () => {
    const cache = await makeCache();
    cache.set('u1', 1, { tags: ['user'] });
    cache.set('u2', 2, { tags: ['user'] });

    const seen = [];
    const stop = cache.subscribeTag('user', ({ tag, keys, change }) =>
      seen.push(`${change.type}:${tag}:${[...keys].sort().join(',')}`),
    );

    cache.set('u3', 3, { tags: ['user'] }); // enters the tag
    cache.touch('u3', { ttlMs: 60_000 }); // still in it, deadline renewed
    cache.delete('u1'); // leaves it
    cache.invalidateTags('user'); // u2 and u3 leave the cache
    cache.clear(); // nothing of the tag is left to report

    assert.deepEqual(seen, [
      'set:user:u3',
      'touch:user:u3',
      'delete:user:u1',
      'invalidate:user:u2,u3', // hash order neutralised by the sort above
    ]);

    stop();
    await cache.dispose();
  });

  it('attributes an eviction and an expiry to the tag the entry carried', async () => {
    const cache = await makeCache({ capacity: 1 });
    cache.set('a', 'first', { tags: ['hot'] });
    const evicted = [];
    const stopEvict = cache.subscribeTag('hot', ({ tag, keys, change }) =>
      evicted.push(`${change.type}:${tag}:${keys.join(',')}`),
    );

    cache.set('b', 'second', { tags: ['hot'] }); // drops 'a' under capacity pressure
    assert.deepEqual(
      evicted,
      ['set:hot:b', 'evict:hot:a'],
      'the write enters the tag, the eviction leaves it',
    );
    stopEvict();

    const expired = [];
    cache.set('dying', 'bye', { tags: ['hot'], ttlMs: 60 });
    const stopExpire = cache.subscribeTag('hot', ({ tag, keys, change }) =>
      expired.push(`${change.type}:${tag}:${keys.join(',')}`),
    );
    await delay(150);
    assert.equal(cache.get('dying'), undefined);
    assert.deepEqual(expired, ['expire:hot:dying']);
    stopExpire();

    await cache.dispose();
  });

  it('reports `clear` only to the tags whose keys were really there', async () => {
    const cache = await makeCache();
    cache.set('warm', 1, { tags: ['hot'] });
    const seen = [];
    const stop = cache.subscribeTag('hot', ({ keys }) => seen.push([...keys].sort()));

    cache.clear();
    assert.deepEqual(seen, [['warm']]);

    // Nothing carries the tag any more, so a second clear reports nothing.
    cache.clear();
    assert.deepEqual(seen, [['warm']]);

    stop();
    await cache.dispose();
  });

  it('ignores a tag nobody subscribed to', async () => {
    const cache = await makeCache();
    cache.set('a', 1, { tags: ['watched', 'ignored'] });
    const seen = [];
    const stop = cache.subscribeTag('watched', ({ keys }) => seen.push([...keys]));

    cache.delete('a');
    assert.deepEqual(seen, [['a']], 'only the subscribed tag woke up');

    stop();
    await cache.dispose();
  });

  it('wakes both the tag a rewrite left and the one it joined', async () => {
    const cache = await makeCache();
    cache.set('k', 1, { tags: ['old'] });
    const seen = [];
    const stopOld = cache.subscribeTag('old', ({ change }) => seen.push(`old:${change.type}`));
    const stopNew = cache.subscribeTag('new', ({ change }) => seen.push(`new:${change.type}`));

    cache.set('k', 2, { tags: ['new'] }); // leaves `old`, joins `new`
    cache.set('k', 3, { tags: ['old', 'new'] }); // stays in both
    cache.set('k', 4); // leaves both

    assert.deepEqual(seen, [
      'old:set',
      'new:set',
      'old:set',
      'new:set',
      'old:set',
      'new:set',
    ]);

    stopOld();
    stopNew();
    await cache.dispose();
  });
});

describe('unsubscribing', () => {
  it('stops notifying on unsubscribe, and a handle released twice costs nothing', async () => {
    const cache = await makeCache();
    let count = 0;
    const stop = cache.subscribe('k', () => {
      count += 1;
    });

    cache.set('k', 1);
    stop();
    stop(); // idempotent
    cache.set('k', 2);
    assert.equal(count, 1);

    const stopAgain = cache.subscribe('k', () => {
      count += 1;
    });
    cache.set('k', 3);
    assert.equal(count, 2, 'the re-subscription is registered exactly once — no residue');

    stopAgain();
    await cache.dispose();
  });

  it('leaves no residue after repeated subscribe/unsubscribe cycles', async () => {
    const cache = await makeCache();
    for (let i = 0; i < 50; i += 1) {
      const stopKey = cache.subscribe('k', () => {});
      const stopTag = cache.subscribeTag('t', () => {});
      const stopMany = cache.subscribeMany(['k', 'j'], () => {});
      stopKey();
      stopTag();
      stopMany();
    }

    const seen = [];
    cache.subscribe('k', (value) => seen.push(value));
    cache.set('k', 1);
    cache.set('k', 2);
    assert.deepEqual(seen, [1, 2], 'exactly one notification per change after 50 cycles');
    await cache.dispose();
  });

  it('keeps the other subscribers when one of them stops', async () => {
    const cache = await makeCache();
    const seen = [];
    const stopFirst = cache.subscribe('k', (value) => seen.push(`first:${value}`));
    cache.subscribe('k', (value) => seen.push(`second:${value}`));

    cache.set('k', 1);
    stopFirst();
    cache.set('k', 2);

    assert.deepEqual(seen, ['first:1', 'second:1', 'second:2']);
    await cache.dispose();
  });

  it('never calls a subscriber that unsubscribed earlier in the same event', async () => {
    const cache = await makeCache();
    const seen = [];
    let stopSecond;
    cache.subscribe('k', () => {
      seen.push('first');
      stopSecond();
    });
    stopSecond = cache.subscribe('k', () => seen.push('second'));

    cache.set('k', 1);
    assert.deepEqual(seen, ['first'], 'the snapshot is re-checked before every call');
    await cache.dispose();
  });

  it('re-binds its listeners after `cache.off()` instead of dying quietly', async () => {
    const cache = await makeCache();
    const seen = [];
    cache.subscribe('k', (value) => seen.push(value));

    cache.off(); // sledgehammer: every *event* listener goes
    cache.set('k', 1);
    assert.deepEqual(seen, [1], 'the subscription survived `off()`');

    cache.off('set'); // …and the type-scoped version too
    cache.set('k', 2);
    assert.deepEqual(seen, [1, 2]);

    await cache.dispose();
  });
});

describe('safety', () => {
  it('isolates a throwing subscriber from the mutation and its siblings', async () => {
    const cache = await makeCache();
    const originalError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args);
    try {
      const seen = [];
      cache.subscribe('k', () => {
        throw new Error('boom');
      });
      cache.subscribe('k', (value) => seen.push(value));

      assert.doesNotThrow(() => cache.set('k', 1), 'a bad subscriber never breaks the write');
      assert.deepEqual(seen, [1], 'the sibling still ran');
      assert.equal(cache.get('k'), 1, 'the mutation itself stands');
      assert.equal(logged.length, 1, 'exactly one failure was reported');
      assert.match(String(logged[0][0]), /subscription listener failed/);
      assert.equal(logged[0][1]?.message, 'boom', 'the error itself is handed along');
    } finally {
      console.error = originalError;
    }
    await cache.dispose();
  });

  it('honours `once` for key and tag subscriptions alike', async () => {
    const cache = await makeCache();
    cache.set('a', 1, { tags: ['t'] });
    const keySeen = [];
    const tagSeen = [];
    cache.subscribe('a', (value) => keySeen.push(value), { once: true });
    cache.subscribeTag('t', ({ change }) => tagSeen.push(change.type), { once: true });

    cache.set('a', 2);
    cache.set('a', 3);

    assert.deepEqual(keySeen, [2], 'the key subscription fired exactly once');
    assert.deepEqual(tagSeen, ['set'], 'the tag subscription fired exactly once');
    await cache.dispose();
  });

  it('drops every subscription on dispose', async () => {
    const cache = await makeCache();
    const seen = [];
    cache.subscribe('k', (value) => seen.push(value));
    cache.subscribeTag('t', () => seen.push('tag'));

    cache.set('k', 1, { tags: ['t'] });
    assert.deepEqual(seen, [1, 'tag'], 'both the key and the tag subscription woke up');

    await cache.dispose();
    assert.deepEqual(seen, [1, 'tag'], 'nothing runs once the cache is gone');
  });
});
