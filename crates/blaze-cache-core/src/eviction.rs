//! The SIEVE eviction queue.
//!
//! SIEVE keeps a queue ordered **oldest → newest** and walks it with a `hand` cursor:
//!
//! * a cache hit only sets `visited = true` on the node — the queue is *never* reordered,
//!   which is what makes reads cheaper than LRU;
//! * eviction advances the hand: if the node under it is visited (or expired) the bit is
//!   cleared and the hand moves on, otherwise the node is unlinked and returned;
//! * the cursor persists **between** eviction calls, so a hot entry only loses its protection
//!   when the hand actually reaches it again.
//!
//! New entries are appended at the tail with `visited = false`, so the queue doubles as an
//! insertion-order log and the eviction side stays purely FIFO-ish.
//!
//! The queue only stores indices; the nodes themselves live in the cache's slab. Methods take
//! the slab as an argument so `self` and the nodes never fight over the borrow checker.

use web_time::Instant;

use crate::node::Node;

/// Doubly linked SIEVE queue over a slab of nodes.
#[derive(Debug, Default)]
pub(crate) struct Sieve {
    /// Oldest end — where eviction starts.
    head: Option<usize>,
    /// Newest end — where inserts land.
    tail: Option<usize>,
    /// Persistent eviction cursor. `None` means "start from the head".
    hand: Option<usize>,
    len: usize,
}

impl Sieve {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn len(&self) -> usize {
        self.len
    }

