<p align="center">
  <img src="https://raw.githubusercontent.com/blaze-cache/blaze-cache/main/docs/blaze-cache-logo.png" alt="Blaze Cache logo" width="150">
</p>

<h1 align="center">@blaze-cache/react-query</h1>

Persist TanStack Query v5 in WebAssembly — instant first paint after reload while
stale-while-revalidate still works.

## Install

```sh
npm install @blaze-cache/react-query@beta   # @tanstack/react-query ≥ 5 is a peer dependency
```

`@beta` is npm's dist-tag for the prerelease; drop it to install the last stable
release.

## Quick start

```ts
// src/queryClient.ts
import { createBlazeQueryClient } from '@blaze-cache/react-query';
import { cache } from './blaze.js'; // a cache created by @blaze-cache/core

export const queryClient = createBlazeQueryClient({ cache });
```

```tsx
import { useBlazeQuery } from '@blaze-cache/react-query';

const todos = useBlazeQuery(cache, {
  queryKey: ['todos'],
  queryFn: () => api.get('/todos').then((response) => response.data),
});
```

A mirrored query is injected as `initialData` **with its original `dataUpdatedAt`** —
the first paint after a reload comes from the cache instantly, while TanStack still
treats the data as stale and refetches in the background. Options that already carry
`initialData` or `initialDataUpdatedAt` are left entirely alone, and the mirror is looked
up with TanStack's own hashing, so a custom `queryKeyHashFn` is honoured.

## Behaviour

* Successful fetches and `setQueryData` are written to the shared cache.
* An **explicit** `removeQueries` or `clear` deletes from it. Ordinary garbage
  collection — a query left unobserved past `gcTime` — deliberately does **not**: that
  is in-session housekeeping, and the persisted copy is what paints the next session.
* Invalidation keeps the data too, so stale-while-revalidate always has something to
  paint.
* Renders never touch cache statistics: the pre-fetch lookup prefers `peek` over `get`,
  so StrictMode's double render cannot move the hit rate or influence eviction.
* That holds for events too — `peek` emits nothing, so renders are silent; the writes the
  mirror performs surface as `set` events on the shared cache:

  ```ts
  cache.on('set', ({ key }) => console.log('mirrored', key));
  ```

  `on` returns its own unsubscribe function; the full event table is in the
  [repository README](https://github.com/blaze-cache/blaze-cache#events).
* Error states stay in TanStack — only data crosses into the cache.
* TanStack owns freshness *within* a session; Blaze Cache owns it *across* sessions.

## Documentation

Setup and the full integration reference live in the
[repository README](https://github.com/blaze-cache/blaze-cache#readme).

## Part of Blaze Cache

* [`@blaze-cache/core`](https://www.npmjs.com/package/@blaze-cache/core) — the cache itself
* [`@blaze-cache/axios`](https://www.npmjs.com/package/@blaze-cache/axios) — HTTP adapter
* [`@blaze-cache/fetch`](https://www.npmjs.com/package/@blaze-cache/fetch) — drop-in `fetch()` replacement

## License

[MIT](https://github.com/blaze-cache/blaze-cache/blob/main/LICENSE) © Blaze Cache
