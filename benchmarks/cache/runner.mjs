/**
 * Orchestrates a benchmark run.
 *
 * Every scenario runs twice over, in this order:
 *
 *  1. **validation** — each adapter is built fresh, given the scenario's `setup`, and asked
 *     for its `probe` observations. The observations must be *deeply equal across all three
 *     adapters*. This is the fairness guarantee: a typo'd method, an option silently ignored
 *     or an adapter storing nothing at all fails here, loudly, instead of quietly producing
 *     a flattering or damning number. It runs first so a broken comparison never wastes
 *     time being measured.
 *  2. **measurement** — a second, pristine adapter per entry, timed by {@link measure}.
 *
 * Validation deliberately uses its own instances so the probe can mutate state freely
 * without the timing ever seeing it.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import process from 'node:process';

import { adapterLabel, createAdapter } from './adapters.mjs';
import { measure } from './harness.mjs';
import { buildScenarios } from './scenarios.mjs';

/** Overridable run parameters. The defaults are sized for a readable, stable table. */
export const DEFAULTS = {
  capacity: 10_000,
  samples: 7,
  targetMs: 120,
  warmupBatches: 3,
};

/**
 * Runs the benchmark and returns its results.
 *
 * @param {object} [options] see {@link DEFAULTS}, plus `filter` (substring of a scenario id)
 *   and `onProgress` (called before each timing)
 * @returns {Promise<{environment: object, config: object, scenarios: object[], rows: object[]}>}
 */
export async function runBenchmark(options = {}) {
  const {
    capacity,
    samples,
    targetMs,
    warmupBatches,
    filter = null,
    onProgress = null,
  } = { ...DEFAULTS, ...options };

  const scenarios = buildScenarios(capacity).filter(
    (scenario) => filter === null || scenario.id.includes(filter),
  );
  if (scenarios.length === 0) {
    throw new Error(`no scenario matches "${filter}"`);
  }

  const rows = [];
  for (const scenario of scenarios) {
    await validateScenario(scenario, capacity);

    for (const name of scenario.adapters) {
      onProgress?.({ scenario: scenario.id, adapter: adapterLabel(name) });

      const adapter = await createAdapter(name, { capacity });
      let stats;
      try {
        scenario.setup?.(adapter);
        stats = await measure({
          op: (iteration) => scenario.op(adapter, iteration),
          prepare: scenario.prepare ? () => scenario.prepare(adapter) : undefined,
          opsPerBatch: scenario.opsPerBatch,
          samples,
          targetMs,
          warmupBatches,
        });
      } finally {
        await adapter.dispose();
      }

      rows.push({ scenario: scenario.id, adapter: adapterLabel(name), ...stats });
    }

    // "vs best" is meaningful only within a scenario — the units are the same, the
    // workloads are not.
    const best = Math.max(
      ...rows.filter((row) => row.scenario === scenario.id).map((row) => row.opsPerSecond),
    );
    for (const row of rows) {
      if (row.scenario === scenario.id) row.relative = row.opsPerSecond / best;
    }
  }

  return {
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      cpu: os.cpus()[0]?.model ?? 'unknown',
    },
    config: { capacity, samples, targetMs, warmupBatches },
    scenarios: scenarios.map(({ id, title, notes }) => ({ id, title, notes })),
    rows,
  };
}

/**
 * Builds every adapter for `scenario`, collects its probe observations and asserts they
 * agree. Returns how many adapters were compared, for callers that want to report it.
 *
 * Exported so the smoke tests can prove the guard still fires — a validation that no
 * longer rejects a bad comparison is worse than none, because it looks like coverage.
 *
 * @throws {AssertionError} when two adapters disagree about what the workload produced
 */
export async function validateScenario(scenario, capacity) {
  const observed = [];
  for (const name of scenario.adapters) {
    const adapter = await createAdapter(name, { capacity });
    try {
      scenario.setup?.(adapter);
      observed.push({ name, result: await scenario.probe(adapter) });
    } finally {
      await adapter.dispose();
    }
  }

  const [first, ...rest] = observed;
  for (const candidate of rest) {
    assert.deepStrictEqual(
      candidate.result,
      first.result,
      `${scenario.id}: ${adapterLabel(candidate.name)} observed ` +
        `${JSON.stringify(candidate.result)}, but ${adapterLabel(first.name)} observed ` +
        `${JSON.stringify(first.result)} — these adapters are not doing equivalent work, ` +
        `so their timings would not be comparable`,
    );
  }
  return observed.length;
}
