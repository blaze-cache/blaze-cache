import { createCache } from '@blaze-cache/core';
import type { BlazeCache } from '@blaze-cache/core';
import { installBlazeCache } from '@blaze-cache/axios';
import { createBlazeQueryClient } from '@blaze-cache/react-query';
import axios from 'axios';
import wasmUrl from '@blaze-cache/core/pkg/blaze_cache_wasm_bg.wasm?url';

/**
 * One cache, two integrations.
 *
 * The wasm binary is passed explicitly with a bundler URL import — that keeps the path
 * correct after dependency pre-bundling, which is where `import.meta.url` relative paths
 * usually break. Omitting `wasm` works too when the package is not pre-bundled.
 */
export const cache: BlazeCache = await createCache({
  capacity: 500,
  persistence: { namespace: 'blaze-example', flushDelayMs: 250 },
  wasm: wasmUrl,
});

/** Axios with the Blaze adapter installed. GET responses stay fresh for 15 seconds. */
export const api = axios.create({ baseURL: '/' });
installBlazeCache(api, {
  cache,
  ttlMs: 15_000,
  tags: (response) => ['todos', `status:${response.status}`],
});

/** TanStack Query client mirroring every successful query into the same cache. */
export const queryClient = createBlazeQueryClient({ cache, ttlMs: 24 * 60 * 60_000 });
