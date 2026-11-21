/**
 * Opt-in cross-tab synchronization for {@link BlazeCache}.
 *
 * One `BroadcastChannel` per `namespace\0generation` carries mutations between tabs. The
 * module never changes what a *local* write does: it is a side channel that listens to the cache's
 * publish step and applies remote mutations through a path that deliberately skips that step,
 * so a message can never bounce back and become an echo storm.
 *
 * Ordering uses a hybrid logical clock (physical ms + logical counter) plus a per-client
 * sequence and a `clientId` tiebreaker. Every key remembers the version of the last write that
 * touched it; a late message carrying an older version is ignored instead of resurrecting a
 * value a focused tab has already replaced. That is the "hidden tab flushes an older value"
 * failure this stage fixes.
 *
 * Nothing here exists unless `multiTab.enabled` is set: caches created without it keep the
 * exact same code path as before, and environments without `BroadcastChannel` degrade silently.
 */

/** Where a value comes from across tabs. */
export type MultiTabStrategy = 'value' | 'invalidate';

/** Options for {@link BlazeCacheOptions.multiTab}. */
export interface MultiTabOptions {
  /** Must be `true` to enable sync. Default off. */
  enabled: boolean;
  /** Override the channel name. Default: `blaze-cache:${namespace}\0${generation}`. */
  channel?: string;
  /**
   * `value` (default) broadcasts structured-cloneable values; a non-cloneable value falls
   * back to an invalidate (tombstone) message. `invalidate` always sends tombstones, for apps
   * that refetch on focus.
   */
  strategy?: MultiTabStrategy;
}

/** A comparable HLC stamp. `p` is physical ms, `l` the logical counter within that ms. */
export interface HlcStamp {
  p: number;
  l: number;
}

/** A version is an HLC stamp plus the originating client, for deterministic tie-breaking. */
export interface Version extends HlcStamp {
  c: string;
  /** Per-client sequence, only used when stamp and client id are equal (same sender). */
  s: number;
}

/** What the cache hands the sync layer for a remote operation. */
export interface MultiTabBridge<V> {
  /** Where the payload of a remote `set` goes. */
  applySet(key: string, value: V | undefined, ttlMs: number | null, tags: string[]): void;
  applyDelete(key: string): void;
  applyClear(): void;
  applyInvalidateTags(tags: string[]): void;
  applyRotate(generation: string): void;
  /** Emits a `remote-*` event; the cache decides listeners and payload shape. */
  emitRemote(type: RemoteType, key: string | null, value: V | undefined): void;
  /** All live entries, for the `hello`/`state` handshake. */
  snapshot(): Array<{ key: string; version: Version | undefined; ttlMs: number | null; tags: string[]; value: V }>;
  /** The last seen version for `key`, or `undefined`. */
  versionOf(key: string): Version | undefined;
  /** Records the version a remote mutation installed. */
  setVersion(key: string, version: Version): void;
  /** Clears all per-key versions after a clear/rotate. */
  resetVersions(): void;
}

export type RemoteType =
  | 'remote-set'
  | 'remote-delete'
  | 'remote-clear'
  | 'remote-invalidate'
  | 'remote-rotate';

interface BaseMessage {
  clientId: string;
  seq: number;
  version: Version;
}

export type SyncMessage<V = any> = BaseMessage &
  (
    | { kind: 'set'; key: string; ttlMs: number | null; tags: string[]; value?: V }
    | { kind: 'delete'; key: string }
    | { kind: 'clear' }
    | { kind: 'invalidate-tags'; tags: string[] }
    | { kind: 'rotate'; generation: string }
    | { kind: 'hello' }
    | {
        kind: 'state';
        entries: Array<{
          key: string;
          version: Version;
          ttlMs: number | null;
          tags: string[];
          value?: V;
        }>;
      }
  );

/** Compare two versions: physical, logical, then client id, then sequence. */
export function compareVersions(a: Version, b: Version): number {
  return (
    a.p - b.p ||
    a.l - b.l ||
    (a.c < b.c ? -1 : a.c > b.c ? 1 : 0) ||
    a.s - b.s
  );
}

/** A tiny hybrid logical clock: monotonic across sends and observed remote stamps. */
class Clock {
  #p = 0;
  #l = 0;

