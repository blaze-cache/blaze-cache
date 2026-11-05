import process from 'node:process';

import {
  BlazeAdapter,
  SWRAdapter,
  TanStackQueryAdapter,
} from './adapters.mjs';

/**
 * Deterministic payload strings. `--value-bytes` controls per-entry string size;
 * each entry gets a distinct payload suffix so values are not all the same
 * reference (keeps the benchmark honest for copy/value-sensitive stores).
 */
function makeValue(i, valueBytes) {
  const suffix = String(i);
  const pad = Math.max(0, valueBytes - suffix.length);
  return { id: i, payload: 'x'.repeat(pad) + suffix, label: `value:${i}` };
}

export function fill(adapter, capacity, valueBytes = 256) {
  for (let i = 0; i < capacity; i += 1) {
    adapter.set(`key:${i}`, makeValue(i, valueBytes));
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function spreadPercent(values) {
  const m = median(values);
  if (m <= 0) return 0;
  return ((Math.max(...values) - Math.min(...values)) / m) * 100;
}

/**
 * Measure one operation.
 * - prepare() runs untimed before every sample.
 * - GC runs before timing when available (Node --expose-gc).
 * - warmup samples are discarded so JIT/WASM tier-up does not skew medians.
 * - reports p50 (median) and p95 over recorded samples.
 */
function measureOp({ iterations, samples, warmup = 2, prepare, op }) {
  let sink = 0;
  const gc = typeof globalThis.gc === 'function' ? globalThis.gc : null;
  const run = () => {
    prepare?.();
    gc?.();
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) sink += op(i) ? 1 : 0;
    const end = process.hrtime.bigint();
    return Number(end - start) / iterations;
  };

  for (let w = 0; w < warmup; w += 1) run();
  const nsPerOpSamples = [];
  for (let s = 0; s < samples; s += 1) nsPerOpSamples.push(run());

  return {
    nsPerOp: median(nsPerOpSamples),
    p50: median(nsPerOpSamples),
    p95: percentile(nsPerOpSamples, 95),
    spread: spreadPercent(nsPerOpSamples),
    opsPerSample: iterations,
    samples: nsPerOpSamples.length,
    warmup,
    sink,
  };
}

function adapters() {
  return [
    { name: 'Blaze', label: 'Blaze (WASM core)', ctor: BlazeAdapter },
    {
      name: 'TanStack Query',
      label: 'TanStack Query (query-core)',
      ctor: TanStackQueryAdapter,
      note: 'includes query-key hashing/normalization + query-cache bookkeeping',
    },
    {
      name: 'SWR',
      label: 'SWR (cache store)',
      ctor: SWRAdapter,
      note: 'uses SWR initCache store in Node; real SWR apps also pay key serialization',
    },
  ];
}

export function buildScenarios({
  capacity,
  iterations,
  samples,
  warmup = 2,
  valueBytes = 256,
}) {
  const key = 'key:0';
  const missKey = 'absent:key:0';
  const value = makeValue(0, valueBytes);

  return [
    {
      id: 'warm-hit',
      title: 'read a present key from a filled cache',
      opLabel: 'get(key)',
      measure: (adapter) =>
        measureOp({
          iterations,
          samples,
          warmup,
          prepare: () => {
            adapter.clear();
            fill(adapter, capacity, valueBytes);
          },
          op: () => adapter.get(key),
        }),
      probe: (adapter) => {
        adapter.clear();
        fill(adapter, capacity, valueBytes);
        const v = adapter.get(key);
        return {
          present: v?.id === 0 && v?.label === 'value:0',
          size: adapter.size(),
          sizeOk: adapter.size() === capacity,
        };
      },
    },
    {
      id: 'miss',
      title: 'read an absent key from a filled cache',
      opLabel: 'get(key)',
      measure: (adapter) =>
        measureOp({
          iterations,
          samples,
          warmup,
          prepare: () => {
            adapter.clear();
            fill(adapter, capacity, valueBytes);
          },
          op: () => adapter.get(missKey),
        }),
      probe: (adapter) => {
        adapter.clear();
        fill(adapter, capacity, valueBytes);
        return {
          missing: adapter.get(missKey) === undefined,
          size: adapter.size(),
          sizeOk: adapter.size() === capacity,
        };
      },
    },
    {
      id: 'write',
      title: 'overwrite an existing key',
      opLabel: 'set(key, value)',
      measure: (adapter) =>
        measureOp({
          iterations,
          samples,
          warmup,
          prepare: () => {
            adapter.clear();
            fill(adapter, capacity, valueBytes);
          },
          op: (i) => adapter.set(key, makeValue(i, valueBytes)),
        }),
      probe: (adapter) => {
        adapter.clear();
        fill(adapter, capacity, valueBytes);
        adapter.set(key, makeValue(999999, valueBytes));
        return {
          updated: adapter.get(key)?.id === 999999,
          size: adapter.size(),
          sizeOk: adapter.size() === capacity,
        };
      },
    },
    {
      id: 'invalidate-by-key',
      title: 'delete a distinct present key (one delete per op)',
      opLabel: 'delete(key)',
      iterationsCap: (cap) => Math.min(iterations, cap),
      measure: (adapter, n = iterations) =>
        measureOp({
          iterations: Math.min(n, capacity),
          samples,
          warmup,
          prepare: () => {
            adapter.clear();
            fill(adapter, capacity, valueBytes);
          },
          op: (i) => adapter.delete(`key:${i}`),
        }),
      probe: (adapter) => {
        adapter.clear();
        fill(adapter, capacity, valueBytes);
        const removed = adapter.delete('key:7');
        return {
          removed: removed === true,
          after: adapter.get('key:7'),
          size: adapter.size(),
          sizeOk: adapter.size() === capacity - 1,
        };
      },
    },
  ];
}

function probeFailed(probe) {
  return (
    probe.present === false ||
    probe.missing === false ||
    probe.updated === false ||
    probe.removed === false ||
    probe.sizeOk === false
  );
}

export async function runScenarios(options = {}) {
  const {
    capacity = 10000,
    iterations = 20000,
    samples = 7,
    warmup = 2,
    valueBytes = 256,
  } = options;

  const defs = adapters();
  const scenarios = buildScenarios({ capacity, iterations, samples, warmup, valueBytes });
  const results = [];

  for (const scenario of scenarios) {
    let scenarioIterations = iterations;
    if (scenario.id === 'invalidate-by-key') {
      if (iterations > capacity) {
        throw new Error(
          `invalidate-by-key requires iterations <= capacity (got ${iterations} > ${capacity}); each iteration deletes a distinct pre-filled key`,
        );
      }
      scenarioIterations = iterations;
    }

    for (const def of defs) {
      const instance = await new def.ctor().create({ capacity });
      try {
        const probe = scenario.probe(instance);
        if (probeFailed(probe)) {
          throw new Error(`${scenario.id}/${def.label} probe failed: ${JSON.stringify(probe)}`);
        }
        const stats =
          scenario.id === 'invalidate-by-key'
            ? scenario.measure(instance, scenarioIterations)
            : scenario.measure(instance);
        results.push({
          scenario: scenario.id,
          adapter: def.name,
          label: def.label,
          note: def.note,
          probe,
          ...stats,
        });
      } finally {
        instance.dispose?.();
      }
    }

    const best = Math.min(
      ...results.filter((r) => r.scenario === scenario.id).map((r) => r.nsPerOp),
    );
    for (const row of results) {
      if (row.scenario === scenario.id) row.relative = row.nsPerOp / best;
    }
  }

  return {
    config: { capacity, iterations, samples, warmup, valueBytes },
    scenarios: scenarios.map(({ id, title, opLabel }) => ({ id, title, opLabel })),
    adapters: defs.map(({ name, label, note }) => ({ name, label, note })),
    results,
  };
}

// Back-compat for old single-op path; kept minimal.
export async function runScenario(scenarioName, scenarioFn, options = {}) {
  const { capacity = 1000, key = 'key:0' } = options;
  const defs = [BlazeAdapter, TanStackQueryAdapter, SWRAdapter];
  const names = ['Blaze', 'TanStack Query', 'SWR'];
  const results = [];
  for (let i = 0; i < defs.length; i++) {
    const adapter = await new defs[i]().create({ capacity });
    const result = await scenarioFn(adapter, capacity, key);
    adapter.dispose?.();
    results.push({ scenario: scenarioName, adapter: names[i], ...result });
  }
  return results;
}
