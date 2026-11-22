/**
 * Orchestrates a benchmark run.
 *
 * Every scenario runs twice over, in this order:
 *
 *  1. **validation** — each adapter is built fresh, given the scenario's `setup`, and asked
 *     for its `probe` observations. The observations must be *deeply equal across every
 *     adapter in the scenario*. This is the fairness guarantee: a typo'd method, an option silently ignored
 *     or an adapter storing nothing at all fails here, loudly, instead of quietly producing
 *     a flattering or damning number. It runs first so a broken comparison never wastes
 *     time being measured.
 *  2. **measurement** — a second, pristine adapter per entry, timed by {@link measure} (or
 *     {@link measureAsync} for scenarios with an awaited `prepare`/`op`).
 *
 * Validation deliberately uses its own instances so the probe can mutate state freely
 * without the timing ever seeing it.
 *
 * The module is shared verbatim with the browser workspace: everything that used to import
 * `node:os`/`node:process` is now detected from globals, so the same orchestration, the same
 * probe guard and the same median/spread methodology run in both targets.
 */
import { measure, measureAsync } from './harness.mjs';
import { PAYLOAD_SIZES, createValueFactory } from './payloads.mjs';
import { buildScenarios } from './scenarios.mjs';

/**
 * A tiny deep-equality assertion, deliberately dependency-free so this module also runs in the
 * browser. Probe observations are arrays of primitives (booleans, counts, short strings), so a
 * recursive strict comparison is both sufficient and deterministic across runtimes.
 */
export function assertDeepStrictEqual(actual, expected, message) {
  const equal = (a, b) => {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null) return false;
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      return a.every((value, index) => equal(value, b[index]));
    }
    if (typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b);
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
  };
  if (!equal(actual, expected)) throw new Error(message);
}

/** Overridable run parameters. The defaults are sized for a readable, stable table. */
export const DEFAULTS = {
  capacity: 10_000,
  samples: 7,
  targetMs: 120,
  warmupBatches: 3,
};

/**
 * Describes the runtime without assuming Node. The browser uses the same fields so a results
 * page can line the two columns up.
 */
export function detectEnvironment() {
  const isNode = typeof process !== 'undefined' && typeof process.versions?.node === 'string';
  if (isNode) {
    let cpu = 'unknown';
    try {
      cpu = process.report?.getReport?.()?.header?.cpuModel ?? 'unknown';
    } catch {
      // Some restricted runtimes disable `process.report`; the rest of the report is intact.
    }
    return {
      runtime: 'node',
      version: process.version,
      platform: `${process.platform} ${process.arch}`,
      cpu,
      cores: globalThis.navigator?.hardwareConcurrency ?? null,
    };
  }
  return {
    runtime: 'browser',
    version: navigator.userAgent,
    platform: `${navigator.platform} · ${navigator.hardwareConcurrency ?? '?'} cores`,
    cpu: navigator.userAgentData?.platform ?? navigator.platform,
  };
}

/**
 * Runs the benchmark and returns its results.
 *
 * @param {object} [options] see {@link DEFAULTS}, plus `payload`/`payloadKind` (the matrix
 *   cell), `filter` (substring of a scenario id) and `onProgress`
 * @returns {Promise<{environment: object, config: object, scenarios: object[], rows: object[]}>}
 */
export async function runBenchmark(options = {}) {
  const {
    capacity,
    samples,
    targetMs,
    warmupBatches,
    payload,
    payloadKind,
    includeStage2 = false,
    filter = null,
    onProgress = null,
    adapters,
  } = { ...DEFAULTS, ...options };

  if (adapters === undefined) {
    throw new Error('runBenchmark needs an adapters registry (see adapters.mjs)');
  }
  const { createAdapter, adapterLabel } = adapters;
  const factory = createValueFactory({ payload, payloadKind });
  const scenarios = buildScenarios({ capacity, ...factory, payloadKind, includeStage2 }).filter(
    (scenario) => filter === null || scenario.id.includes(filter),
  );
  if (scenarios.length === 0) {
    throw new Error(`no scenario matches "${filter}"`);
  }

  const rows = [];
  for (const scenario of scenarios) {
    await validateScenario(scenario, capacity, adapters);

    for (const name of scenario.adapters) {
      onProgress?.({ scenario: scenario.id, adapter: adapterLabel(name), payload: factory.label });

      const adapter = await createAdapter(name, { capacity });
      let stats;
      try {
        scenario.setup?.(adapter);
        const timing = scenario.async ? measureAsync : measure;
        stats = await timing({
          op: (iteration) => scenario.op(adapter, iteration),
          prepare: scenario.prepare ? () => scenario.prepare(adapter) : undefined,
          opsPerBatch: scenario.opsPerBatch,
          samples,
          targetMs,
          warmupBatches,
          divisor: scenario.divisor ?? 1,
        });
      } finally {
        await adapter.dispose();
      }

      rows.push({
        scenario: scenario.id,
        adapter: adapterLabel(name),
        payload: factory.payload,
        payloadKind: factory.kind,
        ...stats,
      });
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
    environment: detectEnvironment(),
    config: {
      capacity,
      samples,
      targetMs,
      warmupBatches,
      payload: factory.payload,
      payloadKind: factory.kind,
    },
    scenarios: scenarios.map(({ id, title, notes, category }) => ({ id, title, notes, category })),
    rows,
  };
}

/**
 * Runs one benchmark per payload size and merges them into a single report. Each run gets its
 * own factory and its own adapters, so a 1 MB working set cannot bleed into a 64 B one.
 */
export async function runPayloadMatrix(options = {}) {
  const runs = [];
  for (const payload of Object.keys(PAYLOAD_SIZES)) {
    runs.push(await runBenchmark({ ...options, payload }));
  }
  const first = runs[0];
  return {
    ...first,
    config: { ...first.config, matrix: true },
    scenarios: first.scenarios,
    rows: runs.flatMap((run) => run.rows),
    runs,
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
export async function validateScenario(scenario, capacity, adapters) {
  if (adapters === undefined) {
    throw new Error('validateScenario needs an adapters registry (see adapters.mjs)');
  }
  const { createAdapter, adapterLabel } = adapters;
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
    assertDeepStrictEqual(
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
