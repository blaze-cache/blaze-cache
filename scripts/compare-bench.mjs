#!/usr/bin/env node
/**
 * CI regression gate for the cache benchmark.
 *
 * Reads a `--quick` result and a checked-in baseline and fails when any matched row got more
 * than 20% slower. New rows (a new adapter or scenario) are reported but cannot fail a build:
 * there is no honest baseline to compare them to until one is committed. Improvements are
 * reported and ignored — this is a regression gate, not a leaderboard.
 *
 * Rows are matched on runtime + payload + payload kind + scenario + adapter. Each row is
 * normalised by the median ns/op of its own scenario+payload cell before comparison, so a
 * faster or slower CI runner scales every adapter together and cannot trigger a false alarm.
 * What is gated is therefore the *shape* of the result — blaze against its peers — not the
 * absolute clock. Refresh the baseline deliberately when the workload itself changes.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const THRESHOLD = 0.2;

function key(row) {
  return [
    row.environment?.runtime ?? 'node',
    row.payload ?? 'small',
    row.payloadKind ?? 'object',
    row.scenario,
    row.adapter,
  ].join('|');
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * A single GC pause or scheduler preemption can inflate one sample several-fold (the raw
 * `--quick` runs contain samples like 58, 58, 58, 61, 101). The published report keeps them —
 * that is what the spread column is for — but a regression gate should compare the steady
 * state, so drop samples more than 1.5× the median before taking the central value. A real
 * regression moves *every* sample and is unaffected; a one-off spike no longer fails a PR.
 */
function steadySamples(row) {
  const samples = (Array.isArray(row.samples) ? row.samples : [row.nsPerOp]).filter(
    (value) => Number.isFinite(value) && value > 0,
  );
  if (samples.length === 0) return [row.nsPerOp];
  const mid = median(samples);
  const kept = samples.filter((value) => value <= mid * 1.5);
  return kept.length > 0 ? kept : samples;
}

function steadyNs(row) {
  return median(steadySamples(row));
}

function steadySpread(row) {
  const samples = steadySamples(row);
  const mid = median(samples);
  return mid > 0 ? ((Math.max(...samples) - Math.min(...samples)) / mid) * 100 : 0;
}

function group(row) {
  return [
    row.environment?.runtime ?? 'node',
    row.payload ?? 'small',
    row.payloadKind ?? 'object',
    row.scenario,
  ].join('|');
}

/** Normalises each row by its cell's median so hardware speed cancels out. */
function index(report) {
  const rows = report.rows ?? [];
  const byGroup = new Map();
  for (const row of rows) {
    const groupKey = group(row);
    if (!byGroup.has(groupKey)) byGroup.set(groupKey, []);
    byGroup.get(groupKey).push(row);
  }
  const scales = new Map(
    [...byGroup].map(([groupKey, groupRows]) => [groupKey, median(groupRows.map(steadyNs))]),
  );
  const map = new Map();
  for (const row of rows) {
    map.set(key(row), {
      ratio: steadyNs(row) / Math.max(scales.get(group(row)), 1),
      nsPerOp: steadyNs(row),
      spread: steadySpread(row),
    });
  }
  return map;
}

async function load(path) {
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}

async function main() {
  const [currentPath, baselinePath = 'benchmarks/results/baseline.node.json'] =
    process.argv.slice(2);
  if (!currentPath) {
    process.stderr.write('usage: node compare-bench.mjs <current.json> [baseline.json]\n');
    process.exitCode = 2;
    return;
  }

  const current = index(await load(currentPath));
  const baseline = index(await load(baselinePath));

  const changes = [];
  const unmatched = [];
  for (const [id, currentRow] of current) {
    const before = baseline.get(id);
    if (before === undefined) {
      unmatched.push(id);
      continue;
    }
    changes.push({
      id,
      before: before.ratio,
      after: currentRow.ratio,
      beforeNs: before.nsPerOp,
      afterNs: currentRow.nsPerOp,
      delta: (currentRow.ratio - before.ratio) / Math.max(before.ratio, 1e-12),
      // A noisy row needs a bigger move before it means anything. Cap the allowance so a
      // pathological spread cannot turn the gate into a no-op.
      threshold: Math.max(THRESHOLD, Math.min(0.4, Math.max(before.spread, currentRow.spread) / 100)),
    });
  }
  changes.sort((a, b) => b.delta - a.delta);

  const regressions = changes.filter((change) => change.delta > change.threshold);
  const worst = changes.slice(0, 8);
  process.stdout.write(
    `bench:ci — ${changes.length} matched rows, threshold +20% (scenario-normalised)\n`,
  );
  for (const change of worst) {
    process.stdout.write(
      `  ${change.delta >= 0 ? '+' : ''}${(change.delta * 100).toFixed(1).padStart(6)}%  ` +
        `${change.beforeNs.toFixed(1)} → ${change.afterNs.toFixed(1)} ns/op  ${change.id}\n`,
    );
  }
  if (unmatched.length > 0) {
    process.stdout.write(`  ${unmatched.length} new rows (no baseline): ${unmatched.join(', ')}\n`);
  }

  if (regressions.length > 0) {
    process.stderr.write(
      `\nbench:ci failed: ${regressions.length} rows regressed by more than 20%:\n`,
    );
    for (const change of regressions) {
      process.stderr.write(
        `  +${(change.delta * 100).toFixed(1)}% (allowed +${(change.threshold * 100).toFixed(0)}%)  ` +
          `${change.id} (${change.beforeNs.toFixed(1)} → ${change.afterNs.toFixed(1)} ns/op)\n`,
      );
    }
    process.exitCode = 1;
  } else {
    process.stdout.write('bench:ci passed.\n');
  }
}

main().catch((error) => {
  process.stderr.write(`bench:ci failed to run: ${error?.message ?? error}\n`);
  process.exitCode = 2;
});
