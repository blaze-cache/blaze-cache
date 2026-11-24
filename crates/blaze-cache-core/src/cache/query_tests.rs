//! Unit tests for the opt-in query indexes (0.5.0-beta.1).

use std::time::Duration;

use super::*;
use crate::{QueryError, QueryFilter};

fn filter<'a>(limit: usize) -> QueryFilter<'a> {
    QueryFilter {
        limit,
        ..QueryFilter::default()
    }
}

#[test]
fn query_requires_opt_in_and_a_nonzero_limit() {
    let mut cache: Cache<String, u32> = Cache::new(8);
    cache.insert("a".into(), 1);
    assert_eq!(
        cache.query_keys(&filter(10)),
        Err(QueryError::IndexesDisabled)
    );

    cache.enable_indexes();
    assert!(cache.indexes_enabled());
    assert_eq!(cache.query_keys(&filter(0)), Err(QueryError::InvalidLimit));
    // Idempotent: enabling twice must not duplicate anything.
    cache.enable_indexes();
    assert_eq!(cache.indexed_key_count(), Some(1));
}

#[test]
fn index_tracks_insert_replace_delete_clear_and_existing_entries() {
    let mut cache: Cache<String, u32> = Cache::new(8);
    cache.insert("b".into(), 2);
    cache.insert("a".into(), 1);
    cache.enable_indexes();
    assert_eq!(cache.indexed_key_count(), Some(2));

    cache.insert("c".into(), 3);
    cache.insert("a".into(), 10); // overwrite: no duplicate
    assert_eq!(cache.indexed_key_count(), Some(3));
    assert_eq!(cache.remove("b"), Some(2));
    assert_eq!(cache.indexed_key_count(), Some(2));
    cache.clear();
    assert_eq!(cache.indexed_key_count(), Some(0));

    cache.insert("d".into(), 4);
    assert_eq!(cache.indexed_key_count(), Some(1));
}

#[test]
fn prefix_queries_are_sorted_and_cursor_survives_a_deleted_anchor() {
    let mut cache: Cache<String, u32> = Cache::new(16);
    for key in ["app:a", "app:b", "app:c", "other:x"] {
        cache.insert(key.to_owned(), 1);
    }
    cache.enable_indexes();

    let mut f = filter(2);
    f.prefix = Some("app:");
    let page1 = cache.query_keys(&f).unwrap();
    assert_eq!(
        page1
            .rows
            .iter()
            .map(|r| r.key.as_str())
            .collect::<Vec<_>>(),
        vec!["app:a", "app:b"]
    );
    assert_eq!(page1.next_cursor.as_deref(), Some("app:b"));

    // Delete the anchor: a last-key cursor is an opaque position, not a stored node.
    assert!(cache.remove("app:b").is_some());
    let cursor = page1.next_cursor.unwrap();
    let mut page2 = filter(2);
    page2.prefix = Some("app:");
    page2.cursor = Some(&cursor);
    let page2 = cache.query_keys(&page2).unwrap();
    assert_eq!(
        page2
            .rows
            .iter()
            .map(|r| r.key.as_str())
            .collect::<Vec<_>>(),
        vec!["app:c"]
    );
    assert_eq!(page2.next_cursor, None);
}

#[test]
fn tag_constraints_combine_any_all_and_none() {
    let mut cache: Cache<String, u32> = Cache::new(16);
    cache.insert_with("a".into(), 1, EntryOptions::new().tags(["red", "round"]));
    cache.insert_with("b".into(), 2, EntryOptions::new().tags(["red", "square"]));
    cache.insert_with("c".into(), 3, EntryOptions::new().tags(["blue", "round"]));
    cache.enable_indexes();

    let red = ["red".to_owned()];
    let round = ["round".to_owned()];
    let square = ["square".to_owned()];

    let mut f = filter(10);
    f.tags_any = &red;
    let rows = cache.query_keys(&f).unwrap().rows;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].tags, vec!["red", "round"]);

    f.tags_all = &round;
    let rows = cache.query_keys(&f).unwrap().rows;
    assert_eq!(
        rows.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(),
        vec!["a"]
    );

    f.tags_any = &[];
    f.tags_all = &[];
    f.tags_none = &square;
    let rows = cache.query_keys(&f).unwrap().rows;
    assert_eq!(
        rows.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(),
        vec!["a", "c"]
    );
}

#[test]
fn ttl_range_and_keys_allow_list_filter_metadata() {
    let mut cache: Cache<String, u32> = Cache::new(16);
    cache.insert_with(
        "short".into(),
        1,
        EntryOptions::new().ttl(Duration::from_millis(250)),
    );
    cache.insert_with(
        "long".into(),
        2,
        EntryOptions::new().ttl(Duration::from_secs(60)),
    );
    cache.insert("permanent".into(), 3);
    cache.enable_indexes();

    let mut f = filter(10);
    f.ttl_max_ms = Some(5_000.0);
    let rows = cache.query_keys(&f).unwrap().rows;
    assert_eq!(
        rows.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(),
        vec!["short"],
        "permanent entries have infinite TTL and are excluded by an upper bound"
    );

    f.ttl_max_ms = None;
    f.ttl_min_ms = Some(10_000.0);
    let rows = cache.query_keys(&f).unwrap().rows;
    assert_eq!(
        rows.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(),
        vec!["long", "permanent"]
    );

    f.ttl_min_ms = None;
    let allowed = ["long".to_owned(), "permanent".to_owned()];
    f.keys = Some(&allowed);
    let rows = cache.query_keys(&f).unwrap().rows;
    assert_eq!(
        rows.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(),
        vec!["long", "permanent"]
    );
}

