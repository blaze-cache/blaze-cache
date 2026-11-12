import init, {
  setPanicHook,
  ensureScratch,
  BlazeCache as WasmCache,
} from '../pkg/blaze_cache_wasm.js';
import type { InitInput, InitOutput } from '../pkg/blaze_cache_wasm.js';

/** Whatever the generated `init()` accepts — passed through untouched. */
export type WasmInitInput = NonNullable<Parameters<typeof init>[0]>;

/**
 * Anything the generated `init()` can instantiate from: a URL to fetch, a `Request`, a
 * `Response`, raw bytes, or an already-compiled `WebAssembly.Module`.
 */
export type WasmSource = InitInput;

/**
 * URL of the `.wasm` binary, resolved relative to **this** module.
 *
 * Both Vite and webpack rewrite `new URL('…', import.meta.url)` into an emitted asset, so no
 * bundler-specific wasm plugin is required — only `type: module` output.
 */
export const wasmUrl: URL = new URL('../pkg/blaze_cache_wasm_bg.wasm', import.meta.url);

/** Every option that says *where* the `.wasm` comes from — at most one may be given. */
export interface WasmLoadOptions {
  /**
   * URL of the `.wasm` binary to fetch: absolute, or relative to the document.
   *
   * Defaults to the asset shipped inside `@blaze-cache/core`, resolved relative to this
   * module — which is what makes the zero-config path work under Vite, webpack and plain
   * static hosting alike. Override it when the binary lives somewhere else: a `public/`
   * asset path, a CDN, another origin.
   *
   * ```ts
   * await createCache({ wasmUrl: '/assets/blaze_cache_wasm_bg.wasm' });
   * ```
   */
  wasmUrl?: string | URL;
  /**
   * A precompiled `WebAssembly.Module` — no fetch and no compile at all, for callers that
   * already hold one (a service worker, a warm `WebAssembly.compileStream`, a test fixture).
   *
   * ```ts
   * const module = await WebAssembly.compile(await (await fetch(url)).arrayBuffer());
   * await createCache({ module });
   * ```
   */
  module?: WebAssembly.Module;
  /**
   * Full custom loader — the escape hatch for everything the defaults do not cover: a fetch
   * that needs auth headers or retries, an asset behind a signed CDN path, bytes already in
   * memory or in IndexedDB.
   *
   * Resolve to the **source** the loader should instantiate from — a URL, a `Request` or
   * `Response`, raw bytes, or a precompiled `WebAssembly.Module`. The loader still does the
   * linking, streaming instantiation and one-time registration.
   *
   * It deliberately does *not* receive the wasm-bindgen import object and must not resolve
   * to a `WebAssembly.Instance` or to an object's exports: the generated glue owns linking
   * and registration, and an instance created outside it can never be adopted afterwards —
   * `WebAssembly.instantiate` rejects an `Instance`, and the glue's finaliser is private.
   * Producing a *source* instead keeps the escape hatch honest, and covers the same ground:
   *
   * ```ts
   * const cache = await createCache({
   *   instantiate: async () => (await fetch(url, { headers: { authorization } })).arrayBuffer(),
   * });
   * ```
   */
  instantiate?: () => WasmSource | Promise<WasmSource>;
  /**
   * Low-level passthrough: a source handed straight to wasm-bindgen's generated `init()`,
   * bypassing the loader's own fetch. Equivalent to {@link WasmLoadOptions.wasmUrl} for a
   * URL, and the way to pass pre-read bytes (`Uint8Array`) — which is what the test suites
   * do, since Node cannot `fetch()` a `file:` URL.
   */
  wasm?: WasmInitInput;
}

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

/** The one in-flight {@link loadBlazeWasm}, shared by every concurrent `createCache()`. */
let loading: Promise<void> | null = null;

/** The four ways to say where the `.wasm` is, in the order they are reported and resolved. */
const SOURCE_KEYS = ['wasmUrl', 'module', 'instantiate', 'wasm'] as const;

/**
 * Loads and instantiates the Blaze Cache wasm module exactly once, from the source the
 * given options describe.
 *
 * This is what `createCache()` awaits. Concurrent callers share one load: the first call's
 * options decide where the binary comes from, every later call awaits that same promise
 * and never fetches, compiles or instantiates again — so N simultaneous `createCache()`
 * calls cost one download. A failure resets the promise, so the next call may retry.
 *
 * @param options Exactly one of `wasmUrl`, `module`, `instantiate` or `wasm`; with none of
 *   them the binary shipped next to this module is fetched.
 *
 * @throws TypeError if more than one source option is given — silently picking one would
 *   hide a real mistake.
 * @throws Error if the binary cannot be fetched or instantiated. The message names the URL
 *   (or the step that failed) and what to do about it; the original error is on `cause`.
 */
