//! An arena for binary values that live in Wasm linear memory.
//!
//! This is the storage behind the optional bytes value mode. A JS caller reserves a region,
//! writes into it through a `Uint8Array` view of Wasm memory, and hands the `(ptr, len)` pair
//! to the binding, which stores an owning [`BytesRef`] as the cache value. Reads return the
//! same `(ptr, len)` pair so JS can build a view without copying — the only genuine zero-copy
//! path across the boundary, since arbitrary JS objects cannot live in linear memory.
//!
//! # Design
//!
//! * **Chunked, never-moving buffers.** A `Vec<Vec<u8>>` would invalidate every outstanding
//!   pointer whenever it reallocated, so the arena is a list of fixed-size chunks. A chunk's
//!   allocation is never resized or dropped while the arena lives, which makes the absolute
//!   pointers it hands out stable across later allocations. `memory.grow` preserves Wasm memory
//!   contents, so the *offsets* stay valid too — only JS-side `ArrayBuffer` views are detached
//!   and must be rebuilt (see the `getBytes` docs in the wasm binding).
//! * **Safe validation, no `unsafe`.** Every host-supplied pointer is checked against the
//!   current chunk base/bounds through [`with_region`]/[`adopt`] before a slice is made — the
//!   mirror of `with_raw_key` in the wasm crate. A stale or out-of-range pointer degrades to
//!   `None`/`false`, never a trap or an out-of-bounds view.
//! * **`Drop` returns capacity.** When the cache evicts, expires or overwrites an entry its
//!   `BytesRef` is dropped and the region goes back on a free list, so a long-running cache
//!   under churn does not grow the arena without bound. Reuse does invalidate any JS view that
//!   was still pointing at the region — views are short-lived by contract; use `getBytesCopy`
//!   in the binding when one must outlive the next allocation.
//!
//! The arena is module-global (one thread-local per wasm instance), like the key scratch in the
//! binding. That lets one `BytesRef` be dropped from any cache in the instance and always find
//! the arena it came from, without threading a lifetime through the generic cache.

use std::cell::RefCell;

/// Size of a newly allocated chunk. Bump-allocating within a chunk keeps `reserve` O(1) in the
/// common case; a payload larger than this simply gets a chunk of its own.
const CHUNK_SIZE: usize = 64 * 1024;

/// One never-resized allocation. `used` is the bump pointer into `buf`.
struct Chunk {
    buf: Vec<u8>,
    used: usize,
}

#[derive(Default)]
struct Arena {
    chunks: Vec<Chunk>,
    /// Regions returned by a dropped `BytesRef`, awaiting reuse: `(chunk, offset, len)`.
    free: Vec<(usize, usize, usize)>,
    /// Regions handed to JS but not yet adopted by a `setBytes` call. They stay reserved so a
    /// second `reserve` cannot hand out the same bytes, and are recovered (not freed) if the
    /// caller drops the `Reservation` without adopting.
    reserved: Vec<(usize, usize, usize)>,
    /// Regions currently owned by live `BytesRef`s. Telemetry for tests.
    live: usize,
}

thread_local! {
    /// The one arena for this wasm instance / thread.
    static ARENA: RefCell<Arena> = const {
        RefCell::new(Arena {
            chunks: Vec::new(),
            free: Vec::new(),
            reserved: Vec::new(),
            live: 0,
        })
    };
}

/// An owning handle to a region of the arena.
///
/// Dropping it returns the region to the free list. Deliberately **not** `Clone` or `Copy`:
/// two owners would both return the same region and hand it out twice.
#[derive(Debug)]
pub struct BytesRef {
    pub ptr: usize,
    pub len: usize,
    chunk: usize,
    offset: usize,
}

impl Drop for BytesRef {
    fn drop(&mut self) {
        ARENA.with(|cell| {
            let mut arena = cell.borrow_mut();
            arena.free.push((self.chunk, self.offset, self.len));
            arena.live -= 1;
        });
    }
}

/// The result of [`reserve`]: coordinates JS writes into, but does not yet own, a region.
///
/// Dropping without [`adopt`] releases the reservation so a later `reserve` can reuse it.
#[derive(Debug)]
pub struct Reservation {
    pub ptr: usize,
    pub len: usize,
    chunk: usize,
    offset: usize,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        ARENA.with(|cell| {
            let mut arena = cell.borrow_mut();
            if let Some(pos) = arena
                .reserved
                .iter()
                .position(|&(c, o, l)| c == self.chunk && o == self.offset && l == self.len)
            {
                arena.reserved.remove(pos);
                arena.free.push((self.chunk, self.offset, self.len));
            }
        });
    }
}

