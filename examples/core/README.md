# Blaze Cache — core example

A standalone React + TypeScript playground for [`@blaze-cache/core`](../../packages/core): the
WebAssembly cache itself — no HTTP layer involved.

What you can do:

* **Set / Get / Delete** entries with optional TTL (empty = no expiry) and comma-separated tags.
* **Inspect live entries** — key, value, remaining TTL and tags, refreshed after every action.
* **Invalidate by tag** — removes every entry carrying that tag.
* **Prune / Clear / Reset stats** — reclaim expired entries, empty the cache, zero the counters.
* **Watch the event log** — `set`, `get` hits/misses, `delete`, `invalidate`, `prune`,
  `evict`/`expire`, live as they happen.
* **Reload** — entries persist to IndexedDB under the `blaze-example-core` namespace and are
  painted back from storage on the next visit.

## Run

From the repository root:

```sh
pnpm install
pnpm dev:core
```

then open <http://localhost:5175>.

Or from this directory once the packages are built (`pnpm build` at the root):

```sh
pnpm --filter blaze-cache-example-core dev
```

`pnpm build` here type-checks and produces a production bundle in `dist/`.

## What it wires up

`src/blaze.ts` creates one `BlazeCache<string>` with 100 entries of capacity, persisted to
IndexedDB (`namespace: 'blaze-example-core'`, 250 ms debounce), loading the wasm binary
through the package's zero-config default — no `?url` import, the binary ships inside
`@blaze-cache/core` and is fetched relative to the package's own module (which is why
`vite.config.ts` keeps the package out of the pre-bundle). `src/App.tsx` renders the
playground and subscribes to every cache event with `cache.on(...)`.
