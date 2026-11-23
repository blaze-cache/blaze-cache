/** Registry and lifecycle for devtools attachments. */
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
  #off: (() => void) | null;
  #active = true;

  constructor(cache: DevtoolsCacheLike, cacheId: string, options: AttachOptions) {
    this.cacheId = cacheId;
    this.clientId = makeId('client');
    this.label = options.label;
    this.#options = options;
    this.#ref = new WeakRef(cache);
    this.#feed = new EventFeed(this.clientId, options.maxEvents ?? 500);
    // The only listener devtools ever registers. Its closure captures *this handle*, not
    // the cache, so the WeakRef remains weak. The unsubscribe function is the exact one the
    // event bus handed back, so detaching restores the prior drop-log state precisely.
    this.#off = cache.on((event) =>
      this.#deliver(event.type, 'key' in event ? event.key : undefined),
    );
  }

  get active(): boolean {
    return this.#active;
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
      this.#off?.();
    } finally {
      this.#off = null;
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
    if (existing?.deref() === cache && existing.active) return existing;
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
