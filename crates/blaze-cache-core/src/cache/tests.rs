//! Unit tests for [`Cache`] — kept in their own file so `cache.rs` stays readable.
//!
//! `use super::*` still reaches every private item `cache.rs` declares, so these remain
//! true unit tests rather than API-level integration tests.

use super::*;
use std::thread;

fn sleep(ms: u64) {
    thread::sleep(Duration::from_millis(ms));
}

fn keys_of<K, V>(cache: &Cache<K, V>) -> Vec<K>
where
    K: Clone + Hash + Eq + std::fmt::Debug,
{
    cache.keys().cloned().collect()
}

/// Owned copy of the keys carrying `tag`, so assertions read naturally.
fn tagged_keys<K, V>(cache: &Cache<K, V>, tag: &str) -> Vec<K>
where
    K: Clone + Hash + Eq,
{
    cache.keys_with_tag(tag).into_iter().cloned().collect()
}

#[test]
fn round_trips_values() {
    let mut cache = Cache::new(4);
    cache.insert("greeting", "hello");
    assert_eq!(cache.get("greeting"), Some(&"hello"));
    assert_eq!(cache.len(), 1);
    assert_eq!(cache.stats().hits, 1);
    assert!(cache.contains_key("greeting"));
}

#[test]
fn counts_misses_and_handles_replacement() {
    let mut cache = Cache::new(4);
    cache.insert("k", 1);
    assert_eq!(cache.insert_with("k", 2, EntryOptions::new()), Some(1));
    assert_eq!(cache.len(), 1);
    assert_eq!(cache.get("k"), Some(&2));

    assert_eq!(cache.get("absent"), None);
    let stats = cache.stats();
    assert_eq!(stats.hits, 1);
    assert_eq!(stats.misses, 1);
    assert!((stats.hit_rate() - 0.5).abs() < 1e-9);
}

#[test]
fn evicts_the_oldest_unvisited_entry() {
    let mut cache = Cache::new(3);
    cache.insert("a", 1);
    cache.insert("b", 2);
    cache.insert("c", 3);
    assert_eq!(cache.get("a"), Some(&1)); // "a" becomes protected

    cache.insert("d", 4); // over capacity -> "b" is the oldest unvisited
    assert_eq!(cache.len(), 3);
    assert_eq!(cache.get("a"), Some(&1));
    assert_eq!(cache.get("b"), None);
    assert_eq!(cache.get("c"), Some(&3));
    assert_eq!(cache.get("d"), Some(&4));
    assert_eq!(cache.stats().evictions, 1);
}

#[test]
fn second_sweep_reclaims_protected_entries() {
    let mut cache = Cache::new(3);
    cache.insert("a", 1);
    cache.insert("b", 2);
    cache.insert("c", 3);
    for (key, value) in [("a", 1), ("b", 2), ("c", 3)] {
        assert_eq!(
            cache.get(key),
            Some(&value),
            "every entry becomes protected"
        );
    }
    // Everything is visited: the hand clears the bits on its first pass and takes the
    // oldest one on the wrap-around.
    cache.insert("d", 4);
    assert_eq!(cache.get("a"), None);
    assert_eq!(keys_of(&cache), vec!["b", "c", "d"]);
    assert_eq!(cache.stats().evictions, 1);
}

#[test]
fn zero_capacity_is_clamped_to_one() {
    let mut cache: Cache<&str, i32> = Cache::new(0);
    assert_eq!(cache.capacity(), 1);
    cache.insert("a", 1);
    cache.insert("b", 2);
    assert_eq!(cache.len(), 1);
    assert_eq!(cache.get("b"), Some(&2));
    assert_eq!(cache.get("a"), None);
}

#[test]
fn shrinking_capacity_evicts_immediately() {
    let mut cache = Cache::new(4);
    for (k, v) in [("a", 1), ("b", 2), ("c", 3), ("d", 4)] {
        cache.insert(k, v);
    }
    cache.set_capacity(1);
    assert_eq!(cache.len(), 1);
    assert_eq!(keys_of(&cache), vec!["d"]);
}

