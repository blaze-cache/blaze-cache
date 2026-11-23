/**
 * `@blaze-cache/devtools` — zero-cost-by-default observability for Blaze Cache.
 *
 * Nothing happens until you call {@link attach}: no listeners, no timers, no snapshots.
 * Attaching registers one wildcard listener; detaching hands back the exact unsubscribe
 * function, so the core's opt-in drop log switches off again.
 *
 * @packageDocumentation
 */
export { attach, detach, dispose, list, onEvent } from './registry.js';
export {
  createEnvelope,
  isDevtoolsEnvelope,
  isSupportedEnvelope,
  makeId,
  DEVTOOLS_PROTOCOL,
  TAB_ID,
} from './protocol.js';
export type { DevtoolsEnvelope, DevtoolsKind } from './protocol.js';
export { summarize } from './summarizer.js';
export type { SummarizeOptions, SummaryTruncation, ValueSummary } from './summarizer.js';
export { buildSnapshot } from './snapshot.js';
export type { BuildSnapshotContext } from './snapshot.js';
export { EventFeed } from './feed.js';
export type {
  AttachOptions,
  DevtoolsCacheLike,
  DevtoolsEvent,
  DevtoolsHandle,
  DevtoolsSnapshot,
  DevtoolsSnapshotPayload,
  DevtoolsValueMode,
  SnapshotEntry,
  SnapshotOptions,
} from './types.js';

// Re-exported from the frozen shared contract so a UI has one place to import redaction.
export {
  isBlazeRecord,
  isRedactedKey,
  redactKey,
  REDACT_KEY_PATTERNS,
  bindingFromKind,
  featureFromKind,
  makeBlazeKind,
} from '@blaze-cache/core/shared';
export type { BlazeRecord } from '@blaze-cache/core/shared';
