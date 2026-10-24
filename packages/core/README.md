<p align="center">
  <img src="https://raw.githubusercontent.com/blaze-cache/blaze-cache/main/docs/blaze-cache-logo.png" alt="Blaze Cache logo" width="150">
</p>

<h1 align="center">@blaze-cache/core</h1>

WebAssembly client-side cache for the browser: SIEVE eviction, per-entry TTLs, tag
invalidation and optional IndexedDB persistence.

The engine behind
[`@blaze-cache/axios`](https://www.npmjs.com/package/@blaze-cache/axios) and
[`@blaze-cache/react-query`](https://www.npmjs.com/package/@blaze-cache/react-query) —
also usable on its own.

## Install

```sh
npm install @blaze-cache/core
```

## Quick start

```ts
import { createCache } from '@blaze-cache/core';

const cache = await createCache({ capacity: 1000, persistence: { namespace: 'app' } });

cache.set('user:42', { name: 'Ada' }, { ttlMs: 30_000, tags: ['user:42'] });

cache.get('user:42');              // { name: 'Ada' } — counted as a hit
cache.invalidateTags('user:42');   // removes it, synchronously, and syncs IndexedDB
cache.stats();                     // { hits, misses, evictions, expirations, … }
```

`create` instantiates the wasm module once, so everything after it is **synchronous** —
`get`/`set` never allocate a `Promise`.

## Good to know

* **The `.wasm` ships inside this package** — no CDN setup. If your bundler
  pre-bundles dependencies, point at it explicitly:

  ```ts
  import wasmUrl from '@blaze-cache/core/pkg/blaze_cache_wasm_bg.wasm?url';

  const cache = await createCache({ wasm: wasmUrl });
  ```

* **Types are bundled** — no `@types/*` packages to install.
* **ESM only, browser only.** Node/SSR targets are out of scope by design.
* **Persistence is optional** and off by default; a blocked IndexedDB (private mode)
  degrades to memory-only instead of breaking the app.

## Documentation

Setup, persistence, eviction, tags and the full API are documented in the
[repository README](https://github.com/blaze-cache/blaze-cache#readme).

## License

[MIT](https://github.com/blaze-cache/blaze-cache/blob/main/LICENSE) © Blaze Cache
