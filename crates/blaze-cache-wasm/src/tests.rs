//! `#[wasm_bindgen_test]` suite for the bindings.
//!
//! Declared behind `#[cfg(all(test, target_arch = "wasm32"))]` in `lib.rs`, so host
//! `cargo test` never compiles it while `pnpm test:wasm` runs it in Node.
//!
//! What this covers that the host-side engine tests cannot: everything that actually crosses
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
    let mut cache = BlazeCache::new(8.0);

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
    let mut cache = BlazeCache::new(4.0);

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
    let mut cache = BlazeCache::new(4.0);
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
    let mut cache = BlazeCache::new(4.0);
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
    let mut cache = BlazeCache::new(8.0);
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
    let mut cache = BlazeCache::new(2.0);
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
    let mut cache = BlazeCache::new(4.0);
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

/// Burns CPU until `ms` of wall time passed — wasm has no blocking sleep to lean on, and
/// `js_sys::Date::now()` is the clock every browser and this Node runner agree on.
fn wait_ms(ms: f64) {
    let start = js_sys::Date::now();
    while js_sys::Date::now() - start < ms {
        std::hint::spin_loop();
    }
}

#[wasm_bindgen_test]
fn peek_and_ttl_observe_without_counting_anything() {
    let mut cache = BlazeCache::new(4.0);
    cache.set("a", JsValue::from_str("one"), Some(30_000.0), vec![]);
    cache.set("b", JsValue::from_str("two"), None, vec![]);

    assert_eq!(
        cache.peek("a").and_then(|v| v.as_string()).as_deref(),
        Some("one")
    );
    assert!(
        cache.peek("absent").is_none(),
        "a missing key serialises as undefined"
    );

    let ttl = cache
        .ttl("a")
        .expect("a deadline-bearing key reports its ms");
    assert!(
        (0.0..=30_000.0).contains(&ttl),
        "remaining sits in (0, 30000], got {ttl}"
    );
    assert_eq!(cache.ttl("b"), None, "no deadline → undefined");
    assert_eq!(cache.ttl("absent"), None, "missing → undefined");

    // Both are observational reads: not one of them may reach the counters.
    let stats = cache.stats().expect("stats must serialise");
    assert_eq!(number(&stats, "hits"), 0.0, "peek records no hit");
    assert_eq!(
        number(&stats, "misses"),
        0.0,
        "…and neither call records a miss"
    );
}

#[wasm_bindgen_test]
fn touch_rewrites_the_ttl_and_never_the_value() {
    let mut cache = BlazeCache::new(4.0);
    cache.set("a", JsValue::from_str("one"), Some(1_000.0), vec![]);

    let before = cache.ttl("a").expect("deadline before the touch");
    assert!(cache.touch("a", Some(60_000.0)), "the key is live, so true");
    let after = cache.ttl("a").expect("deadline after the touch");
    assert!(after > before, "renewed from now ({before} → {after})");

    assert_eq!(
        cache.get("a").and_then(|v| v.as_string()).as_deref(),
        Some("one"),
        "the stored value never changed"
    );
    let stats = cache.stats().expect("stats must serialise");
    assert_eq!(
        number(&stats, "hits"),
        1.0,
        "the touch itself recorded no hit"
    );

    // Omitting `ttlMs` leaves the deadline where it was…
    assert!(cache.touch("a", None));
    assert!(
        cache.ttl("a").is_some_and(|ms| ms <= 60_000.0),
        "an optionless touch must not clear the TTL"
    );
    // …while `0` drops it, exactly as `set` reads that value.
    assert!(cache.touch("a", Some(0.0)));
    assert_eq!(cache.ttl("a"), None, "0 → never expires");

    assert!(
        !cache.touch("absent", Some(5_000.0)),
        "a missing key reports false"
    );
}

#[wasm_bindgen_test]
fn size_counts_only_the_entries_that_are_still_alive() {
    let mut cache = BlazeCache::new(8.0);
    cache.set("alive", JsValue::NULL, None, vec![]);
    cache.set("dying", JsValue::NULL, Some(30.0), vec![]);
    assert_eq!(cache.size(), 2, "both are live to begin with");

    wait_ms(60.0);

    assert_eq!(cache.size(), 1, "the expired one is not counted");
    assert_eq!(cache.ttl("dying"), None, "…and reads as absent");
    assert!(cache.has("alive"));
    assert_eq!(cache.capacity(), 8, "capacity is unaffected by expiry");
}