/// Finds the chunk containing `[ptr, ptr+len)` and returns `(chunk index, offset)`.
///
/// Bounds and overflow are checked before any pointer arithmetic, so a hostile `u32` from JS
/// can never index a slice. The region must lie entirely inside one chunk — a view spanning two
/// chunks would not be a single contiguous allocation JS could safely address.
fn locate(arena: &Arena, ptr: usize, len: usize) -> Option<(usize, usize)> {
    for (index, chunk) in arena.chunks.iter().enumerate() {
        let base = chunk.buf.as_ptr() as usize;
        let end = base.checked_add(chunk.buf.len())?;
        if ptr < base || ptr >= end {
            continue;
        }
        let offset = ptr - base;
        if offset.checked_add(len)? <= chunk.buf.len() {
            return Some((index, offset));
        }
    }
    None
}

/// Reserves `len` zeroed bytes and returns the coordinates JS writes into.
///
/// `len == 0` is a valid (zero-length) region; callers get a stable pointer and can still store
/// an empty byte value. The region stays reserved until [`Reservation::adopt`] succeeds or the
/// reservation is dropped.
pub fn reserve(len: usize) -> Reservation {
    ARENA.with(|cell| {
        let mut arena = cell.borrow_mut();

        // Reuse a returned region of exactly the requested size first: no growth, no new chunk.
        if let Some(pos) = arena.free.iter().position(|&(_, _, l)| l == len) {
            let (chunk, offset, _) = arena.free.remove(pos);
            let ptr = arena.chunks[chunk].buf.as_ptr() as usize + offset;
            let reservation = Reservation {
                ptr,
                len,
                chunk,
                offset,
            };
            arena.reserved.push((chunk, offset, len));
            return reservation;
        }

        // Otherwise bump within a chunk that still has room.
        if let Some((index, chunk)) = arena
            .chunks
            .iter_mut()
            .enumerate()
            .find(|(_, chunk)| chunk.buf.len() - chunk.used >= len)
        {
            let offset = chunk.used;
            chunk.used += len;
            let ptr = chunk.buf.as_ptr() as usize + offset;
            let reservation = Reservation {
                ptr,
                len,
                chunk: index,
                offset,
            };
            arena.reserved.push((index, offset, len));
            return reservation;
        }

        // No room: add a chunk (large enough for the payload, at least CHUNK_SIZE).
        let size = len.max(CHUNK_SIZE);
        let buf = vec![0u8; size];
        let ptr = buf.as_ptr() as usize;
        arena.chunks.push(Chunk { buf, used: len });
        let index = arena.chunks.len() - 1;
        let reservation = Reservation {
            ptr,
            len,
            chunk: index,
            offset: 0,
        };
        arena.reserved.push((index, 0, len));
        reservation
    })
}

impl Reservation {
    /// Takes ownership of a previously reserved region after validating its coordinates.
    ///
    /// Returns `None` for an unknown/stale `(ptr, len)` pair; the reservation is then dropped
    /// normally and the region returned to the free list by its `Drop`.
    pub fn adopt(self, ptr: usize, len: usize) -> Option<BytesRef> {
        let key = (self.chunk, self.offset, self.len);
        if self.ptr != ptr || self.len != len {
            return None;
        }
        ARENA.with(|cell| {
            let mut arena = cell.borrow_mut();
            let pos = arena.reserved.iter().position(|&entry| entry == key)?;
            arena.reserved.remove(pos);
            arena.live += 1;
            // Ownership moves to the `BytesRef`. `mem::forget` skips only `Reservation::drop`,
            // whose entire effect is undoing the reservation we just consumed above.
            std::mem::forget(self);
            Some(BytesRef {
                ptr,
                len,
                chunk: key.0,
                offset: key.1,
            })
        })
    }
}

