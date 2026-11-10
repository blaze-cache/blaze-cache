<p align="center">
  <img src="https://raw.githubusercontent.com/blaze-cache/blaze-cache/main/docs/blaze-cache-logo.png" alt="Blaze Cache logo" width="150">
</p>

<h1 align="center">@blaze-cache/axios</h1>

Cache HTTP responses in axios via a WebAssembly cache — TTLs, tags, Cache-Control
support and IndexedDB persistence.

## Install

```sh
npm install @blaze-cache/axios   # axios ≥ 1.7 is a peer dependency
```

`@beta` is npm's dist-tag for prereleases; append it to install a prerelease
instead of this stable release.

## Quick start

```ts
import axios from 'axios';
import { createCache } from '@blaze-cache/core';
import { installBlazeCache } from '@blaze-cache/axios';

const cache = await createCache({ capacity: 1000 });
const api = axios.create({ baseURL: '/api' });

installBlazeCache(api, {
  cache,
  ttlMs: 30_000,                  // default
  methods: ['GET', 'HEAD'],       // default
  honourCacheControl: true,       // default (cacheControl is an alias)
  varyHeaders: ['Authorization'], // default
});

// Cached GET
const response = await api.get('/users/42');
response.fromBlazeCache;              // false on MISS, true on HIT
response.headers['x-blaze-cache'];    // 'HIT' | 'MISS'

// Bypass cache for a single request
await api.get('/users/42', { blazeCache: false });

// Custom TTL/tags (and optional key override) per request
await api.get('/users/1', {
  blazeCache: {
    enabled: true,
    ttlMs: 30_000,
    tags: ['user', 'user:1'],
    key: 'user:1', // optional string override
  },
});

// Invalidate after a mutation
await api.post('/todos', body, {
  blazeCache: {
    invalidateTags: ['todos'],
  },
});
```

## Per-request options

Pass `blazeCache` on any request config (types are augmented on `axios`):

```ts
await api.get('/users/1', {
  blazeCache: {
    enabled: true,                         // false bypasses read/write for this request
    ttlMs: 30_000,                         // overrides adapter ttlMs (number or fn)
    tags: (res, config) => ['user', 'user:1'],
    key: 'user:1',                         // string or (config) => string
    varyHeaders: ['Authorization'],
    forceRefresh: true,                    // bypass read, store fresh response
    invalidateTags: ['todos'],             // invalidate after the network response
  },
});
```

`blazeCache: false` is a shorthand to bypass caching for that request.

## Behaviour

* **`Cache-Control` is honoured on both sides** when `honourCacheControl` is on (default;
  `cacheControl` is an alias) — `max-age` overrides `ttlMs` *minus the response's `Age`*
  (a `max-age=60, Age: 50` response has ten seconds left, not sixty); `no-store` (on the
  request or the response) bypasses the cache entirely, and `no-cache` — the per-field
  `no-cache="set-cookie"` spelling included — plus `max-age=0` on the request skip the
  read. Malformed directives are ignored rather than guessed at: an empty `max-age=` reads
  as *no directive*, not as zero, and a duplicated directive keeps its first value (RFC 9111 §5.2.3).
* **Freshness is enforced by the adapter, not by the store** — each record carries the
  deadline it was written with, so even a store that never expires anything (a plain `Map`
  shim satisfies the interface) still cannot replay a response past its freshness lifetime.
* **The key is the URL axios will actually request** — an absolute `url` ignores
  `baseURL`, the join collapses slashes exactly as axios' `buildFullPath` does, and the
  result is canonicalised through `new URL`. One endpoint, one entry.
* **`Authorization` participates in the key** (hashed, never stored verbatim), so a
  personalized response is never replayed to a different user. Tune with `varyHeaders`.
* **The response's own `Vary` is honoured** — `Vary: *` is never stored (RFC 9111 §3), and
  a response varying on a header you have not put in `varyHeaders` is left uncached rather
  than replay a variant to the wrong caller. Server headers missing from `varyHeaders`?
  That is the safe default working as intended — list them to opt in.
* **A hit behaves like a network response** — the raw body is stored, so
  `transformResponse` runs on it exactly as it would on a miss, and it is replayed
  through the *current* request's `validateStatus` (a stored `404` still rejects), with
  the same `error.code` the network path produces: `4xx` is `ERR_BAD_REQUEST`, a
  sub-400 that failed a custom `validateStatus` (and any `5xx`) is `ERR_BAD_RESPONSE` —
  exactly axios' own `settle` partition.
