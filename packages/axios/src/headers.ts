import { AxiosHeaders } from 'axios';

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

  const record = source as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()];
  return value === null || value === undefined ? undefined : String(value);
}

/**
 * Builds an `AxiosHeaders` from whatever axios handed us.
 *
 * The `AxiosHeaders` constructor types are narrower than what adapters actually receive
 * (`AxiosResponseHeaders` is a union that does not overlap cleanly), so the cast lives here,
 * in one documented place, instead of at every call site.
 */
export function toAxiosHeaders(headers: unknown): AxiosHeaders {
  if (headers instanceof AxiosHeaders) return headers;
  return AxiosHeaders.from(headers as Record<string, string>);
}

/** Copies headers into a plain object suitable for storage. */
export function toPlainHeaders(headers: unknown): Record<string, unknown> {
  return { ...toAxiosHeaders(headers) };
}
