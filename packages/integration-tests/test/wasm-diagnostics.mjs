/**
 * Wasm failure diagnostics shared by the offline and live integration suites.
 *
 * A wasm failure in Node is usually just `RuntimeError: unreachable` (a Rust panic with
 * `panic = "abort"`) with no useful context: which cache call trapped, which binary was
 * loaded, or whether the build is stale. Every cache is therefore created and accessed
 * through this module so a failure prints a structured report before it reaches the test
 * runner:
 *
 * * the stage that failed (`createCache`, `cache.set`, …) and the argument summary,
 * * the whole `cause` chain (wasm-bindgen and our own loader wrap errors),
 * * a fingerprint of the binary actually loaded (path, byte count, sha256 prefix), which
 *   makes a forgotten `pnpm build:wasm` obvious from the log alone.
 *
 * The helpers only log — they rethrow the original error so test assertions still see it.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { createCache } from '@blaze-cache/core';

/** The built artifact both suites load (`createCache({ wasm })` — Node cannot fetch `file:`). */
const BINARY = new URL('../../core/pkg/blaze_cache_wasm_bg.wasm', import.meta.url);

let bytesPromise = null;
let loadedBytes = null;

/** Reads the binary once, with a log and an actionable message if the build is missing. */
async function readBinary() {
  if (bytesPromise === null) {
    bytesPromise = readFile(BINARY)
      .then((bytes) => {
        loadedBytes = bytes;
        return bytes;
      })
      .catch((cause) => {
        bytesPromise = null; // a later test may retry after a rebuild
        logWasmFailure('read wasm binary', cause, { path: BINARY.href });
        throw new Error(
          `@blaze-cache/integration: cannot read the wasm binary at ${BINARY.href}. ` +
            'Run `pnpm build:wasm` before the integration tests.',
          { cause },
        );
      });
  }
  return bytesPromise;
}

/** Short, log-friendly summary of a value passed to a wasm-bound method. */
function summarize(value) {
  if (typeof value === 'string') {
    return value.length > 120 ? `${value.slice(0, 117)}…` : value;
  }
  if (value instanceof Uint8Array) return `Uint8Array(${value.length})`;
  if (typeof value === 'function') return 'function';
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value)?.slice(0, 200) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return value;
}

/** Renders an error and its `cause` chain, with a cycle guard. */
export function describeError(error) {
  const parts = [];
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current) && parts.length < 8) {
    seen.add(current);
    const name = current.name ?? 'Error';
    const message = current.message ?? String(current);
    parts.push(`${name}: ${message}`);
    current = current.cause;
  }
  return parts.join(' <- caused by ');
}

/** Prints one structured report. Never throws on a malformed error. */
export function logWasmFailure(stage, error, detail = {}) {
  const fingerprint = {
    binary: BINARY.href,
    bytes: loadedBytes?.length ?? null,
    sha256: loadedBytes
      ? createHash('sha256').update(loadedBytes).digest('hex').slice(0, 16)
      : null,
  };
  console.error(`[blaze-cache:integration] wasm failure during ${stage}: ${describeError(error)}`, {
    ...fingerprint,
    node: process.version,
    ...detail,
    stack: error?.stack,
  });
}

/**
 * Wraps a cache so any throw from a wasm-bound method is logged with the method name and
 * arguments, then rethrown unchanged.
 *
 * Methods are applied to the original target, so the cache's private fields still work;
 * non-function properties and `constructor` pass through untouched, keeping `instanceof`.
 */
export function instrumentCache(cache) {
  return new Proxy(cache, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || prop === 'constructor') return value;
      return (...args) => {
        try {
          return value.apply(target, args);
        } catch (error) {
          logWasmFailure(`cache.${String(prop)}`, error, {
            args: args.slice(0, 8).map(summarize),
          });
          throw error;
        }
      };
    },
  });
}

/** Cache factory used by both suites: real binary, detailed logs on any wasm failure. */
export async function createDiagnosticCache(options = {}) {
  const wasm = await readBinary();
  try {
    const cache = await createCache({ wasm, persistence: false, ...options });
    return instrumentCache(cache);
  } catch (error) {
    logWasmFailure('createCache', error, { options: summarize(options) });
    throw error;
  }
}