#[test]
fn expires_lazily_on_access() {
    let mut cache = Cache::new(4);
    cache.insert_with(
        "short",
        1,
        EntryOptions::new().ttl(Duration::from_millis(5)),
    );
    cache.insert_with("long", 2, EntryOptions::new().ttl(Duration::from_secs(60)));

    assert!(cache.contains_key("short"));
    sleep(30);
    assert!(!cache.contains_key("short"), "contains_key never mutates");
    assert_eq!(cache.get("short"), None);
    assert_eq!(cache.len(), 1, "the expired entry was dropped eagerly");
    assert_eq!(cache.get("long"), Some(&2));

    let stats = cache.stats();
    assert_eq!(stats.expirations, 1);
    assert_eq!(stats.misses, 1);
}

#[test]
fn keys_skip_expired_entries() {
    let mut cache = Cache::new(4);
    cache.insert_with(
        "stale",
        1,
        EntryOptions::new().ttl(Duration::from_millis(5)),
    );
    cache.insert("fresh", 2);
    sleep(30);

    assert_eq!(keys_of(&cache), vec!["fresh"]);
    assert_eq!(cache.entries().len(), 1);
    assert!(cache.meta("stale").is_none());
    assert!(cache.meta("fresh").is_some());
    assert!(
        cache.entry("stale").is_none(),
        "entry() sees the same expiry"
    );
    assert_eq!(*cache.entry("fresh").expect("alive").value, 2);
}

#[test]
fn prune_reclaims_every_expired_entry() {
    let mut cache = Cache::new(8);
    cache.insert_with("a", 1, EntryOptions::new().ttl(Duration::from_millis(5)));
    cache.insert_with("b", 2, EntryOptions::new().ttl(Duration::from_millis(5)));
    cache.insert("c", 3);
    sleep(30);

    let mut removed = cache.prune();
    removed.sort_unstable();
    assert_eq!(removed, vec!["a", "b"]);
    assert_eq!(cache.len(), 1);
    assert_eq!(cache.stats().expirations, 2);
}

#[test]
fn zero_ttl_means_no_expiry() {
    let mut cache = Cache::new(4);
    cache.insert_with("permanent", 1, EntryOptions::new().ttl(Duration::ZERO));
    assert_eq!(cache.len(), 1);
    assert!(cache.contains_key("permanent"));
    assert_eq!(cache.meta("permanent").unwrap().ttl_remaining, None);
}

#[test]
fn tags_invalidate_only_the_matching_entries() {
    let mut cache = Cache::new(8);
    cache.insert_with("u1", 1, EntryOptions::new().tag("user:1"));
    cache.insert_with("u2", 2, EntryOptions::new().tags(["user:2", "vip"]));
    cache.insert_with("page", 3, EntryOptions::new().tag("public"));

    assert_eq!(tagged_keys(&cache, "vip"), vec!["u2"]);
    assert!(cache.has_tag("u2", "vip"));
    assert!(!cache.has_tag("u1", "vip"));

    assert_eq!(cache.invalidate_tags(["user:1"]), vec!["u1"]);
    assert_eq!(cache.len(), 2);

    let mut removed = cache.invalidate_tags(["vip", "public"]);
    removed.sort_unstable();
    assert_eq!(removed, vec!["page", "u2"]);
    assert!(cache.is_empty());
    assert_eq!(cache.stats().invalidations, 3);
    // Forgotten tags must not leak.
    assert!(cache.keys_with_tag("vip").is_empty());
    assert!(!cache.has_tag("u2", "vip"));
}