  tick(clientId: string, seq: number): Version {
    const now = Date.now();
    if (now > this.#p) {
      this.#p = now;
      this.#l = 0;
    } else {
      this.#l += 1;
    }
    return { p: this.#p, l: this.#l, c: clientId, s: seq };
  }

  observe(stamp: HlcStamp): void {
    if (stamp.p > this.#p) {
      this.#p = stamp.p;
      this.#l = stamp.l;
    } else if (stamp.p === this.#p && stamp.l > this.#l) {
      this.#l = stamp.l;
    }
  }

  /** Current stamp without advancing the clock (for publishing the last version). */
  stamp(clientId: string, seq: number): Version {
    return { p: this.#p, l: this.#l, c: clientId, s: seq };
  }
}

/** Would `BroadcastChannel` structured-clone this value? Used for the fallback strategy. */
function isCloneable(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

/** Structured clone of a value that may be a zero-copy Wasm view; never throws. */
function cloneValue<V>(value: V): V | undefined {
  try {
    return structuredClone(value);
  } catch {
    return undefined;
  }
}

/**
 * The sync layer. Created only when `multiTab.enabled`; all methods are no-ops otherwise (the
 * cache does not construct one in that case).
 */
export class MultiTabSync<V> {
  readonly clientId: string;
  readonly #channelName: string;
  readonly #strategy: MultiTabStrategy;
  readonly #bridge: MultiTabBridge<V>;
  readonly #clock = new Clock();
  #channel: BroadcastChannel | null = null;
  #seq = 0;
  /** Last clear/rotate stamp — protects against old set messages arriving afterwards. */
  #epochVersion: Version | null = null;
  #generation: string;
  #unbind: Array<() => void> = [];
  #closed = false;

  constructor(options: {
    channel: string;
    generation: string;
    strategy: MultiTabStrategy;
    bridge: MultiTabBridge<V>;
  }) {
    this.clientId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.#channelName = options.channel;
    this.#generation = options.generation;
    this.#strategy = options.strategy;
    this.#bridge = options.bridge;

    if (typeof BroadcastChannel === 'undefined') return; // Worker / older browser: silent no-op.
    this.#channel = new BroadcastChannel(this.#channelName);
    this.#channel.onmessage = (event: MessageEvent) => this.#receive(event.data as SyncMessage<V>);
    this.#bindLifecycle();
    this.#post({ kind: 'hello' });
  }

  get active(): boolean {
    return this.#channel !== null && !this.#closed;
  }

  /** The channel name, also used as the cross-tab Web Lock name. */
  get channelName(): string {
    return this.#channelName;
  }

  /** The current generation, updated on rotate. */
  get generation(): string {
    return this.#generation;
  }

  /** Version assigned to the most recent outgoing message. */
  get lastVersion(): Version | null {
    return this.#seq === 0 ? null : this.#clock.stamp(this.clientId, this.#seq);
  }

  // ------------------------------------------------------------------ publish

  /** Broadcasts a local set. Returns immediately when the feature is off or channel closed. */
  publishSet(key: string, value: V | undefined, ttlMs: number | null, tags: string[]): void {
    const sendValue = this.#strategy === 'value' && isCloneable(value);
    this.#post({
      kind: 'set',
      key,
      ttlMs,
      tags: [...tags],
      ...(sendValue ? { value: cloneValue(value) } : {}),
    });
  }

  publishDelete(key: string): void {
    this.#post({ kind: 'delete', key });
  }

  publishClear(): void {
    this.#post({ kind: 'clear' });
  }

  publishInvalidateTags(tags: string[]): void {
    this.#post({ kind: 'invalidate-tags', tags: [...tags] });
  }

  publishRotate(generation: string): void {
    this.#generation = generation;
    this.#post({ kind: 'rotate', generation });
  }

  /** Sends a hello on focus/visibility so an offline tab can catch up. */
  hello(): void {
    this.#post({ kind: 'hello' });
  }

  /** Marks the last outgoing mutation as a new epoch (clear/invalidate/rotate). */
  markEpoch(): void {
    if (this.#seq > 0) this.#epochVersion = this.lastVersion;
  }

  /** Releases the channel and lifecycle listeners. Called by `dispose()`. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const unbind of this.#unbind.splice(0)) unbind();
    const channel = this.#channel;
    this.#channel = null;
    channel?.close();
  }

  // ------------------------------------------------------------------ internals

  #nextVersion(): Version {
    return this.#clock.tick(this.clientId, ++this.#seq);
  }

  #post(body: Record<string, unknown> & { kind: SyncMessage<V>['kind'] }): void {
    const channel = this.#channel;
    if (!channel || this.#closed) return;
    const version = this.#nextVersion();
    const message = {
      ...body,
      clientId: this.clientId,
      seq: version.s,
      version,
    } as unknown as SyncMessage<V>;
    try {
      channel.postMessage(message);
    } catch {
      // A channel whose peer was closed can throw; sync is best-effort and must never break
      // the local mutation that triggered it.
    }
  }

  #bindLifecycle(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') this.hello();
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    this.#unbind.push(() => {
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    });
  }

  #receive(message: SyncMessage<V>): void {
    if (!message || typeof message !== 'object') return;
    if (message.clientId === this.clientId) return; // own message (some polyfills echo)
    if (!message.version || typeof message.version.p !== 'number') return;
    this.#clock.observe(message.version);

    // Handshake: answer a hello with our state; merge a state reply with newer entries.
    if (message.kind === 'hello') {
      this.#sendState();
      return;
    }
    if (message.kind === 'state') {
      for (const entry of message.entries) {
        if (!this.#isNewer(entry.version, entry.key)) continue;
        this.#bridge.setVersion(entry.key, entry.version);
        // A state entry without a `value` property is a tombstone under the invalidate
        // strategy: the receiving tab should drop its copy, not store `undefined`.
        if (!Object.hasOwn(entry, 'value')) this.#bridge.applyDelete(entry.key);
        else this.#bridge.applySet(entry.key, entry.value as V, entry.ttlMs, entry.tags);
      }
      return;
    }

    if (!this.#isNewer(message.version, 'key' in message ? message.key : '')) return;

    switch (message.kind) {
      case 'set':
        this.#applySetMessage(message);
        break;
      case 'delete':
        this.#bridge.setVersion(message.key, message.version);
        this.#bridge.applyDelete(message.key);
        this.#bridge.emitRemote('remote-delete', message.key, undefined);
        break;
      case 'clear':
        this.#epochVersion = message.version;
        this.#bridge.resetVersions();
        this.#bridge.applyClear();
        this.#bridge.emitRemote('remote-clear', null, undefined);
        break;
      case 'invalidate-tags':
        this.#epochVersion = message.version;
        this.#bridge.applyInvalidateTags(message.tags);
        this.#bridge.emitRemote('remote-invalidate', null, undefined);
        break;
      case 'rotate':
        this.#epochVersion = message.version;
        this.#generation = message.generation;
        this.#bridge.resetVersions();
        this.#bridge.applyRotate(message.generation);
        this.#bridge.emitRemote('remote-rotate', null, undefined);
        break;
    }
  }

  #isNewer(version: Version, key: string): boolean {
    if (this.#epochVersion && compareVersions(version, this.#epochVersion) <= 0) return false;
    const local = key ? this.#bridge.versionOf(key) : undefined;
    return !local || compareVersions(version, local) > 0;
  }

  #applySetMessage(message: Extract<SyncMessage<V>, { kind: 'set' }>): void {
    this.#bridge.setVersion(message.key, message.version);
    if (!Object.hasOwn(message, 'value')) {
      // 'invalidate' strategy (or a non-cloneable value): drop the local copy so the app
      // refetches. This is a tombstone, never a write of `undefined`.
      this.#bridge.applyDelete(message.key);
      this.#bridge.emitRemote('remote-delete', message.key, undefined);
      return;
    }
    this.#bridge.applySet(message.key, message.value, message.ttlMs, message.tags);
    this.#bridge.emitRemote('remote-set', message.key, message.value);
  }

  #sendState(): void {
    const channel = this.#channel;
    if (!channel || this.#closed) return;
    const entries = this.#bridge.snapshot().map((entry) => ({
      key: entry.key,
      version: entry.version ?? this.#clock.tick(this.clientId, this.#seq),
      ttlMs: entry.ttlMs,
      tags: entry.tags,
      ...(this.#strategy === 'value' && isCloneable(entry.value)
        ? { value: cloneValue(entry.value) }
        : {}),
    }));
    const message: SyncMessage<V> = {
      kind: 'state',
      entries,
      clientId: this.clientId,
      seq: this.#seq,
      version: this.#nextVersion(),
    };
    try {
      channel.postMessage(message);
    } catch {
      // Best effort, like #post.
    }
  }
}
