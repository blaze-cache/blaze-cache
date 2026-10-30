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
| [`@blaze-cache/swr`](packages/swr) | SWR middleware + `useSWR` that paints instantly from cache and persists fetches |

## Installation

Install the cache itself, then add only the integrations you use:

```sh
npm install @blaze-cache/core@beta         # prerelease — 0.2.3-beta
npm install @blaze-cache/axios@beta         # prerelease — 0.2.3-beta
npm install @blaze-cache/fetch@beta         # prerelease — 0.2.3-beta
npm install @blaze-cache/react-query@beta   # prerelease — 0.2.3-beta
npm install @blaze-cache/swr@beta           # prerelease — 0.2.3-beta
```

`pnpm add …` and `yarn add …` are equivalent. The `@beta` dist-tag points at the
prerelease this branch documents; drop it (`@blaze-cache/core`, no tag) to install
the last stable release instead.

| Package | Expects as a peer dependency |
| --- | --- |
| `@blaze-cache/core` | — |
| `@blaze-cache/axios` | `axios` ≥ 1.7 |
| `@blaze-cache/fetch` | — (any `fetch`-shaped function) |
| `@blaze-cache/react-query` | `@tanstack/react-query` ≥ 5 |
| `@blaze-cache/swr` | `swr` ≥ 2 |

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
written by the previous session is readable on the very next line. A row that no longer
matches the record shape — an older package version, another tab, a flaky adapter — is
skipped individually and reported once, so one bad row costs that row rather than the
whole hydration.

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
Teardown happens even when that last flush fails: the timers, listeners and wasm memory
are still released, and the storage error is rethrown to you afterwards, so a full disk
cannot leak the instance. Every event listener is dropped with the rest — though it costs
nothing to call `on`/`off` on the disposed instance: registration is inert, never a crash.

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
matches the Rust core, where `Duration::ZERO` is treated as "unbounded". The same holds
for a TTL so far out that it overflows the monotonic clock: it reads as "never expires"
rather than raising. A *positive* value below a millisecond is rounded **up** to 1 ms, so
the shortest TTL you can ask for is one tick — not, as a truncating conversion would make
it, forever.

### Tags

Tags turn a lookup into a group invalidation:

```ts
cache.set('user:1', ada,  { tags: ['user:1', 'profile'] });
cache.set('user:2', grace, { tags: ['user:2', 'profile'] });

cache.invalidateTags('profile');   // ['user:1', 'user:2'] — deduplicated, in queue order
```

Writing a key **replaces** its tag set; there is no partial merge. Tag ids are
monotonic and never reused, so invalidation is a set difference rather than a scan — and
because names are interned into a ~4.3-billion-entry id space that is never recycled
within a process, a bounded vocabulary (`'user:42'`, `'profile'`) beats per-object UUIDs.

### Eviction

`capacity` bounds the number of entries. The wasm binding normalises it before it is used
— below `1` clamps up, above `1_000_000` clamps down, and a non-finite value falls back to
the default — so `capacity()` always reports a number inside that range. When the bound is
reached, SIEVE evicts the oldest entry that has not been read since the last eviction pass
— entries you actually read are protected, which makes the cache scan-resistant.

A write never evicts itself: capacity is freed **before** the new entry is published.

`get()` and `touch()` are what mark an entry as used; `peek()` deliberately does not, so
polling a key can never turn it into an eviction-proof resident.

### Introspection

Five reads answer "what is in there, and for how long?" — none of them counts a hit or
a miss. All are available in the Rust core (`blaze-cache-core`) and exposed through the
wasm bindings as of `0.2.3-beta`:

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

### Values

Values are handed back **by reference**: the object you pass to `set` is the very object
that `get`, `peek`, `entry` and `entries` return later. Mutating either one silently
rewrites the cache — and, after the next flush, the persisted row — with no error and no
warning. Treat values living in the cache as read-only: clone on the way *out*
(`structuredClone(cache.get(key))`) before editing, or clone on the way *in* if you want
to keep mutating your own copy.

The sharing is deliberate, not an oversight: the hot path never clones or serialises a
value, which is what keeps `get`/`set` allocation-free. The contract is ownership
transfer, not deep-copy semantics.

### Stats

```ts
cache.stats();
// { hits, misses, evictions, expirations, invalidations, size, capacity, hitRate }
```

`has()`, `entry()`, `peek()` and `ttl()` deliberately do *not* touch statistics or eviction
state — they are the non-observing reads, useful for persistence and for UI checks.

