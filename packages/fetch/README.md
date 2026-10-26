<p align="center">
  <img src="https://raw.githubusercontent.com/blaze-cache/blaze-cache/main/docs/blaze-cache-logo.png" alt="Blaze Cache logo" width="150">
</p>

<h1 align="center">@blaze-cache/fetch</h1>

A drop-in `fetch()` replacement backed by a WebAssembly cache — TTLs, `Cache-Control`,
stale-while-revalidate and an `x-blaze-cache: HIT | MISS` marker.

## Install

```sh
npm install @blaze-cache/fetch @blaze-cache/core
```

## Quick start

```ts
import { createCache } from '@blaze-cache/core';
import { createBlazeFetch } from '@blaze-cache/fetch';

const cache = await createCache({ capacity: 1000 });
const fetch = createBlazeFetch(cache, { ttlMs: 30_000 });

const response = await fetch('/api/users');
response.headers.get('x-blaze-cache'); // 'MISS' …
```

```ts
const again = await fetch('/api/users');
again.headers.get('x-blaze-cache');    // … then 'HIT'
await again.json();                     // the body replayed from the cache
```

The wrapper **is** a `fetch`: same signature, same `Response` back. Hand it to anything that
expects the platform function.

```ts
const asFetch: typeof fetch = fetch;
window.fetch = fetch;                   // now every request in the app is cached
```

## Behaviour

* **Only `GET` is cached** — pass `methods: ['GET', 'HEAD']` to include `HEAD`. Everything
  else (including errors from uncached methods) always goes to the network.
* **`Cache-Control` is honoured on both sides** when `cacheControl` is on (the default):
  `max-age` overrides `ttlMs`, `Age` is deducted, `no-store`/`no-cache` on the request skip
  the read, and the same directives on the response stop it being stored.
* **Only successful responses are stored** — the default `shouldCache` keeps `2xx`; replace
  it to widen or narrow that.
* **`Authorization` participates in the default key** (hashed, never stored verbatim), so a
  personalized response is never replayed to a different user. Tune with `varyHeaders`.
* **The response's own `Vary` is honoured** — `Vary: *` is never stored (RFC 9111 §3), and
  a response varying on a header you have not put in `varyHeaders` is left uncached rather
  than replay a variant to the wrong caller. Server headers missing from `varyHeaders`?
  That is the safe default working as intended — list them to opt in.
* **A hit is a real `Response`** — status, status text, headers, body, `url` after a
  redirect and `redirected` are replayed exactly, so your code cannot tell the difference
  apart from the marker header.
* **Binary, `Blob` and chunked bodies are first-class** — the payload is buffered as raw
  bytes whether it arrived as a file, a `ReadableStream` or plain text, so an image
  replays byte-for-byte with its `content-type` intact and `blob().type`/`blob().size`
  still correct. Buffering runs on a teed clone *after* your `Response` is handed back, so
  a streaming body is never held up waiting for the cache — and because the record is
  complete before it is written, a hit can never half-load.
* **Transport headers are corrected to the bytes stored** — `fetch` decodes
  `content-encoding` for you, so the record drops `content-encoding` and
  `transfer-encoding` and rewrites `content-length` to the payload's real size. Without
  that, a hit would claim `content-length: 1425` (the compressed size) for 6504 stored
  bytes — which breaks anything that measures a download. `HEAD` keeps its headers: no
  body was sent, so its `content-length` is what a GET *would* return.
* **Failures behave like plain `fetch`** — a rejected network call still rejects; a cache
  that cannot store a response never breaks the request that produced it.

## Options

```ts
const fetch = createBlazeFetch(cache, {
  ttlMs: 30_000,                        // number | (response, url, init) => number
  methods: ['GET'],                     // which methods are cacheable
  cacheControl: true,                   // honour Cache-Control on request + response
  staleWhileRevalidate: false,          // true | milliseconds — see below
  key: (url, init) => `${init.method} ${url}`,   // custom cache key
  shouldCache: (response) => response.ok,        // which responses are stored
  tags: (response, url) => ['fetch', url],       // tags on stored entries
  varyHeaders: ['authorization'],       // headers folded into the default key
  markerHeader: 'x-blaze-cache',        // or false to disable the marker
  fetch: globalThis.fetch,              // the real network function (for tests)
});
```

