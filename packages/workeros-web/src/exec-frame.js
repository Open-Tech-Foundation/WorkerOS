// Framing for the synchronous `execCapture` syscall response.
//
// The sync-syscall channel (sync-syscall.js) carries one payload per response:
// either JSON *or* a single raw byte block. `child_process`'s synchronous forms
// (`execSync`/`spawnSync`/…) need three values back at once — the exit code plus
// captured stdout *and* stderr — so we pack them into one byte block with a tiny
// fixed header and unpack it on the guest side. (The live/streaming async forms
// go through a different path entirely — `spawnChild` + postMessage'd CHILD_*
// events — and need none of this.)
//
//   [0..4)  int32  exit code (little-endian)
//   [4..8)  uint32 stdout byte length (little-endian); stderr is the remainder
//   [8..8+n)       stdout bytes
//   [8+n..)        stderr bytes

const HEADER = 8;

/** Kernel side: pack `{ code, stdout, stderr }` into one framed byte block. */
export function frameExecResult(code, stdout, stderr) {
  const out = stdout || new Uint8Array(0);
  const err = stderr || new Uint8Array(0);
  const buf = new Uint8Array(HEADER + out.length + err.length);
  const dv = new DataView(buf.buffer);
  dv.setInt32(0, code | 0, true);
  dv.setUint32(4, out.length, true);
  buf.set(out, HEADER);
  buf.set(err, HEADER + out.length);
  return buf;
}

/** Guest side: unpack a framed block into `{ code, stdout, stderr }`. */
export function unframeExecResult(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const code = dv.getInt32(0, true);
  const outLen = dv.getUint32(4, true);
  const stdout = bytes.slice(HEADER, HEADER + outLen);
  const stderr = bytes.slice(HEADER + outLen);
  return { code, stdout, stderr };
}
