/**
 * The workloads.
 *
 * A scenario is a fixed op (`op(adapter, i)`), an optional untimed `setup`/`prepare`, and a
 * `probe`. Every adapter in a scenario is handed the **same precomputed key sequence** — a
 * deterministic, pre-shuffled ring — so the three are fed identical work rather than each
 * one's own idea of "random". The index step is `i & mask` on a power-of-two ring instead
 * of `i % n`: cheaper, and identically cheaper for everyone.
 *
 * `probe` is the fairness guarantee. It runs on a freshly built adapter, before any timing,
 * and returns observations that the runner requires to be **deeply equal across adapters**.
 * A missing method, a mis-wired option or an adapter silently storing nothing would surface
 * there as a failed assertion instead of as a suspicious-looking benchmark result. Probes
 * also deliberately stay *inside* `capacity` writes: the three stores evict by design
 * (QuickLRU may hold up to twice `maxSize`, for one), so a probe that tripped an eviction
 * would be comparing eviction policies rather than the features under test.
 *
 * ## The pair that does the explaining
 *
 * `mixed-90-10` and `full-featured` run the **same load plan** — same key space, same
 * read/write split, same sequence — and differ only in that the latter puts a deadline and a
 * tag on each write and retires a tag periodically. So their two rows are directly comparable
 * to each other, and the gap between them is the price of TTL, tags and invalidation on that
 * load. Each is still compared against its own rivals for the "vs best" column; it is the
 * *pair* that isolates the feature cost.
 *
 * `full-featured` is the headline, because it is the question a cache like this actually
 * gets asked: not "how fast is a bare lookup" but "what does a bounded, expiring,
 * tag-invalidatable cache cost".
 */
import { setTimeout as delay } from 'node:timers/promises';

/** How long an entry lives in the TTL paths — far beyond any run, so reads see live data. */
const HOUR_MS = 3_600_000;
/**
 * How many distinct tags the headline scenario spreads its writes over.
 *
 * Small enough that an invalidation is a meaningful fraction of the cache and the tag index
 * has real buckets to maintain; large enough that no single invalidation empties the cache,
 * which would otherwise turn the workload into something `mixed-90-10` could not be measured
 * against.
 */
const TAG_COUNT = 32;
/** Pre-built, never-mutated: one tag per bucket, `entity:<n>`. */
const TAGS = Array.from({ length: TAG_COUNT }, (_, index) => `entity:${index}`);
/** Tag the probe uses, kept out of the TAGS ring so it cannot collide with the workload. */
const PROBE_TAG = 'probe';
/**
 * Iterations between two invalidations in the headline scenario.
 *
 * Chosen against `capacity` rather than a constant so the ratio survives `--capacity=N`:
 * invalidation stays a proportional trim of a full cache instead of either a no-op or a
 * total wipe.
 */
const invalidationCycle = (capacity) => Math.max(1, Math.floor(capacity / 4));
/** Length of the shared read/write plan ring in the two load scenarios. */
const PLAN_LENGTH = 65_536;

/** Deterministic PRNG (mulberry32) — the same sequence for every adapter and every run. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smallest power of two ≥ `value`. */
function powerOfTwo(value) {
  let size = 1;
  while (size < value) size *= 2;
  return size;
}

/**
 * A shuffled, power-of-two ring of indices.
 *
 * Pre-shuffled so reads look like random access — the pattern a real cache sees, and the
 * one a prefetcher cannot make free. Values are `offset + (i % length)`, which lets one
 * ring address the cold half of a key space as naturally as the hot half.
 *
 * @returns {{ring: Uint32Array, mask: number}}
 */
function shuffledRing(length, seed, offset = 0) {
  const size = powerOfTwo(length);
  const ring = new Uint32Array(size);
  for (let i = 0; i < size; i += 1) ring[i] = offset + (i % length);

  const random = makeRandom(seed);
  for (let i = size - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const swap = ring[i];
    ring[i] = ring[j];
    ring[j] = swap;
  }
  return { ring, mask: size - 1 };
}