/// JS→integer conversion wraps, so `new BlazeCache(-1)` used to arrive as ~4.29e9 and the
/// core would reserve a hash map for it — an allocation that aborts the whole wasm instance.
/// The constructor now reads a plain `f64` and normalises before the core sees it.
#[wasm_bindgen_test]
fn a_hostile_capacity_is_normalised_before_it_reaches_the_core() {
    assert_eq!(
        BlazeCache::new(-1.0).capacity(),
        1,
        "negatives clamp to the floor"
    );
    assert_eq!(BlazeCache::new(-1e9).capacity(), 1);
    assert_eq!(BlazeCache::new(0.0).capacity(), 1, "zero still means one");
    assert_eq!(
        BlazeCache::new(f64::NAN).capacity(),
        blaze_cache_core::DEFAULT_CAPACITY
    );
    assert_eq!(
        BlazeCache::new(f64::INFINITY).capacity(),
        blaze_cache_core::DEFAULT_CAPACITY
    );
    assert_eq!(
        BlazeCache::new(1e12).capacity(),
        crate::MAX_CAPACITY,
        "absurd sizes clamp to something a browser can hold"
    );
    assert_eq!(
        BlazeCache::new(8.0).capacity(),
        8,
        "an honest number passes through"
    );

    // The instance survived construction, which is the point: it still works.
    let mut cache = BlazeCache::new(-1.0);
    cache.set("k", JsValue::from_f64(1.0), None, vec![]);
    assert_eq!(cache.get("k").and_then(|v| v.as_f64()), Some(1.0));
}

/// `ms as u64` truncates towards zero, so a positive sub-millisecond TTL used to become
/// `Duration::ZERO` — which the core reads as *no expiry*, the exact opposite of what the
/// caller asked for.
#[wasm_bindgen_test]
fn a_sub_millisecond_ttl_expires_instead_of_becoming_immortal() {
    let mut cache = BlazeCache::new(4.0);

    // `ms as u64` truncates 0.5 to 0, and the core reads `Duration::ZERO` as "no expiry" —
    // so a sub-millisecond TTL used to produce an entry that outlived the heat death of the
    // universe. What matters is that a deadline exists at all.
    cache.set("fleeting", JsValue::NULL, Some(0.5), vec![]);
    assert!(
        cache.ttl("fleeting").is_some(),
        "a positive TTL must install a deadline, never truncate to 'never expires'"
    );

    // The rules for zero, negatives and NaN are deliberately unchanged: still "no expiry".
    cache.set("immortal", JsValue::NULL, Some(0.0), vec![]);
    assert_eq!(cache.ttl("immortal"), None);
    cache.set("also", JsValue::NULL, Some(-5.0), vec![]);
    assert_eq!(cache.ttl("also"), None);

    // `touch` truncates the same way, so a renewed sub-millisecond deadline used to vanish.
    cache.set("touched", JsValue::NULL, None, vec![]);
    assert_eq!(
        cache.ttl("touched"),
        None,
        "it starts out with no deadline at all"
    );
    assert!(cache.touch("touched", Some(0.5)));
    assert!(
        cache.ttl("touched").is_some(),
        "touching with a positive TTL installs a deadline"
    );

    // The proof: the sub-millisecond entry really does die, while the zero-TTL one lives on.
    wait_ms(60.0);
    assert!(!cache.has("fleeting"), "the sub-millisecond entry expired");
    assert_eq!(cache.ttl("fleeting"), None);
    assert!(cache.has("immortal"), "…while the zero-TTL one did not");
}

// ------------------------------------------------------------ drop tracking

#[wasm_bindgen_test]
fn drop_tracking_is_off_by_default() {
    let mut cache = BlazeCache::new(2.0);
    assert!(!cache.drop_tracking());
    cache.set("a", JsValue::NULL, None, vec![]);
    cache.set("b", JsValue::NULL, None, vec![]);
    cache.set("c", JsValue::NULL, None, vec![]); // "a" evicted while nobody listens
    assert_eq!(cache.drain_drops().length(), 0);
}

