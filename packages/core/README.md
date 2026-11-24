<p align="center">
  <img src="https://raw.githubusercontent.com/blaze-cache/blaze-cache/main/docs/assets/blaze-cache-logo.png" alt="Blaze Cache logo" width="150">
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

cache.get('user:42'); // { name: 'Ada' } — counted as a hit
cache.peek('user:42'); // the same value, with no hit recorded
cache.ttl('user:42'); // ~30000 — ms until it expires
cache.touch('user:42', { ttlMs: 60_000 }); // renew the deadline, keep the value
cache.invalidateTags('user:42'); // removes it, synchronously, and syncs IndexedDB
cache.stats(); // { hits, misses, evictions, expirations, … }
```

`createCache()` instantiates the wasm module once, so everything after it is **synchronous** —
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

cache.off('evict'); // every `evict` listener
cache.off(); // every listener, period
offEvict(); // …or just this one handle (idempotent)
```

| Event        | Emitted when                                      | Payload        |
| ------------ | ------------------------------------------------- | -------------- |
| `set`        | a key was stored (insert or replace)              | `key`          |
| `delete`     | a key was removed and was present                 | `key`          |
| `clear`      | the cache was emptied                             | —              |
| `invalidate` | `invalidateTags()` removed entries                | `keys`         |
| `prune`      | `prune()` removed expired entries                 | `keys`         |
| `touch`      | `touch()` renewed a live entry's deadline         | `key`          |
| `evict`      | the core dropped an entry to stay within capacity | `key`, `value` |
| `expire`     | the core reclaimed an entry whose TTL elapsed     | `key`, `value` |
| `hit`        | `get()` / `getMany()` found a live entry          | `key`, `value` |
| `miss`       | a lookup found nothing (absent or expired)        | `key`          |

Eight of those are raised in TypeScript around the call you made; `evict` and `expire`
happen _inside_ the Rust core and are delivered from an opt-in **drop log** — the first
listener interested in them switches it on through the wasm binding, and with no such
listener the hot path pays a single predictable branch. Listeners run synchronously in
registration order (typed first, wildcards last), a throwing listener is logged and
skipped — never able to undo a mutation — and reads that record nothing (`peek`, `has`,
`ttl`, `size`, `keys`, `entry`) emit nothing. A listener removed _during_ delivery — by
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
  console.log(change.type, user); // 'set' → the new value, 'delete' → undefined
});

const stopMany = cache.subscribeMany(['a', 'b'], (key, value, change) => {
  console.log(key, value, change.type);
});

const stopTag = cache.subscribeTag('user', ({ tag, keys, change }) => {
  console.log(tag, keys, change.type); // 'user', ['user:42'], 'invalidate'
});

stop();
stopMany();
stopTag(); // idempotent — also safe from inside a listener
```

- **`value` is what the cache holds now** — the new value after `set`, the unchanged one
  after `touch`, and `undefined` after `delete`, `evict`, `expire`, `invalidate`, `prune`
  or `clear`. For `evict`/`expire` the dropped reference is still on `change.value`.
- **Reads never wake a subscriber** — `hit`/`miss` are not part of a subscription at all,
  so `get`, `peek`, `has`, `ttl` … cost a subscription nothing.
- **Tag subscriptions know what the raw events cannot** — a removal carries no tags, so the
  layer keeps a per-tag mirror of the live keys carrying it and attributes `delete`,
  `evict`, `expire`, `invalidate`, `prune` and `clear` to the tags they actually hit.
- **Subscriptions switch on the drop log**, exactly like an `evict`/`expire` listener: the
  Rust core only records the entries it drops by itself while somebody is waiting for them,
  and the last stop function switches it back off.
- **`{ once: true }`** fires a single time and unsubscribes itself.
- **A subscriber that throws is isolated** — logged with `console.error`, the mutation
  stands, and the remaining subscribers still run. One that unsubscribes mid-notification
  (through its own handle, or because a `once` sibling fired) is never visited for that
  event.
- **All of it is opt-in** — with no subscription the layer does not exist. The first call
  attaches eight typed listeners and snapshots the live keys; while a subscription lives, a
  write crosses the boundary once more to re-read that key's tags (and only when a tag
  subscription exists), and reads back a value only for keys somebody subscribed to.
  Releasing the last subscription detaches everything again. `cache.off()` clears _event_
  listeners only — live subscriptions re-bind their own immediately.

## Opt-in multi-tab sync

`createCache({ multiTab: { enabled: true } })` opens one `BroadcastChannel` per
`namespace\0generation` and propagates `set`, `delete`, `clear`, tag invalidation and rotation
between tabs, with a `hello`/`state` handshake on focus. Every key tracks a hybrid-logical-clock
version, so stale messages from a hidden tab cannot overwrite a newer value — the old
last-writer-wins flush bug is fixed. `strategy: 'value'` (default) structured-clones payloads
and falls back to a tombstone for non-cloneable values; `strategy: 'invalidate'` always sends
tombstones. Remote mutations emit `remote-set` / `remote-delete` / `remote-clear` /
`remote-invalidate` / `remote-rotate` events and are never re-broadcast. Flushes are guarded by
a cross-tab Web Lock where available. The option is off by default; without it no channel is
created and behavior is unchanged.

## Indexed queries

`keys()`/`entries()` walk every live entry. `createCache({ indexes: true })` builds opt-in
ordered key, expiry and tag indexes for bounded reads:

```ts
const cache = await createCache({ indexes: true });
cache.set('user:1', { name: 'Ada' }, { tags: ['user'], ttlMs: 60_000 });

