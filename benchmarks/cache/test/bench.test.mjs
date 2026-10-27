/**
 * Smoke tests for the benchmark itself.
 *
 * A benchmark that quietly compares two things that are not the same workload is worse
 * than no benchmark: it looks authoritative and answers the wrong question. These tests
 * guard the machinery that stops that happening — the adapter contract, the probe
 * equivalence check, and the harness's arithmetic — against the built artifacts, exactly
 * like the core suite does.
 *
 *   pnpm --filter blaze-cache-bench test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ADAPTERS, adapterLabel, createAdapter } from '../adapters.mjs';
import { median, measure, spreadPercent } from '../harness.mjs';
import { runBenchmark, validateScenario } from '../runner.mjs';
import { buildScenarios } from '../scenarios.mjs';

/** Small enough to finish in well under a second, large enough to evict nothing. */
const TINY = { capacity: 64, samples: 2, targetMs: 5, warmupBatches: 1 };

describe('adapters', () => {
  it('builds every registry entry with the surface the scenarios call', async () => {
    const surface = ['get', 'set', 'delete', 'size', 'clear', 'dispose'];
    for (const name of Object.keys(ADAPTERS)) {
      const adapter = await createAdapter(name, { capacity: 8 });
      try {
        for (const method of surface) {
          assert.equal(typeof adapter[method], 'function', `${name}.${method} exists`);
        }
        assert.equal(adapter.size(), 0, `${name} starts empty`);
        adapter.set('k', 1);
        assert.equal(adapter.get('k'), 1, `${name} round-trips a value`);
        assert.equal(adapter.size(), 1);
        adapter.clear();
        assert.equal(adapter.size(), 0, `${name} clears`);
        assert.ok(adapterLabel(name).length > 0, `${name} has a printable label`);
      } finally {
        await adapter.dispose();
      }
    }
  });

  it('exposes invalidateTags wherever a scenario invalidates', async () => {
    const candidates = new Set(buildScenarios(64).flatMap((scenario) => scenario.adapters));
    let checked = 0;
    for (const name of candidates) {
      // Capability, not name: a scenario's adapters must all be able to do what the
      // scenario's op does, and matching on a substring would silently skip a rename.
      const probe = await createAdapter(name, { capacity: 8 });
      const canInvalidate = typeof probe.invalidateTags === 'function';
      await probe.dispose();
      if (!canInvalidate) continue;

      const adapter = await createAdapter(name, { capacity: 8 });
      try {
        adapter.set('k', 1, { tags: ['t'] });
        assert.deepEqual(adapter.invalidateTags('t'), ['k'], `${name} invalidates by tag`);
        assert.equal(adapter.size(), 0, `${name} removed the tagged key`);
        checked += 1;
      } finally {
        await adapter.dispose();
      }
    }
    assert.ok(checked >= 3, `the headline adapters all invalidate (checked ${checked})`);
  });

  it('reports a deadline as gone once it lapses, on all three full-featured stores', async () => {
    for (const name of ['map-full', 'quicklru-full', 'blaze']) {
      const adapter = await createAdapter(name, { capacity: 8 });
      try {
        adapter.set('short', 'value', { ttlMs: 1 });
        adapter.set('long', 'value', { ttlMs: 60_000 });
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(adapter.get('short'), undefined, `${name} expires the short entry`);
        assert.equal(adapter.get('long'), 'value', `${name} keeps the live one`);
      } finally {
        await adapter.dispose();
      }
    }
  });
});

