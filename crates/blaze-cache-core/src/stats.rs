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
        // Saturating: a cache that somehow survives 2^64 lookups must not panic (debug)
        // or wrap to zero (release) in an observational method.
        let total = self.hits.saturating_add(self.misses);
        if total == 0 {
            0.0
        } else {
            self.hits as f64 / total as f64
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hit_rate_saturates_instead_of_overflowing() {
        let stats = CacheStats {
            hits: u64::MAX,
            misses: u64::MAX,
            ..CacheStats::default()
        };
        // The saturated total equals `hits`, so the ratio is 1.0 — the point is that
        // the method returns a finite value in range instead of panicking/wrapping.
        let rate = stats.hit_rate();
        assert!(rate.is_finite() && (0.0..=1.0).contains(&rate));
        assert_eq!(rate, 1.0);
        assert_eq!(CacheStats::default().hit_rate(), 0.0);
    }
}
