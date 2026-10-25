//! wasm-bindgen bindings for [`blaze-cache-core`].
//!
//! The exported [`BlazeCache`] class is what `@blaze-cache/core` drives from TypeScript.
//! Design notes:
//!
//! * **Keys are `String`, values are `JsValue`** — JS objects are passed by reference and are
//!   *never* cloned or serialised on the hot path, which keeps `get`/`set` allocation-free.
//! * **TTLs are milliseconds on the boundary** (`Option<f64>`) but stay monotonic
//!   [`Instant`](web_time::Instant) deadlines inside the core, so a system clock adjustment
//!   cannot silently extend or truncate an entry's life.
//! * **Bulk operations return `Vec<String>`** (`invalidate_tags`, `prune`) so the host knows
//!   exactly which keys disappeared — that is what keeps IndexedDB in sync.
#![allow(clippy::unused_unit)]

use std::time::Duration;

use blaze_cache_core::{Cache, EntryOptions};
use wasm_bindgen::prelude::*;

/// A JavaScript-visible Blaze Cache.
#[wasm_bindgen]
pub struct BlazeCache {
    inner: Cache<String, JsValue>,
}

#[wasm_bindgen]
impl BlazeCache {
    /// Creates a cache that holds at most `capacity` entries (clamped to `>= 1`).
    #[wasm_bindgen(constructor)]
    pub fn new(capacity: usize) -> BlazeCache {
        BlazeCache {
            inner: Cache::new(capacity),
        }
    }

    /// Returns the value stored under `key`, or `undefined` when it is missing/expired.
    ///
    /// A hit marks the entry *visited* for SIEVE, so this takes `&mut self`.
    #[wasm_bindgen(js_name = get)]
    pub fn get(&mut self, key: &str) -> Option<JsValue> {
        self.inner.get(key).cloned()
    }

    /// Same lookup as [`get`](Self::get) — **without** recording a hit or a miss, and without
    /// marking the entry visited for SIEVE.
    ///
    /// The read for "is this here?" questions: it leaves the hit rate and the eviction order
    /// exactly as it found them, and it never reclaims an expired entry.
    #[wasm_bindgen(js_name = peek)]
    pub fn peek(&self, key: &str) -> Option<JsValue> {
        self.inner.peek(key).cloned()
    }

    /// Milliseconds until `key` expires, or `undefined` when it carries no TTL or the key is
    /// missing/expired. Purely observational: statistics and eviction state are untouched.
    #[wasm_bindgen(js_name = ttl)]
    pub fn ttl(&self, key: &str) -> Option<f64> {
        self.inner
            .ttl(key)
            .flatten()
            .map(|ttl| ttl.as_millis() as f64)
    }

    /// Stores `value` under `key`.
    ///
    /// * `ttlMs` — milliseconds until expiry. `undefined`, `null`, `0` and negatives all mean
    ///   "no expiry".
    /// * `tags` — tag names for bulk invalidation via [`invalidate_tags`](Self::invalidate_tags).
    ///
    /// Replacing a key refreshes its TTL **and** its tags, and re-queues it as the newest
    /// entry. Capacity pressure is applied before the new node becomes visible, so a write
    /// can never evict itself.
    #[wasm_bindgen(js_name = set)]
    pub fn set(&mut self, key: &str, value: JsValue, ttl_ms: Option<f64>, tags: Vec<String>) {
        let mut options = EntryOptions::new().tags(tags);
        if let Some(ms) = ttl_ms {
            if ms.is_finite() && ms > 0.0 {
                options = options.ttl(Duration::from_millis(ms as u64));
            }
        }
        self.inner.insert_with(key.to_owned(), value, options);
    }

    /// Marks `key` as recently used for eviction and optionally renews its TTL — the stored
    /// value is never changed. Returns `false` when the key is missing or expired.
    ///
    /// * `ttlMs` — `undefined`/`null` leaves the current deadline alone; a positive finite
    ///   number replaces it with "now + ttlMs"; `0`, negatives and `NaN` drop the deadline
    ///   (never expires), the same reading [`set`](Self::set) gives them.
    #[wasm_bindgen(js_name = touch)]
    pub fn touch(&mut self, key: &str, ttl_ms: Option<f64>) -> bool {
        let ttl = ttl_ms.map(|ms| {
            if ms.is_finite() && ms > 0.0 {
                Duration::from_millis(ms as u64)
            } else {
                Duration::ZERO
            }
        });
        self.inner.touch(key, ttl)
    }

    /// `true` when `key` is present and not expired. Does not affect eviction state.
    #[wasm_bindgen(js_name = has)]
    pub fn has(&self, key: &str) -> bool {
        self.inner.contains_key(key)
    }

    /// Removes `key`, returning whether it was there.
    #[wasm_bindgen(js_name = delete)]
    pub fn delete(&mut self, key: &str) -> bool {
        self.inner.remove(key).is_some()
    }

    /// Full view of one key — value, remaining TTL (ms) and tags — or `undefined` when the key
    /// is missing or expired. Does not affect statistics or eviction state.
    #[wasm_bindgen(js_name = entry)]
    pub fn entry(&self, key: &str) -> JsValue {
        match self.inner.entry(key) {
            Some(entry) => entry_object(
                entry.key,
                entry.value.clone(),
                entry.meta.ttl_remaining,
                &entry.meta.tags,
            )
            .into(),
            None => JsValue::UNDEFINED,
        }
    }

