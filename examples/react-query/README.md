# Blaze Cache — TanStack Query example

A standalone React + TypeScript demo for [`@blaze-cache/react-query`](../../packages/react-query):
TanStack Query v5 queries mirrored into WebAssembly.

The page shows a todo list served by a tiny fake API (every request costs 400 ms of artificial
latency and the server counts its own hits). Because mirrored entries keep their original
`dataUpdatedAt`, a reload paints instantly from the persisted mirror while the query
refetches in the background — TanStack's own stale-while-revalidate, surviving sessions.

* **Instant first paint** — after a reload, the list appears from the mirror before the 400 ms
  fetch completes; `isFetching` shows the background revalidation.
* **Two-sided invalidation** — “Invalidate ‘todos’” marks the query stale in TanStack **and**
  purges the persisted mirror entry via `invalidateBlazeQueries`.
* **Request log** — every real network fetch is logged with its latency; cache reads taken at
  render time use `peek` and don't show up (they don't move the hit rate either).
* **Cache statistics** — hits/misses/entries/evictions/expirations for the mirror.
* **Reload** — entries persist to IndexedDB under `blaze-example-react-query`.

## Run

From the repository root:

```sh
pnpm install
pnpm dev:react-query
```

then open <http://localhost:5178>.

Or from this directory once the packages are built (`pnpm build` at the root):

```sh
pnpm --filter blaze-cache-example-react-query dev
```

`pnpm build` here type-checks and produces a production bundle in `dist/`; `pnpm preview`
serves it with the same fake API the dev server runs.

## What it wires up

`src/blaze.ts` creates the shared cache, the TanStack client with mirroring enabled, and the
fetcher:

```ts
export const queryClient = createBlazeQueryClient({
  cache,
  ttlMs: 24 * 60 * 60_000,
  tags: ['react-query', 'todos'],
});
```

`src/main.tsx` wraps the app in `<QueryClientProvider>`. `src/App.tsx` reads the query with
`useBlazeQuery(cache, { queryKey: ['todos'], ... })` and writes with `useBlazeMutation(..., {
  invalidate: { queryKey: ['todos'], tags: ['todos'] },
})` — on success TanStack refetches and the mirror is purged in the same step.

The `serverHits` counter is read with plain `fetch`, so the UI can show how many requests
actually reached the fake server. The mock API lives in `vite.config.ts` as a dev-server
middleware; no separate backend is needed.
