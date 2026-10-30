import type {
  CacheEvent,
  CacheEventListener,
  CacheEventMap,
  CacheEventType,
  CacheListener,
} from './types.js';

/**
 * A listener as the bus stores it — before the public overload narrows it to one type.
 *
 * The narrowing lives purely in the type system: at runtime a listener is always just a
 * function of one event object, which is what lets `once` wrap it and `off` compare it.
 */
type AnyListener = (event: any) => void;

/** The two event types only the Rust/Wasm core can produce (never a direct API call). */
const DROP_TYPES: ReadonlySet<CacheEventType> = new Set<CacheEventType>(['evict', 'expire']);

/**
 * The internal event bus behind {@link BlazeCache.on} / `once` / `off`.
 *
 * Layout is one `Set` per event type plus one `Set` for wildcard listeners, so delivering
 * an event touches at most two sets and allocates nothing. Two counters keep the hot path
 * free of any map work:
 *
 * * `#size` — every listener registered anywhere. `emit` checks it first, so a cache with
 *   no subscribers pays a single integer comparison per operation (and call sites that
 *   would have to *build* a payload check {@link CacheEventBus.size} before building it).
 * * `#dropSubscribers` — listeners that would hear `evict`/`expire` (typed ones plus every
 *   wildcard). It mirrors the wasm drop-tracking flag: the Rust core only records dropped
 *   entries while somebody is actually waiting for them.
 *
 * Iterating a `Set` while a listener runs is safe: a listener that unsubscribes prevents
 * the removed entries from being visited, and one that subscribes during delivery may be
 * visited in the same pass. Delivery order is deterministic — typed listeners for the event
 * first, wildcards last — and a throwing listener is isolated (logged, never propagated).
 *
 * The optional `onChange` callback fires after every registration change — including the
 * implicit removal a fired `once` performs — so the owner can re-derive any state that
 * must mirror the subscriber set (the cache uses it to switch the core's drop log on/off)
 * without each call site remembering to.
 */
export class CacheEventBus<V = any> {
  readonly #typed = new Map<CacheEventType, Set<AnyListener>>();
  readonly #wildcard = new Set<AnyListener>();
  readonly #onChange: (() => void) | undefined;
  /** Typed + wildcard listeners — the gate every `emit` reads first. */
  #size = 0;
  /** Wildcard listeners plus `evict`/`expire` listeners. */
  #dropSubscribers = 0;

  constructor(onChange?: () => void) {
    this.#onChange = onChange;
  }

  /** Total listeners (typed and wildcard). */
  get size(): number {
    return this.#size;
  }

  /** `true` when at least one listener would receive `evict` or `expire`. */
  get wantsDrops(): boolean {
    return this.#dropSubscribers > 0;
  }

  /** How many listeners are registered for exactly one event type (0 when none). */
  count(type: CacheEventType): number {
    return this.#typed.get(type)?.size ?? 0;
  }

  /**
   * `true` when someone would actually receive `type` — a listener of that type or any
   * wildcard.
   *
   * The "should I even build the payload?" gate for the hot path: `emit` alone would only
   * tell you *after* the (possibly expensive) event object exists.
   */
  hears(type: CacheEventType): boolean {
    return this.#wildcard.size > 0 || (this.#typed.get(type)?.size ?? 0) > 0;
  }

  // ------------------------------------------------------------- subscribe

  /**
   * Subscribes to one event type (or — without a type — to every event) and returns the
   * unsubscribe function. Registering the same function twice is a no-op: one call to the
   * returned unsub ends both, exactly like a `Set`.
   */
  on<K extends CacheEventType>(type: K, listener: CacheEventListener<V, K>): () => void;
  on(listener: CacheEventListener<V>): () => void;
  /** @deprecated The pre-event-system signature — kept so old annotations still compile. */
  on(listener: CacheListener): () => void;
  on(
    typeOrListener: CacheEventType | AnyListener,
    maybeListener?: AnyListener,
  ): () => void {
    const type = typeof typeOrListener === 'string' ? typeOrListener : undefined;
    const listener = (type === undefined ? typeOrListener : maybeListener) as AnyListener;

    const set = type === undefined ? this.#wildcard : this.#takeSet(type);
    if (!set.has(listener)) {
      set.add(listener);
      this.#size += 1;
      if (type === undefined || DROP_TYPES.has(type)) this.#dropSubscribers += 1;
      this.#onChange?.();
    }
    // The closure re-resolves the set through the map, so a stale unsub stays a no-op even
    // after `off(type)` dropped the whole set and a later `on` rebuilt it.
    return () => {
      this.#detach(type, listener);
      this.#onChange?.();
    };
  }