| Option | Default | What it does |
| --- | --- | --- |
| `ttlMs` | `60_000` | Freshness window. Overridden by a response `max-age`. |
| `methods` | `['GET']` | Methods eligible for caching. |
| `cacheControl` | `true` | Honour `Cache-Control`/`Age` on both sides. |
| `staleWhileRevalidate` | `false` | Serve stale entries while refreshing. A number is the fallback window when the response omits the directive. |
| `key` | method + URL + vary hash | Custom cache key. |
| `shouldCache` | `2xx` | Which responses are stored. |
| `tags` | `['fetch', '<method> <url>']` | Tags for `cache.invalidateTags(...)`. |
| `varyHeaders` | `['authorization']` | Request headers folded into the default key. |
| `markerHeader` | `'x-blaze-cache'` | Header carrying `HIT`/`MISS`/`STALE`; `false` disables it. |
| `fetch` | `globalThis.fetch` | The real network call — pass a stub in tests. |

Requests can force the behaviour per call:

```ts
await fetch('/api/users', { forceRefresh: true });  // bypass the cache read
await fetch('/api/users', { cache: 'no-cache' });   // the standard spelling of the same
await fetch('/api/users', { cache: 'no-store' });   // neither read nor write
```

## Stale-while-revalidate

```ts
const fetch = createBlazeFetch(cache, { ttlMs: 10_000, staleWhileRevalidate: 30_000 });
```

Within the stale window a request is answered **immediately** from the cache with
`x-blaze-cache: STALE`, while a background refresh rewrites the entry — the next request is
a fresh `HIT`. One refresh runs per key at a time, and its failure is swallowed: a stale
entry is better than a failed request.

The window comes from the response's `Cache-Control: stale-while-revalidate=<seconds>`;
the number you pass is only the fallback for servers that do not send it.

## Invalidating

Stored responses carry two tags, so they plug straight into the cache's tag API:

```ts
cache.invalidateTags('fetch');                 // everything this wrapper stored
cache.invalidateTags('get /api/users');        // one resource
cache.set('get /api/users', /* … */);          // … or just overwrite it
```

## Custom keys

```ts
import { createBlazeFetch, defaultCacheKey } from '@blaze-cache/fetch';

const fetch = createBlazeFetch(cache, {
  // Keep the default (method + URL + vary hash) and add a version prefix:
  key: (url, init) => `v2:${defaultCacheKey(url, init, ['authorization'])}`,
});
```

## Testing

Two suites, both run against the built package:

```sh
pnpm --filter @blaze-cache/fetch test         # stubbed network — deterministic, offline
pnpm --filter @blaze-cache/fetch test:live    # real public API — opt-in, needs the network
```

The live suite calls `api.github.com` (keyless, well under ten requests per run) to prove
that *real* `Cache-Control` headers are read correctly — a stub can only simulate that.
Every test in it is skipped unless `BLAZE_CACHE_LIVE=1` is set, so the default suite always
passes with no network at all.

## Documentation

Setup, core concepts and the complete API reference live in the
[repository README](https://github.com/blaze-cache/blaze-cache#readme).

## Part of Blaze Cache

* [`@blaze-cache/core`](https://www.npmjs.com/package/@blaze-cache/core) — the cache itself
* [`@blaze-cache/axios`](https://www.npmjs.com/package/@blaze-cache/axios) — the axios adapter
* [`@blaze-cache/react-query`](https://www.npmjs.com/package/@blaze-cache/react-query) — TanStack Query v5 mirror

## License

[MIT](https://github.com/blaze-cache/blaze-cache/blob/main/LICENSE) © Blaze Cache
