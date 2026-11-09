<p align="center">
  <img src="https://raw.githubusercontent.com/blaze-cache/blaze-cache/main/docs/blaze-cache-logo.png" alt="Blaze Cache logo" width="150">
</p>

<h1 align="center">@blaze-cache/ofetch</h1>

Cache [ofetch](https://github.com/unjs/ofetch) (`$fetch`) responses through a WebAssembly
cache — TTLs, tags, `Cache-Control` and an `x-blaze-cache: HIT | MISS` marker.

## Install

```sh
npm install @blaze-cache/ofetch @blaze-cache/core ofetch
```

`@beta` is npm's dist-tag for prereleases; append it to install a prerelease instead of
this stable release. `ofetch` ≥ 1.0 is a peer dependency.

## Quick start

Wrap an existing ofetch instance (including one from `ofetch.create()`) so successful
`GET` responses are stored in Blaze Cache and replayed from it:

```ts
import { ofetch } from 'ofetch';
import { blazeOfetch } from '@blaze-cache/ofetch';
import { createCache } from '@blaze-cache/core';

const cache = await createCache({ capacity: 1000 });

const api = blazeOfetch(ofetch.create({ baseURL: 'https://api.example.com' }), cache, {
  ttlMs: 30_000,
  methods: ['GET'],
  tags: (response, ctx) => ['api'],
});

const users = await api('/users');           // parsed JSON — network (MISS)
const again = await api('/users');           // parsed JSON — replayed from cache (HIT)

const res = await api.raw('/users');         // FetchResponse (HIT)
res.headers.get('x-blaze-cache');           // 'HIT'
```

The helper form creates a fresh cached instance — ofetch defaults and cache options in one
bag:

```ts
import { createBlazeOfetch } from '@blaze-cache/ofetch';

const api = createBlazeOfetch(cache, {
  baseURL: 'https://api.example.com',   // any ofetch option, as usual
  ttlMs: 30_000,                         // …plus the cache options
});

const users = await api('/users');
```

## Behaviour

* **Only `GET` is cached** — pass `methods: ['GET', 'HEAD']` to include `HEAD`. Everything
  else always goes to the network and is never stored.
* **Only successful responses are stored** — the default `shouldCache` keeps `2xx`;
  replace it to widen or narrow that. A response `shouldCache` rejects is still returned
  (or throws, if ofetch would throw for that status) — it is simply not cached.
* **`Cache-Control` is honoured on both sides** when `cacheControl` is on (the default):
  on the request, `no-store`/`no-cache` and `max-age=0` skip the read, and `no-store`
  also skips the write; on the response, `max-age` overrides `ttlMs`, `Age` is deducted,
  and `no-store`/`no-cache` — the per-field `no-cache="set-cookie"` form included — stop
  it being stored.
* **`Authorization` participates in the default key** (hashed, never stored verbatim), so
  a personalized response is never replayed to a different user. Tune with `varyHeaders`.
* **The response's own `Vary` is honoured** — `Vary: *` is never stored (RFC 9111 §3), and
  a response varying on a header you have not put in `varyHeaders` is left uncached rather
  than replay a variant to the wrong caller. The check runs before *every* store, even with
  `cacheControl: false`.
* **The full ofetch API is preserved** — call the wrapped instance directly for parsed
  data, `.raw()` for the `FetchResponse` (with `_data` and the `x-blaze-cache` marker),
  `.native` for the underlying fetch, and `.create()` for derived instances (which remain
  cached). `baseURL` and `query`/`params` are resolved into the cache key the same way
  ofetch resolves them.
* **Buffering never delays a response** — the body is stored from a clone in the
  background, and the record is complete before it is written, so a hit can never
  half-load. Transport headers are corrected to the stored bytes (`content-encoding` and
  `transfer-encoding` dropped, `content-length` rewritten).
* **Failures behave like plain ofetch** — a rejected network call still rejects; a cache
  that cannot read or store a response never breaks the request that produced it. The first
  cache-layer failure is announced once on the console, then the adapter keeps working
  *without* the cache rather than warning on every call.
* **Cache activity is observable** — reads/writes use `cache.get`/`cache.set`, so the
  shared cache's typed event system sees every request the adapter serves.

## Options

```ts
const api = blazeOfetch(ofetch, cache, {
  ttlMs: 30_000,                         // number | (response, ctx) => number
  methods: ['GET'],                      // which methods are cacheable
  cacheControl: true,                    // honour Cache-Control on request + response
  key: (ctx) => `${ctx.method} ${ctx.url}`, // custom cache key
  shouldCache: (response) => response.ok,   // which responses are stored
  tags: (response, ctx) => ['api'],         // tags on stored entries
  varyHeaders: ['authorization'],        // headers folded into the default key
  markerHeader: 'x-blaze-cache',         // or false to disable the marker
});
```

`createBlazeOfetch(cache, options)` accepts these **plus** every ofetch option.

| Option | Default | What it does |
| --- | --- | --- |
| `ttlMs` | `60_000` | Freshness window. Overridden by a response `max-age`. |
| `methods` | `['GET']` | Methods eligible for caching. |
| `cacheControl` | `true` | Honour `Cache-Control`/`Age` on both sides. |
| `key` | method + resolved URL + vary hash | Custom cache key (receives `{ request, options, method, url, headers }`). |
| `shouldCache` | `2xx` | Which responses are stored. |
| `tags` | `['ofetch', '<method> <url>']` | Tags for `cache.invalidateTags(...)`. |
| `varyHeaders` | `['authorization']` | Request headers folded into the default key. |
| `markerHeader` | `'x-blaze-cache'` | Header carrying `HIT`/`MISS` on `raw()` responses; `false` disables it. |

## Invalidating

Stored responses carry two tags, so they plug straight into the cache's tag API:

```ts
cache.invalidateTags('ofetch');                          // everything this adapter stored
cache.invalidateTags('get https://api.example.com/users'); // one resource
```

The per-resource tag is `'<method> <url>'` — the same spelling `@blaze-cache/fetch`,
`@blaze-cache/axios`, and `@blaze-cache/ky` use, so integrations sharing one cache
invalidate together.

## Custom keys

```ts
import { blazeOfetch, defaultCacheKey } from '@blaze-cache/ofetch';

const api = blazeOfetch(ofetch, cache, {
  key: (ctx) => `v2:${defaultCacheKey(ctx.method, ctx.url, ctx.headers, ['authorization'])}`,
});
```

## Testing

```sh
pnpm --filter @blaze-cache/ofetch test
```

The suite runs against the built package with a stubbed network — deterministic and
offline.

## Documentation

Setup, core concepts and the complete API reference live in the
[repository README](https://github.com/blaze-cache/blaze-cache#readme).

## Part of Blaze Cache

* [`@blaze-cache/core`](https://www.npmjs.com/package/@blaze-cache/core) — the cache itself
* [`@blaze-cache/fetch`](https://www.npmjs.com/package/@blaze-cache/fetch) — the drop-in `fetch()` replacement (stale-while-revalidate included)
* [`@blaze-cache/axios`](https://www.npmjs.com/package/@blaze-cache/axios) — the axios adapter
* [`@blaze-cache/ky`](https://www.npmjs.com/package/@blaze-cache/ky) — the ky hook adapter
* [`@blaze-cache/react-query`](https://www.npmjs.com/package/@blaze-cache/react-query) — TanStack Query v5 mirror
* [`@blaze-cache/swr`](https://www.npmjs.com/package/@blaze-cache/swr) — SWR middleware + hook

## License

[MIT](https://github.com/blaze-cache/blaze-cache/blob/main/LICENSE) © Blaze Cache
