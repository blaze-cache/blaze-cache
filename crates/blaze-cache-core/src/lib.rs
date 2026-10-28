//! # blaze-cache-core
//!
//! The engine behind **Blaze Cache**: a small, allocation-conscious in-memory cache with
//! per-entry TTLs, tag-based invalidation and the [SIEVE] eviction policy.
//!
//! The crate is `no-frills` on purpose: it has no threads, no async runtime and no I/O.
//! Everything that touches the outside world (WebAssembly bindings, IndexedDB persistence,
//! HTTP adapters) lives in the layers above it.
//!
//! ## Design
//!
//! * **Storage** — entries live in a slab (`Vec<Option<Node<K, V>>>`) with a free list, so
//!   nodes never move and eviction is `O(1)`. A `HashMap<K, usize>` (seeded by [foldhash])
//!   maps keys to slots.
//! * **Eviction** — the [SIEVE] queue is a doubly linked list ordered *oldest → newest* with a
//!   persistent `hand` cursor. Reads only flip a `visited` bit; they never reorder the list,
//!   which makes reads cheaper than LRU while behaving better than FIFO.
//! * **Expiry** — `web_time::Instant` (monotonic, works on `wasm32-unknown-unknown`). Expired
//!   entries are dropped lazily on access, opportunistically during eviction, or in bulk via
//!   [`Cache::prune`]. A counter of entries that actually hold a deadline lets every read skip
//!   the clock entirely when no TTL is in play — on wasm that call is a `performance.now()`
//!   import, i.e. a JS boundary crossing per operation.
//! * **Tags** — entries may declare string tags. [`Cache::invalidate_tags`] removes every entry
//!   carrying any of the given tags in `O(members)` time.
//!
//! ```rust
//! use std::time::Duration;
//! use blaze_cache_core::{Cache, EntryOptions};
//!
//! let mut cache = Cache::new(1024);
//! cache.insert("greeting", "hello");
//! cache.insert_with(
//!     "user:1",
//!     r#"{"name":"Ada"}"#,
//!     EntryOptions::new().ttl(Duration::from_secs(60)).tag("user:1"),
//! );
//!
//! assert_eq!(cache.get("greeting"), Some(&"hello"));
//! assert_eq!(cache.invalidate_tags(["user:1"]), vec!["user:1"]);
//! assert_eq!(cache.len(), 1);
//! ```
//!
//! [SIEVE]: https://www.usenix.org/conference/fast24/presentation/yang
#![forbid(unsafe_code)]

mod cache;
mod entry;
mod eviction;
mod node;
mod stats;
mod tags;

pub use cache::{Cache, DropReason, Dropped, EntryMeta, EntryView};
pub use entry::EntryOptions;
pub use stats::CacheStats;

/// Number of entries held by [`Cache::default`].
pub const DEFAULT_CAPACITY: usize = 1024;
