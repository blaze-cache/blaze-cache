import init, { setPanicHook, BlazeCache as WasmCache } from '../pkg/blaze_cache_wasm.js';

/** Whatever the generated `init()` accepts — passed through untouched. */
export type WasmInitInput = NonNullable<Parameters<typeof init>[0]>;

/**
 * URL of the `.wasm` binary, resolved relative to **this** module.
 *
 * Both Vite and webpack rewrite `new URL('…', import.meta.url)` into an emitted asset, so no
 * bundler-specific wasm plugin is required — only `type: module` output.
 */
export const wasmUrl: URL = new URL('../pkg/blaze_cache_wasm_bg.wasm', import.meta.url);

let pending: Promise<void> | null = null;

/**
 * Loads and instantiates the Blaze Cache wasm module exactly once.
 *
 * Safe to call from every package: the first call starts the download, later calls await the
 * same promise. A failed load resets it so callers may retry.
 *
 * @param input Override how the binary is fetched (CDN URL, pre-fetched `Response`, …).
 */
export function initBlazeWasm(input?: WasmInitInput): Promise<void> {
  if (pending) return pending;

  pending = (async () => {
    // wasm-bindgen accepts either a positional input or `{ module_or_path }`; the object
    // form is the current API (the positional one warns), so use it explicitly.
    await init({ module_or_path: input ?? wasmUrl });
    // Forward Rust panics to `console.error` so devtools shows something useful.
    setPanicHook();
  })();

  // Reset on failure so a transient network error is retryable. The original promise still
  // rejects for whoever is awaiting it.
  void pending.catch(() => {
    pending = null;
  });

  return pending;
}

export { WasmCache };
