// The synchronous syscall channel (ADR-010 / ADR-016).
//
// A wasm `_start` runs synchronously, so a WASI import (`fd_read`, `path_open`, …)
// must return a value *immediately* — it can't `await`. This channel lets the
// program worker make a blocking syscall and get the result on the same call:
//
//   1. program worker writes a request into a SharedArrayBuffer, sets STATE=REQ,
//      and signals the kernel worker with a normal postMessage;
//   2. it then `Atomics.wait`s on STATE — parking that thread only;
//   3. the kernel worker (a separate thread, free to run) reads the request,
//      services it against the wasm kernel, writes the response, sets STATE=RESP,
//      and `Atomics.notify`s;
//   4. the program worker wakes and returns the result synchronously.
//
// One request is in flight at a time (a guest is single-threaded), so a single
// request/response slot suffices — no ring buffer needed. `fd_write` to stdout
// stays on the async fire-and-forget path (its result is known locally); only
// calls that need a value *back* use this channel.

export const STATE = 0; // Int32 index: 0 idle, 1 request-ready, 2 response-ready
export const STATUS = 1; // Int32 index: 0 ok, negative = -errno
export const LEN = 2; // Int32 index: total payload byte length
export const MLEN = 3; // Int32 index: request meta (JSON) byte length; bytes follow
export const HEADER_BYTES = 16;

export const S_IDLE = 0;
export const S_REQ = 1;
export const S_RESP = 2;

const DATA_BYTES = 1 << 20; // 1 MiB payload region (max single read)
// The most a single sync read can carry back. A caller asking for more must chunk
// (exactly as writes do) — the kernel advances the fd offset by what it reads, so
// requesting more than this and getting a truncated payload would silently skip
// the remainder of the file. Exported so the guest clamps each read to it.
export const MAX_SYNC_PAYLOAD = DATA_BYTES;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Allocate a per-process sync-syscall buffer. */
export function allocSyncBuffer() {
  return new SharedArrayBuffer(HEADER_BYTES + DATA_BYTES);
}

/** Views over a sync buffer. */
export function views(sab) {
  return {
    i32: new Int32Array(sab, 0, HEADER_BYTES / 4),
    u8: new Uint8Array(sab, HEADER_BYTES),
  };
}

/**
 * Program-worker side: a blocking syscall. `binary` true means the response
 * payload is raw bytes (a read); otherwise it's JSON. `reqBytes` (optional) is a
 * raw request payload placed after the JSON meta — used by a synchronous `write`
 * to carry the bytes being written. Returns `{ status, bytes }` or
 * `{ status, value }`.
 */
export function makeSyncCaller(sab, signal) {
  const { i32, u8 } = views(sab);
  return function syncCall(call, args, binary, reqBytes) {
    const meta = enc.encode(JSON.stringify({ call, ...args }));
    u8.set(meta, 0);
    let total = meta.length;
    if (reqBytes && reqBytes.length) {
      // The payload region is fixed (DATA_BYTES); the caller chunks larger writes.
      u8.set(reqBytes.subarray(0, DATA_BYTES - meta.length), meta.length);
      total += Math.min(reqBytes.length, DATA_BYTES - meta.length);
    }
    Atomics.store(i32, MLEN, meta.length);
    Atomics.store(i32, LEN, total);
    Atomics.store(i32, STATE, S_REQ);
    signal(); // tell the kernel worker a request is waiting
    // Park until the kernel flips STATE away from S_REQ.
    while (Atomics.load(i32, STATE) === S_REQ) {
      Atomics.wait(i32, STATE, S_REQ);
    }
    const status = Atomics.load(i32, STATUS);
    const len = Atomics.load(i32, LEN);
    const payload = u8.slice(0, len);
    Atomics.store(i32, STATE, S_IDLE);
    if (binary) return { status, bytes: payload };
    return { status, value: len ? JSON.parse(dec.decode(payload)) : null };
  };
}

/** Kernel-worker side: read the pending request's JSON meta. */
export function readRequest(sab) {
  const { i32, u8 } = views(sab);
  const mlen = Atomics.load(i32, MLEN);
  return JSON.parse(dec.decode(u8.slice(0, mlen)));
}

/** Kernel-worker side: the raw request payload after the meta (empty if none). */
export function requestBytes(sab) {
  const { i32, u8 } = views(sab);
  const mlen = Atomics.load(i32, MLEN);
  const len = Atomics.load(i32, LEN);
  return u8.slice(mlen, len);
}

/** Kernel-worker side: write a response and wake the program worker. */
export function writeResponse(sab, status, payload) {
  const { i32, u8 } = views(sab);
  let bytes;
  if (payload == null) bytes = new Uint8Array(0);
  else if (payload instanceof Uint8Array) bytes = payload;
  else bytes = enc.encode(JSON.stringify(payload));
  u8.set(bytes.subarray(0, DATA_BYTES), 0);
  Atomics.store(i32, STATUS, status | 0);
  Atomics.store(i32, LEN, Math.min(bytes.length, DATA_BYTES));
  Atomics.store(i32, STATE, S_RESP);
  Atomics.notify(i32, STATE);
}