#[test]
fn rewriting_an_entry_replaces_its_tags() {
    let mut cache = Cache::new(4);
    cache.insert_with("k", 1, EntryOptions::new().tag("old"));
    assert_eq!(cache.tags_of("k"), Some(vec!["old".to_owned()]));

    cache.insert_with("k", 2, EntryOptions::new().tag("new"));
    assert_eq!(cache.tags_of("k"), Some(vec!["new".to_owned()]));
    assert!(cache.keys_with_tag("old").is_empty());
    assert_eq!(tagged_keys(&cache, "new"), vec!["k"]);

    // The retagged entry is still findable under the old key with the new value.
    assert_eq!(cache.get("k"), Some(&2));
    assert_eq!(cache.invalidate_tags(["old"]), Vec::<&str>::new());
    assert!(cache.contains_key("k"));
}

#[test]
fn entries_expose_ttl_and_tags_for_persistence() {
    let mut cache = Cache::new(4);
    cache.insert_with(
        "user:7",
        "payload",
        EntryOptions::new()
            .ttl(Duration::from_secs(30))
            .tags(["user:7", "profile"]),
    );
    let entries = cache.entries();
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert_eq!(*entry.key, "user:7");
    assert_eq!(*entry.value, "payload");
    let ttl = entry.meta.ttl_remaining.expect("has a ttl");
    assert!(ttl <= Duration::from_secs(30) && !ttl.is_zero());
    assert_eq!(entry.meta.tags, vec!["user:7", "profile"]);
}

#[test]
fn clear_resets_storage_and_tags() {
    let mut cache = Cache::new(4);
    cache.insert_with("a", 1, EntryOptions::new().tag("t"));
    cache.insert("b", 2);
    cache.clear();

    assert!(cache.is_empty());
    assert!(cache.keys_with_tag("t").is_empty());
    assert_eq!(cache.stats().invalidations, 2);
    // Still usable afterwards.
    cache.insert("c", 3);
    assert_eq!(cache.get("c"), Some(&3));
}

#[test]
fn remove_returns_the_value_and_counts_an_invalidation() {
    let mut cache = Cache::new(4);
    cache.insert("k", 42);
    assert_eq!(cache.remove("k"), Some(42));
    assert_eq!(cache.remove("k"), None);
    assert_eq!(cache.len(), 0);
    assert_eq!(cache.stats().invalidations, 1);
}

#[test]
fn removing_middle_entries_keeps_the_queue_linked() {
    let mut cache = Cache::new(4);
    cache.insert("a", 1);
    cache.insert("b", 2);
    cache.insert("c", 3);
    cache.insert("d", 4);

    // "b" and "c" are middle nodes: linked, but neither end. `is_linked` used to answer
    // `false` for exactly those, so their slots were freed while the neighbours still
    // pointed at them — freeing "c" then panicked in `unlink` on `live prev`.
    assert_eq!(cache.remove("b"), Some(2));
    assert_eq!(cache.remove("c"), Some(3));
    assert_eq!(cache.len(), 2);

    cache.insert("e", 5);
    cache.insert("f", 6);
    assert_eq!(
        cache.keys().copied().collect::<Vec<_>>(),
        vec!["a", "d", "e", "f"],
        "the survivors keep their queue order"
    );

    // A full eviction sweep over every node proves the repaired links actually walk.
    cache.insert("g", 7);
    assert_eq!(cache.stats().evictions, 1);
    assert_eq!(
        cache.keys().copied().collect::<Vec<_>>(),
        vec!["d", "e", "f", "g"]
    );
}

#[test]
fn reinserting_a_key_keeps_slot_count_stable() {
    let mut cache = Cache::new(4);
    for i in 0..100 {
        cache.insert_with("hot", i, EntryOptions::new().tag("t"));
    }
    assert_eq!(cache.len(), 1);
    assert_eq!(cache.get("hot"), Some(&99));
    assert_eq!(tagged_keys(&cache, "t"), vec!["hot"]);
    assert_eq!(cache.stats().evictions, 0);
}

