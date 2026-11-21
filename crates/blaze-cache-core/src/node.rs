//! The intrusive node that links an entry into the SIEVE queue.

use smallvec::SmallVec;
use web_time::Instant;

/// One cached entry plus its queue bookkeeping.
///
/// Fields are `pub(crate)` because the queue, the tag index and the cache all manipulate
/// nodes directly; nothing here is part of the public API.
#[derive(Debug)]
pub(crate) struct Node<K, V> {
    pub(crate) key: K,
    pub(crate) value: V,
    /// Stable, never-reused identity of this entry across slab-slot reuse. JS-authoritative
    /// mode keys its value `Map` by this id so a hot hit can address wasm without marshalling
    /// the key string.
    pub(crate) id: u32,
    pub(crate) prev: Option<usize>,
    pub(crate) next: Option<usize>,
    /// SIEVE "has been touched since the hand last passed" bit.
    pub(crate) visited: bool,
    pub(crate) expires_at: Option<Instant>,
    /// Tag ids from the [`TagIndex`](crate::tags::TagIndex). Empty or ≤2 ids need no heap
    /// allocation, which is the common case and keeps `Node` no larger than it was with a
    /// `Vec` on 64-bit targets.
    pub(crate) tags: SmallVec<[u32; 2]>,
}

impl<K, V> Node<K, V> {
    pub(crate) fn new(
        key: K,
        value: V,
        id: u32,
        expires_at: Option<Instant>,
        tags: SmallVec<[u32; 2]>,
    ) -> Self {
        Self {
            key,
            value,
            id,
            prev: None,
            next: None,
            visited: false,
            expires_at,
            tags,
        }
    }

    /// `true` when the entry has a TTL that elapsed at `now`.
    pub(crate) fn is_expired(&self, now: Instant) -> bool {
        self.expires_at.is_some_and(|at| at <= now)
    }
}
