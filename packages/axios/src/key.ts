import { safeStableStringify } from '@blaze-cache/core';
import type { InternalAxiosRequestConfig } from 'axios';
import { readHeader } from './headers.js';

/**
 * FNV-1a, 32-bit.
 *
 * Folds sensitive material (bearer tokens, query parameters) into a short, stable token. It
 * is not a security primitive — the point is that a persisted cache key never contains a
 * secret in readable form.
 */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** Default cache key: method + URL, plus a hash of the params and the `vary` headers. */
export function defaultCacheKey(
  config: InternalAxiosRequestConfig,
  varyHeaders: readonly string[],
): string {
  const method = (config.method ?? 'get').toLowerCase();
  const url = `${config.baseURL ?? ''}${config.url ?? ''}`;

  // `params` is stringified canonically, so `?a=1&b=2` and `?b=2&a=1` share one key.
  const params = safeStableStringify(config.params) ?? 'undefined';
  const vary = varyHeaders.map((header) => readHeader(config.headers, header) ?? '').join(' ');

  return `${method} ${url}?${fnv1a(`${params} ${vary}`)}`;
}