### Events

Everything the cache does can be observed through a typed event system. `on(type, listener)`
subscribes to one event type, `on(listener)` subscribes to **all** of them (wildcard), both
return their own unsubscribe function, and `once` / `off` complete the API:

```ts
const cache = await createCache({ capacity: 2 });

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

Eight of those are raised in TypeScript around the call you made. `evict` and `expire` are
the exception — capacity sweeps and TTL reclamation happen *inside* the Rust core, mid-`set`
or lazily during a `get`, where no JavaScript exists to observe them. For those the core
keeps an opt-in **drop log**: the first listener interested in `evict`/`expire` (typed or
wildcard) switches it on through the wasm binding, and after each operation that can
reclaim memory the cache drains it and emits one event per dropped entry — with the `value`
you would have read a moment earlier. With no such listener the log stays off and the hot
path pays a single predictable branch. Drains run after `get`, `getMany`, `set` and
`setMany`; `evict`/`expire` events land right after the operation that caused them.

Listeners run synchronously and in registration order (typed listeners first, wildcards
last), a throwing listener is logged and skipped — never able to undo or block a mutation —
and reads that record nothing (`peek`, `has`, `ttl`, `size`, `keys`, `entry`) emit nothing.

Legacy code that used the original `on(listener)` keeps working: that form *is* the
wildcard now, so such listeners additionally see `hit`/`miss`/`evict`/`expire`.

### API at a glance

`createCache(options)` accepts `capacity`, `persistence` and `wasm` (see
[Setup](#1-create-the-cache) and [Bundler setup](#bundler-setup)); everything else below
is a method on the returned cache. Reads that record nothing are marked ⊘ — no hit, no
miss, no eviction state, no event.

| | Method | Returns / does |
| --- | --- | --- |
| **Read** | `get(key)` | value or `undefined` — counts a hit or a miss |
| | `getMany(keys)` | one entry per key, same accounting as `get` |
| | `peek(key)` ⊘ | value or `undefined`, invisible to stats and eviction |
| | `has(key)` / `hasMany(keys)` ⊘ | presence of live (unexpired) entries |
| | `entry(key)` / `entries()` ⊘ | `{ key, value, ttlMs, tags }` snapshots |
| | `keys()` ⊘ | every live key |
| | `ttl(key)` ⊘ | ms left, or `undefined` for *never expires* or *not here* |
| | `size()` / `capacity()` ⊘ | live entries / the normalised bound |
| | `stats()` ⊘ | `{ hits, misses, evictions, expirations, invalidations, size, capacity, hitRate }` |
| | `keysWithTag(tag)` / `tagsOf(key)` / `hasTag(key, tag)` ⊘ | tag index reads |
| **Write** | `set(key, value, { ttlMs, tags })` | stores (insert or replace) |
| | `setMany(entries)` | batched `set` |
| | `touch(key, { ttlMs })` | marks used; renews the deadline when `ttlMs` is given |
| | `delete(key)` / `deleteMany(keys)` | `true` when the key was present |
| | `invalidateTags(...tags)` | the keys removed |
| | `prune()` | the expired keys reclaimed |
| | `clear()` | empties the cache |
| | `resetStats()` | zeroes the counters, entries untouched |
| **Observe** | `on(type, listener)` / `on(listener)` | subscribe (typed / wildcard); returns unsubscribe |
| | `once(…)` | the same, listener removed as it fires |
| | `off()` / `off(type)` / `off(type, listener)` / `off(listener)` | removes listeners without the handle |
| **Persist** | `flush()` | awaits the pending write-through queue |
| | `dispose()` | flushes, frees the wasm memory, drops every listener |

Values travel **by reference** in and out of every read and write — see
[Values](#values) before mutating one.

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

Failures are contained at both ends. An adapter that cannot open at all (private mode,
enterprise policy) degrades to memory-only with a console warning rather than breaking
the app. A flush that fails *later* — a quota error, a transient IndexedDB problem — is
logged and, crucially, every record it had claimed is put straight back on the queue, so
the next flush retries them instead of losing them. Only an awaited `flush()` or
`dispose()` surfaces that error to you.

Any storage can be plugged in:

```ts
interface CachePersistence {
  load(): Promise<PersistedRecord[]>;
  save(records: PersistedRecord[]): Promise<void>;
  remove(keys: string[]): Promise<void>;
  clear(): Promise<void>;
  keys?(): Promise<string[]>;   // reconciliation — see below
  close?(): Promise<void>;
}
```

`keys()` — the optional method that keeps storage honest — exists because the wasm core
drops entries on its own: a capacity eviction or a lapsed TTL never queues a delete for
persistence (the `evict`/`expire` events reach *subscribers*, not the flush bookkeeping),
so without a way to list what storage still holds, those rows would outlive every flush,
re-hydrate at the next startup and eat quota until persistence dies. Implementing it is
recommended; adapters that skip it keep working exactly as before.

### Multiple tabs

Tabs share one IndexedDB namespace but nothing else: each holds its own wasm instance,
hydrated once at startup, and each flushes the keys it wrote. There is no coordination
between them — writes are **last-writer-wins per key**. That is what you want for
ordinary use (the foreground tab refetches on focus and rewrites its own copy), but a tab
that keeps working while hidden can flush a value older than the one the focused tab just
wrote, and that older value is what hydration paints after a reload until revalidation
corrects it. If it matters, use a short `ttlMs` on records written from background tabs,
or filter on a timestamp stored inside the value.

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
* `Cache-Control` is honoured on both sides: `max-age` overrides `ttlMs` **minus the
  response's `Age`** (a `max-age=60, Age: 50` response has ten seconds left, not sixty);
  `no-store` (on the request or the response) bypasses the cache entirely, and `no-cache`
  — the per-field `no-cache="set-cookie"` spelling included — plus `max-age=0` on the
  request skip the read.
* Freshness is enforced by the adapter, not trusted from the store: every record carries
  the deadline it was written with, so a store that never expires anything (a plain `Map`
  shim qualifies) still cannot replay a stale entry.
* The key is built from the URL axios will actually request — an absolute `url` ignores
  `baseURL`, and slashes are collapsed exactly as axios' own `buildFullPath` does — so one
  endpoint occupies one entry instead of several spellings of it.
* `Authorization` participates in the default key (hashed, never stored verbatim), so a
  personalized response is never served to a different user. Configure with `varyHeaders`.
  A response's own `Vary` is checked too: `Vary: *` is never stored, and one varying on a
  header outside `varyHeaders` is left uncached rather than risk replaying the wrong
  variant — add the server's headers there to opt those responses in.
* A cached response is replayed through the *current* request's `validateStatus`, so a
  stored `404` rejects just like a live one.
* Only responses that pass `validateStatus` are candidates for storage; the default
  stores `GET` requests answering `2xx`.
* A cache that throws costs one extra request, never a failed response: reads and writes
  are guarded, and the failure is reported once on the console.
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
  overrides `ttlMs`; `no-store` bypasses the read *and* the write; `cache: 'no-cache'`,
  `forceRefresh` and `max-age=0` on the request skip the read and rewrite the entry; a
  response `no-cache` — per-field spelling included — is never stored; and
  `must-revalidate`/`proxy-revalidate` closes the stale window entirely, however short.
* Identical concurrent requests **coalesce**: one caller leads, and the rest wait for its
  write to settle and replay the record it stored, so a burst of the same `GET` opens one
  connection instead of N. Only cacheable requests lead (a `POST` is never folded into
  another), callers that explicitly demanded the network are never joined, and a leader
  that fails simply opens the gate over an empty cache so its joiners fetch in turn.
* A cache-layer failure never fails a response the network delivered: a throwing
  `cache.get`, `cache.set` or `shouldCache` callback costs at most one console warning,
  after which the wrapper keeps working uncached.
* `staleWhileRevalidate` serves the stale body immediately and refetches in the background.
  Those responses are marked **`STALE`** rather than `HIT` — the one marker value beyond
  `HIT | MISS`, so a stale paint stays visible in the network tab.
* `Authorization` participates in the default key (hashed, never stored verbatim), so a
  personalized response is never served to a different user. Configure with `varyHeaders`,
  or replace the whole key with `key`.
* A response's own `Vary` is honoured before anything is stored: `Vary: *` is never cached,
  and a response varying on a header you have not listed in `varyHeaders` is deliberately
  left uncached — an unknown variant must never be replayed to the caller it doesn't belong
  to. This is the conservative default; add the server's headers to `varyHeaders` if you
  want those responses cached.
* The `Response` is handed back immediately — the bytes are buffered in the background from
  a teed clone, so a streaming body is never held up waiting for the cache. A hit still
  replays exactly the bytes the network sent — status, headers and `url` included.
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
refetches in the background. Options that already carry `initialData` or
`initialDataUpdatedAt` are left entirely alone — your data, your timestamp. The lookup is
hashed exactly as TanStack hashes it, so a custom `queryKeyHashFn` (per query, in
`setQueryDefaults` or under `defaultOptions.queries`) is honoured on both sides of the
mirror.

The mirror reacts to query events: successful fetches and `setQueryData` are written;
an **explicit** `removeQueries` or `clear` deletes; invalidation deliberately keeps the
data so stale-while-revalidate still has something to paint. Ordinary garbage collection
— a query that sat unobserved past `gcTime` — is housekeeping rather than a purge, so the
mirror survives it: that copy is what paints the next session. Error states stay in
TanStack.

### Full API

* `useBlazeQuery(cache, options)` — `useQuery` seeded from the mirror; `useBlazeInfiniteQuery`
  does the same for infinite queries (the whole `InfiniteData`, pages included, seeds back
  as `initialData`), `useBlazeQueries` does it for parallel queries.
* `useBlazeMutation(cache, options)` — `useMutation` that runs the given
  `invalidate` filters through the two-sided helpers after success.
* `prefetchBlazeQuery(cache, client, options)` — prefetch; seeds from the mirror first,
  mirrors the fetched result.
* `setBlazeQueryData(cache, client, queryKey, data, options?)` — write through to the
  mirror (TanStack first, then Blaze, with the caller's TTL/tags).
* `invalidateBlazeQueries(cache, client, filters)` / `removeBlazeQueries(cache, client, filters)`
  — invalidate (mark stale + purge persisted data) / remove, query-key, tag or predicate
  based, on both caches at once.

### Round trip

```ts
// Server: whatever the mirror holds for this session, as a TanStack DehydratedState.
const dehydratedState = dehydrateBlazeQueryClient(cache);