// ------------------------------------------------------- ttl_count bookkeeping
//
// `ttl_count` is what lets the read paths skip `Instant::now()` (a wasm→JS boundary
// crossing) when no entry can be expired. Every test here guards the invariant the fast
// path will rely on: **the counter equals the number of nodes holding a deadline.**
// They run before the fast path exists, so a failure here can only be bookkeeping.

#[test]
fn ttl_count_tracks_new_entries_with_and_without_deadlines() {
    let mut cache = Cache::new(8);
    assert_eq!(cache.ttl_count, 0);

    cache.insert("permanent", 1); // no TTL
    assert_eq!(cache.ttl_count, 0);

    cache.insert_with(
        "expiring",
        2,
        EntryOptions::new().ttl(Duration::from_secs(60)),
    );
    assert_eq!(cache.ttl_count, 1);

    // Zero/absent TTL means "no deadline" — must not be counted.
    cache.insert_with("zero", 3, EntryOptions::new().ttl(Duration::ZERO));
    assert_eq!(
        cache.ttl_count, 1,
        "only the 60s entry holds a deadline; a zero TTL is permanent"
    );
}

#[test]
fn ttl_count_follows_deadline_changes_on_rewrite() {
    let mut cache = Cache::new(8);
    cache.insert_with("k", 1, EntryOptions::new().ttl(Duration::from_secs(60)));
    assert_eq!(cache.ttl_count, 1);

    // Same key, now permanent: the deadline is dropped, so the count falls.
    cache.insert_with("k", 2, EntryOptions::new());
    assert_eq!(cache.ttl_count, 0, "rewrite removed the deadline");

    // Permanent → expiring again: back up.
    cache.insert_with("k", 3, EntryOptions::new().ttl(Duration::from_secs(5)));
    assert_eq!(cache.ttl_count, 1);

    // Expiring → expiring: still exactly one deadline, never two.
    cache.insert_with("k", 4, EntryOptions::new().ttl(Duration::from_secs(5)));
    assert_eq!(cache.ttl_count, 1);
    assert_eq!(cache.get("k"), Some(&4));
}

#[test]
fn ttl_count_drops_when_entries_are_removed() {
    let mut cache = Cache::new(8);
    cache.insert_with("a", 1, EntryOptions::new().ttl(Duration::from_secs(60)));
    cache.insert_with("b", 2, EntryOptions::new()); // permanent
    assert_eq!(cache.ttl_count, 1);

    // `remove` frees `a`, whose deadline dies with it.
    cache.remove("a");
    assert_eq!(cache.ttl_count, 0, "release() decrements the counter");

    // A permanent entry being removed must leave the counter untouched (it is 0).
    cache.remove("b");
    assert_eq!(cache.ttl_count, 0);
}

#[test]
fn ttl_count_survives_eviction_and_expiration() {
    let mut cache = Cache::new(2);
    cache.insert_with("a", 1, EntryOptions::new().ttl(Duration::from_secs(60)));
    cache.insert_with("b", 2, EntryOptions::new().ttl(Duration::from_secs(60)));
    assert_eq!(cache.ttl_count, 2);

    // Capacity pressure: `a` (oldest, unvisited) is evicted through `evict_one`.
    cache.insert_with("c", 3, EntryOptions::new().ttl(Duration::from_secs(60)));
    assert_eq!(cache.ttl_count, 2, "evicted a, added c");
    assert_eq!(cache.get("a"), None);

    // Lazy expiry on read: `b`'s TTL elapses and `get` reclaims it eagerly.
    let mut expiring = Cache::new(4);
    expiring.insert_with("s", 1, EntryOptions::new().ttl(Duration::from_millis(5)));
    assert_eq!(expiring.ttl_count, 1);
    sleep(30);
    assert_eq!(expiring.get("s"), None, "expired and freed");
    assert_eq!(
        expiring.ttl_count, 0,
        "the expired node decremented on release"
    );
}

