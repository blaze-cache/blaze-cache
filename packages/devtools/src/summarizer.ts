/**
 * Safe value summarizer. Devtools must never hand a cache's live by-reference value to a
 * UI, and must never let a hostile or non-cloneable value throw into the host app.
 *
 * `structuredClone` is attempted first (in a try/catch) so getters on the live object are
 * not read by the traversal; when cloning fails — functions, proxies, externrefs, cyclic
 * non-cloneables — the original is described defensively instead.
 */
import { bindingFromKind, isBlazeRecord } from '@blaze-cache/core/shared';

import type { DevtoolsValueMode } from './types.js';

export type SummaryTruncation = 'depth' | 'entries' | 'bytes' | 'string' | 'keys';

export type ValueSummary =
  | {
      kind:
        | 'undefined'
        | 'null'
        | 'boolean'
        | 'number'
        | 'string'
        | 'bigint'
        | 'symbol'
        | 'function'
        | 'unsupported';
      value?: string;
    }
  | { kind: 'full'; value: unknown }
  | { kind: 'redacted' }
  | { kind: 'cycle'; ref: number }
  | { kind: 'truncated'; reason: SummaryTruncation }
  | { kind: 'date'; iso: string }
  | { kind: 'error'; name: string; message: string }
  | { kind: 'array'; length: number; items: ValueSummary[]; truncated?: SummaryTruncation }
  | {
      kind: 'object';
      name: string;
      entries: Array<[string, ValueSummary]>;
      truncated?: SummaryTruncation;
    }
  | {
      kind: 'map';
      size: number;
      entries: Array<[ValueSummary, ValueSummary]>;
      truncated?: SummaryTruncation;
    }
  | { kind: 'set'; size: number; items: ValueSummary[]; truncated?: SummaryTruncation }
  | { kind: 'arraybuffer'; byteLength: number }
  | { kind: 'view'; name: string; byteLength: number; preview?: number[] }
  | {
      kind: 'blaze-record';
      /** `<binding>:<feature>` kind — never expand `data`. */
      recordKind: string;
      v: number;
      storedAt: number;
      framework?: string;
    };

export interface SummarizeOptions {
  /** `summary` (default) builds a bounded tree; `none` hides values; `full` returns a clone. */
  valueMode?: DevtoolsValueMode;
  maxDepth?: number;
  maxEntries?: number;
  maxStringLength?: number;
  maxBytes?: number;
  /** Preview bytes for typed arrays. Default `0` (no preview). */
  previewBytes?: number;
}

interface Budget {
  bytes: number;
  readonly max: number;
}

