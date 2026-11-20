/**
 * The payload-size matrix.
 *
 * Values are stored **by reference** in blaze (and in every rival here), so the size of a
 * value must never be confused with work done on the hot path: the same handful of payload
 * objects is handed out for every key and reused across batches. What the matrix isolates is
 * therefore the cost of the *boundary crossing and bookkeeping* for a given working-set size,
 * not the cost of constructing a 1 MB object on every `set` — that would measure the generator,
 * not the cache.
 *
 * Two representations are measured for every size:
 *
 *  * `object` — a structured-cloneable `{ id, payload, label }` record, the shape application
 *    code actually caches;
 *  * `bytes`  — a `Uint8Array`, the shape that would benefit most from a future zero-copy path.
 *
 * Both are deterministic (same bytes for the same slot on every run) so the deep-equality
 * probe check in `runner.mjs` stays meaningful across adapters and across sizes.
 */

/** Named sizes, in bytes. `tiny` is deliberately at the roadmap's ≤64 B ceiling. */
export const PAYLOAD_SIZES = Object.freeze({
  tiny: 64,
  small: 1024,
  medium: 10 * 1024,
  large: 100 * 1024,
  massive: 1024 * 1024,
});

/** The two value representations measured at every size. */
export const PAYLOAD_KINDS = Object.freeze(['object', 'bytes']);

export const DEFAULT_PAYLOAD = 'small';
export const DEFAULT_PAYLOAD_KIND = 'object';

/**
 * How many distinct values are built per run. Large enough that reads are not all the same
 * reference; small enough that a `massive/bytes` run costs ~16 MB, not ~16 GB.
 */
const POOL_SIZE = 16;

function makeObjectValue(id, bytes) {
  // Keep the overhead small and constant so `bytes` really is the dominant term. The suffix
  // makes every pooled value distinct without allocating a second large string.
  const suffix = id.toString(36).padStart(4, '0').slice(-4);
  const pad = Math.max(0, bytes - 24);
  return { id, payload: 'x'.repeat(pad) + suffix, label: `value:${id}` };
}

function makeBytesValue(id, bytes) {
  const value = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 1) value[i] = (i + id * 31) & 0xff;
  return value;
}

/**
 * Builds a value factory for one cell of the payload matrix.
 *
 * @param {object} [options]
 * @param {keyof PAYLOAD_SIZES} [options.payload]
 * @param {'object'|'bytes'} [options.payloadKind]
 * @returns {{payload: string, kind: string, bytes: number, label: string,
 *   valueFor: (index: number) => unknown, pool: unknown[]}}
 */
export function createValueFactory({
  payload = DEFAULT_PAYLOAD,
  payloadKind = DEFAULT_PAYLOAD_KIND,
} = {}) {
  if (!Object.hasOwn(PAYLOAD_SIZES, payload)) {
    throw new Error(
      `unknown payload "${payload}" (expected one of ${Object.keys(PAYLOAD_SIZES).join(', ')})`,
    );
  }
  if (!PAYLOAD_KINDS.includes(payloadKind)) {
    throw new Error(
      `unknown payload kind "${payloadKind}" (expected ${PAYLOAD_KINDS.join(' or ')})`,
    );
  }

  const bytes = PAYLOAD_SIZES[payload];
  const make = payloadKind === 'bytes' ? makeBytesValue : makeObjectValue;
  const pool = Array.from({ length: POOL_SIZE }, (_, id) => make(id, bytes));

  return {
    payload,
    kind: payloadKind,
    bytes,
    label: `${payload}/${payloadKind}`,
    pool,
    /** The pooled value for `index` — stable for the whole run, never cloned. */
    valueFor: (index) => pool[Math.abs(index) % POOL_SIZE],
  };
}
