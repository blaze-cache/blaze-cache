//! wasm-bindgen bindings for [`blaze-cache-core`].
//!
//! The exported [`BlazeCache`] class is what `@blaze-cache/core` drives from TypeScript.
//! Design notes:
//!
//! * **Keys are `String`, values are `JsValue`** — JS objects are passed by reference and are
//!   *never* cloned or serialised on the hot path, which keeps `get`/`set` allocation-free.
//! * **TTLs are milliseconds on the boundary** (`Option<f64>`) but stay monotonic
//!   [`Instant`](web_time::Instant) deadlines inside the core, so a system clock adjustment
//!   cannot silently extend or truncate an entry's life.
//! * **Bulk operations return `Vec<String>`** (`invalidate_tags`, `prune`) so the host knows
//!   exactly which keys disappeared — that is what keeps IndexedDB in sync.
//!
//! The crate is `#![forbid(unsafe_code)]`: the raw-key bindings used to decode host-supplied
//! pointers with `from_raw_parts`/`from_utf8_unchecked`, which allowed out-of-bounds reads
//! and invalid `&str`s. `with_raw_key` now validates every pointer/length in safe Rust, and
//! this attribute keeps that guarantee from regressing at compile time.
#![forbid(unsafe_code)]
#![allow(clippy::unused_unit)]

use js_sys::Array;
use std::cell::RefCell;
use std::time::Duration;

use blaze_cache_core::bytes as arena;
use blaze_cache_core::{BytesRef, Cache, EntryOptions};
use wasm_bindgen::prelude::*;

/// Hard ceiling for a JS-supplied capacity: enough for any realistic workload. The core
/// reserves only a small fixed index up front, so this is a logical bound, not an allocation.
pub const MAX_CAPACITY: usize = 1_000_000;

