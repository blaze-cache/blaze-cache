/** Bounded, per-handle ring buffer of recent cache events. */
import { TAB_ID } from './protocol.js';
import type { DevtoolsEvent } from './types.js';

/** A UI feed never needs more than this many events, however large `maxEvents` is. */
const MAX_CAPACITY = 100_000;

export class EventFeed {
  readonly #capacity: number;
  readonly #clientId: string;
  /** Fixed ring: `head` is the oldest slot, `size` is the live count. */
  readonly #buffer: Array<DevtoolsEvent | undefined>;
  #head = 0;
  #size = 0;
  readonly #listeners = new Set<(event: DevtoolsEvent) => void>();

  constructor(clientId: string, capacity = 500) {
    this.#clientId = clientId;
    // A fixed allocation replaces `Array.shift()`: appending to a saturated feed is O(1)
    // instead of moving every stored event down by one slot. Hostile sizes cannot throw.
    const requested = Number.isFinite(capacity) ? Math.floor(capacity) : 500;
    this.#capacity = Math.max(1, Math.min(requested, MAX_CAPACITY));
    this.#buffer = new Array<DevtoolsEvent | undefined>(this.#capacity);
  }

  /** Appends one event, evicting the oldest when full. Never stores a live value. */
  push(type: string, key?: string): DevtoolsEvent {
    const event: DevtoolsEvent = {
      type,
      ...(key === undefined ? {} : { key }),
      ts: Date.now(),
      tabId: TAB_ID,
      clientId: this.#clientId,
    };
    this.#buffer[(this.#head + this.#size) % this.#capacity] = event;
    if (this.#size === this.#capacity) this.#head = (this.#head + 1) % this.#capacity;
    else this.#size += 1;
    for (const listener of [...this.#listeners]) {
      if (!this.#listeners.has(listener)) continue;
      try {
        listener(event);
      } catch {
        // A UI consumer must never break the host app's mutation path.
      }
    }
    return event;
  }

  /** Oldest-first copy. */
  events(): readonly DevtoolsEvent[] {
    const out: DevtoolsEvent[] = new Array<DevtoolsEvent>(this.#size);
    for (let i = 0; i < this.#size; i += 1) {
      out[i] = this.#buffer[(this.#head + i) % this.#capacity]!;
    }
    return out;
  }

  onEvent(listener: (event: DevtoolsEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  get size(): number {
    return this.#size;
  }

  clear(): void {
    // Drop the event references too: a detached handle must not pin old payloads.
    for (let i = 0; i < this.#size; i += 1) {
      this.#buffer[(this.#head + i) % this.#capacity] = undefined;
    }
    this.#head = 0;
    this.#size = 0;
  }

  /** Drops all UI subscriptions. Called by `handle.detach()`. */
  close(): void {
    this.#listeners.clear();
    this.clear();
  }
}