* **Streams are never stored** — `responseType: 'stream'` leaves `response.data` as a
  live Node stream the caller is about to consume, so there is nothing complete to
  replay. The `x-blaze-cache` marker is stripped from the stored headers too: it
  describes *this* exchange, not the stored representation.
* **Params containers key by content** — `URLSearchParams`, `FormData` and `Map` render
  as `'{}'` to `JSON.stringify`, so requests differing only in them used to collide on
  one key. Each is now flattened into a stable string of its actual entries: order
  preserved for `URLSearchParams` (axios sends it verbatim), order ignored for
  `FormData` parts and `Map` keys.
* **A request body folds into the key too** — an opted-in `POST` with two different
  payloads occupies two entries instead of replaying one response for the other. A body
  the key cannot read (raw bytes, a stream, anything serialising to the bare `'{}'`)
  leaves that request uncached rather than guessed at — the same "unknown ⇒ do not store"
  rule `Vary` follows — unless a `key` callback describes it.
* **Replayed headers describe the stored body, not the wire** — axios decodes the body
  for you (and drops `content-encoding`), so `transfer-encoding` goes too and
  `content-length` is corrected to the payload's real size. A live request answered with
  `content-length: 1425` for `6504` decoded bytes would otherwise hand a hit a length that
  contradicts `data.byteLength`. Bodyless responses (HEAD) keep theirs: there the headers
  describe the body a GET *would* return.
* Only responses that pass `validateStatus` are stored; by default the cache keeps
  `GET` and `HEAD` requests answering `2xx` (`methods: ['GET', 'HEAD']`). A method you
  cache beyond those is stored only when its body can be folded into the key (or a `key`
  callback describes it).
* **HIT/MISS observability** — `response.fromBlazeCache` is `true` on cache hits and
  `false` on network responses, and the `x-blaze-cache` header is set to `HIT`/`MISS`
  (configurable via `markerHeader`, or `false` to disable). Core cache `hit`/`miss`/`set`
  events fire when using `@blaze-cache/core`.
* **Mutation invalidation** — `blazeCache.invalidateTags` invalidates tags on a cache that
  supports it (e.g. `BlazeCache`) after the network response, so `POST`/`PUT`/`PATCH`/`DELETE`
  can bust related GET caches. The `invalidateCacheTags(cache, ...tags)` helper is also exported.
* **A cache that throws costs one extra request, never a failed response** — the read and
  the write are both guarded, and the failure is reported once on the console instead of
  turning a good network response into a rejected promise.
* **Cache activity is observable** — the adapter reads with `cache.get` and writes with
  `cache.set`, so the shared cache's typed event system sees every request it serves:

  ```ts
  cache.on('hit', ({ key }) => console.log('replayed', key));
  cache.on('miss', ({ key }) => console.log('fetched', key));
  cache.on('evict', ({ key }) => console.log('dropped', key));
  ```

  `on` returns its own unsubscribe function; the full event table is in the
  [repository README](https://github.com/blaze-cache/blaze-cache#events).

## Testing

```sh
pnpm --filter @blaze-cache/axios test        # offline — canned adapter, no network
pnpm --filter @blaze-cache/axios test:live   # live — real public APIs, needs the network
```

The offline suite stubs the network so it can assert exact call counts and look
inside the store: payload, status, stored headers, TTL window, tags and key shape. The
live suite (4 tests) runs against `api.github.com` and a real PNG, proving that the
server's own `Cache-Control` is parsed, that a rejected `401` never overwrites a good
entry, and that an `arraybuffer` download replays byte-for-byte.

Every live test is skipped unless `BLAZE_CACHE_LIVE=1` is set, so the default suite always
runs offline.

## Documentation

Setup, core concepts and the complete axios reference live in the
[repository README](https://github.com/blaze-cache/blaze-cache#readme).

## Part of Blaze Cache

* [`@blaze-cache/core`](https://www.npmjs.com/package/@blaze-cache/core) — the cache itself
* [`@blaze-cache/fetch`](https://www.npmjs.com/package/@blaze-cache/fetch) — drop-in `fetch()` replacement
* [`@blaze-cache/ky`](https://www.npmjs.com/package/@blaze-cache/ky) — ky hooks (v1 and v2)
* [`@blaze-cache/react-query`](https://www.npmjs.com/package/@blaze-cache/react-query) — TanStack Query v5 mirror
* [`@blaze-cache/swr`](https://www.npmjs.com/package/@blaze-cache/swr) — SWR middleware + hook

## License

[MIT](https://github.com/blaze-cache/blaze-cache/blob/main/LICENSE) © Blaze Cache
