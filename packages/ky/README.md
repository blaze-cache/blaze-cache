<p align="center">
  <img src="https://raw.githubusercontent.com/blaze-cache/blaze-cache/main/docs/blaze-cache-logo.png" alt="Blaze Cache logo" width="150">
</p>

<h1 align="center">@blaze-cache/ky</h1>

ky hooks that cache HTTP responses through a WebAssembly cache — TTLs, tags,
`Cache-Control` and an `x-blaze-cache: HIT | MISS` marker.

Works on **ky v1 and v2**, whose hook signatures differ: the hooks recognise whichever
shape they are called with, from one implementation.

## Install

```sh
npm install @blaze-cache/ky@beta @blaze-cache/core@beta
```

`@beta` is npm's dist-tag for the prerelease; drop it to install the last stable
release. `ky` ≥ 1.14 is a peer dependency — v1 and v2 both work.

## Quick start

ky is designed around hooks, so caching is two of them: one that answers a request from
the cache by returning a `Response` — ky skips the network entirely — and one that stores
the response worth keeping.

```ts
import ky from 'ky';
import { blazeKyHook } from '@blaze-cache/ky';
import { createCache } from '@blaze-cache/core';

const cache = await createCache({ capacity: 1000 });

const api = ky.extend({
  hooks: {
    ...blazeKyHook(cache, {
      ttlMs: 30_000,
      methods: ['GET'],
      tags: (response, request) => ['api'],
    }),
  },
});

const response = await api.get('https://api.example.com/users');
response.headers.get('x-blaze-cache'); // 'MISS' …
```

```ts
const again = await api.get('https://api.example.com/users');
again.headers.get('x-blaze-cache');    // … then 'HIT'
await again.json();                    // the body replayed from the cache
```

The helper form wraps the same hooks around a pre-configured instance — every ky option
passes through:

```ts
import { createBlazeKy } from '@blaze-cache/ky';

const api = createBlazeKy(cache, {
  prefixUrl: 'https://api.example.com',   // ky v1; ky v2 spells this `baseUrl`
  ttlMs: 30_000,
});

const users = await api.get('users').json();
```

## Behaviour

* **Only `GET` is cached** — pass `methods: ['GET', 'HEAD']` to include `HEAD`. Everything
  else always goes to the network and is never stored.
* **Only successful responses are stored** — the default `shouldCache` keeps `2xx`;
  replace it to widen or narrow that. A cached non-`2xx` (reachable with a custom
  `shouldCache`) still throws ky's `HTTPError` on replay exactly like the network one.
* **`Cache-Control` is honoured on both sides** when `cacheControl` is on (the default):
  on the request, `no-store`/`no-cache` and `max-age=0` skip the read, and `no-store`
  also skips the write; on the response, `max-age` overrides `ttlMs`, `Age` is deducted,
  and `no-store`/`no-cache` — the per-field `no-cache="set-cookie"` form included — stop
  it being stored.
* **`Authorization` participates in the default key** (hashed, never stored verbatim), so
  a personalized response is never replayed to a different user. Tune with `varyHeaders`.
* **The response's own `Vary` is honoured** — `Vary: *` is never stored (RFC 9111 §3), and
  a response varying on a header you have not put in `varyHeaders` is left uncached rather
  than replay a variant to the wrong caller. Server headers missing from `varyHeaders`?
  That is the safe default working as intended — list them to opt in. The check runs
  before *every* store, `cacheControl: false` included: variant correctness is not a
  freshness preference.
* **Your hooks keep working** — `ky.extend` appends hooks, so your `beforeRequest` hooks
  run **before** the cache (any header they set is folded into the key), and your
  `afterResponse` hooks run before the response is stored. With `createBlazeKy`, pass
  them in `options.hooks` and they are merged for you.
* **A hit is a real `Response`** — status, status text, headers, body, `url` after a
  redirect and `redirected` are replayed exactly, so your code cannot tell the difference
  apart from the marker header. Body shortcuts (`.json()`, `.blob()`, `.text()`) work on
  hits as on any response.
* **A hit never re-stores itself** — ky runs `afterResponse` on a `beforeRequest`-returned
  response too; the adapter tracks its own replays by request identity, so every read
  leaves the entry's TTL exactly where it was.
* **Buffering never delays a response** — the body is stored on a teed clone in the
  background, and the record is complete before it is written, so a hit can never
  half-load. Transport headers are corrected to the stored bytes (`content-encoding` and
  `transfer-encoding` dropped, `content-length` rewritten), exactly as
  `@blaze-cache/fetch` does.
