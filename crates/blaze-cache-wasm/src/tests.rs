//! `#[wasm_bindgen_test]` suite for the bindings.
//!
//! Declared behind `#[cfg(all(test, target_arch = "wasm32"))]` in `lib.rs`, so host
//! `cargo test` never compiles it while `pnpm test:wasm` runs it in Node.
//!
//! What this covers that the 23 host-side tests cannot: everything that actually crosses
//! the wasm boundary — `Option` ↔ `undefined`/`null`, `Vec<String>` ↔ `Array`, the
//! `{ key, value, ttlMs, tags }` object shape built with `Reflect`, and the serialised
//! stats object — through the real wasm-bindgen glue.

use js_sys::Array;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_test::wasm_bindgen_test;

use crate::BlazeCache;

/// Reads `target[key]`, failing if the property is absent — a renamed field must break the
/// test rather than slip through as `undefined`.
fn field(target: &JsValue, key: &str) -> JsValue {
    let value = js_sys::Reflect::get(target, &JsValue::from_str(key))
        .unwrap_or_else(|_| panic!("property `{key}` could not be read"));
    assert!(!value.is_undefined(), "property `{key}` is missing");
    value
}

fn number(stats: &JsValue, key: &str) -> f64 {
    field(stats, key)
        .as_f64()
        .unwrap_or_else(|| panic!("`{key}` should be a number"))
}

#[wasm_bindgen_test]
fn round_trips_values_and_presence() {
    let mut cache = BlazeCache::new(8);

    cache.set("str", JsValue::from_str("hello"), None, vec![]);
    cache.set("num", JsValue::from_f64(42.0), None, vec![]);

    assert_eq!(
        cache
            .get("str")
            .and_then(|value| value.as_string())
            .as_deref(),
        Some("hello")
    );
    assert_eq!(
        cache.get("num").and_then(|value| value.as_f64()),
        Some(42.0)
    );
    assert!(cache.has("str"));
    assert_eq!(cache.size(), 2);
    assert_eq!(cache.capacity(), 8);

    assert!(cache.delete("str"));
    assert!(!cache.delete("str"), "the second delete must report absent");
    assert_eq!(
        cache.get("str"),
        None,
        "missing key serialises as undefined"
    );
    assert!(!cache.has("str"));
}

#[wasm_bindgen_test]
fn stats_cross_the_boundary_as_a_plain_object() {
    let mut cache = BlazeCache::new(4);

    cache.set("a", JsValue::NULL, None, vec![]);
    let _hit = cache.get("a");
    let _miss = cache.get("missing");

    let stats = cache.stats().expect("stats must serialise");
    assert_eq!(number(&stats, "hits"), 1.0);
    assert_eq!(number(&stats, "misses"), 1.0);
    assert_eq!(number(&stats, "size"), 1.0);
    assert_eq!(number(&stats, "capacity"), 4.0);
    assert_eq!(number(&stats, "evictions"), 0.0);
}

#[wasm_bindgen_test]
fn entry_objects_carry_key_value_ttl_and_tags() {
    let mut cache = BlazeCache::new(4);
    cache.set(
        "user:1",
        JsValue::from_str("Ada"),
        Some(30_000.0),
        vec!["profile".to_string(), "vip".to_string()],
    );

    let entry = cache.entry("user:1");
    assert!(!entry.is_undefined());
    assert_eq!(field(&entry, "key").as_string().as_deref(), Some("user:1"));
    assert_eq!(field(&entry, "value").as_string().as_deref(), Some("Ada"));

    let ttl = field(&entry, "ttlMs")
        .as_f64()
        .expect("`ttlMs` must be a number when a TTL is set");
    assert!(
        (0.0..=30_000.0).contains(&ttl),
        "remaining TTL should sit in (0, 30000], got {ttl}"
    );

    let tags: Array = field(&entry, "tags").unchecked_into();
    assert_eq!(tags.length(), 2);
    assert_eq!(tags.get(0).as_string().as_deref(), Some("profile"));

    let entries = cache.entries();
    assert_eq!(entries.length(), 1, "one live entry in the snapshot");

    assert!(
        cache.entry("absent").is_undefined(),
        "a missing key serialises as undefined"
    );
}

#[wasm_bindgen_test]
fn zero_and_negative_ttl_mean_no_expiry() {
    let mut cache = BlazeCache::new(4);
    cache.set("zero", JsValue::UNDEFINED, Some(0.0), vec![]);
    cache.set("negative", JsValue::UNDEFINED, Some(-5.0), vec![]);
    cache.set(
        "not-a-number",
        JsValue::UNDEFINED,
        Some(f64::INFINITY),
        vec![],
    );

    assert!(
        field(&cache.entry("zero"), "ttlMs").is_null(),
        "no TTL → null"
    );
    assert!(cache.has("zero"), "zero TTL must not expire");
    assert!(cache.has("negative"));
    assert!(
        cache.has("not-a-number"),
        "non-finite TTL falls back to no expiry"
    );
}

#[wasm_bindgen_test]
fn tag_invalidation_returns_removed_keys() {
    let mut cache = BlazeCache::new(8);
    cache.set("u1", JsValue::NULL, None, vec!["user:1".to_string()]);
    cache.set(
        "u2",
        JsValue::NULL,
        None,
        vec!["user:2".to_string(), "vip".to_string()],
    );
    cache.set("page", JsValue::NULL, None, vec!["public".to_string()]);

    assert!(cache.has_tag("u2", "vip"));
    assert!(!cache.has_tag("u1", "vip"));
    assert_eq!(cache.keys_with_tag("vip"), vec!["u2".to_string()]);

    let mut removed = cache.invalidate_tags(vec!["vip".to_string(), "public".to_string()]);
    removed.sort();
    assert_eq!(removed, vec!["page".to_string(), "u2".to_string()]);
    assert_eq!(cache.size(), 1);
    assert_eq!(cache.tags_of("u2").len(), 0, "removed keys keep no tags");
}

#[wasm_bindgen_test]
fn eviction_protects_entries_read_since_the_last_pass() {
    let mut cache = BlazeCache::new(2);
    cache.set("a", JsValue::NULL, None, vec![]);
    cache.set("b", JsValue::NULL, None, vec![]);
    let _protected = cache.get("a"); // mark "a" visited for SIEVE
    cache.set("c", JsValue::NULL, None, vec![]); // forces an eviction

    assert_eq!(cache.size(), 2);
    assert!(cache.has("a"), "the visited entry survives");
    assert!(!cache.has("b"), "the oldest unvisited entry is evicted");
    assert!(cache.has("c"), "a write must never evict itself");

    let stats = cache.stats().expect("stats must serialise");
    assert_eq!(number(&stats, "evictions"), 1.0);
}

#[wasm_bindgen_test]
fn clear_and_reset_stats_behave_independently() {
    let mut cache = BlazeCache::new(4);
    cache.set("a", JsValue::NULL, None, vec![]);
    let _hit = cache.get("a");
    let _miss = cache.get("missing");

    cache.reset_stats();
    let stats = cache.stats().expect("stats must serialise");
    assert_eq!(number(&stats, "hits"), 0.0, "counters are zeroed");
    assert_eq!(number(&stats, "size"), 1.0, "entries are untouched");

    cache.clear();
    assert_eq!(cache.size(), 0);
    assert!(!cache.has("a"));
}
