/**
 * Smoke tests for the framework benchmark suite.
 *
 * Guards: real cache-store adapters (Blaze/WASM, TanStack Query query-core,
 * SWR cache store) expose equivalent observable behavior for timed scenarios;
 * runner output shape is stable. Map/QuickLRU baselines live in benchmarks/cache.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BlazeAdapter,
  SWRAdapter,
  TanStackQueryAdapter,
} from '../adapters.mjs';
import { buildScenarios, runScenarios } from '../scenarios.mjs';

const TINY = { capacity: 32, iterations: 20, samples: 2, warmup: 0, valueBytes: 64 };
const ADAPTERS = [
  ['Blaze', BlazeAdapter],
  ['TanStack Query', TanStackQueryAdapter],
  ['SWR', SWRAdapter],
];

async function withAdapter(Ctor, fn) {
  const adapter = await new Ctor().create({ capacity: TINY.capacity });
  try {
    await fn(adapter);
  } finally {
    adapter.dispose?.();
  }
}

describe('framework benchmark adapters', () => {
  it('implement the cache-store surface used by scenarios', async () => {
    for (const [name, Ctor] of ADAPTERS) {
      await withAdapter(Ctor, (adapter) => {
        for (const method of ['get', 'set', 'delete', 'size', 'clear']) {
          assert.equal(typeof adapter[method], 'function', `${name}.${method}`);
        }
        adapter.clear();
        assert.equal(adapter.size(), 0, `${name} starts/clears empty`);
        adapter.set('k', { id: 1 });
        assert.deepEqual(adapter.get('k'), { id: 1 }, `${name} round-trips value`);
        assert.equal(adapter.size(), 1, `${name} reports size`);
        assert.equal(adapter.delete('k'), true, `${name} deletes present key`);
        assert.equal(adapter.get('k'), undefined, `${name} key gone after delete`);
      });
    }
  });
});

describe('framework benchmark scenarios', () => {
  it('define ids, titles, ops, probes, and measure hooks', () => {
    const scenarios = buildScenarios(TINY);
    assert.ok(scenarios.length >= 4, 'has core scenarios');
    for (const scenario of scenarios) {
      assert.ok(scenario.id && scenario.title && scenario.opLabel, `${scenario.id} described`);
      assert.equal(typeof scenario.probe, 'function', `${scenario.id} has probe`);
      assert.equal(typeof scenario.measure, 'function', `${scenario.id} has measure`);
    }
    const ids = scenarios.map((s) => s.id);
    for (const expected of ['warm-hit', 'miss', 'write', 'invalidate-by-key']) {
      assert.ok(ids.includes(expected), `includes ${expected}`);
    }
  });

  it('probes pass for every real adapter', async () => {
    const scenarios = buildScenarios(TINY);
    for (const scenario of scenarios) {
      for (const [name, Ctor] of ADAPTERS) {
        await withAdapter(Ctor, (adapter) => {
          const probe = scenario.probe(adapter);
          const bad = Object.entries(probe).find(([, v]) => v === false);
          assert.equal(
            bad,
            undefined,
            `${scenario.id}/${name} probe failed: ${JSON.stringify(probe)}`,
          );
        });
      }
    }
  });

  it('invalidate-by-key rejects iterations > capacity', async () => {
    await assert.rejects(
      () => runScenarios({ capacity: 10, iterations: 11, samples: 1, warmup: 0, valueBytes: 8 }),
      /iterations <= capacity/,
    );
  });
});

describe('framework benchmark runner output', () => {
  it('produces measured rows for every adapter/scenario with sane stats', async () => {
    const result = await runScenarios(TINY);
    assert.deepEqual(result.config, TINY);
    assert.equal(result.scenarios.length, 4);
    assert.equal(result.adapters.length, 3);
    assert.equal(result.results.length, 12, '3 adapters × 4 scenarios');

    for (const row of result.results) {
      const label = `${row.scenario}/${row.adapter}`;
      assert.ok(row.label, `${label} has display label`);
      assert.ok(Number.isFinite(row.nsPerOp) && row.nsPerOp > 0, `${label} has ns/op`);
      assert.ok(Number.isFinite(row.p50) && row.p50 > 0, `${label} has p50`);
      assert.ok(Number.isFinite(row.p95) && row.p95 > 0, `${label} has p95`);
      assert.ok(Number.isFinite(row.spread) && row.spread >= 0, `${label} has spread`);
      assert.equal(row.samples, TINY.samples, `${label} records requested samples`);
      assert.equal(row.warmup, TINY.warmup, `${label} records warmup`);
      assert.ok(Number.isFinite(row.relative) && row.relative >= 1, `${label} has relative`);
      assert.ok(row.probe && typeof row.probe === 'object', `${label} includes probe`);
    }

    for (const scenario of result.scenarios) {
      const rows = result.results.filter((r) => r.scenario === scenario.id);
      assert.ok(rows.some((r) => r.relative === 1), `${scenario.id} has a best adapter`);
      if (scenario.id === 'invalidate-by-key') {
        for (const r of rows) assert.equal(r.opsPerSample, TINY.iterations, `${r.label} deletes distinct keys`);
      }
    }
  });
});
