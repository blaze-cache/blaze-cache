# Blaze Cache — published benchmark results

**Suite:** `0.4.0-beta.3` Stage 1 · **Generated:** 2026-11-20 · **Baseline:** `0.4.0-beta.2`

These are the numbers Stage 1 exists to produce: the same ten scenarios, five payload sizes
and two value representations in **both Node and a real browser**, with the raw machine-readable
outputs checked in next to them. Their job is to tell us whether the hybrid-memory hypothesis
in the [0.4.0 roadmap](../plan/0.4.0-roadmap.md) is worth building — not to win an argument.

> **Read the caveat first.** Values are held **by reference** in the Rust slab. Neither `get`
> nor `set` serialises a payload; the cost under test is the **boundary crossing and the
> bookkeeping** (key marshalling, tag `Vec<String>` marshalling, TTL/SIEVE/tag maintenance).
> A larger object therefore should *not* make `get`/`set` much slower — and in these numbers it
> does not. That is evidence against the "serialising JS objects is the bottleneck" premise,
> and is the reason Stage 2 is gated rather than assumed.

## Hardware and versions

| | Node suite | Browser suite |
|---|---|---|
| Machine | Apple M2, 8 logical cores, macOS | same machine, headless Google Chrome 157 |
| Runtime | Node v24.5.0 | Chrome/157.0.0.0 (headless) |
| Wasm | `wasm-pack` 0.15.0, `--target web`, release | identical binary, fetched over HTTP by Vite |
| Capacity | 10 000 entries | 10 000 entries |
| Samples | 7 recorded × ~120 ms, 3 discarded warm-ups | identical |
| Clock | `process.hrtime.bigint()` | `performance.now()` (coarser; batches calibrated to tens of ms) |

Raw outputs (one row per scenario × adapter × payload size; includes every sample, spread and
environment block):

* [`node-matrix-object.json`](../../benchmarks/results/node-matrix-object.json) — 5 sizes × structured-cloneable objects
* [`node-matrix-bytes.json`](../../benchmarks/results/node-matrix-bytes.json) — 5 sizes × `Uint8Array`
* [`browser-matrix-object.json`](../../benchmarks/results/browser-matrix-object.json)
* [`browser-matrix-bytes.json`](../../benchmarks/results/browser-matrix-bytes.json)
* [`baseline.node.json`](../../benchmarks/results/baseline.node.json) — the checked-in CI gate baseline (`--quick`)
* [`framework.json`](../../benchmarks/results/framework.json) — TanStack Query / SWR / blaze cache-store comparison (Node)

Reproduce: `pnpm bench -- --matrix` and `pnpm bench:browser -- --matrix` (add
`--payload-kind=bytes` for the typed-array half). Both accept `--json`.

## Methodology in one paragraph

Every adapter in a scenario receives the **same precomputed, pre-shuffled key ring** and is
called through the same one-call-deep wrapper. Before any timing, each adapter is built fresh
and asked for a `probe`; the observations must be **deeply equal across adapters** or the run
aborts. A batch is doubled until it costs ~20 ms and scaled to land near 120 ms, so a 20 ns
`Map.get` and a 200 ns wasm round trip are timed over comparable spans. Three warm-up batches
are discarded; the reported figure is the **median** of seven recorded batches and the full
range is kept as the spread column. `prepare()` runs outside the timed region. Values come
from a small pool of shared references — a 1 MB value is allocated sixteen times, not once per
key, so the number never measures the value generator. The persistence pair times a whole
10 000-record flush/restore as one operation and divides by the record count; its `ns/op` is
therefore **per record**, not per batch.

## The premise test: payload size barely matters

blaze-cache, `ns/op` (lower is better). Tiny = ≤64 B, small ≈1 KB, medium ≈10 KB, large ≈100 KB,
massive ≈1 MB.

| Scenario | Runtime | tiny | small | medium | large | massive |
|---|---|---:|---:|---:|---:|---:|
| `get-hit` | Node | 93 | 112 | 107 | 107 | 108 |
| `full-featured` | Node | 169 | 184 | 183 | 183 | 191 |
| `get-hit` | Browser | 86 | 86 | 86 | 85 | 90 |
| `full-featured` | Browser | 184 | 209 | 208 | 194 | 193 |

Both value representations say the same thing (the `Uint8Array` tables differ by a few ns, not
by an order of magnitude). A 16 000× increase in payload size moves a hot read by roughly
10–20 ns and a full-featured operation by roughly 10–25 ns — within the run-to-run drift of
the suite. **There is no payload-size cliff.** The remaining cost is the crossing itself, which
a raw-key scratch buffer already reduces for repeated keys; that is the cost Stage 2 would have
to attack, and it is far smaller than the original proposal assumed.

## The headline: `full-featured`, small payload

Bounded, expiring, tag-invalidatable — the question this cache exists to answer. `ns/op`:

| Adapter | Node / object | Node / bytes | Browser / object | Browser / bytes |
|---|---:|---:|---:|---:|
| Map + LRU + TTL + tags | 211.2 | 206.4 | 190.3 | 180.2 |
| QuickLRU + tag index | **109.3** | **107.0** | **88.2** | **86.5** |
| lru-cache + tag index | 231.3 | 234.7 | 100.0 | 91.1 |
| blaze-cache | 183.6 | 190.3 | 208.6 | 194.2 |

Two comparisons are meaningful, and they point in opposite directions:

* **Against the three layers you would otherwise write and own** (an LRU on a `Map`, a deadline
  wrapped around every value, a tag mirror kept in step): blaze is **1.15× faster** in Node, and
  **about even — 8–10% slower** — in the browser. Whether that trade is worth it is not a
  speed question alone: blaze also owns the eviction callback, the stale-index bugs and the
  invalidation bookkeeping, and holds exactly `capacity` entries.
