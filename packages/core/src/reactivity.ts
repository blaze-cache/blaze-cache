import type { BlazeCache } from './cache.js';
import type {
  CacheEventType,
  CacheManySubscriber,
  CacheKeySubscriber,
  CacheMutation,
  CacheSubscribeOptions,
  CacheTagChange,
  CacheTagSubscriber,
} from './types.js';

/**
 * The mutation events a subscription listens to — exactly the eight the cache raises for a
 * change.
 *
 * `hit`/`miss` are deliberately absent: they are reads, and a lookup must never wake a
 * subscriber. Registering them as **typed** listeners (rather than the wildcard) is what
 * keeps the read path out of the layer entirely.
 */
const CHANGE_TYPES: readonly CacheEventType[] = [
  'set',
  'delete',
  'touch',
  'evict',
  'expire',
  'invalidate',
  'prune',
  'clear',
];

/** The members of {@link CacheMutation} that name a single key. */
type KeyedMutation<V> = Extract<CacheMutation<V>, { key: string }>;
/** The members of {@link CacheMutation} that name a batch of keys. */
type KeyedBatch<V> = Extract<CacheMutation<V>, { keys: string[] }>;

/** One `subscribe` / `subscribeMany` registration: the keys it watches and how to call it. */
interface KeySubscription<V> {
  /** Deduplicated keys this registration is interested in. */
  readonly keys: readonly string[];
  /** Calls the caller's listener with this key's current value and the mutation. */
  readonly invoke: (key: string, value: V | undefined, change: CacheMutation<V>) => void;
  /** `true` for `{ once: true }` — removed the moment it fires. */
  readonly once: boolean;
  /** Cleared the instant the subscription stops, so a stale handle can never fire twice. */
  active: boolean;
}

/** One `subscribeTag` registration. */
interface TagSubscription<V> {
  readonly tag: string;
  readonly invoke: (info: CacheTagChange<V>) => void;
  readonly once: boolean;
  active: boolean;
}

/**
 * The opt-in reactivity layer behind {@link BlazeCache.subscribe} / `subscribeTag` /
 * `subscribeMany`.
 *
 * ## Design
 *
 * Nothing here runs until the first `subscribe` call. That call attaches the layer to the
 * event bus — eight **typed** listeners, one per change type — and snapshots the live keys
 * so `clear` (which names nothing) can still be reported precisely. From then on every
 * mutation is dispatched twice over: the mirrors first, so a subscriber always observes a
 * cache the layer already agrees with, and the subscribers second.
 *
 * Two mirrors, both dropped the moment the last subscription stops:
 *
 * * `#live` — the live keys, kept in step by the events themselves (a `set` adds, a
 *   removal deletes, `clear` empties). It is what proves a key was present when `clear`
 *   hit, so a subscription for an absent key is never woken by one.
 * * `#tagged` — per *watched* tag, the live keys carrying it, hydrated straight from
 *   {@link BlazeCache.keysWithTag} the first time somebody subscribes to that tag. Removal
 *   events carry no tags, so this is what attributes a `delete`/`evict`/`expire`/
 *   `invalidate`/`prune`/`clear` to the tag subscriptions it concerns — without it the
 *   layer would have to guess, or poll the cache.
 *
 * The cost of a subscription is therefore bounded and paid only while one exists: one
 * `keys()` crossing at attach, one `keysWithTag()` per watched tag, one `tagsOf()` per
 * write *only while a tag subscription is live*, and a `peek()` per change to a key
 * somebody actually subscribed to. With no subscription the layer does not exist and the
 * hot path is untouched.
 *
 * Delivery mirrors the event bus: a snapshot of the subscriber set is taken before each
 * notification and membership re-checked per subscriber, so one that unsubscribes mid-event
 * — by its own handle, or because a `{ once: true }` sibling fired — is never visited for
 * that event. A subscriber that throws is isolated with `console.error`; the mutation it
 * was told about stands and the remaining subscribers still run.
 */
