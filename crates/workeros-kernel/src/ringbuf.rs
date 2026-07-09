//! Single-producer / single-consumer byte ring buffer — the reference
//! implementation and wire spec for the synchronous syscall transport
//! (ADR-010, ADR-015).
//!
//! # Wire layout
//!
//! The transport lives in a shared memory region (a `SharedArrayBuffer` in the
//! browser). This module is the *authoritative* specification of the framing;
//! the browser's JS mirror ([`packages/workeros-web/src/ringbuffer.js`]) must
//! reproduce this exact byte layout so a Rust producer/consumer and a JS
//! producer/consumer interoperate.
//!
//! ```text
//! offset 0  ..4        : write_pos  (u32 LE) — total bytes ever written
//! offset 4  ..8        : read_pos   (u32 LE) — total bytes ever consumed
//! offset 8  ..8+cap    : data       (cap bytes, treated as a circular buffer)
//! ```
//!
//! `write_pos` / `read_pos` are *monotonic* counters (they wrap only at u32
//! overflow, which we treat as unreachable for a single session). The number of
//! bytes available to read is `write_pos.wrapping_sub(read_pos)`; the free space
//! is `cap - available`. Physical positions in the data region are the counters
//! taken modulo `cap`.
//!
//! Synchronization uses the classic Lamport SPSC discipline: the producer
//! publishes with a release store to `write_pos`, the consumer observes it with
//! an acquire load (and vice-versa for `read_pos`). This is data-race-free for
//! exactly one producer and one consumer.
//!
//! # Blocking (`Atomics.wait`)
//!
//! A WASI guest's `fd_read` must block until data is available. In the browser
//! that is `Atomics.wait(int32View, WRITE_SLOT, seen)` on the consumer side and
//! `Atomics.notify` on the producer side. Natively we model the same
//! "block-until-satisfied" contract with a spin+yield loop (see
//! [`Consumer::read_blocking`]); the observable semantics are identical, which
//! is what the Phase 0 concurrency tests pin down.

use std::sync::atomic::{AtomicU32, AtomicU8, Ordering};
use std::sync::Arc;

/// Byte offset of the `write_pos` counter within the region.
pub const WRITE_POS_OFFSET: usize = 0;
/// Byte offset of the `read_pos` counter within the region.
pub const READ_POS_OFFSET: usize = 4;
/// Byte offset of the circular data region within the region.
pub const DATA_OFFSET: usize = 8;
/// Size of the fixed header (two u32 counters).
pub const HEADER_LEN: usize = DATA_OFFSET;

/// The shared backing region for one ring buffer.
///
/// In the browser this is mirrored by a `SharedArrayBuffer`; here it is plain
/// heap memory shared between threads via [`Arc`], which is all the native
/// concurrency tests need.
struct Region {
    write_pos: AtomicU32,
    read_pos: AtomicU32,
    data: Box<[AtomicU8]>,
}

impl Region {
    fn new(capacity: usize) -> Self {
        assert!(capacity > 0, "ring buffer capacity must be non-zero");
        let mut data = Vec::with_capacity(capacity);
        for _ in 0..capacity {
            data.push(AtomicU8::new(0));
        }
        Region {
            write_pos: AtomicU32::new(0),
            read_pos: AtomicU32::new(0),
            data: data.into_boxed_slice(),
        }
    }

    #[inline]
    fn capacity(&self) -> usize {
        self.data.len()
    }
}

/// Create a connected producer/consumer pair over a fresh region of `capacity`
/// data bytes.
pub fn channel(capacity: usize) -> (Producer, Consumer) {
    let region = Arc::new(Region::new(capacity));
    (
        Producer {
            region: region.clone(),
        },
        Consumer { region },
    )
}

/// The write end of the ring buffer.
pub struct Producer {
    region: Arc<Region>,
}

/// The read end of the ring buffer.
pub struct Consumer {
    region: Arc<Region>,
}

impl Producer {
    /// Total capacity of the data region in bytes.
    pub fn capacity(&self) -> usize {
        self.region.capacity()
    }

    /// Bytes currently free for writing.
    pub fn free(&self) -> usize {
        let r = &self.region;
        let write = r.write_pos.load(Ordering::Relaxed);
        let read = r.read_pos.load(Ordering::Acquire);
        r.capacity() - write.wrapping_sub(read) as usize
    }

    /// Write as many bytes from `buf` as fit without blocking. Returns the
    /// number of bytes written (0 if the buffer is full).
    pub fn write(&self, buf: &[u8]) -> usize {
        let r = &self.region;
        let cap = r.capacity();
        let write = r.write_pos.load(Ordering::Relaxed);
        let read = r.read_pos.load(Ordering::Acquire);
        let free = cap - write.wrapping_sub(read) as usize;
        let n = buf.len().min(free);
        let start = (write as usize) % cap;
        for (i, &b) in buf.iter().take(n).enumerate() {
            let pos = (start + i) % cap;
            r.data[pos].store(b, Ordering::Relaxed);
        }
        // Publish the new data with release ordering so a consumer that observes
        // the updated write_pos also observes the bytes.
        r.write_pos
            .store(write.wrapping_add(n as u32), Ordering::Release);
        n
    }