thread_local! {
    /// Host-writable bytes the `*Raw` methods read keys from — the storage behind
    /// [`ensureScratch`]. Module-global (one per wasm instance, shared by every
    /// `BlazeCache`), which is exactly what lets the TypeScript wrapper keep a single
    /// "last encoded key" cache across cache instances.
    static KEY_SCRATCH: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// What a cache entry holds.
///
/// `Ref` is the default: a `JsValue` externref held by reference, never cloned or serialised.
/// `Bytes` is the opt-in binary mode: an owning region in Wasm linear memory whose coordinates
/// JS can read into a zero-copy `Uint8Array` view. Keeping both behind one enum means the
/// metadata/eviction/stat machinery is shared; only the value-facing methods branch.
#[derive(Debug)]
enum Value {
    Ref(JsValue),
    Bytes(BytesRef),
}

impl Value {
    /// The externref, when this entry was written with `set` — never a bytes entry.
    fn as_ref_value(&self) -> Option<&JsValue> {
        match self {
            Value::Ref(value) => Some(value),
            Value::Bytes(_) => None,
        }
    }

    /// The byte coordinates, when this entry was written with `setBytes`.
    fn as_bytes(&self) -> Option<(usize, usize)> {
        match self {
            Value::Bytes(bytes) => Some((bytes.ptr, bytes.len)),
            Value::Ref(_) => None,
        }
    }

    /// A structured-cloneable view for `entry()`/`entries()`/drop events and persistence.
    /// Bytes are copied here on purpose: a snapshot must outlive the next arena reuse.
    fn to_js(&self) -> JsValue {
        match self {
            Value::Ref(value) => value.clone(),
            Value::Bytes(bytes) => match arena::to_vec(bytes.ptr, bytes.len) {
                Some(owned) => js_sys::Uint8Array::from(owned.as_slice()).into(),
                None => JsValue::UNDEFINED,
            },
        }
    }
}

/// A JavaScript-visible Blaze Cache.
#[wasm_bindgen]
pub struct BlazeCache {
    inner: Cache<String, Value>,
}

#[wasm_bindgen]
impl BlazeCache {
    /// Creates a cache that holds at most `capacity` entries.
    ///
    /// `capacity` arrives as a JS `Number`, so it is validated before anything else sees it:
    ///
    /// * non-finite (`NaN`, `Infinity`) — meaningless as a size, falls back to the default;
    /// * below `1` — clamped up to `1`, exactly as the core clamps `0`; note this also
    ///   covers negatives, which JS→integer conversion would otherwise deliver as ~4.29e9;
    /// * above [`MAX_CAPACITY`] — clamped down, because `capacity()` reports it back and
    ///   nobody builds a browser cache meant to hold a billion entries.
    ///
    /// The core reserves at most a small fixed number of index buckets, so even an
    /// unvalidated number cannot abort the instance with a huge up-front allocation.
    #[wasm_bindgen(constructor)]
    pub fn new(capacity: f64) -> BlazeCache {
        let capacity = if !capacity.is_finite() {
            blaze_cache_core::DEFAULT_CAPACITY
        } else if capacity < 1.0 {
            1
        } else if capacity > MAX_CAPACITY as f64 {
            MAX_CAPACITY
        } else {
            // Both bounds checked against the f64: `as usize` on wasm32 truncates modulo
            // 2³² rather than saturating, so narrowing first would wrap instead of clamp.
            capacity as usize
        };
        BlazeCache {
            inner: Cache::new(capacity),
        }
    }

    /// Returns the value stored under `key`, or `undefined` when it is missing/expired.
    ///
    /// A hit marks the entry *visited* for SIEVE, so this takes `&mut self`.
    #[wasm_bindgen(js_name = get)]
    pub fn get(&mut self, key: &str) -> Option<JsValue> {
        self.inner.get(key).and_then(Value::as_ref_value).cloned()
    }

    /// Same lookup as [`get`](Self::get) — **without** recording a hit or a miss, and without
    /// marking the entry visited for SIEVE.
    ///
    /// The read for "is this here?" questions: it leaves the hit rate and the eviction order
    /// exactly as it found them, and it never reclaims an expired entry.
    #[wasm_bindgen(js_name = peek)]
    pub fn peek(&self, key: &str) -> Option<JsValue> {
        self.inner.peek(key).and_then(Value::as_ref_value).cloned()
    }

    /// Milliseconds until `key` expires, or `undefined` when it carries no TTL or the key is
    /// missing/expired. Purely observational: statistics and eviction state are untouched.
    #[wasm_bindgen(js_name = ttl)]
    pub fn ttl(&self, key: &str) -> Option<f64> {
        self.inner
            .ttl(key)
            .flatten()
            .map(|ttl| ttl.as_millis() as f64)
    }

    /// Stores `value` under `key`.
    ///
    /// * `ttlMs` — milliseconds until expiry. `undefined`, `null`, `0` and negatives all mean
    ///   "no expiry".
    /// * `tags` — tag names for bulk invalidation via [`invalidate_tags`](Self::invalidate_tags).
    ///
    /// Replacing a key refreshes its TTL **and** its tags, and re-queues it as the newest
    /// entry. Capacity pressure is applied before the new node becomes visible, so a write
    /// can never evict itself. The key is looked up by slice first, so an overwrite never
    /// allocates a `String` just to throw it away again.
    #[wasm_bindgen(js_name = set)]
    pub fn set(&mut self, key: &str, value: JsValue, ttl_ms: Option<f64>, tags: Vec<String>) {
        let mut options = EntryOptions::new().tags(tags);
        if let Some(ms) = ttl_ms {
            if ms.is_finite() && ms > 0.0 {
                options = options.ttl(Duration::from_millis((ms as u64).max(1)));
            }
        }
        self.inner.insert_borrowed(key, Value::Ref(value), options);
    }

    /// Batch get: looks up every key in one boundary crossing. Returns `JsValue::UNDEFINED`
    /// for missing or expired entries. Each hit marks the entry visited for SIEVE.
    #[wasm_bindgen(js_name = getMany)]
    pub fn get_many(&mut self, keys: Vec<String>) -> Vec<JsValue> {
        keys.iter()
            .map(|k| {
                self.inner
                    .get(k)
                    .and_then(Value::as_ref_value)
                    .cloned()
                    .unwrap_or(JsValue::UNDEFINED)
            })
            .collect()
    }

    /// Batch set: stores every key/value pair in one boundary crossing.
    ///
    /// `ttl_ms[i] < 0` means no expiry. `tag_offsets[i]`..`tag_offsets[i+1]` index into
    /// `tags_flat` for the tags of entry `i`. Those offsets come from JS, so they are
    /// clamped rather than trusted: a non-monotonic or out-of-range pair yields no tags
    /// for that entry instead of panicking and trapping the wasm instance. Keys are looked
    /// up by slice, so overwriting an existing key pays no key allocation.
    #[wasm_bindgen(js_name = setMany)]
    pub fn set_many(
        &mut self,
        keys: Vec<String>,
        values: JsValue,
        ttl_ms: Vec<f64>,
        tags_flat: Vec<String>,
        tag_offsets: Vec<usize>,
    ) {
        let values_arr = Array::from(&values);
        let len = keys
            .len()
            .min(values_arr.length() as usize)
            .min(ttl_ms.len());
        for i in 0..len {
            // JS supplies these offsets, so they are clamped instead of trusted: a
            // non-monotonic pair (end < start) or one reaching past `tags_flat` would
            // otherwise panic mid-slice and trap the whole wasm instance. Bad input
            // degrades to "no tags for this entry", matching how short arrays above are
            // already tolerated.
            let flat_len = tags_flat.len();
            let start = tag_offsets.get(i).copied().unwrap_or(0).min(flat_len);
            let end = tag_offsets
                .get(i + 1)
                .copied()
                .unwrap_or(start)
                .clamp(start, flat_len);
            let entry_tags = &tags_flat[start..end];

            let mut options = EntryOptions::new().tags(entry_tags.iter().map(|s| s.as_str()));
            let ms = ttl_ms[i];
            if ms.is_finite() && ms > 0.0 {
                options = options.ttl(Duration::from_millis((ms as u64).max(1)));
            }
            let value = values_arr.get(i as u32);
            self.inner
                .insert_borrowed(keys[i].as_str(), Value::Ref(value), options);
        }
    }

    /// Batch has: returns `1` for each key that is present and not expired, `0` otherwise.
    #[wasm_bindgen(js_name = hasMany)]
    pub fn has_many(&self, keys: Vec<String>) -> Vec<u8> {
        keys.iter()
            .map(|k| if self.inner.contains_key(k) { 1 } else { 0 })
            .collect()
    }

    /// Batch delete: returns `1` for each key that was present, `0` otherwise.
    #[wasm_bindgen(js_name = deleteMany)]
    pub fn delete_many(&mut self, keys: Vec<String>) -> Vec<u8> {
        keys.iter()
            .map(|k| if self.inner.remove(k).is_some() { 1 } else { 0 })
            .collect()
    }
    /// Marks `key` as recently used for eviction and optionally renews its TTL — the stored
    /// value is never changed. Returns `false` when the key is missing or expired.
    ///
    /// * `ttlMs` — `undefined`/`null` leaves the current deadline alone; a positive finite
    ///   number replaces it with "now + ttlMs"; `0`, negatives and `NaN` drop the deadline
    ///   (never expires), the same reading [`set`](Self::set) gives them.
    #[wasm_bindgen(js_name = touch)]
    pub fn touch(&mut self, key: &str, ttl_ms: Option<f64>) -> bool {
        let ttl = ttl_ms.map(|ms| {
            if ms.is_finite() && ms > 0.0 {
                // Same rounding-up rule as `set`: a positive TTL must never truncate to
                // zero, which the core would read as "drop the deadline".
                Duration::from_millis((ms as u64).max(1))
            } else {
                Duration::ZERO
            }
        });
        self.inner.touch(key, ttl)
    }

    /// `true` when `key` is present and not expired. Does not affect eviction state.
    #[wasm_bindgen(js_name = has)]
    pub fn has(&self, key: &str) -> bool {
        self.inner.contains_key(key)
    }

    /// Removes `key`, returning whether it was there.
    #[wasm_bindgen(js_name = delete)]
    pub fn delete(&mut self, key: &str) -> bool {
        self.inner.remove(key).is_some()
    }

    // -------------------------------------------------------- binary value mode (opt-in)

    /// The `WebAssembly.Memory` backing this instance, so JS can build `Uint8Array` views of
    /// regions reserved by [`bytes_reserve`](Self::bytes_reserve).
    #[wasm_bindgen(js_name = wasmMemory)]
    pub fn wasm_memory() -> JsValue {
        wasm_bindgen::memory()
    }

    /// Reserves `len` bytes in the shared arena and returns their absolute pointer.
    ///
    /// JS writes the payload into `new Uint8Array(memory.buffer, ptr, len)` and passes the same
    /// `(ptr, len)` to [`set_bytes`](Self::set_bytes), which adopts the reservation and stores
    /// it as the entry's value. No JS object is serialised: the bytes are already in linear
    /// memory. A reservation that is never adopted simply stays reserved for the lifetime of
    /// the instance (a fixed, bounded cost per abandoned `setBytes`).
    #[wasm_bindgen(js_name = bytesReserve)]
    pub fn bytes_reserve(len: usize) -> u32 {
        arena::reserve_for_host(len)
    }

    /// Adopts a reserved byte region as the value for `key`.
    ///
    /// Every coordinate is validated against the arena before ownership is taken: a stale or
    /// out-of-range `(ptr, len)` stores nothing and returns `false` instead of trapping.
    #[wasm_bindgen(js_name = setBytes)]
    pub fn set_bytes(
        &mut self,
        key: &str,
        ptr: u32,
        len: u32,
        ttl_ms: Option<f64>,
        tags: Vec<String>,
    ) -> bool {
        // `bytesReserve` is the only way to obtain a live reservation; validate by attempting
        // adoption. On failure the reservation simply drops and frees its region.
        let bytes = match arena::adopt(ptr as usize, len as usize) {
            Some(bytes) => bytes,
            None => return false,
        };
        let mut options = EntryOptions::new().tags(tags);
        if let Some(ms) = ttl_ms {
            if ms.is_finite() && ms > 0.0 {
                options = options.ttl(Duration::from_millis((ms as u64).max(1)));
            }
        }
        self.inner
            .insert_borrowed(key, Value::Bytes(bytes), options);
        true
    }

    /// Returns `[ptr, len]` for a bytes entry, or `undefined` when the key is missing or was
    /// written with `set` instead of `setBytes`. A hit marks the entry visited for SIEVE.
    ///
    /// The coordinates are stable across `memory.grow`, but JS `ArrayBuffer` views are detached
    /// by it — rebuild the view from the current `wasmMemory().buffer` before each read, and
    /// never retain a view across an allocation. Use `getBytesCopy` for a long-lived snapshot.
    #[wasm_bindgen(js_name = getBytes)]
    pub fn get_bytes(&mut self, key: &str) -> Option<Array> {
        let coordinates = self.inner.get(key)?.as_bytes()?;
        let out = Array::new();
        out.push(&JsValue::from_f64(coordinates.0 as f64));
        out.push(&JsValue::from_f64(coordinates.1 as f64));
        Some(out)
    }

    /// Like [`get_bytes`](Self::get_bytes) but returns an **owned copy** as a `Uint8Array`.
    ///
    /// Safe to retain: the copy is outside the arena and survives eviction, reuse and
    /// `memory.grow`. This is the escape hatch for long-lived reads of byte values.
    #[wasm_bindgen(js_name = getBytesCopy)]
    pub fn get_bytes_copy(&mut self, key: &str) -> Option<js_sys::Uint8Array> {
        let (ptr, len) = self.inner.get(key)?.as_bytes()?;
        arena::to_vec(ptr, len).map(|owned| js_sys::Uint8Array::from(owned.as_slice()))
    }

    // --------------------------------------------------- JS-authoritative metadata mode

    /// Turns on the stable-id index before the first write (`storage: 'js'` only).
    ///
    /// The default mode never calls this, so the id map — and the hash on every insert and
    /// release it entails — is completely absent from the default hot path.
    #[wasm_bindgen(js_name = enableIds)]
    pub fn enable_ids(&mut self) {
        self.inner.enable_ids();
    }

    /// Inserts a sentinel-only entry and returns its stable id, for `storage: 'js'`.
    ///
    /// The value lives in a JS `Map<id, V>`; wasm keeps keys, TTL, tags, SIEVE and the id index.
    /// An overwrite keeps the same id so JS can replace the value in place.
    #[wasm_bindgen(js_name = setMeta)]
    pub fn set_meta(&mut self, key: &str, ttl_ms: Option<f64>, tags: Vec<String>) -> u32 {
        let mut options = EntryOptions::new().tags(tags);
        if let Some(ms) = ttl_ms {
            if ms.is_finite() && ms > 0.0 {
                options = options.ttl(Duration::from_millis((ms as u64).max(1)));
            }
        }
        self.inner
            .insert_borrowed_id(key, Value::Ref(JsValue::UNDEFINED), options)
            .1
    }

    /// Batch form of [`set_meta`](Self::set_meta), returning one id per entry.
    #[wasm_bindgen(js_name = setManyMeta)]
    pub fn set_many_meta(
        &mut self,
        keys: Vec<String>,
        ttl_ms: Vec<f64>,
        tags_flat: Vec<String>,
        tag_offsets: Vec<usize>,
    ) -> Vec<u32> {
        let flat_len = tags_flat.len();
        keys.iter()
            .enumerate()
            .map(|(i, key)| {
                let start = tag_offsets.get(i).copied().unwrap_or(0).min(flat_len);
                let end = tag_offsets
                    .get(i + 1)
                    .copied()
                    .unwrap_or(start)
                    .clamp(start, flat_len);
                let mut options =
                    EntryOptions::new().tags(tags_flat[start..end].iter().map(String::as_str));
                let ms = ttl_ms.get(i).copied().unwrap_or(-1.0);
                if ms.is_finite() && ms > 0.0 {
                    options = options.ttl(Duration::from_millis((ms as u64).max(1)));
                }
                self.inner
                    .insert_borrowed_id(key, Value::Ref(JsValue::UNDEFINED), options)
                    .1
            })
            .collect()
    }

    /// Hit/miss + SIEVE visit for a JS-owned id. No key string crosses the boundary.
    #[wasm_bindgen(js_name = getById)]
    pub fn get_by_id(&mut self, id: u32) -> bool {
        self.inner.get_by_id(id)
    }

    /// Observational presence check by id (no stats, no eviction bookkeeping).
    #[wasm_bindgen(js_name = peekById)]
    pub fn peek_by_id(&self, id: u32) -> bool {
        self.inner.peek_by_id(id)
    }

    /// `true` when `id` is present and not expired.
    #[wasm_bindgen(js_name = hasById)]
    pub fn has_by_id(&self, id: u32) -> bool {
        self.inner.has_by_id(id)
    }

    /// Counts a miss for an absent key that was resolved locally, with no wasm lookup.
    #[wasm_bindgen(js_name = recordMiss)]
    pub fn record_miss(&mut self) {
        self.inner.record_miss();
    }

    /// Metadata for one key with its stable id, for `entry()` in JS-authoritative mode.
    /// The `value` field is `undefined`: JS fills it from its own `Map<id, V>`.
    #[wasm_bindgen(js_name = entryMeta)]
    pub fn entry_meta(&self, key: &str) -> JsValue {
        let Some(entry) = self.inner.entry(key) else {
            return JsValue::UNDEFINED;
        };
        entry_meta_object(
            entry.key,
            entry.id,
            entry.meta.ttl_remaining,
            &entry.meta.tags,
        )
        .into()
    }

    /// Metadata for every live entry with its stable id, for `entries()` in JS mode.
    #[wasm_bindgen(js_name = entriesMeta)]
    pub fn entries_meta(&self) -> Array {
        let out = Array::new();
        for entry in self.inner.entries() {
            out.push(&entry_meta_object(
                entry.key,
                entry.id,
                entry.meta.ttl_remaining,
                &entry.meta.tags,
            ));
        }
        out
    }

    /// [`get`](Self::get) with the key already encoded into wasm memory by the host.
    ///
    /// The TypeScript wrapper encodes each distinct key once into the shared scratch (see
    /// [`ensureScratch`]) and passes the offset/length, so a repeat lookup costs no
    /// `passStringToWasm0` allocation — that malloc + copy + free was the single largest
    /// component of a read.
    ///
    /// # Host contract
    ///
    /// `ptr`/`len` must address `len` bytes of valid UTF-8 in the current scratch buffer.
    /// The wrapper only ever passes bytes it encoded from a JS string (ASCII fast path or
    /// `TextEncoder`). Anything else — a stale pointer after a scratch reallocation, an
    /// out-of-range length, invalid UTF-8 — is treated as a miss instead of undefined
    /// behaviour (see [`with_raw_key`]).
    #[wasm_bindgen(js_name = getRaw)]
    pub fn get_raw(&mut self, ptr: u32, len: u32) -> Option<JsValue> {
        with_raw_key(ptr, len, |key| {
            self.inner.get(key).and_then(Value::as_ref_value).cloned()
        })
        .flatten()
    }

    /// [`set`](Self::set) with a pre-encoded key and **no tags** — the untagged write fast
    /// path. Untagged writes skip the `Vec<String>` boundary crossing entirely; use
    /// [`set`](Self::set) when the entry carries tags.
    #[wasm_bindgen(js_name = setRaw)]
    pub fn set_raw(&mut self, ptr: u32, len: u32, value: JsValue, ttl_ms: Option<f64>) {
        let _ = with_raw_key(ptr, len, |key| {
            let mut options = EntryOptions::new();
            if let Some(ms) = ttl_ms {
                if ms.is_finite() && ms > 0.0 {
                    options = options.ttl(Duration::from_millis((ms as u64).max(1)));
                }
            }
            self.inner.insert_borrowed(key, Value::Ref(value), options);
        });
    }

    /// [`delete`](Self::delete) with a pre-encoded key. See [`getRaw`](Self::get_raw) for
    /// the host contract.
    #[wasm_bindgen(js_name = deleteRaw)]
    pub fn delete_raw(&mut self, ptr: u32, len: u32) -> bool {
        with_raw_key(ptr, len, |key| self.inner.remove(key).is_some()).unwrap_or(false)
    }

    /// Full view of one key — value, remaining TTL (ms) and tags — or `undefined` when the key
    /// is missing or expired. Does not affect statistics or eviction state.
    #[wasm_bindgen(js_name = entry)]
    pub fn entry(&self, key: &str) -> JsValue {
        match self.inner.entry(key) {
            Some(entry) => entry_object(
                entry.key,
                entry.value.to_js(),
                entry.meta.ttl_remaining,
                &entry.meta.tags,
            )
            .into(),
            None => JsValue::UNDEFINED,
        }
    }

    /// Tags currently attached to `key` (empty array when the key is unknown).
    #[wasm_bindgen(js_name = tagsOf)]
    pub fn tags_of(&self, key: &str) -> Vec<String> {
        self.inner.tags_of(key).unwrap_or_default()
    }

    /// `true` when `key` carries `tag`.
    #[wasm_bindgen(js_name = hasTag)]
    pub fn has_tag(&self, key: &str, tag: &str) -> bool {
        self.inner.has_tag(key, tag)
    }

    /// Every live key, oldest first. Expired-but-unpruned entries are skipped.
    #[wasm_bindgen(js_name = keys)]
    pub fn keys(&self) -> Vec<String> {
        self.inner.keys().cloned().collect()
    }

    /// Every live key carrying `tag`.
    #[wasm_bindgen(js_name = keysWithTag)]
    pub fn keys_with_tag(&self, tag: &str) -> Vec<String> {
        self.inner.keys_with_tag(tag).into_iter().cloned().collect()
    }

    /// Full snapshot — `{ key, value, ttlMs, tags }` for every live entry, oldest first.
    ///
    /// This is what persistence layers hydrate from; it crosses the WASM boundary exactly
    /// once instead of once per key.
    #[wasm_bindgen(js_name = entries)]
    pub fn entries(&self) -> js_sys::Array {
        let out = js_sys::Array::new();
        for entry in self.inner.entries() {
            out.push(&entry_object(
                entry.key,
                entry.value.to_js(),
                entry.meta.ttl_remaining,
                &entry.meta.tags,
            ));
        }
        out
    }

    /// Removes every entry carrying any of `tags`, returning the removed keys so the host can
    /// drop them from its persistence layer.
    #[wasm_bindgen(js_name = invalidateTags)]
    pub fn invalidate_tags(&mut self, tags: Vec<String>) -> Vec<String> {
        self.inner.invalidate_tags(tags).into_iter().collect()
    }

    /// Removes every expired entry, returning the removed keys.
    #[wasm_bindgen(js_name = prune)]
    pub fn prune(&mut self) -> Vec<String> {
        self.inner.prune().into_iter().collect()
    }

    /// Empties the cache.
    #[wasm_bindgen(js_name = clear)]
    pub fn clear(&mut self) {
        self.inner.clear();
    }

    /// Starts (or stops) recording entries the cache drops **by itself** — capacity
    /// evictions and TTL expirations — so the host can observe them via
    /// [`drain_drops`](Self::drain_drops).
    ///
    /// Off by default: while off, the core pays nothing but a branch at the moment an
    /// entry dies, and `drain_drops()` returns an empty array. Turning it off also clears
    /// whatever has been recorded but not yet drained.
    #[wasm_bindgen(js_name = setDropTracking)]
    pub fn set_drop_tracking(&mut self, enabled: bool) {
        self.inner.set_drop_tracking(enabled);
    }

    /// `true` while the drop log is being collected.
    #[wasm_bindgen(js_name = dropTracking)]
    pub fn drop_tracking(&self) -> bool {
        self.inner.drop_tracking()
    }

    /// Takes every drop recorded since the last call as
    /// `[{ key, value, reason: "evict" | "expire" }, …]`.
    ///
    /// Explicit `delete`, `deleteMany`, `invalidateTags`, `prune` and `clear` never show up
    /// here — the host issued those and already knows the result. Call this after each
    /// operation that could have reclaimed memory (any write, any read when TTLs exist)
    /// while drop listeners are installed.
    #[wasm_bindgen(js_name = drainDrops)]
    pub fn drain_drops(&mut self) -> Array {
        let out = Array::new();
        for dropped in self.inner.drain_drops() {
            let obj = js_sys::Object::new();
            set_field(&obj, "key", &JsValue::from_str(&dropped.key));
            set_field(&obj, "id", &JsValue::from_f64(dropped.id as f64));
            set_field(&obj, "value", &dropped.value.to_js());
            set_field(
                &obj,
                "reason",
                &JsValue::from_str(match dropped.reason {
                    blaze_cache_core::DropReason::Evicted => "evict",
                    blaze_cache_core::DropReason::Expired => "expire",
                }),
            );
            out.push(&obj);
        }
        out
    }

    /// Counters: `{ hits, misses, evictions, expirations, invalidations, size, capacity }`.
    #[wasm_bindgen(js_name = stats)]
    pub fn stats(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.inner.stats()).map_err(|err| {
            JsValue::from_str(&format!("blaze-cache: failed to serialise stats: {err}"))
        })
    }

    /// Zeroes the cumulative counters. Stored entries are untouched.
    #[wasm_bindgen(js_name = resetStats)]
    pub fn reset_stats(&mut self) {
        self.inner.reset_stats();
    }

    /// Number of stored entries that are present **and** not expired — expired-but-unpruned
    /// slots are not counted, so this always matches what `keys()`/`entries()` return.
    ///
    /// `O(1)` when no entry carries a TTL, otherwise a single oldest-first walk.
    #[wasm_bindgen(js_name = size)]
    pub fn size(&self) -> usize {
        self.inner.live_len()
    }

    /// Maximum number of entries — the `capacity` passed to `createCache`.
    #[wasm_bindgen(js_name = capacity)]
    pub fn capacity(&self) -> usize {
        self.inner.capacity()
    }
}