// Client: restore into the synced client, then keep persisting afterwards.
hydrateBlazeQueryClient(cache, queryClient, dehydratedState, { tags: ['ssr', `user:${userId}`] });
```

## Sharing one cache

Every integration takes the same `cache` — one instance per app is the intended setup:

```ts
const cache = await createCache({ capacity: 1000, persistence: { namespace: 'app' } });

installBlazeCache(api, { cache });                     // @blaze-cache/axios
const fetch = createBlazeFetch(cache);                 // @blaze-cache/fetch
const queryClient = createBlazeQueryClient({ cache }); // @blaze-cache/react-query
// useBlazeSWR(cache, key, fetcher, { ttlMs, tags })   // @blaze-cache/swr
```

Key formats are disjoint by default — axios/fetch file `get <url>?<fnv1a>`, TanStack
files its own `queryHash`, SWR its own serialization — so entries from different
integrations never overwrite each other. What *is* shared:

* **Tags are one namespace at the core.** Default tags (`axios`, `fetch`, `react-query`,
  `swr`) keep `cache.invalidateTags('<integration>')` scoped to a single package, and
  every integration's purge helpers select *their own records* by shape before they read
  tags — so `invalidateBlazeQueries(cache, client, { tags: ['todos'] })` purges mirror
  records tagged `'todos'` and leaves an axios/SWR entry tagged `'todos'` in place. A
  direct `cache.invalidateTags('todos')` is the one call that spans everything tagged —
  useful when one purge *should* cover the whole domain.
* **Purge helpers without a filter stay on their own records.**
  `removeBlazeQueries(cache, client)` (and the unfiltered `invalidateBlazeQueries`)
  removes every entry that *looks like* a react-query record (`dataUpdatedAt`), leaving
  axios/fetch/SWR entries on a shared store untouched. `{ queryKey }` and `{ tags }`
  narrow it further.
* **Every integration shape-checks values it did not write.** axios treats a foreign
  value as a miss — it neither serves nor deletes it; react-query seeds only records
  carrying its own `dataUpdatedAt` stamp; SWR seeds only its `{ kind: 'swr' }` envelope.
  With default keys collisions cannot happen at all, and with custom keys a foreign
  value reads as a clean miss instead of being shown as data.
* **Capacity, stats, events and the persistence flush are one pool.** Size `capacity` for
  the combined write volume — a busy integration evicts other entries. Reads differ too:
  react-query/SWR render with `peek` (never moving hit rate or eviction), axios/fetch
  read with `get` (counting, as request-driven reads should).

The cross-integration suite in [`packages/integration-tests`](packages/integration-tests)
pins all of the above. It found six conflicts along the way — cross-purging purges,
shape-blind reads and deletes, an unscoped resource tag — each since fixed in its package
and now asserted positively here.

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
  swr/                   @blaze-cache/swr (SWR persist + hook)
  integration-tests/     cross-integration tests: several packages, one shared cache
  <name>/test/           that package's Node test suite
examples/
  browser/               Vite + React demo with a mock API and a latency counter
benchmarks/
  cache/                 pnpm bench — blaze-cache vs quick-lru and the native Map
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
pnpm bench            # blaze-cache vs quick-lru and the native Map (~40s)
pnpm lint             # clippy -D warnings + rustfmt + tsc --noEmit
pnpm test:wasm        # wasm-pack test --node (the bindings, against the wasm crate)
pnpm dev              # build, then serve the browser example
pnpm clean            # remove build outputs
```

