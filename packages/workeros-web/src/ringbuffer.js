// SharedArrayBuffer ring buffer — the browser mirror of the Rust reference
// implementation and wire spec in `crates/workeros-kernel/src/ringbuf.rs`
// (ADR-010, ADR-015). The byte layout MUST match that spec exactly so a Rust
// end and a JS end interoperate:
//
//   offset 0 ..4      : write_pos (u32 LE, monotonic total bytes written)
//   offset 4 ..8      : read_pos  (u32 LE, monotonic total bytes consumed)
//   offset 8 ..8+cap  : circular data region (cap bytes)
//
// Blocking uses Atomics.wait/notify on the i32 view of the two counters, which
// is the browser realization of the "block-until-satisfied" contract the Rust
// `read_blocking`/`write_all` model with spin+yield.

const WRITE_POS_OFFSET = 0;
const READ_POS_OFFSET = 4;
const DATA_OFFSET = 8;
export const HEADER_LEN = DATA_OFFSET;

// i32 slot indices (byte offset / 4) for the Atomics counter operations.
const WRITE_SLOT = WRITE_POS_OFFSET / 4;
const READ_SLOT = READ_POS_OFFSET / 4;

/** Allocate a SharedArrayBuffer sized to hold `capacity` data bytes. */
export function allocRingBuffer(capacity) {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new RangeError("ring buffer capacity must be a positive integer");
  }
  return new SharedArrayBuffer(HEADER_LEN + capacity);
}

/** A view over a shared ring-buffer region; construct one on each worker. */
export class RingBuffer {
  constructor(sab) {
    this.sab = sab;
    this.i32 = new Int32Array(sab, 0, 2);
    this.bytes = new Uint8Array(sab);
    this.capacity = sab.byteLength - HEADER_LEN;
  }

  get writePos() {
    return Atomics.load(this.i32, WRITE_SLOT) >>> 0;
  }
  get readPos() {
    return Atomics.load(this.i32, READ_SLOT) >>> 0;
  }

  available() {
    return (this.writePos - this.readPos) >>> 0;
  }
  free() {
    return this.capacity - this.available();
  }

  /** Write as many bytes as fit; returns the count written (0 if full). */
  write(buf) {
    const write = this.writePos;
    const read = this.readPos;
    const free = this.capacity - ((write - read) >>> 0);
    const n = Math.min(buf.length, free);
    const start = write % this.capacity;
    for (let i = 0; i < n; i++) {
      this.bytes[DATA_OFFSET + ((start + i) % this.capacity)] = buf[i];
    }
    // Publish, then wake a consumer blocked on the write counter.
    Atomics.store(this.i32, WRITE_SLOT, (write + n) >>> 0);
    Atomics.notify(this.i32, WRITE_SLOT);
    return n;
  }

  /** Write the whole slice, blocking on back-pressure until it all lands. */
  writeAll(buf) {
    let off = 0;
    while (off < buf.length) {
      const n = this.write(buf.subarray(off));
      if (n === 0) {
        // Buffer full: wait for the consumer to advance read_pos.
        const seen = this.readPos;
        Atomics.wait(this.i32, READ_SLOT, seen | 0, 1000);
      } else {
        off += n;
      }
    }
  }

  /** Read up to `max` bytes without blocking; returns a Uint8Array (may be empty). */
  read(max) {
    const write = this.writePos;
    const read = this.readPos;
    const avail = (write - read) >>> 0;
    const n = Math.min(max, avail);
    const out = new Uint8Array(n);
    const start = read % this.capacity;
    for (let i = 0; i < n; i++) {
      out[i] = this.bytes[DATA_OFFSET + ((start + i) % this.capacity)];
    }
    Atomics.store(this.i32, READ_SLOT, (read + n) >>> 0);
    Atomics.notify(this.i32, READ_SLOT);
    return out;
  }

  /** Read exactly `length` bytes, blocking (Atomics.wait) until they arrive. */
  readBlocking(length) {
    const out = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const chunk = this.read(length - filled);
      if (chunk.length === 0) {
        const seen = this.writePos;
        Atomics.wait(this.i32, WRITE_SLOT, seen | 0, 1000);
      } else {
        out.set(chunk, filled);
        filled += chunk.length;
      }
    }
    return out;
  }
}
