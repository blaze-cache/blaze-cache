/** On-demand, bounded snapshot builder. Never runs on the cache's hot path. */
import { isRedactedKey, redactKey } from '@blaze-cache/core/shared';

import { createEnvelope } from './protocol.js';
import { summarize } from './summarizer.js';
import type {
  DevtoolsCacheLike,
  DevtoolsSnapshot,
  DevtoolsValueMode,
  SnapshotEntry,
  SnapshotOptions,
} from './types.js';

export interface BuildSnapshotContext {
  cacheId: string;
  clientId: string;
  label?: string;
  redactKeys?: readonly RegExp[];
  valueMode?: DevtoolsValueMode;
  tabId?: string;
}

/** Approximate serialized size of a summary, used only for the payload byte cap. */
function summaryBytes(summary: unknown): number {
  try {
    return JSON.stringify(summary)?.length ?? 0;
  } catch {
    return 64;
  }
}

/**
 * Builds a versioned snapshot message. Uses the cache's bounded `query()` when available
 * (the 0.5.0 query track), so the devtools panel never builds a 100k-row array; a cache
 * without indexes falls back to a bounded `entries()` slice.
 */
export function buildSnapshot(
  cache: DevtoolsCacheLike,
  context: BuildSnapshotContext,
  options: SnapshotOptions = {},
): DevtoolsSnapshot {
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 100));
  const maxValueBytes = Math.max(1, Math.floor(options.maxValueBytes ?? 64 * 1024));
  const mode = options.valueMode ?? context.valueMode ?? 'summary';

  let rows: Array<{ key: string; ttlMs: number | null; tags: string[] }>;
  let totalEntries: number | undefined;
  if (typeof cache.query === 'function') {
    const page = cache.query({ limit: maxEntries, withTotal: true });
    rows = page.items.map((item) => ({
      key: item.key,
      ttlMs: item.ttlMs,
      tags: item.tags,
    }));
    totalEntries = page.total;
  } else {
    const all = cache.entries();
    rows = all.slice(0, maxEntries).map((entry) => ({
      key: entry.key,
      ttlMs: entry.ttlMs,
      tags: entry.tags,
    }));
    totalEntries = all.length;
  }

  const entries: SnapshotEntry[] = [];
  let bytes = 0;
  let truncatedBytes = false;
  for (const row of rows) {
    const sensitive = isRedactedKey(row.key, context.redactKeys);
    let value;
    if (sensitive) {
      value = { kind: 'redacted' as const };
    } else {
      let raw: unknown;
      try {
        raw = typeof cache.peek === 'function' ? cache.peek(row.key) : cache.entry(row.key)?.value;
      } catch {
        raw = undefined;
      }
      value = summarize(raw, { valueMode: mode });
    }
    const cost = summaryBytes(value);
    if (bytes + cost > maxValueBytes) {
      truncatedBytes = true;
      break;
    }
    bytes += cost;
    entries.push({
      key: redactKey(row.key, context.redactKeys),
      ttlMs: row.ttlMs,
      tags: sensitive ? [] : row.tags,
      value,
    });
  }

  let persistence = null;
  try {
    persistence = cache.persistence?.stats() ?? null;
  } catch {
    // A broken adapter must not take the snapshot down with it.
  }

  return createEnvelope(
    context.clientId,
    context.cacheId,
    'snapshot',
    {
      ...(context.label === undefined ? {} : { label: context.label }),
      stats: cache.stats(),
      size: cache.size(),
      capacity: cache.capacity(),
      totalEntries,
      entries,
      truncated: {
        entries: totalEntries !== undefined && totalEntries > entries.length,
        bytes: truncatedBytes,
      },
      persistence,
    },
    context.tabId,
  );
}
