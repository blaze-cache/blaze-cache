# Blaze Cache — fetch example

A standalone React + TypeScript demo for [`@blaze-cache/fetch`](../../packages/fetch): a
drop-in `fetch()` replacement backed by WASM, with TTLs, `Cache-Control` support, SIEVE
eviction and IndexedDB persistence.

The page shows a todo list served by a tiny fake API (every request costs 400 ms of artificial
latency and the server counts its own hits). The wrapper marks each response
`x-blaze-cache: HIT`, `MISS` or `STALE`.

* **Miss → Hit** — the first fetch pays 400 ms; the next is instant. Entries stay fresh for
  15 s.
* **Request log** — every request with its marker, latency and URL. POSTs are never cached.
* **Cache statistics** — hits, misses, hit rate, entries, evictions and expirations.
* **Invalidate / Clear / Prune** — `invalidateTags('fetch')`, empty the cache, or reclaim
  expired entries.
* **Reload** — entries persist to IndexedDB under `blaze-example-fetch`; the list paints
  instantly on return.

## Run

From the repository root:

```sh
pnpm install
pnpm dev:fetch
```

then open <http://localhost:5177>.

Or from this directory once the packages are built (`pnpm build` at the root):

```sh
pnpm --filter blaze-cache-example-fetch dev
```

`pnpm build` here type-checks and produces a production bundle in `dist/`; `pnpm preview`
serves it with the same fake API the dev server runs.

## What it wires up

```ts
const cache = await createCache({
  capacity: 500,
  persistence: { namespace: 'blaze-example-fetch', debounceMs: 250 },
  wasmUrl,
});

export const blazeFetch = createBlazeFetch(cache, {
  ttlMs: 15_000,
  varyHeaders: ['authorization', 'origin'],
});
```

`varyHeaders` includes `origin` because the Vite dev server answers every response with
`Vary: Origin`, and the wrapper will not store a response varying on a header it does not key
on — without it, the demo would be a permanent MISS. The wrapper supports
`staleWhileRevalidate` too; this demo leaves it off, so only `HIT` and `MISS` appear.

The `serverHits` counter is read with plain `fetch`, so the UI can show how many requests
actually reached the fake server. The mock API lives in `vite.config.ts` as a dev-server
middleware; no separate backend is needed.
