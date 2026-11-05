# Cross-integration tests

Every `@blaze-cache/*` integration is built to plug into **one shared cache instance**:

```ts
const cache = await createCache({ capacity: 1000, persistence: { namespace: 'app' } });

installBlazeCache(api, { cache });            // @blaze-cache/axios
const fetch = createBlazeFetch(cache);        // @blaze-cache/fetch
const kyApi = createBlazeKy(cache);           // @blaze-cache/ky
const queryClient = createBlazeQueryClient({ cache });  // @blaze-cache/react-query
const swr = (key, fn, opts) => useBlazeSWR(cache, key, fn, opts); // @blaze-cache/swr
```

This suite is the only place that exercises **that** scenario: five integrations,
one store, checking where they stay out of each other's way and where they don't.

| What | Expectation |
| --- | --- |
| Default cache keys | never collide across integrations (each format is disjoint) |
| Writes | coexist — every integration reads back its own value shape |
| Default tags (`axios` / `fetch` / `ky` / `react-query` / `swr`) | isolate: purging one leaves the others |
| Caller domain tags (`'todos'`, …) on `cache.invalidateTags` | **shared** — the core's tag index is one namespace, so a direct purge reaches every integration's tagged entries (by design, documented) |
| `invalidateBlazeQueries({ tags })` / `removeBlazeQueries()` | purged entries are selected by record *shape* + tag, so other integrations' entries survive even when they share the tag |
| Forced key collision (custom keys) | every integration treats a foreign value as a miss: axios and ky never serve nor delete it; react-query and SWR never seed it to the UI |
| Capacity / stats / events | one shared pool by design — sizing and read discipline matter |

This suite earned its keep: it found six cross-integration conflicts — the unfiltered and
tag-based purge helpers reaching every entry, axios deleting foreign values on a read and
tagging the raw url, and axios/fetch/SWR/react-query misreading or destroying each
other's values under a forced key collision. All six were fixed in their packages; each
now has a positive assertion here, so a regression fails the suite immediately.

## Testing

```sh
pnpm --filter @blaze-cache/integration-tests test        # offline — after pnpm build:wasm && pnpm build
pnpm --filter @blaze-cache/integration-tests test:live   # live — after a workspace build (same prerequisite)
```

The offline suite pins the isolation contract with canned adapters. The live suite (4
tests) drives the same five integrations against `api.github.com` on one shared cache,
proving every integration's marker works against a real response, a second read replays
without a single network call, `fetch` and `ky` genuinely share one entry for identical
request identity, and a default-tag purge removes exactly that integration's entry.
`test:live` does not build the workspace — the build comes first, as with the offline
suite. Every live test is skipped unless `BLAZE_CACHE_LIVE=1` is set, so the default
suite always runs offline.
