# Cache benchmark

How fast is `@blaze-cache/core` — really — against the two caches you would otherwise
reach for: the native [`Map`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Map)
and [`quick-lru`](https://github.com/sindresorhus/quick-lru)?

## Run it

```sh
pnpm bench                  # builds the wasm + core, then the full table (~40s)
pnpm bench -- --quick       # ~10s smoke run
pnpm bench -- --filter=get  # only scenarios whose id contains "get"
pnpm bench -- --capacity=5000
pnpm bench -- --json        # results as JSON
```

`pnpm bench` rebuilds the wasm and the core first, so the numbers are never taken against a
stale binary, and runs `node` with `--expose-gc` so garbage can be collected *between*
samples rather than during them. Without `--expose-gc` the table still prints, but the
spread column gets noisier.

## What is compared

Each scenario picks two or three of these.

| Adapter | Store | Eviction | TTL | Tags |
| --- | --- | --- | --- | --- |
| `Map` | native `Map` | **none** — grows forever | none | none |
| `QuickLRU` | `quick-lru` v7 | LRU at `maxSize` | built-in `maxAge` | none |
| `Map + LRU + TTL + tags` | `Map` + three layers you would write | hand-rolled LRU | hand-rolled deadline check | key→tags / tag→keys mirror |
| `QuickLRU + tag index` | `quick-lru` + one layer you would write | LRU | built-in `maxAge` | the same mirror |
| `blaze-cache` | Rust core, through wasm | SIEVE at `capacity` | built-in | built-in |

The hand-written wrappers exist so that a store without a feature still has to *do the work*
of that feature — otherwise blaze would be timed doing work its rivals never attempted, or
spared it, and neither comparison means anything. The stacked `Map` row is the point of the
exercise: **it is the cache you would otherwise write and then own** — eviction, expiry and
invalidation as three layers of application code. QuickLRU, by contrast, gets its LRU and its
deadline for free and is wrapped only for the tag mirror, because a hand-rolled stand-in must
never be put up against a built-in.

Every adapter is a class whose methods delegate to its store, so all are called through the
same one-call-deep wrapper and none gets to skip a method call the others pay.

## Scenarios

Five, deliberately: three diagnostic rows that isolate one mechanism each, one control, and
one headline. `overwrite`, `get-with-ttl` and `set-with-tags` were folded into the headline —
they measured TTL and tags *in isolation*, where a rival can look cheap because nothing else
is being asked of it, and their story is now told by the control/headline pair below.

| Scenario | Adapters | What it measures |
| --- | --- | --- |
| `fill` | Map, QuickLRU, blaze | cold insert of `capacity` distinct keys into an empty cache |
| `get-hit` | Map, QuickLRU, blaze | random reads over the resident set |
| `get-miss` | Map, QuickLRU, blaze | reads of keys from a disjoint namespace, against a full cache |
| `mixed-90-10` | Map, QuickLRU, blaze | 90% reads of a hot half, 10% writes to a cold half — bounded caches evict continuously. **The control.** |
| `full-featured` | Map + LRU + TTL + tags, QuickLRU + tag index, blaze | the same load again, plus a deadline and a tag on every write and a periodic invalidation. **The headline.** |

## Results

Apple M2, macOS, Node v24.5.0, `capacity` 10 000, 7 samples × ~120 ms per adapter.
Nanoseconds per operation — **lower is better**.

### The diagnostic rows and the control

| Scenario | Map | QuickLRU | blaze-cache | blaze vs QuickLRU |
| --- | ---: | ---: | ---: | ---: |
| `fill` | **46.0** | 56.8 | 106.9 | 1.9× slower |
| `get-hit` | **32.4** | 90.4 | 69.0 | **1.3× faster** |
| `get-miss` | **29.8** | 34.1 | 53.0 | 1.6× slower |
| `mixed-90-10` (control) | **48.1** | 72.6 | 83.8 | 1.2× slower |

### The headline: `full-featured`

Bounded, expiring, tag-invalidatable — three different ways of getting there. This row has
its own columns because the three adapters are *not* the three above: the plain `Map` and
`QuickLRU` can't answer this question at all.

| Map + LRU + TTL + tags | QuickLRU + tag index | blaze-cache | spread (all three) |
| ---: | ---: | ---: | --- |
| 192.6 | **102.9** | 141.9 | ±6% / ±5% / ±2% |

Two comparisons here, and only two are meaningful:

* **blaze vs the hand-rolled stack — 1.4× faster** (141.9 against 192.6). That middle column
  is the three layers you would otherwise write: an LRU on a `Map`, a deadline wrapped around
  every value, and a tag mirror kept in step by hand. blaze is faster than your own code *and*
  doesn't leave you owning its eviction callback, its stale-index bugs or its invalidation
  bookkeeping — and it holds exactly `capacity` entries where that stack is charged for
  holding them too.
* **blaze vs `QuickLRU + tag index` — 1.4× slower** (141.9 against 102.9). The rival gets its
  LRU and its `maxAge` natively and hands you only the tag mirror to write. Against *that*
  hand-written mirror, blaze costs a premium: every `set` crosses the JS→wasm boundary and
  marshals key, deadline and a `Vec<String>` of tags into linear memory.

### How to read this

* **`Map` wins the first four rows, and it is not a rival.** It has no capacity, no TTL, no
  tags and no index — in `mixed-90-10` it simply keeps every key it is handed while the other
  two evict for the whole run. Treat it as the floor: the cost of a bare JavaScript hash
  lookup, with nothing else asked of it. Never quote blaze's ns/op next to it.
* **The comparison that means something is blaze vs `QuickLRU`** — or, in the headline, vs
  the stacked `Map`. Those are the caches actually holding a bounded, feature-carrying state.
* **Reads are where blaze wins:** 1.3× faster on `get-hit`, one round trip plus SIEVE's
  visited bit against QuickLRU's recency promotion on every hit.
* **Writes are where blaze pays** — 1.9× on `fill`. Every `set` crosses the boundary and
  marshals its key; that is the cost of running eviction, TTL and tag indexes in the same
  place the data lives rather than in the JavaScript around it.
* **What the features cost, on identical work.** `mixed-90-10` and `full-featured` replay the
  *same* read/write plan; the second only attaches a deadline, a tag and a periodic
  invalidation. The difference per operation: `QuickLRU + tag index` **+30 ns**, blaze
  **+58 ns**, the stacked `Map` **+144 ns** — though most of the Map's jump is simply gaining
  the LRU policy that its control row never had. The pair is the story the old isolated
  scenarios told one feature at a time.
* **Believe gaps smaller than the `spread` column as nothing.** That column is the range of
  the samples around their median — your machine, your Node build and how warm the JIT
  happens to be will all move these numbers. In `get-miss` it even swallows the gap between
  `Map` and `QuickLRU` (±17% on a 4 ns difference), so read that pair as a tie, while the
  19 ns out to blaze there is several times the spread. The headline's three figures, at
  ±2–6% against a 39 ns gap, are not in that territory.

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
| `bench.mjs` | CLI, table rendering, `--json` |
| `runner.mjs` | orchestration: validate a scenario, then measure it |
| `harness.mjs` | calibration, warm-up, sampling, median/spread |
| `scenarios.mjs` | the workloads and their probes |
| `adapters.mjs` | the stores, plus the LRU/TTL/tag wrappers that stack them |
| `test/bench.test.mjs` | guards the machinery (run by `pnpm -r test`) |

`test/bench.test.mjs` runs against the built `dist/` plus the wasm binary, so it needs
`pnpm build:wasm` to have run — the same requirement as the core suite.
