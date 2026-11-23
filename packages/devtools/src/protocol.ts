/**
 * Versioned wire protocol shared by every devtools transport (in-page today, a future
 * browser extension tomorrow). Unknown versions and unknown kinds are ignored, never
 * thrown — see {@link isSupportedEnvelope}.
 */

/** Bump only when the envelope shape changes incompatibly. */
export const DEVTOOLS_PROTOCOL = 1 as const;

/** The three message directions. A transport may carry all three. */
export type DevtoolsKind = 'snapshot' | 'event' | 'action';

let idCounter = 0;

/** One tab-level identity, generated once per loaded module. */
export const TAB_ID = makeId('tab');

/** Opaque, collision-resistant id with a readable prefix. */
export function makeId(prefix: string): string {
  idCounter += 1;
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}-${idCounter}`;
}

/** The envelope every devtools message uses. */
export interface DevtoolsEnvelope<P = unknown> {
  protocol: typeof DEVTOOLS_PROTOCOL;
  /** Tab the message originated in. */
  tabId: string;
  /** Cache-instance handle that produced it. */
  clientId: string;
  /** Stable id of the observed cache instance. */
  cacheId: string;
  /** `Date.now()` at creation. */
  ts: number;
  kind: DevtoolsKind;
  payload: P;
}

/** Creates an envelope, stamping the current time and this tab's id. */
export function createEnvelope<P>(
  clientId: string,
  cacheId: string,
  kind: DevtoolsKind,
  payload: P,
  tabId = TAB_ID,
  ts = Date.now(),
): DevtoolsEnvelope<P> {
  return { protocol: DEVTOOLS_PROTOCOL, tabId, clientId, cacheId, ts, kind, payload };
}

/**
 * Structural check used at transport boundaries. Deliberately accepts any object with the
 * right fields so a newer build's extra properties do not trip it; version compatibility is
 * a separate, explicit check.
 */
export function isDevtoolsEnvelope(value: unknown): value is DevtoolsEnvelope {
  if (value === null || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    typeof message.protocol === 'number' &&
    typeof message.tabId === 'string' &&
    typeof message.clientId === 'string' &&
    typeof message.cacheId === 'string' &&
    typeof message.ts === 'number' &&
    typeof message.kind === 'string' &&
    'payload' in message
  );
}

/** `true` only for messages this build can interpret; others degrade to "ignored". */
export function isSupportedEnvelope(value: unknown): value is DevtoolsEnvelope {
  if (!isDevtoolsEnvelope(value)) return false;
  return (
    value.protocol === DEVTOOLS_PROTOCOL &&
    (value.kind === 'snapshot' || value.kind === 'event' || value.kind === 'action')
  );
}
