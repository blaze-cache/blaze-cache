//! Stress tests for the cache's hand-built memory structures.
//!
//! Safe Rust rules out the classic memory-safety bugs (use-after-free, double-free, buffer
//! overflows) at compile time, but this cache layers its own memory management on top of a
//! `Vec` slab: a free list, intrusive queue links, an interned tag index, a TTL counter and an
//! optional drop log. A logic error there surfaces as a leaked value, a dangling slot index,
//! a cycle in the queue or unbounded growth under churn. Every test below audits those
//! structures directly; the randomized one does so after *every* operation.
//!
//! The same suite can be run under Miri for extra confidence in the dependencies:
//! `cargo +nightly miri test -p blaze-cache-core`.

use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const TAGS: &[&str] = &["alpha", "beta", "gamma", "delta", "zeta"];

/// Deterministic xorshift64* so a failure can be reproduced from its seed.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed | 1)
    }

    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: usize) -> usize {
        debug_assert!(n > 0);
        (self.next() % n as u64) as usize
    }
}

/// A value that reports its own lifetime, so leaks and double-drops are observable.
#[derive(Debug)]
struct Tracked {
    id: u64,
    live: Arc<AtomicUsize>,
    ledger: Arc<Mutex<HashSet<u64>>>,
}

impl Tracked {
    fn new(id: u64, live: &Arc<AtomicUsize>, ledger: &Arc<Mutex<HashSet<u64>>>) -> Self {
        live.fetch_add(1, Ordering::SeqCst);
        Self {
            id,
            live: Arc::clone(live),
            ledger: Arc::clone(ledger),
        }
    }
}