/// Installs a panic hook that forwards Rust panics to `console.error`, making debugging in
/// devtools far less painful. Safe to call more than once.
#[wasm_bindgen(js_name = setPanicHook)]
pub fn set_panic_hook() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

/// Ensures the shared key scratch holds at least `len` bytes and returns its offset in
/// wasm memory.
///
/// The host encodes keys here — once per *distinct* key; a repeated key is served from the
/// wrapper's last-key cache with no write at all — and hands the offset to
/// [`getRaw`](BlazeCache::get_raw)/[`setRaw`](BlazeCache::set_raw)/
/// [`deleteRaw`](BlazeCache::delete_raw). That is what keeps a read from paying
/// `passStringToWasm0`'s malloc + copy + free on every single call.
///
/// The returned offset stays valid until the next `ensureScratch` that has to grow the
/// buffer; `memory.grow` never moves it (wasm memory contents are preserved across
/// growth), so the wrapper only has to refresh its `Uint8Array` view, not the pointer.
#[wasm_bindgen(js_name = ensureScratch)]
pub fn ensure_scratch(len: usize) -> u32 {
    KEY_SCRATCH.with(|cell| {
        let mut scratch = cell.borrow_mut();
        if scratch.len() < len {
            scratch.resize(len, 0);
        }
        scratch.as_mut_ptr() as u32
    })
}