/// Adopts a previously reserved region by its public coordinates.
///
/// This is the path used by the wasm binding, which only receives `(ptr, len)` from JS. It
/// succeeds only when the pair exactly matches a live reservation, so a stale or hostile pair
/// can never turn into an owned `BytesRef`.
pub fn adopt(ptr: usize, len: usize) -> Option<BytesRef> {
    ARENA.with(|cell| {
        let mut arena = cell.borrow_mut();
        let pos = arena.reserved.iter().position(|&(c, o, l)| {
            arena
                .chunks
                .get(c)
                .is_some_and(|chunk| chunk.buf.as_ptr() as usize + o == ptr && l == len)
        })?;
        let (chunk, offset, len) = arena.reserved.remove(pos);
        arena.live += 1;
        Some(BytesRef {
            ptr,
            len,
            chunk,
            offset,
        })
    })
}

/// Reserves a region and returns its pointer, keeping the reservation alive until
/// [`adopt`] claims it. For hosts (the wasm binding) that only hold a numeric pointer and call
/// back later; an abandoned region stays reserved for the instance's lifetime.
pub fn reserve_for_host(len: usize) -> u32 {
    let reservation = reserve(len);
    let ptr = reservation.ptr as u32;
    std::mem::forget(reservation);
    ptr
}

/// Copies `src` into the arena region at `ptr`/`len`, returning `false` for an invalid range.
pub fn copy_into(ptr: usize, len: usize, src: &[u8]) -> bool {
    with_region_mut(ptr, len, |dest| dest.copy_from_slice(src)).is_some()
}

/// Returns a copy of the bytes at `ptr`/`len`, or `None` for an invalid range.
pub fn to_vec(ptr: usize, len: usize) -> Option<Vec<u8>> {
    with_region(ptr, len, |bytes| bytes.to_vec())
}

/// Runs `f` on the bytes at `ptr`/`len` if the range is valid.
pub fn with_region<R>(ptr: usize, len: usize, f: impl FnOnce(&[u8]) -> R) -> Option<R> {
    ARENA.with(|cell| {
        let arena = cell.borrow();
        let (chunk, offset) = locate(&arena, ptr, len)?;
        Some(f(&arena.chunks[chunk].buf[offset..offset + len]))
    })
}

fn with_region_mut<R>(ptr: usize, len: usize, f: impl FnOnce(&mut [u8]) -> R) -> Option<R> {
    ARENA.with(|cell| {
        let mut arena = cell.borrow_mut();
        let (chunk, offset) = locate(&arena, ptr, len)?;
        Some(f(&mut arena.chunks[chunk].buf[offset..offset + len]))
    })
}

/// Number of regions currently reserved for JS or owned by live `BytesRef`s. Test helper.
pub fn live_regions() -> usize {
    ARENA.with(|cell| {
        let arena = cell.borrow();
        arena.reserved.len() + arena.live
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserve_copy_adopt_and_drop_reuses_the_region() {
        let reservation = reserve(8);
        assert!(copy_into(reservation.ptr, reservation.len, b"12345678"));
        let (ptr, len) = (reservation.ptr, reservation.len);
        let bytes = reservation.adopt(ptr, len).unwrap();
        let mut out = [0u8; 8];
        with_region(bytes.ptr, bytes.len, |src| out.copy_from_slice(src));
        assert_eq!(&out, b"12345678");
        let same_ptr = bytes.ptr;
        drop(bytes);

        // The freed region is handed out again at the same address, without a new chunk.
        let again = reserve(8);
        assert_eq!(again.ptr, same_ptr);
        drop(again);
    }

    #[test]
    fn hostile_pointers_and_lengths_are_rejected() {
        assert!(!copy_into(usize::MAX, 4, b"abcd"));
        assert_eq!(to_vec(usize::MAX, 4), None);
        let reservation = reserve(4);
        assert!(!copy_into(reservation.ptr, usize::MAX, b"x"));
        let ptr = reservation.ptr;
        assert!(reservation.adopt(ptr + 1, 4).is_none());
    }

    #[test]
    fn a_large_payload_gets_its_own_chunk() {
        let reservation = reserve(CHUNK_SIZE * 2);
        assert_eq!(reservation.len, CHUNK_SIZE * 2);
        assert!(copy_into(
            reservation.ptr,
            reservation.len,
            &vec![7; reservation.len]
        ));
        assert_eq!(
            to_vec(reservation.ptr, reservation.len).unwrap().len(),
            CHUNK_SIZE * 2
        );
        let (ptr, len) = (reservation.ptr, reservation.len);
        drop(reservation.adopt(ptr, len).unwrap());
    }
}