    /// Write the entire slice, spinning until space is available. Mirrors a
    /// blocking `fd_write` against a full pipe.
    pub fn write_all(&self, mut buf: &[u8]) {
        while !buf.is_empty() {
            let n = self.write(buf);
            if n == 0 {
                std::thread::yield_now();
            } else {
                buf = &buf[n..];
            }
        }
    }
}

impl Consumer {
    /// Total capacity of the data region in bytes.
    pub fn capacity(&self) -> usize {
        self.region.capacity()
    }

    /// Bytes currently available to read.
    pub fn available(&self) -> usize {
        let r = &self.region;
        let write = r.write_pos.load(Ordering::Acquire);
        let read = r.read_pos.load(Ordering::Relaxed);
        write.wrapping_sub(read) as usize
    }

    /// Read up to `buf.len()` bytes without blocking. Returns the number of
    /// bytes read (0 if empty).
    pub fn read(&self, buf: &mut [u8]) -> usize {
        let r = &self.region;
        let cap = r.capacity();
        let write = r.write_pos.load(Ordering::Acquire);
        let read = r.read_pos.load(Ordering::Relaxed);
        let avail = write.wrapping_sub(read) as usize;
        let n = buf.len().min(avail);
        let start = (read as usize) % cap;
        for (i, slot) in buf.iter_mut().take(n).enumerate() {
            let pos = (start + i) % cap;
            *slot = r.data[pos].load(Ordering::Relaxed);
        }
        // Publish the consumed range so the producer sees the freed space.
        r.read_pos
            .store(read.wrapping_add(n as u32), Ordering::Release);
        n
    }

    /// Read exactly `buf.len()` bytes, blocking until they arrive. This is the
    /// "block-until-satisfied" contract the synchronous syscall path depends on;
    /// in the browser the blocking is `Atomics.wait`, here it is spin+yield.
    pub fn read_blocking(&self, buf: &mut [u8]) {
        let mut filled = 0;
        while filled < buf.len() {
            let n = self.read(&mut buf[filled..]);
            if n == 0 {
                std::thread::yield_now();
            } else {
                filled += n;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;

    #[test]
    fn write_read_roundtrip_within_capacity() {
        let (p, c) = channel(16);
        assert_eq!(p.write(b"hello"), 5);
        assert_eq!(c.available(), 5);
        let mut out = [0u8; 5];
        assert_eq!(c.read(&mut out), 5);
        assert_eq!(&out, b"hello");
        assert_eq!(c.available(), 0);
    }

    #[test]
    fn write_is_bounded_by_free_space() {
        let (p, c) = channel(4);
        assert_eq!(p.write(b"abcdef"), 4, "only 4 bytes fit");
        assert_eq!(p.write(b"x"), 0, "full buffer accepts nothing");
        let mut out = [0u8; 2];
        assert_eq!(c.read(&mut out), 2);
        assert_eq!(&out, b"ab");
        assert_eq!(p.write(b"yz"), 2, "freed space is reusable");
    }

    #[test]
    fn wraps_around_the_data_region() {
        let (p, c) = channel(4);
        let mut out = [0u8; 3];
        // Advance the physical cursor near the end, then wrap.
        assert_eq!(p.write(b"123"), 3);
        assert_eq!(c.read(&mut out), 3);
        assert_eq!(&out, b"123");
        // read/write positions are now 3; next write straddles the boundary.
        assert_eq!(p.write(b"ABCD"), 4);
        let mut out4 = [0u8; 4];
        assert_eq!(c.read(&mut out4), 4);
        assert_eq!(&out4, b"ABCD");
    }

    #[test]
    fn producer_consumer_stream_large_payload() {
        // A payload far larger than capacity must stream through intact,
        // exercising back-pressure (write_all) and block-until-data (read_blocking).
        let (p, c) = channel(64);
        let payload: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
        let expected = payload.clone();

        let producer = thread::spawn(move || {
            p.write_all(&payload);
        });

        let mut received = vec![0u8; expected.len()];
        c.read_blocking(&mut received);
        producer.join().unwrap();

        assert_eq!(received, expected);
    }

    #[test]
    fn read_blocks_until_data_when_consumer_starts_first() {
        let (p, c) = channel(8);
        let produced = Arc::new(AtomicBool::new(false));
        let produced_seen_by_consumer = Arc::new(AtomicBool::new(false));

        let produced_w = produced.clone();
        let consumer_flag = produced_seen_by_consumer.clone();
        let consumer = thread::spawn(move || {
            let mut out = [0u8; 4];
            // Blocks here: no data yet.
            c.read_blocking(&mut out);
            // If we ever unblock, the producer must already have run.
            assert!(
                produced_w.load(Ordering::Acquire),
                "consumer unblocked before producer wrote"
            );
            assert_eq!(&out, b"data");
            consumer_flag.store(true, Ordering::Release);
        });

        // Give the consumer a chance to reach its blocking read.
        thread::yield_now();
        thread::sleep(std::time::Duration::from_millis(20));
        produced.store(true, Ordering::Release);
        p.write_all(b"data");

        consumer.join().unwrap();
        assert!(produced_seen_by_consumer.load(Ordering::Acquire));
    }
}
