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

## API

The integration is one cache + a set of hooks, helpers and hydration functions. All of
them take `(cache, client?, options?)` — the cache first, then the `QueryClient` (from
context when omitted by a hook), then the options.

| Export | What it does |
| --- | --- |
| `createBlazeQueryClient` / `syncBlazeQueryCache` | Mirror TanStack cache writes into the Blaze Cache (see [Behaviour](#behaviour)). |
| `useBlazeQuery` | `useQuery` seeded from the mirror. |
| `useBlazeInfiniteQuery` | `useInfiniteQuery` seeded with the whole `InfiniteData` (all pages) as `initialData`. |
| `useBlazeQueries` | `useQueries` over several keys, each seeded independently. |
| `useBlazeMutation` | `useMutation` that invalidates queries after success. |
| `prefetchBlazeQuery` | Imperatively seed + prefetch, mirroring the fetched result. |
| `setBlazeQueryData` | Write data through to the mirror (TanStack first, then Blaze). |
| `invalidateBlazeQueries` | Invalidate in TanStack **and** purge the mirror. |
| `removeBlazeQueries` | Remove from TanStack **and** purge the mirror. |
| `dehydrateBlazeQueryClient` / `hydrateBlazeQueryClient` | Serialize / restore the mirror as a TanStack `DehydratedState`. |

## Example usage

### `useBlazeQuery` — instant first paint

```tsx
import { useBlazeQuery } from '@blaze-cache/react-query';

function Todos({ userId }: { userId: string }) {
  const todos = useBlazeQuery(cache, {
    queryKey: ['todos', userId],
    queryFn: () => api.get('/todos', { userId }).then((r) => r.data),
  });
  // renders cached data immediately; refetches stale data in the background
}
```

### `useBlazeInfiniteQuery` — instant first paint for infinite lists

```tsx
const feed = useBlazeInfiniteQuery(cache, {
  queryKey: ['feed', userId],
  queryFn: ({ pageParam }) => api.get('/feed', { userId, pageParam }),
  initialPageParam: 0,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
});
// feed.data?.pages — every page cached before the reload, immediately
```

The whole `InfiniteData` payload (pages + page params) is mirrored as one entry and seeded
back as `initialData`, with the original `dataUpdatedAt`, so the first paint after a reload
shows all previously loaded pages while TanStack still refetches.

### `useBlazeQueries` — parallel instant first paint

```tsx
const [profile, settings, notifications] = useBlazeQueries(cache, {
  queries: [
    { queryKey: ['profile', userId], queryFn: () => api.profile(userId) },
    { queryKey: ['settings'], queryFn: () => api.settings },
    { queryKey: ['notifications', userId], queryFn: () => api.notifications(userId) },
  ],
});
```

### `useBlazeMutation` — keep the mirror in sync after writes

```tsx
const addTodo = useBlazeMutation(cache, {
  mutationFn: (text: string) => api.post('/todos', { userId, text }),
  invalidate: { queryKey: ['todos', userId] }, // or { tags: ['todos', `user:${userId}`] }
  onSuccess: (data) => toast('Todo added'),
});
```

On success the mutation invalidates the given queries — TanStack marks them stale (active
ones refetch) and the matching persisted records are purged, so a reload cannot paint
pre-write data. Your own `onSuccess` still runs first, and invalidation is skipped if it
throws.

### `prefetchBlazeQuery` — warm the mirror before navigation

```ts
await prefetchBlazeQuery(cache, queryClient, {
  queryKey: ['todos', userId],
  queryFn: () => api.get('/todos', { userId }).then((r) => r.data),
  staleTime: 5 * 60_000, // serve within the window from the mirror
});
```

### `setBlazeQueryData` — write through to the mirror

```ts
setBlazeQueryData(cache, queryClient, ['settings', userId], settings, {
  tags: ['settings', `user:${userId}`],
});
```

### `invalidateBlazeQueries` / `removeBlazeQueries` — purge persisted data on writes

```ts
// After a mutation that changes a list:
await invalidateBlazeQueries(cache, queryClient, { queryKey: ['todos', userId] });
// …or by tag, which also covers queries from earlier sessions:
invalidateBlazeQueries(cache, queryClient, { tags: ['todos', `user:${userId}`] });

removeBlazeQueries(cache, queryClient, { tags: ['todos', `user:${userId}`] }); // after logout
```

### `dehydrateBlazeQueryClient` / `hydrateBlazeQueryClient` — server-side persistence

```ts
// Server: serialize whatever the mirror holds for this request.
const dehydratedState = dehydrateBlazeQueryClient(cache);

// Client: restore into the (synced) client, then keep it persisted again.
hydrateBlazeQueryClient(cache, queryClient, dehydratedState, {
  tags: ['ssr', `user:${userId}`],
});
```

## Documentation

Setup and the full integration reference live in the
[repository README](https://github.com/blaze-cache/blaze-cache#readme).

## Part of Blaze Cache

* [`@blaze-cache/core`](https://www.npmjs.com/package/@blaze-cache/core) — the cache itself
* [`@blaze-cache/axios`](https://www.npmjs.com/package/@blaze-cache/axios) — HTTP adapter
* [`@blaze-cache/fetch`](https://www.npmjs.com/package/@blaze-cache/fetch) — drop-in `fetch()` replacement

## License

[MIT](https://github.com/blaze-cache/blaze-cache/blob/main/LICENSE) © Blaze Cache
