# Blaze Cache — ky example

A standalone React + TypeScript browser demo for [`@blaze-cache/ky`](../../packages/ky): ky
hooks backed by a WebAssembly cache, with TTLs, tag invalidation and IndexedDB persistence.

Built with Vite and React 19, matching the other per-package examples — no query library, no
state management beyond `useState`, so the adapter's behaviour is easy to see.

The page shows a todo list served by a tiny fake API (every request costs 400 ms of artificial
latency and the server counts its own hits). From there you can watch the adapter work:

* **Miss → Hit** — the first fetch pays 400 ms and is marked `x-blaze-cache: MISS`; the next is
  instant and marked `HIT`. Entries stay fresh for 15 s.
* **Request log** — a live list of every request with its marker, latency and URL. POSTs are
  never cached.
* **Cache statistics** — hits, misses, hit rate, entries, evictions and expirations, straight
  from the cache.
* **Invalidate / Clear / Prune** — drop everything the adapter stored (`invalidateTags('ky')`),
  empty the cache, or reclaim expired entries.
* **Reload** — entries are persisted to IndexedDB, so the list paints instantly on reload and
  revalidates in the background.

## Run

From the repository root:

```sh
pnpm install
pnpm dev:ky
```

then open <http://localhost:5174>.

Or from this directory once the packages are built (`pnpm build` at the root):

```sh
pnpm --filter blaze-cache-example-ky dev
```

`pnpm build` here type-checks and produces a production bundle in `dist/`; `pnpm preview`
serves it with the same fake API the dev server runs.

## What it wires up

`src/blaze.ts` creates one cache and one ky instance; `src/App.tsx` renders the
interface and calls the adapter:

```ts
const cache = await createCache({
  capacity: 500,
  persistence: { namespace: 'blaze-example-ky', debounceMs: 250 },
  wasmUrl,                     // `?url` import — the binary ships inside @blaze-cache/core
});

export const api = createBlazeKy(cache, {
  baseUrl: '/',             // ky v2 spelling; ky v1 calls this `prefixUrl`
  ttlMs: 15_000,
  varyHeaders: ['authorization', 'origin'],
});
```

`varyHeaders` includes `origin` because the Vite dev server answers every response with
`Vary: Origin`, and the adapter will not store a response varying on a header it does not
key on — without it, the demo would be a permanent MISS.

Components read `cache.stats()` after every action to refresh the statistics panel; the
request log shows the `x-blaze-cache` marker ky sets on each response.

The `serverHits` counter is read with plain `fetch`, so the UI can show how many requests
actually reached the fake server — a cached read never touches it. The mock API lives in
`vite.config.ts` as a dev-server middleware, so no separate backend is needed.