* **Against a library that implements LRU and TTL natively and only needs a hand-written tag
  mirror:** blaze is **1.7× slower** in Node and **2.2–2.4× slower** in the browser. Every `set`
  crosses the JS→wasm boundary and marshals key, deadline and a `Vec<String>` of tags; that is
  the premium the by-reference design pays for keeping the policy and the data in one place.

So: **no unqualified "faster than JavaScript" claim is supported by this data.** The honest
claim is narrower — blaze replaces a stack of application code at roughly the same cost, beats
that stack on Node reads, and pays a clear write-path premium against native LRU libraries.

## Feature-equivalent table (what the headline is compared against)

The same load plan without deadlines or tags — `mixed-90-10`, small payload, `ns/op`:

| Adapter | Node | Browser |
|---|---:|---:|
| Map (unbounded — does strictly less work) | 52.6 | 42.7 |
| QuickLRU | 73.9 | 66.2 |
| lru-cache | 183.1 | 68.5 |
| blaze-cache | 119.3 | 113.4 |

Read this beside the headline, not instead of it. The delta between the two tables is the price
of TTL + tags + invalidation on identical work. `Map` is a floor, not a rival: it has no
capacity, no TTL, no tags and no index, and in every pressure scenario it simply keeps every
key it is handed. QuickLRU and lru-cache hold between `maxSize` and `2 × maxSize` by design;
blaze holds exactly `capacity`.

## The five added scenarios

`ns/op` (per record for the two persistence rows), small payload, object values:

| Scenario | Node | Browser | What it isolates |
|---|---:|---:|---|
| `ttl-churn` | blaze 110.8 vs 50.2 (Map stack) | 92.4 vs 36.0 | lazy expiry reclamation on access |
| `eviction-pressure` | blaze 219.4 vs 62.2 (QuickLRU) | 197.0 vs 39.1 | a reclaim on every write |
| `tag-invalidation-scale` | blaze 71.5 vs 15.2 (Map stack) | 56.6 vs 12.8 | a 128-tag index under a read load |
| `persistence-flush` | blaze 1415.0 vs 99.4 (QuickLRU queue) | 1536.2 vs 109.5 | write-through reconciliation + one batched write |
| `hydration` | blaze 127.1 vs 57.1 (QuickLRU queue) | 119.7 vs 33.7 | restoring 10 000 records into memory |

The persistence premium is the largest gap in the suite, and it is not a serialization cost:
blaze's flush builds `PersistedRecord`s from live wasm entries, reconciles rows the core evicted
on its own, and commits through one `write()` call. The rivals copy references into a
`Map`-backed queue. In Node there is no IndexedDB, so both sides use an in-memory
`CachePersistence` adapter; the browser workspace runs the same code path, but the published
browser numbers also use the in-memory adapter so the two columns stay comparable. A
real-IDB flush/hydration run is the natural follow-up once the browser harness is on CI.

## Reading the spread

Some rows — notably the persistence pair and the short `--quick` gate — have wide spreads (up
to ~500% on one hydration sample). The reported statistic is a **median**, so a single outlier
does not move the central figure, but the range is printed rather than hidden. Gaps smaller
than the spread are ties. The CI gate is scenario-normalised (each row divided by its cell's
median) and spread-aware, so a faster or slower runner and a noisy row cannot on their own fail
a PR; see [`scripts/compare-bench.mjs`](../../scripts/compare-bench.mjs).

## Suite layout

| Scenario | Adapters | Category |
|---|---|---|
| `fill`, `get-hit`, `get-miss` | Map, QuickLRU, lru-cache, blaze | diagnostic |
| `mixed-90-10` | as above | control for the headline |
| `full-featured` | Map + LRU + TTL + tags, QuickLRU + tag index, lru-cache + tag index, blaze | headline |
| `ttl-churn`, `tag-invalidation-scale` | the three full-featured stacks | lifetime / features |
| `eviction-pressure` | Map + LRU, QuickLRU, lru-cache, blaze | lifetime |
| `persistence-flush`, `hydration` | blaze + persistence, Map + queue, QuickLRU + queue | persistence |

## Framework cache stores (Node, cache-store microbenchmark only)

`pnpm bench:framework` compares the real `@tanstack/query-core` `QueryClient` store and the real
SWR cache store on point operations. This is **not** a React hook/render or fetch benchmark;
TanStack's numbers include query-key hashing and query-cache bookkeeping, and real SWR apps
also pay key serialisation. `ns/op`, capacity 10 000, 1 KB payloads:

| Scenario | Blaze | TanStack Query | SWR |
|---|---:|---:|---:|
| `warm-hit` | 40.5 | 518.7 | 11.9 |
| `miss` | 28.2 | 504.9 | 11.6 |
| `write` | 175.3 | 1831.7 | 130.8 |
| `invalidate-by-key` | 142.7 | 1 427 377.4 | 100.0 |

These are different shapes of API doing different amounts of work, so they are **not** the
feature-equivalent table for the headline — that is the `Map`/`QuickLRU`/`lru-cache` table above.
They exist because the framework suite called for more scenarios, and because "faster than a
framework cache store" is only a claim about the store's point operations.

`Map` and `QuickLRU` baselines stay in [`benchmarks/cache/`](../../benchmarks/cache/README.md);
the framework suite is [`benchmarks/framework/`](../../benchmarks/framework/README.md). The
browser workspace is [`benchmarks/browser/`](../../benchmarks/browser/).