const page = cache.query({ prefix: 'user:', tags: { all: ['user'] }, limit: 20 });
// items are metadata only: { key, ttlMs, tags }
const more = cache.query({ prefix: 'user:', limit: 20, cursor: page.nextCursor! });
cache.queryKeys({ prefix: 'user:', limit: 20 }); // keys only
cache.count({ prefix: 'user:' }); // number of matches
```

`ttlRange: { min?, max? }` filters remaining TTL; `keys: [...]` is an allow-list; `limit` is
required and cursors are last-key anchors in ascending key order that survive deletion of
the anchor key. `query()` throws without `indexes: true` — an explicit `fullScan: true` is
the only O(n) path. It permits `cursor` and an optional `where` post-filter, but rejects
`prefix`/`tags`/`ttlRange`/`keys` (a scan would silently ignore those constraints).
`includeValues: true` returns live by-reference values and requires both `maxEntries` and
`maxValueBytes` caps. Indexes are off by default and add nothing to the hot path.

## The `@blaze-cache/core/shared` subpath

A wasm-free, server-safe subpath holding the redaction patterns (`REDACT_KEY_PATTERNS`,
`isRedactedKey`), the frozen duck-typed `isBlazeRecord` guard and the
`<binding>:<feature>` kind helpers. Snapshot bridges and framework bindings import it
without loading the cache runtime, wasm or IndexedDB.

## Opt-in storage modes

The default keeps values as by-reference externrefs in the Rust slab (see _Good to know_).
Two opt-in modes are available for workloads with different ownership needs:

```ts
import { createCache } from '@blaze-cache/core';

// 1. Raw bytes live in Wasm linear memory; reads are zero-copy views.
const bytesCache = await createCache({ capacity: 1000 });
bytesCache.setBytes('image', new Uint8Array(buffer), { ttlMs: 30_000 });
const view = bytesCache.getBytes('image'); // Uint8Array view onto Wasm memory
const copy = bytesCache.getBytesCopy('image'); // owned snapshot, safe to retain
// set()/get() still work on the same cache and are unchanged.

