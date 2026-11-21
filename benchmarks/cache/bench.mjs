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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as adapters from './adapters.mjs';
import { PAYLOAD_KINDS, PAYLOAD_SIZES } from './payloads.mjs';
import { DEFAULTS, runBenchmark, runPayloadMatrix } from './runner.mjs';
import { buildScenarios } from './scenarios.mjs';

const USAGE = `
Usage: node bench.mjs [options]

Options
  --capacity=N      entries each bounded cache may hold   (default ${DEFAULTS.capacity})
  --samples=N       batches recorded per adapter          (default ${DEFAULTS.samples})
  --target-ms=N     approximate length of one sample       (default ${DEFAULTS.targetMs})
  --payload=NAME    tiny | small | medium | large | massive (default small)
  --payload-kind=K  object | bytes                        (default object)
  --matrix          run all five payload sizes and merge the results
  --stage2          include the opt-in js-storage / bytes adapters in the matrix
  --filter=TEXT     only scenarios whose id contains TEXT
  --quick           fast smoke run
  --list            print the scenario ids and exit
  --json            print results as JSON instead of a table
  --out=FILE        also write the JSON result to FILE (implies --json)
  --help            this message
`;

/** Options this CLI accepts — anything else is a typo that must not pass silently. */
const KNOWN_FLAGS = new Set(['help', 'list', 'quick', 'json', 'matrix', 'stage2']);
const KNOWN_OPTIONS = new Set([
  'capacity',
  'samples',
  'target-ms',
  'payload',
  'payload-kind',
  'filter',
  'out',
]);

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
function renderTable(rows, showPayload = false) {
  const headers = showPayload
    ? ['payload', 'scenario', 'adapter', 'ops/sec', 'ns/op', 'spread', 'vs best']
    : ['scenario', 'adapter', 'ops/sec', 'ns/op', 'spread', 'vs best'];
  const cells = rows.map((row) => [
    ...(showPayload ? [`${row.payload}/${row.payloadKind}`] : []),
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
  const left = showPayload ? 3 : 2;
  const format = (line) =>
    line
      .map((cell, index) =>
        index < left ? cell.padEnd(widths[index]) : cell.padStart(widths[index]),
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
    `  ${environment.runtime} ${environment.version} · ${environment.platform} · ${environment.cpu}`,
    `  capacity ${config.capacity.toLocaleString('en-US')} · ` +
      `payload ${config.matrix ? 'matrix (5 sizes)' : `${config.payload}/${config.payloadKind}`} · ` +
      `${config.samples} samples × ~${config.targetMs}ms per adapter · ${gcNote}`,
    '',
    renderTable(rows, config.matrix === true),
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
  const payload = values.payload ?? 'small';
  const payloadKind = values['payload-kind'] ?? 'object';
  if (!Object.hasOwn(PAYLOAD_SIZES, payload)) {
    throw new Error(`unknown --payload "${payload}" (try --help)`);
  }
  if (!PAYLOAD_KINDS.includes(payloadKind)) {
    throw new Error(`unknown --payload-kind "${payloadKind}" (try --help)`);
  }

  const options = {
    capacity: integerOption(values, 'capacity', DEFAULTS.capacity),
    // A CI gate needs a stable median: 3 × 25 ms was enough for a smoke run but drifted by
    // >20% between two back-to-back runs on the same machine. Keep `--quick` short-ish while
    // giving each sample enough time to average out scheduler noise.
    samples: integerOption(values, 'samples', quick ? 5 : DEFAULTS.samples),
    targetMs: integerOption(values, 'target-ms', quick ? 60 : DEFAULTS.targetMs),
    warmupBatches: quick ? 2 : DEFAULTS.warmupBatches,
    payload,
    payloadKind,
    includeStage2: flags.has('stage2'),
    adapters,
    filter: values.filter ?? null,
    onProgress: ({ scenario, adapter, payload: cell }) =>
      process.stderr.write(`  measuring ${cell} / ${scenario} / ${adapter}\n`),
  };

  const result = flags.has('matrix') ? await runPayloadMatrix(options) : await runBenchmark(options);

  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (values.out) {
    const { mkdir, writeFile } = await import('node:fs/promises');
    // pnpm runs this script with the package dir as cwd. Resolve --out against the repo root
    // so `pnpm bench -- --out=benchmarks/results/x.json` lands where the caller expects.
    const file = resolve(dirname(fileURLToPath(import.meta.url)), '../..', values.out);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, json);
    process.stderr.write(`  wrote ${file}\n`);
  }
  if (flags.has('json') || values.out) {
    process.stdout.write(json);
    return;
  }
  process.stdout.write(`${render(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`\nbenchmark failed: ${error?.message ?? error}\n`);
  process.exitCode = 1;
});