/// Runs `f` on the host-written scratch bytes at `ptr`/`len`, interpreted as a key.
///
/// `ptr` is an absolute wasm pointer (the base [`ensureScratch`] handed the host), so it is
/// validated against the *current* buffer before any slice is made. That closes two holes
/// the old unchecked decoder had: a pointer left stale by a scratch reallocation, and a
/// length reaching past the buffer. Invalid UTF-8 is rejected too, so no `&str` is ever
/// built from bytes JS did not encode. A rejected key skips `f` entirely — the exported
/// methods turn that into a miss, a no-op or `false`, never a trap.
///
/// The closure receives the slice while the `RefCell` borrow is alive, so the returned
/// reference never needs to outlive it and the whole path stays safe Rust.
fn with_raw_key<R>(ptr: u32, len: u32, f: impl FnOnce(&str) -> R) -> Option<R> {
    KEY_SCRATCH.with(|cell| {
        let scratch = cell.borrow();
        let base = scratch.as_ptr() as usize;
        let start = (ptr as usize).checked_sub(base)?;
        let end = start.checked_add(len as usize)?;
        let bytes = scratch.get(start..end)?;
        Some(f(std::str::from_utf8(bytes).ok()?))
    })
}

/// `{ key, id, ttlMs, tags }` — metadata-only entry shape for JS-authoritative mode.
fn entry_meta_object(key: &str, id: u32, ttl: Option<Duration>, tags: &[String]) -> js_sys::Object {
    let obj = js_sys::Object::new();
    set_field(&obj, "key", &JsValue::from_str(key));
    set_field(&obj, "id", &JsValue::from_f64(id as f64));
    set_field(&obj, "ttlMs", &ttl_ms(ttl));
    let tag_array = js_sys::Array::new();
    for tag in tags {
        tag_array.push(&JsValue::from_str(tag));
    }
    set_field(&obj, "tags", &tag_array);
    obj
}