#[test]
fn ttl_count_resets_on_clear_and_survives_prune() {
    let mut cache = Cache::new(8);
    cache.insert_with("a", 1, EntryOptions::new().ttl(Duration::from_secs(60)));
    cache.insert_with("b", 2, EntryOptions::new());
    assert_eq!(cache.ttl_count, 1);

    // `clear()` bypasses `release()` entirely, so it must reset the counter itself.
    cache.clear();
    assert_eq!(cache.ttl_count, 0, "clear() resets the counter");

    // Prune reclaims expired nodes through `free()` → `release()`.
    cache.insert_with("x", 1, EntryOptions::new().ttl(Duration::from_millis(5)));
    assert_eq!(cache.ttl_count, 1);
    sleep(30);
    cache.prune();
    assert_eq!(
        cache.ttl_count, 0,
        "prune() ran the nodes through release()"
    );
    assert_eq!(cache.len(), 0);
}

#[test]
fn ttl_count_never_drifts_under_mixed_churn() {
    // Hammer rewrite, capacity eviction and explicit removal at once with a capacity
    // smaller than the key pool, so insertions evict too. Hand-tracked arithmetic can't
    // model evictions, so compare directly against ground truth after every step: the
    // number of live nodes that actually hold a deadline.
    let live_deadlines = |cache: &Cache<String, usize>| {
        cache
            .entries()
            .iter()
            .filter(|e| e.meta.ttl_remaining.is_some())
            .count()
    };

    let mut cache = Cache::new(4);
    for i in 0..60 {
        let with_ttl = i % 2 == 0;
        let key = format!("k{}", i % 6);
        let options = if with_ttl {
            EntryOptions::new().ttl(Duration::from_secs(60))
        } else {
            EntryOptions::new()
        };
        cache.insert_with(key.clone(), i, options);
        assert_eq!(
            cache.ttl_count,
            live_deadlines(&cache),
            "drift after insert at iteration {i} (with_ttl={with_ttl})"
        );

        if i % 5 == 0 {
            cache.remove(&key);
            assert_eq!(
                cache.ttl_count,
                live_deadlines(&cache),
                "drift after remove at iteration {i} (with_ttl={with_ttl})"
            );
        }
    }
    assert!(
        !cache.is_empty(),
        "sanity: the churn must leave entries behind"
    );
}

#[test]
fn live_len_counts_only_unexpired_entries() {
    let mut cache = Cache::new(4);
    assert_eq!(cache.capacity(), 4, "capacity is what was asked for");
    cache.insert("plain", 1);
    cache.insert_with(
        "short",
        2,
        EntryOptions::new().ttl(Duration::from_millis(20)),
    );
    assert_eq!(cache.live_len(), 2);

    sleep(40);
    assert_eq!(cache.len(), 2, "len() still counts the expired slot");
    assert_eq!(cache.live_len(), 1, "live_len() does not");

    // With no deadline anywhere the fast path answers from the index, no walk and no clock.
    let mut plain = Cache::new(2);
    plain.insert("a", 1);
    plain.insert("b", 2);
    assert_eq!(plain.live_len(), 2);
    assert_eq!(plain.ttl_count, 0, "a plain write still costs no clock");
}