function spend(budget: Budget, amount: number): boolean {
  budget.bytes += amount;
  return budget.bytes <= budget.max;
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '[unprintable]';
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Clone when possible; fall back to the original rather than throwing. */
function cloneOrOriginal<T>(value: T): T {
  try {
    return typeof structuredClone === 'function' ? structuredClone(value) : value;
  } catch {
    return value;
  }
}

function describe(
  value: unknown,
  depth: number,
  seen: Map<object, number>,
  budget: Budget,
  options: Required<Omit<SummarizeOptions, 'valueMode'>>,
): ValueSummary {
  if (depth >= options.maxDepth) return { kind: 'truncated', reason: 'depth' };
  if (!spend(budget, 16)) return { kind: 'truncated', reason: 'bytes' };

  if (value === undefined) return { kind: 'undefined' };
  if (value === null) return { kind: 'null' };

  const type = typeof value;
  switch (type) {
    case 'boolean':
    case 'number':
      return { kind: type, value: safeString(value) };
    case 'bigint':
      return { kind: 'bigint', value: truncate(safeString(value), options.maxStringLength) };
    case 'string':
      return { kind: 'string', value: truncate(value as string, options.maxStringLength) };
    case 'symbol':
      return { kind: 'symbol', value: truncate(safeString(value), options.maxStringLength) };
    case 'function':
      return {
        kind: 'function',
        value: truncate((value as Function).name || 'anonymous', options.maxStringLength),
      };
    default:
      break;
  }

  const object = value as object;

  // Frozen envelope convention: show the kind/version, never expand `data`.
  if (isBlazeRecord(value)) {
    const record = value as { kind: string; v: number; storedAt: number };
    return {
      kind: 'blaze-record',
      recordKind: truncate(record.kind, options.maxStringLength),
      v: record.v,
      storedAt: record.storedAt,
      framework: bindingFromKind(record.kind),
    };
  }

  if (seen.has(object)) return { kind: 'cycle', ref: seen.get(object)! };
  seen.set(object, seen.size);

  if (object instanceof Date) {
    return { kind: 'date', iso: Number.isNaN(object.getTime()) ? 'invalid' : object.toISOString() };
  }
  if (object instanceof Error) {
    return {
      kind: 'error',
      name: object.name,
      message: truncate(object.message, options.maxStringLength),
    };
  }
  if (object instanceof ArrayBuffer) {
    return { kind: 'arraybuffer', byteLength: object.byteLength };
  }
  if (ArrayBuffer.isView(object)) {
    const view = object as ArrayBufferView;
    let preview: number[] | undefined;
    if (options.previewBytes > 0 && view instanceof Uint8Array) {
      preview = Array.from(view.subarray(0, options.previewBytes));
    }
    return {
      kind: 'view',
      name: view.constructor?.name ?? 'ArrayBufferView',
      byteLength: view.byteLength,
      ...(preview ? { preview } : {}),
    };
  }

  if (Array.isArray(object)) {
    const items: ValueSummary[] = [];
    const visible = Math.min(object.length, options.maxEntries);
    for (let i = 0; i < visible; i += 1) {
      let item: unknown;
      try {
        item = object[i];
      } catch {
        items.push({ kind: 'unsupported' });
        continue;
      }
      items.push(describe(item, depth + 1, seen, budget, options));
    }
    return {
      kind: 'array',
      length: object.length,
      items,
      ...(object.length > visible ? { truncated: 'entries' as const } : {}),
    };
  }

  if (object instanceof Map) {
    const entries: Array<[ValueSummary, ValueSummary]> = [];
    const visible = Math.min(object.size, options.maxEntries);
    let index = 0;
    try {
      for (const [key, entryValue] of object) {
        if (index >= visible) break;
        entries.push([
          describe(key, depth + 1, seen, budget, options),
          describe(entryValue, depth + 1, seen, budget, options),
        ]);
        index += 1;
      }
    } catch {
      entries.push([{ kind: 'unsupported' }, { kind: 'unsupported' }]);
    }
    return {
      kind: 'map',
      size: object.size,
      entries,
      ...(object.size > visible ? { truncated: 'entries' as const } : {}),
    };
  }

  if (object instanceof Set) {
    const items: ValueSummary[] = [];
    const visible = Math.min(object.size, options.maxEntries);
    let index = 0;
    try {
      for (const item of object) {
        if (index >= visible) break;
        items.push(describe(item, depth + 1, seen, budget, options));
        index += 1;
      }
    } catch {
      items.push({ kind: 'unsupported' });
    }
    return {
      kind: 'set',
      size: object.size,
      items,
      ...(object.size > visible ? { truncated: 'entries' as const } : {}),
    };
  }

  // Plain object / externref. Externrefs clone-fail and typically expose no own keys, which
  // is reported as an opaque object rather than guessed at.
  let keys: string[];
  try {
    keys = Object.keys(object);
  } catch {
    return { kind: 'unsupported', value: safeConstructorName(object) };
  }
  const entries: Array<[string, ValueSummary]> = [];
  const visible = Math.min(keys.length, options.maxEntries);
  for (let i = 0; i < visible; i += 1) {
    const key = keys[i]!;
    let property: unknown;
    try {
      property = (object as Record<string, unknown>)[key];
    } catch {
      entries.push([key, { kind: 'unsupported' }]);
      continue;
    }
    entries.push([
      truncate(key, options.maxStringLength),
      describe(property, depth + 1, seen, budget, options),
    ]);
  }
  return {
    kind: 'object',
    name: safeConstructorName(object),
    entries,
    ...(keys.length > visible ? { truncated: 'entries' as const } : {}),
  };
}

function safeConstructorName(value: object): string {
  try {
    return value.constructor?.name ?? 'Object';
  } catch {
    return 'Object';
  }
}

/**
 * Summarizes `value` without ever throwing into the host app. In `none` mode values are
 * replaced by a `{ kind: 'redacted' }` marker; in `full` mode a clone is returned (and a
 * failed clone degrades to a description), never the live reference itself.
 */
export function summarize(value: unknown, options: SummarizeOptions = {}): ValueSummary {
  const mode = options.valueMode ?? 'summary';
  if (mode === 'none') return { kind: 'redacted' };
  if (mode === 'full') {
    const cloned = cloneOrOriginal(value);
    if (cloned !== value) return { kind: 'full', value: cloned };
    // A non-cloneable value cannot be shown in full without risking the live reference.
    return describe(value, 0, new Map(), makeBudget(options), normalized(options));
  }
  const prepared = cloneOrOriginal(value);
  try {
    return describe(prepared, 0, new Map(), makeBudget(options), normalized(options));
  } catch {
    return { kind: 'unsupported' };
  }
}

function makeBudget(options: SummarizeOptions): Budget {
  return { bytes: 0, max: options.maxBytes ?? 16_384 };
}

function normalized(options: SummarizeOptions): Required<Omit<SummarizeOptions, 'valueMode'>> {
  return {
    maxDepth: options.maxDepth ?? 4,
    maxEntries: options.maxEntries ?? 32,
    maxStringLength: options.maxStringLength ?? 200,
    maxBytes: options.maxBytes ?? 16_384,
    previewBytes: options.previewBytes ?? 0,
  };
}