#[test]
fn touch_updates_the_expiry_index() {
    let mut cache: Cache<String, u32> = Cache::new(8);
    cache.insert_with(
        "a".into(),
        1,
        EntryOptions::new().ttl(Duration::from_millis(200)),
    );
    cache.enable_indexes();
    assert_eq!(cache.ttl_ordered_keys(), vec!["a"]);

    assert!(cache.touch("a", Some(Duration::from_secs(30))));
    assert_eq!(cache.ttl_ordered_keys(), vec!["a"]);
    let mut f = filter(10);
    f.ttl_min_ms = Some(10_000.0);
    assert_eq!(cache.query_keys(&f).unwrap().rows.len(), 1);

    // A zero TTL clears the deadline and moves the key to the permanent set.
    assert!(cache.touch("a", Some(Duration::ZERO)));
    assert_eq!(cache.ttl_ordered_keys(), vec!["a"]);
    assert_eq!(cache.query_keys(&f).unwrap().rows.len(), 1); // permanent counts as infinity
}

#[test]
fn count_reports_all_matches_without_paging() {
    let mut cache: Cache<String, u32> = Cache::new(16);
    for key in ["a", "b", "c"] {
        cache.insert(key.to_owned(), 1);
    }
    cache.enable_indexes();
    assert_eq!(cache.query_count(&filter(1)).unwrap(), 3);
    let page = cache.query_keys(&filter(1)).unwrap();
    assert_eq!(page.rows.len(), 1);
    assert_eq!(page.next_cursor.as_deref(), Some("a"));
    assert_eq!(page.total, 0, "total is opt-in to keep queries bounded");
}

#[test]
fn a_page_stops_at_the_first_extra_match_and_a_total_walks_all_matches() {
    let mut cache: Cache<String, u32> = Cache::new(64);
    for i in 0..16 {
        cache.insert(format!("k{i:02}"), i);
    }
    cache.enable_indexes();

    let page = cache.query_keys(&filter(3)).unwrap();
    assert_eq!(
        page.rows.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(),
        vec!["k00", "k01", "k02"]
    );
    assert_eq!(page.next_cursor.as_deref(), Some("k02"));
    assert_eq!(page.total, 0);

    let mut counted = filter(3);
    counted.with_total = true;
    let all = cache.query_keys(&counted).unwrap();
    assert_eq!(all.rows.len(), 3, "a total never widens the returned page");
    assert_eq!(all.total, 16);
    assert_eq!(
        all.next_cursor.as_deref(),
        Some("k02"),
        "a total does not hide the fact that a next page exists"
    );
}

#[test]
fn a_small_allow_list_is_sorted_and_the_cursor_seeks_it() {
    let mut cache: Cache<String, u32> = Cache::new(64);
    for i in 0..16 {
        cache.insert(format!("k{i:02}"), i);
    }
    cache.enable_indexes();

    let allowed = ["k10".to_owned(), "k03".to_owned(), "k07".to_owned()];
    let mut f = filter(10);
    f.keys = Some(&allowed);
    let keys = |f: &QueryFilter<'_>| -> Vec<String> {
        cache
            .query_keys(f)
            .unwrap()
            .rows
            .iter()
            .map(|r| r.key.clone())
            .collect()
    };
    assert_eq!(
        keys(&f),
        vec!["k03", "k07", "k10"],
        "allow-list order is key order"
    );

    let cursor = "k05".to_owned();
    f.cursor = Some(&cursor);
    assert_eq!(keys(&f), vec!["k07", "k10"]);
    assert_eq!(
        cache.query_count(&f).unwrap(),
        3,
        "a cursor must not narrow a count"
    );
}

#[test]
fn a_prefix_cursor_seeks_the_contiguous_prefix_region() {
    let mut cache: Cache<String, u32> = Cache::new(64);
    for i in 0..16 {
        cache.insert(format!("k{i:02}"), i);
    }
    cache.enable_indexes();

    let mut f = filter(10);
    f.prefix = Some("k0");
    let keys = |f: &QueryFilter<'_>| -> Vec<String> {
        cache
            .query_keys(f)
            .unwrap()
            .rows
            .iter()
            .map(|r| r.key.clone())
            .collect()
    };
    assert_eq!(
        keys(&f),
        vec![
            "k00", "k01", "k02", "k03", "k04", "k05", "k06", "k07", "k08", "k09"
        ]
    );

    // A cursor before the prefix region adds nothing the prefix bound does not already
    // give; one inside it must seek. Both stop at the end of the region ("k10" excluded).
    let before = "j".to_owned();
    f.cursor = Some(&before);
    assert_eq!(keys(&f).len(), 10);
    let inside = "k04".to_owned();
    f.cursor = Some(&inside);
    assert_eq!(keys(&f), vec!["k05", "k06", "k07", "k08", "k09"]);
}
