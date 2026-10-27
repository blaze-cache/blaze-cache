/**
 * Blaze Cache — a WebAssembly client-side cache.
 *
 * The Rust core provides SIEVE eviction, per-entry TTLs and tag invalidation; this package
 * adds the browser glue: one-time wasm initialisation and optional IndexedDB persistence.
 *
 * @example
 * ```ts
 * import { createCache } from '@blaze-cache/core';
 *
 * const cache = await createCache({ capacity: 1000 });
 * cache.set('greeting', 'hello', { ttlMs: 30_000, tags: ['greeting'] });
 * ```
 *
 * @packageDocumentation
 */

export { BlazeCache, createCache, DEFAULT_CAPACITY, DEFAULT_FLUSH_DELAY_MS, DEFAULT_MAX_RECORDS } from './cache.js';
export type { BlazeCacheOptions, CachePersistenceOptions, IndexedDbPersistenceOptions } from './cache.js';

export { initBlazeWasm, wasmUrl } from './wasm.js';
export type { WasmInitInput } from './wasm.js';

export { indexedDbPersistence } from './persistence/indexeddb.js';
export type { CachePersistence, IndexedDbOptions, PersistedRecord } from './persistence/types.js';

export { safeStableStringify, stableStringify } from './utils.js';

export type {
  BlazeCacheLike,
  CacheChange,
  CacheEntry,
  CacheListener,
  CacheStats,
  SetManyEntry,
  SetOptions,
  TouchOptions,
} from './types.js';
