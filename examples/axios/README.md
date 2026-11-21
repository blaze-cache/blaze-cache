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
* **Value storage** — the default keeps values as by-reference externrefs in Wasm;
  open with `?storage=js` (or use the toggle in the page header) to run the same demo
  with `storage: 'js'`, where values live in a JS Map and Wasm keeps keys, TTL, tags
  and stable ids. Each mode has its own IndexedDB namespace.
* **Reload** — entries persist to IndexedDB under `blaze-example-axios-wasm` / `blaze-example-axios-js`; the list paints
  instantly on return.

* **Multi-tab & persistence toggles** — the cache enables `multiTab` by default; add `?sync=off` to disable cross-tab propagation or `?persistence=off` to run memory-only. The page header shows the current state and has links that flip either option (reloading the demo to recreate the cache).

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

`pnpm build` here type-checks and produces a production bundle in `dist/`; `pnpm preview`
serves it with the same fake API the dev server runs.

## What it wires up

```ts
const cache = await createCache({
  capacity: 500,
  storage, // "wasm" (default) or "js" — from ?storage=js
  persistence: { namespace: `blaze-example-axios-${storage}`, debounceMs: 250 },
  wasmUrl,
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