describe('scenarios', () => {
  it('names only registered adapters and defines the hooks they need', () => {
    const scenarios = buildScenarios(64);
    for (const scenario of scenarios) {
      assert.ok(scenario.id && scenario.title && scenario.notes.length > 0, `${scenario.id} is described`);
      assert.equal(typeof scenario.op, 'function', `${scenario.id} has an op`);
      assert.equal(typeof scenario.probe, 'function', `${scenario.id} has a probe`);
      assert.ok(scenario.adapters.length >= 2, `${scenario.id} compares at least two adapters`);
      for (const name of scenario.adapters) {
        assert.ok(ADAPTERS[name], `${scenario.id} references the registered adapter "${name}"`);
      }
    }
  });

  it('includes a headline, and gives it the features the table claims', async () => {
    const byId = new Map(buildScenarios(64).map((scenario) => [scenario.id, scenario]));
    const headline = byId.get('full-featured');
    assert.ok(headline, 'the headline scenario exists');

    // Every adapter in the headline must support the whole feature set, or the row would
    // be timing three different questions against each other.
    const observed = [];
    for (const name of headline.adapters) {
      const adapter = await createAdapter(name, { capacity: 8 });
      try {
        adapter.set('k', 1, { ttlMs: 60_000, tags: ['t'] });
        observed.push({
          name,
          canInvalidate: typeof adapter.invalidateTags,
          readsBack: adapter.get('k'),
          holdsOne: adapter.size(),
        });
      } finally {
        await adapter.dispose();
      }
    }
    const [first, ...rest] = observed;
    for (const other of rest) {
      assert.equal(other.canInvalidate, first.canInvalidate, `${other.name} invalidates like ${first.name}`);
      assert.equal(other.readsBack, first.readsBack, `${other.name} reads back like ${first.name}`);
      assert.equal(other.holdsOne, first.holdsOne, `${other.name} holds like ${first.name}`);
    }
    assert.equal(first.canInvalidate, 'function', 'the headline adapters can invalidate');
    assert.equal(first.readsBack, 1, 'the headline adapters read back the value');
    assert.equal(first.holdsOne, 1, 'the headline adapters hold the entry');
  });

  it('runs every scenario adapter identically for the same workload', async () => {
    const result = await runBenchmark(TINY);
    assert.equal(
      result.rows.length,
      buildScenarios(TINY.capacity).length * 3,
      'three adapters measured for every scenario',
    );
    for (const row of result.rows) {
      const label = `${row.scenario}/${row.adapter}`;
      assert.ok(Number.isFinite(row.nsPerOp) && row.nsPerOp > 0, `${label} has a real ns/op`);
      assert.ok(row.opsPerSecond > 0, `${label} has a throughput`);
      assert.ok(row.relative > 0 && row.relative <= 1.0000001, `${label} is at most "vs best"`);
      assert.ok(Number.isFinite(row.spread) && row.spread >= 0, `${label} reports a spread`);
      assert.equal(row.samples.length, TINY.samples, `${label} recorded every sample`);
    }
  });
});

describe('equivalence guard', () => {
  it('rejects two adapters that disagree about what the workload produced', async () => {
    // Fill past the capacity blaze enforces but Map, having no capacity, does not: their
    // sizes must differ, which is exactly the divergence the guard exists to catch.
    const scenario = {
      id: 'deliberately-unequal',
      title: 'two stores that cannot agree',
      adapters: ['map', 'blaze'],
      op: () => undefined,
      setup: (adapter) => {
        for (let i = 0; i < 9; i += 1) adapter.set(`key:${i}`, i);
      },
      probe: (adapter) => [adapter.size()],
    };

    await assert.rejects(
      () => validateScenario(scenario, 8),
      /not doing equivalent work/,
      'an unequal comparison fails loudly instead of producing a number',
    );
  });

  it('accepts adapters that do agree, and counts them', async () => {
    const scenario = {
      id: 'deliberately-equal',
      title: 'two stores that agree',
      adapters: ['map', 'quicklru'],
      op: () => undefined,
      setup: (adapter) => adapter.set('key:0', 'value'),
      probe: (adapter) => [adapter.get('key:0'), adapter.size()],
    };
    assert.equal(await validateScenario(scenario, 8), 2, 'both adapters were compared');
  });
});

describe('harness', () => {
  it('medians and spreads follow from the samples', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2.5);
    assert.equal(spreadPercent([20, 20, 20]), 0, 'identical samples have no spread');
    assert.equal(spreadPercent([10, 20, 30]), 100, 'range as a percentage of the median');
  });

  it('calibrates a batch, keeps every sample, and survives a no-op prepare', async () => {
    let calls = 0;
    const stats = await measure({
      op: (iteration) => {
        calls += 1;
        return iteration;
      },
      prepare: () => {},
      samples: 3,
      targetMs: 5,
      warmupBatches: 1,
    });

    assert.equal(stats.samples.length, 3, 'every sample is recorded');
    assert.ok(stats.opsPerSample >= 64, 'the batch was grown past the floor');
    assert.ok(stats.nsPerOp > 0 && Number.isFinite(stats.nsPerOp));
    assert.ok(stats.opsPerSecond > 0 && Number.isFinite(stats.opsPerSecond));
    assert.ok(stats.spread >= 0 && Number.isFinite(stats.spread));
    // Strictly more than the recorded work: calibration and warm-up ran `op` too.
    assert.ok(
      calls > stats.samples.length * stats.opsPerSample,
      `the loop really ran (${calls} calls for ${stats.samples.length} × ` +
        `${stats.opsPerSample} recorded)`,
    );
  });

  it('rejects a filter that matches nothing instead of reporting an empty table', async () => {
    await assert.rejects(() => runBenchmark({ ...TINY, filter: 'no-such-scenario' }), /no scenario matches/);
  });
});
