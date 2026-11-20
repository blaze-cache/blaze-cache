#!/usr/bin/env node
/**
 * Runs the shared cache benchmark *inside a real browser*.
 *
 * Vite serves the page (and blaze's wasm asset over HTTP), Playwright drives Chrome, and the
 * page calls the very same `runBenchmark`/`runPayloadMatrix` functions the Node CLI uses. The
 * numbers therefore cross the Wasm boundary in the deployment target instead of in Node.
 *
 * Node suites stay the CI regression gate; these browser numbers are published for trust.
 *
 *   pnpm bench:browser -- --quick --payload=tiny
 *   pnpm bench:browser -- --matrix --json --out=results/browser.json
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

const USAGE = `
Usage: node runner.mjs [options]

Options
  --capacity=N      entries each bounded cache may hold   (default 10000)
  --samples=N       recorded samples per adapter           (default 7)
  --target-ms=N     approximate length of one sample        (default 120)
  --payload=NAME    tiny | small | medium | large | massive (default small)
  --payload-kind=K  object | bytes                         (default object)
  --matrix          run all five payload sizes and merge the results
  --filter=TEXT     only scenarios whose id contains TEXT
  --quick           fast smoke run
  --out=FILE        also write the JSON result to FILE
  --json            print results as JSON instead of a table
  --help            this message

Requires the built wasm + core (pnpm build:wasm && pnpm --filter @blaze-cache/core build) and
a locally installed Google Chrome (or BLAZE_CHROME_PATH pointing at another Chromium binary).
`;

const FLAGS = new Set(['help', 'matrix', 'quick', 'json']);
const OPTIONS = new Set([
  'capacity',
  'samples',
  'target-ms',
  'payload',
  'payload-kind',
  'filter',
  'out',
]);

function parseArgs(argv) {
  const flags = new Set();
  const values = {};
  for (const raw of argv) {
    if (raw === '--') continue;
    if (!raw.startsWith('--')) throw new Error(`unexpected argument: ${raw}`);
    const body = raw.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) {
      if (!FLAGS.has(body)) throw new Error(`unknown option --${body} (try --help)`);
      flags.add(body);
    } else {
      const name = body.slice(0, eq);
      if (!OPTIONS.has(name)) throw new Error(`unknown option --${name}=… (try --help)`);
      values[name] = body.slice(eq + 1);
    }
  }
  return { flags, values };
}

function intOpt(values, name, fallback) {
  const raw = values[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
  return n;
}

function fmtNs(ns) {
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(2)}ms`;
  if (ns >= 1000) return `${(ns / 1000).toFixed(1)}µs`;
  return ns.toFixed(1);
}

function renderTable(rows, showPayload) {
  const headers = showPayload
    ? ['payload', 'scenario', 'adapter', 'ops/sec', 'ns/op', 'spread', 'vs best']
    : ['scenario', 'adapter', 'ops/sec', 'ns/op', 'spread', 'vs best'];
  const cells = rows.map((row) => [
    ...(showPayload ? [`${row.payload}/${row.payloadKind}`] : []),
    row.scenario,
    row.adapter,
    Math.round(row.opsPerSecond).toLocaleString('en-US'),
    fmtNs(row.nsPerOp),
    `±${Math.round(row.spread)}%`,
    `${row.relative.toFixed(2)}x`,
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const left = showPayload ? 3 : 2;
  const line = (row) =>
    row
      .map((cell, i) => (i < left ? cell.padEnd(widths[i]) : cell.padStart(widths[i])))
      .join('  ');
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...cells.map(line)].join('\n');
}

function render(result) {
  const { environment, config, scenarios, rows } = result;
  const lines = [
    'blaze-cache browser benchmark',
    `  ${environment.runtime} ${environment.version} · ${environment.platform}`,
    `  browser ${environment.browser ?? 'unknown'} · ` +
      `capacity ${config.capacity.toLocaleString('en-US')} · ` +
      `payload ${config.matrix ? 'matrix (5 sizes)' : `${config.payload}/${config.payloadKind}`} · ` +
      `${config.samples} samples × ~${config.targetMs}ms per adapter`,
    '',
    renderTable(rows, config.matrix === true),
    '',
    'Scenarios',
  ];
  for (const scenario of scenarios) lines.push(`  ${scenario.id} — ${scenario.title}`);
  lines.push(
    '',
    '  "vs best" compares adapters within one scenario only — the workloads are',
    '  not comparable across rows. Read these as relative figures.',
    '  Browser clocks are coarser than Node’s; batched calibration keeps that below',
    '  the measured span, but believe gaps smaller than the spread column as nothing.',
  );
  return lines.join('\n');
}

async function launchBrowser() {
  const executablePath = process.env.BLAZE_CHROME_PATH;
  try {
    return await chromium.launch({
      ...(executablePath ? { executablePath } : { channel: 'chrome' }),
      headless: true,
    });
  } catch (error) {
    throw new Error(
      `could not launch Chrome (${error.message}). Install Google Chrome or set BLAZE_CHROME_PATH.`,
    );
  }
}

async function main() {
  const { flags, values } = parseArgs(process.argv.slice(2));
  if (flags.has('help')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  if (!existsSync(resolve(REPO, 'packages/core/pkg/blaze_cache_wasm_bg.wasm'))) {
    throw new Error('wasm binary missing — run `pnpm build:wasm` first');
  }
  if (!existsSync(resolve(REPO, 'packages/core/dist/index.js'))) {
    throw new Error('core dist missing — run `pnpm --filter @blaze-cache/core build` first');
  }

  const quick = flags.has('quick');
  const options = {
    capacity: intOpt(values, 'capacity', 10_000),
    samples: intOpt(values, 'samples', quick ? 5 : 7),
    targetMs: intOpt(values, 'target-ms', quick ? 60 : 120),
    warmupBatches: quick ? 2 : 3,
    payload: values.payload ?? 'small',
    payloadKind: values['payload-kind'] ?? 'object',
    filter: values.filter ?? null,
    matrix: flags.has('matrix'),
  };

  const server = await createServer({ root: HERE, logLevel: 'warn' });
  await server.listen();
  const address = server.httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 5173;

  const browser = await launchBrowser();
  let result;
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => process.stderr.write(`  page error: ${error.message}\n`));
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__BLAZE_BENCH_READY__ === true, { timeout: 30_000 });

    result = await page.evaluate(async (opts) => {
      const bench = window.__BLAZE_BENCH__;
      const run = opts.matrix ? bench.runPayloadMatrix : bench.runBenchmark;
      const output = await run({
        capacity: opts.capacity,
        samples: opts.samples,
        targetMs: opts.targetMs,
        warmupBatches: opts.warmupBatches,
        payload: opts.payload,
        payloadKind: opts.payloadKind,
        filter: opts.filter,
        adapters: bench.adapters,
      });
      output.environment.browser = navigator.userAgent.match(/(Chrome|Chromium)\/[\d.]+/)?.[0] ?? null;
      return output;
    }, options);
  } finally {
    await browser.close();
    await server.close();
  }

  if (values.out) {
    const file = resolve(REPO, values.out);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`  wrote ${file}\n`);
  }
  if (flags.has('json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${render(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`\nbrowser benchmark failed: ${error?.message ?? error}\n`);
  if (error?.stack) process.stderr.write(`\n${error.stack}\n`);
  process.exitCode = 1;
});
