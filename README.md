<p align="center">
  <img src="docs/blaze-cache-logo.png" alt="Blaze Cache logo" width="150">
</p>

<h1 align="center">Blaze Cache</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@blaze-cache/core"><img src="https://img.shields.io/npm/v/@blaze-cache/core?label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@blaze-cache/core"><img src="https://img.shields.io/npm/dm/@blaze-cache/core?label=downloads" alt="npm monthly downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/blaze-cache/blaze-cache?label=license" alt="MIT license"></a>
</p>

Blazingly fast client-side caching library powered by Rust → WebAssembly. Features synchronous reads, SIEVE eviction, tag invalidation, and optional IndexedDB persistence.

The hot path — storage, TTL bookkeeping, tag indexing and eviction — runs in Wasm.
The TypeScript layer adds the browser glue: one-time module initialisation, optional
IndexedDB persistence, an axios adapter, a drop-in `fetch()` replacement and a TanStack
Query integration.

```ts
import { createCache } from '@blaze-cache/core';

const cache = await createCache({ capacity: 1000, persistence: { namespace: 'app' } });

cache.set('user:42', { name: 'Ada' }, { ttlMs: 30_000, tags: ['user:42'] });

cache.get('user:42');              // { name: 'Ada' } — counted as a hit
cache.invalidateTags('user:42');   // removes it, synchronously, and syncs IndexedDB
```

Reads and writes are **synchronous**: the wasm module is instantiated once during
`create`, so the hot path never allocates a `Promise`.

## Packages

| Package | Purpose |
| --- | --- |
| [`@blaze-cache/core`](packages/core) | The cache itself: SIEVE eviction, TTLs, tags, stats, IndexedDB persistence |
| [`@blaze-cache/axios`](packages/axios) | An axios adapter that caches HTTP responses (honouring `Cache-Control`) |
| [`@blaze-cache/fetch`](packages/fetch) | A drop-in `fetch()` replacement with automatic HTTP caching |
| [`@blaze-cache/react-query`](packages/react-query) | TanStack Query v5 mirror + a `useQuery` that paints instantly from cache |

## Installation

Install the cache itself, then add only the integrations you use:

```sh
npm install @blaze-cache/core
npm install @blaze-cache/axios         # optional — axios adapter
npm install @blaze-cache/fetch         # optional — drop-in fetch() replacement
npm install @blaze-cache/react-query   # optional — TanStack Query v5
```

`pnpm add …` and `yarn add …` are equivalent.

| Package | Expects as a peer dependency |
| --- | --- |
| `@blaze-cache/core` | — |
| `@blaze-cache/axios` | `axios` ≥ 1.7 |
| `@blaze-cache/fetch` | — (any `fetch`-shaped function) |
| `@blaze-cache/react-query` | `@tanstack/react-query` ≥ 5 |

npm 7+ and pnpm install peers automatically; yarn classic users need them explicitly.

Three things to know up front:

* **Nothing extra to download.** The `.wasm` binary ships inside `@blaze-cache/core` —
  no CDN configuration, no separate asset package. [Bundler setup](#bundler-setup) shows
  how your bundler resolves it.
* **Types are bundled — no `@types/*` to install.** Every package ships its own `.d.ts`
  through `exports.types`, so `tsc` and editors resolve them under any `moduleResolution`.
  There is no `@types/blaze-cache/*` and none is needed; skip `@types/axios` too (it is a
  deprecated stub — axios carries its own types, and so does TanStack Query). The only
  type packages a consumer needs are the ones its stack already requires, such as
  `@types/react` for React apps.
* **ESM only, browser only.** Every package publishes `"type": "module"` with an `import`
  entry point, so `require()` fails by design. Node/SSR targets are deliberately out of
  scope.

## Setup

Wire the cache once at your entry point, then share it with every integration.

### 1. Create the cache

```ts
// src/blaze.ts
import { createCache } from '@blaze-cache/core';
import wasmUrl from '@blaze-cache/core/pkg/blaze_cache_wasm_bg.wasm?url';

export const cache = await createCache({
  capacity: 1000,
  persistence: { namespace: 'my-app' },
  wasm: wasmUrl,
});
```

Top-level `await` is fine in any ESM module: the wasm is instantiated during `create`, so
every `get`/`set` after it resolves is synchronous. If your bundler does not pre-bundle
dependencies you can drop `wasm` entirely — the package then resolves the binary relative
to its own module URL (see [Bundler setup](#bundler-setup)).

With `persistence` enabled, `create` hydrates from IndexedDB before it resolves, so data
written by the previous session is readable on the very next line.

### 2. Cache HTTP responses (optional)

```ts
// src/api.ts
import axios from 'axios';
import { installBlazeCache } from '@blaze-cache/axios';
import { cache } from './blaze.js';

export const api = axios.create({ baseURL: '/api' });

installBlazeCache(api, { cache, ttlMs: 30_000 });
```

Every `GET` now checks the cache first; responses carry an `x-blaze-cache: HIT | MISS`
header so you can see the behaviour in the network tab.

### 3. Mirror TanStack Query (optional)

```ts
// src/queryClient.ts
import { createBlazeQueryClient } from '@blaze-cache/react-query';
import { cache } from './blaze.js';

export const queryClient = createBlazeQueryClient({ cache });
```

```tsx
// src/main.tsx
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './queryClient.js';

createRoot(container).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
```

### 4. Read through it

```tsx
const todos = useBlazeQuery(cache, {
  queryKey: ['todos'],
  queryFn: () => api.get('/todos').then((response) => response.data),
});
```

A previously mirrored query is injected as `initialData` **with its original
`dataUpdatedAt`**, so the first paint after a reload is instant while TanStack still
considers it stale and refetches in the background.

### Teardown

Persistence flushes itself on `pagehide` and `visibilitychange`, so most apps never think
about it. When you do need to tear down explicitly (a test harness, a hard reset):

```ts
await cache.dispose(); // flushes pending writes, then frees the wasm memory
```

The instance is unusable afterwards — call `createCache()` again for a fresh one.

## Why Wasm

A cache is a data-structure problem, not a DOM problem. Moving it into Rust buys:

* **Predictable eviction.** SIEVE is a scan-resistant, O(1)-amortised algorithm with a
  tiny memory footprint — no JS object churn, no `WeakRef` heuristics.
* **Real data structures.** A slab allocator plus a hash index means lookups are a
  single map hit, and entries are nodes in a queue rather than scattered objects.
* **A tested core.** The eviction, TTL and tag logic is unit-tested in Rust
  (`cargo test --workspace`), independent of any browser or bundler.

## Core concepts

### TTLs

```ts
cache.set('token', value, { ttlMs: 60_000 });   // expires after a minute
cache.set('user', value);                        // no TTL — lives until evicted
```

Expiry is **lazy**: an expired entry stops being visible immediately (`get`, `has`,
`entry` all see through it), and its slot is reclaimed either by `prune()` or when
eviction reaches it. `stats().expirations` counts entries that expired rather than
being explicitly removed.

A `ttlMs` of `0` (or any non-positive or non-finite value) means *no expiry*. This
matches the Rust core, where `Duration::ZERO` is treated as "unbounded".

### Tags

Tags turn a lookup into a group invalidation:

```ts
cache.set('user:1', ada,  { tags: ['user:1', 'profile'] });
cache.set('user:2', grace, { tags: ['user:2', 'profile'] });

cache.invalidateTags('profile');   // ['user:1', 'user:2'] — deduplicated, in queue order
```

Writing a key **replaces** its tag set; there is no partial merge. Tag ids are
monotonic and never reused, so invalidation is a set difference rather than a scan.

### Eviction

`capacity` bounds the number of entries. When it is reached, SIEVE evicts the oldest
entry that has not been read since the last eviction pass — entries you actually read
are protected, which makes the cache scan-resistant.

A write never evicts itself: capacity is freed **before** the new entry is published.

`get()` and `touch()` are what mark an entry as used; `peek()` deliberately does not, so
polling a key can never turn it into an eviction-proof resident.

### Introspection

Five reads answer "what is in there, and for how long?" — none of them counts a hit or
a miss:

```ts
const cache = await createCache({ capacity: 1000 });

cache.set('user', data, { ttlMs: 30_000 });

cache.size();        // 1 — non-expired entries only
cache.capacity();    // 1000

cache.peek('user');  // data (no hit recorded)
cache.get('user');   // data (hit recorded)

cache.ttl('user');   // e.g. 28400
cache.touch('user', { ttlMs: 60_000 }); // refresh TTL to 60s
```

* **`size()`** counts entries that are present *and* unexpired, so it always agrees with
  `keys()` and `entries()`. `stats().size` is the raw slab count and may still hold slots
  that expired but have not been pruned — `prune()` is what closes that gap.
* **`peek()`** is `get()` without the paperwork: no hit or miss, no eviction protection,
  nothing reclaimed. Use it for "is this here?" checks that must not move the hit rate.
* **`ttl()`** returns `undefined` for both *never expires* and *not here* — the first lives
  until it is evicted, the second will never be found again.
* **`touch()`** marks the entry used for SIEVE (exactly what a read grants, so it survives
  the next eviction pass) and rewrites the deadline when `ttlMs` is passed. Omit `ttlMs` to
  leave it alone, pass `0` to drop it, and note that it returns `false` for a missing or
  already expired key. The stored value is never changed.

### Stats

```ts
cache.stats();
// { hits, misses, evictions, expirations, invalidations, size, capacity, hitRate }
```

`has()`, `entry()`, `peek()` and `ttl()` deliberately do *not* touch statistics or eviction
state — they are the non-observing reads, useful for persistence and for UI checks.

## Persistence

Persistence is optional and off by default.

```ts
const cache = await createCache({
  persistence: { namespace: 'app', flushDelayMs: 250, maxRecords: 2000 },
});
```

The built-in adapter stores records in IndexedDB as
`{ id, ns, key, value, tags, ttlMs, storedAt }`, keyed by `namespace\0key`, so two
caches in the same database never collide. Writes are debounced, flushed on `pagehide`
and `visibilitychange`, and absolute expiry is reconstructed from `storedAt` at
hydration — records that expired while the tab was away are dropped on load.

Failures degrade to memory-only with a console warning rather than rejecting:
a blocked IndexedDB (private mode, enterprise policy) should never break the app.

Any storage can be plugged in:

```ts
interface CachePersistence {
  load(): Promise<PersistedRecord[]>;
  save(records: PersistedRecord[]): Promise<void>;
  remove(keys: string[]): Promise<void>;
  clear(): Promise<void>;
  close?(): Promise<void>;
}
```

## axios

```ts
import { installBlazeCache } from '@blaze-cache/axios';

installBlazeCache(api, { cache, ttlMs: 30_000 });

const response = await api.get('/users/42');
response.fromBlazeCache;              // true on a hit
response.headers['x-blaze-cache'];    // 'HIT' | 'MISS'
```

Behaviour worth knowing:

* The adapter stores the **raw** response body, so axios runs `transformResponse` on a
  hit exactly as it would on a network response — a hit is indistinguishable from a miss.
* `Cache-Control` is honoured on both sides: `max-age` overrides `ttlMs`; `no-store`
  (on the request or the response) bypasses the cache entirely.
* `Authorization` participates in the default key (hashed, never stored verbatim), so a
  personalized response is never served to a different user. Configure with `varyHeaders`.
* A cached response is replayed through the *current* request's `validateStatus`, so a
  stored `404` rejects just like a live one.
* Only responses that pass `validateStatus` are candidates for storage; the default
  stores `GET` requests answering `2xx`.
* `installBlazeCache` captures the instance's existing adapter *before* replacing it,
  which is what guarantees the wrapper can never call itself.

## fetch

```ts
import { createBlazeFetch } from '@blaze-cache/fetch';

const cachedFetch = createBlazeFetch(cache, { ttlMs: 30_000 });

const response = await cachedFetch('/api/users/42');
response.headers.get('x-blaze-cache');   // 'HIT' | 'MISS' | 'STALE'
await response.json();
```

`createBlazeFetch` returns a `typeof fetch`, so it drops in wherever the global was
expected — a `fetch` field, an SDK that takes a custom fetcher, or `globalThis.fetch`
itself:

```ts
const api = {
  get: (path: string) => createBlazeFetch(cache)('/api' + path).then((r) => r.json()),
};
```

Behaviour worth knowing:

* Only `GET` is cached by default (`methods` adds `'HEAD'`), and only `2xx` responses are
  stored unless `shouldCache` says otherwise.
* `Cache-Control` is honoured on both sides: `max-age`, minus the response's `Age`,
  overrides `ttlMs`; `no-store` bypasses the read *and* the write; `cache: 'no-cache'` and
  `forceRefresh` skip the read and rewrite the entry.
* `staleWhileRevalidate` serves the stale body immediately and refetches in the background.
  Those responses are marked **`STALE`** rather than `HIT` — the one marker value beyond
  `HIT | MISS`, so a stale paint stays visible in the network tab.
* `Authorization` participates in the default key (hashed, never stored verbatim), so a
  personalized response is never served to a different user. Configure with `varyHeaders`,
  or replace the whole key with `key`.
* The body is buffered before the `Response` is handed back, so a hit replays exactly the
  bytes the network sent — status, headers and `url` included.
* Binary, `Blob` and chunked bodies are handled: the payload is buffered as raw bytes, so a
  hit replays byte-for-byte with `content-type` intact and `blob()` still reports the right
  type and size. Because `fetch` has already decoded the body, `content-encoding` and
  `transfer-encoding` are dropped and `content-length` is corrected to the stored size —
  otherwise a hit would claim the *compressed* length for decoded bytes.
* `markerHeader` renames `x-blaze-cache` or switches it off (`markerHeader: false`).

Full option reference: [`packages/fetch`](packages/fetch).

## TanStack Query

```tsx
import { createBlazeQueryClient, useBlazeQuery } from '@blaze-cache/react-query';

const queryClient = createBlazeQueryClient({ cache });

<QueryClientProvider client={queryClient}>…</QueryClientProvider>

const todos = useBlazeQuery(cache, {
  queryKey: ['todos', userId],
  queryFn: () => api.get('/todos').then((r) => r.data),
});
```

TanStack owns freshness *within* a session; Blaze Cache owns it *across* sessions.
`useBlazeQuery` seeds `initialData` **with its original `dataUpdatedAt`**, so the first
paint after a reload is instant while TanStack still considers the data stale and
refetches in the background.

The mirror reacts to query events: successful fetches and `setQueryData` are written,
`removeQueries` deletes, and invalidation deliberately keeps the data so stale-while-
revalidate still has something to paint. Error states stay in TanStack.

## Bundler setup

The wasm binary ships inside `@blaze-cache/core`. Point at it explicitly with your
bundler's URL import — this stays correct after dependency pre-bundling:

```ts
import wasmUrl from '@blaze-cache/core/pkg/blaze_cache_wasm_bg.wasm?url';

await createCache({ wasm: wasmUrl });
```

| Bundler | Import |
| --- | --- |
| Vite | `?url` (shown above) |
| webpack 5 | `new URL('@blaze-cache/core/pkg/blaze_cache_wasm_bg.wasm', import.meta.url)` |
| Next.js / others | `?url` via `serverComponentsExternalPackages`, or serve the file yourself |

If your bundler does **not** pre-bundle dependencies (or you exclude
`@blaze-cache/core` from pre-bundling, as `examples/browser` does), omitting `wasm`
also works: the package resolves the binary relative to its own module URL.

## Repository layout

```
crates/
  blaze-cache-core/      Rust engine: slab store, SIEVE queue, tags, TTL, stats
  blaze-cache-wasm/      wasm-bindgen bindings
packages/
  core/                  @blaze-cache/core  (wasm loader, persistence, createCache)
  axios/                 @blaze-cache/axios (HTTP adapter)
  fetch/                 @blaze-cache/fetch (drop-in fetch() replacement)
  react-query/           @blaze-cache/react-query (v5 mirror + hook)
  <name>/test/           that package's Node test suite
examples/
  browser/               Vite + React demo with a mock API and a latency counter
.github/
  workflows/             rust.yml (fmt, clippy, tests) + js.yml (offline on PR, live nightly)
```

## Development

```sh
pnpm install          # workspace dependencies
pnpm build            # wasm + all packages (topological)
pnpm build:wasm       # wasm-pack only
pnpm typecheck        # every package, against workspace sources
pnpm test             # cargo test --workspace
pnpm test:js          # build the wasm, then run every package's tests against dist/
pnpm test:live        # the opt-in live suites (fetch + axios) against real public APIs
pnpm lint             # clippy -D warnings + rustfmt + tsc --noEmit
pnpm dev              # build, then serve the browser example
pnpm clean            # remove build outputs
```

Every package carries its own suite in `packages/<name>/test/`, run with `node --test`
(`pnpm --filter @blaze-cache/fetch test` for one of them). The suites exercise the
**built** artifacts — the real wasm binary plus `packages/*/dist` — so they fail if
either side drifts, and each marker-header assertion is paired with a look *inside*
the store, so a green run means the payload really landed there.

The `fetch` and `axios` packages additionally ship an opt-in **live** suite that talks to
real public APIs (`api.github.com` and `raw.githubusercontent.com`, keyless, well under
GitHub's unauthenticated 60 requests/hour) so that *actual* `Cache-Control` headers are
exercised rather than a stub's idea of them:

```sh
pnpm test:live                             # every package's live suite
pnpm --filter @blaze-cache/fetch test:live # just one of them
```

Every test in those suites is skipped unless `BLAZE_CACHE_LIVE=1` (each package's
`test:live` script sets it for you), so `pnpm test:js` always keeps working offline.
[`.github/workflows/js.yml`](.github/workflows/js.yml) mirrors that split — the offline
suites gate every push and PR, the live ones run on a nightly cron and on manual
dispatch, so a third-party outage can never fail an unrelated PR.

## Contributors

Thanks to everyone who has contributed so far. The grid below is generated live and
updates on its own — the [contributors graph](https://github.com/blaze-cache/blaze-cache/graphs/contributors)
has the per-commit detail:

<p align="center">
  <a href="https://github.com/blaze-cache/blaze-cache/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=blaze-cache/blaze-cache" alt="Blaze Cache contributors">
  </a>
</p>