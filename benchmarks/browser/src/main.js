/**
 * Exposes the exact same benchmark entry points the Node CLI calls, but with the browser
 * adapter registry (no disk reads — blaze fetches its own wasm asset over HTTP). Playwright
 * drives `page.evaluate` against these globals; the page itself is deliberately dumb.
 */
import * as adapters from '../../cache/adapters.browser.mjs';
import { PAYLOAD_KINDS, PAYLOAD_SIZES } from '../../cache/payloads.mjs';
import {
  DEFAULTS,
  detectEnvironment,
  runBenchmark,
  runPayloadMatrix,
} from '../../cache/runner.mjs';

window.__BLAZE_BENCH__ = {
  adapters,
  DEFAULTS,
  PAYLOAD_KINDS,
  PAYLOAD_SIZES,
  detectEnvironment,
  runBenchmark,
  runPayloadMatrix,
};
window.__BLAZE_BENCH_READY__ = true;

document.getElementById('status').textContent =
  `ready — ${detectEnvironment().runtime}, ${Object.keys(PAYLOAD_SIZES).length} payload sizes`;
