/**
 * Guards the CI performance gate itself. A gate that silently accepts a 25% regression is
 * worse than no gate: it looks like coverage. These run the real CLI over tiny fixture reports.
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../../scripts/compare-bench.mjs', import.meta.url));

function row(adapter, nsPerOp) {
  return {
    environment: { runtime: 'node' },
    payload: 'tiny',
    payloadKind: 'object',
    scenario: 'get-hit',
    adapter,
    nsPerOp,
  };
}

/** A fixed reference row plus the one under test: the ratio is what the gate compares. */
function report(nsPerOp) {
  return { rows: [row('Map', 100), row('blaze-cache', nsPerOp)] };
}

async function compare(current, baseline) {
  const dir = await mkdtemp(join(tmpdir(), 'blaze-bench-gate-'));
  const currentPath = join(dir, 'current.json');
  const baselinePath = join(dir, 'baseline.json');
  await writeFile(currentPath, JSON.stringify(report(current)));
  await writeFile(baselinePath, JSON.stringify(report(baseline)));
  return run(process.execPath, [SCRIPT, currentPath, baselinePath], {
    cwd: process.cwd(),
  });
}

describe('bench:ci regression gate', () => {
  it('passes when a row is unchanged', async () => {
    const { stdout } = await compare(100, 100);
    assert.match(stdout, /bench:ci passed/);
  });

  it('passes on a small regression inside the threshold', async () => {
    const { stdout } = await compare(110, 100);
    assert.match(stdout, /bench:ci passed/);
  });

  it('fails on a regression over 20%', async () => {
    await assert.rejects(
      () => compare(200, 100),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /regressed by more than 20%/);
        return true;
      },
    );
  });
});
