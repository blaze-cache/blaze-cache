import init, {
  setPanicHook,
  ensureScratch,
  BlazeCache as WasmCache,
} from '../pkg/blaze_cache_wasm.js';
import type { InitOutput } from '../pkg/blaze_cache_wasm.js';

/** Whatever the generated `init()` accepts — passed through untouched. */
export type WasmInitInput = NonNullable<Parameters<typeof init>[0]>;

/**
 * URL of the `.wasm` binary, resolved relative to **this** module.
 *
 * Both Vite and webpack rewrite `new URL('…', import.meta.url)` into an emitted asset, so no
 * bundler-specific wasm plugin is required — only `type: module` output.
 */
export const wasmUrl: URL = new URL('../pkg/blaze_cache_wasm_bg.wasm', import.meta.url);

/** Smallest scratch reservation — covers ordinary keys (`user:42`, `key:12345`) outright. */
const SCRATCH_MIN = 64;

const textEncoder = new TextEncoder();

/**
 * Encodes JS keys straight into wasm memory for the `*Raw` bindings.
 *
 * `passStringToWasm0` — the normal string path — pays a wasm-side malloc, a byte copy and a
 * free on *every* call (~13 ns in the framework benchmark). This buffer replaces that with:
 *
 * * **one encode per distinct key** — a repeated key (the hot case in a read loop) is served
 *   from {@link KeyScratch.#last} with no write at all, just an offset;
 * * **no wasm-side allocation** — bytes land in a region Rust handed us via `ensureScratch`.
 *
 * The buffer and this encoder are module-level singletons: the Rust scratch is one
 * `thread_local` per wasm instance, so a second encoder would let one cache's "last key"
 * vouch for bytes another cache has since overwritten.
 *
 * Not usable until {@link KeyScratch.setup} has run — and only when the instantiated module
 * actually exports the `*Raw` methods (a caller may pass its own `.wasm` bytes).
 */
class KeyScratch {
  /** Byte offset of the encoded key inside wasm memory. */
  ptr = 0;
  /** Byte length of the encoded key at {@link KeyScratch.ptr}. */
  len = 0;
  /** `true` once the module behind this scratch is known to speak the raw protocol. */
  enabled = false;

  #memory: WebAssembly.Memory | null = null;
  #view: Uint8Array | null = null;
  #base = 0;
  #cap = 0;
  #last: string | null = null;

  /**
   * Binds the scratch to a freshly instantiated module, probing for everything the raw
   * path needs. Leaves {@link KeyScratch.enabled} `false` — and callers on the ordinary
   * string path — when any piece is missing, so a stale or foreign `.wasm` binary degrades
   * instead of throwing.
   */
  setup(exports: InitOutput): void {
    const memory = exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) return;
    if (
      typeof exports.blazecache_getRaw !== 'function' ||
      typeof exports.blazecache_setRaw !== 'function' ||
      typeof exports.blazecache_deleteRaw !== 'function' ||
      typeof exports.ensureScratch !== 'function'
    ) {
      return;
    }
    try {
      this.#base = ensureScratch(SCRATCH_MIN);
      this.#cap = SCRATCH_MIN;
    } catch {
      return; // glue/binary version skew: the wrapper exists but the export does not
    }
    this.#memory = memory;
    this.enabled = true;
  }

  /**
   * Makes {@link KeyScratch.ptr}/{@link KeyScratch.len} describe `key`.
   *
   * ASCII keys take a `charCodeAt` write loop; anything else goes through `encodeInto`
   * (worst case 3 bytes per UTF-16 unit, which is what the scratch is grown to). The wasm
   * `memory.grow` that any intervening write may have triggered only detaches the view —
   * the scratch *offset* never moves — so a refresh is a view rebuild, not a re-encode.
   */
  encode(key: string): void {
    if (key === this.#last) return; // bytes are still in place: no write, no view touch

    const n = key.length;
    if (n * 3 > this.#cap) this.#grow(n * 3); // worst case 3 bytes per UTF-16 unit

    let view = this.#view;
    const memory = this.#memory!;
    if (view === null || view.buffer !== memory.buffer) {
      view = new Uint8Array(memory.buffer); // absolute offsets: indices match wasm pointers
      this.#view = view;
    }

    // One pass — scan and write together, exactly like the generated `passStringToWasm0`
    // (a separate pre-scan doubled the per-char cost of a distinct key).
    const base = this.#base;
    let j = 0;
    for (; j < n; j += 1) {
      const code = key.charCodeAt(j);
      if (code > 0x7f) break;
      view[base + j] = code;
    }
    this.len =
      j === n ? n : textEncoder.encodeInto(key, view.subarray(base, base + n * 3)).written;
    this.ptr = base;
    this.#last = key;
  }

  #grow(need: number): void {
    const want = need < SCRATCH_MIN ? SCRATCH_MIN : need;
    this.#base = ensureScratch(want);
    this.#cap = want;
    this.#view = null; // the old view addressed the pre-growth buffer
  }
}

/** The one key scratch shared by every {@link WasmCache} instance (see {@link KeyScratch}). */
export const keyScratch = new KeyScratch();

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
    // form is the current API (the positional one warns), so use it explicitly. The
    // resolved value is the module's exports — needed for the raw-key scratch.
    const exports = await init({ module_or_path: input ?? wasmUrl });
    keyScratch.setup(exports);
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