    /// Tags currently attached to `key` (empty array when the key is unknown).
    #[wasm_bindgen(js_name = tagsOf)]
    pub fn tags_of(&self, key: &str) -> Vec<String> {
        self.inner.tags_of(key).unwrap_or_default()
    }

    /// `true` when `key` carries `tag`.
    #[wasm_bindgen(js_name = hasTag)]
    pub fn has_tag(&self, key: &str, tag: &str) -> bool {
        self.inner.has_tag(key, tag)
    }

    /// Every live key, oldest first. Expired-but-unpruned entries are skipped.
    #[wasm_bindgen(js_name = keys)]
    pub fn keys(&self) -> Vec<String> {
        self.inner.keys().cloned().collect()
    }

    /// Every live key carrying `tag`.
    #[wasm_bindgen(js_name = keysWithTag)]
    pub fn keys_with_tag(&self, tag: &str) -> Vec<String> {
        self.inner.keys_with_tag(tag).into_iter().cloned().collect()
    }

    /// Full snapshot — `{ key, value, ttlMs, tags }` for every live entry, oldest first.
    ///
    /// This is what persistence layers hydrate from; it crosses the WASM boundary exactly
    /// once instead of once per key.
    #[wasm_bindgen(js_name = entries)]
    pub fn entries(&self) -> js_sys::Array {
        let out = js_sys::Array::new();
        for entry in self.inner.entries() {
            out.push(&entry_object(
                entry.key,
                entry.value.clone(),
                entry.meta.ttl_remaining,
                &entry.meta.tags,
            ));
        }
        out
    }

    /// Removes every entry carrying any of `tags`, returning the removed keys so the host can
    /// drop them from its persistence layer.
    #[wasm_bindgen(js_name = invalidateTags)]
    pub fn invalidate_tags(&mut self, tags: Vec<String>) -> Vec<String> {
        self.inner.invalidate_tags(tags).into_iter().collect()
    }

    /// Removes every expired entry, returning the removed keys.
    #[wasm_bindgen(js_name = prune)]
    pub fn prune(&mut self) -> Vec<String> {
        self.inner.prune().into_iter().collect()
    }

    /// Empties the cache.
    #[wasm_bindgen(js_name = clear)]
    pub fn clear(&mut self) {
        self.inner.clear();
    }

    /// Counters: `{ hits, misses, evictions, expirations, invalidations, size, capacity }`.
    #[wasm_bindgen(js_name = stats)]
    pub fn stats(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.inner.stats()).map_err(|err| {
            JsValue::from_str(&format!("blaze-cache: failed to serialise stats: {err}"))
        })
    }

    /// Zeroes the cumulative counters. Stored entries are untouched.
    #[wasm_bindgen(js_name = resetStats)]
    pub fn reset_stats(&mut self) {
        self.inner.reset_stats();
    }

    /// Number of stored entries that are present **and** not expired — expired-but-unpruned
    /// slots are not counted, so this always matches what `keys()`/`entries()` return.
    ///
    /// `O(1)` when no entry carries a TTL, otherwise a single oldest-first walk.
    #[wasm_bindgen(js_name = size)]
    pub fn size(&self) -> usize {
        self.inner.live_len()
    }

    /// Maximum number of entries — the `capacity` passed to `createCache`.
    #[wasm_bindgen(js_name = capacity)]
    pub fn capacity(&self) -> usize {
        self.inner.capacity()
    }
}

/// Installs a panic hook that forwards Rust panics to `console.error`, making debugging in
/// devtools far less painful. Safe to call more than once.
#[wasm_bindgen(js_name = setPanicHook)]
pub fn set_panic_hook() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

fn set_field(target: &js_sys::Object, key: &str, value: &JsValue) {
    // Reflect::set only fails for non-extensible targets, which a fresh Object never is.
    let _ = js_sys::Reflect::set(target, &JsValue::from_str(key), value);
}

fn ttl_ms(ttl: Option<Duration>) -> JsValue {
    match ttl {
        Some(ttl) => JsValue::from_f64(ttl.as_millis() as f64),
        None => JsValue::NULL,
    }
}

/// `{ key, value, ttlMs, tags }` — the shape both `entry()` and `entries()` hand to JS.
fn entry_object(
    key: &str,
    value: JsValue,
    ttl: Option<Duration>,
    tags: &[String],
) -> js_sys::Object {
    let tag_array = js_sys::Array::new();
    for tag in tags {
        tag_array.push(&JsValue::from_str(tag));
    }
    let obj = js_sys::Object::new();
    set_field(&obj, "key", &JsValue::from_str(key));
    set_field(&obj, "value", &value);
    set_field(&obj, "ttlMs", &ttl_ms(ttl));
    set_field(&obj, "tags", &tag_array);
    obj
}

/// Bindings tests, compiled only for `wasm32` test builds — `pnpm test:wasm` runs them in
/// Node, while host `cargo test` skips the module entirely.
#[cfg(all(test, target_arch = "wasm32"))]
mod tests;
