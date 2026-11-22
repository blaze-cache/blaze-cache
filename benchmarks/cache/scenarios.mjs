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
 * there as a failed assertion instead of as a suspicious-looking benchmark result.
 *
 * `mixed-90-10` and `full-featured` run the **same load plan** and differ only in that the
 * latter puts a deadline and a tag on each write and retires a tag periodically. Their gap is
 * the price of TTL, tags and invalidation on that load. `full-featured` stays the headline.
 *
 * Five further scenarios answer the gaps the framework suite called out (TTL churn, eviction
 * pressure, tag invalidation at scale, persistence flush, hydration). The persistence pair is
 * async: one timed op is a whole `capacity`-record flush/restore and `divisor` normalises it to
 * a per-record figure, so it can share the median/spread harness with the point operations.
 *
 * Payload size is supplied by the caller as a `valueFor(index)` factory from `payloads.mjs`.
 * The factory hands out a small pool of shared references — blaze stores values by reference,
 * so what we measure is the boundary/bookkeeping cost at a given working-set size, never the
 * cost of constructing a fresh 1 MB object per `set`.
 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long a non-expiring entry lives in the TTL paths — far beyond any run. */
const HOUR_MS = 3_600_000;
/** Tags in the headline scenario: enough for real buckets, few enough to matter when retired. */
const TAG_COUNT = 32;
const TAGS = Array.from({ length: TAG_COUNT }, (_, index) => `entity:${index}`);
/** Wider tag space for the scale scenario — one tag per ~0.8% of a full cache. */
const SCALE_TAG_COUNT = 128;
const SCALE_TAGS = Array.from({ length: SCALE_TAG_COUNT }, (_, index) => `scale:${index}`);
const PROBE_TAG = 'probe';

const invalidationCycle = (capacity) => Math.max(1, Math.floor(capacity / 4));
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

function powerOfTwo(value) {
  let size = 1;
  while (size < value) size *= 2;
  return size;
}

/** A shuffled, power-of-two ring of indices. */
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

