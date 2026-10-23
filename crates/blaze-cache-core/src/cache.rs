//! The cache itself: slab storage, hash index, SIEVE queue and tag bookkeeping.

use std::borrow::Borrow;
use std::collections::{HashMap, HashSet};
use std::hash::Hash;
use std::time::Duration;

use web_time::Instant;

use crate::DEFAULT_CAPACITY;
use crate::entry::EntryOptions;
use crate::eviction::Sieve;
use crate::node::Node;
use crate::stats::CacheStats;
use crate::tags::TagIndex;

/// Remaining lifetime and tags of a live entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryMeta {
    /// Time left before the entry expires, or `None` when it never expires.
    pub ttl_remaining: Option<Duration>,
    /// Tags currently attached to the entry.
    pub tags: Vec<String>,
}

/// A borrowed snapshot of one live entry, as returned by [`Cache::entries`].
#[derive(Debug)]
pub struct EntryView<'a, K, V> {
    pub key: &'a K,
    pub value: &'a V,
    pub meta: EntryMeta,
}

/// An in-memory cache with per-entry TTLs, tag invalidation and SIEVE eviction.
///
/// `K` must be cheaply cloneable: every key is stored once in the hash index and once inside
/// its slab node so that eviction can unregister itself without re-hashing. Keys are almost
/// always short strings, so this is a good trade.
///
/// # Behaviour
///
/// * Lookups take `&mut self` because a hit marks the entry as *visited* for SIEVE — the same
///   trade [`lru`](https://docs.rs/lru) makes.
/// * [`len`](Self::len) is `O(1)` and counts entries that have expired but were not pruned yet.
/// * Writes never allocate more than one node; capacity pressure evicts during the write.
///
/// ```rust
/// use std::time::Duration;
/// use blaze_cache_core::{Cache, EntryOptions};
///
/// let mut cache = Cache::new(2);
/// cache.insert("a", 1);
/// cache.insert("b", 2);
/// cache.insert("c", 3); // "a" is evicted: nothing was visited
/// assert_eq!(cache.get("a"), None);
///
/// cache.get("b"); // mark "b" visited
/// cache.insert_with("d", 4, EntryOptions::new().ttl(Duration::from_secs(5)));
/// assert_eq!(cache.get("c"), None, "the unvisited entry goes first");
/// assert_eq!(cache.get("b"), Some(&2));
/// ```
#[derive(Debug)]
pub struct Cache<K, V> {
    nodes: Vec<Option<Node<K, V>>>,
    free: Vec<usize>,
    index: HashMap<K, usize>,
    queue: Sieve,
    tags: TagIndex,
    capacity: usize,
    stats: CacheStats,
}