// 2. Values live in a JS Map; Wasm keeps metadata + stable ids.
const hybrid = await createCache({ capacity: 1000, storage: 'js' });
hybrid.set('user:42', user, { tags: ['user'] }); // value stays in JS
hybrid.get('user:42'); // Wasm by id, then Map.get — same reference
```

**Bytes mode** copies the payload once into an arena region, then hands out a view with no
second copy. A view is valid only until the next allocation: `memory.grow` detaches the old
`ArrayBuffer`, and an evicted region can be reused. Use `getBytesCopy` for anything long-lived.
`entries()`/`entry()` and persistence see a copied `Uint8Array`, so those paths stay
structured-cloneable. `setBytes` is unavailable with `storage: 'js'` and throws a clear error.
Advanced producers that already wrote into the arena can call
`cache.setBytesReserved(key, ptr, len, options?)` to adopt the region with no JS→Wasm copy;
get `ptr` from `WasmCache.bytesReserve(len)` (exported from the wasm package) and write through a
view of `wasmLinearMemory().buffer`. The public `setBytes` and its view-lifetime contract are
unchanged.

**`storage: 'js'`** preserves by-reference semantics, tag invalidation, events, statistics,
`entry()`/`entries()` and persistence: Wasm still owns the policy and reports evictions by
stable id, and the JS layer deletes the corresponding value from its `Map` (the `evict`/`expire`
events carry the real value, exactly as in the default mode). The cost is one extra `Map` lookup
per read and an extra `Map` write per set — the key scratch buffer already makes the default
path cheap, so **measure before enabling** (see the published deltas linked from the root
README). Both modes are strictly opt-in; a cache created with no options is byte-for-byte the
same implementation as before.

## Good to know

- **The `.wasm` ships inside this package** — no CDN setup, no separate asset download.
  `createCache` fetches it relative to the package's own module, streams it in, and does
  it once per page even when several caches are created at once. Under Vite this needs no
  configuration at all.

  When the binary lives somewhere else — a `public/` asset path, a CDN, Next.js, or a
  bundler that pre-bundles dependencies — say so explicitly:

  ```ts
  // a file you copied to public/, served at /assets/blaze_cache_wasm_bg.wasm
  const cache = await createCache({ capacity: 1000, wasmUrl: '/assets/blaze_cache_wasm_bg.wasm' });
  ```

  Two further overrides cover the rest: `module` for a precompiled `WebAssembly.Module`
  (no fetch, no compile), and `instantiate` for a custom loader that resolves to a source
  — a URL, a `Request`/`Response`, bytes, or a `Module`. Pass at most one of the three;
  two at once throws a `TypeError`. Failures name the URL or step that failed and keep the
  original error on `cause`.

- **Types are bundled** — no `@types/*` packages to install.
- **ESM only, browser only.** Node/SSR targets are out of scope by design.
- **Values are shared by reference** — `set` hands the object over and `get`/`peek`/
  `entry` hand the same object back, so mutating it rewrites the cache (and, after the
  next flush, the persisted row). Clone on the way out if you need to edit: the sharing
  is what keeps `get`/`set` allocation-free.
- **Persistence is optional** and off by default; a blocked IndexedDB (private mode)
  degrades to memory-only instead of breaking the app. A flush that fails later — a quota
  error, a transient IndexedDB problem — is reported (`onError`, or the awaited call's
  rejection) and its records go straight back on the queue for the next flush, rather
  than being dropped; the exception is a record that fails _on its own_ three times
  running, which is dropped from the queue with a console warning (still in memory) so one
  poison row cannot block every later flush, and any successful pass resets the count.
  Options — `namespace`, `debounceMs`, `maxEntries`, `restoreExpired`, `writeMode`,
  `onError`, `onActivity`, `generation` — are validated when persistence is attached and
  throw from `createCache()` rather than misbehave later (`flushDelayMs`/`maxRecords` remain as
  aliases). `cache.persistence` is the control surface: `flush()` writes now, `clear()`
  empties storage without touching memory, `hydrate()` reloads storage into memory,
  `stats()` reports counters, and `rotate(generation)` switches sessions — dropping the
  previous session's queued _and_ in-flight writes (see
  [Persistence](https://github.com/blaze-cache/blaze-cache#persistence)).
- **`capacity` is normalised** — below `1` clamps up, above `1_000_000` clamps down, and
  a non-finite value falls back to the wasm default — so `capacity()` reports a real
  number back.
- **Events cost nothing when unused** — with no listeners the bus is a size check per
  operation, and the Rust core's drop log stays off until somebody asks for
  `evict`/`expire`, or subscribes to a key or a tag (see [Events](#events) and
  [Subscriptions](#subscriptions)).

## Documentation

Setup, persistence, eviction, tags, events, subscriptions and the full API are documented
in the [repository README](https://github.com/blaze-cache/blaze-cache#readme).

## License

[MIT](https://github.com/blaze-cache/blaze-cache/blob/main/LICENSE) © Blaze Cache
