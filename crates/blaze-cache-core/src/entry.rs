//! Per-write options: TTL and tags.

use std::time::Duration;

/// Options applied to a single [`Cache::insert_with`](crate::Cache::insert_with).
///
/// Built with a chainable, move-`self` DSL:
///
/// ```rust
/// use std::time::Duration;
/// use blaze_cache_core::EntryOptions;
///
/// let options = EntryOptions::new()
///     .ttl(Duration::from_secs(30))
///     .tags(["user:42", "profile"]);
/// assert_eq!(options.tags_ref().len(), 2);
/// ```
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EntryOptions {
    ttl: Option<Duration>,
    tags: Vec<String>,
}

impl EntryOptions {
    /// No TTL and no tags.
    pub fn new() -> Self {
        Self::default()
    }

    /// Expire the entry `ttl` after it is written.
    ///
    /// `Duration::ZERO` is ignored — the entry is stored with **no** deadline, exactly as
    /// if `ttl` had never been set (a zero deadline would only create a phantom entry that
    /// expires on the next instruction). Callers that mean "do not cache" should simply
    /// not insert.
    ///
    /// ```rust
    /// use std::time::Duration;
    /// use blaze_cache_core::{Cache, EntryOptions};
    ///
    /// let mut cache = Cache::new(4);
    /// cache.insert_with("forever", 1, EntryOptions::new().ttl(Duration::ZERO));
    /// assert_eq!(cache.get("forever"), Some(&1), "stored, not a no-op");
    /// assert_eq!(cache.meta("forever").unwrap().ttl_remaining, None, "no deadline");
    /// ```
    pub fn ttl(mut self, ttl: Duration) -> Self {
        self.ttl = Some(ttl);
        self
    }

    /// Replace the tag list with `tags`.
    pub fn tags<I, S>(mut self, tags: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        self.tags = tags.into_iter().map(|t| t.as_ref().to_owned()).collect();
        self
    }

    /// Append a single tag (keeps tags added so far).
    pub fn tag(mut self, tag: impl AsRef<str>) -> Self {
        let tag = tag.as_ref();
        if !self.tags.iter().any(|t| t == tag) {
            self.tags.push(tag.to_owned());
        }
        self
    }

    /// The configured TTL, if any.
    pub fn ttl_opt(&self) -> Option<Duration> {
        self.ttl
    }

    /// The configured tags.
    pub fn tags_ref(&self) -> &[String] {
        &self.tags
    }
}

impl From<Duration> for EntryOptions {
    fn from(ttl: Duration) -> Self {
        EntryOptions::new().ttl(ttl)
    }
}
