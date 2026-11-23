/** Bounded, per-handle ring buffer of recent cache events. */
import { TAB_ID } from './protocol.js';
import type { DevtoolsEvent } from './types.js';

export class EventFeed {
  readonly #capacity: number;
  readonly #clientId: string;
  readonly #events: DevtoolsEvent[] = [];
  readonly #listeners = new Set<(event: DevtoolsEvent) => void>();

  constructor(clientId: string, capacity = 500) {
    this.#clientId = clientId;
    this.#capacity = Math.max(1, Math.floor(capacity));
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
    this.#events.push(event);
    if (this.#events.length > this.#capacity) this.#events.shift();
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
    return [...this.#events];
  }

  onEvent(listener: (event: DevtoolsEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  get size(): number {
    return this.#events.length;
  }

  clear(): void {
    this.#events.length = 0;
  }

  /** Drops all UI subscriptions. Called by `handle.detach()`. */
  close(): void {
    this.#listeners.clear();
    this.clear();
  }
}