/// The shape the TypeScript layer reads: `{ key, value, reason: "evict" }`.
#[wasm_bindgen_test]
fn drain_drops_reports_evictions_as_plain_objects() {
    let mut cache = BlazeCache::new(2.0);
    cache.set_drop_tracking(true);
    assert!(cache.drop_tracking());
    cache.set("a", JsValue::from_str("first"), None, vec![]);
    cache.set("b", JsValue::from_str("second"), None, vec![]);
    cache.set("c", JsValue::from_str("third"), None, vec![]); // evicts "a"

    let drops = cache.drain_drops();
    assert_eq!(drops.length(), 1);
    let drop: JsValue = drops.get(0);
    assert_eq!(field(&drop, "key").as_string().as_deref(), Some("a"));
    assert_eq!(field(&drop, "value").as_string().as_deref(), Some("first"));
    assert_eq!(field(&drop, "reason").as_string().as_deref(), Some("evict"));

    assert_eq!(cache.drain_drops().length(), 0, "draining empties the log");
}

#[wasm_bindgen_test]
fn drain_drops_reports_lazy_expirations() {
    let mut cache = BlazeCache::new(4.0);
    cache.set_drop_tracking(true);
    cache.set("dying", JsValue::from_str("last words"), Some(30.0), vec![]);
    wait_ms(60.0);

    assert!(
        cache.get("dying").is_none(),
        "the read reclaims the expired entry"
    );
    let drops = cache.drain_drops();
    assert_eq!(drops.length(), 1);
    let drop: JsValue = drops.get(0);
    assert_eq!(field(&drop, "key").as_string().as_deref(), Some("dying"));
    assert_eq!(
        field(&drop, "value").as_string().as_deref(),
        Some("last words")
    );
    assert_eq!(
        field(&drop, "reason").as_string().as_deref(),
        Some("expire")
    );
}

#[wasm_bindgen_test]
fn explicit_deletes_are_never_reported_as_drops() {
    let mut cache = BlazeCache::new(4.0);
    cache.set_drop_tracking(true);
    cache.set("gone", JsValue::NULL, None, vec!["tag".to_string()]);

    assert!(cache.delete("gone"));
    cache.set("bulk", JsValue::NULL, None, vec!["tag".to_string()]);
    cache.invalidate_tags(vec!["tag".to_string()]);
    cache.clear();

    assert_eq!(
        cache.drain_drops().length(),
        0,
        "host-initiated removals are not cache-initiated drops"
    );

    // Turning tracking off also discards anything left undrained.
    let mut small = BlazeCache::new(1.0);
    small.set_drop_tracking(true);
    small.set("x", JsValue::NULL, None, vec![]);
    small.set("y", JsValue::NULL, None, vec![]); // evicts "x"
    assert_eq!(small.drain_drops().length(), 1);
    small.set("z", JsValue::NULL, None, vec![]); // undrained drop…
    small.set_drop_tracking(false);
    assert_eq!(small.drain_drops().length(), 0, "…cleared with the flag");
}

#[wasm_bindgen_test]
fn set_many_clamps_malformed_tag_offsets_instead_of_trapping() {
    let mut cache = BlazeCache::new(8.0);

    let values = Array::new();
    values.push(&JsValue::from_str("v1"));
    values.push(&JsValue::from_str("v2"));
    values.push(&JsValue::from_str("v3"));

    // Hostile offsets covering every failure shape of `tag_offsets[i]..tag_offsets[i+1]`
    // against a 2-element `tags_flat`:
    //   i=0 → end < start        (1..0)  — non-monotonic
    //   i=1 → end past the flat  (0..99)
    //   i=2 → start past the flat (99..99)
    // Unclamped, each panics mid-slice and traps the whole wasm instance.
    cache.set_many(
        vec!["k1".into(), "k2".into(), "k3".into()],
        values.into(),
        vec![0.0, 0.0, 0.0],
        vec!["tA".into(), "tB".into()],
        vec![1, 0, 99],
    );

    // All three entries must still be stored and readable — bad tags cost at most the tags.
    assert_eq!(cache.size(), 3);
    assert_eq!(
        cache.get("k1").and_then(|v| v.as_string()).as_deref(),
        Some("v1")
    );
    assert_eq!(
        cache.get("k2").and_then(|v| v.as_string()).as_deref(),
        Some("v2")
    );
    assert_eq!(
        cache.get("k3").and_then(|v| v.as_string()).as_deref(),
        Some("v3")
    );

    assert!(
        cache.tags_of("k1").is_empty(),
        "non-monotonic range degrades to no tags, not a trap"
    );
    assert_eq!(
        cache.tags_of("k2"),
        vec!["tA".to_string(), "tB".to_string()],
        "out-of-range end clamps to tags_flat.len()"
    );
    assert!(
        cache.tags_of("k3").is_empty(),
        "out-of-range start yields no tags"
    );
}

