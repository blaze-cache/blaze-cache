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

type SnapshotRow = { key: string; ttlMs: number | null; tags: string[] };

/**
 * Reads at most `maxEntries` rows. `query()` exists on every `BlazeCache`, but throws when
 * the cache was created without `indexes: true` — method presence is *not* an index check.
 * Prefer the indexed read, then the explicit bounded full scan, then a plain `entries()`
 * slice for cache-like objects that implement no query at all.
 */
function readRows(
  cache: DevtoolsCacheLike,
  maxEntries: number,
): {
  rows: SnapshotRow[];
  totalEntries: number | undefined;
} {
  const fromEntries = () => {
    const all = cache.entries();
    return {
      rows: all.slice(0, maxEntries).map((entry) => ({
        key: entry.key,
        ttlMs: entry.ttlMs,
        tags: entry.tags,
      })),
      totalEntries: all.length,
    };
  };
  const fromPage = (page: { items: SnapshotRow[]; total?: number }) => ({
    rows: page.items.map((item) => ({ key: item.key, ttlMs: item.ttlMs, tags: item.tags })),
    totalEntries: page.total,
  });

  if (typeof cache.query !== 'function') return fromEntries();
  try {
    // `withTotal` would make the indexed query walk *every* match just to build a count
    // the snapshot cannot use: an unfiltered page has exactly `size()` rows in total.
    // A cache-like that reports its own total without being asked is still believed.
    const page = cache.query({ limit: maxEntries });
    return { ...fromPage(page), totalEntries: page.total ?? cache.size() };
  } catch {
    // `query()` is always defined; the setup error means indexes are off.
  }
  try {
    // Full scan is bounded by `limit` and runs only on this on-demand path. `size()`
    // supplies the total without asking the scan to materialise every match.
    const page = cache.query({ limit: maxEntries, fullScan: true });
    return { ...fromPage(page), totalEntries: cache.size() };
  } catch {
    return fromEntries();
  }
}

/**
 * Builds a versioned snapshot message. Uses the cache's bounded `query()` when available
 * (the 0.5.0 query track), so the devtools panel never builds a 100k-row array; caches
 * without indexes use a bounded full scan instead.
 */
export function buildSnapshot(
  cache: DevtoolsCacheLike,
  context: BuildSnapshotContext,
  options: SnapshotOptions = {},
): DevtoolsSnapshot {
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 100));
  const maxValueBytes = Math.max(1, Math.floor(options.maxValueBytes ?? 64 * 1024));
  const mode = options.valueMode ?? context.valueMode ?? 'summary';

  const { rows, totalEntries } = readRows(cache, maxEntries);

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
