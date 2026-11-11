<p align="center">
  <img src="https://raw.githubusercontent.com/blaze-cache/blaze-cache/main/docs/blaze-cache-logo.png" alt="Blaze Cache logo" width="150">
</p>

<h1 align="center">@blaze-cache/swr</h1>

Persist SWR in WebAssembly — instant first paint after reload while
stale-while-revalidate still works.

## Install

```sh
npm install @blaze-cache/swr   # swr ≥ 2 is a peer dependency
```

`@beta` is npm's dist-tag for prereleases; append it to install a prerelease
instead of this stable release.

## Quick start

```tsx
import { useBlazeSWR } from '@blaze-cache/swr';
import { cache } from './blaze.js'; // a cache created by @blaze-cache/core

function Todos() {
  const { data } = useBlazeSWR(cache, '/api/todos', (url) => fetch(url).then((r) => r.json()), {
    ttlMs: 5 * 60_000,
    tags: ['todos'],
  });
  // first render: the persisted todos, instantly — background revalidation included
}
```

A persisted entry is handed to SWR as `fallbackData` — the first paint after a reload
comes from the cache instantly, while SWR still revalidates in the background exactly
like plain `useSWR` (`revalidateIfStale` is untouched, so the fetcher runs on mount as
usual). Every successful fetch is written back under the same key, stamped with
`ttlMs`/`tags`. A caller-supplied `fallbackData` (or a provider-level `fallback` entry
for that key) always wins over the cache.

## Behaviour

* Keys are filed under **SWR's own serialization** (`unstable_serialize`): plain strings
  stay themselves, array/object keys get SWR's stable hash — an entry always lines up
  with the key SWR uses internally, and `resolveBlazeKey(key)` exposes it for
  imperative `cache.get` / `cache.set` / `cache.delete`.
* Successful fetches are written to the shared cache; failed fetches are not — errors
  stay in SWR, data crosses into Blaze.
* The cache layer never takes a fetch down with it: a hydration read that throws seeds
  nothing (the hook fetches as plain `useSWR` would, with one console warning), and a
  write that throws — or a `tags` resolver that does — returns the data unwritten,
  warned and otherwise uninterrupted.
* An `undefined` result is skipped too: SWR reads it as "no data", so there is nothing
  to stamp a TTL onto.
* What is written is an **envelope** — `{ kind: 'swr', data, storedAt }` — and hydration
  only seeds the UI from values carrying it. On a cache shared with `@blaze-cache/axios`,
  `@blaze-cache/fetch` or `@blaze-cache/react-query`, a forced key collision can park a
  foreign value under an SWR key; the envelope keeps an HTTP record from ever being shown
  as this hook's `data`. `readBlazeSWRRecord(cache, key)` exposes the gated read, and
  `isBlazeSWRRecord` the shape check.
* Renders never touch cache statistics: the hydration read prefers `peek` over `get`,
  so StrictMode's double render cannot move the hit rate or influence eviction.
* Paused keys (`null`/`undefined`/`false`, or a lazy key resolving to one) read and
  write nothing.
* SWR owns freshness *within* a session; Blaze Cache owns it *across* sessions —
  `ttlMs` defaults to 24 h, and with no `tags` given every write carries the `'swr'`
  tag, so `cache.invalidateTags('swr')` purges everything this package wrote.
  (Supplied `tags` **replace** the default rather than extending it — add `'swr'`
  yourself if you want the integration-wide purge to keep reaching your entries.)

## API

The entry points take `(cache, …, options?)` — the cache first, then the usual SWR
arguments, then normal SWR options plus the Blaze-side stamp (`ttlMs`/`tags`/`forceRefresh`).

| Export | What it does |
| --- | --- |
| `useBlazeSWR` | `useSWR` seeded from the cache, persisting successful fetches. |
| `blazeSWRMiddleware` | The same behaviour as a plain SWR middleware, for `SWRConfig` or an existing `useSWR`. |
| `invalidateBlazeSWR` | Purge this package's entries by tag — foreign records on a shared cache survive — and revalidate the hooks that showed them. |
| `resolveBlazeKey` | The key an SWR `key` is filed under in the Blaze Cache (`null` when paused). |
| `readBlazeSWRRecord` | The gated hydration read: `key`'s data, but only when the value is this package's own envelope. |
| `isBlazeSWRRecord` | The envelope shape check `readBlazeSWRRecord` uses. |
| `DEFAULT_TTL_MS` / `DEFAULT_TAGS` | The write stamp used when nothing is given: 24 h, `['swr']`. |
| `BlazeSWROptions` / `BlazeSWRMiddlewareOptions` / `BlazeSWRCacheLike` / `BlazeSWRRecord` / `BlazeSWRTags` / `InvalidateBlazeSWROptions` | The option, cache, record and tag types. |

Precedence for the write stamp and `forceRefresh`: the current `useSWR`/`useBlazeSWR`
options, then the middleware's own options, then the defaults. `useBlazeSWR` keeps
`ttlMs`/`tags`/`forceRefresh` in the SWR config it hands to `useSWR` rather than
stripping them out, so a hook-level stamp also wins an `SWRConfig` provider's merged
values — a provider default can never shadow a per-call one.

## Example usage

### `useBlazeSWR` — instant first paint

