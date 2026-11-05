# Blaze Cache — axios example

A standalone React + TypeScript demo for [`@blaze-cache/axios`](../../packages/axios): the
axios adapter that caches GET responses in WASM.

The page shows a todo list served by a tiny fake API (every request costs 400 ms of artificial
latency and the server counts its own hits). The adapter turns cache reads into instant
replays — marked `x-blaze-cache: HIT` (`response.fromBlazeCache` is also available when you
cast the response).

* **Miss → Hit** — the first fetch pays 400 ms; the next is instant. Entries stay fresh for
  15 s.
* **Request log** — every request with its marker, latency and URL. POSTs are never cached.
* **Cache statistics** — hits, misses, hit rate, entries, evictions and expirations.
* **Invalidate / Clear / Prune** — `invalidateTags('axios')`, empty the cache, or reclaim
  expired entries.
* **Reload** — entries persist to IndexedDB under `blaze-example-axios`; the list paints
  instantly on return.

## Run

From the repository root:

```sh
pnpm install
pnpm dev:axios
```

then open <http://localhost:5176>.

Or from this directory once the packages are built (`pnpm build` at the root):

```sh
pnpm --filter blaze-cache-example-axios dev
```

`pnpm build` here type-checks and produces a production bundle in `dist/`.

## What it wires up

```ts
const cache = await createCache({
  capacity: 500,
  persistence: { namespace: 'blaze-example-axios', flushDelayMs: 250 },
  wasm: wasmUrl,
});

const api = axios.create({ baseURL: '/' });
installBlazeCache(api, {
  cache,
  ttlMs: 15_000,
  varyHeaders: ['authorization', 'origin'],
});
```

`varyHeaders` includes `origin` because the Vite dev server answers every response with
`Vary: Origin`, and the adapter will not store a response varying on a header it does not key
on — without it, the demo would be a permanent MISS.

The `serverHits` counter is read with plain `fetch`, so the UI can show how many requests
actually reached the fake server. The mock API lives in `vite.config.ts` as a dev-server
middleware; no separate backend is needed.
