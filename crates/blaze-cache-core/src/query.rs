//! Opt-in indexes for bounded queries.
//!
//! Everything in this module is inert until [`Cache::enable_indexes`] is called. The
//! `Option<Box<dyn QueryIndex<K>>>` field on `Cache` is `None` by default, so a cache that
//! never opts in allocates no index and pays one predictable branch per mutation.
//!
//! The concrete index is currently for `String` keys — the only key type the wasm binding
//! uses — but it is held behind a trait object so the generic cache impl keeps its existing
//! `K: Clone + Hash + Eq` bounds.

use std::collections::{BTreeSet, HashMap};
use std::fmt::Debug;

use web_time::Instant;

/// A bounded query over the opt-in indexes. All constraints are ANDed together;
/// `tags.any` / `tags.all` / `tags.none` map to the three tag sets below.
#[derive(Debug, Default)]
pub struct QueryFilter<'a> {
    /// Only keys starting with this prefix.
    pub prefix: Option<&'a str>,
    /// Keep keys carrying at least one of these tags (empty = no constraint).
    pub tags_any: &'a [String],
    /// Keep keys carrying every one of these tags.
    pub tags_all: &'a [String],
    /// Drop keys carrying any of these tags.
    pub tags_none: &'a [String],
    /// Lower bound on remaining TTL in milliseconds (inclusive).
    pub ttl_min_ms: Option<f64>,
    /// Upper bound on remaining TTL in milliseconds (inclusive). Permanent keys are
    /// treated as infinity and are therefore excluded when this is set.
    pub ttl_max_ms: Option<f64>,
    /// Optional allow-list of keys; everything else is ignored.
    pub keys: Option<&'a [String]>,
    /// Page size. A zero limit is rejected with [`QueryError::InvalidLimit`].
    pub limit: usize,
    /// Opaque last-key anchor: keys are returned in **ascending key order**, strictly
    /// after this value. Survivors of a deleted anchor still paginate correctly.
    pub cursor: Option<&'a str>,
    /// Count every match (not just this page). Off by default: it is a full scan.
    pub with_total: bool,
}

/// Metadata returned for one matching key. Values are never fetched here: the host
/// decides whether to request them, and caps them when it does.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryRow {
    pub key: String,
    /// Remaining TTL in milliseconds, or `None` for a permanent entry.
    pub ttl_ms: Option<f64>,
    pub tags: Vec<String>,
}

/// One page of metadata rows plus the opaque cursor for the next page.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryKeysResult {
    pub rows: Vec<QueryRow>,
    /// `Some(key)` when more matches follow this page; pass it back as `cursor`.
    pub next_cursor: Option<String>,
    /// Total matches, populated only when [`QueryFilter::with_total`] was set.
    pub total: usize,
}

/// Guard failures a caller can catch — never silently fall back to an O(n) scan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueryError {
    /// `enable_indexes()` was never called (and no explicit full scan was requested).
    IndexesDisabled,
    /// `limit` must be at least one.
    InvalidLimit,
}

/// The maintenance surface the cache needs from an ordered query index.
pub(crate) trait QueryIndex<K>: Debug {
    /// Registers a newly published entry.
    fn on_insert(&mut self, key: &K, expires_at: Option<Instant>);
    /// Updates an existing entry whose deadline changed (a rewrite or a touch).
    fn on_touch(&mut self, key: &K, old: Option<Instant>, new: Option<Instant>);
    /// Unregisters an entry that is about to leave the slab.
    fn on_remove(&mut self, key: &K, expires_at: Option<Instant>);
    /// Drops every registered key (`Cache::clear`).
    fn clear(&mut self);

    /// Keys in ascending order, including expired-but-unreclaimed ones (callers filter).
    fn ordered_keys(&self) -> Box<dyn Iterator<Item = &str> + '_>;
    /// Deadline order (soonest first), with permanent keys last. Used by TTL-range queries.
    fn ttl_ordered_keys(&self) -> Box<dyn Iterator<Item = &str> + '_>;
    /// Deadline for `key`, or `None` for a permanent (or unknown) key.
    fn deadline_of(&self, key: &str) -> Option<Instant>;
    /// Number of registered keys.
    fn len(&self) -> usize;
}

/// Ordered index for string keys: a `BTreeSet` for prefix/range scans, an expiry-ordered
/// `BTreeSet` plus an O(1) deadline lookup for TTL ranges, and reuse of the cache's
/// [`TagIndex`](crate::tags::TagIndex) for tag constraints (done by the query itself).
#[derive(Debug, Default)]
pub(crate) struct StringQueryIndex {
    keys: BTreeSet<String>,
    deadlines: BTreeSet<(Instant, String)>,
    deadline_by_key: HashMap<String, Instant>,
    permanent: BTreeSet<String>,
}

impl QueryIndex<String> for StringQueryIndex {
    fn on_insert(&mut self, key: &String, expires_at: Option<Instant>) {
        self.keys.insert(key.clone());
        self.set_deadline(key, expires_at);
    }

    fn on_touch(&mut self, key: &String, old: Option<Instant>, new: Option<Instant>) {
        if old != new {
            self.remove_deadline(key, old);
            self.set_deadline(key, new);
        }
    }

    fn on_remove(&mut self, key: &String, expires_at: Option<Instant>) {
        self.keys.remove(key);
        self.remove_deadline(key, expires_at);
    }

    fn clear(&mut self) {
        self.keys.clear();
        self.deadlines.clear();
        self.deadline_by_key.clear();
        self.permanent.clear();
    }

    fn ordered_keys(&self) -> Box<dyn Iterator<Item = &str> + '_> {
        Box::new(self.keys.iter().map(String::as_str))
    }

    fn ttl_ordered_keys(&self) -> Box<dyn Iterator<Item = &str> + '_> {
        // Expiring keys first, by deadline; permanent keys last in ascending key order.
        Box::new(
            self.deadlines
                .iter()
                .map(|(_, key)| key.as_str())
                .chain(self.permanent.iter().map(String::as_str)),
        )
    }

    fn deadline_of(&self, key: &str) -> Option<Instant> {
        self.deadline_by_key.get(key).copied()
    }

    fn len(&self) -> usize {
        self.keys.len()
    }
}

impl StringQueryIndex {
    fn set_deadline(&mut self, key: &String, expires_at: Option<Instant>) {
        match expires_at {
            Some(at) => {
                self.deadlines.insert((at, key.clone()));
                self.deadline_by_key.insert(key.clone(), at);
                self.permanent.remove(key);
            }
            None => {
                self.permanent.insert(key.clone());
            }
        }
    }

    fn remove_deadline(&mut self, key: &String, expires_at: Option<Instant>) {
        if let Some(at) = expires_at {
            self.deadlines.remove(&(at, key.clone()));
            self.deadline_by_key.remove(key);
        } else {
            self.permanent.remove(key);
        }
    }
}