  /** Like {@link CacheEventBus.on}, but the listener is removed as it fires. */
  once<K extends CacheEventType>(type: K, listener: CacheEventListener<V, K>): () => void;
  once(listener: CacheEventListener<V>): () => void;
  /** @deprecated The pre-event-system signature — kept so old annotations still compile. */
  once(listener: CacheListener): () => void;
  once(
    typeOrListener: CacheEventType | AnyListener,
    maybeListener?: AnyListener,
  ): () => void {
    const type = typeof typeOrListener === 'string' ? typeOrListener : undefined;
    const raw = (type === undefined ? typeOrListener : maybeListener) as AnyListener;

    let unsubscribe!: () => void;
    const wrapped: AnyListener = (event) => {
      // Detach *before* invoking: a re-entrant emit from inside the listener must not fire
      // this one a second time, mirroring Node's `EventEmitter.once`.
      unsubscribe();
      raw(event);
    };
    unsubscribe = type === undefined ? this.on(wrapped) : this.on(type, wrapped);
    return unsubscribe;
  }

  // ----------------------------------------------------------- unsubscribe

  /** Removes every listener of `type`. */
  off(type: CacheEventType): void;
  /** Removes this one listener of `type`. */
  off(type: CacheEventType, listener: AnyListener): void;
  /** Removes this function from the wildcard **and** every typed set. */
  off(listener: AnyListener): void;
  /** Removes every listener of every type. */
  off(): void;
  off(typeOrListener?: CacheEventType | AnyListener, listener?: AnyListener): void {
    if (typeOrListener === undefined) {
      this.clear();
      return;
    }
    if (typeof typeOrListener === 'string') {
      const type = typeOrListener;
      if (listener === undefined) {
        const set = this.#typed.get(type);
        if (set !== undefined) {
          this.#size -= set.size;
          if (DROP_TYPES.has(type)) this.#dropSubscribers -= set.size;
          this.#typed.delete(type);
          this.#onChange?.();
        }
        return;
      }
      this.#detach(type, listener);
      this.#onChange?.();
      return;
    }
    // `off(listener)`: the caller wants *this function* gone — wildcard and typed alike.
    const fn = typeOrListener;
    this.#detach(undefined, fn);
    for (const type of [...this.#typed.keys()]) this.#detach(type, fn);
    this.#onChange?.();
  }

  /** Removes every listener of every type (used by `dispose`). */
  clear(): void {
    this.#typed.clear();
    this.#wildcard.clear();
    this.#size = 0;
    this.#dropSubscribers = 0;
    this.#onChange?.();
  }

  // --------------------------------------------------------------- deliver

  /**
   * Delivers one event to the listeners of its type, then to every wildcard listener.
   *
   * Returns immediately when nothing is subscribed, so the event object a caller already
   * built is simply dropped rather than inspected.
   */
  emit<K extends CacheEventType>(type: K, event: CacheEventMap<V>[K]): void;
  emit(event: CacheEvent<V>): void;
  emit(typeOrEvent: CacheEventType | CacheEvent<V>, maybeEvent?: unknown): void {
    if (this.#size === 0) return;
    const type = typeof typeOrEvent === 'string' ? typeOrEvent : typeOrEvent.type;
    const event = (typeof typeOrEvent === 'string' ? maybeEvent : typeOrEvent) as unknown;

    const typed = this.#typed.get(type);
    if (typed !== undefined) {
      for (const listener of typed) invoke(listener, event);
    }
    if (this.#wildcard.size > 0) {
      for (const listener of this.#wildcard) invoke(listener, event);
    }
  }

  // ------------------------------------------------------------- internals

  #takeSet(type: CacheEventType): Set<AnyListener> {
    let set = this.#typed.get(type);
    if (set === undefined) {
      set = new Set();
      this.#typed.set(type, set);
    }
    return set;
  }

  /**
   * Removes one listener of `type` (`undefined` = the wildcard set), keeping both counters
   * honest. Always re-resolves the set, so calling an unsubscribe twice — or after the set
   * was replaced — can never under-count.
   */
  #detach(type: CacheEventType | undefined, listener: AnyListener): void {
    const set = type === undefined ? this.#wildcard : this.#typed.get(type);
    if (set === undefined || !set.delete(listener)) return;
    this.#size -= 1;
    if (type === undefined || DROP_TYPES.has(type)) this.#dropSubscribers -= 1;
    if (type !== undefined && set.size === 0) this.#typed.delete(type);
  }
}

/** Calls one listener, isolating its failure from every other listener. */
function invoke(listener: AnyListener, event: unknown): void {
  try {
    listener(event);
  } catch (error) {
    // The mutation already happened — a bad subscriber must not abort its siblings or
    // surface out of a successful `set`.
    console.error(
      '[blaze-cache] event listener failed — the remaining listeners still run.',
      error,
    );
  }
}
