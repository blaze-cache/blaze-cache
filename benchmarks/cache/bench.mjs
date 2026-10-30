#!/usr/bin/env node
/**
 * `pnpm bench` — timings for @blaze-cache/core against quick-lru and the native Map.
 *
 * Progress goes to stderr so `--json` keeps stdout machine-readable:
 *
 *   pnpm bench                      # the full table
 *   pnpm bench -- --filter=get      # only scenarios whose id contains "get"
 *   pnpm bench -- --capacity=5000   # a smaller cache
 *   pnpm bench -- --quick           # ~10s smoke run
 *   pnpm bench -- --json            # results as JSON
 *
 * Read the numbers as *relative* ones. "vs best" compares adapters within a single
 * scenario; nothing here says anything about scenarios other than its own, and absolute
 * throughput moves with the machine, the Node build and how warm the JIT happens to be.
 */
import process from 'node:process';

import { DEFAULTS, runBenchmark } from './runner.mjs';
import { buildScenarios } from './scenarios.mjs';

const USAGE = `
Usage: node bench.mjs [options]

Options
  --capacity=N      entries each bounded cache may hold   (default ${DEFAULTS.capacity})
  --samples=N       batches recorded per adapter          (default ${DEFAULTS.samples})
  --target-ms=N     approximate length of one sample       (default ${DEFAULTS.targetMs})
  --filter=TEXT     only scenarios whose id contains TEXT
  --quick           fast smoke run (~10s)
  --list            print the scenario ids and exit
  --json            print results as JSON instead of a table
  --help            this message
`;

/** Options this CLI accepts — anything else is a typo that must not pass silently. */
const KNOWN_FLAGS = new Set(['help', 'list', 'quick', 'json']);
const KNOWN_OPTIONS = new Set(['capacity', 'samples', 'target-ms', 'filter']);

/**
 * Splits `--name=value` and bare `--flag` arguments.
 *
 * A bare `--` is the conventional end-of-options marker: `pnpm bench -- --quick` forwards
 * it verbatim, and it is dropped rather than recorded as an empty-named flag.
 *
 * @throws {Error} on a positional argument or an option nobody would want ignored — a
 *   misspelled `--capcity=500` that quietly fell back to the default would still produce a
 *   table, just not the one that was asked for.
 */
function parseArgs(argv) {
  const flags = new Set();
  const values = {};
  for (const raw of argv) {
    if (raw === '--') continue;
    if (!raw.startsWith('--')) throw new Error(`unexpected argument: ${raw}`);

    const body = raw.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) {
      if (!KNOWN_FLAGS.has(body)) {
        throw new Error(`unknown option --${body} (try --help)`);
      }
      flags.add(body);
      continue;
    }

    const name = body.slice(0, eq);
    if (!KNOWN_OPTIONS.has(name)) {
      throw new Error(`unknown option --${name}=… (try --help)`);
    }
    values[name] = body.slice(eq + 1);
  }
  return { flags, values };
}

/** Reads an integer option, rejecting anything that would silently produce nonsense. */
function integerOption(values, name, fallback) {
  const raw = values[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer (got "${raw}")`);
  }
  return parsed;
}

/** Left-aligns text, right-aligns numbers, so the columns scan. */
function renderTable(rows) {
  const headers = ['scenario', 'adapter', 'ops/sec', 'ns/op', 'spread', 'vs best'];
  const cells = rows.map((row) => [
    row.scenario,
    row.adapter,
    Math.round(row.opsPerSecond).toLocaleString('en-US'),
    row.nsPerOp.toFixed(1),
    `±${Math.round(row.spread)}%`,
    `${row.relative.toFixed(2)}x`,
  ]);

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...cells.map((cell) => cell[index].length)),
  );
  const format = (line) =>
    line
      .map((cell, index) =>
        index < 2 ? cell.padEnd(widths[index]) : cell.padStart(widths[index]),
      )
      .join('  ');

  return [
    format(headers),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...cells.map(format),
  ].join('\n');
}

function render(result) {
  const { environment, config, scenarios, rows } = result;
  const gcNote =
    typeof globalThis.gc === 'function'
      ? 'gc exposed'
      : 'gc not exposed — run via `pnpm bench` for cleaner samples';

  const lines = [
    'blaze-cache benchmark',
    `  ${environment.node} · ${environment.platform} · ${environment.cpu}`,
    `  capacity ${config.capacity.toLocaleString('en-US')} · ` +
      `${config.samples} samples × ~${config.targetMs}ms per adapter · ${gcNote}`,
    '',
    renderTable(rows),
    '',
    'Scenarios',
  ];

  for (const scenario of scenarios) {
    lines.push(`  ${scenario.id} — ${scenario.title}`);
    for (const note of scenario.notes) lines.push(`      ${note}`);
  }

  lines.push(
    '',
    '  "vs best" compares adapters within one scenario only — the workloads are',
    '  not comparable across rows. Read these as relative figures.',
    '',
    '  Caveats: Map is the unbounded baseline — no eviction policy, no TTL, no tags,',
    '           so in an eviction scenario it does strictly less work than the others.',
    '           QuickLRU deliberately holds between maxSize and 2 × maxSize.',
    '           Every adapter is called through the same one-call-deep wrapper.',
  );
  return lines.join('\n');
}

async function main() {
  const { flags, values } = parseArgs(process.argv.slice(2));

  if (flags.has('help')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (flags.has('list')) {
    const capacity = integerOption(values, 'capacity', DEFAULTS.capacity);
    for (const scenario of buildScenarios(capacity)) {
      process.stdout.write(`${scenario.id} — ${scenario.title}\n`);
    }
    return;
  }

  const quick = flags.has('quick');
  const options = {
    capacity: integerOption(values, 'capacity', DEFAULTS.capacity),
    samples: integerOption(values, 'samples', quick ? 3 : DEFAULTS.samples),
    targetMs: integerOption(values, 'target-ms', quick ? 25 : DEFAULTS.targetMs),
    warmupBatches: quick ? 1 : DEFAULTS.warmupBatches,
    filter: values.filter ?? null,
    onProgress: ({ scenario, adapter }) =>
      process.stderr.write(`  measuring ${scenario} / ${adapter}\n`),
  };

  const result = await runBenchmark(options);

  if (flags.has('json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${render(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`\nbenchmark failed: ${error?.message ?? error}\n`);
  process.exitCode = 1;
});
