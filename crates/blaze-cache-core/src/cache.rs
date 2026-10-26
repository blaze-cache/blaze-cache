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
///   trade [`lru`](https://docs.rs/lru) makes. [`peek`](Self::peek) is the read that does not.
/// * [`len`](Self::len) is `O(1)` and counts entries that have expired but were not pruned yet;
///   [`live_len`](Self::live_len) counts only the ones that are actually there.
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
    /// Key → slab slot.
    ///
    /// Uses [`foldhash`] rather than std's default SipHash-1-3: this map is probed on every
    /// read and write, cache keys are short strings, and foldhash keeps per-process random
    /// seeding (hash-flooding resistance) at a fraction of SipHash's cost.
    index: HashMap<K, usize, foldhash::fast::RandomState>,
    queue: Sieve,
    tags: TagIndex,
    capacity: usize,
    stats: CacheStats,
    /// How many stored entries carry an `expires_at` deadline.
    ///
    /// This is the fast-path predicate: when it is `0`, no entry can ever be expired, so the
    /// read paths skip `Instant::now()` — on wasm that clock call is a `performance.now()`
    /// import, i.e. a boundary crossing per operation. Maintained exclusively through
    /// [`shift_ttl`](Self::shift_ttl) so every deadline change flows through one place.
    ttl_count: usize,
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
            index: HashMap::with_capacity_and_hasher(
                capacity,
                foldhash::fast::RandomState::default(),
            ),
            queue: Sieve::new(),
            tags: TagIndex::default(),
            capacity,
            stats: CacheStats::default(),
            ttl_count: 0,
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

    /// Number of stored entries that are present **and** not expired.
    ///
    /// Expired-but-unpruned slots are skipped, so this is the count that `get`, `keys` and
    /// `entries` actually see — unlike [`len`](Self::len), which is `O(1)` and counts them.
    ///
    /// `O(1)` while no entry carries a deadline (`ttl_count == 0`); otherwise a single
    /// oldest-first walk that reads the clock exactly once.
    #[must_use]
    pub fn live_len(&self) -> usize {
        if self.ttl_count == 0 {
            return self.index.len();
        }
        let now = Instant::now();
        let mut count = 0;
        let mut cursor = self.queue_head();
        while let Some(idx) = cursor {
            let node = self.nodes[idx].as_ref().expect("live slot");
            cursor = node.next;
            if !node.is_expired(now) {
                count += 1;
            }
        }
        count
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
        let Some(&idx) = self.index.get(key) else {
            self.stats.misses += 1;
            return None;
        };
        // Fast path: with no deadline on any entry nothing can be expired, so the clock is
        // skipped entirely. On wasm `Instant::now()` is a `performance.now()` import — a
        // boundary crossing per read — which is exactly what this avoids.
        if self.ttl_count > 0 {
            let now = Instant::now();
            if self.nodes[idx].as_ref().expect("live slot").is_expired(now) {
                self.stats.expirations += 1;
                self.stats.misses += 1;
                self.free(idx);
                return None;
            }
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

    /// Fetches a value **without** recording a hit or a miss, and without marking the entry
    /// visited for SIEVE — a look that leaves no footprint.
    ///
    /// An expired entry is simply not there, and nothing is reclaimed: `peek` takes `&self`,
    /// so unlike [`get`](Self::get) it cannot even tidy up behind you. Use it for UI checks
    /// ("is this key here?") where counting the read would skew the hit rate.
    #[must_use]
    pub fn peek<Q>(&self, key: &Q) -> Option<&V>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let idx = *self.index.get(key)?;
        let node = self.nodes[idx].as_ref().expect("live slot");
        if self.ttl_count > 0 && node.is_expired(Instant::now()) {
            return None;
        }
        Some(&node.value)
    }

    /// `true` when the key is present **and** not expired. Never mutates the cache.
    #[must_use]
    pub fn contains_key<Q>(&self, key: &Q) -> bool
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        self.index.get(key).is_some_and(|&idx| {
            // `ttl_count == 0` means no deadline exists anywhere, so the check below could
            // only ever confirm "not expired" — skip the clock call (see `get`).
            self.ttl_count == 0
                || !self.nodes[idx]
                    .as_ref()
                    .expect("live slot")
                    .is_expired(Instant::now())
        })
    }

    /// TTL left and tags for one key, without touching LRU/SIEVE state.
    pub fn meta<Q>(&self, key: &Q) -> Option<EntryMeta>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let idx = *self.index.get(key)?;
        let node = self.nodes[idx].as_ref().expect("live slot");
        if self.ttl_count == 0 {
            // No deadline exists, so `ttl_remaining` is `None` for every node and the
            // expired check cannot trigger — no clock needed (see `get`).
            return Some(self.meta_for(node, None));
        }
        let now = Instant::now();
        if node.is_expired(now) {
            return None;
        }
        Some(self.meta_for(node, Some(now)))
    }

    /// Time left on `key`'s deadline.
    ///
    /// * `Some(None)` — stored, but it carries no deadline (it lives until evicted);
    /// * `Some(Some(d))` — `d` remains before it expires;
    /// * `None` — the key is unknown or already expired.
    ///
    /// Like [`meta`](Self::meta) this is a pure read: no statistics, no eviction state and
    /// nothing reclaimed.
    #[must_use]
    pub fn ttl<Q>(&self, key: &Q) -> Option<Option<Duration>>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let idx = *self.index.get(key)?;
        let node = self.nodes[idx].as_ref().expect("live slot");
        let now = if self.ttl_count == 0 {
            // No deadline exists anywhere, so nothing can be expired and no clock is needed
            // (see `get` for why that call matters on wasm).
            None
        } else {
            let now = Instant::now();
            if node.is_expired(now) {
                return None;
            }
            Some(now)
        };
        Some(ttl_remaining(node, now))
    }

    /// Full view of one key — value, remaining TTL and tags — without touching statistics or
    /// the eviction state. Used by persistence layers to serialise a single entry.
    pub fn entry<Q>(&self, key: &Q) -> Option<EntryView<'_, K, V>>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let idx = *self.index.get(key)?;
        let node = self.nodes[idx].as_ref().expect("live slot");
        let now = if self.ttl_count == 0 {
            None // no deadline anywhere: cannot be expired, `ttl_remaining` is `None`
        } else {
            let now = Instant::now();
            if node.is_expired(now) {
                return None;
            }
            Some(now)
        };
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
                meta: self.meta_for(node, Some(now)),
            });
        }
        out
    }

    /// Builds the public metadata view of a live node.
    ///
    /// `now` is `None` exactly when the cache holds no deadlines (`ttl_count == 0`); see
    /// [`ttl_remaining`].
    fn meta_for(&self, node: &Node<K, V>, now: Option<Instant>) -> EntryMeta {
        EntryMeta {
            ttl_remaining: ttl_remaining(node, now),
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
    ///
    /// Like [`meta`](Self::meta), an expired entry answers `None`: every read in this API
    /// agrees on what "present" means, so code branching on tags can never disagree with
    /// [`get`](Self::get) about the same key.
    pub fn tags_of<Q>(&self, key: &Q) -> Option<Vec<String>>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let idx = *self.index.get(key)?;
        let node = self.nodes[idx].as_ref().expect("live slot");
        if self.ttl_count > 0 && node.is_expired(Instant::now()) {
            return None;
        }
        Some(self.tags.names(&node.tags))
    }

    /// `true` when `key` is present, not expired and carries `tag`.
    ///
    /// Expiry is honoured exactly as in [`get`](Self::get): a key whose TTL elapsed is not
    /// "carrying" anything, so a `has_tag` gate can never take a branch that `get` would
    /// then refuse to back up.
    #[must_use]
    pub fn has_tag<Q>(&self, key: &Q, tag: &str) -> bool
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let Some(id) = self.tags.resolve(tag) else {
            return false;
        };
        let Some(&idx) = self.index.get(key) else {
            return false;
        };
        let Some(node) = self.nodes[idx].as_ref() else {
            return false;
        };
        // `ttl_count == 0` means no deadline exists anywhere: skip the clock (see `get`).
        if self.ttl_count > 0 && node.is_expired(Instant::now()) {
            return false;
        }
        node.tags.contains(&id)
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
        let existing = self.index.get(&key).copied();

        // Make room *before* anything is interned. Eviction forgets a tag once its last
        // member dies, so sweeping between `intern_all` and `attach` would orphan the tag
        // the new node is about to carry: `attach` would find no such id, silently do
        // nothing, and `invalidate_tags` would then never reach this entry. Only new keys
        // need room — a replacement reuses the slot it already occupies.
        if existing.is_none() {
            while self.index.len() >= self.capacity && self.evict_one().is_some() {}
        }

        // The clock is only needed when a TTL is actually requested — a plain write must not
        // pay a wasm→JS `performance.now()` call just to discard the result.
        // `checked_add`: a TTL large enough to overflow the instant range means "centuries
        // from now", and storing no deadline says exactly that — while `+` would panic on
        // nothing more than a caller-supplied `Duration`.
        let expires_at = options
            .ttl_opt()
            .filter(|ttl| !ttl.is_zero())
            .and_then(|ttl| Instant::now().checked_add(ttl));
        let new_tag_ids = self
            .tags
            .intern_all(options.tags_ref().iter().map(String::as_str));

        let previous = match existing {
            Some(idx) => {
                let (old_expires_at, old_tag_ids) = {
                    let node = self.nodes[idx].as_mut().expect("live slot");
                    let old_expires_at = node.expires_at;
                    node.expires_at = expires_at;
                    (
                        old_expires_at,
                        std::mem::replace(&mut node.tags, new_tag_ids.clone()),
                    )
                };
                self.shift_ttl(old_expires_at, expires_at);
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
                // Room was made above, before the tags were interned: a write must never be
                // able to evict the entry it just created, nor orphan the tags it carries.
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
                self.shift_ttl(None, expires_at);
                None
            }
        };

        debug_assert_eq!(self.queue.len(), self.index.len(), "queue/index desync");
        previous
    }

    /// Marks `key` as recently used and optionally renews its deadline, without changing the
    /// stored value.
    ///
    /// "Recently used" means the SIEVE *visited* bit — precisely the protection
    /// [`get`](Self::get) grants, which is what makes the entry survive the next eviction
    /// sweep. The queue itself is never reordered (see [`eviction`](crate::eviction)): SIEVE's
    /// whole point is that a read costs a bit flip, not a relink.
    ///
    /// * `Some(ttl)` — replaces the deadline with `now + ttl`. As in
    ///   [`insert_with`](Self::insert_with), a `Duration::ZERO` means "never expires" and
    ///   drops any deadline already there;
    /// * `None` — the current deadline is left exactly as it is.
    ///
    /// Returns `false` when the key is unknown or already expired: there is nothing to
    /// refresh, and an expired entry is never resurrected.
    pub fn touch<Q>(&mut self, key: &Q, ttl: Option<Duration>) -> bool
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let Some(&idx) = self.index.get(key) else {
            return false;
        };
        // Read the clock only when a deadline exists to check — the same fast path as `get`.
        let now = (self.ttl_count > 0).then(Instant::now);
        if now.is_some_and(|now| self.nodes[idx].as_ref().expect("live slot").is_expired(now)) {
            return false;
        }

        if let Some(ttl) = ttl {
            let base = now.unwrap_or_else(Instant::now);
            // `checked_add` rather than `+`: an overflowing TTL is a caller-supplied
            // `Duration`, and panicking on it would hand any embedder a denial of service.
            // Overflowing means "never in our lifetime" — the same answer a missing
            // deadline gives, which is what a zero TTL already maps to here.
            let new = (!ttl.is_zero()).then(|| base.checked_add(ttl)).flatten();
            let old = {
                let node = self.nodes[idx].as_mut().expect("live slot");
                std::mem::replace(&mut node.expires_at, new)
            };
            self.shift_ttl(old, new);
        }
        self.nodes[idx].as_mut().expect("live slot").visited = true;
        true
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
        // `release()` never runs for these nodes, so reset the fast-path counter here.
        self.ttl_count = 0;
        self.stats.invalidations += dropped;
    }

    // ------------------------------------------------------------- internals

    /// Applies a deadline change to the fast-path counter: `old` → `new`.
    ///
    /// Every path that sets, replaces or drops an entry's `expires_at` funnels through here,
    /// so the invariant "*`ttl_count` equals the number of nodes holding a deadline*" holds
    /// by construction rather than by scattered `+= 1`s. Callers pass `None` for a deadline
    /// that is being removed (or for a brand-new entry that has one).
    fn shift_ttl(&mut self, old: Option<Instant>, new: Option<Instant>) {
        self.ttl_count += new.is_some() as usize;
        self.ttl_count -= old.is_some() as usize;
        debug_assert!(
            self.ttl_count <= self.index.len(),
            "ttl_count exceeds stored entries"
        );
    }

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
        // Single point where an entry dies: keep the fast-path counter in step.
        self.shift_ttl(node.expires_at, None);
        self.index.remove(&node.key);
        for &id in &node.tags {
            self.tags.detach(id, idx);
        }
        self.free.push(idx);
        (node.key, node.value)
    }

    /// Applies SIEVE once and counts *why* the entry died.
    fn evict_one(&mut self) -> Option<(K, V)> {
        // No deadline anywhere → nothing can be expired, so the sweep takes no clock (the
        // hand's visited-bit logic is time-independent). See `get` for the rationale.
        let now = (self.ttl_count > 0).then(Instant::now);
        let idx = self.queue.evict_candidate(&mut self.nodes, now)?;
        let was_expired =
            now.is_some_and(|now| self.nodes[idx].as_ref().expect("live slot").is_expired(now));
        let pair = self.release(idx); // `evict_candidate` already unlinked it
        if was_expired {
            self.stats.expirations += 1;
        } else {
            self.stats.evictions += 1;
        }
        Some(pair)
    }
}

/// Time left on `node`'s deadline at `now`.
///
/// `now` is `None` exactly when the owning cache holds no deadlines (`ttl_count == 0`);
/// `expires_at` is then `None` for every node too, so the answer is `None` either way — which
/// is what lets those call sites skip the clock without ever producing a wrong answer.
fn ttl_remaining<K, V>(node: &Node<K, V>, now: Option<Instant>) -> Option<Duration> {
    node.expires_at
        .zip(now)
        .map(|(at, now)| at.saturating_duration_since(now))
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
mod tests;