```tsx
import { useBlazeSWR } from '@blaze-cache/swr';

function Profile({ userId }: { userId: string }) {
  const { data, isLoading } = useBlazeSWR(
    cache,
    ['profile', userId],
    ([url, id]) => api.get(`${url}/${id}`).then((r) => r.data),
    { ttlMs: 60_000, tags: [`user:${userId}`] },
  );
  // renders the persisted profile immediately; refetches stale data in the background
}
```

Omit the fetcher (or pass `null`) for a global fetcher or client-side state — the cache
is still read, nothing is written:

```tsx
const { data } = useBlazeSWR(cache, 'theme', null, { fallbackData: 'dark' });
```

`tags` may also be a function, resolved at write time from the key and the fetched data
— for tags only a successful fetch can be responsible for:

```tsx
const { data } = useBlazeSWR(cache, '/api/users/7', fetchUser, {
  tags: (key, data) => ['user', `user:${data.id}`],
});
```

### `blazeSWRMiddleware` — one middleware for a whole tree

```tsx
import { SWRConfig } from 'swr';
import { blazeSWRMiddleware } from '@blaze-cache/swr';

<SWRConfig value={{ use: [blazeSWRMiddleware(cache)] }}>
  <App />
</SWRConfig>;
```

It is a plain SWR middleware, so yours compose with it — this one goes first, so it
seeds the config and wraps the fetcher before they transform either:

```ts
const { data } = useSWR('/api/todos', fetcher, {
  use: [blazeSWRMiddleware(cache, { ttlMs: 60_000 }), loggerMiddleware],
});
```

### `forceRefresh` — skip the paint, hit the network

```tsx
const { data } = useBlazeSWR(cache, '/api/todos', fetchTodos, {
  tags: ['todos'],
  forceRefresh: true,
});
// no persisted seed — the fetcher runs immediately, and the result is still written
// back, so the next mount starts from it
```

For a key that must be current *right now* — a pull-to-refresh, a view opened after a
mutation elsewhere: the persisted entry is not read, `revalidateOnMount` is forced so the
fetch runs even where this call or the provider would quiet it (the flag beats an
explicit `revalidateOnMount: false` — skipping the read is only honest if the network
runs), and the write still happens. Skip the read, keep the write — the same rule as
axios/fetch's `forceRefresh`. Caller `fallbackData` and provider `fallback` keep their
own precedence: they only stop *Blaze* from seeding, never the caller.

### Invalidating by tag

```ts
// Writes carry tags…
const { data } = useBlazeSWR(cache, '/api/todos', fetchTodos, { tags: ['todos'] });

// …so a mutation that changes the list purges every persisted copy — including ones
// from earlier sessions — and revalidates the hooks that were showing the old one:
await invalidateBlazeSWR(cache, 'todos');
```

`invalidateBlazeSWR` only ever touches this package's `{ kind: 'swr' }` envelopes: on a
cache shared with `@blaze-cache/axios` / `@blaze-cache/fetch` /
`@blaze-cache/react-query`, an entry another integration wrote — even one wearing the
same tag — survives. It returns the purged keys. Hooks under a *custom* `SWRConfig`
provider need that provider's mutator:

```ts
const { mutate } = useSWRConfig();
await invalidateBlazeSWR(cache, 'todos', { mutate });
```

The raw equivalent reaches the whole shared tag namespace and leaves SWR's in-memory
copy to you:

```ts
cache.invalidateTags('todos');
mutate('/api/todos'); // SWR's own revalidation for the mounted hook
```

## Testing

```sh
pnpm --filter @blaze-cache/swr test        # offline — stubbed fetcher, no network
pnpm --filter @blaze-cache/swr test:live   # live — real public API, needs the network
```

The offline suite runs against the built package with Node's test runner, started with
`--experimental-test-module-mocks`: the hook test replaces the `swr` module with a
capture stub, so the exact config `useBlazeSWR` hands to SWR can be asserted without a
React renderer (the main suite needs none of that).

The live suite (4 tests) runs against `api.github.com`, proving the middleware round-trips
a real response body through the persisted envelope, that a fresh middleware run seeds
from the mirror with zero network, that a failing fetcher persists nothing, and that a
revalidation rewrites the same single entry in place. Every live test is skipped unless
`BLAZE_CACHE_LIVE=1` is set, so the default suite always runs offline.

## Documentation

Setup and the full integration reference live in the
[repository README](https://github.com/blaze-cache/blaze-cache#readme).

## Part of Blaze Cache

* [`@blaze-cache/core`](https://www.npmjs.com/package/@blaze-cache/core) — the cache itself
* [`@blaze-cache/axios`](https://www.npmjs.com/package/@blaze-cache/axios) — HTTP adapter
* [`@blaze-cache/fetch`](https://www.npmjs.com/package/@blaze-cache/fetch) — drop-in `fetch()` replacement
* [`@blaze-cache/ky`](https://www.npmjs.com/package/@blaze-cache/ky) — ky hooks (v1 and v2)
* [`@blaze-cache/react-query`](https://www.npmjs.com/package/@blaze-cache/react-query) — TanStack Query v5 mirror + hook

## License

[MIT](https://github.com/blaze-cache/blaze-cache/blob/main/LICENSE) © Blaze Cache
