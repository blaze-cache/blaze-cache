# Browser benchmark workspace

Runs the **same** ten scenarios, five payload sizes and two value representations as
[`../cache/`](../cache/README.md), but in a real browser — so the Wasm boundary crossing is
measured in the deployment target rather than in Node. Node suites remain the CI regression
gate; these numbers are published for trust in
[`docs/benchmarks/RESULTS.md`](../../docs/benchmarks/RESULTS.md).

## Run

From the repo root (the wasm and core must be built first):

```sh
pnpm bench:browser                       # full table, small/object
pnpm bench:browser -- --payload=large --payload-kind=bytes
pnpm bench:browser -- --matrix --out=benchmarks/results/browser-matrix-object.json
pnpm bench:browser -- --quick --json
```

`runner.mjs` starts a Vite dev server, launches headless Chrome through `playwright-core`, waits
for the page to expose the benchmark entry points, calls them with `page.evaluate`, and prints
the same table/JSON shape as the Node CLI. Set `BLAZE_CHROME_PATH` if Chrome lives somewhere
other than the platform default.

## Layout

| File | Role |
| --- | --- |
| `index.html`, `src/main.js` | the page; exposes the shared harness and the browser adapter registry |
| `vite.config.js` | serves `../cache/` shared modules and emits the wasm asset as an HTTP resource |
| `runner.mjs` | Vite + Playwright driver, CLI, table/JSON rendering |
| `test/modules.test.mjs` | asserts the shared modules contain no `node:` imports |

The adapters come from `../cache/adapters.browser.mjs`: identical store implementations to the
Node suite (`../cache/stores.mjs`), with blaze left to fetch its own `.wasm` asset through the
package's default `wasmUrl`. Browser clocks are coarser than Node's; calibration keeps the timed
batches well above the clock resolution, but read the spread column before quoting a gap.