fn set_field(target: &js_sys::Object, key: &str, value: &JsValue) {
    // Reflect::set only fails for non-extensible targets, which a fresh Object never is.
    let _ = js_sys::Reflect::set(target, &JsValue::from_str(key), value);
}

fn ttl_ms(ttl: Option<Duration>) -> JsValue {
    match ttl {
        Some(ttl) => JsValue::from_f64(ttl.as_millis() as f64),
        None => JsValue::NULL,
    }
}

/// `{ key, value, ttlMs, tags }` — the shape both `entry()` and `entries()` hand to JS.
fn entry_object(
    key: &str,
    value: JsValue,
    ttl: Option<Duration>,
    tags: &[String],
) -> js_sys::Object {
    let tag_array = js_sys::Array::new();
    for tag in tags {
        tag_array.push(&JsValue::from_str(tag));
    }
    let obj = js_sys::Object::new();
    set_field(&obj, "key", &JsValue::from_str(key));
    set_field(&obj, "value", &value);
    set_field(&obj, "ttlMs", &ttl_ms(ttl));
    set_field(&obj, "tags", &tag_array);
    obj
}

/// Bindings tests, compiled only for `wasm32` test builds — `pnpm test:wasm` runs them in
/// Node, while host `cargo test` skips the module entirely.
#[cfg(all(test, target_arch = "wasm32"))]
mod tests;
