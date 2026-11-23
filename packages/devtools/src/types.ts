/** Shared public types for `@blaze-cache/devtools`. */
import type {
  CacheEntry,
  CacheEvent,
  CacheStats,
  PersistenceStats,
  QueryOptions,
  QueryResult,
} from '@blaze-cache/core';

import type { DevtoolsEnvelope } from './protocol.js';
import type { ValueSummary } from './summarizer.js';

/** How values are rendered in a snapshot. `full` is an explicit opt-in and still cloned. */
export type DevtoolsValueMode = 'summary' | 'none' | 'full';

/**
 * The structural surface devtools needs from a cache. `BlazeCache` satisfies it, and so can
 * a test double — no import from the wasm entry is needed at runtime.
 */
export interface DevtoolsCacheLike {
  on(listener: (event: CacheEvent) => void): () => void;
  stats(): CacheStats;
  size(): number;
  capacity(): number;
  keys(): string[];
  entry(key: string): CacheEntry | undefined;
  entries(): CacheEntry[];
  ttl(key: string): number | undefined;
  tagsOf(key: string): string[];
  /** Optional: present on caches created with persistence. */
  persistence?: { stats(): PersistenceStats };
  /** Optional: present on caches created with `indexes: true`. */
  query?(filter: QueryOptions): QueryResult;
  /** Optional: used for value summaries without recording hits. */
  peek?(key: string): unknown;
}

/** One event in the ring buffer. Never carries the live value. */
export interface DevtoolsEvent {
  type: string;
  key?: string;
  ts: number;
  tabId: string;
  clientId: string;
}

/** Options for {@link attach}. */
export interface AttachOptions {
  label?: string;
  /** Overrides the default-on redaction patterns from `@blaze-cache/core/shared`. */
  redactKeys?: readonly RegExp[];
  /** Default `summary`. `full` is an explicit opt-in and returns clones, never live refs. */
  valueMode?: DevtoolsValueMode;
  /** Ring-buffer size for this handle. Default `500`. */
  maxEvents?: number;
}

/** One summarized entry in a snapshot. */
export interface SnapshotEntry {
  key: string;
  ttlMs: number | null;
  tags: string[];
  value: ValueSummary;
}

/** Payload of a `snapshot` message. */
export interface DevtoolsSnapshotPayload {
  label?: string;
  stats: CacheStats;
  size: number;
  capacity: number;
  totalEntries: number | undefined;
  entries: SnapshotEntry[];
  truncated: { entries: boolean; bytes: boolean };
  persistence: PersistenceStats | null;
}

/** A complete, versioned snapshot message. */
export type DevtoolsSnapshot = DevtoolsEnvelope<DevtoolsSnapshotPayload>;

/** Options for an on-demand snapshot. */
export interface SnapshotOptions {
  /** Maximum rows. Default `100`. */
  maxEntries?: number;
  /** Maximum estimated summary bytes. Default `64 * 1024`. */
  maxValueBytes?: number;
  /** Overrides the handle's `valueMode` for this snapshot. */
  valueMode?: DevtoolsValueMode;
}

/** A live attachment. Detach exactly once; after that the handle is a no-op. */
export interface DevtoolsHandle {
  readonly cacheId: string;
  readonly clientId: string;
  readonly label: string | undefined;
  /** `true` until `detach()` / `dispose()`. */
  readonly active: boolean;
  /** The observed cache — a weak reference under the hood. */
  deref(): DevtoolsCacheLike | undefined;
  /** Builds a bounded snapshot on demand; never called on the hot path. */
  snapshot(options?: SnapshotOptions): DevtoolsSnapshot;
  /** Recent events, oldest first. */
  events(): readonly DevtoolsEvent[];
  /** Subscribes to new events on this handle. Returns an unsubscribe function. */
  onEvent(listener: (event: DevtoolsEvent) => void): () => void;
  /** Removes this handle's listener, restoring the cache's prior drop-log state. */
  detach(): void;
}
