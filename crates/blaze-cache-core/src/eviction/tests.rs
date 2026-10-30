//! Unit tests for [`Sieve`] — split out of `eviction.rs`.

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
        .evict_candidate(&mut slab.nodes, Some(now))
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
        .evict_candidate(&mut slab.nodes, Some(now))
        .expect("a is expired");
    assert_eq!(evicted, a, "an expired entry beats a visited one");
    assert!(
        slab.nodes[a].as_ref().unwrap().visited,
        "the hand does not inspect dead nodes"
    );
}

#[test]
fn a_none_clock_treats_every_node_as_live() {
    // `now: None` is the fast path for "this cache has no deadlines at all": even a node
    // that carries a deadline must be treated as live, because the owning cache's
    // `ttl_count` guarantees there are none. Only the visited bit decides.
    let mut slab = Slab::new();
    let mut queue = Sieve::new();
    let (a, b) = (slab.push("a"), slab.push("b"));
    for idx in [a, b] {
        queue.push_back(&mut slab.nodes, idx);
    }
    slab.nodes[a].as_mut().unwrap().visited = true;
    slab.nodes[a].as_mut().unwrap().expires_at = Some(Instant::now());

    let evicted = queue
        .evict_candidate(&mut slab.nodes, None)
        .expect("must evict something");
    assert_eq!(
        evicted, b,
        "with no clock the visited bit alone decides: unvisited b dies first"
    );
    assert!(
        !slab.nodes[a].as_ref().unwrap().visited,
        "the hand passed over a (clearing its bit) instead of reclaiming it as expired — \
         `None` means nothing is expired"
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