Every package carries its own suite in `packages/<name>/test/`, run with `node --test`
(`pnpm --filter @blaze-cache/fetch test` for one of them). The suites exercise the
**built** artifacts — the real wasm binary plus `packages/*/dist` — so they fail if
either side drifts, and each marker-header assertion is paired with a look *inside*
the store, so a green run means the payload really landed there.

The `fetch` and `axios` packages additionally ship an opt-in **live** suite that talks to
real public APIs — `api.github.com` and `raw.githubusercontent.com` (keyless, and well
within GitHub's unauthenticated 60 requests/hour) plus `jsonplaceholder.typicode.com` —
so that *actual* `Cache-Control` and `Vary` headers are exercised rather than a stub's
idea of them:

```sh
pnpm test:live                             # every package's live suite
pnpm --filter @blaze-cache/fetch test:live # just one of them
```

Every test in those suites is skipped unless `BLAZE_CACHE_LIVE=1` (each package's
`test:live` script sets it for you), so `pnpm test:js` always keeps working offline.
[`.github/workflows/js.yml`](.github/workflows/js.yml) mirrors that split — the offline
suites gate every push and PR, the live ones run on a nightly cron and on manual
dispatch, so a third-party outage can never fail an unrelated PR.

## Benchmarks

`pnpm bench` runs [`benchmarks/cache/`](benchmarks/cache), which times `@blaze-cache/core`
against `quick-lru` and the native `Map` over five workloads — cold fill, a hit, a miss, a
90/10 mixed load under capacity pressure, and one headline that switches on every feature at
once. Before a single timing is taken, every adapter in a scenario must produce *deeply
equal* probe observations, so the three are provably asked the same question rather than a
similar-looking one.

From one run on an Apple M2 — nanoseconds per operation, **lower is better**:

| Scenario | Map | QuickLRU | blaze-cache |
| --- | ---: | ---: | ---: |
| `fill` | **46.0** | 56.8 | 106.9 |
| `get-hit` | **32.4** | 90.4 | 69.0 |
| `get-miss` | **29.8** | 34.1 | 53.0 |
| `mixed-90-10` | **48.1** | 72.6 | 83.8 |

The headline asks the question this cache exists for — *give me a bounded, expiring,
tag-invalidatable cache: what does each one cost?* — so its columns differ from the three
above, since a bare `Map` or `QuickLRU` cannot answer it at all:

| `full-featured` | Map + LRU + TTL + tags | QuickLRU + tag index | blaze-cache |
| --- | ---: | ---: | ---: |
| ns/op | 192.6 | **102.9** | 141.9 |

Of the caches that actually bound themselves, blaze is the faster **read** path — 1.3× on a
hit — and beats the three layers you would otherwise write and own by 1.4×, while `QuickLRU`
plus a hand-written tag mirror stays 1.4× quicker still, for a cache you also then maintain.
blaze pays for that on writes, where every `set` crosses the JS→wasm boundary and marshals
its key (and deadline, and tags) into linear memory. `Map` wins the first table because it
is asked to do the least: no capacity, no TTL, no tags, no index.
Numbers move with the machine, so read [`benchmarks/cache/README.md`](benchmarks/cache/README.md)
for the full table, the spread column and the methodology before quoting any figure.

## Contributors

Thanks to everyone who has contributed so far. The grid below is generated live and
updates on its own — the [contributors graph](https://github.com/blaze-cache/blaze-cache/graphs/contributors)
has the per-commit detail:

<p align="center">
  <a href="https://github.com/blaze-cache/blaze-cache/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=blaze-cache/blaze-cache" alt="Blaze Cache contributors">
  </a>
</p>