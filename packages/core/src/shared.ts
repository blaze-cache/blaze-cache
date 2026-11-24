/**
 * The wasm-free, server-safe contract shared by Blaze Cache bindings, devtools and
 * snapshot bridges.
 *
 * This module deliberately imports nothing from `./cache.js`, `./wasm.js` or any other
 * module that touches WebAssembly, IndexedDB or the DOM. It is safe to import from a
 * Node server, a server-rendering bundle, or a snapshot serialiser. Its shapes are
 * **frozen here in 0.5.0-beta.1**: later releases import them rather than redefining
 * them, so a devtools summary and a binding write can never drift apart.
 *
 * @packageDocumentation
 */

/**
 * Default key patterns that mark a cache entry as sensitive. Keys are matched
 * case-insensitively against the whole key; a match means "never display this value".
 *
 * These live here — not in devtools — so server snapshots and framework bindings can
 * apply the same deny-by-default policy without importing the browser runtime.
 */
export const REDACT_KEY_PATTERNS: readonly RegExp[] = Object.freeze([
  /authorization/i,
  /token/i,
  /cookie/i,
  /credential/i,
  /password/i,
  /passwd/i,
  /secret/i,
  /api[-_]?key/i,
  /session/i,
]);

/** `true` when `key` matches any of `patterns` (defaults to {@link REDACT_KEY_PATTERNS}). */
export function isRedactedKey(
  key: string,
  patterns: readonly RegExp[] = REDACT_KEY_PATTERNS,
): boolean {
  for (let i = 0; i < patterns.length; i += 1) {
    const pattern = patterns[i]!;
    try {
      // A pattern with the global/sticky flag is stateful; reset before testing so a
      // caller-supplied pattern cannot make redaction alternate between calls. A frozen
      // pattern rejects the write — harmless for a non-stateful one, whose `test` never
      // reads `lastIndex`, so it must keep working rather than over-redact everything.
      try {
        pattern.lastIndex = 0;
      } catch {
        // Frozen: fall through and let `test` decide.
      }
      if (pattern.test(key)) return true;
    } catch {
      // Deny by default: a pattern that cannot be evaluated — a frozen *global* one (its
      // `test` rewrites the frozen `lastIndex`), a hostile `test`, a non-regexp entry —
      // must neither throw into the host nor silently disable redaction.
      return true;
    }
  }
  return false;
}

/** Replaces a sensitive key with an opaque marker. */
export function redactKey(
  key: string,
  patterns: readonly RegExp[] = REDACT_KEY_PATTERNS,
  replacement = '[redacted]',
): string {
  return isRedactedKey(key, patterns) ? replacement : key;
}

/**
 * The record envelope written by framework bindings. `kind` follows the
 * `<binding>:<feature>` convention (e.g. `next:route`); `v` is the envelope version,
 * guard-tested as *any finite number* so older and newer records stay recognisable.
 */
export interface BlazeRecord<V = unknown> {
  kind: string;
  v: number;
  data: V;
  /** `Date.now()` at write time, used by restore logic to break ties. */
  storedAt: number;
}

/**
 * Duck-typed, version-tolerant guard for {@link BlazeRecord}. It deliberately does not
 * inspect `data` (which may be any value) and does not require a specific `v`, so a
 * record written by a future binding is still recognised and summarised as a record
 * instead of being expanded into the devtools UI.
 */
export function isBlazeRecord(value: unknown): value is BlazeRecord<unknown> {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.kind === 'string' &&
    record.kind.length > 0 &&
    typeof record.v === 'number' &&
    Number.isFinite(record.v) &&
    typeof record.storedAt === 'number' &&
    Number.isFinite(record.storedAt) &&
    Object.prototype.hasOwnProperty.call(record, 'data')
  );
}

/** The separator in the `<binding>:<feature>` kind convention. */
export const KIND_SEPARATOR = ':';

/** Builds a namespaced kind (e.g. `makeBlazeKind('next', 'route')` → `next:route`). */
export function makeBlazeKind(binding: string, feature: string): string {
  return `${binding}${KIND_SEPARATOR}${feature}`;
}

/** The framework prefix of a kind, or `undefined` when it does not follow the convention. */
export function bindingFromKind(kind: string): string | undefined {
  const index = kind.indexOf(KIND_SEPARATOR);
  if (index <= 0 || index === kind.length - 1) return undefined;
  return kind.slice(0, index);
}

/** The feature suffix of a kind, or `undefined` when it does not follow the convention. */
export function featureFromKind(kind: string): string | undefined {
  const index = kind.indexOf(KIND_SEPARATOR);
  if (index <= 0 || index === kind.length - 1) return undefined;
  return kind.slice(index + 1);
}
