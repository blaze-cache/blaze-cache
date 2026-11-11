<p align="center">
  <img src="https://raw.githubusercontent.com/blaze-cache/blaze-cache/main/docs/blaze-cache-logo.png" alt="Blaze Cache logo" width="150">
</p>

<h1 align="center">@blaze-cache/core</h1>

WebAssembly client-side cache for the browser: SIEVE eviction, per-entry TTLs, tag
invalidation and optional IndexedDB persistence.

The engine behind
[`@blaze-cache/axios`](https://www.npmjs.com/package/@blaze-cache/axios),
[`@blaze-cache/fetch`](https://www.npmjs.com/package/@blaze-cache/fetch),
[`@blaze-cache/ky`](https://www.npmjs.com/package/@blaze-cache/ky),
[`@blaze-cache/react-query`](https://www.npmjs.com/package/@blaze-cache/react-query) and
[`@blaze-cache/swr`](https://www.npmjs.com/package/@blaze-cache/swr) —
also usable on its own.

## Install

```sh
npm install @blaze-cache/core
```

`@beta` is npm's dist-tag for prereleases; append it to install a prerelease
instead of this stable release.

## Quick start

```ts
import { createCache } from '@blaze-cache/core';

const cache = await createCache({ capacity: 1000, persistence: { namespace: 'app' } });

cache.set('user:42', { name: 'Ada' }, { ttlMs: 30_000, tags: ['user:42'] });

cache.get('user:42');              // { name: 'Ada' } — counted as a hit
cache.peek('user:42');             // the same value, with no hit recorded
cache.ttl('user:42');              // ~30000 — ms until it expires
cache.touch('user:42', { ttlMs: 60_000 }); // renew the deadline, keep the value
cache.invalidateTags('user:42');   // removes it, synchronously, and syncs IndexedDB
cache.stats();                     // { hits, misses, evictions, expirations, … }
```

`create` instantiates the wasm module once, so everything after it is **synchronous** —
`get`/`set` never allocate a `Promise`.

## Events

Everything the cache does is observable through a typed event system. `on(type, listener)`
subscribes to one event type, `on(listener)` subscribes to **all** of them (wildcard), both
return their own unsubscribe function, and `once` / `off` complete the API:

```ts
// One event type — the payload is typed to exactly that event.
const offEvict = cache.on('evict', ({ key, value }) => {
  console.log('the cache dropped', key, value);
});

// Wildcard: every event, payload the full union (narrow on `event.type`).
cache.on((event) => {
  if (event.type === 'hit') console.log('hit', event.key, event.value);
});

cache.once('clear', () => console.log('first clear, only once'));

cache.off('evict');   // every `evict` listener
cache.off();          // every listener, period
offEvict();           // …or just this one handle (idempotent)
```

| Event | Emitted when | Payload |
| --- | --- | --- |
| `set` | a key was stored (insert or replace) | `key` |
| `delete` | a key was removed and was present | `key` |
| `clear` | the cache was emptied | — |
| `invalidate` | `invalidateTags()` removed entries | `keys` |
| `prune` | `prune()` removed expired entries | `keys` |
| `touch` | `touch()` renewed a live entry's deadline | `key` |
| `evict` | the core dropped an entry to stay within capacity | `key`, `value` |
| `expire` | the core reclaimed an entry whose TTL elapsed | `key`, `value` |
| `hit` | `get()` / `getMany()` found a live entry | `key`, `value` |
| `miss` | a lookup found nothing (absent or expired) | `key` |

Eight of those are raised in TypeScript around the call you made; `evict` and `expire`
happen *inside* the Rust core and are delivered from an opt-in **drop log** — the first
listener interested in them switches it on through the wasm binding, and with no such
listener the hot path pays a single predictable branch. Listeners run synchronously in
registration order (typed first, wildcards last), a throwing listener is logged and
skipped — never able to undo a mutation — and reads that record nothing (`peek`, `has`,
`ttl`, `size`, `keys`, `entry`) emit nothing. A listener removed *during* delivery — by
its own unsubscribe, by `off(type, fn)`, or wholesale by `off(type)`/`off()` — is never
visited for that event, and a pending `once` can be cancelled before it fires through
`off(type, fn)` (Node's `.listener` convention). `dispose()` clears every listener along
with the wasm memory — and overlapping `dispose()` calls share one teardown, so the wasm
is freed exactly once. The full design notes live in the
[repository README](https://github.com/blaze-cache/blaze-cache#events).

## Subscriptions

`subscribe` is the value-oriented front end of [Events](#events): hand it a key, a list of
keys or a tag and a callback, and it runs that callback with the **current value** every
time the cache changes one of them. Each call returns its own stop function, and nothing is
registered until the first one.

```ts
const stop = cache.subscribe('user:42', (user, change) => {
  console.log(change.type, user);      // 'set' → the new value, 'delete' → undefined
});

const stopMany = cache.subscribeMany(['a', 'b'], (key, value, change) => {
  console.log(key, value, change.type);
});

const stopTag = cache.subscribeTag('user', ({ tag, keys, change }) => {
  console.log(tag, keys, change.type); // 'user', ['user:42'], 'invalidate'
});

stop(); stopMany(); stopTag();         // idempotent — also safe from inside a listener
```

* **`value` is what the cache holds now** — the new value after `set`, the unchanged one
  after `touch`, and `undefined` after `delete`, `evict`, `expire`, `invalidate`, `prune`
  or `clear`. For `evict`/`expire` the dropped reference is still on `change.value`.
* **Reads never wake a subscriber** — `hit`/`miss` are not part of a subscription at all,
  so `get`, `peek`, `has`, `ttl` … cost a subscription nothing.
* **Tag subscriptions know what the raw events cannot** — a removal carries no tags, so the
  layer keeps a per-tag mirror of the live keys carrying it and attributes `delete`,
  `evict`, `expire`, `invalidate`, `prune` and `clear` to the tags they actually hit.
* **Subscriptions switch on the drop log**, exactly like an `evict`/`expire` listener: the
  Rust core only records the entries it drops by itself while somebody is waiting for them,
  and the last stop function switches it back off.
* **`{ once: true }`** fires a single time and unsubscribes itself.
* **A subscriber that throws is isolated** — logged with `console.error`, the mutation
  stands, and the remaining subscribers still run. One that unsubscribes mid-notification
  (through its own handle, or because a `once` sibling fired) is never visited for that
  event.
* **All of it is opt-in** — with no subscription the layer does not exist. The first call
  attaches eight typed listeners and snapshots the live keys; while a subscription lives, a
  write crosses the boundary once more to re-read that key's tags (and only when a tag
  subscription exists), and reads back a value only for keys somebody subscribed to.
  Releasing the last subscription detaches everything again. `cache.off()` clears *event*
  listeners only — live subscriptions re-bind their own immediately.

## Good to know

* **The `.wasm` ships inside this package** — no CDN setup. If your bundler
  pre-bundles dependencies, point at it explicitly:

  ```ts
  import wasmUrl from '@blaze-cache/core/pkg/blaze_cache_wasm_bg.wasm?url';

  const cache = await createCache({ wasm: wasmUrl });
  ```

* **Types are bundled** — no `@types/*` packages to install.
* **ESM only, browser only.** Node/SSR targets are out of scope by design.
* **Values are shared by reference** — `set` hands the object over and `get`/`peek`/
  `entry` hand the same object back, so mutating it rewrites the cache (and, after the
  next flush, the persisted row). Clone on the way out if you need to edit: the sharing
  is what keeps `get`/`set` allocation-free.
* **Persistence is optional** and off by default; a blocked IndexedDB (private mode)
  degrades to memory-only instead of breaking the app. A flush that fails later — a quota
  error, a transient IndexedDB problem — is logged and its records go straight back on
  the queue for the next flush, rather than being dropped; the exception is a record that
  fails *on its own* three times running, which is dropped from the queue with a console
  warning (still in memory) so one poison row cannot block every later flush, and any
  successful pass resets the count. `flushDelayMs` and `maxRecords` are validated when
  persistence is attached and throw a `RangeError` from `create` rather than misbehave
  later (`maxRecords: 0` would persist everything — `slice(-0)` is the whole array).
* **`capacity` is normalised** — below `1` clamps up, above `1_000_000` clamps down, and
  a non-finite value falls back to the wasm default — so `capacity()` reports a real
  number back.
* **Events cost nothing when unused** — with no listeners the bus is a size check per
  operation, and the Rust core's drop log stays off until somebody asks for
  `evict`/`expire`, or subscribes to a key or a tag (see [Events](#events) and
  [Subscriptions](#subscriptions)).

## Documentation

Setup, persistence, eviction, tags, events, subscriptions and the full API are documented
in the [repository README](https://github.com/blaze-cache/blaze-cache#readme).

## License

[MIT](https://github.com/blaze-cache/blaze-cache/blob/main/LICENSE) © Blaze Cache
