/** Registry and lifecycle for devtools attachments. */
import type { CacheEvent } from '@blaze-cache/core';
import { REDACT_KEY_PATTERNS } from '@blaze-cache/core/shared';

import { EventFeed } from './feed.js';
import { makeId } from './protocol.js';
import { buildSnapshot } from './snapshot.js';
import type {
  AttachOptions,
  DevtoolsCacheLike,
  DevtoolsEvent,
  DevtoolsHandle,
  DevtoolsSnapshot,
  SnapshotOptions,
} from './types.js';

const registry = new Map<string, Handle>();
const cacheIds = new WeakMap<object, string>();
const globalListeners = new Set<(event: DevtoolsEvent) => void>();

/** The default ring-buffer size — the same one `EventFeed` gets when `maxEvents` is omitted. */
const DEFAULT_MAX_EVENTS = 500;
/** The default value rendering — the same one `buildSnapshot` falls back to. */
const DEFAULT_VALUE_MODE = 'summary';

/**
 * Structural equality for pattern lists: two lists match when they describe the same
 * patterns, whatever `RegExp` objects carry them — `attach()` is called with freshly
 * written literals far more often than with one shared array.
 */
function samePatterns(a: readonly RegExp[], b: readonly RegExp[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === right) continue;
    if (left === undefined || right === undefined) return false;
    if (left.source !== right.source || left.flags !== right.flags) return false;
  }
  return true;
}

function isCache(value: unknown): value is DevtoolsCacheLike {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as DevtoolsCacheLike).on === 'function' &&
    typeof (value as DevtoolsCacheLike).stats === 'function'
  );
}

class Handle implements DevtoolsHandle {
  readonly cacheId: string;
  readonly clientId: string;
  readonly label: string | undefined;
  readonly #ref: WeakRef<DevtoolsCacheLike>;
  readonly #feed: EventFeed;
  readonly #options: AttachOptions;
  readonly #listener: (event: CacheEvent) => void;
  /** The bus-provided unsub — held only when the cache exposes no `off()`. */
  #unsub: (() => void) | null;
  #active = true;

  constructor(cache: DevtoolsCacheLike, cacheId: string, options: AttachOptions) {
    this.cacheId = cacheId;
    this.clientId = makeId('client');
    this.label = options.label;
    this.#options = options;
    this.#ref = new WeakRef(cache);
    this.#feed = new EventFeed(this.clientId, options.maxEvents ?? DEFAULT_MAX_EVENTS);
    // The only listener devtools ever registers. Its closure captures *this handle*, not
    // the cache, so the WeakRef remains weak.
    this.#listener = (event) => this.#deliver(event.type, 'key' in event ? event.key : undefined);
    // Detaching prefers `cache.off(listener)`. The unsub `on()` hands back closes over the
    // event bus, and the bus's onChange callback closes over the cache — storing that
    // closure here would make the registry pin a cache it has no business retaining (the
    // exact leak this replaced). Only a cache with no `off()` of its own (a structural
    // double) keeps the unsub, since it is that cache's only unsubscribe handle.
    const unsub = cache.on(this.#listener);
    this.#unsub = typeof cache.off === 'function' ? null : unsub;
  }

  get active(): boolean {
    return this.#active;
  }

  /**
   * `true` when `next` would change how this live handle behaves. Omitted fields mean
   * "keep whatever the handle has" (an empty re-attach stays idempotent), so only an
   * explicitly provided field that resolves differently than the live one counts —
   * defaults are resolved first so re-stating them is not a conflict.
   */
  conflictsWith(next: AttachOptions): boolean {
    const current = this.#options;
    if (next.label !== undefined && next.label !== current.label) return true;
    if (
      next.valueMode !== undefined &&
      next.valueMode !== (current.valueMode ?? DEFAULT_VALUE_MODE)
    ) {
      return true;
    }
    if (
      next.maxEvents !== undefined &&
      next.maxEvents !== (current.maxEvents ?? DEFAULT_MAX_EVENTS)
    ) {
      return true;
    }
    if (
      next.redactKeys !== undefined &&
      !samePatterns(next.redactKeys, current.redactKeys ?? REDACT_KEY_PATTERNS)
    ) {
      return true;
    }
    return false;
  }

  #deliver(type: string, key?: string): void {
    const event = this.#feed.push(type, key);
    for (const listener of [...globalListeners]) {
      try {
        listener(event);
      } catch {
        // UI listeners are isolated from the host app's mutation path.
      }
    }
  }