* **Failures behave like plain ky** — a rejected network call still rejects; a cache that
  cannot read or store a response never breaks the request that produced it. Reads,
  writes, `shouldCache`, `key` and the clone step are all guarded: the first cache-layer
  failure is announced once on the console, then the adapter keeps working *without* the
  cache rather than warning on every call.
* **Cache activity is observable** — the adapter reads with `cache.get` and writes with
  `cache.set`, so the shared cache's typed event system sees every request it serves:

  ```ts
  cache.on('hit', ({ key }) => console.log('replayed', key));
  cache.on('miss', ({ key }) => console.log('fetched', key));
  cache.on('evict', ({ key }) => console.log('dropped', key));
  ```

  `on` returns its own unsubscribe function; the full event table is in the
  [repository README](https://github.com/blaze-cache/blaze-cache#events).

## Options

```ts
const hooks = blazeKyHook(cache, {
  ttlMs: 30_000,                        // number | (response, request) => number
  methods: ['GET'],                     // which methods are cacheable
  cacheControl: true,                   // honour Cache-Control on request + response
  key: (request) => request.url,        // custom cache key
  shouldCache: (response) => response.ok,        // which responses are stored
  tags: (response, request) => ['api'],          // tags on stored entries
  varyHeaders: ['authorization'],       // headers folded into the default key
  markerHeader: 'x-blaze-cache',        // or false to disable the marker
});
```

`createBlazeKy(cache, options)` accepts these **plus** every ky option.

| Option | Default | What it does |
| --- | --- | --- |
| `ttlMs` | `60_000` | Freshness window. Overridden by a response `max-age`. |
| `methods` | `['GET']` | Methods eligible for caching. |
| `cacheControl` | `true` | Honour `Cache-Control`/`Age` on both sides. |
| `key` | method + URL + vary hash | Custom cache key. |
| `shouldCache` | `2xx` | Which responses are stored. |
| `tags` | `['ky', '<method> <url>']` | Tags for `cache.invalidateTags(...)`. |
| `varyHeaders` | `['authorization']` | Request headers folded into the default key. |
| `markerHeader` | `'x-blaze-cache'` | Header carrying `HIT`/`MISS`; `false` disables it. |

Requests can force the behaviour per call:

```ts
await api.get(url, { cache: 'no-cache' });   // skip the read, still store the response
await api.get(url, { cache: 'no-store' });   // neither read nor write
```

## Invalidating

Stored responses carry two tags, so they plug straight into the cache's tag API:

```ts
cache.invalidateTags('ky');                       // everything this adapter stored
cache.invalidateTags('get https://api.example.com/users');  // one resource
```

The per-resource tag is `'<method> <url>'` — the same spelling `@blaze-cache/fetch` and
`@blaze-cache/axios` use, so integrations sharing one cache invalidate together.

## Custom keys

```ts
import { blazeKyHook, defaultCacheKey } from '@blaze-cache/ky';

const api = ky.extend({
  hooks: {
    ...blazeKyHook(cache, {
      // Keep the default (method + URL + vary hash) and add a version prefix:
      key: (request) => `v2:${defaultCacheKey(request, ['authorization'])}`,
    }),
  },
});
```

## ky v1 and ky v2

ky 2 changed every hook from positional arguments (`(request, options, response, state)`)
to a single state object (`({request, options, response, retryCount})`). `blazeKyHook`
detects which shape it is called with, so the same code runs on either major — use the
spelling your installed ky expects (`prefixUrl` in v1, `baseUrl`/`prefix` in v2) and
ignore the rest. Both are covered by the test suite.

## Testing

```sh
pnpm --filter @blaze-cache/ky test
```

The suite runs against the built package with a stubbed network — deterministic, offline
— and executes **every test twice**, once on ky v1 and once on ky v2 (installed under an
npm alias), because the two majors take their hooks in completely different shapes.

## Documentation

Setup, core concepts and the complete API reference live in the
[repository README](https://github.com/blaze-cache/blaze-cache#readme).

## Part of Blaze Cache

* [`@blaze-cache/core`](https://www.npmjs.com/package/@blaze-cache/core) — the cache itself
* [`@blaze-cache/fetch`](https://www.npmjs.com/package/@blaze-cache/fetch) — the drop-in `fetch()` replacement (stale-while-revalidate included)
* [`@blaze-cache/axios`](https://www.npmjs.com/package/@blaze-cache/axios) — the axios adapter
* [`@blaze-cache/react-query`](https://www.npmjs.com/package/@blaze-cache/react-query) — TanStack Query v5 mirror

## License

[MIT](https://github.com/blaze-cache/blaze-cache/blob/main/LICENSE) © Blaze Cache
