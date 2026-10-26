<p align="center">
  <img src="https://raw.githubusercontent.com/blaze-cache/blaze-cache/main/docs/blaze-cache-logo.png" alt="Blaze Cache logo" width="150">
</p>

<h1 align="center">@blaze-cache/axios</h1>

Cache HTTP responses in axios via a WebAssembly cache — TTLs, tags, Cache-Control
support and IndexedDB persistence.

## Install

```sh
npm install @blaze-cache/axios@beta   # axios ≥ 1.7 is a peer dependency
```

`@beta` is npm's dist-tag for the prerelease; drop it to install the last stable
release.

## Quick start

```ts
import axios from 'axios';
import { installBlazeCache } from '@blaze-cache/axios';
import { cache } from './blaze.js'; // a cache created by @blaze-cache/core

const api = axios.create({ baseURL: '/api' });

installBlazeCache(api, { cache, ttlMs: 30_000 });

const response = await api.get('/users/42');
response.fromBlazeCache;              // true when served from the cache
response.headers['x-blaze-cache'];    // 'HIT' | 'MISS'
```

## Behaviour

* **`Cache-Control` is honoured on both sides** — `max-age` overrides `ttlMs` *minus the
  response's `Age`* (a `max-age=60, Age: 50` response has ten seconds left, not sixty);
  `no-store` (on the request or the response) bypasses the cache entirely, and `no-cache`
  — the per-field `no-cache="set-cookie"` spelling included — plus `max-age=0` on the
  request skip the read.
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
  through the *current* request's `validateStatus` (a stored `404` still rejects).
* **Replayed headers describe the stored body, not the wire** — axios decodes the body
  for you (and drops `content-encoding`), so `transfer-encoding` goes too and
  `content-length` is corrected to the payload's real size. A live request answered with
  `content-length: 1425` for `6504` decoded bytes would otherwise hand a hit a length that
  contradicts `data.byteLength`. Bodyless responses (HEAD) keep theirs: there the headers
  describe the body a GET *would* return.
* Only responses that pass `validateStatus` are stored; by default the cache keeps
  `GET` requests answering `2xx`.
* **A cache that throws costs one extra request, never a failed response** — the read and
  the write are both guarded, and the failure is reported once on the console instead of
  turning a good network response into a rejected promise.

## Testing

```sh
pnpm --filter @blaze-cache/axios test        # offline — canned adapter, no network
pnpm --filter @blaze-cache/axios test:live   # live — real public APIs, needs the network
```

The offline suite (26 tests) stubs the network so it can assert exact call counts and look
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
* [`@blaze-cache/react-query`](https://www.npmjs.com/package/@blaze-cache/react-query) — TanStack Query v5 mirror

## License

[MIT](https://github.com/blaze-cache/blaze-cache/blob/main/LICENSE) © Blaze Cache
