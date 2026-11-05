import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Adapter interface for framework benchmark scenarios.
 * All adapters expose the same cache-store surface; scenario probes assert
 * equivalent observable behavior before timing.
 */
export class BaseAdapter {
  async create(_options) {
    throw new Error('create() must be implemented');
  }
  get(_key) {
    throw new Error('get() must be implemented');
  }
  set(_key, _value, _options = {}) {
    throw new Error('set() must be implemented');
  }
  delete(_key) {
    throw new Error('delete() must be implemented');
  }
  size() {
    throw new Error('size() must be implemented');
  }
  clear() {
    throw new Error('clear() must be implemented');
  }
  dispose() {}
}

/** Blaze Cache: @blaze-cache/core (WASM). */
export class BlazeAdapter extends BaseAdapter {
  #cache;
  async create({ capacity }) {
    const { createCache } = await import('@blaze-cache/core');
    const { readFile } = await import('node:fs/promises');
    const wasmPath = require.resolve('@blaze-cache/core/pkg/blaze_cache_wasm_bg.wasm');
    const wasmBytes = await readFile(wasmPath);
    this.#cache = await createCache({ wasm: wasmBytes, capacity });
    return this;
  }
  get(key) {
    return this.#cache.get(key);
  }
  set(key, value, options = {}) {
    this.#cache.set(key, value, options);
  }
  delete(key) {
    return this.#cache.delete(key);
  }
  size() {
    return this.#cache.size();
  }
  clear() {
    this.#cache.clear();
  }
}

/**
 * TanStack Query: real @tanstack/query-core QueryClient cache store.
 * Uses getQueryData/setQueryData/removeQueries; query keys are ['bench', key].
 * Costs include QueryClient key hashing/normalization and query-cache bookkeeping
 * (real for users of this API path).
 */
export class TanStackQueryAdapter extends BaseAdapter {
  #client;
  async create() {
    const { QueryClient } = await import('@tanstack/query-core');
    this.#client = new QueryClient({
      defaultOptions: {
        queries: {
          gcTime: Infinity,
          staleTime: Infinity,
          retry: false,
          refetchOnMount: false,
          refetchOnWindowFocus: false,
          refetchOnReconnect: false,
        },
      },
    });
    return this;
  }
  #qk(key) {
    return ['bench', key];
  }
  get(key) {
    return this.#client.getQueryData(this.#qk(key));
  }
  set(key, value) {
    this.#client.setQueryData(this.#qk(key), value);
  }
  delete(key) {
    const existed = this.#client.getQueryData(this.#qk(key)) !== undefined;
    this.#client.removeQueries({ queryKey: this.#qk(key), exact: true });
    return existed;
  }
  size() {
    return this.#client.getQueryCache().getAll().length;
  }
  clear() {
    this.#client.clear();
  }
  dispose() {
    this.#client?.clear();
  }
}

/**
 * SWR: real SWR cache store via initCache + Map provider.
 * Uses SWR's internal cache wrapper in Node to isolate cache-store cost (no
 * React render/hooks). Real SWR apps also pay key serialization/normalization;
 * this path uses direct string keys and a minimal cache entry shape.
 */
export class SWRAdapter extends BaseAdapter {
  #cache;
  async create() {
    const internal = await import('swr/_internal');
    const { initCache, defaultConfigOptions } = internal;
    const [cache] = initCache(new Map(), defaultConfigOptions);
    this.#cache = cache;
    return this;
  }
  get(key) {
    return this.#cache.get(key)?.data;
  }
  set(key, value) {
    this.#cache.set(key, { data: value, _k: key });
  }
  delete(key) {
    const existed = this.#cache.get(key) !== undefined;
    this.#cache.delete(key);
    return existed;
  }
  size() {
    return [...this.#cache.keys()].length;
  }
  clear() {
    for (const k of [...this.#cache.keys()]) this.#cache.delete(k);
  }
  dispose() {
    try {
      this.clear();
    } catch {}
  }
}

export const TanStackAdapter = TanStackQueryAdapter;