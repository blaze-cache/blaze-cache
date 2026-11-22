import { createCache } from '@blaze-cache/core'
import type { BlazeCache } from '@blaze-cache/core'

/**
 * A standalone playground for `@blaze-cache/core`.
 *
 * No wasm URL import here: the default path fetches the binary shipped inside the package,
 * resolved relative to its own module. That works because this example excludes
 * `@blaze-cache/core` from Vite's pre-bundle (see `vite.config.ts`) — pre-bundling would
 * rewrite `import.meta.url`, which is exactly when you pass `wasmUrl` instead.
 *
 * Entries are written straight into one cache, persisted to IndexedDB under a
 * storage-specific namespace, so a reload paints them back from storage. The playground can
 * recreate the cache in either supported storage mode:
 *
 * * `wasm` (default) — values are by-reference externrefs held in the Rust slab.
 * * `js` — values live in a JS `Map<id, V>`; Wasm keeps metadata and stable entry ids.
 *
 * The namespaces differ so switching modes cannot hydrate rows written by the other mode's
 * value store into a cache that expects a different ownership shape.
 *
 * Multi-tab sync is enabled here so two open copies of this page behave like two tabs: a `set`
 * in one reaches the other over BroadcastChannel, and both write through to the same IndexedDB
 * bucket. Writes use `immediate` mode so a Refetch in another tab sees the value right away.
 * Persistence itself is optional — turning it off keeps the cache memory-only (sync still works).
 */
export type ExampleStorage = 'wasm' | 'js'

export async function createExampleCache(
  storage: ExampleStorage = 'wasm',
  multiTab = true,
  persistence = true,
): Promise<BlazeCache<string>> {
  const namespace = `blaze-example-core-${storage}`
  return createCache<string>({
    capacity: 100,
    storage,
    persistence: persistence ? { namespace, writeMode: 'immediate' } : false,
    ...(multiTab ? { multiTab: { enabled: true } } : {}),
  })
}
