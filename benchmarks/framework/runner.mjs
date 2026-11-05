#!/usr/bin/env node
import os from 'node:os';
import process from 'node:process';

import { runScenarios } from './scenarios.mjs';

const USAGE = `
Usage: node runner.mjs [options]

Options
  --capacity=N      cache entries filled before sample   (default 10000)
  --iterations=N    timed operations per sample          (default 50000)
  --samples=N       recorded samples per adapter         (default 7)
  --warmup=N        discarded warmup samples             (default 2)
  --value-bytes=N   approximate payload size per value   (default 256)
  --json            print machine-readable JSON
  --help            show this message

Notes
  - Run with --expose-gc for real GC between samples (package script does this).
  - invalidate-by-key requires --iterations <= --capacity (deletes distinct keys).
  - Cache-store microbenchmark only (Node); not full React hook/app render benchmark.
`;

function parseArgs(argv) {
  const flags = new Set();
  const values = {};
  for (const raw of argv) {
    if (raw === '--') continue;
    if (!raw.startsWith('--')) throw new Error(`unexpected argument: ${raw}`);
    const body = raw.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) flags.add(body);
    else values[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return { flags, values };
}

function intOpt(values, name, fallback, { min = 1 } = {}) {
  const raw = values[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer >= ${min}`);
  return n;
}

function fmtNs(ns) {
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(2)}ms`;
  if (ns >= 1000) return `${(ns / 1000).toFixed(1)}µs`;
  if (ns >= 100) return ns.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return ns.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

function renderTable(rows) {
  const headers = ['adapter', 'p50', 'p95', 'spread', 'vs best'];
  const cells = rows.map((r) => [
    r.label,
    fmtNs(r.p50 ?? r.nsPerOp),
    fmtNs(r.p95 ?? r.nsPerOp),
    `±${Math.round(r.spread)}%`,
    `${r.relative.toFixed(2)}x`,
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const fmt = (line) =>
    line
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])))
      .join('  ');
  return [fmt(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...cells.map(fmt)].join('\n');
}

function render(result) {
  const { config, scenarios, results } = result;
  const gcAvailable = typeof globalThis.gc === 'function';
  const gcNote = gcAvailable
    ? 'gc() called before each timed sample'
    : 'gc unavailable (run with --expose-gc)';
  const lines = [
    'blaze-cache framework benchmark (cache-store microbenchmark)',
    `  ${process.version} · ${process.platform} ${process.arch} · ${os.cpus()[0]?.model ?? 'unknown'}`,
    `  capacity ${config.capacity.toLocaleString('en-US')} · value ~${config.valueBytes}B distinct/entry · ${config.iterations.toLocaleString('en-US')} ops/sample · ${config.samples} samples + ${config.warmup} warmup · ${gcNote}`,
    '',
  ];

  for (const scenario of scenarios) {
    lines.push(`${scenario.id} — ${scenario.title}`);
    lines.push(`  op: ${scenario.opLabel}`);
    const rows = results.filter((r) => r.scenario === scenario.id);
    lines.push(renderTable(rows).replace(/^/gm, '  '));
    lines.push('');
  }

  lines.push('Notes');
  lines.push('  * Cache-store microbenchmarks in Node, not full React hook/app render/fetch benchmarks.');
  lines.push('  * p50/p95 are over recorded samples; warmup samples discarded; gc() runs before timing when available.');
  lines.push('  * Blaze uses @blaze-cache/core (WASM). TanStack Query uses real QueryClient (query-key hashing/bookkeeping included).');
  lines.push('  * SWR uses real initCache store in Node (real SWR apps also pay key serialization/hook behavior).');
  lines.push('  * Map/QuickLRU baselines live in benchmarks/cache; this suite focuses on framework cache stores.');
  lines.push('  * invalidate-by-key deletes distinct pre-filled keys (iterations <= capacity). "vs best" is per scenario.');
  return lines.join('\n');
}

async function main() {
  const { flags, values } = parseArgs(process.argv.slice(2));
  if (flags.has('help')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const options = {
    capacity: intOpt(values, 'capacity', 10000),
    iterations: intOpt(values, 'iterations', 50000),
    samples: intOpt(values, 'samples', 7),
    warmup: intOpt(values, 'warmup', 2, { min: 0 }),
    valueBytes: intOpt(values, 'value-bytes', 256, { min: 0 }),
  };

  const result = await runScenarios(options);
  if (flags.has('json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${render(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`\nbenchmark failed: ${error?.message ?? error}\n`);
  if (error?.stack) process.stderr.write(`\n${error.stack}\n`);
  process.exitCode = 1;
});
