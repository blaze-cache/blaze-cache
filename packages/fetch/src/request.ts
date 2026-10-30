import type { BlazeFetchEffectiveInit } from './types.js';

/**
 * Normalising a `fetch` input.
 *
 * `fetch` accepts three shapes — a URL string, a {@link URL} or a whole {@link Request} —
 * and the method/headers may live on the `Request`, on the `init` object, or on both (with
 * `init` winning). Cache keys, `Cache-Control` and every user callback work from the
 * *resolved* view instead: one absolute URL, one method, one merged header list.
 *
 * The network always receives the caller's original `input`/`init`, unchanged.
 */

/** `true` when `input` is a `Request`. Guarded, so exotic hosts without one still work. */
export function isRequest(input: RequestInfo | URL): input is Request {
  return typeof Request !== 'undefined' && input instanceof Request;
}

/**
 * Absolute URL of the request — the basis of every cache key.
 *
 * A `Request` and a `URL` are already absolute. A string is resolved against the page in a
 * browser; in Node there is no document base, so it is kept verbatim, which is still a
 * stable key as long as call sites are stable.
 */
export function resolveUrl(input: RequestInfo | URL): string {
  if (isRequest(input)) return input.url;
  const raw = input instanceof URL ? input.href : String(input);
  try {
    return new URL(raw).href;
  } catch {
    const base = globalThis.location?.href;
    return base === undefined ? raw : new URL(raw, base).href;
  }
}

/** HTTP method, upper-cased — `GET` when nothing says otherwise. */
export function resolveMethod(input: RequestInfo | URL, init: RequestInit): string {
  const explicit = init.method ?? (isRequest(input) ? input.method : undefined);
  return (explicit ?? 'GET').toUpperCase();
}

/**
 * The **effective** request: `init` as the caller passed it, with `method`, `headers` and
 * `cache` filled in from `input` when it is a `Request`.
 *
 * This is what `key`, `shouldCache`, `tags` and `ttlMs` receive — so a callback can read
 * `authorization` whether the caller set it on a `Request` or on the `init` object. It never
 * reaches the network.
 */
export function normalizeInit(
  input: RequestInfo | URL,
  init: RequestInit,
  method: string,
): BlazeFetchEffectiveInit {
  return {
    ...init,
    method,
    headers: new Headers(init.headers ?? (isRequest(input) ? input.headers : undefined)),
    cache: init.cache ?? (isRequest(input) ? input.cache : undefined),
  };
}