export function loadBlazeWasm(options: WasmLoadOptions = {}): Promise<void> {
  // Validate before any short-circuit: two sources is a programming error, and it should
  // surface whether or not the module happens to be loaded already.
  const requested = SOURCE_KEYS.filter((key) => options[key] !== undefined);
  if (requested.length > 1) {
    throw new TypeError(
      `@blaze-cache/core: pass at most one wasm source, got ${requested
        .map((key) => `\`${key}\``)
        .join(' and ')}. Use \`wasmUrl\` for an asset URL, \`module\` for a precompiled ` +
        'WebAssembly.Module, `instantiate` for a custom loader, or `wasm` to hand a ' +
        "source straight to wasm-bindgen's init().",
    );
  }

  // Already loading/loaded: nothing to resolve, whatever the later callers asked for.
  if (pending !== null) return pending;
  if (loading !== null) return loading;

  loading = (async () => {
    const source = await resolveWasmSource(options);
    try {
      await initBlazeWasm(await prepareWasmSource(source));
    } catch (cause) {
      throw new Error(
        `@blaze-cache/core: failed to instantiate the WebAssembly binary — ${describeCause(cause)}. ` +
          'Check that the asset is the Blaze Cache `.wasm` for this package version and that ' +
          'your server allows WebAssembly (a `Content-Type` of `application/wasm` lets the ' +
          'loader stream it; anything else still works, just slower).',
        { cause },
      );
    }
  })();

  // Reset on failure so a bad URL or a transient network error is retryable. The original
  // promise still rejects for whoever is awaiting it.
  void loading.catch(() => {
    loading = null;
  });

  return loading;
}

/** Picks the one requested source — or the default asset shipped with this module. */
async function resolveWasmSource(options: WasmLoadOptions): Promise<WasmInitInput> {
  if (options.wasmUrl !== undefined) return options.wasmUrl;
  if (options.module !== undefined) return options.module;
  if (options.instantiate !== undefined) return adoptWasmSource(await options.instantiate());
  if (options.wasm !== undefined) return options.wasm;
  return wasmUrl; // default: the binary that ships next to this module
}

/**
 * Fetches URL sources here rather than handing them to the glue, so a wrong path, a blocked
 * request and a corrupt binary each fail with their own message instead of one opaque
 * "failed to load wasm". Bytes, `Response`s and `Module`s pass through untouched — there is
 * nothing to fetch for those.
 */
async function prepareWasmSource(source: WasmInitInput): Promise<WasmInitInput> {
  if (typeof source === 'string') return await fetchWasmBinary(source);
  if (typeof URL !== 'undefined' && source instanceof URL) return await fetchWasmBinary(source);
  return source;
}

/** `fetch()` with the failure modes spelled out; resolves to a body that is known good. */
async function fetchWasmBinary(target: string | URL): Promise<Response> {
  const href = typeof target === 'string' ? target : target.href;
  const hint =
    'Pass `wasmUrl` for a public asset path or a CDN, `module` for a precompiled ' +
    'WebAssembly.Module, or `instantiate` for a fully custom loader.';

  let response: Response;
  try {
    response = await fetch(target);
  } catch (cause) {
    throw new Error(
      `@blaze-cache/core: could not fetch the WebAssembly binary from ${JSON.stringify(href)} — ` +
        `${describeCause(cause)}. ${hint}`,
      { cause },
    );
  }

  if (!response.ok) {
    throw new Error(
      `@blaze-cache/core: could not fetch the WebAssembly binary — HTTP ${response.status} ` +
        `${response.statusText} for ${JSON.stringify(response.url || href)}. ${hint}`,
    );
  }

  return response;
}

/**
 * Rejects the one shape the loader cannot honour, with the reason instead of a mystery deep
 * inside wasm-bindgen. See {@link WasmLoadOptions.instantiate} for why an instance or an
 * exports object cannot be adopted.
 */
function adoptWasmSource(source: WasmSource): WasmSource {
  if (isWasmSource(source)) return source;
  throw new Error(
    "@blaze-cache/core: `instantiate` must resolve to a *source* — a URL, a Request or " +
      'Response, raw bytes, or a precompiled WebAssembly.Module — not to a ' +
      'WebAssembly.Instance or to an object\'s exports. wasm-bindgen\'s generated glue owns ' +
      'the import object and has to create the instance itself, so an instance built ' +
      'elsewhere can never be wired up. Return the source instead, for example ' +
      '`(await fetch(url)).arrayBuffer()`.',
  );
}

/**
 * Narrows to {@link WasmSource} — everything `init()` can actually instantiate from. An
 * `Instance` or an exports object falls through and is rejected by {@link adoptWasmSource}.
 */
function isWasmSource(
  value: WasmSource | WebAssembly.Instance | WebAssembly.Exports,
): value is WasmSource {
  if (typeof value === 'string') return true;
  if (typeof URL !== 'undefined' && value instanceof URL) return true;
  if (typeof Request !== 'undefined' && value instanceof Request) return true;
  if (typeof Response !== 'undefined' && value instanceof Response) return true;
  if (value instanceof WebAssembly.Module) return true;
  if (value instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(value)) return true;
  return false;
}

/** One line out of an unknown thrown value, for the messages above. */
function describeCause(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  return cause.name === 'Error' ? cause.message : `${cause.name}: ${cause.message}`;
}

export { WasmCache };
