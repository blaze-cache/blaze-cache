# Framework benchmark

Cache-store microbenchmarks for Blaze Cache vs real framework cache stores.

## Adapters

- **Blaze (WASM core)** — real `@blaze-cache/core`.
- **TanStack Query (query-core)** — real `@tanstack/query-core` `QueryClient` cache store
  (`setQueryData` / `getQueryData` / `removeQueries` / `clear`) in Node (no React render).
- **SWR (cache store)** — real SWR `initCache` store in Node (no React render).

`Map`/`QuickLRU` baselines are intentionally kept in [`../cache/`](../cache/).

## Fairness / measurement

- Same deterministic fill pattern and distinct per-entry payloads (`--value-bytes`).
- Fresh adapter instance per adapter/scenario; probes validate observable behavior before timing.
- `prepare()` runs outside the timed region before every sample.
- `globalThis.gc?.()` is called before each timed sample when Node is run with `--expose-gc`.
- Warmup samples are discarded (default 2); recorded samples report **p50** and **p95**.
- Defaults: `--capacity=10000 --iterations=50000 --samples=7 --warmup=2 --value-bytes=256`.
- `invalidate-by-key` deletes a **distinct pre-filled key per iteration** (pure delete). It requires `--iterations <= --capacity`.
- Adapter order is fixed per scenario; read small gaps cautiously.

## Caveats (safe claims)

- **Cache-store microbenchmark only** (Node). Not a full React/TanStack Query hook or SWR hook render/fetch benchmark.
- **TanStack Query costs include query-key hashing/normalization and query-cache bookkeeping** (real for `QueryClient` API users), not just raw storage.
- **SWR uses the real SWR cache wrapper in Node**; real SWR app paths also pay key serialization and hook/render behavior.
- For Map/QuickLRU engine baselines, use `benchmarks/cache`.
- These scenarios do point operations on a filled cache; add eviction/persistence/hydration scenarios before making broader claims.

## Run

```sh
pnpm bench:framework
pnpm bench:framework -- --capacity=50000 --iterations=50000 --samples=7 --warmup=2 --value-bytes=1024
pnpm bench:framework -- --capacity=100000 --iterations=100000 --samples=7 --value-bytes=4096
pnpm bench:framework -- --json
```

`--expose-gc` is used by the package script.

## Scenarios

| Scenario | Timed op | Notes |
| --- | --- | --- |
| `warm-hit` | `get(key)` | present key, filled cache |
| `miss` | `get(key)` | absent key, filled cache |
| `write` | `set(key, value)` | fresh value object per iteration |
| `invalidate-by-key` | `delete(key)` | distinct key per iteration; `iterations <= capacity` |