function makeKeys(count, prefix = 'key:') {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`);
}

/** `count` value references drawn from the caller's pool (one object per slot by default). */
function makeValues(count, valueFor) {
  return Array.from({ length: count }, (_, index) => valueFor(index));
}

/**
 * Probe comparison that works for both value modes. A bytes entry returns a fresh `Uint8Array`
 * view (it cannot return the source reference), so identity alone would report a false miss.
 * Returning a boolean keeps the probes deeply equal across adapters: every store either
 * preserved the payload or it did not.
 */
function sameValue(actual, expected) {
  if (actual === expected) return true;
  if (actual instanceof Uint8Array && expected instanceof Uint8Array) {
    return (
      actual.length === expected.length && actual.every((byte, index) => byte === expected[index])
    );
  }
  return false;
}

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
 * Builds every scenario.
 *
 * @param {number | {capacity: number, valueFor?: (index: number) => unknown,
 *   payload?: string, payloadKind?: string}} options a capacity (legacy) or the full options;
 *   `valueFor` comes from `createValueFactory` in `payloads.mjs`
 */
export function buildScenarios(options = {}) {
  const opts = typeof options === 'number' ? { capacity: options } : options;
  const {
    capacity,
    valueFor = (index) => ({ id: index }),
    payload = 'small',
    payloadKind = 'object',
    includeStage2 = false,
  } = opts;

  const keys = makeKeys(capacity);
  const values = makeValues(capacity, valueFor);
  const absent = makeKeys(capacity, 'absent:');
  const access = shuffledRing(capacity, 0x5eed);

  const wideSize = capacity * 2;
  const wideKeys = makeKeys(wideSize);
  const wideValues = makeValues(wideSize, valueFor);
  const plan = makeLoadPlan(capacity);
  const cycle = invalidationCycle(capacity);
  /** Invalidation is a meaningful fraction of the scale scenario, not a once-per-run trickle. */
  const scaleCycle = Math.max(4, Math.floor(capacity / 50));

  const pressureKeys = makeKeys(capacity, 'pressure:');
  const pressureValues = makeValues(capacity, valueFor);

  /** Fills the resident set. Shared by `setup` and every probe that needs a full cache. */
  const fill = (adapter) => {
    for (let i = 0; i < capacity; i += 1) adapter.set(keys[i], values[i]);
  };

  /** The record shape `CachePersistence` expects — used to seed the hydration scenario. */
  const records = Array.from({ length: capacity }, (_, index) => ({
    key: keys[index],
    value: values[index],
    tags: [],
    ttlMs: null,
    storedAt: Date.now(),
  }));

  const sizeNote = `payload ${payload}/${payloadKind}`;

  const scenariosResults = [
    {
      id: 'fill',
      category: 'diagnostic',
      title: 'insert `capacity` distinct keys into an empty cache',
      adapters: ['map', 'quicklru', 'lrucache', 'blaze'],
      notes: [
        'One batch is one cold fill. The clear that makes it repeatable runs outside the timed region, so no adapter is charged for emptying itself.',
        sizeNote,
      ],
      opsPerBatch: capacity,
      prepare: (adapter) => adapter.clear(),
      op: (adapter, i) => adapter.set(keys[i], values[i]),
      probe: (adapter) => {
        adapter.clear();
        fill(adapter);
        return [
          adapter.size() >= capacity,
          sameValue(adapter.get(keys[0]), values[0]),
          sameValue(adapter.get(keys[capacity - 1]), values[capacity - 1]),
          adapter.get('key:absent'),
        ];
      },
    },

    {
      id: 'get-hit',
      category: 'diagnostic',
      title: 'read a key that is present',
      adapters: ['map', 'quicklru', 'lrucache', 'blaze'],
      notes: [
        'Random reads over the resident set. Map does no bookkeeping; QuickLRU promotes on every hit; blaze sets SIEVE’s visited bit — each library paying what its policy requires.',
        sizeNote,
      ],
      setup: fill,
      op: (adapter, i) => adapter.get(keys[access.ring[i & access.mask]]),
      probe: (adapter) => {
        fill(adapter);
        return [
          adapter.size() >= capacity,
          sameValue(adapter.get(keys[0]), values[0]),
          sameValue(adapter.get(keys[capacity - 1]), values[capacity - 1]),
          adapter.get('key:absent'),
        ];
      },
    },

    {
      id: 'get-miss',
      category: 'diagnostic',
      title: 'read a key that was never written',
      adapters: ['map', 'quicklru', 'lrucache', 'blaze'],
      notes: [
        'The cache is full but every read comes from a disjoint namespace — all three pay for a lookup that finds nothing.',
        sizeNote,
      ],
      setup: fill,
      op: (adapter, i) => adapter.get(absent[access.ring[i & access.mask]]),
      probe: (adapter) => {
        fill(adapter);
        return [
          adapter.size() >= capacity,
          sameValue(adapter.get(keys[0]), values[0]),
          adapter.get(absent[0]),
          adapter.get(absent[capacity - 1]),
        ];
      },
    },

    {
      id: 'mixed-90-10',
      category: 'control',
      title: '90% reads / 10% writes under capacity pressure',
      adapters: ['map', 'quicklru', 'lrucache', 'blaze'],
      notes: [
        'The control for `full-featured`: same load plan, no deadline and no tags on the writes.',
        'Reads from a hot half, writes to a cold half of a `2 × capacity` key space, so the bounded caches evict continuously while Map keeps everything.',
        sizeNote,
      ],
      setup: fill,
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
          sameValue(adapter.get(wideKeys[0]), wideValues[0]),
          sameValue(adapter.get(wideKeys[capacity - 1]), wideValues[capacity - 1]),
          adapter.get(wideKeys[capacity]),
        ];
      },
    },

    {
      id: 'full-featured',
      category: 'headline',
      title: 'the same load, with TTL and tags on every write',
      adapters: ['map-full', 'quicklru-full', 'lrucache-full', 'blaze'],
      notes: [
        'The headline: what does a bounded, expiring, tag-invalidatable cache cost?',
        `Identical to \`mixed-90-10\` except each write carries a one-hour deadline and one of ${TAG_COUNT} tags, and a tag is retired every ${cycle} iterations.`,
        'Map is given a hand-written LRU, deadline and tag index; QuickLRU supplies its own LRU and `maxAge` and is wrapped only for tags; blaze does all three in wasm.',
        sizeNote,
      ],
      setup: fill,
      op: (adapter, i) => {
        const step = i & (PLAN_LENGTH - 1);
        if (plan.kind[step] === 1) return adapter.get(wideKeys[plan.read[step]]);

        const index = plan.write[step];
        adapter.set(wideKeys[index], wideValues[index], {
          ttlMs: HOUR_MS,
          tags: [TAGS[index % TAG_COUNT]],
        });
        if (i > 0 && i % cycle === 0) adapter.invalidateTags(TAGS[(i / cycle) % TAG_COUNT]);
        return undefined;
      },
      probe: async (adapter) => {
        const writes = Math.floor(capacity / 2);
        for (let i = 0; i < writes; i += 1) {
          adapter.set(keys[i], values[i], { ttlMs: HOUR_MS, tags: [TAGS[i % TAG_COUNT]] });
        }
        const held = adapter.size();
        const readable = sameValue(adapter.get(keys[0]), values[0]);

        const removed = adapter.invalidateTags(TAGS[0]).length;
        const after = adapter.size();

        adapter.set('key:short', values[0], { ttlMs: 1, tags: [PROBE_TAG] });
        await delay(10);
        const expired = adapter.get('key:short');

        return [held, readable, removed, after, expired];
      },
    },

    {
      id: 'ttl-churn',
      category: 'lifetime',
      title: 'TTL-expiry-heavy churn: every read reclaims a lapsed entry',
      adapters: ['map-full', 'quicklru-full', 'lrucache-full', 'blaze'],
      async: true,
      notes: [
        'Each untimed batch fills the cache with 1 ms deadlines and lets them lapse; the timed reads then do the lazy reclamation a synchronous cache must perform on access.',
        'The two rivals expire with a hand-rolled deadline check and QuickLRU’s native `maxAge` respectively; blaze reclaims inside the Rust core and reports the drop through its log.',
        sizeNote,
      ],
      prepare: async (adapter) => {
        adapter.clear();
        for (let i = 0; i < capacity; i += 1) adapter.set(keys[i], values[i], { ttlMs: 1 });
        await delay(5);
      },
      op: (adapter, i) => adapter.get(keys[access.ring[i & access.mask]]),
      probe: async (adapter) => {
        adapter.clear();
        for (let i = 0; i < Math.min(capacity, 64); i += 1) {
          adapter.set(keys[i], values[i], { ttlMs: HOUR_MS });
        }
        const live = sameValue(adapter.get(keys[0]), values[0]);
        adapter.set('ttl:short', values[0], { ttlMs: 1 });
        await delay(10);
        return [live, adapter.get('ttl:short') === undefined];
      },
    },

    {
      id: 'eviction-pressure',
      category: 'lifetime',
      title: 'a full cache evicts on every write',
      adapters: ['map-lru', 'quicklru', 'lrucache', 'blaze'],
      notes: [
        'Each batch is one full-cache fill followed by `capacity` writes to a disjoint namespace, so every single write has to reclaim a slot.',
        'All three adapters are bounded here (Map + a hand-rolled LRU, QuickLRU, blaze): an unbounded Map would be doing strictly less work and its row belongs in the diagnostic table only.',
        sizeNote,
      ],
      setup: fill,
      prepare: (adapter) => {
        adapter.clear();
        fill(adapter);
      },
      opsPerBatch: capacity,
      op: (adapter, i) => adapter.set(pressureKeys[i], pressureValues[i]),
      probe: (adapter) => {
        adapter.clear();
        fill(adapter);
        adapter.set('pressure:probe', values[0]);
        return [
          adapter.size() === capacity,
          sameValue(adapter.get('pressure:probe'), values[0]),
          adapter.get('absent:key:0') === undefined,
        ];
      },
    },

    {
      id: 'tag-invalidation-scale',
      category: 'features',
      title: 'invalidation across a large tag index',
      adapters: ['map-full', 'quicklru-full', 'lrucache-full', 'blaze'],
      notes: [
        `A full cache spread over ${SCALE_TAG_COUNT} tags, retired every ${scaleCycle} iterations against a background of reads — the index, not the individual delete, is under test.`,
        'The hand-rolled mirror keeps both key→tags and tag→keys in step, including on eviction; blaze maintains both indexes in wasm.',
        sizeNote,
      ],
      setup: (adapter) => {
        for (let i = 0; i < capacity; i += 1) {
          adapter.set(keys[i], values[i], {
            ttlMs: HOUR_MS,
            tags: [SCALE_TAGS[i % SCALE_TAG_COUNT]],
          });
        }
      },
      op: (adapter, i) => {
        if (i > 0 && i % scaleCycle === 0) {
          return adapter.invalidateTags(SCALE_TAGS[(i / scaleCycle) % SCALE_TAG_COUNT]).length;
        }
        return adapter.get(keys[access.ring[i & access.mask]]);
      },
      probe: (adapter) => {
        adapter.clear();
        const writes = Math.min(capacity, 256);
        for (let i = 0; i < writes; i += 1) {
          adapter.set(keys[i], values[i], {
            ttlMs: HOUR_MS,
            tags: [SCALE_TAGS[i % SCALE_TAG_COUNT]],
          });
        }
        const before = adapter.size();
        const removed = adapter.invalidateTags(SCALE_TAGS[0]).length;
        return [
          before,
          removed,
          adapter.size(),
          adapter.get(keys[0]) === undefined,
          sameValue(adapter.get(keys[1]), values[1]),
        ];
      },
    },

    {
      id: 'persistence-flush',
      category: 'persistence',
      title: 'flush a full cache of dirty records to storage',
      adapters: ['blaze-persist', 'map-persist', 'quicklru-persist'],
      async: true,
      opsPerBatch: 1,
      divisor: capacity,
      notes: [
        'One timed op is a whole `capacity`-record flush; `ns/op` is normalised to **per record** so it can be read beside the point operations.',
        'blaze uses its real write-through layer (debounce + reconciliation + one batched write) over an in-memory `CachePersistence`; the rivals use a hand-rolled pending-write queue over the same store. Node has no IndexedDB; the browser workspace runs the same scenario against real IDB-backed storage.',
        sizeNote,
      ],
      prepare: async (adapter) => {
        adapter.clear();
        await adapter.storeClear();
        for (let i = 0; i < capacity; i += 1) adapter.set(keys[i], values[i]);
      },
      op: async (adapter) => {
        await adapter.flush();
        return adapter.storeSize() === capacity;
      },
      probe: async (adapter) => {
        adapter.clear();
        await adapter.storeClear();
        const writes = Math.min(capacity, 32);
        for (let i = 0; i < writes; i += 1) adapter.set(keys[i], values[i]);
        await adapter.flush();
        return [adapter.storeSize(), sameValue(adapter.get(keys[0]), values[0])];
      },
    },

    {
      id: 'hydration',
      category: 'persistence',
      title: 'restore a full cache from storage',
      adapters: ['blaze-persist', 'map-persist', 'quicklru-persist'],
      async: true,
      opsPerBatch: 1,
      divisor: capacity,
      notes: [
        'One timed op restores `capacity` stored records into a cleared cache; `ns/op` is per restored record.',
        'Storage is seeded directly (bypassing the write path) so the number measures hydration alone. blaze uses `cache.persistence.hydrate()`; the rivals read the same rows and repopulate their stores.',
        sizeNote,
      ],
      prepare: async (adapter) => {
        adapter.clear();
        await adapter.storeClear();
        await adapter.seedRecords(records);
      },
      op: async (adapter) => {
        await adapter.hydrate();
        return adapter.size() === capacity;
      },
      probe: async (adapter) => {
        adapter.clear();
        await adapter.storeClear();
        await adapter.seedRecords(records.slice(0, 32));
        await adapter.hydrate();
        return [
          adapter.size(),
          sameValue(adapter.get(keys[0]), values[0]),
          adapter.get('absent:key:0') === undefined,
        ];
      },
    },
  ];
  // Stage 2 adapters are opt-in in the *suite* as well as in the product. Besides matching
  // "opt-in by default", this keeps bench:ci honest: a js-storage validation fills 10 000
  // entries and grows the shared Wasm heap, which measurably slows the blaze row measured
  // after it in the same process. The gate must compare like-for-like against the base tree,
  // so these rows live in the separate Stage 2 reports until a per-adapter process isolation
  // is in place. Use `--stage2` (or the stage2Json reports) to see them.
  if (includeStage2) {
    for (const scenario of scenariosResults) {
      if (!scenario.adapters.includes('blaze')) continue;
      scenario.adapters.push('blaze-js');
      if (payloadKind === 'bytes' && !scenario.async) scenario.adapters.push('blaze-bytes');
    }
  }

  return scenariosResults;
}
