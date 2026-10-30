<p align="center">
  <img src="https://raw.githubusercontent.com/blaze-cache/blaze-cache/main/docs/blaze-cache-logo.png" alt="Blaze Cache logo" width="150">
</p>

<h1 align="center">@blaze-cache/core</h1>

WebAssembly client-side cache for the browser: SIEVE eviction, per-entry TTLs, tag
invalidation and optional IndexedDB persistence.

The engine behind
[`@blaze-cache/axios`](https://www.npmjs.com/package/@blaze-cache/axios),
[`@blaze-cache/fetch`](https://www.npmjs.com/package/@blaze-cache/fetch) and
[`@blaze-cache/react-query`](https://www.npmjs.com/package/@blaze-cache/react-query) —
also usable on its own.

## Install

```sh
npm install @blaze-cache/core@beta
```

`@beta` is npm's dist-tag for the prerelease; drop it to install the last stable
release.

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
`ttl`, `size`, `keys`, `entry`) emit nothing. `dispose()` clears every listener along with
the wasm memory. The full design notes live in the
[repository README](https://github.com/blaze-cache/blaze-cache#events).

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
  the queue for the next flush, rather than being dropped.
* **`capacity` is normalised** — below `1` clamps up, above `1_000_000` clamps down, and
  a non-finite value falls back to the wasm default — so `capacity()` reports a real
  number back.
* **Events cost nothing when unused** — with no listeners the bus is a size check per
  operation, and the Rust core's drop log stays off until somebody asks for
  `evict`/`expire` (see [Events](#events)).

## Documentation

Setup, persistence, eviction, tags, events and the full API are documented in the
[repository README](https://github.com/blaze-cache/blaze-cache#readme).

## License

[MIT](https://github.com/blaze-cache/blaze-cache/blob/main/LICENSE) © Blaze Cache