#[wasm_bindgen_test]
fn tagged_overwrite_refreshes_value_ttl_and_tags() {
    let mut cache = BlazeCache::new(4.0);
    cache.set(
        "k",
        JsValue::from_str("v1"),
        Some(10_000.0),
        vec!["old".to_string()],
    );
    cache.set(
        "k",
        JsValue::from_str("v2"),
        Some(20_000.0),
        vec!["new".to_string()],
    );

    // The borrowed-key path must still update the existing entry in place.
    assert_eq!(cache.size(), 1);
    assert_eq!(cache.keys(), vec!["k".to_string()]);
    assert_eq!(
        cache.get("k").and_then(|v| v.as_string()).as_deref(),
        Some("v2")
    );
    assert_eq!(cache.tags_of("k"), vec!["new".to_string()]);
    assert!(cache.keys_with_tag("old").is_empty());
    assert_eq!(cache.keys_with_tag("new"), vec!["k".to_string()]);
    let ttl = cache.ttl("k").expect("deadline was refreshed");
    assert!(
        ttl > 0.0 && ttl <= 20_000.0,
        "unexpected remaining TTL {ttl}"
    );
}

#[wasm_bindgen_test]
fn batch_overwrite_refreshes_existing_entries() {
    let mut cache = BlazeCache::new(4.0);
    cache.set("a", JsValue::from_str("old"), None, vec!["t1".to_string()]);
    cache.set("b", JsValue::from_str("keep"), None, vec![]);

    let values = Array::new();
    values.push(&JsValue::from_str("fresh"));
    values.push(&JsValue::from_str("other"));
    cache.set_many(
        vec!["a".to_string(), "b".to_string()],
        values.into(),
        vec![5_000.0, -1.0],
        vec!["t2".to_string()],
        vec![0, 1, 1],
    );

    assert_eq!(cache.size(), 2);
    assert_eq!(
        cache.get("a").and_then(|v| v.as_string()).as_deref(),
        Some("fresh")
    );
    assert_eq!(
        cache.get("b").and_then(|v| v.as_string()).as_deref(),
        Some("other")
    );
    assert_eq!(cache.tags_of("a"), vec!["t2".to_string()]);
    assert!(cache.keys_with_tag("t1").is_empty());
    let ttl = cache.ttl("a").expect("batch set installed a deadline");
    assert!(
        ttl > 0.0 && ttl <= 5_000.0,
        "unexpected remaining TTL {ttl}"
    );
    assert_eq!(cache.ttl("b"), None, "a negative ttlMs means no expiry");
}

#[wasm_bindgen_test]
fn raw_key_methods_round_trip_and_reject_bad_pointers() {
    let mut cache = BlazeCache::new(4.0);
    let base = crate::ensure_scratch(16);
    crate::KEY_SCRATCH.with(|cell| {
        let mut scratch = cell.borrow_mut();
        scratch[..2].copy_from_slice(b"ok");
    });

    cache.set_raw(base, 2, JsValue::from_str("v"), None);
    assert_eq!(
        cache
            .get_raw(base, 2)
            .and_then(|v| v.as_string())
            .as_deref(),
        Some("v"),
        "the valid raw path is unchanged"
    );
    assert!(cache.delete_raw(base, 2));
    assert_eq!(cache.get_raw(base, 2), None);

    // An out-of-bounds pointer or length used to build an invalid slice (UB). Now both
    // degrade to a miss / no-op / false without trapping the instance.
    assert_eq!(cache.get_raw(u32::MAX, 1), None);
    assert!(!cache.delete_raw(u32::MAX, 1));
    assert_eq!(cache.get_raw(base, u32::MAX), None);
    cache.set_raw(u32::MAX, 1, JsValue::from_str("v"), None);
    assert_eq!(cache.size(), 0, "a bad pointer must not create an entry");
}