export class CacheSubscriptions<V = any> {
  readonly #cache: BlazeCache<V>;
  /** `subscribe` / `subscribeMany` registrations, indexed by each key they watch. */
  readonly #byKey = new Map<string, Set<KeySubscription<V>>>();
  /** `subscribeTag` registrations, indexed by tag. */
  readonly #byTag = new Map<string, Set<TagSubscription<V>>>();
  /** Watched tag → the live keys carrying it. Empty (and rebuilt) while nobody watches. */
  readonly #tagged = new Map<string, Set<string>>();
  /** Live keys while attached — the proof `clear` needs. `undefined` once detached. */
  #live: Set<string> | undefined;
  /** Unsubscribe handles for the eight bus listeners currently registered. */
  readonly #detachers: Array<() => void> = [];
  /** Active registrations; reaching zero detaches the layer from the bus. */
  #count = 0;

  constructor(cache: BlazeCache<V>) {
    this.#cache = cache;
  }

  // ------------------------------------------------------------- subscribe

  /**
   * Watches one key. The listener receives the key's **current** value — `undefined` once
   * the change removed it or it expired — plus the mutation that woke it.
   */
  subscribe(
    key: string,
    listener: CacheKeySubscriber<V>,
    options?: CacheSubscribeOptions,
  ): () => void {
    const sub: KeySubscription<V> = {
      keys: [key],
      once: options?.once === true,
      active: true,
      invoke: (_key, value, change) => listener(value, change),
    };
    return this.#addKey(sub);
  }

  /**
   * Watches several keys with one listener, which is told *which* key changed. Duplicates
   * collapse, and an empty list subscribes to nothing — it never attaches and returns a
   * no-op handle.
   */
  subscribeMany(
    keys: string[],
    listener: CacheManySubscriber<V>,
    options?: CacheSubscribeOptions,
  ): () => void {
    const unique = [...new Set(keys)];
    if (unique.length === 0) return () => {};
    const sub: KeySubscription<V> = {
      keys: unique,
      once: options?.once === true,
      active: true,
      invoke: (key, value, change) => listener(key, value, change),
    };
    return this.#addKey(sub);
  }

  /**
   * Watches one tag. The listener is told which of that tag's keys the mutation touched —
   * a write reports the key that entered or stayed in the tag, a removal reports the keys
   * that left it — and what the mutation was.
   */
  subscribeTag(
    tag: string,
    listener: CacheTagSubscriber<V>,
    options?: CacheSubscribeOptions,
  ): () => void {
    this.#attach();
    // First watcher of this tag: its key set comes straight from the cache, so the mirror
    // starts out exactly as wide as the tag actually is.
    if (!this.#tagged.has(tag)) this.#tagged.set(tag, new Set(this.#cache.keysWithTag(tag)));

    const sub: TagSubscription<V> = {
      tag,
      once: options?.once === true,
      active: true,
      invoke: listener,
    };
    let set = this.#byTag.get(tag);
    if (set === undefined) {
      set = new Set();
      this.#byTag.set(tag, set);
    }
    set.add(sub);
    this.#count += 1;
    return () => this.#stopTag(sub);
  }

  // ---------------------------------------------------------- unsubscribe

  /** Re-registers the eight bus listeners after `cache.off()` dropped them. See `rebind`. */
  rebind(): void {
    if (this.#count === 0) return;
    this.#unbind();
    this.#attach();
  }

  /** Drops every subscription and detaches from the bus — `BlazeCache.dispose` calls this. */
  dispose(): void {
    this.#detach();
  }

  // ------------------------------------------------------------- internals

  #addKey(sub: KeySubscription<V>): () => void {
    this.#attach();
    for (const key of sub.keys) {
      let set = this.#byKey.get(key);
      if (set === undefined) {
        set = new Set();
        this.#byKey.set(key, set);
      }
      set.add(sub);
    }
    this.#count += 1;
    return () => this.#stopKey(sub);
  }

  /** Idempotent: a handle released twice — or already consumed by `once` — costs nothing. */
  #stopKey(sub: KeySubscription<V>): void {
    if (!sub.active) return;
    sub.active = false;
    for (const key of sub.keys) {
      const set = this.#byKey.get(key);
      if (set === undefined) continue;
      set.delete(sub);
      if (set.size === 0) this.#byKey.delete(key);
    }
    this.#count -= 1;
    this.#maybeDetach();
  }