#[test]
fn peek_reads_without_leaving_a_footprint() {
    let mut cache = Cache::new(4);
    cache.insert("a", 1);
    cache.insert("b", 2);

    assert_eq!(cache.peek("a"), Some(&1));
    assert_eq!(cache.peek("a"), Some(&1), "reading twice changes nothing");
    assert_eq!(cache.peek("missing"), None);
    let stats = cache.stats();
    assert_eq!(stats.hits, 0, "peek records no hit");
    assert_eq!(stats.misses, 0, "…and no miss");

    // Expired entries are invisible to peek as well, and — unlike get — nothing is reclaimed.
    cache.insert_with("e", 9, EntryOptions::new().ttl(Duration::from_millis(10)));
    sleep(30);
    assert_eq!(cache.peek("e"), None);
    assert_eq!(cache.len(), 3, "peek never mutates, so no slot was freed");
    assert_eq!(
        cache.live_len(),
        2,
        "…while live_len sees through the expired one"
    );

    // The eviction half of "no footprint": a peek does not mark the entry visited.
    let mut sieve = Cache::new(2);
    sieve.insert("a", 1);
    sieve.insert("b", 2);
    assert_eq!(sieve.peek("a"), Some(&1));
    sieve.insert("c", 3);
    assert_eq!(sieve.get("a"), None, "the peeked entry was still evictable");
    assert_eq!(sieve.get("b"), Some(&2));
}

#[test]
fn ttl_reports_remaining_time_or_nothing_at_all() {
    let mut cache = Cache::new(4);
    cache.insert("forever", 1);
    cache.insert_with(
        "short",
        2,
        EntryOptions::new().ttl(Duration::from_millis(300)),
    );

    assert_eq!(cache.ttl("forever"), Some(None), "no deadline set");
    let left = cache.ttl("short").flatten().expect("a deadline is set");
    assert!(
        left <= Duration::from_millis(300) && left > Duration::from_millis(100),
        "remaining is measured from now ({left:?})"
    );
    assert_eq!(cache.ttl("missing"), None, "unknown key");
    let stats = cache.stats();
    assert_eq!(stats.hits, 0, "ttl() observes nothing");

    // An expired key reads as absent, the same way `get` and `peek` see it.
    cache.insert_with(
        "gone",
        3,
        EntryOptions::new().ttl(Duration::from_millis(10)),
    );
    sleep(30);
    assert_eq!(
        cache.ttl("gone"),
        None,
        "expired is indistinguishable from missing"
    );
}

#[test]
fn touch_refreshes_the_deadline_without_touching_the_value() {
    let mut cache = Cache::new(4);
    cache.insert_with("a", 1, EntryOptions::new().ttl(Duration::from_millis(400)));

    // No TTL requested → the existing deadline must survive untouched.
    assert!(cache.touch("a", None));
    let untouched = cache.ttl("a").flatten().expect("still deadline-bearing");
    assert!(
        untouched <= Duration::from_millis(400) && untouched > Duration::from_millis(300),
        "a TTL-less touch must not rewrite the deadline ({untouched:?})"
    );

    // With a TTL → the deadline is rebuilt from this moment.
    assert!(cache.touch("a", Some(Duration::from_secs(5))));
    let refreshed = cache.ttl("a").flatten().expect("still deadline-bearing");
    assert!(
        refreshed > Duration::from_secs(4),
        "renewed from now, not accumulated ({refreshed:?})"
    );
    assert_eq!(
        cache.ttl_count, 1,
        "the fast-path counter followed the rewrite"
    );

    assert_eq!(cache.get("a"), Some(&1), "the value never changed");
    assert_eq!(
        cache.stats().hits,
        1,
        "the only recorded read is the get above"
    );

    // A zero TTL means "never expires", exactly as in insert_with.
    assert!(cache.touch("a", Some(Duration::ZERO)));
    assert_eq!(cache.ttl("a"), Some(None), "the deadline was dropped");
    assert_eq!(cache.ttl_count, 0, "…and so was its counter");

    // Nothing to touch → false, and an expired entry is never resurrected.
    assert!(!cache.touch("missing", Some(Duration::from_secs(5))));
    cache.insert_with(
        "dead",
        2,
        EntryOptions::new().ttl(Duration::from_millis(10)),
    );
    sleep(30);
    assert!(!cache.touch("dead", Some(Duration::from_secs(5))));
    assert_eq!(cache.get("dead"), None, "still expired");
}

