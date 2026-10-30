<p align="center">
  <img src="https://raw.githubusercontent.com/blaze-cache/blaze-cache/main/docs/blaze-cache-logo.png" alt="Blaze Cache logo" width="150">
</p>

<h1 align="center">@blaze-cache/swr</h1>

Persist SWR in WebAssembly — instant first paint after reload while
stale-while-revalidate still works.

## Install

```sh
npm install @blaze-cache/swr@beta   # swr ≥ 2 is a peer dependency
```

`@beta` is npm's dist-tag for the prerelease; drop it to install the last stable
release.

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

Both entry points take `(cache, …, options?)` — the cache first, then the usual SWR
arguments, then normal SWR options plus the Blaze-side stamp (`ttlMs`/`tags`).

| Export | What it does |
| --- | --- |
| `useBlazeSWR` | `useSWR` seeded from the cache, persisting successful fetches. |
| `blazeSWRMiddleware` | The same behaviour as a plain SWR middleware, for `SWRConfig` or an existing `useSWR`. |
| `resolveBlazeKey` | The key an SWR `key` is filed under in the Blaze Cache (`null` when paused). |
| `readBlazeSWRRecord` | The gated hydration read: `key`'s data, but only when the value is this package's own envelope. |
| `isBlazeSWRRecord` | The envelope shape check `readBlazeSWRRecord` uses. |
| `DEFAULT_TTL_MS` / `DEFAULT_TAGS` | The write stamp used when nothing is given: 24 h, `['swr']`. |
| `BlazeSWROptions` / `BlazeSWRMiddlewareOptions` / `BlazeSWRCacheLike` / `BlazeSWRRecord` | The option, cache and record types. |

Precedence for the write stamp: the current `useSWR`/`useBlazeSWR` options, then the
middleware's own options, then the defaults.

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

### Invalidating by tag

```ts
// Writes carry tags…
const { data } = useBlazeSWR(cache, '/api/todos', fetchTodos, { tags: ['todos'] });

// …so a mutation that changes the list purges every persisted copy —
// including ones from earlier sessions:
cache.invalidateTags('todos');
mutate('/api/todos'); // SWR's own revalidation for the mounted hook
```

## Documentation

Setup and the full integration reference live in the
[repository README](https://github.com/blaze-cache/blaze-cache#readme).

## Part of Blaze Cache

* [`@blaze-cache/core`](https://www.npmjs.com/package/@blaze-cache/core) — the cache itself
* [`@blaze-cache/axios`](https://www.npmjs.com/package/@blaze-cache/axios) — HTTP adapter
* [`@blaze-cache/fetch`](https://www.npmjs.com/package/@blaze-cache/fetch) — drop-in `fetch()` replacement
* [`@blaze-cache/react-query`](https://www.npmjs.com/package/@blaze-cache/react-query) — TanStack Query v5 mirror + hook

## License

[MIT](https://github.com/blaze-cache/blaze-cache/blob/main/LICENSE) © Blaze Cache
