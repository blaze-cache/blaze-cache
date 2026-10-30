/**
 * Timing harness for the cache benchmark.
 *
 * A measurement is built from three phases:
 *
 *  1. **calibration** — the batch is doubled until it costs at least `PROBE_NS`, then
 *     scaled to land near `targetMs`. This is what keeps a 15 ns `Map.get` and a 400 ns
 *     wasm round-trip measured over comparable spans of time instead of one of them being
 *     timed by a clock that is noisier than the work itself.
 *  2. **warm-up** — `warmupBatches` identical batches, discarded, so the JIT reaches its
 *     steady tier before anything is recorded.
 *  3. **measurement** — `samples` batches, each an independent timing; the reported figure
 *     is the **median** of those samples, with the full range kept for the spread column.
 *
 * `prepare` runs before every batch but *outside* the timed region. Scenarios that must
 * start from an empty cache (a cold fill) therefore do not pay for the `clear()` that
 * makes the batch repeatable.
 *
 * The harness folds every `op` result into a running total. The total is never used for a
 * number — it exists so the compiler cannot prove the loop's result unused and drop the
 * very work being measured. Only the assignment happens inside the loop, so the overhead
 * is one branch and one add per operation, and it is **identical for every adapter in a
 * scenario**, which keeps the comparison — the thing the benchmark is actually about — fair.
 */
import process from 'node:process';

/** Nanoseconds in one second. */
const NS_PER_SECOND = 1e9;
/** Calibration keeps doubling the batch until it costs at least this long. */
const PROBE_NS = 20_000_000;
/** Batch floor: below this the clock's own resolution dominates the measurement. */
const MIN_BATCH = 64;
/** Batch ceiling, so a pathological calibration cannot run away. */
const MAX_BATCH = 50_000_000;
/** Ceiling on batches per sample, so a very cheap scenario cannot loop forever. */
const MAX_BATCHES_PER_SAMPLE = 10_000;

/** Arithmetic median of `values`. */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Total spread of the samples around their median, as a percentage of that median. */
export function spreadPercent(values) {
  const middle = median(values);
  if (middle <= 0) return 0;
  return ((Math.max(...values) - Math.min(...values)) / middle) * 100;
}

/** Yields to the event loop so a sample's garbage is collectable before the next one. */
const breathe = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Times `op` and returns summary statistics.
 *
 * @param {object} options
 * @param {(iteration: number) => unknown} options.op  one timed operation
 * @param {() => void} [options.prepare]               untimed reset before each batch
 * @param {number} [options.opsPerBatch]               fixed batch size (e.g. one cold fill);
 *                                                     omit to calibrate it
 * @param {number} [options.samples]                   batches to record
 * @param {number} [options.targetMs]                  approximate length of each sample
 * @param {number} [options.warmupBatches]             discarded batches before recording
 * @returns {Promise<{nsPerOp: number, opsPerSecond: number, spread: number,
 *   samples: number[], opsPerSample: number, sink: number}>}
 */
export async function measure({
  op,
  prepare,
  opsPerBatch,
  samples = 7,
  targetMs = 120,
  warmupBatches = 3,
}) {
  const targetNs = targetMs * 1_000_000;
  const gc = typeof globalThis.gc === 'function' ? globalThis.gc.bind(globalThis) : () => {};

  /** One untimed `prepare`, then `n` timed ops. */
  const timedBatch = (n) => {
    prepare?.();
    const start = process.hrtime.bigint();
    let sink = 0;
    for (let i = 0; i < n; i += 1) sink += op(i) ? 1 : 0;
    return { ns: Number(process.hrtime.bigint() - start), sink };
  };

  // --- 1. calibrate ------------------------------------------------------
  let n = opsPerBatch ?? MIN_BATCH;
  if (opsPerBatch === undefined) {
    let { ns } = timedBatch(n);
    while (ns < PROBE_NS && n < MAX_BATCH) {
      n = Math.min(MAX_BATCH, n * 2);
      ({ ns } = timedBatch(n));
    }
    if (ns > 0) {
      n = Math.min(MAX_BATCH, Math.max(MIN_BATCH, Math.round((n * targetNs) / ns)));
    }
  }

  // --- 2. warm up (discarded) -------------------------------------------
  let sink = 0;
  for (let w = 0; w < warmupBatches; w += 1) sink += timedBatch(n).sink;

  // --- 3. record ---------------------------------------------------------
  const probe = timedBatch(n);
  const batchesPerSample = Math.max(
    1,
    Math.min(MAX_BATCHES_PER_SAMPLE, Math.round(targetNs / Math.max(probe.ns, 1))),
  );
  const opsPerSample = n * batchesPerSample;

  const nsPerOpSamples = [];
  for (let s = 0; s < samples; s += 1) {
    await breathe();
    gc();

    let ns = 0;
    for (let b = 0; b < batchesPerSample; b += 1) {
      const batch = timedBatch(n);
      ns += batch.ns;
      sink += batch.sink;
    }
    nsPerOpSamples.push(ns / opsPerSample);
  }

  const nsPerOp = median(nsPerOpSamples);
  return {
    nsPerOp,
    opsPerSecond: NS_PER_SECOND / nsPerOp,
    spread: spreadPercent(nsPerOpSamples),
    samples: nsPerOpSamples,
    opsPerSample,
    sink,
  };
}
