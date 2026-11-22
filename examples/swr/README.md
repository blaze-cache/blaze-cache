# Blaze Cache — SWR example

A standalone React + TypeScript demo for [`@blaze-cache/swr`](../../packages/swr): SWR seeded
from WebAssembly.

The page shows a todo list served by a tiny fake API (every request costs 400 ms of artificial
latency and the server counts its own hits). `useBlazeSWR` hands the persisted list to SWR as
`fallbackData`, so a reload paints instantly while SWR revalidates in the background — like
plain `useSWR`, but the data survives the session.

- **Instant first paint** — after a reload, the list appears from the mirror before the 400 ms
  fetch completes; `isValidating` shows the background revalidation.
- **Two-sided invalidation** — the Add button and “Invalidate ‘todos’” purge the persisted
  mirror (`cache.invalidateTags('todos')`) and revalidate the mounted hook via SWR's `mutate`.
- **Request log** — every real network fetch is logged with its latency; render-time reads use
  `peek` and don't move the hit rate.
- **Cache statistics** — hits/misses/entries/evictions/expirations for the mirror.
- **Value storage** — the default keeps values as by-reference externrefs in Wasm;
  open with `?storage=js` (or use the toggle in the page header) to run the same demo
  with `storage: 'js'`, where values live in a JS Map and Wasm keeps keys, TTL, tags
  and stable ids. Each mode has its own IndexedDB namespace.
- **Reload** — entries persist to IndexedDB under `blaze-example-swr-wasm` / `blaze-example-swr-js`.

- **Multi-tab & persistence toggles** — the cache enables `multiTab` by default; add `?sync=off` to disable cross-tab propagation or `?persistence=off` to run memory-only. The page header shows the current state and has links that flip either option (reloading the demo to recreate the cache).

## Run

From the repository root:

```sh
pnpm install
pnpm dev:swr
```

then open <http://localhost:5179>.

Or from this directory once the packages are built (`pnpm build` at the root):

```sh
pnpm --filter blaze-cache-example-swr dev
```

`pnpm build` here type-checks and produces a production bundle in `dist/`; `pnpm preview`
serves it with the same fake API the dev server runs.

## What it wires up

```tsx
const { data, isLoading, isValidating, mutate } = useBlazeSWR(cache, '/api/todos', fetcher, {
  ttlMs: 24 * 60 * 60_000,
  tags: ['swr', 'todos'],
});
```

Successful fetches are written back under SWR's own key serialization (`unstable_serialize`) —
a plain string key stays itself. Writes carry the `swr`/`todos` tags, so one
`cache.invalidateTags('todos')` wipes every persisted copy of the list.

The `serverHits` counter is read with plain `fetch`, so the UI can show how many requests
actually reached the fake server. The mock API lives in `vite.config.ts` as a dev-server
middleware; no separate backend is needed.
