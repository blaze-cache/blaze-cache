//! The intrusive node that links an entry into the SIEVE queue.

use web_time::Instant;

/// One cached entry plus its queue bookkeeping.
///
/// Fields are `pub(crate)` because the queue, the tag index and the cache all manipulate
/// nodes directly; nothing here is part of the public API.
#[derive(Debug)]
pub(crate) struct Node<K, V> {
    pub(crate) key: K,
    pub(crate) value: V,
    pub(crate) prev: Option<usize>,
    pub(crate) next: Option<usize>,
    /// SIEVE "has been touched since the hand last passed" bit.
    pub(crate) visited: bool,
    pub(crate) expires_at: Option<Instant>,
    /// Tag ids from the [`TagIndex`](crate::tags::TagIndex). Empty vec allocates nothing.
    pub(crate) tags: Vec<u32>,
}

impl<K, V> Node<K, V> {
    pub(crate) fn new(key: K, value: V, expires_at: Option<Instant>, tags: Vec<u32>) -> Self {
        Self {
            key,
            value,
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
