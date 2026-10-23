//! Counters exposed to the host through `stats()`.

use serde::Serialize;

/// A snapshot of a [`Cache`](crate::Cache)'s counters.
///
/// All counters are cumulative since the last [`CacheStats::default`] / reset; `size` and
/// `capacity` describe the current moment.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct CacheStats {
    /// Successful lookups.
    pub hits: u64,
    /// Lookups that found nothing (missing **or** expired).
    pub misses: u64,
    /// Entries dropped because the cache was over [`capacity`](Self::capacity).
    pub evictions: u64,
    /// Entries dropped because their TTL elapsed.
    pub expirations: u64,
    /// Entries dropped explicitly (`remove`, `invalidate_tags`, `clear`).
    pub invalidations: u64,
    /// Live entries (may include not-yet-pruned expired ones).
    pub size: usize,
    /// Maximum number of entries the cache will hold.
    pub capacity: usize,
}

impl CacheStats {
    /// Fraction of lookups that hit, in `0.0..=1.0`. `0.0` when nothing was looked up yet.
    pub fn hit_rate(&self) -> f64 {
        let total = self.hits + self.misses;
        if total == 0 {
            0.0
        } else {
            self.hits as f64 / total as f64
        }
    }
}
