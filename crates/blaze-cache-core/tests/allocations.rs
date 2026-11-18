//! Regression tests for the "allocation-conscious" tagged-write path.
//!
//! These live in a separate integration-test crate because the library itself forbids
//! `unsafe_code`, which a `GlobalAlloc` implementation needs. Counting is gated by a
//! thread-local flag so the tests can run in parallel without cross-talk.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use blaze_cache_core::{Cache, EntryOptions};

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
