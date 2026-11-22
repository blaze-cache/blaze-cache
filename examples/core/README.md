# Blaze Cache — core example

A standalone React + TypeScript playground for [`@blaze-cache/core`](../../packages/core): the
WebAssembly cache itself — no HTTP layer involved.

What you can do:

- **Set / Get / Delete** entries with optional TTL (empty = no expiry) and comma-separated tags.
- **Multi-tab sync** — on by default: each cache opens a `BroadcastChannel` on the shared
  namespace, so a `set`/`delete`/`clear`/tag-invalidation in one tab reaches every other open
  tab. The toggle recreates the cache when changed.
- **Persistence** — on by default: writes go through to IndexedDB (`writeMode: 'immediate'`, so
  a refetch in another tab sees them at once). Turn it off for a memory-only cache — multi-tab
  sync still works, but a reload no longer restores entries.
- **Refetch** — re-reads the key from the shared IndexedDB bucket when persistence is on (and
  from the other tab when sync is on), or just from the current cache when it is off. It shows
  the newest value rather than inventing a local one — the normal follow-up to an invalidation.
- **Inspect live entries** — key, value, remaining TTL and tags, refreshed after every action.
- **Invalidate by tag** — **removes** every entry carrying that tag (it does not mark it stale).
- **Prune / Clear / Reset stats** — reclaim expired entries, empty the cache, zero the counters.
- **Watch the event log** — `set`, `get` hits/misses, `delete`, `invalidate`, `prune`,
  `evict`/`expire`, live as they happen.
- **Switch value storage** — `wasm` (default) keeps values as by-reference externrefs in the
  Rust slab; `js (hybrid)` keeps them in a JS `Map<id, V>` while Wasm owns keys, TTL, tags and
  stable ids. Switching recreates the cache under a storage-specific IndexedDB namespace
  (`blaze-example-core-wasm` / `blaze-example-core-js`), so the two modes never mix values.
  Every operation — tags, events, stats, persistence — behaves the same in both.
- **Reload** — entries persist to IndexedDB under that namespace and are painted back from
  storage on the next visit.

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

`pnpm build` here type-checks and produces a production bundle in `dist/`; `pnpm preview`
serves it (this example has no fake API — the playground writes straight into the cache).

## What it wires up

`src/blaze.ts` exposes `createExampleCache(storage)` — a `BlazeCache<string>` with 100 entries
of capacity and a 250 ms IndexedDB debounce, under the `blaze-example-core-<storage>`
namespace. It loads the wasm binary through the package's zero-config default — no `?url`
import, the binary ships inside `@blaze-cache/core` and is fetched relative to the package's
own module (which is why `vite.config.ts` keeps the package out of the pre-bundle).
`src/App.tsx` renders the playground; it recreates the cache and re-subscribes with
`cache.on(...)` whenever the storage toggle changes, disposing the previous instance.