  deref(): DevtoolsCacheLike | undefined {
    return this.#ref.deref();
  }

  snapshot(options?: SnapshotOptions): DevtoolsSnapshot {
    const cache = this.deref();
    if (!cache) throw new Error('[blaze-cache/devtools] the observed cache has been collected.');
    return buildSnapshot(
      cache,
      {
        cacheId: this.cacheId,
        clientId: this.clientId,
        label: this.label,
        redactKeys: this.#options.redactKeys,
        valueMode: this.#options.valueMode,
      },
      options,
    );
  }

  events(): readonly DevtoolsEvent[] {
    return this.#feed.events();
  }

  onEvent(listener: (event: DevtoolsEvent) => void): () => void {
    return this.#feed.onEvent(listener);
  }

  detach(): void {
    if (!this.#active) return;
    this.#active = false;
    try {
      if (this.#unsub !== null) {
        this.#unsub();
      } else {
        // Identity-based removal: exactly this listener, wildcard set only. The cache may
        // already have been collected — then its bus died with it and there is nothing
        // left to unsubscribe from.
        this.#ref.deref()?.off?.(this.#listener);
      }
    } finally {
      this.#unsub = null;
      this.#feed.close();
      if (registry.get(this.cacheId) === this) registry.delete(this.cacheId);
    }
  }
}

/** Attaches devtools to one cache. Attaching twice to the same cache is idempotent. */
export function attach(cache: DevtoolsCacheLike, options: AttachOptions = {}): DevtoolsHandle {
  if (!isCache(cache)) {
    throw new TypeError('[blaze-cache/devtools] attach() needs a cache with on() and stats().');
  }
  let cacheId = cacheIds.get(cache);
  if (cacheId !== undefined) {
    const existing = registry.get(cacheId);
    if (existing?.deref() === cache && existing.active) {
      // Silent option-dropping on a live re-attach is a footgun: the second call's
      // label/modes would never take effect. Refuse loudly instead — detach first.
      if (existing.conflictsWith(options)) {
        throw new Error(
          '[blaze-cache/devtools] attach() called again with different options for a live handle — detach() first to change them.',
        );
      }
      return existing;
    }
  }
  cacheId = cacheId ?? makeId('cache');
  cacheIds.set(cache, cacheId);
  const handle = new Handle(cache, cacheId, options);
  registry.set(cacheId, handle);
  return handle;
}

/** Detaches a handle (or every handle attached to a cache object). Returns what was removed. */
export function detach(target: DevtoolsHandle | object): number {
  if (target instanceof Handle) {
    if (!target.active) return 0;
    target.detach();
    return 1;
  }
  let removed = 0;
  for (const handle of [...registry.values()]) {
    if (handle.deref() === target) {
      handle.detach();
      removed += 1;
    }
  }
  return removed;
}

/** Live attachments. Collected caches are pruned from the registry as a side effect. */
export function list(): Array<{ cacheId: string; clientId: string; label: string | undefined }> {
  for (const handle of [...registry.values()]) {
    if (!handle.deref()) handle.detach();
  }
  return [...registry.values()].map((handle) => ({
    cacheId: handle.cacheId,
    clientId: handle.clientId,
    label: handle.label,
  }));
}

/** Detaches everything. No timers or module-level work exist before this is called. */
export function dispose(): void {
  for (const handle of [...registry.values()]) handle.detach();
  registry.clear();
  globalListeners.clear();
}

/** Global event subscription, handy for a UI that wants one stream across all caches. */
export function onEvent(listener: (event: DevtoolsEvent) => void): () => void {
  globalListeners.add(listener);
  return () => {
    globalListeners.delete(listener);
  };
}