impl Drop for Tracked {
    fn drop(&mut self) {
        let first_time = self
            .ledger
            .lock()
            .expect("drop ledger poisoned")
            .insert(self.id);
        assert!(first_time, "value {} was dropped twice", self.id);
        self.live.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Full structural audit of an `Cache`, using the private fields the test module can see.
fn audit<K, V>(cache: &Cache<K, V>)
where
    K: Clone + Hash + Eq,
{
    // Every slab slot is either live (in the index) or free, never both and never neither.
    assert_eq!(
        cache.nodes.len(),
        cache.index.len() + cache.free.len(),
        "slab accounting drifted"
    );
    let mut free = HashSet::new();
    for &idx in &cache.free {
        assert!(idx < cache.nodes.len(), "free index out of bounds");
        assert!(free.insert(idx), "duplicate free index {idx}");
        assert!(cache.nodes[idx].is_none(), "free index holds a live node");
    }

    let mut live = HashSet::with_capacity(cache.index.len());
    let mut deadlines = 0;
    for (key, &idx) in &cache.index {
        assert!(idx < cache.nodes.len(), "index points past the slab");
        assert!(live.insert(idx), "two keys share one slab slot");
        let node = cache.nodes[idx]
            .as_ref()
            .expect("index points at a free slot");
        assert!(node.key == *key, "index key and node key disagree");
        deadlines += usize::from(node.expires_at.is_some());
    }
    assert_eq!(deadlines, cache.ttl_count, "ttl fast-path counter drifted");

    let live_nodes: Vec<(usize, &[u32])> = live
        .iter()
        .map(|&idx| {
            (
                idx,
                cache.nodes[idx]
                    .as_ref()
                    .expect("live slot")
                    .tags
                    .as_slice(),
            )
        })
        .collect();
    cache.queue.debug_check(&cache.nodes, &live);
    cache.tags.debug_check(&live_nodes);
    assert!(
        cache.drops.len() <= 64 * 1024,
        "drop log exceeded its soft cap"
    );
}

/// Push one random node's deadline into the past without sleeping. `shift_ttl` keeps the
/// fast-path counter honest, so the rest of the audit still applies.
fn poison_expiry(cache: &mut Cache<String, Tracked>, rng: &mut Rng) {
    let slots: Vec<usize> = cache.index.values().copied().collect();
    let Some(&idx) = slots.get(rng.below(slots.len().max(1))) else {
        return;
    };
    let old = cache.nodes[idx].as_ref().expect("live slot").expires_at;
    let past = Instant::now()
        .checked_sub(Duration::from_secs(1))
        .unwrap_or_else(Instant::now);
    let new = Some(past);
    cache.nodes[idx].as_mut().expect("live slot").expires_at = new;
    cache.shift_ttl(old, new);
}

fn value(id: u64, live: &Arc<AtomicUsize>, ledger: &Arc<Mutex<HashSet<u64>>>) -> Tracked {
    Tracked::new(id, live, ledger)
}

fn run(seed: u64, steps: usize) {
    let mut rng = Rng::new(seed);
    let live = Arc::new(AtomicUsize::new(0));
    let ledger = Arc::new(Mutex::new(HashSet::new()));
    let mut next_id = 0;
    let mut cache: Cache<String, Tracked> = Cache::new(1 + rng.below(24));

    for step in 0..steps {
        let key = format!("k{}", rng.below(48));
        match rng.below(100) {
            0..=29 => {
                let mut options = EntryOptions::new();
                for &name in TAGS.iter().take(rng.below(4)) {
                    options = options.tag(name);
                }
                if rng.below(4) == 0 {
                    options = options.ttl(Duration::from_millis((rng.below(4) + 1) as u64));
                }
                cache.insert_with(key, value(next_id, &live, &ledger), options);
                next_id += 1;
            }
            30..=39 => {
                cache.insert_borrowed(&key, value(next_id, &live, &ledger), EntryOptions::new());
                next_id += 1;
            }
            40..=54 => {
                cache.get(&key);
            }
            55..=62 => {
                cache.peek(&key);
            }
            63..=66 => {
                let _ = cache.contains_key(&key);
            }
            67..=72 => {
                let ttl = (rng.below(2) == 0).then(|| Duration::from_millis(rng.below(5) as u64));
                cache.touch(&key, ttl);
            }
            73..=80 => {
                cache.remove(&key);
            }
            81..=88 => {
                let tags: Vec<&str> = (0..1 + rng.below(3))
                    .map(|_| TAGS[rng.below(TAGS.len())])
                    .collect();
                cache.invalidate_tags(tags);
            }
            89..=92 => {
                cache.prune();
            }
            93..=95 => {
                cache.set_capacity(1 + rng.below(24));
            }
            96..=97 => {
                cache.clear();
            }
            98 => {
                let _ = cache.entries();
                let _ = cache.keys().count();
                let _ = cache.stats();
            }
            99 => {
                if cache.drop_tracking() {
                    drop(cache.drain_drops());
                    if rng.below(2) == 0 {
                        cache.set_drop_tracking(false);
                    }
                } else {
                    cache.set_drop_tracking(true);
                }
            }
            _ => unreachable!(),
        }

        if step % 41 == 0 {
            poison_expiry(&mut cache, &mut rng);
        }
        audit(&cache);
    }

    cache.set_drop_tracking(false); // clears any drops still recorded
    drop(cache);
    assert_eq!(
        live.load(Ordering::SeqCst),
        0,
        "some values were never dropped"
    );
    assert_eq!(
        ledger.lock().expect("drop ledger poisoned").len() as u64,
        next_id,
        "not every value was dropped exactly once"
    );
}

#[test]
fn randomized_churn_preserves_every_internal_invariant() {
    // Miri interprets every operation, so allow a shorter run there while keeping the full
    // sweep on ordinary `cargo test`.
    let steps = std::env::var("BLAZE_STRESS_STEPS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(2000);
    for seed in [
        0x9E37_79B9_7F4A_7C15,
        0xD1B5_4A32_D192_ED03,
        0x0123_4567_89AB_CDEF,
        0xDEAD_BEEF_CAFE_F00D,
    ] {
        run(seed, steps);
    }
}

#[test]
fn a_corrupt_eviction_cursor_is_recovered_instead_of_dereferenced() {
    let mut cache: Cache<u32, u32> = Cache::new(4);
    for i in 0..4 {
        cache.insert(i, i * 10);
    }

    // An out-of-bounds cursor must be treated as "restart from the head", not indexed.
    cache.queue.set_hand(Some(999));
    cache.set_capacity(3);
    audit(&cache);
    assert_eq!(cache.len(), 3);

    // Neither may a cursor that names a real but *free* slab slot.
    cache.remove(&1);
    let free_slot = *cache.free.last().expect("freed slot");
    cache.queue.set_hand(Some(free_slot));
    cache.set_capacity(1);
    audit(&cache);
    assert_eq!(cache.len(), 1);
}

#[test]
fn the_drop_log_cannot_grow_without_bound() {
    let mut cache: Cache<u64, u64> = Cache::new(1);
    cache.set_drop_tracking(true);
    for i in 0..70_000 {
        cache.insert(i, i);
    }
    assert_eq!(cache.drops.len(), 64 * 1024, "soft cap not respected");
    cache.set_drop_tracking(false);
    assert!(cache.drops.is_empty(), "disabling tracking clears the log");
}

#[test]
fn repeated_churn_reuses_the_slab_and_forgets_unused_tags() {
    let mut cache: Cache<String, u32> = Cache::new(16);
    for _ in 0..200 {
        for i in 0..16 {
            cache.insert_with(format!("k{i}"), i, EntryOptions::new().tag("t").tag("u"));
        }
        for i in 0..16 {
            cache.remove(&format!("k{i}"));
        }
        audit(&cache);
    }
    assert_eq!(cache.nodes.len(), 16, "slab must reuse freed slots");
    assert_eq!(cache.free.len(), 16);
    assert!(cache.index.is_empty());
    assert!(cache.tags.resolve("t").is_none(), "tag leaked");
    assert!(cache.tags.resolve("u").is_none(), "tag leaked");
    cache.tags.debug_check(&[]);
}
