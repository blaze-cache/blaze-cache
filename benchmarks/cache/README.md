# Cache benchmark

How fast is `@blaze-cache/core` — really — against the caches you would otherwise reach for:
the native [`Map`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Map),
[`quick-lru`](https://github.com/sindresorhus/quick-lru),
[`lru-cache`](https://github.com/isaacs/node-lru-cache), and the LRU/TTL/tag stack you would
write by hand? The same suite runs in Node and, via [`../browser/`](../browser/), in a real
browser. Published numbers and methodology live in
[`docs/benchmarks/RESULTS.md`](../../docs/benchmarks/RESULTS.md).

## Run it

```sh
pnpm bench                  # builds the wasm + core, then the full table (~40s)
pnpm bench -- --quick       # ~10s smoke run
pnpm bench -- --filter=get  # only scenarios whose id contains "get"
pnpm bench -- --capacity=5000
pnpm bench -- --json        # results as JSON
pnpm bench -- --payload=large --payload-kind=bytes
pnpm bench -- --matrix      # all five payload sizes in one report
```

`pnpm bench` rebuilds the wasm and the core first, so the numbers are never taken against a
stale binary, and runs `node` with `--expose-gc` so garbage can be collected *between*
samples rather than during them. Without `--expose-gc` the table still prints, but the
spread column gets noisier.

## What is compared

Each scenario picks three or four of these.

| Adapter | Store | Eviction | TTL | Tags |
| --- | --- | --- | --- | --- |
| `Map` | native `Map` | **none** — grows forever | none | none |
| `QuickLRU` | `quick-lru` v8 | LRU at `maxSize` | built-in `maxAge` | none |
| `lru-cache` | `lru-cache` v11 | LRU at `max` | built-in `ttl` | none |
| `Map + LRU` | `Map` + one layer you would write | hand-rolled LRU | none | none |
| `Map + LRU + TTL + tags` | `Map` + three layers you would write | hand-rolled LRU | hand-rolled deadline check | key→tags / tag→keys mirror |
| `QuickLRU + tag index` | `quick-lru` + one layer you would write | LRU | built-in `maxAge` | the same mirror |
| `lru-cache + tag index` | `lru-cache` + one layer you would write | LRU | built-in `ttl` | the same mirror |
| `blaze-cache` | Rust core, through wasm | SIEVE at `capacity` | built-in | built-in |
| `blaze-cache + persistence` | core + real write-through layer | SIEVE | built-in | built-in |
| `Map`/`QuickLRU + written queue` | a store + hand-rolled pending writes | as the store | as the store | none |

The hand-written wrappers exist so that a store without a feature still has to *do the work*
of that feature — otherwise blaze would be timed doing work its rivals never attempted, or
spared it, and neither comparison means anything. The stacked `Map` row is the point of the
exercise: **it is the cache you would otherwise write and then own**. QuickLRU and lru-cache get
their LRU and their deadline natively, so a hand-rolled stand-in is never put up against a
built-in; they are wrapped only for the tag mirror. Every adapter is a one-call-deep class
wrapper, so none gets to skip a method call the others pay.

## Payload matrix

`--payload=tiny|small|medium|large|massive` (≤64 B, ~1 KB, ~10 KB, ~100 KB, ~1 MB) and
`--payload-kind=object|bytes` select one cell of a 5 × 2 matrix; `--matrix` runs all five sizes
at once. Values come from a small pool of shared references, so the number measures the cost of
the boundary crossing at a given working-set size — never the cost of building a fresh 1 MB
object on every `set`. This matters because blaze stores values **by reference**: if payload
size barely moves `get`/`set`, the original "serialising JS objects is the bottleneck" premise
is wrong. The published matrix shows exactly that — see
[`docs/benchmarks/RESULTS.md`](../../docs/benchmarks/RESULTS.md).

## Scenarios

Ten: three diagnostics, one control, the headline, five scenario types added in Stage 1.
`overwrite`, `get-with-ttl` and `set-with-tags` were folded into the headline — they measured
TTL and tags *in isolation*, where a rival can look cheap because nothing else is being asked
of it, and their story is now told by the control/headline pair.

| Scenario | Adapters | What it measures |
| --- | --- | --- |
| `fill` | Map, QuickLRU, lru-cache, blaze | cold insert of `capacity` distinct keys |
| `get-hit` | as above | random reads over the resident set |
| `get-miss` | as above | reads from a disjoint namespace, against a full cache |
| `mixed-90-10` | as above | 90/10 hot-read/cold-write under pressure — **the control** |
| `full-featured` | Map stack, QuickLRU + tags, lru-cache + tags, blaze | the same load plus TTL, tags and periodic invalidation — **the headline** |
| `ttl-churn` | the three full-featured stacks | lazy expiry reclamation on every read |
| `eviction-pressure` | Map + LRU, QuickLRU, lru-cache, blaze | a reclaim on every write into a full cache |
| `tag-invalidation-scale` | the three full-featured stacks | a 128-tag index under a background read load |
| `persistence-flush` | blaze + persistence, Map/QuickLRU + queue | a whole 10 000-record flush (reported per record) |
| `hydration` | as above | restoring 10 000 stored records (reported per record) |

The persistence pair is async: one timed operation is the whole batch, divided by the record
count so its `ns/op` is comparable to the point operations. blaze uses its real write-through
layer over an in-memory `CachePersistence` adapter; the rivals use an equivalent hand-rolled
pending-write queue over the same store. Node has no IndexedDB.

## Results

Published numbers for Node **and** headless Chrome, across all five payload sizes and both value
representations, are in [`docs/benchmarks/RESULTS.md`](../../docs/benchmarks/RESULTS.md), with
the raw JSON in [`../results/`](../results/). The headline is reported next to its
feature-equivalent control table, and the boundary-crossing caveat is stated explicitly — there
is no unqualified "faster than JS" claim. In short: blaze is roughly on par with the three
layers you would write yourself (faster on Node reads, slightly slower in the browser) and
pays a clear write-path premium against native LRU libraries.

## Browser and CI

`pnpm bench:browser` (from the repo root) starts Vite, drives headless Chrome with Playwright
and runs **this exact suite** — same harness, same probes, same scenarios — through the browser
adapter registry, where blaze fetches its own wasm asset over HTTP. Node suites remain the CI
regression gate. `pnpm bench:ci` runs `--quick` (5 samples × 60 ms), compares each row against
[`../results/baseline.node.json`](../results/baseline.node.json) after normalising by its
scenario's median, trimming single-sample outliers and allowing for the remaining spread, and
fails any regression above 20%. In CI the baseline is regenerated **from the base revision on
the same runner** before the PR head is measured, so laptop-vs-hosted-runner drift cannot fail a
PR; the checked-in file is the local convenience baseline.
## Methodology

* **Identical work, not similar work.** Every adapter in a scenario is fed the same
  precomputed key sequence — a deterministic, pre-shuffled ring indexed with `i & mask`
  rather than `i % n`, so the modulo is a bitmask and costs the same negligible amount for
  everyone. Reads hit a random resident key, not a walk a prefetcher could make free.
* **Calibrated batches.** A batch is doubled until it costs ~20 ms, then scaled to ~120 ms,
  so a 30 ns `Map.get` and a 120 ns wasm round trip are measured over comparable spans
  instead of one of them being timed by a clock noisier than the work itself.
* **Warm-up, then median.** Three discarded batches let the JIT reach its steady tier;
  the reported figure is the median of the recorded samples, with the full range kept for
  the spread column. `prepare` runs outside the timed region, so `fill` is not charged for
  the `clear()` that makes each batch a genuine cold fill.
* **Equivalence is asserted before anything is timed.** Each adapter is built fresh and
  asked for its `probe` observations, which must be *deeply equal* across all of them. A
  missing method, an option silently ignored or an adapter storing nothing fails here,
  loudly, rather than quietly producing a flattering number — that guard caught a real bug
  while this suite was being written, where both wrappers read `size` as a property and
  returned the function object itself (`function >= n` is `NaN >= n`, quietly `false`).
  The smoke tests include a case that *proves the guard still rejects* an unequal pair.
* **Every `op` returns what it read.** Not decoration: a discarded `Map.get` is a pure read
  with an unused result, which is exactly what a compiler may delete. `mixed-90-10`
  originally reported `Map` at **11.0 ns/op while `get-hit` reported 33.1 ns/op for an
  identical `Map.get` — in the same run**: the loop had been optimised down to its index
  arithmetic, with the lookup removed. Returning the value is what makes that scenario's row
  in the table above mean anything.
* **The hand-written tag index is told when its store drops a key.** blaze removes an
  entry's tag membership when it evicts it, so the mirrors must too: `LruAdapter` reports
  every key it removes, and QuickLRU's `onEvicted` — a *constructor* option, with no way to
  subscribe afterwards — is handed its handler at construction, which is why `quicklru-full`
  is assembled in two steps rather than composed in one expression. Skip that link and a
  mirror keeps rows for keys that are already gone, so `invalidateTags` would report entries
  the store no longer holds: strictly *less* work than blaze does, and in exactly the
  direction a flattering benchmark would want.

## Layout

| File | Role |
| --- | --- |
| `bench.mjs` | CLI, table rendering, `--json`/`--out` |
| `runner.mjs` | orchestration: validate a scenario, then measure it (shared with the browser) |
| `harness.mjs` | calibration, warm-up, sampling, median/spread, async pair |
| `payloads.mjs` | the 5 × 2 payload matrix and its shared-reference factory |
| `scenarios.mjs` | the ten workloads and their probes |
| `stores.mjs` | the stores, plus the LRU/TTL/tag and persistence wrappers (shared with the browser) |
| `adapters.mjs` | Node registry: supplies the wasm bytes read from disk |
| `adapters.browser.mjs` | browser registry: lets core fetch its own wasm asset |
| `test/bench.test.mjs` | guards the machinery (run by `pnpm -r test`) |
| `test/compare-bench.test.mjs` | guards the `bench:ci` regression gate |
| `../browser/` | Vite + Playwright workspace that runs this suite in Chrome |

`test/bench.test.mjs` runs against the built `dist/` plus the wasm binary, so it needs
`pnpm build:wasm` to have run — the same requirement as the core suite.