#[test]
fn touch_protects_the_entry_from_the_next_eviction() {
    let mut cache = Cache::new(2);
    cache.insert("a", 1); // oldest — the entry SIEVE would take
    cache.insert("b", 2);

    assert!(cache.touch("a", None), "marks the oldest entry visited");
    cache.insert("c", 3); // capacity pressure: the sweep has to drop something

    assert_eq!(cache.get("a"), Some(&1), "the touched entry survived");
    assert_eq!(cache.get("b"), None, "the untouched one went instead");
    assert_eq!(cache.stats().evictions, 1);
}

// ---------------------------------------------------------------- regression

/// Eviction used to run *between* interning the new entry's tags and attaching them.
/// When the sweep dropped the tag's last member it forgot the tag outright, so the
/// following `attach` silently no-oped: the new node carried an id the index had lost,
/// `keys_with_tag` came back empty and — worst of all — `invalidate_tags` could no longer
/// reach a live entry, which is the one thing tags exist to do.
#[test]
fn a_tag_survives_the_eviction_of_its_only_previous_member() {
    let mut cache = Cache::new(2);
    cache.insert_with("a", 1, EntryOptions::new().tag("x"));
    cache.insert_with("b", 2, EntryOptions::new().tag("y"));
    // Evicts "a", the only other member of "x", then publishes "c" tagged "x".
    cache.insert_with("c", 3, EntryOptions::new().tag("x"));

    assert_eq!(tagged_keys(&cache, "x"), vec!["c"]);
    assert_eq!(cache.tags_of("c"), Some(vec!["x".to_owned()]));
    assert!(cache.has_tag("c", "x"));
    assert_eq!(
        cache.invalidate_tags(["x"]),
        vec!["c"],
        "stale data survived"
    );
    assert_eq!(cache.len(), 1, "only b is left");
}

/// Same hole, one step wider: the evicted member and the new entry share the tag *and* the
/// sweep has to walk past a visited entry to find its victim. The tag must still resolve.
#[test]
fn tag_index_stays_consistent_across_a_full_capacity_churn() {
    let mut cache = Cache::new(3);
    for round in 0..6 {
        let key = format!("k{round}");
        cache.insert_with(key, round, EntryOptions::new().tag("hot").tag("all"));
        cache.get("k0"); // mark something visited so the sweep skips it
    }

    // Whatever survived, the invariant is the same: the index and the nodes agree.
    let live = keys_of(&cache);
    assert!(!live.is_empty());
    for key in &live {
        assert!(
            cache.has_tag(key, "hot"),
            "{key} is live but the tag index lost it"
        );
    }
    let invalidated = cache.invalidate_tags(["hot"]);
    assert_eq!(
        invalidated.len(),
        live.len(),
        "every live entry carried the tag, so every live entry must go"
    );
}

/// A TTL large enough to overflow the monotonic instant range used to panic with
/// "overflow when adding duration to instant" — reachable from nothing but a
/// caller-supplied `Duration`. It now reads as "no deadline".
#[test]
fn an_overflowing_ttl_never_panics_and_means_no_deadline() {
    let mut cache = Cache::new(4);

    cache.insert_with(
        "huge",
        1,
        EntryOptions::new().ttl(Duration::from_secs(u64::MAX)),
    );
    assert_eq!(
        cache.ttl("huge"),
        Some(None),
        "an unreachable deadline is the same statement as no deadline"
    );

    assert!(cache.touch("huge", Some(Duration::from_secs(u64::MAX))));
    assert_eq!(cache.ttl("huge"), Some(None));
    assert_eq!(cache.get("huge"), Some(&1), "and it is still readable");

    // The honest TTLs are untouched by the fallback.
    cache.insert_with("short", 2, EntryOptions::new().ttl(Duration::from_secs(5)));
    assert!(
        cache
            .ttl("short")
            .flatten()
            .is_some_and(|d| d > Duration::ZERO)
    );
}