/** `count` distinct keys. */
function makeKeys(count, prefix = 'key:') {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`);
}

/** One distinct object per key — values are stored by reference and never cloned. */
function makeValues(count) {
  return Array.from({ length: count }, (_, index) => ({ id: index }));
}

/**
 * The 90/10 load both load scenarios replay.
 *
 * Reads come from a hot half, writes go to a cold half of a `2 × capacity` key space, so a
 * bounded cache sits at capacity and evicts continuously for the whole run while a `Map` —
 * which has no eviction policy — simply keeps everything it is given. Built once per
 * `buildScenarios` so the two scenarios that consume it are provably fed identical work.
 *
 * @returns {{kind: Uint8Array, read: Uint32Array, write: Uint32Array}}
 */
function makeLoadPlan(capacity) {
  const random = makeRandom(0xfeed);
  const kind = new Uint8Array(PLAN_LENGTH);
  const read = new Uint32Array(PLAN_LENGTH);
  const write = new Uint32Array(PLAN_LENGTH);
  for (let i = 0; i < PLAN_LENGTH; i += 1) {
    kind[i] = random() < 0.9 ? 1 : 0;
    read[i] = Math.floor(random() * capacity);
    write[i] = capacity + Math.floor(random() * capacity);
  }
  return { kind, read, write };
}

/**
 * Builds every scenario for a given `capacity`.
 *
 * @param {number} capacity entries each bounded adapter is allowed to hold
 */
export function buildScenarios(capacity) {
  const keys = makeKeys(capacity);
  const values = makeValues(capacity);
  const absent = makeKeys(capacity, 'absent:');
  const access = shuffledRing(capacity, 0x5eed);

  const wideSize = capacity * 2;
  const wideKeys = makeKeys(wideSize);
  const wideValues = makeValues(wideSize);
  const plan = makeLoadPlan(capacity);
  const cycle = invalidationCycle(capacity);

  /** Fills the resident set. Shared by `setup` and every probe that needs a full cache. */
  const fill = (adapter) => {
    for (let i = 0; i < capacity; i += 1) adapter.set(keys[i], values[i]);
  };

  return [
    {
      id: 'fill',
      title: 'insert `capacity` distinct keys into an empty cache',
      adapters: ['map', 'quicklru', 'blaze'],
      notes: [
        'One batch is one cold fill. The clear that makes it repeatable runs outside the timed region, so no adapter is charged for emptying itself.',
      ],
      opsPerBatch: capacity,
      prepare: (adapter) => adapter.clear(),
      op: (adapter, i) => adapter.set(keys[i], values[i]),
      probe: (adapter) => {
        adapter.clear();
        fill(adapter);
        return [
          adapter.size() >= capacity,
          adapter.get(keys[0]) === values[0],
          adapter.get(keys[capacity - 1]) === values[capacity - 1],
          adapter.get('key:absent'),
        ];
      },
    },

    {
      id: 'get-hit',
      title: 'read a key that is present',
      adapters: ['map', 'quicklru', 'blaze'],
      notes: [
        'Random reads over the resident set. Map does no bookkeeping at all, QuickLRU promotes the entry in its recency order on every hit, and blaze sets SIEVE’s visited bit — each library doing the bookkeeping its own eviction policy requires.',
      ],
      setup: fill,
      op: (adapter, i) => adapter.get(keys[access.ring[i & access.mask]]),
      probe: (adapter) => {
        fill(adapter);
        return [
          adapter.size() >= capacity,
          adapter.get(keys[0]) === values[0],
          adapter.get(keys[capacity - 1]) === values[capacity - 1],
          adapter.get('key:absent'),
        ];
      },
    },

    {
      id: 'get-miss',
      title: 'read a key that was never written',
      adapters: ['map', 'quicklru', 'blaze'],
      notes: [
        'The cache is full and holds `capacity` entries, but every read comes from a disjoint namespace — all three pay for a lookup that finds nothing.',
      ],
      setup: fill,
      op: (adapter, i) => adapter.get(absent[access.ring[i & access.mask]]),
      probe: (adapter) => {
        fill(adapter);
        return [
          adapter.size() >= capacity,
          adapter.get(keys[0]) === values[0],
          adapter.get(absent[0]),
          adapter.get(absent[capacity - 1]),
        ];
      },
    },

    {
      id: 'mixed-90-10',
      title: '90% reads / 10% writes under capacity pressure',
      adapters: ['map', 'quicklru', 'blaze'],
      notes: [
        'The control for `full-featured`: this load plan is exactly the same, with no deadline and no tags on the writes.',
        'Reads come from a hot half, writes go to a cold half of a `2 × capacity` key space, so the bounded caches evict continuously while Map — which has no eviction policy — simply keeps everything.',
        'QuickLRU’s dual-cache design may hold up to `2 × maxSize` by design; blaze holds exactly `capacity`.',
      ],
      setup: fill,
      setup: fill,
      // The read result is returned, not discarded: `Map.get` is a pure read, so a value
      // nobody consumes is a lookup the compiler is free to delete — which is exactly how
      // this scenario first measured at 11 ns/op against 33 ns/op for an identical
      // `Map.get` in `get-hit`. The write half needs no such guard: `set` mutates.
      op: (adapter, i) => {
        const step = i & (PLAN_LENGTH - 1);
        if (plan.kind[step] === 1) return adapter.get(wideKeys[plan.read[step]]);
        adapter.set(wideKeys[plan.write[step]], wideValues[plan.write[step]]);
        return undefined;
      },
      probe: (adapter) => {
        fill(adapter);
        return [
          adapter.size() >= capacity,
          adapter.get(wideKeys[0]) === wideValues[0],
          adapter.get(wideKeys[capacity - 1]) === wideValues[capacity - 1],
          adapter.get(wideKeys[capacity]),
        ];
      },
    },

    {
      id: 'full-featured',
      title: 'the same load, with TTL and tags on every write',
      adapters: ['map-full', 'quicklru-full', 'blaze'],
      notes: [
        'The headline, and the only row that answers the question a cache like this is actually asked: what does a bounded, expiring, tag-invalidatable cache cost?',
        `Identical to \`mixed-90-10\` in every respect but one — each write also carries a one-hour deadline and one of ${TAG_COUNT} tags, and one tag is retired every ${cycle} iterations (a quarter of \`capacity\`), so the two rows differ by exactly the price of TTL, tags and invalidation on this load.`,
        'Map is given a hand-written LRU, deadline and tag index; QuickLRU supplies its own LRU and `maxAge` and is wrapped only for tags; blaze does all three in wasm. Nothing here is a stand-in for a built-in.',
      ],
      setup: fill,
      setup: fill,
      op: (adapter, i) => {
        const step = i & (PLAN_LENGTH - 1);
        if (plan.kind[step] === 1) return adapter.get(wideKeys[plan.read[step]]);

        const index = plan.write[step];
        adapter.set(wideKeys[index], wideValues[index], {
          ttlMs: HOUR_MS,
          tags: [TAGS[index % TAG_COUNT]],
        });
        // Driven by `i`, not by a running counter, so every batch replays the same
        // sequence for every adapter, sample after sample.
        if (i > 0 && i % cycle === 0) adapter.invalidateTags(TAGS[(i / cycle) % TAG_COUNT]);
        return undefined;
      },
      probe: async (adapter) => {
        // Half the cache, so nothing evicts: the three hold different amounts at capacity
        // by design, and a probe that tripped eviction would be comparing policies rather
        // than features.
        const writes = Math.floor(capacity / 2);
        for (let i = 0; i < writes; i += 1) {
          adapter.set(keys[i], values[i], { ttlMs: HOUR_MS, tags: [TAGS[i % TAG_COUNT]] });
        }
        const held = adapter.size();
        const readable = adapter.get(keys[0]) === values[0];

        const removed = adapter.invalidateTags(TAGS[0]).length;
        const after = adapter.size();

        // The deadline half of the promise: a one-millisecond entry must read back as gone.
        adapter.set('key:short', values[0], { ttlMs: 1, tags: [PROBE_TAG] });
        await delay(10);
        const expired = adapter.get('key:short');

        return [held, readable, removed, after, expired];
      },
    },
  ];
}
