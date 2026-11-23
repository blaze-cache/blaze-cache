//! Regression tests for the "allocation-conscious" tagged-write path.
//!
//! These live in a separate integration-test crate because the library itself forbids
//! `unsafe_code`, which a `GlobalAlloc` implementation needs. Counting is gated by a
//! thread-local flag so the tests can run in parallel without cross-talk.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use blaze_cache_core::{Cache, EntryOptions, QueryFilter};

thread_local! {
    static COUNT: Cell<usize> = const { Cell::new(0) };
    static BYTES: Cell<usize> = const { Cell::new(0) };
    static TRACK: Cell<bool> = const { Cell::new(false) };
}

struct Counting;

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if TRACK.with(|t| t.get()) {
            COUNT.with(|c| c.set(c.get() + 1));
            BYTES.with(|b| b.set(b.get() + layout.size()));
        }
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if TRACK.with(|t| t.get()) {
            COUNT.with(|c| c.set(c.get() + 1));
            BYTES.with(|b| b.set(b.get() + new_size));
        }
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

fn count<R>(f: impl FnOnce() -> R) -> (R, usize) {
    COUNT.with(|c| c.set(0));
    BYTES.with(|b| b.set(0));
    TRACK.with(|t| t.set(true));
    let result = f();
    TRACK.with(|t| t.set(false));
    let used = COUNT.with(|c| c.get());
    (result, used)
}

fn count_bytes<R>(f: impl FnOnce() -> R) -> (R, usize) {
    COUNT.with(|c| c.set(0));
    BYTES.with(|b| b.set(0));
    TRACK.with(|t| t.set(true));
    let result = f();
    TRACK.with(|t| t.set(false));
    let used = BYTES.with(|b| b.get());
    (result, used)
}

#[test]
fn construction_does_not_reserve_the_full_capacity() {
    let (cache, bytes) = count_bytes(|| Cache::<String, u32>::new(1_000_000));
    assert_eq!(cache.capacity(), 1_000_000, "capacity is a logical ceiling");
    assert!(
        bytes < 1_000_000,
        "a million-slot declaration allocated {bytes} bytes before any insert"
    );

    // The index still grows on demand all the way past the initial reservation.
    let mut cache = cache;
    for i in 0..2_000 {
        cache.insert(i.to_string(), i);
    }
    assert_eq!(cache.len(), 2_000);
}

#[test]
fn overwrite_with_inline_tags_does_not_allocate() {
    let mut cache = Cache::new(4);
    let options = EntryOptions::new().tags(["a", "b"]);
    cache.insert_with("k", 1_u32, options.clone());

    let (displaced, allocations) = count(|| cache.insert_with("k", 2_u32, options));
    assert_eq!(displaced, Some(1));
    assert_eq!(allocations, 0, "≤2 tag ids must stay inline on overwrite");
}

#[test]
fn overwrite_with_spilled_tags_allocates_only_once() {
    let mut cache = Cache::new(4);
    let options = EntryOptions::new().tags(["a", "b", "c", "d", "e"]);
    cache.insert_with("k", 1_u32, options.clone());

    let (displaced, allocations) = count(|| cache.insert_with("k", 2_u32, options));
    assert_eq!(displaced, Some(1));
    // `intern_all` still grows one heap-backed id vector for five tags. The old code cloned
    // that vector again to fill the node, making this two; moving it into the node makes one.
    assert!(allocations <= 1, "overwrite cloned the interned id vector");
}

#[test]
fn by_id_lookups_do_not_allocate() {
    use blaze_cache_core::EntryOptions;

    let mut cache = Cache::new(16);
    cache.enable_ids();
    let id = cache.insert_with_id("k", 7_u32, EntryOptions::new()).1;
    // Warm up any lazy index growth before counting.
    for _ in 0..8 {
        let _ = cache.get_by_id(id);
    }

    let (alive, allocations) = count(|| cache.get_by_id(id));
    assert!(alive);
    assert_eq!(allocations, 0, "a hot by-id hit must not allocate");
}

#[test]
fn indexes_off_keep_the_hot_path_allocation_free() {
    let mut cache = Cache::<String, u32>::new(8);
    cache.insert("k".into(), 1_u32);
    assert!(!cache.indexes_enabled());
    let options = EntryOptions::new();

    let (_, allocations) = count(|| {
        cache.insert_borrowed("k", 2_u32, options.clone());
        let _ = cache.get("k");
        let _ = cache.peek("k");
        let _ = cache.keys().count();
    });
    assert_eq!(
        allocations, 0,
        "an opted-out cache must not allocate for indexes"
    );
}

#[test]
fn indexes_on_backfill_and_return_only_the_requested_page() {
    let mut cache = Cache::<String, u32>::new(8);
    for i in 0..8_u32 {
        cache.insert(i.to_string(), i);
    }
    cache.enable_indexes();
    assert_eq!(cache.indexed_key_count(), Some(8));

    let filter = QueryFilter {
        limit: 2,
        ..QueryFilter::default()
    };
    let page = cache
        .query_keys(&filter)
        .expect("indexed query should work");
    assert_eq!(
        page.rows.len(),
        2,
        "a page never materialises the whole keyspace"
    );
    assert_eq!(page.next_cursor.as_deref(), Some("1"));
}

#[test]
fn byte_region_reuse_does_not_allocate() {
    use blaze_cache_core::bytes::{reserve, with_region};

    let reservation = reserve(128);
    let (ptr, len) = (reservation.ptr, reservation.len);
    let bytes = reservation.adopt(ptr, len).unwrap();
    assert_eq!(with_region(ptr, len, |b| b.len()), Some(len));
    drop(bytes); // region returns to the free list

    // First reuse must come from the free list, not a new chunk or Vec growth.
    let (reservation, allocations) = count(|| reserve(128));
    assert_eq!(
        allocations, 0,
        "a freed region is reused without allocating"
    );
    drop(reservation);
}
