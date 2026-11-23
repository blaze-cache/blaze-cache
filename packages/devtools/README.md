<p align="center">
  <img src="https://raw.githubusercontent.com/blaze-cache/blaze-cache/main/docs/assets/blaze-cache-logo.png" alt="Blaze Cache logo" width="150">
</p>

<h1 align="center">@blaze-cache/devtools</h1>

Zero-cost-by-default observability for Blaze Cache: attach to a cache instance, inspect a
bounded snapshot, and follow a live event feed — without instrumenting application code.

## Install

```sh
npm install @blaze-cache/devtools @blaze-cache/core
```

## Quick start

```ts
import { createCache } from '@blaze-cache/core';
import { attach, onEvent } from '@blaze-cache/devtools';

const cache = await createCache({ indexes: true });
const handle = attach(cache, { label: 'HTTP responses' });

console.log(handle.snapshot().payload.entries); // bounded, summarized rows
const off = onEvent((event) => console.log(event.type, event.key));

// …later
off();
handle.detach(); // restores the core's drop-log state exactly
```

`@blaze-cache/devtools-react` (0.5.0-beta.2) adds the in-app panel on top of this package.

## What it guarantees

- **Zero cost when detached:** importing the package registers no listeners, snapshots or
  timers. Only `attach()` subscribes, and `detach()`/`dispose()` removes the listener.
- **Live values never leak:** `entry()`/`entries()` return by-reference values, so every
  value is summarized through a bounded, cycle-safe summarizer. `blaze-record` envelopes
  are shown as `kind`/`v`, never expanded.
- **Redaction by default:** keys matching the frozen patterns from
  `@blaze-cache/core/shared` (`authorization`, `token`, `cookie`, …) render as `[redacted]`.
  `valueMode: 'full'` is an explicit opt-in and still returns a clone, not the live object.
- **Bounded reads:** snapshots use the indexed `query()` API with `maxEntries`/
  `maxValueBytes` caps and explicit truncation markers, falling back to a bounded full
  scan on caches created without `indexes: true`.

## API

| Export                                                          | Purpose                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------- |
| `attach(cache, { label? })`                                     | Registers one handle; returns a `DevtoolsHandle`.             |
| `detach(handle \| cache)`                                       | Removes handle(s) and their listeners.                        |
| `list()` / `dispose()`                                          | Inspect live attachments / tear them all down.                |
| `handle.snapshot(options?)`                                     | Builds a versioned `snapshot` envelope on demand.             |
| `handle.events()` / `onEvent(listener)`                         | Ring buffer (default 500) and subscriptions.                  |
| `summarize(value, options?)`                                    | Clone-or-describe any value; never throws.                    |
| `createEnvelope` / `isDevtoolsEnvelope` / `isSupportedEnvelope` | Versioned protocol (`protocol: 1`).                           |
| `isBlazeRecord`, `REDACT_KEY_PATTERNS`, …                       | Re-exports of the frozen `@blaze-cache/core/shared` contract. |