#[wasm_bindgen_test]
fn raw_key_methods_ignore_invalid_utf8_in_the_scratch() {
    let mut cache = BlazeCache::new(4.0);
    let base = crate::ensure_scratch(8);
    crate::KEY_SCRATCH.with(|cell| {
        let mut scratch = cell.borrow_mut();
        scratch[0] = 0xff; // a lone continuation byte: never valid UTF-8
    });

    cache.set_raw(base, 1, JsValue::from_str("v"), None);
    assert_eq!(cache.size(), 0, "invalid UTF-8 must not create an entry");
    assert_eq!(cache.get_raw(base, 1), None, "nor be served as a key");
    assert!(!cache.delete_raw(base, 1));
}

// -------------------------------------------------------- binary values + JS-authoritative ids

#[wasm_bindgen_test]
fn bytes_round_trip_through_the_arena() {
    let mut cache = BlazeCache::new(4.0);
    let ptr = BlazeCache::bytes_reserve(8) as usize;
    assert!(blaze_cache_core::bytes::copy_into(ptr, 8, b"abcdefgh"));

    assert!(cache.set_bytes("bin", ptr as u32, 8, None, vec![]));
    let coordinates: Array = cache
        .get_bytes("bin")
        .expect("a bytes entry")
        .unchecked_into();
    assert_eq!(coordinates.length(), 2);
    let read_ptr = coordinates.get(0).as_f64().unwrap() as usize;
    let read_len = coordinates.get(1).as_f64().unwrap() as usize;
    assert_eq!((read_ptr, read_len), (ptr, 8));
    assert_eq!(
        blaze_cache_core::bytes::to_vec(read_ptr, read_len).unwrap(),
        b"abcdefgh"
    );

    let copy: js_sys::Uint8Array = cache.get_bytes_copy("bin").expect("copy");
    assert_eq!(copy.length(), 8);
    assert_eq!(copy.get_index(0), b'a');

    // A `set` entry is not readable as bytes, and vice versa.
    cache.set("obj", JsValue::from_str("x"), None, vec![]);
    assert!(cache.get_bytes("obj").is_none());
    assert!(
        cache.get("bin").is_none(),
        "bytes entries are not externrefs"
    );
}

#[wasm_bindgen_test]
fn set_bytes_rejects_a_stale_pointer_without_trapping() {
    let mut cache = BlazeCache::new(4.0);
    assert!(!cache.set_bytes("bad", u32::MAX, 8, None, vec![]));
    assert_eq!(cache.size(), 0);
    assert!(cache.get_bytes("bad").is_none());
}

#[wasm_bindgen_test]
fn id_metadata_and_by_id_lookups_drive_js_authoritative_mode() {
    let mut cache = BlazeCache::new(4.0);
    cache.enable_ids();
    let first = cache.set_meta("a", None, vec!["tag".into()]);
    assert_eq!(first, 0);
    assert_eq!(
        cache.set_meta("a", Some(5_000.0), vec!["tag".into()]),
        first,
        "overwrite keeps id"
    );
    let second = cache.set_meta("b", None, vec![]);
    assert_eq!(second, 1);

    assert!(cache.get_by_id(first));
    assert!(cache.peek_by_id(first));
    assert!(cache.has_by_id(second));
    assert!(!cache.get_by_id(999));

    let meta = cache.entry_meta("a");
    assert_eq!(field(&meta, "id").as_f64(), Some(0.0));
    // `field` would panic on a missing/undefined property; read this one directly.
    let value = js_sys::Reflect::get(&meta, &JsValue::from_str("value")).unwrap();
    assert!(value.is_undefined(), "no value is stored in wasm");
    assert_eq!(field(&meta, "key").as_string().as_deref(), Some("a"));
    assert_eq!(cache.entries_meta().length(), 2);
}

#[wasm_bindgen_test]
fn drain_drops_carries_the_stable_id() {
    let mut cache = BlazeCache::new(1.0);
    cache.enable_ids();
    cache.set_drop_tracking(true);
    let first = cache.set_meta("a", None, vec![]);
    cache.set_meta("b", None, vec![]); // evicts "a"

    let drops = cache.drain_drops();
    assert_eq!(drops.length(), 1);
    let drop: JsValue = drops.get(0);
    assert_eq!(field(&drop, "id").as_f64(), Some(first as f64));
    assert_eq!(field(&drop, "key").as_string().as_deref(), Some("a"));
}
