import { AxiosHeaders } from 'axios';

/** `hasOwnProperty` over an unknown source — also correct for `Object.create(null)` records. */
const hasOwn = (source: unknown, key: string): boolean =>
  source !== null &&
  source !== undefined &&
  Object.prototype.hasOwnProperty.call(source, key);

/**
 * Case-insensitive header lookup that works with both `AxiosHeaders` and plain objects.
 *
 * Adapters see `config.headers` as an `AxiosHeaders` instance, while stored responses are
 * plain objects — this normalises over both.
 */
export function readHeader(source: unknown, name: string): string | undefined {
  if (source === null || source === undefined) return undefined;

  if (source instanceof AxiosHeaders) {
    const value = source.get(name);
    return value === null || value === undefined ? undefined : String(value);
  }

  if (typeof (source as { get?: unknown }).get === 'function') {
    const value = (source as { get: (name: string) => unknown }).get(name);
    return value === null || value === undefined ? undefined : String(value);
  }

  // Own keys only: a plain `{}` answers `record.__proto__` with `Object.prototype` and
  // `record.constructor` with the constructor — neither is a header anyone sent, and
  // stringifying either would invent a value straight out of the prototype chain.
  const record = source as Record<string, unknown>;
  const exact = hasOwn(record, name) ? record[name] : undefined;
  const lower = hasOwn(record, name.toLowerCase()) ? record[name.toLowerCase()] : undefined;
  const value = exact ?? lower;
  return value === null || value === undefined ? undefined : String(value);
}

/**
 * Builds an `AxiosHeaders` from whatever axios handed us.
 *
 * The `AxiosHeaders` constructor types are narrower than what adapters actually receive
 * (`AxiosResponseHeaders` is a union that does not overlap cleanly), so the cast lives here,
 * in one documented place, instead of at every call site.
 *
 * A legal `__proto__` header name needs care on the way through: axios' `set` writes
 * headers with plain `target[key] = …` assignment, and for that one name that lands in
 * `Object.prototype.__proto__`'s accessor — a string value is silently ignored (the header
 * disappears, on the way into the store *and* on the way back out). So the name is peeled
 * off first: the source is copied (spread defines own keys — it never calls a setter), the
 * key is dropped from the copy so axios normalises every *other* header as usual, and the
 * value is then defined on the result as a plain own property — which `get`, `toJSON` and
 * plain iteration all see, without touching the instance's prototype or any global one.
 */
export function toAxiosHeaders(headers: unknown): AxiosHeaders {
  if (headers instanceof AxiosHeaders) return headers;

  const source = headers as Record<string, unknown>;
  const carriesProto = hasOwn(source, '__proto__');
  const rest = carriesProto ? { ...source } : source;
  if (carriesProto) delete (rest as Record<string, unknown>)['__proto__'];

  const target = AxiosHeaders.from(rest as Record<string, string>);
  if (carriesProto) {
    Object.defineProperty(target, '__proto__', {
      value: source['__proto__'],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return target;
}

/**
 * Copies headers into a plain object suitable for storage.
 *
 * The spread defines own keys — a stored `__proto__` header included (its repair happens in
 * {@link toAxiosHeaders}), and no setter runs on the way.
 */
export function toPlainHeaders(headers: unknown): Record<string, unknown> {
  return { ...toAxiosHeaders(headers) };
}
