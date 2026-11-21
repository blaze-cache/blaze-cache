# Blaze Cache — ofetch example

A standalone React + TypeScript browser demo for [`@blaze-cache/ofetch`](../../packages/ofetch):
ofetch (`$fetch`) hooks backed by a WebAssembly cache, with TTLs, tag invalidation and
IndexedDB persistence.

Built with Vite and React 19, matching the other per-package examples — no query library, no
state management beyond `useState`, so the adapter's behaviour is easy to see.

The page shows a todo list served by a tiny fake API (every request costs 400 ms of artificial
latency and the server counts its own hits). From there you can watch the adapter work:

* **Miss → Hit** — the first fetch pays 400 ms and is marked `x-blaze-cache: MISS`; the next is
  instant and marked `HIT`. Entries stay fresh for 15 s.
* **Request log** — a live list of every request with its marker, latency and URL. POSTs are
  never cached (only `GET` is cacheable by default).
* **Cache statistics** — hits, misses, hit rate, entries, evictions and expirations, straight
  from the cache.
* **Invalidate / Clear / Prune** — drop everything the adapter stored (`invalidateTags('ofetch')`),
  empty the cache, or reclaim expired entries.
* **Value storage** — the default keeps values as by-reference externrefs in Wasm;
  open with `?storage=js` (or use the toggle in the page header) to run the same demo
  with `storage: 'js'`, where values live in a JS Map and Wasm keeps keys, TTL, tags
  and stable ids. Each mode has its own IndexedDB namespace.
* **Reload** — entries are persisted to IndexedDB, so the list paints instantly on reload and
  revalidates in the background.

* **Multi-tab & persistence toggles** — the cache enables `multiTab` by default; add `?sync=off` to disable cross-tab propagation or `?persistence=off` to run memory-only. The page header shows the current state and has links that flip either option (reloading the demo to recreate the cache).

## Run

From the repository root:

```sh
pnpm install
pnpm dev:ofetch
```

then open <http://localhost:5180>.

Or from this directory once the packages are built (`pnpm build` at the root):

```sh
pnpm --filter blaze-cache-example-ofetch dev
```

`pnpm build` here type-checks and produces a production bundle in `dist/`; `pnpm preview`
serves it with the same fake API the dev server runs.

## What it wires up

`src/blaze.ts` creates one cache and one cached ofetch instance; `src/App.tsx` renders the
interface and calls the adapter:

```ts
const cache = await createCache({
  capacity: 500,
  storage, // "wasm" (default) or "js" — from ?storage=js
  persistence: { namespace: `blaze-example-ofetch-${storage}`, debounceMs: 250 },
  wasmUrl,                     // `?url` import — the binary ships inside @blaze-cache/core
});

export const api = createBlazeOfetch(cache, {
  baseURL: window.location.origin, // absolute URL so the adapter can key the request
  ttlMs: 15_000,
  varyHeaders: ['authorization', 'origin'],
});
```

`baseURL` is the current origin so every request is keyed on an absolute URL — the adapter only
caches requests whose URL names its host. `varyHeaders` includes `origin` because the Vite dev
server answers every response with `Vary: Origin`, and the adapter will not store a response
varying on a header it does not key on — without it, the demo would be a permanent MISS.

A plain `api('/api/todos')` call returns parsed JSON, which has nowhere to carry the marker.
The demo uses `api.raw('/api/todos')` instead: it returns the `FetchResponse` with the
`x-blaze-cache` header and the parsed payload on `_data`. Writes go through `api` directly
(`method: 'POST'`), which the adapter leaves uncached. The `serverHits` counter is read with
plain `fetch`, so the UI can show how many requests actually reached the fake server — a cached
read never touches it. The mock API lives in `vite.config.ts` as a dev-server middleware, so no
separate backend is needed.