impl<K, V> Cache<K, V>
where
    K: Clone + Hash + Eq,
{
    /// Creates a cache holding at most `capacity` entries.
    ///
    /// `capacity` is clamped to at least `1`.
    pub fn new(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        Self {
            nodes: Vec::new(),
            free: Vec::new(),
            index: HashMap::with_capacity(capacity),
            queue: Sieve::new(),
            tags: TagIndex::default(),
            capacity,
            stats: CacheStats::default(),
        }
    }

    /// Maximum number of entries. See [`DEFAULT_CAPACITY`].
    #[must_use]
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Live entries. May include entries whose TTL elapsed but that nobody touched yet.
    #[must_use]
    pub fn len(&self) -> usize {
        self.index.len()
    }

    /// `true` when no entry is stored.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.index.is_empty()
    }

    /// Current counters.
    #[must_use]
    pub fn stats(&self) -> CacheStats {
        CacheStats {
            size: self.index.len(),
            capacity: self.capacity,
            ..self.stats
        }
    }

    /// Zeroes the cumulative counters. Does not touch stored entries.
    pub fn reset_stats(&mut self) {
        self.stats = CacheStats::default();
    }

    /// Shrinks (or grows) the cache, evicting entries until it fits the new capacity.
    pub fn set_capacity(&mut self, capacity: usize) {
        self.capacity = capacity.max(1);
        while self.index.len() > self.capacity && self.evict_one().is_some() {}
    }

    // ---------------------------------------------------------------- reads

    /// Fetches a value, marking it *visited* for SIEVE.
    ///
    /// An expired entry counts as a miss and is removed eagerly.
    pub fn get<Q>(&mut self, key: &Q) -> Option<&V>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let now = Instant::now();
        let Some(&idx) = self.index.get(key) else {
            self.stats.misses += 1;
            return None;
        };
        if self.nodes[idx].as_ref().expect("live slot").is_expired(now) {
            self.stats.expirations += 1;
            self.stats.misses += 1;
            self.free(idx);
            return None;
        }
        self.nodes[idx].as_mut().expect("live slot").visited = true;
        self.stats.hits += 1;
        Some(&self.nodes[idx].as_ref().expect("live slot").value)
    }

    /// [`get`](Self::get) followed by a clone — convenient across API boundaries.
    pub fn get_cloned<Q>(&mut self, key: &Q) -> Option<V>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
        V: Clone,
    {
        self.get(key).cloned()
    }

    /// `true` when the key is present **and** not expired. Never mutates the cache.
    #[must_use]
    pub fn contains_key<Q>(&self, key: &Q) -> bool
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let now = Instant::now();
        self.index
            .get(key)
            .is_some_and(|&idx| !self.nodes[idx].as_ref().expect("live slot").is_expired(now))
    }

    /// TTL left and tags for one key, without touching LRU/SIEVE state.
    pub fn meta<Q>(&self, key: &Q) -> Option<EntryMeta>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let now = Instant::now();
        let idx = *self.index.get(key)?;
        let node = self.nodes[idx].as_ref().expect("live slot");
        if node.is_expired(now) {
            return None;
        }
        Some(self.meta_for(node, now))
    }

    /// Full view of one key — value, remaining TTL and tags — without touching statistics or
    /// the eviction state. Used by persistence layers to serialise a single entry.
    pub fn entry<Q>(&self, key: &Q) -> Option<EntryView<'_, K, V>>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let now = Instant::now();
        let idx = *self.index.get(key)?;
        let node = self.nodes[idx].as_ref().expect("live slot");
        if node.is_expired(now) {
            return None;
        }
        Some(EntryView {
            key: &node.key,
            value: &node.value,
            meta: self.meta_for(node, now),
        })
    }

    /// Snapshot of every live (non-expired) entry, oldest first.
    ///
    /// Used by persistence layers to serialise the cache in one pass.
    pub fn entries(&self) -> Vec<EntryView<'_, K, V>> {
        let now = Instant::now();
        let mut out = Vec::with_capacity(self.index.len());
        let mut cursor = self.queue_head();
        while let Some(idx) = cursor {
            let node = self.nodes[idx].as_ref().expect("live slot");
            cursor = node.next;
            if node.is_expired(now) {
                continue;
            }
            out.push(EntryView {
                key: &node.key,
                value: &node.value,
                meta: self.meta_for(node, now),
            });
        }
        out
    }

    /// Builds the public metadata view of a live node.
    fn meta_for(&self, node: &Node<K, V>, now: Instant) -> EntryMeta {
        EntryMeta {
            ttl_remaining: node.expires_at.map(|at| at.saturating_duration_since(now)),
            tags: self.tags.names(&node.tags),
        }
    }

    /// Keys of every live entry, in queue (oldest-first) order.
    pub fn keys(&self) -> impl Iterator<Item = &K> {
        let now = Instant::now();
        let mut cursor = self.queue_head();
        std::iter::from_fn(move || {
            while let Some(idx) = cursor {
                let node = self.nodes[idx].as_ref().expect("live slot");
                cursor = node.next;
                if !node.is_expired(now) {
                    return Some(&node.key);
                }
            }
            None
        })
    }

    /// Every key carrying `tag`, ignoring expired entries.
    pub fn keys_with_tag(&self, tag: &str) -> Vec<&K> {
        let now = Instant::now();
        self.tags
            .members(tag)
            .into_iter()
            .filter_map(|idx| self.nodes[idx].as_ref())
            .filter(|node| !node.is_expired(now))
            .map(|node| &node.key)
            .collect()
    }

    /// Tags currently attached to `key`.
    pub fn tags_of<Q>(&self, key: &Q) -> Option<Vec<String>>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let idx = *self.index.get(key)?;
        Some(
            self.tags
                .names(&self.nodes[idx].as_ref().expect("live slot").tags),
        )
    }

    /// `true` when `key` is present and carries `tag`.
    #[must_use]
    pub fn has_tag<Q>(&self, key: &Q, tag: &str) -> bool
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let Some(id) = self.tags.resolve(tag) else {
            return false;
        };
        self.index.get(key).is_some_and(|&idx| {
            self.nodes[idx]
                .as_ref()
                .is_some_and(|n| n.tags.contains(&id))
        })
    }

    // --------------------------------------------------------------- writes

    /// Stores `key` with no TTL and no tags. See [`insert_with`](Self::insert_with).
    pub fn insert(&mut self, key: K, value: V) {
        self.insert_with(key, value, EntryOptions::new());
    }

    /// Stores (or replaces) `key`, returning the value it displaced.
    ///
    /// A `Duration::ZERO` TTL is ignored — it would expire on the next instruction and only
    /// create a phantom entry. Callers that mean "do not cache" should simply not insert.
    ///
    /// Re-inserting an existing key refreshes its value, its deadline **and** its tags, and
    /// re-queues it as the newest entry (unvisited).
    pub fn insert_with(&mut self, key: K, value: V, options: EntryOptions) -> Option<V> {
        let now = Instant::now();
        let expires_at = options
            .ttl_opt()
            .filter(|ttl| !ttl.is_zero())
            .map(|ttl| now + ttl);
        let new_tag_ids = self
            .tags
            .intern_all(options.tags_ref().iter().map(String::as_str));

        let previous = match self.index.get(&key).copied() {
            Some(idx) => {
                let old_tag_ids = {
                    let node = self.nodes[idx].as_mut().expect("live slot");
                    node.expires_at = expires_at;
                    std::mem::replace(&mut node.tags, new_tag_ids.clone())
                };
                for &id in &old_tag_ids {
                    if !new_tag_ids.contains(&id) {
                        self.tags.detach(id, idx);
                    }
                }
                for &id in &new_tag_ids {
                    if !old_tag_ids.contains(&id) {
                        self.tags.attach(id, idx);
                    }
                }
                // A write makes the entry the newest one; it has not been visited yet.
                self.queue.unlink(&mut self.nodes, idx);
                self.queue.push_back(&mut self.nodes, idx);
                Some(std::mem::replace(
                    &mut self.nodes[idx].as_mut().expect("live slot").value,
                    value,
                ))
            }
            None => {
                // Make room *before* publishing the node: a write must never be able to
                // evict the entry it just created.
                while self.index.len() >= self.capacity && self.evict_one().is_some() {}
                let node = Node::new(key.clone(), value, expires_at, new_tag_ids.clone());
                let idx = match self.free.pop() {
                    Some(idx) => {
                        self.nodes[idx] = Some(node);
                        idx
                    }
                    None => {
                        self.nodes.push(Some(node));
                        self.nodes.len() - 1
                    }
                };
                self.index.insert(key, idx);
                for &id in &new_tag_ids {
                    self.tags.attach(id, idx);
                }
                self.queue.push_back(&mut self.nodes, idx);
                None
            }
        };

        debug_assert_eq!(self.queue.len(), self.index.len(), "queue/index desync");
        previous
    }

    /// Removes `key`, returning its value.
    pub fn remove<Q>(&mut self, key: &Q) -> Option<V>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let idx = *self.index.get(key)?;
        let (_, value) = self.free(idx);
        self.stats.invalidations += 1;
        Some(value)
    }

    /// Removes every entry carrying any of `tags`, returning the removed keys.
    ///
    /// Runs in `O(total members)` — no scan of the whole cache.
    pub fn invalidate_tags<I, S>(&mut self, tags: I) -> Vec<K>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut members: HashSet<usize> = HashSet::new();
        for tag in tags {
            members.extend(self.tags.members(tag.as_ref()));
        }
        let mut removed = Vec::with_capacity(members.len());
        for idx in members {
            let (key, _) = self.free(idx);
            removed.push(key);
        }
        self.stats.invalidations += removed.len() as u64;
        removed
    }

    /// Removes every entry whose TTL elapsed, returning the removed keys.
    ///
    /// Expired entries are also reclaimed lazily on access and opportunistically during
    /// eviction; call this when you want the cache *observed* to be clean right now.
    pub fn prune(&mut self) -> Vec<K> {
        let now = Instant::now();
        let expired: Vec<usize> = self
            .nodes
            .iter()
            .enumerate()
            .filter_map(|(idx, slot)| slot.as_ref().filter(|n| n.is_expired(now)).map(|_| idx))
            .collect();
        let mut removed = Vec::with_capacity(expired.len());
        for idx in expired {
            let (key, _) = self.free(idx);
            removed.push(key);
        }
        self.stats.expirations += removed.len() as u64;
        removed
    }

    /// Drops everything and counts the dropped entries as invalidations.
    pub fn clear(&mut self) {
        let dropped = self.index.len() as u64;
        self.nodes.clear();
        self.free.clear();
        self.index.clear();
        self.queue = Sieve::new();
        self.tags.clear();
        self.stats.invalidations += dropped;
    }

    // ------------------------------------------------------------- internals

    /// Oldest-first entry point for iteration (the SIEVE queue head).
    fn queue_head(&self) -> Option<usize> {
        self.queue.head()
    }

    /// Unlinks `idx` if it is still linked, then frees its slab slot.
    fn free(&mut self, idx: usize) -> (K, V) {
        if self.queue.is_linked(&self.nodes, idx) {
            self.queue.unlink(&mut self.nodes, idx);
        }
        self.release(idx)
    }

    /// Removes `idx` from the index and slab. The caller must have unlinked it already.
    fn release(&mut self, idx: usize) -> (K, V) {
        let node = self.nodes[idx].take().expect("release of a free slot");
        self.index.remove(&node.key);
        for &id in &node.tags {
            self.tags.detach(id, idx);
        }
        self.free.push(idx);
        (node.key, node.value)
    }

    /// Applies SIEVE once and counts *why* the entry died.
    fn evict_one(&mut self) -> Option<(K, V)> {
        let now = Instant::now();
        let idx = self.queue.evict_candidate(&mut self.nodes, now)?;
        let was_expired = self.nodes[idx].as_ref().expect("live slot").is_expired(now);
        let pair = self.release(idx); // `evict_candidate` already unlinked it
        if was_expired {
            self.stats.expirations += 1;
        } else {
            self.stats.evictions += 1;
        }
        Some(pair)
    }
}

impl<K, V> Default for Cache<K, V>
where
    K: Clone + Hash + Eq,
{
    fn default() -> Self {
        Self::new(DEFAULT_CAPACITY)
    }
}

#[cfg(test)]
mod tests {
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
}