    /// Oldest entry — where iteration and eviction start.
    pub(crate) fn head(&self) -> Option<usize> {
        self.head
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Appends `idx` at the newest end, marking it unvisited.
    pub(crate) fn push_back<K, V>(&mut self, nodes: &mut [Option<Node<K, V>>], idx: usize) {
        debug_assert!(nodes[idx].is_some());
        if let Some(prev) = self.tail {
            nodes[prev].as_mut().expect("live tail").next = Some(idx);
        } else {
            self.head = Some(idx);
        }
        let node = nodes[idx].as_mut().expect("live node");
        node.prev = self.tail;
        node.next = None;
        node.visited = false;
        self.tail = Some(idx);
        self.len += 1;
    }

    /// `true` when `idx` is currently part of the queue.
    ///
    /// A head/tail comparison alone is not enough: in a queue of three or more, a *middle*
    /// node is linked but is neither end, and skipping its unlink would free a slab slot its
    /// neighbours still point at (the next [`unlink`](Self::unlink) then panics on
    /// `live prev`). So the node's own links are consulted too — `O(1)` either way.
    pub(crate) fn is_linked<K, V>(&self, nodes: &[Option<Node<K, V>>], idx: usize) -> bool {
        if self.head == Some(idx) || self.tail == Some(idx) {
            return true;
        }
        nodes
            .get(idx)
            .and_then(|slot| slot.as_ref())
            .is_some_and(|node| node.prev.is_some() || node.next.is_some())
    }

    /// Detaches `idx` from the queue without freeing its slab slot.
    pub(crate) fn unlink<K, V>(&mut self, nodes: &mut [Option<Node<K, V>>], idx: usize) {
        let (prev, next) = {
            let node = nodes[idx].as_mut().expect("unlink of a free slot");
            let (prev, next) = (node.prev, node.next);
            node.prev = None;
            node.next = None;
            (prev, next)
        };
        match prev {
            Some(p) => nodes[p].as_mut().expect("live prev").next = next,
            None => self.head = next,
        }
        match next {
            Some(n) => nodes[n].as_mut().expect("live next").prev = prev,
            None => self.tail = prev,
        }
        if self.hand == Some(idx) {
            // Keep the cursor on a live node (or `None`, which wraps back to the head).
            self.hand = next;
        }
        self.len -= 1;
    }

    /// Runs the SIEVE scan and returns the index of a node to drop, already unlinked.
    ///
    /// Expired entries are always reclaimed first — they are dead regardless of `visited`,
    /// so there is no reason to give them another sweep.
    pub(crate) fn evict_candidate<K, V>(
        &mut self,
        nodes: &mut [Option<Node<K, V>>],
        now: Instant,
    ) -> Option<usize> {
        if self.is_empty() {
            return None;
        }
        // Every pass either evicts or clears a visited bit, so two sweeps always suffice.
        let limit = self.len * 2 + 2;
        for _ in 0..limit {
            let idx = match self.hand.or(self.head) {
                Some(i) if i < nodes.len() && nodes[i].is_some() => i,
                // Defensive: the cursor went stale; restart from the oldest entry.
                _ => {
                    self.hand = None;
                    continue;
                }
            };
            let (next, dead) = {
                let node = nodes[idx].as_ref().expect("checked above");
                (node.next, node.is_expired(now) || !node.visited)
            };
            // Park the cursor first so `unlink` can advance it if we reclaim this node.
            self.hand = Some(idx);
            if dead {
                self.unlink(nodes, idx);
                return Some(idx);
            }
            nodes[idx].as_mut().expect("checked above").visited = false;
            self.hand = next;
        }
        // Unreachable while the queue invariants hold; fall back to the oldest entry.
        let head = self.head?;
        self.unlink(nodes, head);
        Some(head)
    }

    /// Oldest-first indices — the hand's natural scanning order.
    #[cfg(test)]
    fn iter<'a, K, V>(&'a self, nodes: &'a [Option<Node<K, V>>]) -> Vec<usize> {
        let mut out = Vec::with_capacity(self.len);
        let mut cursor = self.head;
        while let Some(idx) = cursor {
            out.push(idx);
            cursor = nodes[idx].as_ref().expect("live node").next;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    struct Slab {
        nodes: Vec<Option<Node<&'static str, u32>>>,
    }

    impl Slab {
        fn new() -> Self {
            Self { nodes: Vec::new() }
        }
        fn push(&mut self, key: &'static str) -> usize {
            self.nodes.push(Some(Node::new(key, 0, None, Vec::new())));
            self.nodes.len() - 1
        }
    }

    #[test]
    fn appends_newest_at_the_tail() {
        let mut slab = Slab::new();
        let mut queue = Sieve::new();
        let (a, b, c) = (slab.push("a"), slab.push("b"), slab.push("c"));
        for idx in [a, b, c] {
            queue.push_back(&mut slab.nodes, idx);
        }
        assert_eq!(queue.iter(&slab.nodes), vec![a, b, c]);
        assert_eq!(queue.len(), 3);
    }

    #[test]
    fn unlinks_from_the_middle_and_both_ends() {
        let mut slab = Slab::new();
        let mut queue = Sieve::new();
        let (a, b, c) = (slab.push("a"), slab.push("b"), slab.push("c"));
        for idx in [a, b, c] {
            queue.push_back(&mut slab.nodes, idx);
        }
        queue.unlink(&mut slab.nodes, b);
        assert_eq!(queue.iter(&slab.nodes), vec![a, c]);

        queue.unlink(&mut slab.nodes, a); // head
        assert_eq!(queue.iter(&slab.nodes), vec![c]);
        assert!(!queue.is_empty());

        queue.unlink(&mut slab.nodes, c); // tail
        assert!(queue.is_empty());
        assert_eq!(queue.len(), 0);
        assert_eq!(queue.head, None);
        assert_eq!(queue.tail, None);
    }

    #[test]
    fn hand_clears_visited_bits_before_reusing_a_protected_entry() {
        let mut slab = Slab::new();
        let mut queue = Sieve::new();
        let (a, b, c) = (slab.push("a"), slab.push("b"), slab.push("c"));
        for idx in [a, b, c] {
            queue.push_back(&mut slab.nodes, idx);
        }
        // Everything is hot: the first sweep can only clear bits, the second must evict.
        for idx in [a, b, c] {
            slab.nodes[idx].as_mut().unwrap().visited = true;
        }
        let now = Instant::now();
        let evicted = queue
            .evict_candidate(&mut slab.nodes, now)
            .expect("must evict something");
        assert_eq!(
            evicted, a,
            "the oldest entry is reclaimed on the second sweep"
        );
        assert!(
            !slab.nodes[b].as_ref().unwrap().visited,
            "hand cleared b on the way"
        );
        assert_eq!(queue.iter(&slab.nodes), vec![b, c]);
    }

    #[test]
    fn expired_entries_are_preferred_over_visited_ones() {
        let mut slab = Slab::new();
        let mut queue = Sieve::new();
        let (a, b) = (slab.push("a"), slab.push("b"));
        for idx in [a, b] {
            queue.push_back(&mut slab.nodes, idx);
        }
        slab.nodes[a].as_mut().unwrap().visited = true;
        // A deadline in the past is expressed as "any future `now` sees it as elapsed".
        slab.nodes[a].as_mut().unwrap().expires_at = Some(Instant::now());
        let now = Instant::now() + Duration::from_secs(60);
        let evicted = queue
            .evict_candidate(&mut slab.nodes, now)
            .expect("a is expired");
        assert_eq!(evicted, a, "an expired entry beats a visited one");
        assert!(
            slab.nodes[a].as_ref().unwrap().visited,
            "the hand does not inspect dead nodes"
        );
    }

    #[test]
    fn hand_is_repointed_when_its_own_node_is_unlinked() {
        let mut slab = Slab::new();
        let mut queue = Sieve::new();
        let (a, b, c) = (slab.push("a"), slab.push("b"), slab.push("c"));
        for idx in [a, b, c] {
            queue.push_back(&mut slab.nodes, idx);
        }
        // Park the cursor directly on `b`, then unlink `b` out from under it.
        queue.hand = Some(b);
        queue.unlink(&mut slab.nodes, b);
        assert_eq!(queue.hand, Some(c), "the cursor follows the successor");

        queue.unlink(&mut slab.nodes, c);
        assert_eq!(queue.hand, None, "falls back to a full sweep from the head");
        assert_eq!(queue.iter(&slab.nodes), vec![a]);
    }
}
