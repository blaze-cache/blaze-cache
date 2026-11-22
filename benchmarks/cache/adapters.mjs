/**
 * Node-side adapter registry. The stores themselves live in {@link ./stores.mjs} so the browser
 * workspace can import the very same code; this file only supplies the one thing a browser
 * cannot do — read the `.wasm` binary from disk.
 *
 * Node cannot `fetch()` a `file:` URL (which is the browser-only default baked into
 * `wasmUrl`), so the bytes are resolved through the package's own `./pkg/*` export and handed
 * to `createCache` explicitly, exactly as the core smoke tests do. The promise is memoised:
 * one read per process, not one per adapter instance.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { buildRegistry } from './stores.mjs';

const require = createRequire(import.meta.url);

let wasmBytesPromise = null;
function wasmBytes() {
  wasmBytesPromise ??= readFile(require.resolve('@blaze-cache/core/pkg/blaze_cache_wasm_bg.wasm'));
  return wasmBytesPromise;
}

const registry = buildRegistry({ wasmProvider: wasmBytes });

export const ADAPTERS = registry.ADAPTERS;
export const createAdapter = registry.createAdapter;
export const adapterLabel = registry.adapterLabel;