  #stopTag(sub: TagSubscription<V>): void {
    if (!sub.active) return;
    sub.active = false;
    const set = this.#byTag.get(sub.tag);
    if (set !== undefined) {
      set.delete(sub);
      if (set.size === 0) {
        this.#byTag.delete(sub.tag);
        // Last watcher of this tag out — stop mirroring its keys (and rebuild the mirror
        // fresh from the cache should anybody subscribe to the tag again).
        this.#tagged.delete(sub.tag);
      }
    }
    this.#count -= 1;
    this.#maybeDetach();
  }

  #maybeDetach(): void {
    if (this.#count > 0) return;
    this.#detach();
  }

  /**
   * Attaches to the bus: snapshots the live keys, rebuilds the per-tag mirrors and
   * registers the eight change listeners. Idempotent — a second call (from `rebind`, or
   * from a later `subscribe` after everything stopped) only runs once the handles are gone.
   */
  #attach(): void {
    if (this.#detachers.length > 0) return;
    this.#live = new Set(this.#cache.keys());
    for (const tag of this.#byTag.keys()) {
      this.#tagged.set(tag, new Set(this.#cache.keysWithTag(tag)));
    }
    for (const type of CHANGE_TYPES) {
      this.#detachers.push(
        this.#cache.on(type, (event) => this.#dispatch(event as CacheMutation<V>)),
      );
    }
  }

  /** Releases the bus listeners and the mirrors — the subscriptions themselves survive. */
  #unbind(): void {
    for (const unbind of this.#detachers.splice(0)) unbind();
    this.#live = undefined;
    this.#tagged.clear();
  }

  /** Full teardown: release everything *and* deactivate every outstanding handle. */
  #detach(): void {
    this.#unbind();
    for (const set of this.#byKey.values()) for (const sub of set) sub.active = false;
    for (const set of this.#byTag.values()) for (const sub of set) sub.active = false;
    this.#byKey.clear();
    this.#byTag.clear();
    this.#count = 0;
  }

  // -------------------------------------------------------------- dispatch

  /** One bus event → mirrors first, then the subscribers it concerns. */
  #dispatch(change: CacheMutation<V>): void {
    switch (change.type) {
      case 'set':
      case 'touch':
      case 'delete':
      case 'evict':
      case 'expire':
        this.#dispatchKey(change);
        break;
      case 'invalidate':
      case 'prune':
        this.#dispatchKeys(change.keys, change);
        break;
      case 'clear':
        this.#dispatchClear(change);
        break;
    }
  }

  #dispatchKey(change: KeyedMutation<V>): void {
    const live = this.#live;
    // Detached while this event was already in flight — every handle is dead, so there is
    // nothing left to wake.
    if (live === undefined) return;
    const key = change.key;

    // Mirrors first: by the time a subscriber runs, the layer agrees with the cache.
    let tags: string[] | undefined;
    switch (change.type) {
      case 'set':
        live.add(key);
        tags = this.#retag(key); // membership may have changed in either direction
        break;
      case 'touch':
        live.add(key); // a touch only ever succeeds on a live entry
        tags = this.#holding(key); // membership is unchanged — just who holds it
        break;
      default: // delete | evict | expire — the entry is gone
        live.delete(key);
        tags = this.#untag(key);
        break;
    }

    const set = this.#byKey.get(key);
    if (set !== undefined) {
      // `set`/`touch` happen to a live entry, so read the value back; every other mutation
      // removed it, and `undefined` is the truth — no crossing needed to say so. For
      // `evict`/`expire` the dropped reference is still on `change.value`.
      const removing = change.type !== 'set' && change.type !== 'touch';
      this.#notifyKey(set, key, removing ? undefined : this.#cache.peek(key), change);
    }
    if (tags !== undefined) for (const tag of tags) this.#notifyTag(tag, [key], change);
  }

  #dispatchKeys(keys: string[], change: KeyedBatch<V>): void {
    const live = this.#live;
    if (live === undefined) return;
    const tags = this.#tagged.size > 0 ? new Map<string, string[]>() : undefined;

    // Mirrors first.
    for (const key of keys) {
      live.delete(key);
      if (tags === undefined) continue;
      for (const [tag, held] of this.#tagged) {
        if (!held.delete(key)) continue;
        const list = tags.get(tag);
        if (list === undefined) tags.set(tag, [key]);
        else list.push(key);
      }
    }

    // Then the subscribers. The event itself lists exactly what was removed, so no mirror
    // is consulted to decide *who* to wake — only to decide which tags those keys left.
    for (const key of keys) {
      const set = this.#byKey.get(key);
      if (set !== undefined) this.#notifyKey(set, key, undefined, change);
    }
    if (tags !== undefined) for (const [tag, list] of tags) this.#notifyTag(tag, list, change);
  }

  #dispatchClear(change: CacheMutation<V>): void {
    const live = this.#live;
    if (live === undefined) return;
    // A `clear` payload names nothing, so the mirrors are the only proof of what was
    // there: a subscription for a key the cache never held stays silent.
    const keys: string[] = [];
    for (const key of this.#byKey.keys()) if (live.has(key)) keys.push(key);
    const tags = new Map<string, string[]>();
    for (const [tag, held] of this.#tagged) if (held.size > 0) tags.set(tag, [...held]);

    // Mirrors first.
    live.clear();
    for (const held of this.#tagged.values()) held.clear();

    // Then the subscribers.
    for (const key of keys) {
      const set = this.#byKey.get(key);
      if (set !== undefined) this.#notifyKey(set, key, undefined, change);
    }
    for (const [tag, list] of tags) this.#notifyTag(tag, list, change);
  }

  // --------------------------------------------------------------- mirrors

  /**
   * Re-reads `key`'s tags after a write and settles the watched tags against them,
   * returning every watched tag that holds it now **or** did a moment ago — a write can
   * move a key into a tag, out of one, or both at once.
   */
  #retag(key: string): string[] | undefined {
    if (this.#tagged.size === 0) return undefined;
    const next = this.#cache.tagsOf(key);
    const hits: string[] = [];
    for (const [tag, held] of this.#tagged) {
      const wasIn = held.has(key);
      const isIn = next.includes(tag);
      if (isIn) held.add(key);
      else held.delete(key);
      if (wasIn || isIn) hits.push(tag);
    }
    return hits;
  }

  /** The watched tags currently holding `key`, mirror untouched. */
  #holding(key: string): string[] | undefined {
    if (this.#tagged.size === 0) return undefined;
    const hits: string[] = [];
    for (const [tag, held] of this.#tagged) if (held.has(key)) hits.push(tag);
    return hits;
  }

  /** Drops `key` from every watched tag, returning the tags it just left. */
  #untag(key: string): string[] | undefined {
    if (this.#tagged.size === 0) return undefined;
    const hits: string[] = [];
    for (const [tag, held] of this.#tagged) if (held.delete(key)) hits.push(tag);
    return hits;
  }

  // -------------------------------------------------------------- deliver

  #notifyKey(
    set: Set<KeySubscription<V>>,
    key: string,
    value: V | undefined,
    change: CacheMutation<V>,
  ): void {
    // Snapshot + membership check, exactly like the event bus: a subscriber that stops
    // mid-event (its own handle, or a `{ once: true }` sibling) is never visited for it,
    // and one added mid-event only hears the next change.
    for (const sub of [...set]) {
      if (!sub.active || !set.has(sub)) continue;
      if (sub.once) this.#stopKey(sub); // detach before invoking, like `once` on the bus
      this.#call(() => sub.invoke(key, value, change));
    }
  }

  #notifyTag(tag: string, keys: string[], change: CacheMutation<V>): void {
    const set = this.#byTag.get(tag);
    if (set === undefined || set.size === 0) return;
    // One shared payload for every subscriber of this tag — the bus hands the same event
    // object to all of its listeners too.
    const info: CacheTagChange<V> = { tag, keys, change };
    for (const sub of [...set]) {
      if (!sub.active || !set.has(sub)) continue;
      if (sub.once) this.#stopTag(sub);
      this.#call(() => sub.invoke(info));
    }
  }

  /** Runs one subscriber, isolating its failure from every other subscriber. */
  #call(run: () => void): void {
    try {
      run();
    } catch (error) {
      // The mutation already happened — a bad subscriber must not abort its siblings or
      // surface out of a successful `set`.
      console.error(
        '[blaze-cache] subscription listener failed — the other subscribers still run.',
        error,
      );
    }
  }
}
