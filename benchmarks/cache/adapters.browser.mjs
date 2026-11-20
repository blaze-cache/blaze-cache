/**
 * Browser-side adapter registry. The store implementations are identical to the Node suite's
 * (see `stores.mjs`); the only difference is that blaze is left to fetch its own `.wasm` asset
 * through the default `wasmUrl`, which Vite emits and serves as a real HTTP resource. That is
 * the deployment path the browser benchmark exists to measure.
 */
import { buildRegistry } from './stores.mjs';

const registry = buildRegistry();

export const ADAPTERS = registry.ADAPTERS;
export const createAdapter = registry.createAdapter;
export const adapterLabel = registry.adapterLabel;
